package com.la.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.ai.ChatMessage;
import com.la.ai.LlmClient;
import com.la.exception.BizException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.apache.poi.hssf.usermodel.HSSFWorkbook;
import org.apache.poi.hwpf.extractor.WordExtractor;
import org.apache.poi.ss.usermodel.*;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.apache.poi.xwpf.usermodel.XWPFDocument;
import org.apache.poi.xwpf.usermodel.XWPFTable;
import org.apache.poi.xwpf.usermodel.XWPFTableCell;
import org.apache.poi.xwpf.usermodel.XWPFTableRow;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 出题组卷：导入作业（粘贴文本 / Word / Excel）
 * 提取纯文本后调用 DeepSeek 结构化为题目（题干/答案/难度/知识点/解析），
 * AI 不可用或解析失败时降级为本地规则解析，保证功能始终可用。
 * 图片识别暂未开放（无 OCR 引擎），上传图片时给出明确提示。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ComposeImportService {

    private final LlmClient llmClient;
    private final ObjectMapper objectMapper;

    private static final Pattern IMG_EXT = Pattern.compile("\\.(png|jpe?g|bmp|webp|gif)$", Pattern.CASE_INSENSITIVE);

    /**
     * 提取上传文件中的纯文本（支持 .docx/.doc/.xlsx/.xls）
     */
    public String extractText(MultipartFile file) {
        String name = file.getOriginalFilename() == null ? "" : file.getOriginalFilename();
        String lower = name.toLowerCase();
        if (IMG_EXT.matcher(lower).find()) {
            throw new BizException("图片识别暂未开放：请将题目文字直接粘贴到编辑区，或上传 Word / Excel 版本");
        }
        try (InputStream in = file.getInputStream()) {
            if (lower.endsWith(".docx")) {
                try (XWPFDocument doc = new XWPFDocument(in)) {
                    return docxText(doc);
                }
            } else if (lower.endsWith(".doc")) {
                try (WordExtractor ex = new WordExtractor(in)) {
                    return String.join("\n", ex.getParagraphText());
                }
            } else if (lower.endsWith(".xlsx")) {
                try (Workbook wb = new XSSFWorkbook(in)) {
                    return workbookText(wb);
                }
            } else if (lower.endsWith(".xls")) {
                try (Workbook wb = new HSSFWorkbook(in)) {
                    return workbookText(wb);
                }
            }
            throw new BizException("仅支持 Word（.docx / .doc）与 Excel（.xlsx / .xls）文件");
        } catch (BizException e) {
            throw e;
        } catch (Exception e) {
            log.warn("导入作业文件解析失败：{}", e.getMessage());
            throw new BizException("文件解析失败，请确认文件未损坏后重试");
        }
    }

    /** docx 全文提取：段落逐行 + 表格逐行（表格在段落之后，兼容题目清单型文档） */
    private String docxText(XWPFDocument doc) {
        StringBuilder sb = new StringBuilder();
        doc.getParagraphs().forEach(p -> {
            String t = p.getText();
            if (t != null && !t.isBlank()) {
                sb.append(t.trim()).append('\n');
            }
        });
        for (XWPFTable table : doc.getTables()) {
            for (XWPFTableRow row : table.getRows()) {
                StringBuilder line = new StringBuilder();
                row.getTableCells().forEach(c -> {
                    String t = c.getText();
                    if (t != null && !t.isBlank()) {
                        line.append(t.trim()).append('\t');
                    }
                });
                if (line.length() > 0) {
                    sb.append(line).append('\n');
                }
            }
        }
        return sb.toString();
    }

    private String workbookText(Workbook wb) {
        DataFormatter fmt = new DataFormatter();
        StringBuilder sb = new StringBuilder();
        for (Sheet sheet : wb) {
            for (Row row : sheet) {
                StringBuilder line = new StringBuilder();
                for (Cell cell : row) {
                    String v = fmt.formatCellValue(cell);
                    if (v != null && !v.isBlank()) {
                        line.append(v.trim()).append('\t');
                    }
                }
                if (line.length() > 0) {
                    sb.append(line).append('\n');
                }
            }
        }
        return sb.toString();
    }

    /**
     * 将题目原文结构化为题目列表（AI 优先，失败降级规则解析）
     */
    public List<Map<String, Object>> parseQuestions(String text) {
        if (text == null || text.isBlank()) {
            return List.of();
        }
        if (!llmClient.isMock()) {
            try {
                List<Map<String, Object>> result = llmParse(text.trim());
                if (!result.isEmpty()) {
                    return result;
                }
            } catch (Exception e) {
                log.warn("导入作业 AI 解析失败，降级规则解析：{}", e.getMessage());
            }
        }
        return ruleParse(text.trim());
    }

    private List<Map<String, Object>> llmParse(String text) {
        String system = "你是作业题目的结构化解析器。把用户提供的题目原文解析为一个 JSON 数组，"
                + "严格只输出 JSON，不要输出任何其他文字或代码块标记。每个元素字段：\n"
                + "type：SINGLE（单选题）/MULTI（多选题）/FILL（填空题）/JUDGE（判断题）/SHORT（简答题）/CODE（编程题），根据原文内容判断；\n"
                + "title：题干（去掉题号前缀）；\n"
                + "options：仅单选/多选题提供，格式 [{\"key\":\"A\",\"text\":\"...\"},...]；\n"
                + "answer：单选 [\"A\"]、多选 [\"A\",\"B\"]、判断 [true 或 false]、填空/简答/编程 [\"答案文本\"]；原文给出答案则提取，未给出则根据题目内容推断或留空数组；\n"
                + "difficulty：0.8 或 0.5 或 0.2（原文标注了难度则提取，否则按内容估计）；\n"
                + "kpCode：null（不需要填）；\n"
                + "analysis：原文的答案解析，没有则给一句简短解析或空字符串。\n"
                + "按原文顺序逐题输出，不要遗漏、不要合并。";
        String content = llmClient.chat(List.of(ChatMessage.system(system), ChatMessage.user(text)), 0.2);
        return cleanQuestions(content);
    }

    /** 解析并清洗模型输出（容错：剥离代码块围栏、截取首个 JSON 数组） */
    private List<Map<String, Object>> cleanQuestions(String content) {
        List<Map<String, Object>> result = new ArrayList<>();
        if (content == null || content.isBlank()) {
            return result;
        }
        String text = content.trim();
        int s = text.indexOf('[');
        int e = text.lastIndexOf(']');
        if (s < 0 || e <= s) {
            return result;
        }
        try {
            JsonNode arr = objectMapper.readTree(text.substring(s, e + 1));
            List<String> validTypes = List.of("SINGLE", "MULTI", "FILL", "JUDGE", "SHORT", "CODE");
            for (JsonNode q : arr) {
                String type = q.path("type").asText("");
                if (!validTypes.contains(type)) {
                    continue;
                }
                String title = q.path("title").asText("").trim();
                if (title.isEmpty()) {
                    continue;
                }
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("type", type);
                m.put("title", title);
                if ("SINGLE".equals(type) || "MULTI".equals(type)) {
                    List<Map<String, Object>> opts = new ArrayList<>();
                    if (q.path("options").isArray()) {
                        for (JsonNode o : q.path("options")) {
                            String t = o.path("text").asText("").trim();
                            if (!t.isEmpty()) {
                                Map<String, Object> om = new LinkedHashMap<>();
                                om.put("key", o.path("key").asText(String.valueOf((char) ('A' + opts.size()))));
                                om.put("text", t);
                                opts.add(om);
                            }
                        }
                    }
                    if (opts.size() < 2) {
                        continue;
                    }
                    m.put("options", opts);
                    List<Object> ans = new ArrayList<>();
                    if (q.path("answer").isArray()) {
                        q.path("answer").forEach(a -> ans.add(a.isBoolean() ? a.asBoolean() : a.asText()));
                    }
                    m.put("answer", ans);
                } else if ("JUDGE".equals(type)) {
                    boolean ans = false;
                    if (q.path("answer").isArray() && q.path("answer").size() > 0) {
                        JsonNode a = q.path("answer").get(0);
                        ans = a.isBoolean() ? a.asBoolean() : "true".equalsIgnoreCase(a.asText()) || "对".equals(a.asText()) || "正确".equals(a.asText());
                    }
                    m.put("answer", List.of(ans));
                } else {
                    List<Object> ans = new ArrayList<>();
                    if (q.path("answer").isArray() && q.path("answer").size() > 0) {
                        ans.add(q.path("answer").get(0).asText());
                    }
                    m.put("answer", ans);
                }
                double diff = 0.5;
                try { diff = q.path("difficulty").asDouble(0.5); } catch (Exception ignore) { }
                m.put("difficulty", diff);
                m.put("kpCode", null);
                m.put("analysis", q.path("analysis").asText(""));
                result.add(m);
            }
        } catch (Exception ex) {
            log.warn("导入作业 JSON 解析失败：{}", ex.getMessage());
        }
        return result;
    }

    /**
     * 本地规则解析（AI 不可用/失败时的兜底）：按空行分段，
     * 识别题型关键词、选项行、答案行与解析行
     */
    private List<Map<String, Object>> ruleParse(String text) {
        List<Map<String, Object>> result = new ArrayList<>();
        String[] blocks = text.split("\\n\\s*\\n");
        Pattern typePat = Pattern.compile("(单选|多选|填空|判断|简答|编程)");
        Pattern optPat = Pattern.compile("^\\s*([A-D])[\\.、)）]\\s*(.+)$");
        Pattern ansPat = Pattern.compile("^\\s*(正确答案|答案|参考答案)\\s*[:：]\\s*(.+)$");
        Pattern anaPat = Pattern.compile("^\\s*(解析|答案解析)\\s*[:：]\\s*(.+)$");
        for (String block : blocks) {
            if (block.isBlank()) {
                continue;
            }
            String[] lines = block.split("\\n");
            String join = block.trim();
            Matcher tm = typePat.matcher(join);
            String type = "SHORT";
            if (tm.find()) {
                type = switch (tm.group(1)) {
                    case "单选" -> "SINGLE";
                    case "多选" -> "MULTI";
                    case "填空" -> "FILL";
                    case "判断" -> "JUDGE";
                    case "编程" -> "CODE";
                    default -> "SHORT";
                };
            }
            List<Map<String, Object>> opts = new ArrayList<>();
            List<Object> ans = new ArrayList<>();
            StringBuilder analysis = new StringBuilder();
            List<String> stemLines = new ArrayList<>();
            for (String raw : lines) {
                String line = raw.trim();
                if (line.isEmpty()) {
                    continue;
                }
                Matcher om = optPat.matcher(line);
                Matcher am = ansPat.matcher(line);
                Matcher nm = anaPat.matcher(line);
                if (om.matches() && ("SINGLE".equals(type) || "MULTI".equals(type) || opts.size() < 4)) {
                    if ("SHORT".equals(type)) {
                        type = "SINGLE";
                    }
                    Map<String, Object> opt = new LinkedHashMap<>();
                    opt.put("key", om.group(1));
                    opt.put("text", om.group(2).trim());
                    opts.add(opt);
                } else if (am.matches()) {
                    String v = am.group(2).trim();
                    if ("JUDGE".equals(type)) {
                        ans.add(v.matches("(?i)true|对|正确|T|√") || v.startsWith("A") || v.startsWith("对"));
                    } else if ("SINGLE".equals(type) || "MULTI".equals(type)) {
                        for (char c : v.toCharArray()) {
                            if (c >= 'A' && c <= 'D') {
                                ans.add(String.valueOf(c));
                            }
                        }
                    } else {
                        ans.add(v);
                    }
                } else if (nm.matches()) {
                    analysis.append(nm.group(2).trim());
                } else {
                    stemLines.add(line);
                }
            }
            if ("SINGLE".equals(type) || "MULTI".equals(type)) {
                if (opts.size() < 2) {
                    // 选项不足时按文本题处理，不丢弃内容
                    type = "SHORT";
                }
                // 原文未标注答案的客观题保留（answer 为空数组），由教师在编辑器中补选
            }
            String title = String.join("\n", stemLines).replaceFirst("^\\s*\\d+\\s*[\\.、)）]\\s*", "").trim();
            if (title.isEmpty()) {
                continue;
            }
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("type", type);
            m.put("title", title);
            m.put("options", opts.isEmpty() ? null : opts);
            m.put("answer", ans);
            m.put("difficulty", 0.5);
            m.put("kpCode", null);
            m.put("analysis", analysis.toString());
            result.add(m);
        }
        return result;
    }
}
