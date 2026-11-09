package com.la.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.la.ai.AgentPrompts;
import com.la.ai.ChatMessage;
import com.la.ai.LlmClient;
import com.la.entity.*;
import com.la.exception.BizException;
import com.la.mapper.*;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.stream.Collectors;

/**
 * 教师端：学情看板 / 学生档案 / 预警 / 学情报告
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class TeacherService {

    private final UserMapper userMapper;
    private final ClassMapper classMapper;
    private final MasteryMapper masteryMapper;
    private final KnowledgePointMapper kpMapper;
    private final SubmissionMapper submissionMapper;
    private final AssignmentMapper assignmentMapper;
    private final ExerciseRecordMapper exerciseRecordMapper;
    private final DailyActivityMapper dailyActivityMapper;
    private final WarningMapper warningMapper;
    private final ClassCoTeacherMapper classCoTeacherMapper;
    private final PasswordEncoder passwordEncoder;
    private final LlmClient llmClient;
    private final AgentPrompts agentPrompts;
    private final NotificationService notificationService;

    /**
     * 预警相关接口的班级归属校验：班级须为当前教师授课或共同管理的班级。
     * 兼容演示回退：教师名下无任何可见班级时（classes() 回退返回全部班级）不限制，
     * 避免演示账号在回退班级上预警页 403。
     */
    private void checkClassVisible(Long teacherId, Long classId) {
        List<Long> own = classMapper.selectList(new LambdaQueryWrapper<ClassEntity>()
                        .eq(ClassEntity::getTeacherId, teacherId))
                .stream().map(ClassEntity::getId).toList();
        Long coManaged = classCoTeacherMapper.selectCount(new LambdaQueryWrapper<ClassCoTeacher>()
                .eq(ClassCoTeacher::getTeacherId, teacherId));
        // 无任何可见班级：演示回退模式，放行
        if (own.isEmpty() && (coManaged == null || coManaged == 0)) {
            return;
        }
        if (own.contains(classId)) {
            return;
        }
        Long co = classCoTeacherMapper.selectCount(new LambdaQueryWrapper<ClassCoTeacher>()
                .eq(ClassCoTeacher::getClassId, classId)
                .eq(ClassCoTeacher::getTeacherId, teacherId));
        if (co != null && co > 0) {
            return;
        }
        throw new BizException("无权访问该班级的预警数据");
    }

    /**
     * 学情看板：4 KPI + 卡点知识点 TOP6 + 重点关注学生
     */
    public Map<String, Object> dashboard(Long teacherId, Long classId) {
        List<User> students = classStudents(classId);
        Map<Long, List<Mastery>> masteryByUser = masteryMapper.selectList(new LambdaQueryWrapper<Mastery>()
                        .in(!students.isEmpty(), Mastery::getUserId, students.stream().map(User::getId).toList()))
                .stream().collect(Collectors.groupingBy(Mastery::getUserId));
        List<KnowledgePoint> kps = kpMapper.selectList(new LambdaQueryWrapper<KnowledgePoint>()
                .eq(KnowledgePoint::getLevel, 2));

        // KPI
        double avgMastery = students.stream()
                .flatMap(s -> masteryByUser.getOrDefault(s.getId(), List.of()).stream())
                .mapToInt(Mastery::getMasteryValue).average().orElse(0);
        List<Assignment> assignments = assignmentMapper.selectList(new LambdaQueryWrapper<Assignment>()
                .eq(Assignment::getClassId, classId).ne(Assignment::getStatus, "DRAFT"));
        // 提交总量：单次 GROUP 维度合并查询（替代逐作业 selectCount 的 N+1）
        long totalSubs = assignments.isEmpty() ? 0 : submissionMapper.selectCount(
                new LambdaQueryWrapper<Submission>()
                        .in(Submission::getAssignmentId,
                                assignments.stream().map(Assignment::getId).toList())
                        .ne(Submission::getStatus, "MISSING"));
        long capacity = (long) assignments.size() * students.size();
        int submitRate = capacity > 0 ? (int) Math.round(totalSubs * 100.0 / capacity) : 0;
        long unhandledWarnings = warningMapper.selectCount(new LambdaQueryWrapper<Warning>()
                .eq(Warning::getClassId, classId).eq(Warning::getHandled, false));

        Map<String, Object> kpi = new LinkedHashMap<>();
        kpi.put("studentCount", students.size());
        kpi.put("avgMastery", (int) Math.round(avgMastery));
        kpi.put("submitRate", submitRate);
        kpi.put("riskCount", unhandledWarnings);

        // 卡点知识点 TOP6（平均掌握度升序 + 卡点率 = 掌握度<60 的学生占比）
        Map<Long, List<Integer>> kpValues = new HashMap<>();
        for (User stu : students) {
            for (Mastery m : masteryByUser.getOrDefault(stu.getId(), List.of())) {
                kpValues.computeIfAbsent(m.getKpId(), k -> new ArrayList<>()).add(m.getMasteryValue());
            }
        }
        List<Map<String, Object>> stuckPoints = new ArrayList<>();
        for (KnowledgePoint kp : kps) {
            List<Integer> values = kpValues.getOrDefault(kp.getId(), List.of());
            if (values.isEmpty()) {
                continue;
            }
            double avg = values.stream().mapToInt(Integer::intValue).average().orElse(0);
            long stuck = values.stream().filter(v -> v < 60).count();
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("kp", kp.getKpCode());
            item.put("name", kp.getName());
            item.put("avg", (int) Math.round(avg));
            item.put("stuckRate", (int) Math.round(stuck * 100.0 / values.size()));
            stuckPoints.add(item);
        }
        stuckPoints.sort(Comparator.comparingInt(a -> (int) ((Map<String, Object>) a).get("avg")));
        if (stuckPoints.size() > 6) {
            stuckPoints = stuckPoints.subList(0, 6);
        }

        // 重点关注学生（批量摘要，无逐生 N+1 查询）
        List<StudentSummary> watchList = studentSummaries(students).stream()
                .filter(s -> !"low".equals(s.getRisk()))
                .collect(Collectors.toList());

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("kpi", kpi);
        result.put("stuckPoints", stuckPoints);
        result.put("watchList", watchList);
        return result;
    }

    /**
     * 学生列表摘要（对齐 MOCK.students）——批量化：整班一次返回，全程仅 6 次查询，
     * 替代旧逐生实现（每生 10+ 次查询，50 人班一次 500+ SQL）。
     */
    public List<StudentSummary> studentList(Long classId) {
        return studentSummaries(classStudents(classId));
    }

    /** 单生摘要（供单点场景使用，内部走批量实现） */
    public StudentSummary studentSummary(User stu) {
        return studentSummaries(List.of(stu)).get(0);
    }

    /**
     * 批量学生摘要：掌握度/知识点编码/作业提交率/近 7 日活跃/练习次数 各一次性载入后内存组装。
     * ① 掌握度（user_id in）② kpCode 映射（全表一次）③ 班级作业（class_id in）
     * ④ 提交记录（assignment_id in + student_id in）⑤ 近 7 日活跃（between）⑥ 练习次数分组计数
     */
    public List<StudentSummary> studentSummaries(List<User> students) {
        if (students == null || students.isEmpty()) {
            return List.of();
        }
        List<Long> ids = students.stream().map(User::getId).toList();
        Map<Long, List<Mastery>> masteryByUser = masteryMapper.selectList(new LambdaQueryWrapper<Mastery>()
                        .in(Mastery::getUserId, ids))
                .stream().collect(Collectors.groupingBy(Mastery::getUserId));
        Map<Long, String> kpNames = kpMapper.selectList(null).stream()
                .collect(Collectors.toMap(KnowledgePoint::getId, KnowledgePoint::getKpCode, (a, b) -> a));

        Set<Long> classIds = students.stream().map(User::getClassId)
                .filter(Objects::nonNull).collect(Collectors.toSet());
        Map<Long, List<Assignment>> assignsByClass = classIds.isEmpty() ? Map.of()
                : assignmentMapper.selectList(new LambdaQueryWrapper<Assignment>()
                                .in(Assignment::getClassId, classIds).ne(Assignment::getStatus, "DRAFT"))
                        .stream().collect(Collectors.groupingBy(Assignment::getClassId));
        List<Long> aIds = assignsByClass.values().stream()
                .flatMap(List::stream).map(Assignment::getId).distinct().toList();
        Set<String> submittedKeys = aIds.isEmpty() ? Set.of()
                : submissionMapper.selectList(new LambdaQueryWrapper<Submission>()
                                .in(Submission::getAssignmentId, aIds)
                                .in(Submission::getStudentId, ids)
                                .ne(Submission::getStatus, "MISSING"))
                        .stream().map(s -> s.getAssignmentId() + ":" + s.getStudentId())
                        .collect(Collectors.toSet());

        LocalDate today = LocalDate.now();
        Map<String, Integer> actMap = dailyActivityMapper.selectList(new LambdaQueryWrapper<DailyActivity>()
                        .in(DailyActivity::getUserId, ids)
                        .between(DailyActivity::getStatDate, today.minusDays(6), today))
                .stream().collect(Collectors.toMap(
                        d -> d.getUserId() + ":" + d.getStatDate(),
                        DailyActivity::getMinutes, (a, b) -> a));
        Map<Long, Long> attemptCounts = exerciseRecordMapper.selectList(new LambdaQueryWrapper<ExerciseRecord>()
                        .in(ExerciseRecord::getUserId, ids))
                .stream().collect(Collectors.groupingBy(ExerciseRecord::getUserId, Collectors.counting()));

        List<StudentSummary> result = new ArrayList<>(students.size());
        for (User stu : students) {
            List<Mastery> masteries = masteryByUser.getOrDefault(stu.getId(), List.of());
            int mastery = (int) Math.round(masteries.stream()
                    .mapToInt(Mastery::getMasteryValue).average().orElse(0));
            List<Long> weakKps = masteries.stream().filter(m -> m.getMasteryValue() < 50)
                    .sorted(Comparator.comparingInt(Mastery::getMasteryValue))
                    .map(Mastery::getKpId).limit(3).toList();

            List<Assignment> assignments = stu.getClassId() != null
                    ? assignsByClass.getOrDefault(stu.getClassId(), List.of()) : List.of();
            long submitted = assignments.stream()
                    .filter(as -> submittedKeys.contains(as.getId() + ":" + stu.getId())).count();
            int submitRate = assignments.isEmpty() ? 0
                    : (int) Math.round(submitted * 100.0 / assignments.size());

            int absDays = stu.getLastLoginAt() != null
                    ? (int) ChronoUnit.DAYS.between(stu.getLastLoginAt().toLocalDate(), LocalDate.now()) : 0;

            List<Integer> trend = new ArrayList<>();
            for (int i = 6; i >= 0; i--) {
                LocalDate day = today.minusDays(i);
                Integer minutes = actMap.getOrDefault(stu.getId() + ":" + day, 0);
                trend.add(Math.min(4, minutes / 45));
            }

            long attempts = attemptCounts.getOrDefault(stu.getId(), 0L);
            String risk = mastery < 45 || absDays >= 4 ? "high"
                    : (mastery < 52 || submitRate < 60 ? "mid" : "low");

            result.add(new StudentSummary(String.valueOf(stu.getId()), stu.getRealName(), mastery, submitRate,
                    absDays, risk, weakKps.stream().map(kpNames::get).toList(), trend, attempts));
        }
        return result;
    }

    /**
     * 重置学生密码为统一初始密码 GZgs@2026（BCrypt 存储）
     * 权限约束：学生须属于当前教师授课的班级（教师无授课班级时回退兼容演示账号）
     */
    @Transactional
    public String resetStudentPassword(Long teacherId, Long studentId) {
        User stu = userMapper.selectById(studentId);
        if (stu == null || !"STUDENT".equals(stu.getRole())) {
            throw new BizException("学生不存在");
        }
        List<Long> ownClassIds = classMapper.selectList(new LambdaQueryWrapper<ClassEntity>()
                        .eq(ClassEntity::getTeacherId, teacherId))
                .stream().map(ClassEntity::getId).toList();
        if (!ownClassIds.isEmpty() && (stu.getClassId() == null || !ownClassIds.contains(stu.getClassId()))) {
            throw new BizException("无权操作该学生");
        }
        stu.setPasswordHash(passwordEncoder.encode("GZgs@2026"));
        userMapper.updateById(stu);
        return stu.getRealName();
    }

    /**
     * 预警列表（班级归属校验：授课或共同管理）
     */
    public List<Map<String, Object>> warnings(Long teacherId, Long classId, String level, Boolean handled) {
        checkClassVisible(teacherId, classId);
        LambdaQueryWrapper<Warning> qw = new LambdaQueryWrapper<Warning>()
                .eq(classId != null, Warning::getClassId, classId)
                .eq(level != null && !level.isBlank(), Warning::getLevel, level != null ? level.toUpperCase() : null)
                .eq(handled != null, Warning::getHandled, handled)
                .orderByDesc(Warning::getCreatedAt);
        List<Warning> list = warningMapper.selectList(qw);
        Map<Long, String> names = userMapper.selectList(new LambdaQueryWrapper<User>()
                        .eq(User::getRole, "STUDENT"))
                .stream().collect(Collectors.toMap(User::getId, User::getRealName));
        List<Map<String, Object>> result = new ArrayList<>();
        for (Warning w : list) {
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("id", String.valueOf(w.getId()));
            dto.put("level", w.getLevel() != null ? w.getLevel().toLowerCase() : "mid");
            dto.put("type", w.getType());
            dto.put("sid", w.getStudentId() != null ? String.valueOf(w.getStudentId()) : null);
            dto.put("name", w.getStudentId() != null ? names.getOrDefault(w.getStudentId(), "-") : "全班");
            dto.put("desc", w.getDescription());
            dto.put("time", w.getCreatedAt() != null
                    ? w.getCreatedAt().format(java.time.format.DateTimeFormatter.ofPattern("MM-dd HH:mm")) : null);
            dto.put("handled", Boolean.TRUE.equals(w.getHandled()));
            result.add(dto);
        }
        return result;
    }

    @Transactional
    public void handleWarning(Long teacherId, Long warningId) {
        Warning w = warningMapper.selectById(warningId);
        if (w == null) {
            throw new BizException("预警不存在");
        }
        checkClassVisible(teacherId, w.getClassId());
        w.setHandled(true);
        w.setHandledAt(LocalDateTime.now());
        warningMapper.updateById(w);
    }

    public void notifyStudent(Long teacherId, Long warningId) {
        Warning w = warningMapper.selectById(warningId);
        if (w == null || w.getStudentId() == null) {
            throw new BizException("预警不存在或不支持推送");
        }
        checkClassVisible(teacherId, w.getClassId());
        notificationService.push(w.getStudentId(),
                "教师提醒：" + w.getDescription() + " 如有困难请及时联系老师或使用智能体辅导。", "REMIND");
        w.setHandled(true);
        w.setHandledAt(LocalDateTime.now());
        warningMapper.updateById(w);
    }

    /**
     * 班级薄弱点报告（学情 Agent 生成）
     */
    public Map<String, Object> runInsight(Long teacherId, Long classId) {
        Map<String, Object> dash = dashboard(teacherId, classId);
        List<StudentSummary> students = studentList(classId);

        StringBuilder data = new StringBuilder();
        data.append("## 班级学情数据\n");
        data.append("学生数：").append(((Map) dash.get("kpi")).get("studentCount"))
                .append("，班级平均掌握度：").append(((Map) dash.get("kpi")).get("avgMastery"))
                .append("，作业提交率：").append(((Map) dash.get("kpi")).get("submitRate")).append("%\n");
        data.append("\n### 卡点知识点 TOP6（知识点 / 平均掌握度 / 卡点率）\n");
        for (Object sp : (List<?>) dash.get("stuckPoints")) {
            Map<?, ?> m = (Map<?, ?>) sp;
            data.append("- ").append(m.get("name")).append("：平均 ").append(m.get("avg"))
                    .append(" 分，卡点率 ").append(m.get("stuckRate")).append("%\n");
        }
        data.append("\n### 高风险学生\n");
        for (StudentSummary s : students) {
            if ("high".equals(s.getRisk())) {
                data.append("- ").append(s.getName()).append("：掌握度 ").append(s.getMastery())
                        .append("，提交率 ").append(s.getSubmitRate()).append("%，连续未登录 ")
                        .append(s.getAbsDays()).append(" 天\n");
            }
        }

        String report = llmClient.chat(List.of(
                ChatMessage.system(agentPrompts.get(AgentPrompts.INSIGHT)),
                ChatMessage.user(data.toString())), 0.3);

        notificationService.push(teacherId, "班级薄弱点报告已生成（学情 Agent）。", "TEACHER");

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("report", report);
        result.put("stats", dash);
        result.put("mock", llmClient.isMock());
        result.put("generatedAt", LocalDateTime.now()
                .format(java.time.format.DateTimeFormatter.ofPattern("MM-dd HH:mm")));
        return result;
    }

    private List<User> classStudents(Long classId) {
        if (classId == null) {
            ClassEntity cls = classMapper.selectOne(new LambdaQueryWrapper<ClassEntity>().last("LIMIT 1"));
            classId = cls != null ? cls.getId() : 1L;
        }
        return userMapper.selectList(new LambdaQueryWrapper<User>()
                .eq(User::getClassId, classId).eq(User::getRole, "STUDENT"));
    }

    @lombok.Data
    @lombok.AllArgsConstructor
    public static class StudentSummary {
        private String id;
        private String name;
        private int mastery;
        private int submitRate;
        private int absDays;
        private String risk;
        private List<String> weak;
        private List<Integer> trend;
        private long attempts;
    }
}
