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
     * 题目型作业 AI 初评：客观题（单选/多选/判断）程序判分，
     * 主观题（填空/简答/编程）交给 AI 按题干/参考答案/解析逐题评分；输出逐题点评
     */
    private Map<String, Object> aiGradeCompose(Submission sub, Assignment as) {
        long t0 = System.currentTimeMillis();
        List<Question> questions = questionMapper.selectList(new LambdaQueryWrapper<Question>()
                .eq(Question::getAssignmentId, as.getId()).orderByAsc(Question::getSortOrder));
        if (questions.isEmpty()) {
            throw new BizException("该作业没有题目，无法 AI 初评");
        }
        List<Object> answers = parseAnswerObjects(sub.getAnswers());
        Map<String, JsonNode> ansMap = new LinkedHashMap<>();
        for (Object o : answers) {
            try {
                JsonNode n = objectMapper.readTree(objectMapper.writeValueAsString(o));
                ansMap.put(n.path("questionId").asText(""), n.path("value"));
            } catch (Exception ignore) { }
        }
        // 题号 -> 得分；先算客观题
        Map<Integer, Double> scores = new LinkedHashMap<>();
        StringBuilder comment = new StringBuilder();
        double objective = 0;
        List<Question> subjective = new ArrayList<>();
        for (int i = 0; i < questions.size(); i++) {
            Question q = questions.get(i);
            JsonNode val = ansMap.get(String.valueOf(q.getId()));
            if (isObjective(q.getType())) {
                double s = composeObjectiveScore(q, val, questions);
                scores.put(i + 1, s);
                objective += s;
            } else {
                subjective.add(q);
            }
        }
        // 主观题 AI 评分（一次性批量提问，减少调用次数）
        if (!subjective.isEmpty()) {
            try {
                Map<Integer, Double> aiScores = aiScoreSubjective(as, questions, subjective, ansMap);
                double sum = 0;
                for (Map.Entry<Integer, Double> e : aiScores.entrySet()) {
                    scores.put(e.getKey(), e.getValue());
                    sum += e.getValue();
                }
                comment.append("AI 已按参考答案对主观题逐题评分。");
            } catch (Exception e) {
                // 主观题评分失败不阻塞整体：客观题得分仍可用，主观题留给教师批改
                log.warn("AI 初评主观题评分失败 submission={} reason={}", sub.getId(), e.getMessage());
                comment.append("主观题 AI 评分暂不可用，已保留客观题得分，主观题请人工批改。");
            }
        }
        double total = scores.values().stream().mapToDouble(Double::doubleValue).sum();
        // 逐题点评文本
        for (int i = 0; i < questions.size(); i++) {
            Question q = questions.get(i);
            double s = scores.getOrDefault(i + 1, 0.0);
            comment.append("\n第").append(i + 1).append("题（")
                    .append(qtypeLabel(q.getType())).append("，").append(scoreOf(q, questions)).append(" 分）：")
                    .append("得 ").append(s).append(" 分。");
        }

        sub.setAiScore((int) Math.round(total));
        sub.setAiComment(comment.toString());
        sub.setStatus("AI_REVIEWED");
        submissionMapper.updateById(sub);

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("aiScore", (int) Math.round(total));
        resp.put("aiComment", comment.toString());
        resp.put("rubricScores", new LinkedHashMap<String, Integer>());
        log.info("AI 初评（题目型）完成 submission={} assignment={} objective={} total={} cost={}ms",
                sub.getId(), as.getId(), objective, total, System.currentTimeMillis() - t0);
        return resp;
    }

    /** 主观题 AI 批量评分：返回 题号 -> 得分 */
    private Map<Integer, Double> aiScoreSubjective(Assignment as, List<Question> questions,
                                                   List<Question> subjective, Map<String, JsonNode> ansMap) {
        StringBuilder sb = new StringBuilder();
        sb.append("## 作业：").append(as.getTitle()).append('\n');
        sb.append("## 待评分的主观题（含参考答案与学生作答）\n");
        int no = 0;
        Map<String, Integer> keyToNo = new LinkedHashMap<>();
        for (Question q : questions) {
            if (!isObjective(q.getType())) {
                no++;
                keyToNo.put(String.valueOf(q.getId()), no);
            }
        }
        for (Question q : subjective) {
            JsonNode ref = parseAnswerNode(q.getAnswer());
            String refText = ref != null && ref.size() > 0 ? ref.get(0).asText() : "";
            String studentAns = answerNodeToText(ansMap.get(String.valueOf(q.getId())));
            sb.append("\n### 第 ").append(keyToNo.get(String.valueOf(q.getId()))).append(" 题（满分 ")
                    .append(scoreOf(q, questions)).append(" 分）\n")
                    .append("题干：").append(null2(q.getTitle())).append('\n')
                    .append("参考答案：").append(null2(refText)).append('\n')
                    .append("答案解析：").append(null2(q.getAnalysis())).append('\n')
                    .append("学生作答：").append(studentAns.isEmpty() ? "（未作答）" : studentAns).append('\n');
        }
        sb.append("\n请逐题评分。未作答记 0 分，与参考答案一致或表述等价给满分，")
                .append("部分正确按比例给分，得分不得超过该题满分。")
                .append("严格只输出 JSON：{\"scores\":{\"题号\":得分},\"comments\":{\"题号\":\"一句话点评\"}}。");
        String raw = chatWithRetry(List.of(ChatMessage.system(
                        "你是 Java 课程助教，负责给作业的主观题评分，输出严格的 JSON，不要输出任何其他文字。"),
                ChatMessage.user(sb.toString())), "submission-subjective");
        Map<Integer, Double> out = new LinkedHashMap<>();
        String json = extractJson(raw);
        try {
            JsonNode root = objectMapper.readTree(json);
            JsonNode scoresNode = root.path("scores");
            int subjectiveNo = 0;
            for (int i = 0; i < questions.size(); i++) {
                Question q = questions.get(i);
                if (isObjective(q.getType())) {
                    continue;
                }
                subjectiveNo++;
                double max = scoreOf(q, questions);
                double s = Math.max(0, Math.min(scoresNode.path(String.valueOf(subjectiveNo)).asDouble(0), max));
                out.put(i + 1, Math.round(s * 10) / 10.0);
            }
        } catch (Exception e) {
            throw new BizException("主观题评分结果解析失败");
        }
        return out;
    }

    /** 客观题程序判分（单选/多选/判断），与提交时的判分口径一致；
     *  all 为整卷题目列表，用于 AVERAGE 模式下按题数均摊满分 */
    private double composeObjectiveScore(Question q, JsonNode val, List<Question> all) {
        if (val == null || val.isNull()) {
            return 0;
        }
        // 学生作答可能是标量（单选 "A" / 判断 true）或数组（多选），统一成数组再比对
        JsonNode mine = val.isArray() ? val : objectMapper.createArrayNode().add(val);
        JsonNode correct = parseAnswerNode(q.getAnswer());
        boolean ok = false;
        if ("SINGLE".equals(q.getType()) || "JUDGE".equals(q.getType())) {
            ok = correct.size() == 1 && mine.size() == 1 && nodeEquals(correct.get(0), mine.get(0));
        } else if ("MULTI".equals(q.getType())) {
            if (mine.size() != correct.size()) {
                ok = false;
            } else {
                ok = true;
                for (int i = 0; i < mine.size(); i++) {
                    boolean found = false;
                    for (int j = 0; j < correct.size(); j++) {
                        if (nodeEquals(correct.get(j), mine.get(i))) {
                            found = true;
                            break;
                        }
                    }
                    if (!found) { ok = false; break; }
                }
            }
        }
        return ok ? scoreOf(q, all) : 0;
    }

    private boolean nodeEquals(JsonNode a, JsonNode b) {
        // asText 统一布尔/字符串/数字的文本表示（BooleanNode→"true"，TextNode→原文）
        return a.asText().equals(b.asText());
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

    private boolean isObjective(String type) {
        return "SINGLE".equals(type) || "MULTI".equals(type) || "JUDGE".equals(type);
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
     * 批量 AI 初评（异步，走 gradingExecutor 线程池）：单份失败不阻塞，结束通知含成功/失败数
     */
    @Async("gradingExecutor")
    public void aiGradeBatch(Long assignmentId, Long teacherId) {
        List<Submission> pending = submissionMapper.selectList(new LambdaQueryWrapper<Submission>()
                .eq(Submission::getAssignmentId, assignmentId)
                .eq(Submission::getStatus, "PENDING"));
        int ok = 0, fail = 0;
        for (Submission sub : pending) {
            try {
                aiGrade(sub.getId());
                ok++;
            } catch (Exception e) {
                fail++;
                log.warn("批量初评失败 submission={} assignment={} reason={}",
                        sub.getId(), assignmentId, e.getMessage());
            }
        }
        notificationService.push(teacherId, "批量 AI 初评完成：作业 #" + assignmentId
                + " 成功 " + ok + " 份"
                + (fail > 0 ? "，失败 " + fail + " 份（可稍后重试）" : "")
                + "，共 " + pending.size() + " 份。", "TEACHER");
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
