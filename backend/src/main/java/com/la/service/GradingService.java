package com.la.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.ai.AgentPrompts;
import com.la.ai.ChatMessage;
import com.la.ai.LlmClient;
import com.la.config.DeepSeekProperties;
import com.la.entity.*;
import com.la.exception.BizException;
import com.la.mapper.*;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.*;
import java.util.stream.Collectors;

/**
 * AI 批改：Rubric 驱动 + Temperature=0 + JSON 容错
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class GradingService {

    private final LlmClient llmClient;
    private final DeepSeekProperties props;
    private final ObjectMapper objectMapper;
    private final SubmissionMapper submissionMapper;
    private final AssignmentMapper assignmentMapper;
    private final RubricMapper rubricMapper;
    private final RubricScoreMapper rubricScoreMapper;
    private final QuestionMapper questionMapper;
    private final UserMapper userMapper;
    private final NotificationService notificationService;
    private final SessionService sessionService;
    private final SessionMapper sessionMapper;
    /** 学生端「系统自动评分」引擎：客观题判分的唯一口径（教师端 AI 初评复用） */
    private final AutoScoreService autoScoreService;

    /**
     * 单份 AI 初评（同步）。题目型作业（scoreMode 非空）走逐题判分，Rubric 型作业走评分维度流程
     */
    @Transactional
    public Map<String, Object> aiGrade(Long submissionId) {
        Submission sub = submissionMapper.selectById(submissionId);
        if (sub == null) {
            throw new BizException("提交不存在");
        }
        Assignment as = assignmentMapper.selectById(sub.getAssignmentId());
        if (as == null) {
            throw new BizException("作业不存在");
        }
        if (as.getScoreMode() != null) {
            return aiGradeCompose(sub, as);
        }
        long t0 = System.currentTimeMillis();
        List<Rubric> rubrics = rubricMapper.selectList(new LambdaQueryWrapper<Rubric>()
                .eq(Rubric::getAssignmentId, as.getId()).orderByAsc(Rubric::getSortOrder));

        String prompt = buildPrompt(as, rubrics, sub);
        List<ChatMessage> messages = List.of(
                ChatMessage.system(null2(AgentPromptsHelper.loadGradingPrompt())),
                ChatMessage.user(prompt));
        String raw = chatWithRetry(messages, "submission=" + submissionId);
        AiGradeResult result = parseGradeResult(raw, rubrics);

        sub.setAiScore(result.aiScore);
        sub.setAiComment(result.comment);
        sub.setStatus("AI_REVIEWED");
        submissionMapper.updateById(sub);

        // 保存 AI 逐项评分
        rubricScoreMapper.delete(new LambdaQueryWrapper<RubricScore>()
                .eq(RubricScore::getSubmissionId, sub.getId()));
        for (Map.Entry<Long, Integer> e : result.rubricScores.entrySet()) {
            RubricScore rs = new RubricScore();
            rs.setSubmissionId(sub.getId());
            rs.setRubricId(e.getKey());
            rs.setScore(e.getValue());
            rubricScoreMapper.insert(rs);
        }

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("aiScore", result.aiScore);
        resp.put("aiComment", result.comment);
        resp.put("rubricScores", result.rubricScores.entrySet().stream()
                .collect(Collectors.toMap(e -> rubricName(rubrics, e.getKey()), Map.Entry::getValue,
                        (a, b) -> a, LinkedHashMap::new)));
        log.info("AI 初评完成 submission={} assignment={} score={} cost={}ms",
                submissionId, as.getId(), result.aiScore, System.currentTimeMillis() - t0);
        return resp;
    }

    /**
     * 题目型作业 AI 初评（全题型批量评分）：
     * - 客观题（单选/多选/判断/填空）：复用学生端「系统自动评分」引擎（AutoScoreService），
     *   按参考答案严格匹配判分，与学生端临时分数口径完全一致；
     * - 简答题：AI 语义评分——核心表意与参考答案一致或高度接近即可得高分，无需逐字匹配；
     * - 编程题：AI 多维度评审——语法正确性/逻辑符合度/功能完整性/可运行性/是否存在报错；
     * - 逐题输出评分依据（aiComment），便于教师快速核对与人工复核调整。
     */
    private Map<String, Object> aiGradeCompose(Submission sub, Assignment as) {
        long t0 = System.currentTimeMillis();
        List<Question> questions = questionMapper.selectList(new LambdaQueryWrapper<Question>()
                .eq(Question::getAssignmentId, as.getId()).orderByAsc(Question::getSortOrder));
        if (questions.isEmpty()) {
            throw new BizException("该作业没有题目，无法 AI 初评");
        }
        Map<String, JsonNode> ansMap = new LinkedHashMap<>();
        for (Object o : parseAnswerObjects(sub.getAnswers())) {
            try {
                JsonNode n = objectMapper.readTree(objectMapper.writeValueAsString(o));
                ansMap.put(n.path("questionId").asText(""), n.path("value"));
            } catch (Exception ignore) { }
        }
        // ---- 客观题：直接复用系统自动评分引擎（严格匹配参考答案，口径与学生端一致） ----
        Map<String, Object> auto = autoScoreService.objectiveScore(as.getId(), sub.getAnswers());
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> detail = (List<Map<String, Object>>) auto.get("detail");
        Map<Integer, Double> scores = new LinkedHashMap<>();   // 题号 -> 得分
        Map<Integer, String> rationale = new LinkedHashMap<>(); // 题号 -> 评分依据
        double objective = 0;
        for (int i = 0; i < questions.size() && i < detail.size(); i++) {
            Map<String, Object> d = detail.get(i);
            if (Boolean.TRUE.equals(d.get("subjective"))) {
                continue;
            }
            double s = d.get("score") != null ? ((Number) d.get("score")).doubleValue() : 0;
            boolean correct = Boolean.TRUE.equals(d.get("correct"));
            scores.put(i + 1, s);
            objective += s;
            rationale.put(i + 1, correct ? "作答与标准答案一致" : "作答与标准答案不符（正确答案：" + refText(questions.get(i)) + "）");
        }
        // ---- 主观题：简答（语义匹配）/ 编程（多维度评审）分别走专用 AI 评分 ----
        StringBuilder comment = new StringBuilder();
        List<Question> shorts = new ArrayList<>();
        List<Question> codes = new ArrayList<>();
        for (Question q : questions) {
            if ("SHORT".equals(q.getType())) { shorts.add(q); }
            else if ("CODE".equals(q.getType())) { codes.add(q); }
        }
        boolean aiOk = true;
        if (!shorts.isEmpty()) {
            try {
                AiReview r = aiReview(as, questions, shorts, ansMap, false);
                scores.putAll(r.scores());
                rationale.putAll(r.comments());
            } catch (Exception e) {
                aiOk = false;
                log.warn("AI 初评简答题评分失败 submission={} reason={}", sub.getId(), e.getMessage());
                comment.append("简答题 AI 评分暂不可用，该部分请人工批改。");
            }
        }
        if (!codes.isEmpty()) {
            try {
                AiReview r = aiReview(as, questions, codes, ansMap, true);
                scores.putAll(r.scores());
                rationale.putAll(r.comments());
            } catch (Exception e) {
                aiOk = false;
                log.warn("AI 初评编程题评审失败 submission={} reason={}", sub.getId(), e.getMessage());
                comment.append("编程题 AI 评审暂不可用，该部分请人工批改。");
            }
        }
        if (aiOk && (!shorts.isEmpty() || !codes.isEmpty())) {
            comment.append("客观题按标准答案严格匹配，简答题按语义匹配度、编程题按多维度评审，逐题评分依据如下：");
        } else if (!shorts.isEmpty() || !codes.isEmpty()) {
            comment.append("客观题得分如下：");
        }
        double total = scores.values().stream().mapToDouble(Double::doubleValue).sum();
        // ---- 逐题点评 + 评分依据 ----
        for (int i = 0; i < questions.size(); i++) {
            Question q = questions.get(i);
            double s = scores.getOrDefault(i + 1, 0.0);
            comment.append("\n第").append(i + 1).append("题（")
                    .append(qtypeLabel(q.getType())).append("，").append(fmtScore(scoreOf(q, questions))).append(" 分）：")
                    .append("得 ").append(fmtScore(s)).append(" 分。")
                    .append(rationale.getOrDefault(i + 1, "待人工评分"));
        }

        sub.setAiScore((int) Math.round(total));
        sub.setAiComment(comment.toString());
        sub.setStatus("AI_REVIEWED");
        submissionMapper.updateById(sub);

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("aiScore", (int) Math.round(total));
        resp.put("aiComment", comment.toString());
        resp.put("rubricScores", new LinkedHashMap<String, Integer>());
        log.info("AI 初评（题目型·全题型）完成 submission={} assignment={} objective={} total={} cost={}ms",
                sub.getId(), as.getId(), objective, total, System.currentTimeMillis() - t0);
        return resp;
    }

    /** AI 评审结果：题号 -> 得分 / 题号 -> 评分依据 */
    private record AiReview(Map<Integer, Double> scores, Map<Integer, String> comments) { }

    /** 评分文本格式化：整数不带小数尾巴（10.0 → 10，22.5 保留） */
    private String fmtScore(double v) {
        return v == Math.rint(v) ? String.valueOf((long) v) : String.valueOf(v);
    }

    /** 客观题正确答案的可读文本（评分依据展示用） */
    private String refText(Question q) {
        JsonNode ans = parseAnswerNode(q.getAnswer());
        List<String> parts = new ArrayList<>();
        for (JsonNode a : ans) {
            parts.add("JUDGE".equals(q.getType()) ? (a.asBoolean() ? "正确" : "错误") : a.asText());
        }
        return String.join("、", parts);
    }

    /**
     * 主观题 AI 批量评审（一次请求评审一批，减少调用次数），返回逐题得分与评分依据。
     * @param isCode true = 编程题多维度评审（语法/逻辑/功能/可运行性/报错）；
     *               false = 简答题语义评分（核心表意一致或高度接近即高分，无需逐字匹配）
     */
    private AiReview aiReview(Assignment as, List<Question> questions, List<Question> batch,
                              Map<String, JsonNode> ansMap, boolean isCode) {
        StringBuilder sb = new StringBuilder();
        sb.append("## 作业：").append(as.getTitle()).append('\n');
        sb.append(isCode ? "## 待评审的编程题（含参考实现与学生代码）\n"
                         : "## 待评分的简答题（含参考答案与学生作答）\n");
        for (Question q : batch) {
            JsonNode ref = parseAnswerNode(q.getAnswer());
            String refText = ref.size() > 0 ? ref.get(0).asText() : "";
            String studentAns = answerNodeToText(ansMap.get(String.valueOf(q.getId())));
            // 题号使用整卷序号（与逐题点评一致，便于教师定位）
            int no = questions.indexOf(q) + 1;
            sb.append("\n### 第 ").append(no).append(" 题（满分 ")
                    .append(scoreOf(q, questions)).append(" 分）\n")
                    .append("题干：").append(null2(q.getTitle())).append('\n')
                    .append(isCode ? "参考实现：\n```java\n" : "参考答案：")
                    .append(null2(refText))
                    .append(isCode ? "\n```\n" : "\n")
                    .append("答案解析：").append(null2(q.getAnalysis())).append('\n')
                    .append(isCode ? "学生代码：\n```java\n" : "学生作答：")
                    .append(studentAns.isEmpty() ? "（未作答）" : studentAns)
                    .append(isCode ? "\n```\n" : "\n");
        }
        if (isCode) {
            sb.append("\n请按以下维度逐题评审代码：①语法正确性 ②逻辑是否符合题目要求 ③功能完整性 ④可运行性 ⑤是否存在报错。")
                    .append("评分规则：代码满足核心要求、语法正确、可正常运行并实现题目核心功能即给对应合理分数；")
                    .append("次要瑕疵（命名不规范、缺少注释等）少量扣分；核心功能缺失或存在编译错误按比例扣分；未作答记 0 分。");
        } else {
            sb.append("\n请逐题进行语义评分：学生作答的核心表意与参考答案一致或高度接近即可给高分（无需逐字匹配）；")
                    .append("部分正确按匹配度在合理区间内给分；答非所问或未作答记 0 分；得分不得超过该题满分。");
        }
        sb.append("严格只输出 JSON：{\"scores\":{\"题号\":得分},\"comments\":{\"题号\":\"一句话评分依据\"}}。");
        String raw = chatWithRetry(List.of(ChatMessage.system(
                        "你是 Java 课程助教，负责给作业的" + (isCode ? "编程题代码评审" : "简答题语义评分")
                                + "，只输出严格的 JSON，不要输出任何其他文字。"),
                ChatMessage.user(sb.toString())), isCode ? "submission-code" : "submission-short");
        log.debug("[AI初评] {} 通道原始返回：{}", isCode ? "编程题" : "简答题", raw);
        Map<Integer, Double> scores = new LinkedHashMap<>();
        Map<Integer, String> comments = new LinkedHashMap<>();
        try {
            JsonNode root = objectMapper.readTree(extractJson(raw));
            JsonNode scoresNode = root.path("scores");
            JsonNode commentsNode = root.path("comments");
            for (Question q : batch) {
                int no = questions.indexOf(q) + 1;
                double max = scoreOf(q, questions);
                double s = Math.max(0, Math.min(readNum(scoresNode, no), max));
                scores.put(no, Math.round(s * 10) / 10.0);
                String c = findByKey(commentsNode, no).asText("");
                comments.put(no, c.isBlank() ? "AI 语义评分" : c);
            }
        } catch (Exception e) {
            throw new BizException(isCode ? "编程题评审结果解析失败" : "简答题评分结果解析失败");
        }
        return new AiReview(scores, comments);
    }

    /**
     * AI 返回 JSON 的键名兼容查找：不同批次模型可能用 "5"、"第5题"、"5题"、"Q5" 等键名
     * （真实 DeepSeek 编程题评审曾返回 "第5题" 键名，严格按键名取值会漏读取到 0 分），
     * 先按常见键名直取，再兜底按「键名去除非数字字符后等于题号」模糊匹配。
     */
    private JsonNode findByKey(JsonNode node, int no) {
        if (node == null || !node.isObject()) {
            return objectMapper.createObjectNode();
        }
        for (String k : List.of(String.valueOf(no), "第" + no + "题", no + "题", "Q" + no, "q" + no)) {
            JsonNode v = node.path(k);
            if (!v.isMissingNode()) {
                return v;
            }
        }
        for (Iterator<String> it = node.fieldNames(); it.hasNext(); ) {
            String k = it.next();
            if (k.replaceAll("\\D+", "").equals(String.valueOf(no))) {
                return node.path(k);
            }
        }
        return objectMapper.createObjectNode();
    }

    /** 得分容错读取：兼容数字与字符串数字（如 "8.3"、"8.3分"） */
    private double readNum(JsonNode node, int no) {
        JsonNode v = findByKey(node, no);
        if (v.isNumber()) {
            return v.asDouble();
        }
        try {
            String t = v.asText("").replaceAll("[^0-9.\\-]", "");
            return t.isEmpty() ? 0 : Double.parseDouble(t);
        } catch (Exception e) {
            return 0;
        }
    }

    /** 题目满分：CUSTOM 自定义模式下题目自带 score；AVERAGE 百分制（平均分配）模式下
     *  score 为空，须按前端同口径以 100 分均摊（Math.round(1000/n)/10，保留 1 位小数），
     *  否则答对也得 0 分（曾导致 AI 初评全零分误判） */
    private double scoreOf(Question q, List<Question> all) {
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
            default -> type;
        };
    }

    private JsonNode parseAnswerNode(String json) {
        try {
            JsonNode n = objectMapper.readTree(null2(json));
            return n.isArray() ? n : objectMapper.createArrayNode();
        } catch (Exception e) {
            return objectMapper.createArrayNode();
        }
    }

    private List<Object> parseAnswerObjects(String json) {
        try {
            return objectMapper.readValue(null2(json).isBlank() ? "[]" : json, objectMapper.getTypeFactory()
                    .constructCollectionType(List.class, Object.class));
        } catch (Exception e) {
            return List.of();
        }
    }

    private String answerNodeToText(Object v) {
        if (v == null) {
            return "";
        }
        try {
            JsonNode n = objectMapper.readTree(objectMapper.writeValueAsString(v));
            return n.isTextual() ? n.asText() : String.valueOf(v);
        } catch (Exception e) {
            return String.valueOf(v);
        }
    }

    /**
     * AI 调用（带一次自动重试）：网络波动/超时类临时故障退避 800ms 重试一次，
     * 仍失败抛出友好异常，不阻塞批量流程中的其他提交
     */
    private String chatWithRetry(List<ChatMessage> messages, String bizKey) {
        RuntimeException last = null;
        for (int attempt = 0; attempt < 2; attempt++) {
            try {
                return llmClient.chat(messages, props.getGradeTemperature());
            } catch (RuntimeException e) {
                last = e;
                if (attempt == 0) {
                    log.warn("AI 调用失败（将重试一次）biz={} reason={}", bizKey, e.getMessage());
                    try { Thread.sleep(800); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); }
                }
            }
        }
        log.error("AI 调用重试后仍失败 biz={} ", bizKey, last);
        throw new BizException("AI 初评失败：AI 服务暂不可用（网络波动或服务超时），请稍后重试");
    }

    /**
     * 批量 AI 初评（异步，走 gradingExecutor 线程池）：单份失败不阻塞，结束通知含成功/失败数。
     * 单作业入口（兼容旧接口）。
     */
    @Async("gradingExecutor")
    public void aiGradeBatch(Long assignmentId, Long teacherId) {
        doAiGradeBatch(List.of(assignmentId), teacherId);
    }

    /**
     * 批量 AI 初评（异步）：一次对多份作业的全部待批改提交执行 AI 初评，
     * 完成后汇总通知教师（含各作业成功/失败明细）。
     */
    @Async("gradingExecutor")
    public void aiGradeBatch(List<Long> assignmentIds, Long teacherId) {
        doAiGradeBatch(assignmentIds, teacherId);
    }

    private void doAiGradeBatch(List<Long> assignmentIds, Long teacherId) {
        int okTotal = 0, failTotal = 0, asCount = 0;
        List<String> parts = new ArrayList<>();
        for (Long asId : assignmentIds) {
            List<Submission> pending = submissionMapper.selectList(new LambdaQueryWrapper<Submission>()
                    .eq(Submission::getAssignmentId, asId)
                    .eq(Submission::getStatus, "PENDING"));
            if (pending.isEmpty()) {
                continue;
            }
            asCount++;
            int ok = 0, fail = 0;
            for (Submission sub : pending) {
                try {
                    aiGrade(sub.getId());
                    ok++;
                } catch (Exception e) {
                    fail++;
                    log.warn("批量初评失败 submission={} assignment={} reason={}",
                            sub.getId(), asId, e.getMessage());
                }
            }
            okTotal += ok;
            failTotal += fail;
            Assignment as = assignmentMapper.selectById(asId);
            parts.add("「" + (as != null ? as.getTitle() : "#" + asId) + "」" + ok + "/" + pending.size()
                    + (fail > 0 ? "（失败 " + fail + "）" : ""));
        }
        notificationService.push(teacherId, "批量 AI 初评完成：" + asCount + " 份作业共 "
                + (okTotal + failTotal) + " 份提交，成功 " + okTotal + " 份"
                + (failTotal > 0 ? "，失败 " + failTotal + " 份（可稍后重试）" : "")
                + (parts.size() > 1 ? "。" + String.join("、", parts) : "。"), "TEACHER");
    }

    /**
     * 教师发布评分：写回 score/rubricScores → 学生通知 + 会话 feedback 卡片回流。
     * 题目型作业（scoreMode 非空）无 Rubric 维度，教师直接给总分。
     */
    @Transactional
    public void teacherGrade(Long submissionId, Map<String, Integer> rubricScoresByName, String comment,
                             Integer totalScore) {
        Submission sub = submissionMapper.selectById(submissionId);
        if (sub == null) {
            throw new BizException("提交不存在");
        }
        Assignment as = assignmentMapper.selectById(sub.getAssignmentId());
        List<Rubric> rubrics = rubricMapper.selectList(new LambdaQueryWrapper<Rubric>()
                .eq(Rubric::getAssignmentId, as.getId()).orderByAsc(Rubric::getSortOrder));

        int total;
        if (as.getScoreMode() != null) {
            // 题目型作业：教师直接录入总分（客观题自动判分结果可作参考）
            total = Math.max(0, Math.min(totalScore != null ? totalScore : 0, 100));
            rubricScoreMapper.delete(new LambdaQueryWrapper<RubricScore>()
                    .eq(RubricScore::getSubmissionId, sub.getId()));
        } else {
            total = 0;
            rubricScoreMapper.delete(new LambdaQueryWrapper<RubricScore>()
                    .eq(RubricScore::getSubmissionId, sub.getId()));
            for (Rubric r : rubrics) {
                Integer score = rubricScoresByName.get(r.getName());
                if (score != null) {
                    int s = Math.min(score, r.getMaxScore());
                    total += s;
                    RubricScore rs = new RubricScore();
                    rs.setSubmissionId(sub.getId());
                    rs.setRubricId(r.getId());
                    rs.setScore(s);
                    rubricScoreMapper.insert(rs);
                }
            }
        }
        sub.setScore(total);
        sub.setTeacherComment(comment != null ? comment : "");
        sub.setStatus("GRADED");
        sub.setGradedAt(LocalDateTime.now());
        submissionMapper.updateById(sub);

        // 学生通知
        notificationService.push(sub.getStudentId(),
                "作业「" + as.getTitle() + "」已批改：" + total + " 分。查看教师评语与 Rubric 逐项得分。", "GRADE");

        // 会话内 feedback 卡片回流（写入学生最近一个会话）
        SessionEntity latest = sessionMapper.selectOne(new LambdaQueryWrapper<SessionEntity>()
                .eq(SessionEntity::getUserId, sub.getStudentId())
                .orderByDesc(SessionEntity::getUpdatedAt).last("LIMIT 1"));
        if (latest != null) {
            Map<String, Object> card = new LinkedHashMap<>();
            card.put("type", "feedback");
            card.put("asId", String.valueOf(as.getId()));
            card.put("title", as.getTitle());
            card.put("score", total);
            card.put("comment", comment != null ? comment : "");
            sessionService.insertMessage(latest.getId(), "AGENT", "grading",
                    "你的作业「" + as.getTitle() + "」批改完成，得分 **" + total + "**。详细评语见卡片，也可在「我的作业」查看。",
                    "feedback", card);
        }
    }

    private String buildPrompt(Assignment as, List<Rubric> rubrics, Submission sub) {
        StringBuilder sb = new StringBuilder();
        sb.append("## 作业信息\n标题：").append(as.getTitle())
                .append("\n要求：").append(null2(as.getDescription())).append('\n');
        sb.append("\n## Rubric 评分标准\n");
        for (Rubric r : rubrics) {
            sb.append("- ").append(r.getName()).append("（满分 ").append(r.getMaxScore()).append("）：")
                    .append(null2(r.getDescription())).append('\n');
        }
        sb.append("\n## 学生代码\n```java\n").append(null2(sub.getCode())).append("\n```\n");
        sb.append("\n请按 JSON 格式输出评分结果。");
        return sb.toString();
    }

    private AiGradeResult parseGradeResult(String raw, List<Rubric> rubrics) {
        String json = extractJson(raw);
        for (int attempt = 0; attempt < 2; attempt++) {
            try {
                JsonNode root = objectMapper.readTree(json);
                AiGradeResult result = new AiGradeResult();
                result.aiScore = root.path("aiScore").asInt(0);
                result.comment = root.path("comment").asText("");
                JsonNode scores = root.path("rubricScores");
                Map<Long, Integer> byId = new LinkedHashMap<>();
                for (Rubric r : rubrics) {
                    if (scores.has(r.getName())) {
                        byId.put(r.getId(), Math.min(scores.get(r.getName()).asInt(0), r.getMaxScore()));
                    }
                }
                if (result.aiScore == 0 && byId.isEmpty()) {
                    throw new IllegalStateException("空评分结果");
                }
                if (result.aiScore == 0) {
                    result.aiScore = byId.values().stream().mapToInt(Integer::intValue).sum();
                }
                result.rubricScores = byId;
                return result;
            } catch (Exception e) {
                if (attempt == 1) {
                    // 降级：纯文本评语
                    AiGradeResult fallback = new AiGradeResult();
                    fallback.aiScore = 0;
                    fallback.comment = "AI 初评解析失败（原文摘要）：" + shorten(raw);
                    fallback.rubricScores = new LinkedHashMap<>();
                    return fallback;
                }
                json = repairJson(json);
            }
        }
        throw new BizException("评分解析失败");
    }

    private String extractJson(String raw) {
        if (raw == null) {
            return "{}";
        }
        String t = raw.trim();
        t = t.replace("```json", "").replace("```", "").trim();
        int start = t.indexOf('{');
        int end = t.lastIndexOf('}');
        if (start >= 0 && end > start) {
            return t.substring(start, end + 1);
        }
        return t;
    }

    private String repairJson(String json) {
        // 去尾逗号
        return json.replaceAll(",\\s*}", "}").replaceAll(",\\s*]", "]");
    }

    private String rubricName(List<Rubric> rubrics, Long id) {
        return rubrics.stream().filter(r -> r.getId().equals(id))
                .findFirst().map(Rubric::getName).orElse(String.valueOf(id));
    }

    private String shorten(String s) {
        return s != null && s.length() > 120 ? s.substring(0, 120) + "…" : s;
    }

    private String null2(String s) {
        return s != null ? s : "";
    }

    private static class AiGradeResult {
        int aiScore;
        String comment;
        Map<Long, Integer> rubricScores;
    }

    /** AgentPrompts 是 @Component，此处静态读取 grading 提示词 */
    private static class AgentPromptsHelper {
        private static final com.la.ai.AgentPrompts PROMPTS = new com.la.ai.AgentPrompts();
        static {
            PROMPTS.load();
        }
        static String loadGradingPrompt() {
            return PROMPTS.get(AgentPrompts.GRADING);
        }
    }
}
