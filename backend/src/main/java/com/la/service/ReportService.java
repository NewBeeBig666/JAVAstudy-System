package com.la.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.dto.response.ReviewItemDto;
import com.la.entity.*;
import com.la.exception.BizException;
import com.la.mapper.*;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.stream.Collectors;

/**
 * 学生侧：报告聚合（画像 overview / 掌握度明细）
 */
@Service
@RequiredArgsConstructor
public class ReportService {

    private final UserMapper userMapper;
    private final ClassMapper classMapper;
    private final KnowledgePointMapper kpMapper;
    private final MasteryMapper masteryMapper;
    private final DailyActivityMapper dailyActivityMapper;
    private final ExerciseRecordMapper exerciseRecordMapper;
    private final WrongBookMapper wrongBookMapper;
    private final ExerciseMapper exerciseMapper;
    private final ReviewService reviewService;
    private final ObjectMapper objectMapper;
    private final ExerciseService exerciseService;

    private static final DateTimeFormatter DT = DateTimeFormatter.ofPattern("MM-dd");

    /**
     * 学生画像总览（形状对齐 MOCK.student + reviewQueue + wrongBook）
     */
    public Map<String, Object> overview(Long userId) {
        User user = userMapper.selectById(userId);
        if (user == null) {
            throw new BizException(401, "用户不存在");
        }
        ClassEntity cls = user.getClassId() != null ? classMapper.selectById(user.getClassId()) : null;

        List<KnowledgePoint> kps = kpMapper.selectList(new LambdaQueryWrapper<KnowledgePoint>()
                .eq(KnowledgePoint::getLevel, 2));
        Map<Long, Integer> masteryMap = masteryMapper.selectList(new LambdaQueryWrapper<Mastery>()
                        .eq(Mastery::getUserId, userId))
                .stream().collect(Collectors.toMap(Mastery::getKpId, Mastery::getMasteryValue, (a, b) -> a));

        int avgMastery = (int) Math.round(kps.stream()
                .mapToInt(k -> masteryMap.getOrDefault(k.getId(), 0)).average().orElse(0));

        // 近 7 日活跃
        LocalDate today = LocalDate.now();
        List<DailyActivity> acts = dailyActivityMapper.selectList(new LambdaQueryWrapper<DailyActivity>()
                .eq(DailyActivity::getUserId, userId)
                .ge(DailyActivity::getStatDate, today.minusDays(6)));
        Map<LocalDate, Integer> actMap = acts.stream()
                .collect(Collectors.toMap(DailyActivity::getStatDate, DailyActivity::getMinutes, (a, b) -> a));
        List<Double> weekActivity = new ArrayList<>();
        for (int i = 6; i >= 0; i--) {
            weekActivity.add(Math.round(actMap.getOrDefault(today.minusDays(i), 0) / 6.0) / 10.0);
        }

        // 连续学习天数（从今天或昨天往前数）
        int streakDays = 0;
        LocalDate cursor = actMap.containsKey(today) ? today : today.minusDays(1);
        while (actMap.containsKey(cursor) && actMap.get(cursor) > 0) {
            streakDays++;
            cursor = cursor.minusDays(1);
        }

        double weekHours = Math.round(weekActivity.stream().mapToDouble(Double::doubleValue).sum() * 10) / 10.0;

        long doneExercises = exerciseRecordMapper.selectCount(new LambdaQueryWrapper<ExerciseRecord>()
                .eq(ExerciseRecord::getUserId, userId));

        // 掌握度趋势：以当前 avgMastery 为基准，减去从各日起之后的累计 delta
        List<ExerciseRecord> recentRecords = exerciseRecordMapper.selectList(
                new LambdaQueryWrapper<ExerciseRecord>()
                        .eq(ExerciseRecord::getUserId, userId)
                        .ge(ExerciseRecord::getCreatedAt, today.minusDays(6).atStartOfDay()));
        List<Integer> masteryTrend = new ArrayList<>();
        for (int i = 6; i >= 0; i--) {
            LocalDate day = today.minusDays(i);
            LocalDateTime dayEnd = day.plusDays(1).atStartOfDay();
            int deltaAfter = recentRecords.stream()
                    .filter(r -> r.getCreatedAt() != null && r.getCreatedAt().isAfter(dayEnd))
                    .mapToInt(ExerciseRecord::getDelta).sum();
            masteryTrend.add(Math.max(0, avgMastery - deltaAfter));
        }

        List<ReviewItemDto> reviewQueue = reviewService.all(userId);
        List<Map<String, Object>> wrongBook = wrongBookList(userId);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("id", String.valueOf(user.getId()));
        result.put("name", user.getRealName());
        result.put("sid", user.getStudentNo());
        result.put("className", cls != null ? cls.getName() : null);
        result.put("streakDays", streakDays);
        result.put("weekHours", weekHours);
        result.put("doneExercises", doneExercises);
        result.put("avgMastery", avgMastery);
        result.put("weekActivity", weekActivity);
        result.put("masteryTrend", masteryTrend);
        result.put("reviewQueue", reviewQueue);
        result.put("wrongBook", wrongBook);
        return result;
    }

    /**
     * 掌握度明细（带模块名）
     */
    public List<Map<String, Object>> masteryDetail(Long userId) {
        List<KnowledgePoint> kps = kpMapper.selectList(new LambdaQueryWrapper<KnowledgePoint>()
                .eq(KnowledgePoint::getLevel, 2).orderByAsc(KnowledgePoint::getSortOrder));
        Map<Long, Integer> masteryMap = masteryMapper.selectList(new LambdaQueryWrapper<Mastery>()
                        .eq(Mastery::getUserId, userId))
                .stream().collect(Collectors.toMap(Mastery::getKpId, Mastery::getMasteryValue, (a, b) -> a));
        Map<Long, String> moduleNames = kpMapper.selectList(new LambdaQueryWrapper<KnowledgePoint>()
                        .eq(KnowledgePoint::getLevel, 1))
                .stream().collect(Collectors.toMap(KnowledgePoint::getId, KnowledgePoint::getName));

        List<Map<String, Object>> result = new ArrayList<>();
        for (KnowledgePoint kp : kps) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("id", kp.getKpCode());
            item.put("name", kp.getName());
            item.put("module", kp.getParentId() != null ? moduleNames.get(kp.getParentId()) : null);
            item.put("mastery", masteryMap.getOrDefault(kp.getId(), 0));
            result.add(item);
        }
        return result;
    }

    private List<Map<String, Object>> wrongBookList(Long userId) {
        // 委托 ExerciseService.wrongBook（含题目详情弹窗所需的完整字段：题干/选项/
        // 正确答案/解析/最近作答），保持错题本接口与画像总览数据一致
        return exerciseService.wrongBook(userId);
    }

    private String shorten(String stem) {
        String one = stem.replaceAll("\\s+", " ").trim();
        return one.length() > 40 ? one.substring(0, 40) + "…" : one;
    }
}
