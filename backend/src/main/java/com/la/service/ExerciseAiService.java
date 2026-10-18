package com.la.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.ai.ChatMessage;
import com.la.ai.LlmClient;
import com.la.entity.Exercise;
import com.la.entity.KnowledgePoint;
import com.la.entity.Mastery;
import com.la.exception.BizException;
import com.la.mapper.ExerciseMapper;
import com.la.mapper.MasteryMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;

/**
 * 学生端会话「AI 现场出题」：当知识点题库无新题可抽（题库为空 / 该生已全部做完）时，
 * 调用 DeepSeek 按当前知识点现场生成一道四选一单选题——含题干、选项、答案、解析、三级提示，
 * 校验合格后落库到 exercise 表（沉淀为题库资产，判分 / 提示 / 错题本 / SM-2 复习全链路自动复用）。
 *
 * 生成质量约束：以学生该知识点掌握度定难度（<60 简单 / 60-85 中等 / >85 困难），
 * 参考已有题库题干防止重复考查角度；输出严格 JSON 并做字段级校验，不合格即抛错（由调用方回退题库）。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ExerciseAiService {

    private final LlmClient llmClient;
    private final ExerciseMapper exerciseMapper;
    private final MasteryMapper masteryMapper;
    private final ObjectMapper objectMapper;

    /** 题库单选题统一分值：与现有题库种子一致 */
    private static final int MASTERY_DELTA = 5;

    public Exercise aiGenerate(KnowledgePoint kp, Long userId, List<Exercise> existing) {
        int mastery = currentMastery(userId, kp.getId());
        String difficulty = mastery < 60 ? "简单" : mastery <= 85 ? "中等" : "困难";

        StringBuilder sb = new StringBuilder();
        sb.append("## 出题任务\n");
        sb.append("知识点编码：").append(kp.getKpCode()).append('\n');
        sb.append("知识点名称：").append(kp.getName()).append('\n');
        sb.append("知识点说明：").append(kp.getDescription() == null || kp.getDescription().isBlank()
                ? "（无）" : kp.getDescription()).append('\n');
        sb.append("该学生此知识点当前掌握度：").append(mastery).append("/100，指定出题难度：").append(difficulty).append('\n');
        if (existing != null && !existing.isEmpty()) {
            sb.append("\n题库已有该知识点的题目题干（严禁重复其考查角度与内容）：\n");
            for (Exercise e : existing) {
                String stem = e.getStem() == null ? "" : e.getStem().replace('\n', ' ');
                sb.append("- ").append(stem.length() > 60 ? stem.substring(0, 60) + "…" : stem).append('\n');
            }
        }
        sb.append("""

                请生成一道四选一的单项选择题，严格只输出 JSON（不要 markdown 代码块、不要任何其他文字）：
                {"difficulty":"%s","stem":"题干","options":["选项1","选项2","选项3","选项4"],"answer":0,"analysis":"答案解析","hints":["提示1","提示2","提示3"]}

                要求：
                - answer 为正确选项的下标（0-3）
                - 四个选项相互干扰、只有一项正确，错误项要有典型迷惑性
                - 题干可含代码片段（用\\n换行），考查形式与已有题目不同
                - analysis 讲清正确项为什么对、每个错误项错在哪里，支撑学生自主纠错
                - hints 为三级渐进提示：一级只提醒思考方向、二级缩小范围、三级接近答案，均不直接给答案
                """.formatted(difficulty));

        String raw = llmClient.chat(List.of(
                ChatMessage.system("你是面向大学软件工程专业的 Java 教学出题专家。只输出严格的 JSON，不要输出任何其他文字。"),
                ChatMessage.user(sb.toString())), 0.7);
        log.info("[AI出题·会话] 生成完成 kp={} mastery={} 难度={} 原文长度={}", kp.getKpCode(), mastery, difficulty, raw.length());

        Exercise ex = parseAndBuild(raw, kp, difficulty);
        exerciseMapper.insert(ex);
        log.info("[AI出题·会话] 新题已落库 id={} kp={} 难度={}", ex.getId(), kp.getKpCode(), ex.getDifficulty());
        return ex;
    }

    /** JSON 提取 + 字段级校验：不合格直接抛错，由调用方回退题库抽取 */
    private Exercise parseAndBuild(String raw, KnowledgePoint kp, String fallbackDifficulty) {
        JsonNode root = extractJson(raw);
        if (root == null) {
            throw new BizException("新题生成结果解析失败");
        }
        String stem = root.path("stem").asText("");
        if (stem.isBlank()) {
            throw new BizException("新题题干为空");
        }
        JsonNode opts = root.path("options");
        if (!opts.isArray() || opts.size() != 4) {
            throw new BizException("新题选项数量不合法（需 4 个）");
        }
        List<String> options = new ArrayList<>();
        for (JsonNode o : opts) {
            if (o.asText("").isBlank()) {
                throw new BizException("新题存在空选项");
            }
            options.add(o.asText());
        }
        int answer = root.path("answer").asInt(-1);
        if (answer < 0 || answer > 3) {
            throw new BizException("新题答案下标不合法");
        }
        String analysis = root.path("analysis").asText("");
        if (analysis.isBlank()) {
            throw new BizException("新题缺少答案解析");
        }
        String difficulty = root.path("difficulty").asText("");
        if (!"简单".equals(difficulty) && !"中等".equals(difficulty) && !"困难".equals(difficulty)) {
            difficulty = fallbackDifficulty;
        }
        // 三级渐进提示：不足 3 级用通用提示补齐，保证提示功能完整可用
        List<String> hints = new ArrayList<>();
        if (root.path("hints").isArray()) {
            for (JsonNode h : root.path("hints")) {
                if (!h.asText("").isBlank()) {
                    hints.add(h.asText());
                }
            }
        }
        while (hints.size() < 3) {
            hints.add(List.of("回到该知识点的定义，检查每个选项的关键表述是否准确。",
                            "排除明显违背定义的选项，在剩下的里面找概念陷阱。",
                            "对照题干要求重新验证剩余选项，答案就在其中。")
                    .get(hints.size()));
        }

        try {
            Exercise ex = new Exercise();
            ex.setKpId(kp.getId());
            ex.setType("CHOICE");
            ex.setDifficulty(difficulty);
            ex.setStem(stem);
            ex.setOptions(objectMapper.writeValueAsString(options));
            ex.setAnswer(answer);
            ex.setAnalysis(analysis);
            ex.setHints(objectMapper.writeValueAsString(hints));
            ex.setMasteryDelta(MASTERY_DELTA);
            return ex;
        } catch (Exception e) {
            throw new BizException("新题落库序列化失败");
        }
    }

    /** 容错提取模型返回中的第一个 JSON 对象（容忍 markdown 围栏与前后缀文字） */
    private JsonNode extractJson(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        int s = raw.indexOf('{');
        int e = raw.lastIndexOf('}');
        if (s < 0 || e <= s) {
            return null;
        }
        try {
            return objectMapper.readTree(raw.substring(s, e + 1));
        } catch (Exception ex) {
            return null;
        }
    }

    private int currentMastery(Long userId, Long kpId) {
        Mastery m = masteryMapper.selectOne(new LambdaQueryWrapper<Mastery>()
                .eq(Mastery::getUserId, userId).eq(Mastery::getKpId, kpId));
        return m != null && m.getMasteryValue() != null ? m.getMasteryValue() : 50;
    }
}
