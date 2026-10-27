package com.la.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.ai.ChatMessage;
import com.la.ai.LlmClient;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.la.entity.KnowledgePoint;
import com.la.mapper.KnowledgePointMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;
import org.apache.poi.hslf.usermodel.HSLFSlide;
import org.apache.poi.hslf.usermodel.HSLFTextParagraph;
import org.apache.poi.hslf.usermodel.HSLFTextRun;
import org.apache.poi.hslf.usermodel.HSLFTextShape;
import org.apache.poi.hwpf.extractor.WordExtractor;
import org.apache.poi.xslf.usermodel.XMLSlideShow;
import org.apache.poi.xslf.usermodel.XSLFShape;
import org.apache.poi.xslf.usermodel.XSLFSlide;
import org.apache.poi.xslf.usermodel.XSLFTextShape;
import org.apache.poi.xwpf.usermodel.XWPFDocument;
import org.apache.poi.xwpf.usermodel.XWPFTable;
import org.apache.poi.xwpf.usermodel.XWPFTableCell;
import org.apache.poi.xwpf.usermodel.XWPFTableRow;
import org.springframework.stereotype.Service;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 学习资源 AI 识别：
 * 1. 提取文本类资源（ppt/pptx/doc/docx/pdf）的纯文本内容；
 * 2. 调用 DeepSeek 生成一句话简介，并从系统课程体系知识点（XLSX 节点）中识别关联的知识点编码；
 * 3. 图片 / 视频无法提取文本：仅按标题生成简介，知识点由教师在上传弹窗中手动选择。
 *
 * 输出校验：kpCodes 必须落在系统知识点白名单内（解析层过滤，严禁超出课程体系范围）。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ResourceAiService {

    private final LlmClient llmClient;
    private final KnowledgePointMapper knowledgePointMapper;
    private final ObjectMapper objectMapper;

    /** 送入 AI 的正文截断长度（字符），避免超长资源撑爆上下文 */
    private static final int MAX_TEXT_CHARS = 6000;

    /** AI 识别结果：简介 + 关联知识点编码 */
    public record Recognition(String summary, List<String> kpCodes) {
    }

    /** 知识点编码白名单过滤：仅保留课程体系（XLSX）内存在的编码（供 ResourceService 复用） */
    public List<String> validKpCodes(List<String> codes) {
        if (codes == null || codes.isEmpty()) {
            return List.of();
        }
        Set<String> valid = knowledgePointMapper.selectList(new LambdaQueryWrapper<KnowledgePoint>()
                        .eq(KnowledgePoint::getSource, "XLSX"))
                .stream().map(KnowledgePoint::getKpCode).collect(java.util.stream.Collectors.toSet());
        return codes.stream().filter(valid::contains).toList();
    }

    /**
     * 识别资源内容：能提取文本的资源走 DeepSeek（简介 + 知识点），
     * 提取不到文本（图片/视频）时仅按标题生成简介、不识别知识点。
     */
    public Recognition recognize(String title, String fileType, Path savedFile) {
        String text = extractText(fileType, savedFile);
        if (text != null && !text.isBlank()) {
            return recognizeByText(title, text);
        }
        // 图片 / 视频（或文本提取为空的文档）：仅按标题生成简介
        String summary = summarizeByTitleOnly(title, fileType);
        return new Recognition(summary, List.of());
    }

    /** 提取 Word 文档纯文本（实验报告作业：模板/学生报告内容读取，供 AI 初评） */
    public String extractWordText(Path file) {
        return extractText("word", file);
    }

    /** 文本类资源提取纯文本（按 file_path 读取磁盘文件），图片/视频返回 null；
     *  public：学习资源在线文本预览（Word/PPT/PDF）复用此提取 */
    public String extractText(String fileType, Path file) {
        if (!"ppt".equals(fileType) && !"word".equals(fileType) && !"pdf".equals(fileType)) {
            return null;
        }
        try (InputStream in = Files.newInputStream(file)) {
            String name = file.getFileName().toString().toLowerCase();
            switch (fileType) {
                case "ppt" -> {
                    if (name.endsWith(".pptx")) {
                        try (XMLSlideShow ppt = new XMLSlideShow(in)) {
                            return pptxText(ppt);
                        }
                    }
                    try (org.apache.poi.hslf.usermodel.HSLFSlideShow ppt =
                                 new org.apache.poi.hslf.usermodel.HSLFSlideShow(in)) {
                        return pptText(ppt);
                    }
                }
                case "word" -> {
                    if (name.endsWith(".docx")) {
                        try (XWPFDocument doc = new XWPFDocument(in)) {
                            return docxText(doc);
                        }
                    }
                    try (WordExtractor ex = new WordExtractor(in)) {
                        return String.join("\n", ex.getParagraphText());
                    }
                }
                case "pdf" -> {
                    try (PDDocument doc = PDDocument.load(in)) {
                        return new PDFTextStripper().getText(doc);
                    }
                }
                default -> { return null; }
            }
        } catch (Exception e) {
            log.warn("[资源AI] 文本提取失败 type={} file={}：{}", fileType, file.getFileName(), e.getMessage());
            return null;
        }
    }

    /** pptx 全文：逐页文本框提取 */
    private String pptxText(XMLSlideShow ppt) {
        StringBuilder sb = new StringBuilder();
        for (XSLFSlide slide : ppt.getSlides()) {
            for (XSLFShape shape : slide.getShapes()) {
                if (shape instanceof XSLFTextShape ts && ts.getText() != null && !ts.getText().isBlank()) {
                    sb.append(ts.getText().trim()).append('\n');
                }
            }
        }
        return sb.toString();
    }

    /** ppt 全文：逐页文本框提取 */
    private String pptText(org.apache.poi.hslf.usermodel.HSLFSlideShow ppt) {
        StringBuilder sb = new StringBuilder();
        for (HSLFSlide slide : ppt.getSlides()) {
            for (org.apache.poi.hslf.usermodel.HSLFShape shape : slide.getShapes()) {
                if (shape instanceof HSLFTextShape ts && ts.getText() != null && !ts.getText().isBlank()) {
                    for (HSLFTextParagraph p : ts.getTextParagraphs()) {
                        for (HSLFTextRun r : p.getTextRuns()) {
                            if (r.getRawText() != null && !r.getRawText().isBlank()) {
                                sb.append(r.getRawText().trim());
                            }
                        }
                        sb.append('\n');
                    }
                }
            }
        }
        return sb.toString();
    }

    /** docx 全文：段落逐行 + 表格逐行 */
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

    /** 有文本：DeepSeek 生成简介 + 从课程体系知识点白名单中识别关联知识点 */
    private Recognition recognizeByText(String title, String text) {
        String clipped = text.length() > MAX_TEXT_CHARS ? text.substring(0, MAX_TEXT_CHARS) : text;
        List<KnowledgePoint> whitelist = knowledgePointMapper.selectList(new LambdaQueryWrapper<KnowledgePoint>()
                .eq(KnowledgePoint::getSource, "XLSX"));
        String kpList = whitelist.stream()
                .map(k -> k.getKpCode() + "=" + k.getName())
                .reduce((a, b) -> a + "；" + b)
                .orElse("");

        String prompt = """
                ## 学习资源内容识别任务

                资源标题：%s
                资源正文内容（可能截断）：
                ---
                %s
                ---

                系统内可选的知识点编码与名称清单（只能从中选择，格式 编码=名称）：
                %s

                请分析该学习资源的内容，严格只输出 JSON（不要 markdown 代码块、不要任何其他文字）：
                {"summary":"一句话内容简介（30-80字，说明资源讲什么、适合谁看）","kpCodes":["编码1","编码2"]}

                要求：
                - summary 用中文，简洁客观，不夸大
                - kpCodes 从上面清单中选出与资源内容最相关的 1-5 个知识点编码；若内容与所有知识点都不相关，返回空数组
                - 严禁编造清单中不存在的编码
                """.formatted(title, clipped, kpList.isEmpty() ? "（无）" : kpList);

        try {
            String raw = llmClient.chat(List.of(
                    ChatMessage.system("你是面向大学软件工程专业的 Java 课程助教。只输出严格的 JSON，不要输出任何其他文字。"),
                    ChatMessage.user(prompt)), 0.3);
            JsonNode root = extractJson(raw);
            if (root != null) {
                String summary = root.path("summary").asText("");
                if (!summary.isBlank()) {
                    // 解析层白名单过滤：严禁出现课程体系之外的编码
                    Set<String> valid = new HashSet<>();
                    whitelist.forEach(k -> valid.add(k.getKpCode()));
                    List<String> kpCodes = new ArrayList<>();
                    if (root.path("kpCodes").isArray()) {
                        Set<String> seen = new LinkedHashSet<>();
                        for (JsonNode n : root.path("kpCodes")) {
                            String code = n.asText("");
                            if (valid.contains(code) && seen.add(code)) {
                                kpCodes.add(code);
                            }
                        }
                    }
                    log.info("[资源AI] 识别完成 title={} kpCodes={} summaryLen={}",
                            title, kpCodes, summary.length());
                    return new Recognition(summary, kpCodes);
                }
            }
            log.warn("[资源AI] 返回解析失败，回退标题简介：{}", clip(raw, 120));
        } catch (Exception e) {
            log.warn("[资源AI] DeepSeek 调用失败，回退标题简介：{}", e.getMessage());
        }
        // AI 失败兜底：不阻断上传，简介退化为标题描述、不关联知识点
        return new Recognition(summarizeByTitleOnly(title, null), List.of());
    }

    /** 无文本可提取（图片/视频）：按标题生成简介（优先用 AI，失败时本地兜底） */
    private String summarizeByTitleOnly(String title, String fileType) {
        if (!llmClient.isMock()) {
            try {
                String raw = llmClient.chat(List.of(
                        ChatMessage.system("你是面向大学软件工程专业的 Java 课程助教。只输出严格的 JSON，不要输出任何其他文字。"),
                        ChatMessage.user("请为名为「%s」的%s学习资源写一句话简介（30字以内，说明用途）。\n"
                                        + "严格只输出 JSON：{\"summary\":\"简介\"}".formatted(
                                title, fileType == null ? "" : fileTypeName(fileType)))), 0.3);
                JsonNode root = extractJson(raw);
                if (root != null && !root.path("summary").asText("").isBlank()) {
                    return root.path("summary").asText();
                }
            } catch (Exception e) {
                log.warn("[资源AI] 标题简介生成失败，使用本地兜底：{}", e.getMessage());
            }
        }
        return "「" + title + "」" + (fileType == null ? "学习资源" : fileTypeName(fileType)) + "，建议结合课程进度观看学习。";
    }

    private String fileTypeName(String fileType) {
        return switch (fileType) {
            case "ppt" -> "课件（PPT）";
            case "word" -> "文档（Word）";
            case "pdf" -> "文档（PDF）";
            case "video" -> "教学视频";
            case "image" -> "教学图片";
            default -> "学习资源";
        };
    }

    /** 容错提取模型返回中的第一个 JSON 对象（容忍 markdown 围栏与前后缀文字） */
    private JsonNode extractJson(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        int s = raw.indexOf('{');
        int e = raw.lastIndexOf('}');
        if (s < 0 || e <= s) {
            return null;
        }
        try {
            return objectMapper.readTree(raw.substring(s, e + 1));
        } catch (Exception ex) {
            return null;
        }
    }

    private String clip(String s, int n) {
        if (s == null) return "";
        return s.length() > n ? s.substring(0, n) + "…" : s;
    }
}
