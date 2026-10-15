package com.la.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.entity.Question;
import com.la.mapper.QuestionMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 自动评分（独立模块）：按作业发布时预设的标准答案对学生作答进行程序匹配判分。
 * 与教师批改（GradingService）、成绩管理完全解耦：
 *  - 结果不写 submission.score / aiScore 等任何持久化字段，仅在 DTO 中即时计算返回；
 *  - 仅覆盖客观题（单选/多选/判断，有标准答案可精确匹配），主观题留给教师批改；
 *  - 前端展示时须标注「自动评分临时分数」，不计入最终成绩。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class AutoScoreService {

    private final QuestionMapper questionMapper;
    private final ObjectMapper objectMapper;

    /**
     * 按标准答案对结构化作答进行匹配判分。
     * @param answersJson submission.answers 的 JSON 文本，形如 [{"questionId":"5","value":"A"}]
     * @return { total, fullScore, attempted, detail: [{no, type, score, max, correct}] }
     */
    public Map<String, Object> objectiveScore(Long assignmentId, String answersJson) {
        List<Question> questions = questionMapper.selectList(new LambdaQueryWrapper<Question>()
                .eq(Question::getAssignmentId, assignmentId).orderByAsc(Question::getSortOrder));
        Map<String, JsonNode> ansMap = new LinkedHashMap<>();
        if (answersJson != null && !answersJson.isBlank()) {
            try {
                JsonNode arr = objectMapper.readTree(answersJson);
                if (arr.isArray()) {
                    for (JsonNode n : arr) {
                        ansMap.put(n.path("questionId").asText(""), n.path("value"));
                    }
                }
            } catch (Exception e) {
                log.warn("自动评分：作答 JSON 解析失败 assignment={} err={}", assignmentId, e.getMessage());
            }
        }
        double total = 0, full = 0;
        int attempted = 0;
        List<Map<String, Object>> detail = new ArrayList<>();
        for (int i = 0; i < questions.size(); i++) {
            Question q = questions.get(i);
            // 题目满分：CUSTOM 自定义模式取题目自带 score；AVERAGE 百分制（平均分配）模式
            // 下 score 为空，须按前端同口径以 100 分均摊（Math.round(1000/n)/10），
            // 否则答对也得 0 分（曾导致自动评分临时分数全零）
            double max = q.getScore() != null ? q.getScore().doubleValue()
                    : (questions.isEmpty() ? 0 : Math.round(1000.0 / questions.size()) / 10.0);
            full += max;
            Map<String, Object> d = new LinkedHashMap<>();
            d.put("no", i + 1);
            d.put("type", qtypeLabel(q.getType()));
            d.put("max", max);
            if (isObjective(q.getType())) {
                boolean correct = matchObjective(q, ansMap.get(String.valueOf(q.getId())));
                double s = correct ? max : 0;
                total += s;
                d.put("score", s);
                d.put("correct", correct);
                d.put("subjective", false);
                if (ansMap.containsKey(String.valueOf(q.getId()))) {
                    attempted++;
                }
            } else {
                // 主观题无标准答案可精确匹配，不计入自动评分，由教师批改
                d.put("score", null);
                d.put("correct", null);
                d.put("subjective", true);
            }
            detail.add(d);
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("total", Math.round(total * 10) / 10.0);
        result.put("fullScore", Math.round(full * 10) / 10.0);
        result.put("attempted", attempted);
        result.put("objectiveCount", questions.stream().filter(q -> isObjective(q.getType())).count());
        result.put("detail", detail);
        return result;
    }

    /** 客观题标准答案匹配（单选/多选/判断）；未作答视为不匹配 */
    private boolean matchObjective(Question q, JsonNode val) {
        if (val == null || val.isNull()) {
            return false;
        }
        JsonNode mine = val.isArray() ? val : objectMapper.createArrayNode().add(val);
        JsonNode correct = parseArray(q.getAnswer());
        if ("SINGLE".equals(q.getType()) || "JUDGE".equals(q.getType())) {
            return correct.size() == 1 && mine.size() == 1
                    && correct.get(0).asText().equals(mine.get(0).asText());
        }
        if ("MULTI".equals(q.getType())) {
            if (mine.size() != correct.size()) {
                return false;
            }
            for (int i = 0; i < mine.size(); i++) {
                boolean found = false;
                for (int j = 0; j < correct.size(); j++) {
                    if (correct.get(j).asText().equals(mine.get(i).asText())) {
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    return false;
                }
            }
            return true;
        }
        return false;
    }

    private boolean isObjective(String type) {
        return "SINGLE".equals(type) || "MULTI".equals(type) || "JUDGE".equals(type);
    }

    private JsonNode parseArray(String json) {
        try {
            JsonNode n = objectMapper.readTree(json == null ? "[]" : json);
            return n.isArray() ? n : objectMapper.createArrayNode();
        } catch (Exception e) {
            return objectMapper.createArrayNode();
        }
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
}
