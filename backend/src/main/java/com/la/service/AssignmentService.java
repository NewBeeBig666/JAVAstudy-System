package com.la.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.dto.ComposeRequest;
import com.la.entity.*;
import com.la.exception.BizException;
import com.la.mapper.*;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.stream.Collectors;

/**
 * 作业服务（学生侧 + 教师发布）
 */
@Service
@RequiredArgsConstructor
public class AssignmentService {

    private final AssignmentMapper assignmentMapper;
    private final RubricMapper rubricMapper;
    private final SubmissionMapper submissionMapper;
    private final RubricScoreMapper rubricScoreMapper;
    private final QuestionMapper questionMapper;
    private final ClassMapper classMapper;
    private final UserMapper userMapper;
    private final NotificationService notificationService;
    private final ObjectMapper objectMapper;

    private static final DateTimeFormatter DT = DateTimeFormatter.ofPattern("MM-dd HH:mm");
    private static final DateTimeFormatter DUE = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm");

    /**
     * 学生视角作业列表（含本人提交状态）
     */
    public List<Map<String, Object>> myAssignments(Long userId) {
        User user = userMapper.selectById(userId);
        if (user == null || user.getClassId() == null) {
            return List.of();
        }
        List<Assignment> assignments = assignmentMapper.selectList(new LambdaQueryWrapper<Assignment>()
                .eq(Assignment::getClassId, user.getClassId())
                .ne(Assignment::getStatus, "DRAFT")
                .orderByDesc(Assignment::getCreatedAt));
        List<Map<String, Object>> result = new ArrayList<>();
        for (Assignment as : assignments) {
            Map<String, Object> dto = toAssignmentDto(as);
            Submission sub = submissionMapper.selectOne(new LambdaQueryWrapper<Submission>()
                    .eq(Submission::getAssignmentId, as.getId())
                    .eq(Submission::getStudentId, userId));
            dto.put("mySubmission", sub != null ? toSubmissionDto(sub, false) : null);
            result.add(dto);
        }
        return result;
    }

    /**
     * 学生提交作业（AI 初评异步进行）
     */
    @Transactional
    public Map<String, Object> submit(Long userId, Long assignmentId, String code) {
        Assignment as = assignmentMapper.selectById(assignmentId);
        if (as == null) {
            throw new BizException("作业不存在");
        }
        if ("CLOSED".equals(as.getStatus())) {
            throw new BizException("作业已截止，无法提交");
        }
        if (code == null || code.isBlank()) {
            throw new BizException("代码不能为空");
        }
        Submission sub = submissionMapper.selectOne(new LambdaQueryWrapper<Submission>()
                .eq(Submission::getAssignmentId, assignmentId)
                .eq(Submission::getStudentId, userId));
        if (sub == null) {
            sub = new Submission();
            sub.setAssignmentId(assignmentId);
            sub.setStudentId(userId);
            sub.setCode(code);
            sub.setStatus("PENDING");
            sub.setAttempts(1);
            sub.setSimilarity(0);
            sub.setSubmittedAt(LocalDateTime.now());
            submissionMapper.insert(sub);
        } else {
            sub.setCode(code);
            sub.setStatus("PENDING");
            sub.setAttempts(sub.getAttempts() + 1);
            sub.setSubmittedAt(LocalDateTime.now());
            submissionMapper.updateById(sub);
        }
        return toSubmissionDto(sub, false);
    }

    /**
     * 学生答题提交（题目型作业）：结构化作答 + 客观题自动判分
     * answers 形如 [{"questionId":"5","value":"A"}]（单选 key / 多选 [keys] / 判断 true|false / 文本内容）
     */
    @Transactional
    public Map<String, Object> submitAnswer(Long userId, Long assignmentId, List<Map<String, Object>> answers) {
        Assignment as = assignmentMapper.selectById(assignmentId);
        if (as == null) {
            throw new BizException("作业不存在");
        }
        if (as.getScoreMode() == null) {
            throw new BizException("该作业不支持在线作答");
        }
        if ("CLOSED".equals(as.getStatus())) {
            throw new BizException("作业已截止，无法提交");
        }
        // 有效时段校验：截止后未关闭时，仅允许补交（allowLate=1）
        boolean overdue = as.getDueAt() != null && LocalDateTime.now().isAfter(as.getDueAt());
        if (overdue && (as.getAllowLate() == null || as.getAllowLate() != 1)) {
            throw new BizException("作业已截止，无法提交");
        }
        if (answers == null || answers.isEmpty()) {
            throw new BizException("请至少作答一道题目");
        }
        List<Question> questions = questionMapper.selectList(new LambdaQueryWrapper<Question>()
                .eq(Question::getAssignmentId, assignmentId).orderByAsc(Question::getSortOrder));
        Map<Long, Question> qMap = questions.stream()
                .collect(Collectors.toMap(Question::getId, q -> q));

        // 逐题校验 + 客观题自动判分 + 汇总文本（兼容教师批改页 code 展示）
        StringBuilder summary = new StringBuilder();
        double autoScore = 0;
        List<Map<String, Object>> clean = new ArrayList<>();
        for (Map<String, Object> a : answers) {
            Long qid;
            try {
                qid = Long.valueOf(String.valueOf(a.get("questionId")));
            } catch (Exception e) {
                continue;
            }
            Question q = qMap.get(qid);
            if (q == null) {
                continue;
            }
            Object value = a.get("value");
            boolean answered = value != null && !(value instanceof List && ((List<?>) value).isEmpty())
                    && !String.valueOf(value).isBlank();
            if (q.getScore() != null) {
                autoScore += gradeObjective(q, value, answered);
            }
            clean.add(Map.of("questionId", String.valueOf(qid), "value", value == null ? "" : value));
            summary.append('第').append(q.getSortOrder()).append("题：")
                    .append(answered ? answerText(q, value) : "未作答").append('\n');
        }
        if (clean.isEmpty()) {
            throw new BizException("作答内容无效");
        }

        Submission sub = submissionMapper.selectOne(new LambdaQueryWrapper<Submission>()
                .eq(Submission::getAssignmentId, assignmentId)
                .eq(Submission::getStudentId, userId));
        if (sub == null) {
            sub = new Submission();
            sub.setAssignmentId(assignmentId);
            sub.setStudentId(userId);
            sub.setStatus("PENDING");
            sub.setAttempts(1);
            sub.setSimilarity(0);
            sub.setSubmittedAt(LocalDateTime.now());
        } else {
            sub.setStatus("PENDING");
            sub.setAttempts(sub.getAttempts() + 1);
            sub.setSubmittedAt(LocalDateTime.now());
        }
        sub.setCode(summary.toString());
        sub.setAnswers(toJson(clean));
        if (sub.getId() == null) {
            submissionMapper.insert(sub);
        } else {
            submissionMapper.updateById(sub);
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("submission", toSubmissionDto(sub, false));
        result.put("autoScore", Math.round(autoScore * 10) / 10.0);
        result.put("attempted", clean.size());
        result.put("totalQuestions", questions.size());
        return result;
    }

    /** 客观题（SINGLE/MULTI/JUDGE）自动判分；主观题返回 0（由教师批改） */
    @SuppressWarnings("unchecked")
    private double gradeObjective(Question q, Object value, boolean answered) {
        if (!answered || !isObjective(q)) {
            return 0;
        }
        List<Object> correct = parseObjects(q.getAnswer());
        List<Object> mine = value instanceof List ? (List<Object>) value : List.of(value);
        boolean ok;
        if ("SINGLE".equals(q.getType()) || "JUDGE".equals(q.getType())) {
            ok = correct.size() == 1 && mine.size() == 1 && objEquals(correct.get(0), mine.get(0));
        } else {
            ok = correct.size() == mine.size() && correct.containsAll(mine)
                    && mine.containsAll(correct);
        }
        return ok ? q.getScore().doubleValue() : 0;
    }

    private boolean isObjective(Question q) {
        return "SINGLE".equals(q.getType()) || "MULTI".equals(q.getType()) || "JUDGE".equals(q.getType());
    }

    private boolean objEquals(Object a, Object b) {
        return String.valueOf(a).equals(String.valueOf(b));
    }

    /** 作答内容的可读文本（用于 code 汇总，教师批改页直接可读） */
    private String answerText(Question q, Object value) {
        if (!isObjective(q)) {
            String s = String.valueOf(value);
            return s.length() > 60 ? s.substring(0, 60) + "…" : s;
        }
        List<Object> mine = value instanceof List ? (List<Object>) value : List.of(value);
        if ("JUDGE".equals(q.getType())) {
            return mine.isEmpty() ? "-" : ("true".equals(String.valueOf(mine.get(0))) ? "正确" : "错误");
        }
        return mine.stream().map(String::valueOf).sorted().collect(Collectors.joining(""));
    }

    /**
     * 教师发布/修改作业
     */
    @Transactional
    public Map<String, Object> saveAssignment(Long teacherId, Long assignmentId, Long classId, String title,
                                              String description, List<String> kpCodes, String dueAt,
                                              String status, List<Map<String, Object>> rubric) {
        Assignment as;
        String oldStatus = null;
        if (assignmentId != null) {
            as = assignmentMapper.selectById(assignmentId);
            if (as == null) {
                throw new BizException("作业不存在");
            }
            oldStatus = as.getStatus();
        } else {
            as = new Assignment();
            as.setTeacherId(teacherId);
            as.setCreatedAt(LocalDateTime.now());
        }
        as.setClassId(classId);
        as.setTitle(title);
        as.setDescription(description);
        as.setKpIds(toJson(kpCodes));
        if (dueAt != null && !dueAt.isBlank()) {
            as.setDueAt(LocalDateTime.parse(dueAt.replace(' ', 'T')));
        }
        as.setStatus(status != null ? status : "DRAFT");
        if (as.getId() == null) {
            assignmentMapper.insert(as);
        } else {
            assignmentMapper.updateById(as);
        }
        // 重建 rubric
        if (rubric != null) {
            rubricMapper.delete(new LambdaQueryWrapper<Rubric>().eq(Rubric::getAssignmentId, as.getId()));
            for (int i = 0; i < rubric.size(); i++) {
                Map<String, Object> r = rubric.get(i);
                Rubric rb = new Rubric();
                rb.setAssignmentId(as.getId());
                rb.setName((String) r.get("name"));
                rb.setMaxScore(r.get("max") != null ? ((Number) r.get("max")).intValue() : 20);
                rb.setDescription((String) r.get("desc"));
                rb.setSortOrder(i + 1);
                rubricMapper.insert(rb);
            }
        }
        // 正式发布时通知全班（仅首次发布：修改已发布的作业不重复推送通知）
        notifyOnPublish(as, title, classId, oldStatus);
        return toAssignmentDto(as, true);
    }

    /**
     * 首次发布为 ONGOING 时通知全班学生（saveAssignment / saveCompose 共用）
     */
    private void notifyOnPublish(Assignment as, String title, Long classId, String oldStatus) {
        if ("ONGOING".equals(as.getStatus()) && !"ONGOING".equals(oldStatus)) {
            List<User> students = userMapper.selectList(new LambdaQueryWrapper<User>()
                    .eq(User::getClassId, classId).eq(User::getRole, "STUDENT"));
            for (User stu : students) {
                notificationService.push(stu.getId(), "新作业已发布：「" + title + "」"
                        + (as.getDueAt() != null ? "，截止 " + as.getDueAt().format(DUE) : ""), "ASSIGNMENT");
            }
        }
    }

    /**
     * 出题组卷：保存/发布题目型作业（单选/多选/填空/判断/简答/编程题）
     * 评分机制：AVERAGE=百分制均分 / CUSTOM=自定义分值（总分须为 100）
     * 时间设置：有效时段（startAt ~ endAt，endAt 写入 dueAt）+ 允许补交
     */
    @Transactional
    public Map<String, Object> saveCompose(Long teacherId, ComposeRequest req) {
        if (req.getTitle() == null || req.getTitle().isBlank()) {
            throw new BizException("请填写作业标题");
        }
        String scoreMode = "CUSTOM".equalsIgnoreCase(req.getScoreMode()) ? "CUSTOM" : "AVERAGE";
        String status = req.getStatus() != null ? req.getStatus().toUpperCase() : "DRAFT";
        if (!"DRAFT".equals(status) && !"ONGOING".equals(status)) {
            throw new BizException("作业状态不合法");
        }
        List<ComposeRequest.QuestionReq> questions = req.getQuestions() != null ? req.getQuestions() : List.of();
        if (questions.isEmpty()) {
            throw new BizException("请至少添加一道题目");
        }
        Set<String> validTypes = Set.of("SINGLE", "MULTI", "FILL", "JUDGE", "SHORT", "CODE");
        double scoreSum = 0;
        for (ComposeRequest.QuestionReq q : questions) {
            if (q.getType() == null || !validTypes.contains(q.getType())) {
                throw new BizException("存在不支持的题型");
            }
            if (q.getTitle() == null || q.getTitle().isBlank()) {
                throw new BizException("每道题目均需填写题干");
            }
            if (("SINGLE".equals(q.getType()) || "MULTI".equals(q.getType()))
                    && (q.getOptions() == null || q.getOptions().size() < 2)) {
                throw new BizException("单选题/多选题至少需要 2 个选项");
            }
            if (("SINGLE".equals(q.getType()) || "MULTI".equals(q.getType()) || "JUDGE".equals(q.getType()))
                    && q.getAnswer() == null) {
                throw new BizException("客观题需设置正确答案");
            }
            if (q.getScore() != null) {
                scoreSum += q.getScore();
            }
        }
        if ("CUSTOM".equals(scoreMode) && Math.abs(scoreSum - 100) > 0.01) {
            throw new BizException("自定义评分的总分必须为 100 分，当前为 " + BigDecimal.valueOf(scoreSum).stripTrailingZeros().toPlainString());
        }

        LocalDateTime startAt = req.getStartAt() != null && !req.getStartAt().isBlank()
                ? LocalDateTime.parse(req.getStartAt().replace(' ', 'T')) : LocalDateTime.now();
        LocalDateTime endAt = null;
        if (req.getEndAt() != null && !req.getEndAt().isBlank()) {
            endAt = LocalDateTime.parse(req.getEndAt().replace(' ', 'T'));
        }
        if (endAt == null || !endAt.isAfter(startAt)) {
            throw new BizException("结束时间必须晚于开始时间");
        }

        Assignment as;
        String oldStatus = null;
        if (req.getId() != null) {
            as = assignmentMapper.selectById(req.getId());
            if (as == null) {
                throw new BizException("作业不存在");
            }
            oldStatus = as.getStatus();
        } else {
            as = new Assignment();
            as.setTeacherId(teacherId);
            as.setCreatedAt(LocalDateTime.now());
        }
        as.setClassId(req.getClassId() != null ? req.getClassId() : as.getClassId());
        if (as.getClassId() == null) {
            throw new BizException("缺少发放班级");
        }
        as.setTitle(req.getTitle());
        as.setDescription("");
        // 作业级知识点 = 各题关联知识点的去重合集（保证学生端按知识点过滤仍有效）
        List<String> kpCodes = questions.stream().map(ComposeRequest.QuestionReq::getKpCode)
                .filter(Objects::nonNull).distinct().toList();
        as.setKpIds(toJson(kpCodes));
        as.setStartAt(startAt);
        as.setDueAt(endAt);
        as.setStatus(status);
        as.setScoreMode(scoreMode);
        as.setAllowLate(Boolean.TRUE.equals(req.getAllowLate()) ? 1 : 0);
        if (as.getId() == null) {
            assignmentMapper.insert(as);
        } else {
            assignmentMapper.updateById(as);
        }

        // 全删重建题目
        questionMapper.delete(new LambdaQueryWrapper<Question>()
                .eq(Question::getAssignmentId, as.getId()));
        for (int i = 0; i < questions.size(); i++) {
            ComposeRequest.QuestionReq q = questions.get(i);
            Question en = new Question();
            en.setAssignmentId(as.getId());
            en.setType(q.getType());
            en.setTitle(q.getTitle());
            en.setOptions(q.getOptions() != null ? toJson(q.getOptions()) : null);
            en.setAnswer(q.getAnswer() != null ? toJson(q.getAnswer()) : null);
            en.setAnalysis(q.getAnalysis());
            en.setDifficulty(q.getDifficulty() != null ? BigDecimal.valueOf(q.getDifficulty()) : BigDecimal.valueOf(0.5));
            en.setKpCode(q.getKpCode());
            en.setScore("CUSTOM".equals(scoreMode) && q.getScore() != null
                    ? BigDecimal.valueOf(q.getScore()).setScale(1, RoundingMode.HALF_UP) : null);
            en.setSortOrder(i + 1);
            questionMapper.insert(en);
        }

        // 题目型作业不带 Rubric：清理可能遗留的旧 Rubric（Rubric 型转题目型场景）
        rubricMapper.delete(new LambdaQueryWrapper<Rubric>().eq(Rubric::getAssignmentId, as.getId()));

        notifyOnPublish(as, as.getTitle(), as.getClassId(), oldStatus);
        return toAssignmentDto(as, true);
    }

    /**
     * 教师删除作业（级联删除其 Rubric、学生提交与提交评分）
     * 权限约束：作业须属于当前教师授课班级（教师无授课班级时回退兼容演示账号）
     */
    @Transactional
    public void deleteAssignment(Long teacherId, Long assignmentId) {
        Assignment as = assignmentMapper.selectById(assignmentId);
        if (as == null) {
            throw new BizException("作业不存在");
        }
        List<Long> ownClassIds = classMapper.selectList(new LambdaQueryWrapper<ClassEntity>()
                        .eq(ClassEntity::getTeacherId, teacherId))
                .stream().map(ClassEntity::getId).toList();
        if (!ownClassIds.isEmpty() && !ownClassIds.contains(as.getClassId())) {
            throw new BizException("无权操作该作业");
        }
        // 级联清理：提交评分 → 学生提交 → Rubric → 题目 → 作业
        List<Submission> subs = submissionMapper.selectList(new LambdaQueryWrapper<Submission>()
                .eq(Submission::getAssignmentId, assignmentId));
        if (!subs.isEmpty()) {
            rubricScoreMapper.delete(new LambdaQueryWrapper<RubricScore>()
                    .in(RubricScore::getSubmissionId, subs.stream().map(Submission::getId).toList()));
            submissionMapper.delete(new LambdaQueryWrapper<Submission>()
                    .eq(Submission::getAssignmentId, assignmentId));
        }
        rubricMapper.delete(new LambdaQueryWrapper<Rubric>().eq(Rubric::getAssignmentId, assignmentId));
        questionMapper.delete(new LambdaQueryWrapper<Question>().eq(Question::getAssignmentId, assignmentId));
        assignmentMapper.deleteById(assignmentId);
    }

    public Map<String, Object> toAssignmentDto(Assignment as) {
        return toAssignmentDto(as, false);
    }

    /**
     * withAnswer：教师端编辑回填需含答案与解析；学生端只读看题不含（防作弊）
     */
    public Map<String, Object> toAssignmentDto(Assignment as, boolean withAnswer) {
        List<Rubric> rubrics = rubricMapper.selectList(new LambdaQueryWrapper<Rubric>()
                .eq(Rubric::getAssignmentId, as.getId()).orderByAsc(Rubric::getSortOrder));
        long submitted = submissionMapper.selectCount(new LambdaQueryWrapper<Submission>()
                .eq(Submission::getAssignmentId, as.getId())
                .ne(Submission::getStatus, "MISSING"));
        long total = userMapper.selectCount(new LambdaQueryWrapper<User>()
                .eq(User::getClassId, as.getClassId()).eq(User::getRole, "STUDENT"));

        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("id", String.valueOf(as.getId()));
        dto.put("title", as.getTitle());
        dto.put("kp", parseArray(as.getKpIds()));
        dto.put("desc", as.getDescription());
        dto.put("due", as.getDueAt() != null ? as.getDueAt().format(DUE) : null);
        dto.put("status", as.getStatus() != null ? as.getStatus().toLowerCase() : "draft");
        dto.put("classId", String.valueOf(as.getClassId()));
        dto.put("total", total);
        dto.put("submitted", submitted);
        dto.put("rubric", rubrics.stream().map(r -> {
            Map<String, Object> rm = new LinkedHashMap<>();
            rm.put("name", r.getName());
            rm.put("max", r.getMaxScore());
            rm.put("desc", r.getDescription());
            return rm;
        }).collect(Collectors.toList()));
        dto.put("createdAt", as.getCreatedAt() != null ? as.getCreatedAt().format(DT) : null);
        // 出题组卷扩展：评分机制 / 有效时段 / 允许补交 / 题目
        dto.put("scoreMode", as.getScoreMode() != null ? as.getScoreMode().toLowerCase() : null);
        dto.put("startAt", as.getStartAt() != null ? as.getStartAt().format(DUE) : null);
        dto.put("allowLate", as.getAllowLate() != null && as.getAllowLate() == 1);
        if (as.getScoreMode() != null) {
            List<Question> qs = questionMapper.selectList(new LambdaQueryWrapper<Question>()
                    .eq(Question::getAssignmentId, as.getId()).orderByAsc(Question::getSortOrder));
            dto.put("questionCount", qs.size());
            BigDecimal totalScore = "AVERAGE".equals(as.getScoreMode())
                    ? BigDecimal.valueOf(100)
                    : qs.stream().map(q -> q.getScore() == null ? BigDecimal.ZERO : q.getScore())
                            .reduce(BigDecimal.ZERO, BigDecimal::add);
            dto.put("totalScore", totalScore.stripTrailingZeros().toPlainString());
            dto.put("questions", qs.stream().map(q -> questionDto(q, withAnswer)).collect(Collectors.toList()));
        }
        return dto;
    }

    private Map<String, Object> questionDto(Question q, boolean withAnswer) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", String.valueOf(q.getId()));
        m.put("type", q.getType());
        m.put("title", q.getTitle());
        m.put("options", parseObjects(q.getOptions()));
        m.put("answer", withAnswer ? parseObjects(q.getAnswer()) : null);
        m.put("analysis", withAnswer ? q.getAnalysis() : null);
        m.put("difficulty", q.getDifficulty() != null ? q.getDifficulty().doubleValue() : null);
        m.put("kpCode", q.getKpCode());
        m.put("score", q.getScore() != null ? q.getScore().doubleValue() : null);
        return m;
    }

    private List<Object> parseObjects(String json) {
        if (json == null || json.isBlank()) {
            return List.of();
        }
        try {
            return objectMapper.readValue(json, objectMapper.getTypeFactory()
                    .constructCollectionType(List.class, Object.class));
        } catch (Exception e) {
            return List.of();
        }
    }

    /**
     * 教师视角提交列表（对齐 MOCK.submissions）
     */
    public List<Map<String, Object>> submissionList(Long assignmentId) {
        Assignment as = assignmentMapper.selectById(assignmentId);
        if (as == null) {
            throw new BizException("作业不存在");
        }
        List<User> students = userMapper.selectList(new LambdaQueryWrapper<User>()
                .eq(User::getClassId, as.getClassId()).eq(User::getRole, "STUDENT"));
        Map<Long, User> stuMap = students.stream()
                .collect(Collectors.toMap(User::getId, u -> u));
        Map<Long, Submission> subMap = submissionMapper.selectList(new LambdaQueryWrapper<Submission>()
                        .eq(Submission::getAssignmentId, assignmentId))
                .stream().collect(Collectors.toMap(Submission::getStudentId, s -> s));
        List<Rubric> rubrics = rubricMapper.selectList(new LambdaQueryWrapper<Rubric>()
                .eq(Rubric::getAssignmentId, assignmentId).orderByAsc(Rubric::getSortOrder));
        Map<Long, List<RubricScore>> scoreMap = rubricScoreMapper.selectList(
                        new LambdaQueryWrapper<RubricScore>()
                                .in(!subMap.isEmpty(), RubricScore::getSubmissionId, subMap.values().stream()
                                        .map(Submission::getId).toList()))
                .stream().collect(Collectors.groupingBy(RubricScore::getSubmissionId));

        List<Map<String, Object>> result = new ArrayList<>();
        for (User stu : students) {
            Submission sub = subMap.get(stu.getId());
            if (sub == null) {
                Map<String, Object> dto = baseSubmissionDto(null, as.getId(), stu);
                result.add(dto);
            } else {
                Map<String, Object> dto = toSubmissionDto(sub, true);
                dto.put("name", stu.getRealName());
                // rubricScores 按名称对齐
                Map<String, Object> rScores = new LinkedHashMap<>();
                List<RubricScore> scores = scoreMap.getOrDefault(sub.getId(), List.of());
                Map<Long, Integer> rsMap = scores.stream()
                        .collect(Collectors.toMap(RubricScore::getRubricId, RubricScore::getScore, (a, b) -> a));
                for (Rubric r : rubrics) {
                    if (rsMap.containsKey(r.getId())) {
                        rScores.put(r.getName(), rsMap.get(r.getId()));
                    }
                }
                dto.put("rubricScores", rScores);
                result.add(dto);
            }
        }
        return result;
    }

    private Map<String, Object> baseSubmissionDto(Long subId, Long asId, User stu) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("id", subId != null ? String.valueOf(subId) : "sb-" + stu.getId() + "-" + asId);
        dto.put("asId", String.valueOf(asId));
        dto.put("sid", String.valueOf(stu.getId()));
        dto.put("name", stu.getRealName());
        dto.put("status", "missing");
        dto.put("submittedAt", null);
        dto.put("attempts", 0);
        dto.put("similarity", 0);
        dto.put("timeSlot", "-");
        dto.put("score", null);
        dto.put("aiScore", null);
        dto.put("code", "");
        dto.put("aiComment", "");
        dto.put("teacherComment", "");
        dto.put("rubricScores", new LinkedHashMap<>());
        return dto;
    }

    public Map<String, Object> toSubmissionDto(Submission sub, boolean withCode) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("id", String.valueOf(sub.getId()));
        dto.put("asId", String.valueOf(sub.getAssignmentId()));
        dto.put("sid", String.valueOf(sub.getStudentId()));
        dto.put("status", sub.getStatus() != null ? sub.getStatus().toLowerCase() : "pending");
        dto.put("submittedAt", sub.getSubmittedAt() != null ? sub.getSubmittedAt().format(DT) : null);
        dto.put("attempts", sub.getAttempts());
        dto.put("similarity", sub.getSimilarity());
        dto.put("timeSlot", timeSlot(sub.getSubmittedAt()));
        dto.put("score", sub.getScore());
        dto.put("aiScore", sub.getAiScore());
        if (withCode) {
            dto.put("code", sub.getCode());
        }
        dto.put("answers", parseObjects(sub.getAnswers()));
        dto.put("aiComment", sub.getAiComment() != null ? sub.getAiComment() : "");
        dto.put("teacherComment", sub.getTeacherComment() != null ? sub.getTeacherComment() : "");
        dto.put("rubricScores", new LinkedHashMap<>());
        return dto;
    }

    private String timeSlot(LocalDateTime t) {
        if (t == null) {
            return "-";
        }
        int h = t.getHour();
        if (h >= 0 && h < 5) {
            return "凌晨时段";
        }
        if (h >= 5 && h < 23) {
            return "正常时段";
        }
        return "深夜时段";
    }

    private List<String> parseArray(String json) {
        if (json == null || json.isBlank()) {
            return List.of();
        }
        try {
            return objectMapper.readValue(json, objectMapper.getTypeFactory()
                    .constructCollectionType(List.class, String.class));
        } catch (Exception e) {
            return List.of();
        }
    }

    private String toJson(Object obj) {
        try {
            return objectMapper.writeValueAsString(obj);
        } catch (Exception e) {
            return "[]";
        }
    }
}
