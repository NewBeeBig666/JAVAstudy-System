package com.la.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.entity.Assignment;
import com.la.entity.ClassEntity;
import com.la.entity.Question;
import com.la.entity.Rubric;
import com.la.entity.RubricScore;
import com.la.entity.Submission;
import com.la.entity.User;
import com.la.exception.BizException;
import com.la.mapper.AssignmentMapper;
import com.la.mapper.ClassMapper;
import com.la.mapper.QuestionMapper;
import com.la.mapper.RubricMapper;
import com.la.mapper.RubricScoreMapper;
import com.la.mapper.SubmissionMapper;
import com.la.mapper.UserMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.apache.poi.xwpf.usermodel.ParagraphAlignment;
import org.apache.poi.xwpf.usermodel.XWPFDocument;
import org.apache.poi.xwpf.usermodel.XWPFParagraph;
import org.apache.poi.xwpf.usermodel.XWPFRun;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * 教师端「导出学生作业」：将当前作业下每个已提交学生的完整答题与批改记录
 * 单独生成一份 Word 文档（.docx），统一打包为 ZIP 压缩包下载。
 *
 * Word 内容：基本信息（姓名/学号/提交时间/次数/相似度/状态/AI初评/最终得分）
 *  + 学生作答（题目型逐题：题干/选项/参考答案/解析/学生作答/客观题得分）
 *  + AI 初评全文（含逐题评分依据）+ 教师批改（Rubric 逐维度得分 / 评语 / 总分）。
 * 性能：作业/题目/Rubric/学生/评分一次性批量加载，循环内零查库。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class SubmissionExportService {

    private final AssignmentMapper assignmentMapper;
    private final QuestionMapper questionMapper;
    private final SubmissionMapper submissionMapper;
    private final RubricMapper rubricMapper;
    private final RubricScoreMapper rubricScoreMapper;
    private final UserMapper userMapper;
    private final ClassMapper classMapper;
    private final AutoScoreService autoScoreService;
    private final ObjectMapper objectMapper;

    private static final DateTimeFormatter TS = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm");
    private static final DateTimeFormatter FILE_TS = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss");

    public ResponseEntity<byte[]> export(Long assignmentId) {
        Assignment as = assignmentMapper.selectById(assignmentId);
        if (as == null) {
            throw new BizException("作业不存在");
        }
        // 已提交 = 存在提交记录（重新提交为同一行，attempts 递增）
        List<Submission> subs = submissionMapper.selectList(new LambdaQueryWrapper<Submission>()
                .eq(Submission::getAssignmentId, assignmentId));
        if (subs.isEmpty()) {
            throw new BizException("该作业还没有学生提交，无法导出");
        }

        // ---- 批量加载全部关联数据（循环内零查库，保证批量导出性能） ----
        Map<Long, User> stuMap = userMapper.selectBatchIds(subs.stream()
                        .map(Submission::getStudentId).distinct().toList())
                .stream().collect(Collectors.toMap(User::getId, u -> u));
        // 按学号排序，压缩包内条目顺序与学生名册一致
        subs.sort(Comparator.comparing(s -> {
            User u = stuMap.get(s.getStudentId());
            return u == null || u.getStudentNo() == null ? "" : u.getStudentNo();
        }));

        boolean isCompose = as.getScoreMode() != null;   // 题目型 vs Rubric 型
        List<Question> questions = isCompose ? questionMapper.selectList(new LambdaQueryWrapper<Question>()
                .eq(Question::getAssignmentId, assignmentId).orderByAsc(Question::getSortOrder)) : List.of();
        List<Rubric> rubrics = isCompose ? List.of() : rubricMapper.selectList(new LambdaQueryWrapper<Rubric>()
                .eq(Rubric::getAssignmentId, assignmentId).orderByAsc(Rubric::getSortOrder));
        Map<Long, Map<Long, Integer>> rubScoreMap = isCompose ? Map.of()
                : rubricScoreMapper.selectList(new LambdaQueryWrapper<RubricScore>()
                        .in(RubricScore::getSubmissionId, subs.stream().map(Submission::getId).toList()))
                .stream().collect(Collectors.groupingBy(RubricScore::getSubmissionId,
                        Collectors.toMap(RubricScore::getRubricId, RubricScore::getScore, (a, b) -> a)));
        ClassEntity cls = as.getClassId() != null ? classMapper.selectById(as.getClassId()) : null;
        String className = cls != null && cls.getName() != null ? cls.getName() : "—";

        byte[] zip;
        try {
            zip = buildZip(as, className, subs, stuMap, questions, rubrics, rubScoreMap);
        } catch (IOException e) {
            log.error("导出学生作业失败 assignment={}", assignmentId, e);
            throw new BizException("生成 Word 压缩包失败，请重试");
        }

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.parseMediaType("application/zip"));
        String fileName = sanitize(as.getTitle()) + "-学生作业-" + LocalDateTime.now().format(FILE_TS) + ".zip";
        // RFC 5987：中文文件名按 UTF-8 编码放入 filename*，兼容各浏览器
        headers.setContentDisposition(ContentDisposition.attachment()
                .filename(fileName, StandardCharsets.UTF_8).build());
        return ResponseEntity.ok().headers(headers).body(zip);
    }

    private byte[] buildZip(Assignment as, String className, List<Submission> subs, Map<Long, User> stuMap,
                            List<Question> questions, List<Rubric> rubrics,
                            Map<Long, Map<Long, Integer>> rubScoreMap) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        try (ZipOutputStream zos = new ZipOutputStream(bos)) {
            for (Submission sub : subs) {
                User stu = stuMap.get(sub.getStudentId());
                XWPFDocument doc = buildDoc(as, className, stu, sub, questions, rubrics,
                        rubScoreMap.getOrDefault(sub.getId(), Map.of()));
                String no = stu != null && stu.getStudentNo() != null ? stu.getStudentNo()
                        : String.valueOf(sub.getStudentId());
                String name = stu != null && stu.getRealName() != null ? stu.getRealName() : "未知学生";
                // 学号唯一 → 文件名天然去重；学号在前便于按名册排序
                zos.putNextEntry(new ZipEntry(sanitize(no + "_" + name) + ".docx"));
                doc.write(zos);
                zos.closeEntry();
                doc.close();
            }
        }
        return bos.toByteArray();
    }

    /* ---------------- 单个学生的 Word 文档 ---------------- */

    private XWPFDocument buildDoc(Assignment as, String className, User stu, Submission sub,
                                  List<Question> questions, List<Rubric> rubrics,
                                  Map<Long, Integer> rubScores) {
        XWPFDocument doc = new XWPFDocument();
        boolean isCompose = as.getScoreMode() != null;
        String no = stu != null && stu.getStudentNo() != null ? stu.getStudentNo() : String.valueOf(sub.getStudentId());
        String name = stu != null && stu.getRealName() != null ? stu.getRealName() : "未知学生";

        // 标题 + 副标题
        title(doc, as.getTitle() == null ? "作业" : as.getTitle(), 16, true);
        title(doc, "学生作业批改记录", 11, false, true);
        blank(doc);

        // 一、基本信息
        heading(doc, "一、基本信息");
        kv(doc, "学生姓名", name);
        kv(doc, "学号", no);
        kv(doc, "班级", className);
        kv(doc, "作业截止", as.getDueAt() != null ? as.getDueAt().format(TS) : "—");
        kv(doc, "提交时间", sub.getSubmittedAt() != null ? sub.getSubmittedAt().format(TS) : "—");
        kv(doc, "提交次数", String.valueOf(sub.getAttempts() != null ? sub.getAttempts() : 1));
        kv(doc, "代码相似度", (sub.getSimilarity() != null ? sub.getSimilarity() : 0) + "%");
        kv(doc, "批改状态", statusLabel(sub.getStatus()));
        kv(doc, "AI 初评得分", sub.getAiScore() != null ? sub.getAiScore() + " 分" : "尚未初评");
        kv(doc, "最终得分", sub.getScore() != null ? sub.getScore() + " 分" : "尚未批改");

        if (isCompose) {
            // 二、学生作答（逐题）
            blank(doc);
            heading(doc, "二、学生作答");
            Map<String, JsonNode> ansMap = parseAnswers(sub.getAnswers());
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> detail = questions.isEmpty() || sub.getAnswers() == null
                    ? List.of() : (List<Map<String, Object>>) autoScoreService
                    .objectiveScore(as.getId(), sub.getAnswers()).getOrDefault("detail", List.of());
            for (int i = 0; i < questions.size(); i++) {
                Question q = questions.get(i);
                questionBlock(doc, i + 1, questionMax(q, questions), q, ansMap.get(String.valueOf(q.getId())),
                        detail.isEmpty() ? null : detail.get(i));
            }
        } else {
            // 二、作业要求 + 学生提交的代码
            blank(doc);
            heading(doc, "二、作业要求");
            multiline(doc, as.getDescription() != null && !as.getDescription().isBlank()
                    ? as.getDescription() : "（未填写作业要求）");
            blank(doc);
            heading(doc, "三、学生提交的代码");
            multiline(doc, sub.getCode() != null && !sub.getCode().isBlank() ? sub.getCode() : "（未提交代码）");
        }

        // AI 初评（含逐题评分依据）
        blank(doc);
        heading(doc, isCompose ? "三、AI 初评" : "四、AI 初评");
        if (sub.getAiComment() != null && !sub.getAiComment().isBlank()) {
            multiline(doc, sub.getAiComment());
        } else {
            multiline(doc, "（尚未进行 AI 初评）");
        }

        // 教师批改
        blank(doc);
        heading(doc, isCompose ? "四、教师批改" : "五、教师批改");
        if (!rubrics.isEmpty()) {
            for (Rubric r : rubrics) {
                Integer s = rubScores.get(r.getId());
                kv(doc, r.getName(), (s != null ? s : "未评分") + " / " + r.getMaxScore() + " 分");
            }
        }
        kv(doc, "最终得分", sub.getScore() != null ? sub.getScore() + " 分" : "尚未批改");
        XWPFParagraph cp = doc.createParagraph();
        run(cp, "教师评语：", 10, true, false, "374151");
        multiline(doc, sub.getTeacherComment() != null && !sub.getTeacherComment().isBlank()
                ? sub.getTeacherComment() : "（尚未填写评语）");
        return doc;
    }

    private void questionBlock(XWPFDocument doc, int no, double fullScore, Question q, JsonNode val,
                               Map<String, Object> detail) {
        blank(doc);
        XWPFParagraph p = doc.createParagraph();
        p.setSpacingBefore(80);
        run(p, "第 " + no + " 题 · " + qtypeLabel(q.getType()) + "（满分 " + fmt(fullScore) + " 分）",
                11, true, false, "1F2937");

        // 题干
        multiline(doc, "题干：" + nz(q.getTitle()));

        // 选项（单选/多选/判断）：标注正确答案与学生选择
        if ("SINGLE".equals(q.getType()) || "MULTI".equals(q.getType())) {
            for (JsonNode o : parseNode(q.getOptions())) {
                boolean isKey = inAnswer(q, o.path("key").asText(""));
                boolean isStu = studentPicked(val, o.path("key").asText(""));
                multiline(doc, "    " + o.path("key").asText() + ". " + o.path("text").asText()
                        + (isKey ? "  【正确答案】" : "") + (isStu ? "  【学生选择】" : ""));
            }
        } else if ("JUDGE".equals(q.getType())) {
            boolean key = firstBoolean(q.getAnswer(), true);
            multiline(doc, "    A. 正确" + (key ? "  【正确答案】" : "")
                    + (Boolean.TRUE.equals(studentBool(val)) ? "  【学生选择】" : ""));
            multiline(doc, "    B. 错误" + (!key ? "  【正确答案】" : "")
                    + (Boolean.FALSE.equals(studentBool(val)) ? "  【学生选择】" : ""));
        } else {
            String ref = firstText(q.getAnswer());
            if (ref != null && !ref.isBlank()) {
                multiline(doc, "参考答案：" + ref);
            }
        }
        if (q.getAnalysis() != null && !q.getAnalysis().isBlank()) {
            multiline(doc, "解析：" + q.getAnalysis());
        }
        // 学生作答
        multiline(doc, "学生作答：" + answerText(q, val));
        // 客观题得分（程序判分；主观题逐题得分包含在 AI 初评评分依据中）
        if (detail != null && !Boolean.TRUE.equals(detail.get("subjective")) && detail.get("score") != null) {
            String why = Boolean.TRUE.equals(detail.get("correct")) ? "作答与标准答案一致" : "作答与标准答案不符";
            multiline(doc, "客观题得分：" + detail.get("score") + " 分（" + why + "）");
        }
    }

    /* ---------------- Word 排版辅助 ---------------- */

    private void title(XWPFDocument doc, String text, int size, boolean bold) {
        title(doc, text, size, bold, false);
    }

    private void title(XWPFDocument doc, String text, int size, boolean bold, boolean gray) {
        XWPFParagraph p = doc.createParagraph();
        p.setAlignment(ParagraphAlignment.CENTER);
        run(p, text, size, bold, false, gray ? "6B7280" : "111827");
    }

    private void heading(XWPFDocument doc, String text) {
        XWPFParagraph p = doc.createParagraph();
        p.setSpacingBefore(120);
        run(p, text, 13, true, false, "4338CA");
    }

    private void kv(XWPFDocument doc, String k, String v) {
        XWPFParagraph p = doc.createParagraph();
        run(p, k + "：", 10, true, false, "374151");
        // v 为 null 表示评语走下方多行段落
        if (v != null) {
            run(p, v, 10, false, false, "111827");
        }
    }

    /** 多行文本：按行拆分为独立段落，避免 XWPFRun 对 \n 的不兼容渲染 */
    private void multiline(XWPFDocument doc, String text) {
        String t = text == null || text.isBlank() ? "" : text;
        String[] lines = t.replace("\r\n", "\n").replace("\r", "\n").split("\n", -1);
        for (String line : lines) {
            XWPFParagraph p = doc.createParagraph();
            run(p, line, 10, false, false, "111827");
        }
    }

    private void blank(XWPFDocument doc) {
        doc.createParagraph();
    }

    private void run(XWPFParagraph p, String text, int size, boolean bold, boolean italic, String color) {
        XWPFRun r = p.createRun();
        r.setText(text);
        r.setFontFamily("微软雅黑");
        r.setFontSize(size);
        r.setBold(bold);
        r.setItalic(italic);
        if (color != null) {
            r.setColor(color);
        }
    }

    /* ---------------- 数据解析辅助 ---------------- */

    /** answers JSON：[{questionId, value}] -> questionId -> value 节点 */
    private Map<String, JsonNode> parseAnswers(String answersJson) {
        Map<String, JsonNode> map = new LinkedHashMap<>();
        if (answersJson == null || answersJson.isBlank()) {
            return map;
        }
        try {
            JsonNode arr = objectMapper.readTree(answersJson);
            if (arr.isArray()) {
                for (JsonNode n : arr) {
                    map.put(n.path("questionId").asText(""), n.path("value"));
                }
            }
        } catch (Exception e) {
            log.warn("解析学生作答 JSON 失败：{}", e.getMessage());
        }
        return map;
    }

    private JsonNode parseNode(String json) {
        try {
            JsonNode n = objectMapper.readTree(json == null || json.isBlank() ? "[]" : json);
            return n.isArray() ? n : objectMapper.createArrayNode();
        } catch (Exception e) {
            return objectMapper.createArrayNode();
        }
    }

    /** 学生作答的可读文本（与前端批阅页展示口径一致） */
    private String answerText(Question q, JsonNode val) {
        if (val == null || val.isNull() || (val.isTextual() && val.asText().isBlank())
                || (val.isArray() && val.isEmpty())) {
            return "（未作答）";
        }
        return switch (q.getType() == null ? "" : q.getType()) {
            case "JUDGE" -> val.asBoolean() ? "正确（A）" : "错误（B）";
            case "SINGLE", "MULTI" -> {
                List<String> ks = new ArrayList<>();
                if (val.isArray()) {
                    val.forEach(n -> ks.add(n.asText()));
                } else {
                    ks.add(val.asText());
                }
                yield String.join("、", ks);
            }
            default -> val.isTextual() ? val.asText() : val.toString();
        };
    }

    private boolean inAnswer(Question q, String key) {
        for (JsonNode a : parseNode(q.getAnswer())) {
            if (key.equals(a.asText())) {
                return true;
            }
        }
        return false;
    }

    private boolean studentPicked(JsonNode val, String key) {
        if (val == null) {
            return false;
        }
        if (val.isArray()) {
            for (JsonNode v : val) {
                if (key.equals(v.asText())) {
                    return true;
                }
            }
            return false;
        }
        return key.equals(val.asText());
    }

    private Boolean studentBool(JsonNode val) {
        return val != null && val.isBoolean() ? val.asBoolean() : null;
    }

    private boolean firstBoolean(String answerJson, boolean dft) {
        JsonNode arr = parseNode(answerJson);
        return arr.size() > 0 && arr.get(0).isBoolean() ? arr.get(0).asBoolean() : dft;
    }

    private String firstText(String answerJson) {
        JsonNode arr = parseNode(answerJson);
        return arr.size() > 0 && !arr.get(0).isNull() ? arr.get(0).asText() : "";
    }

    /** 题目满分：CUSTOM 模式取题目分值，其余百分制均分（与教师端批阅页口径一致） */
    private double questionMax(Question q, List<Question> all) {
        if (q.getScore() != null) {
            return q.getScore().doubleValue();
        }
        return all != null && !all.isEmpty() ? Math.round(1000.0 / all.size()) / 10.0 : 0;
    }

    private String qtypeLabel(String type) {
        return switch (type == null ? "" : type) {
            case "SINGLE" -> "单选题";
            case "MULTI" -> "多选题";
            case "FILL" -> "填空题";
            case "JUDGE" -> "判断题";
            case "SHORT" -> "简答题";
            case "CODE" -> "编程题";
            default -> "题目";
        };
    }

    private String statusLabel(String status) {
        return switch (status == null ? "" : status.toUpperCase()) {
            case "GRADED" -> "已批改";
            case "AI_REVIEWED" -> "AI初评完成 · 待复核";
            case "PENDING" -> "待批改";
            default -> status == null ? "未知" : status;
        };
    }

    private String fmt(double v) {
        return v == Math.rint(v) ? String.valueOf((long) v) : String.valueOf(v);
    }

    private String nz(String s) {
        return s == null || s.isBlank() ? "（无题干）" : s;
    }

    /** 文件名/压缩包条目名净化：替换 Windows 非法字符，限长防超长 */
    private String sanitize(String s) {
        String t = (s == null ? "" : s).replaceAll("[\\\\/:*?\"<>|\\r\\n\\t]", "_").trim();
        if (t.length() > 60) {
            t = t.substring(0, 60);
        }
        return t;
    }
}
