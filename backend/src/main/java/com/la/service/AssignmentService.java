package com.la.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.entity.*;
import com.la.exception.BizException;
import com.la.mapper.*;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

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
        if ("ONGOING".equals(as.getStatus()) && !"ONGOING".equals(oldStatus)) {
            List<User> students = userMapper.selectList(new LambdaQueryWrapper<User>()
                    .eq(User::getClassId, classId).eq(User::getRole, "STUDENT"));
            for (User stu : students) {
                notificationService.push(stu.getId(), "新作业已发布：「" + title + "」"
                        + (as.getDueAt() != null ? "，截止 " + as.getDueAt().format(DUE) : ""), "ASSIGNMENT");
            }
        }
        return toAssignmentDto(as);
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
        // 级联清理：提交评分 → 学生提交 → Rubric → 作业
        List<Submission> subs = submissionMapper.selectList(new LambdaQueryWrapper<Submission>()
                .eq(Submission::getAssignmentId, assignmentId));
        if (!subs.isEmpty()) {
            rubricScoreMapper.delete(new LambdaQueryWrapper<RubricScore>()
                    .in(RubricScore::getSubmissionId, subs.stream().map(Submission::getId).toList()));
            submissionMapper.delete(new LambdaQueryWrapper<Submission>()
                    .eq(Submission::getAssignmentId, assignmentId));
        }
        rubricMapper.delete(new LambdaQueryWrapper<Rubric>().eq(Rubric::getAssignmentId, assignmentId));
        assignmentMapper.deleteById(assignmentId);
    }

    public Map<String, Object> toAssignmentDto(Assignment as) {
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
        return dto;
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
