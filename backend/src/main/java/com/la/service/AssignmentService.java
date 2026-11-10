package com.la.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.dto.ComposeRequest;
import com.la.entity.*;
import com.la.exception.BizException;
import com.la.mapper.*;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import java.io.File;
import java.io.IOException;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.file.Files;
import java.nio.file.Path;
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
    private final AutoScoreService autoScoreService;
    private final ClassMapper classMapper;
    private final UserMapper userMapper;
    private final NotificationService notificationService;
    private final ObjectMapper objectMapper;
    private final LearningResourceMapper learningResourceMapper;
    private final AssignmentFolderMapper assignmentFolderMapper;
    private final LabGroupService labGroupService;
    private final ClassCoTeacherMapper classCoTeacherMapper;

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
            Map<String, Object> my = sub != null ? toSubmissionDto(sub, false) : null;
            // 自动评分临时分数：题目型作业按标准答案即时匹配判分（不落库，不计入最终成绩）；
            // 实验报告型（LAB）无客观题，不参与自动评分
            if (my != null && as.getScoreMode() != null && !"LAB".equals(as.getScoreMode())
                    && !"GRADED".equals(sub.getStatus())) {
                Map<String, Object> auto = autoScoreService.objectiveScore(as.getId(), sub.getAnswers());
                my.put("autoScore", auto.get("total"));
                my.put("autoFullScore", auto.get("fullScore"));
            }
            dto.put("mySubmission", my);
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
            // 重新提交：上次批改结果作废（成绩以教师重新批改为准）；
            // updateById 会忽略 null 字段，改用 UpdateWrapper 显式置空
            submissionMapper.update(null, new LambdaUpdateWrapper<Submission>()
                    .eq(Submission::getId, sub.getId())
                    .set(Submission::getCode, code)
                    .set(Submission::getStatus, "PENDING")
                    .set(Submission::getAttempts, sub.getAttempts())
                    .set(Submission::getSubmittedAt, sub.getSubmittedAt())
                    .set(Submission::getScore, null)
                    .set(Submission::getAiScore, null)
                    .set(Submission::getAiComment, null)
                    .set(Submission::getTeacherComment, null)
                    .set(Submission::getGradedAt, null));
        }
        return toSubmissionDto(sub, false);
    }

    /**
     * 学生答题提交（题目型作业）：结构化作答 + 客观题自动判分（独立 AutoScoreService，不落库不影响成绩）
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

        // 逐题校验 + 汇总文本（兼容教师批改页 code 展示）
        StringBuilder summary = new StringBuilder();
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
            // 重新提交：上次批改结果作废（成绩以教师重新批改为准）；
            // updateById 会忽略 null 字段，改用 UpdateWrapper 显式置空
            submissionMapper.update(null, new LambdaUpdateWrapper<Submission>()
                    .eq(Submission::getId, sub.getId())
                    .set(Submission::getCode, sub.getCode())
                    .set(Submission::getAnswers, sub.getAnswers())
                    .set(Submission::getStatus, "PENDING")
                    .set(Submission::getAttempts, sub.getAttempts())
                    .set(Submission::getSubmittedAt, sub.getSubmittedAt())
                    .set(Submission::getScore, null)
                    .set(Submission::getAiScore, null)
                    .set(Submission::getAiComment, null)
                    .set(Submission::getTeacherComment, null)
                    .set(Submission::getGradedAt, null));
        }

        // 自动评分（独立模块即时计算，不写入任何成绩字段）：
        // 客观题按标准答案匹配判分；主观题无精确标准答案，由教师批改
        Map<String, Object> auto = autoScoreService.objectiveScore(assignmentId, sub.getAnswers());

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("submission", toSubmissionDto(sub, false));
        result.put("autoScore", auto.get("total"));
        result.put("autoDetail", auto.get("detail"));
        result.put("attempted", clean.size());
        result.put("totalQuestions", questions.size());
        return result;
    }

    /* ==================== 实验报告作业（LAB） ==================== */

    private static final Path REPORT_DIR = Path.of("uploads", "report");
    private static final Path DELIVERABLE_DIR = Path.of("uploads", "deliverable");
    /** 成果物压缩包大小上限（报告 ≤50MB + 成果物 ≤200MB，multipart 请求上限 260MB） */
    private static final long DELIVERABLE_MAX = 200L * 1024 * 1024;

    /** 作业是否开启「成果物上传」（教师发布配置，存于 description JSON 的 deliverable 字段） */
    public static boolean deliverableEnabled(String description) {
        if (description == null || description.isBlank()) {
            return false;
        }
        try {
            return new ObjectMapper().readTree(description).path("deliverable").path("enabled").asBoolean(false);
        } catch (Exception e) {
            return false;
        }
    }

    /** 学生上传实验报告（Word）+ 成果物压缩包（教师开启后必填：zip/rar ≤200MB，与报告缺一不可）：
     *  保存文件并创建/更新提交（可重复上传，上次批改作废），成功后清理被替代的旧文件 */
    @Transactional
    public Map<String, Object> submitReport(Long studentId, Long assignmentId, MultipartFile file, MultipartFile deliverable) {
        Assignment as = assignmentMapper.selectById(assignmentId);
        if (as == null || !"LAB".equals(as.getScoreMode())) {
            throw new BizException("该作业不支持报告提交");
        }
        if ("CLOSED".equals(as.getStatus())) {
            throw new BizException("作业已截止，无法提交");
        }
        boolean overdue = as.getDueAt() != null && LocalDateTime.now().isAfter(as.getDueAt());
        if (overdue && (as.getAllowLate() == null || as.getAllowLate() != 1)) {
            throw new BizException("作业已截止，无法提交");
        }
        String fileName = file == null || file.getOriginalFilename() == null
                ? "" : file.getOriginalFilename().trim();
        String lower = fileName.toLowerCase();
        if (!lower.endsWith(".doc") && !lower.endsWith(".docx")) {
            throw new BizException("请上传 Word 格式（.doc/.docx）的实验报告");
        }
        if (file.getSize() > 50L * 1024 * 1024) {
            throw new BizException("文件超过大小上限（50MB）");
        }
        // 成果物压缩包：教师开启该功能后必填，与实验报告缺一不可
        boolean needDeliverable = deliverableEnabled(as.getDescription());
        String deliverableName = deliverable == null || deliverable.getOriginalFilename() == null
                ? "" : deliverable.getOriginalFilename().trim();
        if (needDeliverable) {
            if (deliverable == null || deliverable.isEmpty() || deliverableName.isBlank()) {
                throw new BizException("请同时上传成果物压缩包（zip/rar）：实验报告与成果物缺一不可");
            }
            String dLower = deliverableName.toLowerCase();
            if (!dLower.endsWith(".zip") && !dLower.endsWith(".rar")) {
                throw new BizException("成果物仅支持 zip / rar 压缩包格式");
            }
            if (deliverable.getSize() > DELIVERABLE_MAX) {
                throw new BizException("成果物压缩包超过大小上限（200MB）");
            }
        }
        try {
            Files.createDirectories(REPORT_DIR);
            if (needDeliverable) {
                Files.createDirectories(DELIVERABLE_DIR);
            }
        } catch (IOException e) {
            throw new BizException("创建存储目录失败，请联系管理员");
        }
        String storedName = "as" + assignmentId + "-u" + studentId + "-" + System.currentTimeMillis()
                + "-" + fileName.replaceAll("[\\\\/:*?\"<>|\\s]+", "_");
        try {
            file.transferTo(REPORT_DIR.resolve(storedName));
        } catch (IOException e) {
            throw new BizException("报告保存失败，请重试");
        }
        String storedDeliverable = null;
        if (needDeliverable) {
            storedDeliverable = "as" + assignmentId + "-u" + studentId + "-" + System.currentTimeMillis()
                    + "-d-" + deliverableName.replaceAll("[\\\\/:*?\"<>|\\s]+", "_");
            try {
                deliverable.transferTo(DELIVERABLE_DIR.resolve(storedDeliverable));
            } catch (IOException e) {
                // 成果物落盘失败：回滚刚保存的报告，保持一次提交的原子性
                try { Files.deleteIfExists(REPORT_DIR.resolve(storedName)); } catch (IOException ignore) { }
                throw new BizException("成果物保存失败，请重试");
            }
        }

        Submission sub = submissionMapper.selectOne(new LambdaQueryWrapper<Submission>()
                .eq(Submission::getAssignmentId, assignmentId)
                .eq(Submission::getStudentId, studentId));
        // 记录旧报告/旧成果物文件：更新成功后清理，防止重复上传堆积孤儿文件
        String oldFile = null;
        String oldDeliverable = null;
        if (sub != null && sub.getAnswers() != null) {
            try {
                JsonNode old = objectMapper.readTree(sub.getAnswers());
                JsonNode rep = old.isArray() && old.size() > 0 ? old.get(0) : old;
                if (!rep.path("reportFile").asText("").isBlank()) {
                    oldFile = rep.path("reportFile").asText();
                }
                if (!rep.path("deliverableFile").asText("").isBlank()) {
                    oldDeliverable = rep.path("deliverableFile").asText();
                }
            } catch (Exception ignore) { }
        }
        boolean isNew = sub == null;
        if (sub == null) {
            sub = new Submission();
            sub.setAssignmentId(assignmentId);
            sub.setStudentId(studentId);
            sub.setAttempts(1);
            sub.setSimilarity(0);
        } else {
            sub.setAttempts(sub.getAttempts() + 1);
        }
        sub.setStatus("PENDING");
        sub.setSubmittedAt(LocalDateTime.now());
        sub.setCode("【实验报告】" + fileName + (needDeliverable ? " +【成果物】" + deliverableName : ""));
        // answers 存数组（与题目型作业结构一致，parseObjects 可解析）：
        // [{"reportFile": "存储名", "fileName": "原始名", "deliverableFile": "存储名", "deliverableName": "原始名"}]
        Map<String, Object> ans = new LinkedHashMap<>();
        ans.put("reportFile", storedName);
        ans.put("fileName", fileName);
        if (needDeliverable) {
            ans.put("deliverableFile", storedDeliverable);
            ans.put("deliverableName", deliverableName);
        }
        sub.setAnswers(toJson(List.of(ans)));
        try {
            if (isNew) {
                submissionMapper.insert(sub);
            } else {
                submissionMapper.update(null, new LambdaUpdateWrapper<Submission>()
                        .eq(Submission::getId, sub.getId())
                        .set(Submission::getCode, sub.getCode())
                        .set(Submission::getAnswers, sub.getAnswers())
                        .set(Submission::getStatus, "PENDING")
                        .set(Submission::getAttempts, sub.getAttempts())
                        .set(Submission::getSubmittedAt, sub.getSubmittedAt())
                        .set(Submission::getScore, null)
                        .set(Submission::getAiScore, null)
                        .set(Submission::getAiComment, null)
                        .set(Submission::getTeacherComment, null)
                        .set(Submission::getGradedAt, null));
            }
        } catch (RuntimeException e) {
            // DB 写失败：删除刚落盘的报告/成果物文件，避免孤儿文件只增不减
            try { Files.deleteIfExists(REPORT_DIR.resolve(storedName)); } catch (IOException ignore) { }
            if (storedDeliverable != null) {
                try { Files.deleteIfExists(DELIVERABLE_DIR.resolve(storedDeliverable)); } catch (IOException ignore) { }
            }
            throw e;
        }
        // 更新成功：清理被替代的旧报告/旧成果物文件（best-effort，失败不影响业务）
        if (oldFile != null && !oldFile.isBlank() && !oldFile.equals(storedName)) {
            try { Files.deleteIfExists(REPORT_DIR.resolve(oldFile)); } catch (IOException ignore) { }
        }
        if (oldDeliverable != null && !oldDeliverable.isBlank() && !oldDeliverable.equals(storedDeliverable)) {
            try { Files.deleteIfExists(DELIVERABLE_DIR.resolve(oldDeliverable)); } catch (IOException ignore) { }
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("submissionId", sub.getId());
        result.put("fileName", fileName);
        result.put("deliverableName", needDeliverable ? deliverableName : null);
        result.put("attempts", sub.getAttempts());
        return result;
    }

    /** 教师批阅：读取学生上传的实验报告文件（文件对象 + 原文件名） */
    public Map<String, Object> studentReport(Long submissionId) {
        Submission sub = submissionMapper.selectById(submissionId);
        if (sub == null) {
            throw new BizException("提交不存在");
        }
        try {
            // answers 存数组 [{reportFile, fileName}]（兼容旧对象格式）
            JsonNode ans = objectMapper.readTree(sub.getAnswers() == null ? "[]" : sub.getAnswers());
            JsonNode rep = ans.isArray() && ans.size() > 0 ? ans.get(0) : ans;
            String stored = rep.path("reportFile").asText("");
            String fileName = rep.path("fileName").asText("实验报告.docx");
            if (stored.isBlank()) {
                throw new BizException("该提交没有报告文件");
            }
            File f = REPORT_DIR.resolve(stored).toFile();
            if (!f.exists()) {
                throw new BizException("报告文件已丢失，请联系管理员");
            }
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("file", f);
            m.put("fileName", fileName);
            return m;
        } catch (BizException e) {
            throw e;
        } catch (Exception e) {
            throw new BizException("报告信息解析失败");
        }
    }

    /** 教师批阅：读取学生上传的成果物压缩包（文件对象 + 原文件名） */
    public Map<String, Object> studentDeliverable(Long submissionId) {
        Submission sub = submissionMapper.selectById(submissionId);
        if (sub == null) {
            throw new BizException("提交不存在");
        }
        try {
            JsonNode ans = objectMapper.readTree(sub.getAnswers() == null ? "[]" : sub.getAnswers());
            JsonNode rep = ans.isArray() && ans.size() > 0 ? ans.get(0) : ans;
            String stored = rep.path("deliverableFile").asText("");
            String fileName = rep.path("deliverableName").asText("成果物.zip");
            if (stored.isBlank()) {
                throw new BizException("该提交没有成果物文件");
            }
            File f = DELIVERABLE_DIR.resolve(stored).toFile();
            if (!f.exists()) {
                throw new BizException("成果物文件已丢失，请联系管理员");
            }
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("file", f);
            m.put("fileName", fileName);
            return m;
        } catch (BizException e) {
            throw e;
        } catch (Exception e) {
            throw new BizException("成果物信息解析失败");
        }
    }

    /** 作答内容的可读文本（用于 code 汇总，教师批改页直接可读） */
    private String answerText(Question q, Object value) {
        boolean objective = "SINGLE".equals(q.getType()) || "MULTI".equals(q.getType()) || "JUDGE".equals(q.getType());
        if (!objective) {
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
        // 实验报告型作业（scoreMode=LAB）：不组卷，仅关联 Word 模板资源；
        // 模板上传时已作为学习资源入库（学生端学习资源板块可见、可下载）
        boolean isLab = "LAB".equalsIgnoreCase(req.getScoreMode());
        String scoreMode = isLab ? "LAB"
                : ("CUSTOM".equalsIgnoreCase(req.getScoreMode()) ? "CUSTOM" : "AVERAGE");
        String status = req.getStatus() != null ? req.getStatus().toUpperCase() : "DRAFT";
        if (!"DRAFT".equals(status) && !"ONGOING".equals(status)) {
            throw new BizException("作业状态不合法");
        }
        if (isLab && (req.getLabTemplateId() == null
                || learningResourceMapper.selectById(req.getLabTemplateId()) == null)) {
            throw new BizException("实验报告作业需先上传 Word 报告模板");
        }
        // 分组实验配置（实验报告作业）：RANDOM=随机分组 / SELF=学生自行组队
        boolean groupOn = isLab && Boolean.TRUE.equals(req.getGroupEnabled());
        String groupMode = null;
        Integer groupCount = null;
        if (groupOn) {
            groupMode = "SELF".equalsIgnoreCase(req.getGroupMode()) ? "SELF" : "RANDOM";
            groupCount = req.getGroupCount();
            if (groupCount == null || groupCount < 1 || groupCount > 99) {
                throw new BizException("分组数量须为 1~99 之间的整数");
            }
        }
        List<ComposeRequest.QuestionReq> questions = isLab ? List.of()
                : (req.getQuestions() != null ? req.getQuestions() : List.of());
        if (questions.isEmpty() && !isLab) {
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
            // 状态守卫：已发布（ONGOING）的作业编辑保存草稿不降级为 DRAFT——
            // 学生端列表按非 DRAFT 过滤，降级会导致该作业从学生列表消失、无法查看
            if ("ONGOING".equals(oldStatus) && "DRAFT".equals(status)) {
                status = "ONGOING";
            }
            // 分组配置不可变约束：已产生分组数据（小组/组员/邀请任一存在）后，
            // 修改分组模式/分组数量/换班级会使已组建队伍与配置不一致，直接拒绝
            if (isLab && labGroupService.hasGroupData(req.getId())) {
                Map<String, Object> oldCfg = LabGroupService.parseGroupConfig(as.getDescription());
                boolean same = groupOn && oldCfg != null
                        && oldCfg.get("mode").equals(groupMode)
                        && ((Number) oldCfg.get("count")).intValue() == groupCount.intValue();
                boolean classChanged = req.getClassId() != null && !req.getClassId().equals(as.getClassId());
                if (!same || classChanged) {
                    throw new BizException("该作业已生成分组数据，不能修改分组配置、分组数量或班级");
                }
            }
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
        // 实验报告型：description 存模板关联 JSON（复用现有列，零表结构变更）；
        // 分组实验配置存入 group 字段 {enabled, mode, count}；成果物上传配置存入 deliverable 字段 {enabled}
        if (isLab) {
            Map<String, Object> desc = new LinkedHashMap<>();
            desc.put("templateId", req.getLabTemplateId());
            desc.put("templateTitle", req.getLabTemplateTitle() == null ? "" : req.getLabTemplateTitle());
            if (groupOn) {
                Map<String, Object> g = new LinkedHashMap<>();
                g.put("enabled", true);
                g.put("mode", groupMode);
                g.put("count", groupCount);
                desc.put("group", g);
            }
            if (Boolean.TRUE.equals(req.getDeliverableEnabled())) {
                desc.put("deliverable", Map.of("enabled", true));
            }
            as.setDescription(toJson(desc));
        } else {
            as.setDescription("");
        }
        // 作业级知识点：以教师在「关联知识点」面板选择为准（作业卡/学生端展示与之一致）；
        // 面板未选择时兜底取各题关联知识点合集（kp_code 逗号多值需拆分去重，避免
        // "a,b" 合并串入库导致前端 kpName 查不到而显示原始编码）
        List<String> kpCodes;
        if (req.getKps() != null && !req.getKps().isEmpty()) {
            kpCodes = req.getKps().stream().filter(Objects::nonNull).distinct().toList();
        } else {
            kpCodes = questions.stream().map(ComposeRequest.QuestionReq::getKpCode)
                    .filter(Objects::nonNull).filter(s -> !s.isBlank())
                    .flatMap(s -> Arrays.stream(s.split(",")))
                    .map(String::trim).filter(s -> !s.isEmpty())
                    .distinct().toList();
        }
        as.setKpIds(toJson(kpCodes));
        as.setStartAt(startAt);
        as.setDueAt(endAt);
        as.setStatus(status);
        as.setScoreMode(scoreMode);
        as.setAllowLate(Boolean.TRUE.equals(req.getAllowLate()) ? 1 : 0);
        // 作业文件夹：新建时按传入值（NULL=其他）；修改时仅在明确传入时覆盖，
        // 避免旧客户端/编辑场景未携带 folderId 把已有分组清回「其他」
        if (req.getFolderId() != null) {
            as.setFolderId(req.getFolderId());
        } else if (as.getId() == null) {
            as.setFolderId(null);
        }
        if (as.getId() == null) {
            assignmentMapper.insert(as);
        } else {
            assignmentMapper.updateById(as);
        }

        // 题目差量更新（保持 id 稳定）：携带原 id 且仍属本作业的题目原位 UPDATE；
        // 无 id 的新题 INSERT；本次未提交的旧题 DELETE。
        // 修复：原「全删重建」会使全部 question id 变化，学生已提交作答（按 questionId
        // 关联）全部失配 → 详情页「未作答」、教师端批改无答题记录、旧页面提交报「作答内容无效」
        Map<Long, Question> oldQs = questionMapper.selectList(new LambdaQueryWrapper<Question>()
                        .eq(Question::getAssignmentId, as.getId()))
                .stream().collect(Collectors.toMap(Question::getId, q -> q));
        Set<Long> keptIds = new HashSet<>();
        for (int i = 0; i < questions.size(); i++) {
            ComposeRequest.QuestionReq q = questions.get(i);
            Question en = null;
            if (q.getId() != null && oldQs.containsKey(q.getId())) {
                en = oldQs.get(q.getId());
                keptIds.add(q.getId());
            } else {
                en = new Question();
                en.setAssignmentId(as.getId());
            }
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
            if (en.getId() == null) {
                questionMapper.insert(en);
            } else {
                // updateById 忽略 null 字段（清空解析等编辑会残留旧值），显式 set 全列
                questionMapper.update(null, new LambdaUpdateWrapper<Question>()
                        .eq(Question::getId, en.getId())
                        .set(Question::getType, en.getType())
                        .set(Question::getTitle, en.getTitle())
                        .set(Question::getOptions, en.getOptions())
                        .set(Question::getAnswer, en.getAnswer())
                        .set(Question::getAnalysis, en.getAnalysis())
                        .set(Question::getDifficulty, en.getDifficulty())
                        .set(Question::getKpCode, en.getKpCode())
                        .set(Question::getScore, en.getScore())
                        .set(Question::getSortOrder, en.getSortOrder()));
            }
        }
        for (Long oldId : oldQs.keySet()) {
            if (!keptIds.contains(oldId)) {
                questionMapper.deleteById(oldId);
            }
        }

        // 题目型作业不带 Rubric：清理可能遗留的旧 Rubric（Rubric 型转题目型场景）
        rubricMapper.delete(new LambdaQueryWrapper<Rubric>().eq(Rubric::getAssignmentId, as.getId()));

        notifyOnPublish(as, as.getTitle(), as.getClassId(), oldStatus);
        // 分组实验（随机模式）：发布为 ONGOING 时生成小组
        // （按全班人数÷组数均衡分配、组员随机、每组随机指定 1 名组长；已生成则幂等跳过）
        if (isLab && groupOn && "RANDOM".equals(groupMode) && "ONGOING".equals(as.getStatus())) {
            labGroupService.generateRandomGroups(as, groupCount);
        }
        return toAssignmentDto(as, true);
    }

    /**
     * 教师可管理班级口径：授课班级 ∪ 共同管理班级（共同管理教师与所有者拥有一致的作业管理权限；
     * 教师无任何可管理班级时回退兼容演示账号）
     */
    private List<Long> manageableClassIds(Long teacherId) {
        List<Long> ids = new ArrayList<>(classMapper.selectList(new LambdaQueryWrapper<ClassEntity>()
                        .eq(ClassEntity::getTeacherId, teacherId))
                .stream().map(ClassEntity::getId).toList());
        classCoTeacherMapper.selectList(new LambdaQueryWrapper<ClassCoTeacher>()
                        .eq(ClassCoTeacher::getTeacherId, teacherId))
                .forEach(ct -> {
                    if (!ids.contains(ct.getClassId())) {
                        ids.add(ct.getClassId());
                    }
                });
        return ids;
    }

    /**
     * 教师删除作业（级联删除其 Rubric、学生提交与提交评分）
     * 权限约束：作业须属于当前教师可管理班级（授课 ∪ 共同管理；无任何班级时回退兼容演示账号）
     */
    @Transactional
    public void deleteAssignment(Long teacherId, Long assignmentId) {
        Assignment as = assignmentMapper.selectById(assignmentId);
        if (as == null) {
            throw new BizException("作业不存在");
        }
        List<Long> ownClassIds = manageableClassIds(teacherId);
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
        // 分组实验数据（小组/组员/组队邀请）随作业级联删除
        labGroupService.deleteGroupData(assignmentId);
        assignmentMapper.deleteById(assignmentId);
    }

    /**
     * 移动作业到指定文件夹（folderId=null 移回内置「其他」）。
     * 归属校验与删除作业同口径：作业所在班级须为当前教师可管理班级（授课 ∪ 共同管理）。
     */
    public Map<String, Object> moveAssignment(Long teacherId, Long assignmentId, Long folderId) {
        Assignment as = assignmentMapper.selectById(assignmentId);
        if (as == null) {
            throw new BizException("作业不存在");
        }
        List<Long> ownClassIds = manageableClassIds(teacherId);
        if (!ownClassIds.isEmpty() && !ownClassIds.contains(as.getClassId())) {
            throw new BizException("无权操作该作业");
        }
        if (folderId != null) {
            AssignmentFolder folder = assignmentFolderMapper.selectById(folderId);
            if (folder == null || !folder.getTeacherId().equals(teacherId)) {
                throw new BizException("目标文件夹不存在或不可用");
            }
        }
        // 注意：不可用 updateById —— folderId=null 时 MP 会忽略 null 字段导致 SET 子句为空的坏 SQL，
        // 必须用 UpdateWrapper 显式 set 才能把归属改回 NULL（其他/根目录）
        assignmentMapper.update(null, new LambdaUpdateWrapper<Assignment>()
                .eq(Assignment::getId, assignmentId)
                .set(Assignment::getFolderId, folderId));
        as.setFolderId(folderId);
        return toAssignmentDto(as, true);
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
        // 历史数据兼容：早期作业级 kpIds 存过题目 kpCode 的逗号合并串（"a,b"），
        // 输出前逐项拆分逗号并去重，避免前端 kpName 查不到而显示原始编码
        dto.put("kp", parseArray(as.getKpIds()).stream()
                .filter(Objects::nonNull).flatMap(s -> Arrays.stream(s.split(",")))
                .map(String::trim).filter(s -> !s.isEmpty()).distinct().toList());
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
        // 作业文件夹分组（NULL = 内置「其他」）：folderId 与作业 id 一致以字符串输出
        dto.put("folderId", as.getFolderId() == null ? null : String.valueOf(as.getFolderId()));
        if (as.getFolderId() != null) {
            AssignmentFolder folder = assignmentFolderMapper.selectById(as.getFolderId());
            dto.put("folderName", folder != null ? folder.getName() : null);
        } else {
            dto.put("folderName", null);
        }
        // 出题组卷扩展：评分机制 / 有效时段 / 允许补交 / 题目
        dto.put("scoreMode", as.getScoreMode() != null ? as.getScoreMode().toLowerCase() : null);
        dto.put("startAt", as.getStartAt() != null ? as.getStartAt().format(DUE) : null);
        dto.put("allowLate", as.getAllowLate() != null && as.getAllowLate() == 1);
        // 实验报告型：description 存模板关联 JSON，转成 lab 字段输出（desc 不再输出原始 JSON）
        if ("LAB".equals(as.getScoreMode())) {
            dto.put("desc", null);
            try {
                JsonNode lab = objectMapper.readTree(as.getDescription());
                Map<String, Object> labDto = new LinkedHashMap<>();
                labDto.put("templateId", lab.path("templateId").asText());
                labDto.put("templateTitle", lab.path("templateTitle").asText(""));
                labDto.put("templateFileName", lab.path("templateFileName").asText(""));
                // 分组实验配置（开启时输出，前端据此展示分组入口与组队流程）
                Map<String, Object> groupCfg = LabGroupService.parseGroupConfig(as.getDescription());
                if (groupCfg != null) {
                    Map<String, Object> gd = new LinkedHashMap<>();
                    gd.put("enabled", true);
                    gd.put("mode", String.valueOf(groupCfg.get("mode")).toLowerCase());
                    gd.put("count", groupCfg.get("count"));
                    labDto.put("group", gd);
                }
                // 成果物上传配置（开启时输出：学生端须同时提交实验报告与成果物压缩包）
                if (deliverableEnabled(as.getDescription())) {
                    labDto.put("deliverable", Map.of("enabled", true));
                }
                dto.put("lab", labDto);
            } catch (Exception e) {
                dto.put("lab", null);
            }
            dto.put("questionCount", 0);
            dto.put("totalScore", "100");
        }
        if (as.getScoreMode() != null && !"LAB".equals(as.getScoreMode())) {
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
