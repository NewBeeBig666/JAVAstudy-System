package com.la.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.la.entity.*;
import com.la.mapper.*;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.LocalDateTime;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.stream.Collectors;

/**
 * 学情预警自动扫描（预警触发机制，V1.16 起）：
 * - 每日 08:00 定时全量扫描（与前端文案「每日 08:00 刷新」一致），教师端亦可通过
 *   POST /api/teacher/warnings/scan 对自己的可见班级立即检测；
 * - 六类规则：连续未登录 / 提交次数骤降 / 卡点知识点 / 非正常时段提交 /
 *   代码相似度异常 / 班级共性卡点，阈值与种子数据语义对齐；
 * - 去重：同班级 + 同学生 + 同类型存在 3 天内未处理预警时跳过，避免每日重复刷屏。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class WarningScanService {

    private final WarningMapper warningMapper;
    private final UserMapper userMapper;
    private final ClassMapper classMapper;
    private final AssignmentMapper assignmentMapper;
    private final SubmissionMapper submissionMapper;
    private final ExerciseRecordMapper exerciseRecordMapper;
    private final MasteryMapper masteryMapper;
    private final KnowledgePointMapper kpMapper;

    /** 连续未登录阈值（天）：上次登录距今超过该值触发 */
    private static final int LOGIN_SILENCE_DAYS = 5;
    /** 从未登录：账号创建超过该天数且从未登录触发 */
    private static final int NEVER_LOGIN_DAYS = 7;
    /** 提交骤降：近 7 天 ≤ 前 7 天 × 该比例，且前 7 天至少 3 次 */
    private static final double SUBMIT_DROP_RATIO = 0.4;
    /** 卡点知识点：近 30 天同一知识点做错次数 ≥ 该值 */
    private static final int KP_WRONG_TIMES = 3;
    /** 非正常时段：近 7 天 00:00-04:00 提交次数 ≥ 该值 */
    private static final int ODD_HOUR_TIMES = 5;
    /** 代码相似度：≥ 该百分比触发 */
    private static final int SIMILARITY_PCT = 80;
    /** 班级共性卡点：≥ 该人数有掌握数据且平均分 < 40 */
    private static final int CLASS_KP_MIN_STUDENTS = 3;
    /** 同类型去重窗口（天） */
    private static final int DEDUP_DAYS = 3;

    /** 每日 08:00 全量扫描所有班级 */
    @Scheduled(cron = "0 0 8 * * ?")
    public void dailyScan() {
        List<Long> allIds = classMapper.selectList(null)
                .stream().map(ClassEntity::getId).toList();
        Map<String, Object> r = scan(allIds);
        log.info("[预警扫描] 每日定时任务完成：{}", r);
    }

    /**
     * 扫描指定班级并生成预警。
     *
     * @return {"scanned": 班级数, "generated": 新增预警数, "byType": {类型: 数量}}
     */
    public Map<String, Object> scan(List<Long> classIds) {
        LocalDateTime now = LocalDateTime.now();
        Map<String, Integer> byType = new LinkedHashMap<>();
        int generated = 0;
        for (Long cid : classIds) {
            ClassEntity cls = classMapper.selectById(cid);
            if (cls == null) {
                continue;
            }
            List<User> students = userMapper.selectList(new LambdaQueryWrapper<User>()
                    .eq(User::getClassId, cid).eq(User::getRole, "STUDENT"));
            if (students.isEmpty()) {
                continue;
            }
            // 本班作业 → 提交记录（近 14 天，含提交时间）
            Map<Long, List<Submission>> subsByStudent = loadClassSubmissions(cid, now.minusDays(14));
            generated += scanLoginSilence(cls, students, now, byType);
            generated += scanSubmitDrop(cls, students, subsByStudent, now, byType);
            generated += scanStuckKp(cls, students, now, byType);
            generated += scanOddHours(cls, students, subsByStudent, byType);
            generated += scanSimilarity(cls, students, subsByStudent, byType);
            generated += scanClassWeakKp(cls, students, byType);
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("scanned", classIds.size());
        result.put("generated", generated);
        result.put("byType", byType);
        return result;
    }

    /* ==================== 规则 1：连续未登录（HIGH） ====================
     * 上次登录 ≥5 天前 → 连续未登录；从未登录且账号创建 ≥7 天 → 一并提示 */
    private int scanLoginSilence(ClassEntity cls, List<User> students, LocalDateTime now, Map<String, Integer> byType) {
        int n = 0;
        for (User stu : students) {
            LocalDateTime base = stu.getLastLoginAt() != null ? stu.getLastLoginAt() : stu.getCreatedAt();
            if (base == null) {
                continue;
            }
            long days = ChronoUnit.DAYS.between(base, now);
            String desc;
            if (stu.getLastLoginAt() != null && days >= LOGIN_SILENCE_DAYS) {
                desc = "连续 " + days + " 天未登录系统，请关注其学习状态并及时提醒。";
            } else if (stu.getLastLoginAt() == null && days >= NEVER_LOGIN_DAYS) {
                desc = "账号创建 " + days + " 天从未登录系统，可能尚未激活学习，建议课上进行确认。";
            } else {
                continue;
            }
            if (dedupAndInsert(cls.getId(), stu.getId(), "HIGH", "连续未登录", desc, byType)) {
                n++;
            }
        }
        return n;
    }

    /* ==================== 规则 2：提交次数骤降（HIGH） ====================
     * 近 7 天提交 ≤ 前 7 天 × 40% 且前 7 天 ≥ 3 次 */
    private int scanSubmitDrop(ClassEntity cls, List<User> students, Map<Long, List<Submission>> subsByStudent,
                               LocalDateTime now, Map<String, Integer> byType) {
        int n = 0;
        for (User stu : students) {
            List<Submission> subs = subsByStudent.getOrDefault(stu.getId(), List.of());
            long prev = subs.stream().filter(s -> inWindow(s.getSubmittedAt(), now.minusDays(14), now.minusDays(7))).count();
            long recent = subs.stream().filter(s -> inWindow(s.getSubmittedAt(), now.minusDays(7), now)).count();
            if (prev >= 3 && recent <= Math.floor(prev * SUBMIT_DROP_RATIO)) {
                String desc = "作业提交次数骤降：前 7 天提交 " + prev + " 次，近 7 天仅 " + recent
                        + " 次（下降 " + Math.round((1 - recent * 1.0 / prev) * 100) + "%），建议了解近期学习安排。";
                if (dedupAndInsert(cls.getId(), stu.getId(), "HIGH", "提交次数骤降", desc, byType)) {
                    n++;
                }
            }
        }
        return n;
    }

    /* ==================== 规则 3：卡点知识点（MID） ====================
     * 近 30 天同一知识点做错 ≥ 3 次（做错不扣分的设计下仍持续尝试，判定为「卡住」） */
    private int scanStuckKp(ClassEntity cls, List<User> students, LocalDateTime now, Map<String, Integer> byType) {
        int n = 0;
        List<Long> sids = students.stream().map(User::getId).toList();
        if (sids.isEmpty()) {
            return 0;
        }
        List<ExerciseRecord> records = exerciseRecordMapper.selectList(new LambdaQueryWrapper<ExerciseRecord>()
                .in(ExerciseRecord::getUserId, sids)
                .eq(ExerciseRecord::getIsCorrect, false)
                .ge(ExerciseRecord::getCreatedAt, now.minusDays(30)));
        // (学生, 知识点) → 做错次数
        Map<String, Long> wrongCnt = records.stream()
                .collect(Collectors.groupingBy(r -> r.getUserId() + ":" + r.getKpId(), Collectors.counting()));
        Map<Long, KnowledgePoint> kpById = kpMapper.selectBatchIds(
                        records.stream().map(ExerciseRecord::getKpId).filter(Objects::nonNull).distinct().toList())
                .stream().collect(Collectors.toMap(KnowledgePoint::getId, k -> k));
        for (Map.Entry<String, Long> e : wrongCnt.entrySet()) {
            if (e.getValue() < KP_WRONG_TIMES) {
                continue;
            }
            String[] parts = e.getKey().split(":");
            Long sid = Long.valueOf(parts[0]);
            Long kpId = Long.valueOf(parts[1]);
            KnowledgePoint kp = kpById.get(kpId);
            String kpName = kp != null ? kp.getName() : ("知识点#" + kpId);
            String desc = "「" + kpName + "」近 30 天做错 " + e.getValue()
                    + " 次仍在尝试，判定为卡点而非放弃，建议推送针对性讲解或安排辅导。";
            if (dedupAndInsert(cls.getId(), sid, "MID", "卡点知识点", desc, byType)) {
                n++;
            }
        }
        return n;
    }

    /* ==================== 规则 4：非正常时段提交（MID） ====================
     * 近 7 天 00:00-04:00 提交 ≥ 5 次，可能存在赶工或代做风险 */
    private int scanOddHours(ClassEntity cls, List<User> students, Map<Long, List<Submission>> subsByStudent,
                             Map<String, Integer> byType) {
        int n = 0;
        LocalDateTime weekAgo = LocalDateTime.now().minusDays(7);
        for (User stu : students) {
            long odd = subsByStudent.getOrDefault(stu.getId(), List.of()).stream()
                    .filter(s -> inWindow(s.getSubmittedAt(), weekAgo, LocalDateTime.now()))
                    .filter(s -> s.getSubmittedAt().getHour() < 4)
                    .count();
            if (odd >= ODD_HOUR_TIMES) {
                String desc = "近 7 天有 " + odd + " 次提交发生在 00:00-04:00，可能存在夜间赶工或代做风险，建议关注。";
                if (dedupAndInsert(cls.getId(), stu.getId(), "MID", "非正常时段提交", desc, byType)) {
                    n++;
                }
            }
        }
        return n;
    }

    /* ==================== 规则 5：代码相似度异常（HIGH） ====================
     * 近 7 天存在相似度 ≥ 80% 的提交，建议人工复核 */
    private int scanSimilarity(ClassEntity cls, List<User> students, Map<Long, List<Submission>> subsByStudent,
                               Map<String, Integer> byType) {
        int n = 0;
        LocalDateTime weekAgo = LocalDateTime.now().minusDays(7);
        for (User stu : students) {
            Integer maxSim = subsByStudent.getOrDefault(stu.getId(), List.of()).stream()
                    .filter(s -> inWindow(s.getSubmittedAt(), weekAgo, LocalDateTime.now()))
                    .map(Submission::getSimilarity)
                    .filter(Objects::nonNull)
                    .max(Integer::compareTo).orElse(null);
            if (maxSim != null && maxSim >= SIMILARITY_PCT) {
                String desc = "近 7 天提交的最高代码相似度为 " + maxSim + "%，超过 " + SIMILARITY_PCT
                        + "% 预警线，建议对照提交记录人工复核。";
                if (dedupAndInsert(cls.getId(), stu.getId(), "HIGH", "代码相似度异常", desc, byType)) {
                    n++;
                }
            }
        }
        return n;
    }

    /* ==================== 规则 6：班级共性卡点（MID，studentId=NULL） ====================
     * 某知识点 ≥3 名学生有掌握数据且平均分 < 40 */
    private int scanClassWeakKp(ClassEntity cls, List<User> students, Map<String, Integer> byType) {
        int n = 0;
        List<Long> sids = students.stream().map(User::getId).toList();
        if (sids.isEmpty()) {
            return 0;
        }
        List<Mastery> ms = masteryMapper.selectList(new LambdaQueryWrapper<Mastery>()
                .in(Mastery::getUserId, sids));
        Map<Long, List<Integer>> byKp = ms.stream()
                .filter(m -> m.getMasteryValue() != null)
                .collect(Collectors.groupingBy(Mastery::getKpId,
                        Collectors.mapping(Mastery::getMasteryValue, Collectors.toList())));
        for (Map.Entry<Long, List<Integer>> e : byKp.entrySet()) {
            if (e.getValue().size() < CLASS_KP_MIN_STUDENTS) {
                continue;
            }
            double avg = e.getValue().stream().mapToInt(Integer::intValue).average().orElse(100);
            if (avg >= 40) {
                continue;
            }
            KnowledgePoint kp = kpMapper.selectById(e.getKey());
            String kpName = kp != null ? kp.getName() : ("知识点#" + e.getKey());
            String desc = "「" + kpName + "」班级平均掌握度 " + Math.round(avg)
                    + "（" + e.getValue().size() + " 名学生有数据），存在共性薄弱，建议课堂复盘。";
            if (dedupAndInsert(cls.getId(), null, "MID", "班级共性卡点", desc, byType)) {
                n++;
            }
        }
        return n;
    }

    /* ==================== 工具 ==================== */

    /** 同班同生同类型 3 天内已有未处理预警则跳过；否则插入并计数 */
    private boolean dedupAndInsert(Long classId, Long studentId, String level, String type,
                                   String description, Map<String, Integer> byType) {
        Long dup = warningMapper.selectCount(new LambdaQueryWrapper<Warning>()
                .eq(Warning::getClassId, classId)
                .eq(studentId != null, Warning::getStudentId, studentId)
                .isNull(studentId == null, Warning::getStudentId)
                .eq(Warning::getType, type)
                .eq(Warning::getHandled, false)
                .ge(Warning::getCreatedAt, LocalDateTime.now().minusDays(DEDUP_DAYS)));
        if (dup != null && dup > 0) {
            return false;
        }
        Warning w = new Warning();
        w.setClassId(classId);
        w.setStudentId(studentId);
        w.setLevel(level);
        w.setType(type);
        w.setDescription(description);
        w.setHandled(false);
        warningMapper.insert(w);
        byType.merge(type, 1, Integer::sum);
        return true;
    }

    private boolean inWindow(LocalDateTime t, LocalDateTime from, LocalDateTime to) {
        return t != null && !t.isBefore(from) && t.isBefore(to);
    }

    /** 班级全部作业近 N 天的提交记录，按学生分组 */
    private Map<Long, List<Submission>> loadClassSubmissions(Long classId, LocalDateTime since) {
        List<Long> asgIds = assignmentMapper.selectList(new LambdaQueryWrapper<Assignment>()
                        .eq(Assignment::getClassId, classId))
                .stream().map(Assignment::getId).toList();
        if (asgIds.isEmpty()) {
            return Map.of();
        }
        return submissionMapper.selectList(new LambdaQueryWrapper<Submission>()
                        .in(Submission::getAssignmentId, asgIds)
                        .isNotNull(Submission::getSubmittedAt)
                        .ge(Submission::getSubmittedAt, since))
                .stream().collect(Collectors.groupingBy(Submission::getStudentId));
    }
}
