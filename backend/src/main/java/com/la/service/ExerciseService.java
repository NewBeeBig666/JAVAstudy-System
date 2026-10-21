package com.la.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.ai.ChatMessage;
import com.la.ai.LlmClient;
import com.la.dto.response.AttemptResponse;
import com.la.dto.response.ExerciseDto;
import com.la.entity.Exercise;
import com.la.entity.ExerciseRecord;
import com.la.entity.KnowledgePoint;
import com.la.entity.WrongBook;
import com.la.exception.BizException;
import com.la.mapper.ExerciseMapper;
import com.la.mapper.ExerciseRecordMapper;
import com.la.mapper.KnowledgePointMapper;
import com.la.mapper.WrongBookMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Service
@RequiredArgsConstructor
public class ExerciseService {

    private final ExerciseMapper exerciseMapper;
    private final ExerciseRecordMapper recordMapper;
    private final KnowledgePointMapper kpMapper;
    private final WrongBookMapper wrongBookMapper;
    private final MasteryService masteryService;
    private final ReviewService reviewService;
    private final ObjectMapper objectMapper;
    private final LlmClient llmClient;

    /**
     * 知识点下的题目（不泄露 answer / analysis / hints）
     */
    public List<ExerciseDto> listByKp(String kpCode) {
        KnowledgePoint kp = kpMapper.selectOne(new LambdaQueryWrapper<KnowledgePoint>()
                .eq(KnowledgePoint::getKpCode, kpCode));
        if (kp == null) {
            throw new BizException("知识点不存在: " + kpCode);
        }
        List<Exercise> list = exerciseMapper.selectList(new LambdaQueryWrapper<Exercise>()
                .eq(Exercise::getKpId, kp.getId()));
        return list.stream().map(this::toDto).toList();
    }

    public ExerciseDto detail(Long exerciseId) {
        Exercise ex = exerciseMapper.selectById(exerciseId);
        if (ex == null) {
            throw new BizException("题目不存在");
        }
        return toDto(ex);
    }

    /**
     * 请求一级提示（level 1-3）
     */
    public Map<String, Object> hint(Long exerciseId, int level) {
        if (level < 1 || level > 3) {
            throw new BizException("提示级别为 1-3");
        }
        Exercise ex = exerciseMapper.selectById(exerciseId);
        if (ex == null) {
            throw new BizException("题目不存在");
        }
        List<String> hints = parseJsonArray(ex.getHints());
        if (hints.size() < level) {
            throw new BizException("该题没有更多提示了");
        }
        return Map.of("hint", hints.get(level - 1), "level", level);
    }

    /**
     * 提交答案（一个事务内完成）：判分 → 掌握度回写 → 练习记录 → 错题本 → SM-2 入队
     */
    @Transactional
    public AttemptResponse attempt(Long userId, Long exerciseId, Integer selected, Integer hintUsed) {
        Exercise ex = exerciseMapper.selectById(exerciseId);
        if (ex == null) {
            throw new BizException("题目不存在");
        }
        if (selected == null || selected < 0) {
            throw new BizException("请选择一个答案");
        }
        boolean correct = ex.getAnswer() != null && ex.getAnswer().equals(selected);
        // 做错不扣分（鼓励大胆试错）：掌握度记 +0；做照常加分
        int applied = correct ? ex.getMasteryDelta() : 0;

        // 1) 练习记录
        ExerciseRecord record = new ExerciseRecord();
        record.setUserId(userId);
        record.setExerciseId(exerciseId);
        record.setKpId(ex.getKpId());
        record.setSelected(selected);
        record.setIsCorrect(correct);
        record.setDelta(applied);
        record.setHintUsed(hintUsed != null ? hintUsed : 0);
        record.setCreatedAt(LocalDateTime.now());
        recordMapper.insert(record);

        // 2) 掌握度回写：做对加分；做错不回写（保持原值，无记录不创建——
        //    避免 0 分记录把"暂无数据"知识点误判为有数据的薄弱根因）
        Integer newMastery = correct
                ? masteryService.adjust(userId, ex.getKpId(), applied)
                : masteryService.currentValue(userId, ex.getKpId());

        // 3) 错题本 + SM-2
        boolean wrongBookAdded = false;
        LocalDate reviewNext = null;
        if (!correct) {
            WrongBook wb = wrongBookMapper.selectOne(new LambdaQueryWrapper<WrongBook>()
                    .eq(WrongBook::getUserId, userId).eq(WrongBook::getExerciseId, exerciseId));
            if (wb == null) {
                wb = new WrongBook();
                wb.setUserId(userId);
                wb.setExerciseId(exerciseId);
                wb.setKpId(ex.getKpId());
                wb.setWrongCount(1);
                wb.setLastWrongAt(LocalDateTime.now());
                wrongBookMapper.insert(wb);
                wrongBookAdded = true;
            } else {
                wb.setWrongCount(wb.getWrongCount() + 1);
                wb.setLastWrongAt(LocalDateTime.now());
                wrongBookMapper.updateById(wb);
            }
            reviewNext = reviewService.enqueueForWrong(userId, ex);
        }

        // 4) 学习时长（一次练习记 3 分钟）
        masteryService.addMinutes(userId, 3);

        return new AttemptResponse(correct, ex.getAnswer(), ex.getAnalysis(), applied,
                newMastery, wrongBookAdded, reviewNext);
    }

    /**
     * 非选择题型的文本作答（编程/填空/简答/判断）：判分 → 掌握度回写 → 记录 → 错题本 → SM-2。
     * 判断/填空按预设答案精确比对；编程/简答交由 AI 按题干点评，AI 不可用时兜底为完成度判定。
     */
    @Transactional
    public AttemptResponse attemptText(Long userId, Long exerciseId, String answer, Integer hintUsed) {
        Exercise ex = exerciseMapper.selectById(exerciseId);
        if (ex == null) {
            throw new BizException("题目不存在");
        }
        if (answer == null || answer.isBlank()) {
            throw new BizException("请输入作答内容");
        }
        String type = ex.getType() == null ? "" : ex.getType().toUpperCase();
        boolean correct;
        String analysis;
        if ("JUDGE".equals(type)) {
            // 预设答案 0=正确 / 1=错误；学生作答"正确/对/true/A" 视为选正确
            boolean studentSaysTrue = answer.trim().matches("(?i)(正确|对|true|是|√|A)");
            boolean keyIsTrue = ex.getAnswer() != null && ex.getAnswer() == 0;
            correct = studentSaysTrue == keyIsTrue;
            analysis = ex.getAnalysis() != null ? ex.getAnalysis() : (keyIsTrue ? "正确答案：正确。" : "正确答案：错误。");
        } else if ("FILL".equals(type) && ex.getAnalysis() != null && ex.getAnalysis().contains("=")) {
            // 填空题参考答案约定写在解析里（"参考答案：xxx"），按文本归一化比对
            String ref = extractFillRef(ex.getAnalysis());
            correct = ref != null && normalize(answer).equals(ref);
            analysis = ex.getAnalysis();
        } else {
            // 编程/简答：AI 点评（题干 + 学生作答 → 判定 + 解析）；AI 不可用兜底按完成度给通过
            AiJudgeResult judge = judgeByAi(ex, answer);
            correct = judge.correct;
            analysis = judge.comment != null && !judge.comment.isBlank() ? judge.comment
                    : (ex.getAnalysis() != null ? ex.getAnalysis() : "已记录你的作答，可对照参考要点复盘。");
        }
        // 做错不扣分（鼓励大胆试错）：掌握度记 +0；做照常加分
        int applied = correct ? ex.getMasteryDelta() : 0;

        // 练习记录（selected 记 -1 标记文本作答，answer 存原文）
        ExerciseRecord record = new ExerciseRecord();
        record.setUserId(userId);
        record.setExerciseId(exerciseId);
        record.setKpId(ex.getKpId());
        record.setSelected(-1);
        record.setAnswer(answer);
        record.setIsCorrect(correct);
        record.setDelta(applied);
        record.setHintUsed(hintUsed != null ? hintUsed : 0);
        record.setCreatedAt(LocalDateTime.now());
        recordMapper.insert(record);

        // 掌握度回写：做对加分；做错不回写（保持原值，无记录不创建）
        Integer newMastery = correct
                ? masteryService.adjust(userId, ex.getKpId(), applied)
                : masteryService.currentValue(userId, ex.getKpId());

        boolean wrongBookAdded = false;
        LocalDate reviewNext = null;
        if (!correct) {
            WrongBook wb = wrongBookMapper.selectOne(new LambdaQueryWrapper<WrongBook>()
                    .eq(WrongBook::getUserId, userId).eq(WrongBook::getExerciseId, exerciseId));
            if (wb == null) {
                wb = new WrongBook();
                wb.setUserId(userId);
                wb.setExerciseId(exerciseId);
                wb.setKpId(ex.getKpId());
                wb.setWrongCount(1);
                wb.setLastWrongAt(LocalDateTime.now());
                wrongBookMapper.insert(wb);
                wrongBookAdded = true;
            } else {
                wb.setWrongCount(wb.getWrongCount() + 1);
                wb.setLastWrongAt(LocalDateTime.now());
                wrongBookMapper.updateById(wb);
            }
            reviewNext = reviewService.enqueueForWrong(userId, ex);
        }
        masteryService.addMinutes(userId, 3);

        return new AttemptResponse(correct, null, analysis, applied, newMastery, wrongBookAdded, reviewNext);
    }

    /** 编程/简答题 AI 点评：判定是否达到要求并给出解析性反馈 */
    private AiJudgeResult judgeByAi(Exercise ex, String answer) {
        AiJudgeResult r = new AiJudgeResult();
        try {
            String system = "你是 Java 编程助教。根据题干与学生作答判断作答是否基本正确，并给一段简短解析性点评。"
                    + "严格只输出 JSON：{\"correct\":true或false,\"comment\":\"一句话判定理由 + 关键改进点\"}。";
            String user = "题干：" + null2(ex.getStem()) + "\n\n学生作答：\n" + answer;
            String raw = llmClient.chat(List.of(ChatMessage.system(system), ChatMessage.user(user)), 0.2);
            String json = raw == null ? "" : raw.trim()
                    .replace("```json", "").replace("```", "").trim();
            int s = json.indexOf('{'), e = json.lastIndexOf('}');
            if (s >= 0 && e > s) {
                var node = objectMapper.readTree(json.substring(s, e + 1));
                r.correct = node.path("correct").asBoolean(false);
                r.comment = node.path("comment").asText("");
            }
        } catch (Exception ignore) {
            // AI 不可用：兜底按完成度判定（已认真作答即通过），避免阻塞学生流程
            r.correct = answer.trim().length() >= 10;
            r.comment = "AI 点评暂不可用。已记录你的作答，可对照参考要点自行复盘。";
        }
        return r;
    }

    private static class AiJudgeResult {
        boolean correct;
        String comment;
    }

    /** 从解析文本中提取"参考答案：xxx"（填空题约定格式） */
    private String extractFillRef(String analysis) {
        int i = analysis.indexOf("参考答案");
        if (i < 0) {
            return null;
        }
        int c = analysis.indexOf('：', i);
        if (c < 0) {
            return null;
        }
        String rest = analysis.substring(c + 1).trim();
        int end = rest.indexOf("。") >= 0 ? rest.indexOf("。") : rest.length();
        return normalize(rest.substring(0, end));
    }

    /** 文本归一化：去空白与标点，小写 */
    private String normalize(String s) {
        return s == null ? "" : s.replaceAll("[\\s，。、；;：:\"'（）()]", "").toLowerCase();
    }

    private String null2(String s) {
        return s == null ? "" : s;
    }

    private ExerciseDto toDto(Exercise ex) {
        KnowledgePoint kp = kpMapper.selectById(ex.getKpId());
        return new ExerciseDto(ex.getId(), kp != null ? kp.getKpCode() : null,
                ex.getType(), ex.getDifficulty(), ex.getStem(), ex.getCode(),
                parseJsonArray(ex.getOptions()), ex.getMasteryDelta());
    }

    /**
     * 练习题卡片数据（不含 answer/analysis/hints），嵌入 exercise 卡片消息
     */
    public Map<String, Object> exerciseMap(Exercise ex) {
        KnowledgePoint kp = kpMapper.selectById(ex.getKpId());
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", ex.getId());
        m.put("kp", kp != null ? kp.getKpCode() : null);
        m.put("type", ex.getType());
        m.put("difficulty", ex.getDifficulty());
        m.put("stem", ex.getStem());
        m.put("code", ex.getCode());
        m.put("options", parseJsonArray(ex.getOptions()));
        m.put("masteryDelta", ex.getMasteryDelta());
        return m;
    }

    /**
     * 错题本（对齐 MOCK.wrongBook 形状）
     */
    public List<Map<String, Object>> wrongBook(Long userId) {
        List<WrongBook> list = wrongBookMapper.selectList(new LambdaQueryWrapper<WrongBook>()
                .eq(WrongBook::getUserId, userId).orderByDesc(WrongBook::getLastWrongAt));
        List<Map<String, Object>> result = new ArrayList<>();
        for (WrongBook wb : list) {
            Exercise ex = exerciseMapper.selectById(wb.getExerciseId());
            KnowledgePoint kp = kpMapper.selectById(wb.getKpId());
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("id", String.valueOf(wb.getId()));
            dto.put("exerciseId", wb.getExerciseId());
            dto.put("kp", kp != null ? kp.getKpCode() : null);
            dto.put("kpName", kp != null ? kp.getName() : null);
            dto.put("title", ex != null ? shorten(ex.getStem()) : "");
            dto.put("wrongCount", wb.getWrongCount());
            dto.put("lastAt", wb.getLastWrongAt() != null
                    ? wb.getLastWrongAt().format(DateTimeFormatter.ofPattern("MM-dd")) : null);
            // 详情弹窗所需（与练习记录 records DTO 同名字段，前端复用同一弹窗）
            dto.put("type", ex != null ? ex.getType() : null);
            dto.put("stem", ex != null ? ex.getStem() : "");
            dto.put("options", parseOptionsList(ex != null ? ex.getOptions() : null));
            dto.put("answer", ex != null ? ex.getAnswer() : null);
            dto.put("analysis", ex != null ? ex.getAnalysis() : null);
            // 最近一次作答（错题详情展示「我的作答」）
            ExerciseRecord last = recordMapper.selectOne(new LambdaQueryWrapper<ExerciseRecord>()
                    .eq(ExerciseRecord::getUserId, userId).eq(ExerciseRecord::getExerciseId, wb.getExerciseId())
                    .orderByDesc(ExerciseRecord::getCreatedAt).last("limit 1"));
            if (last != null) {
                dto.put("selected", last.getSelected());
                dto.put("userAnswer", last.getAnswer());
                dto.put("correct", Boolean.TRUE.equals(last.getIsCorrect()));
                dto.put("time", last.getCreatedAt() != null
                        ? last.getCreatedAt().format(DateTimeFormatter.ofPattern("MM-dd HH:mm")) : null);
            }
            result.add(dto);
        }
        return result;
    }

    /**
     * 练习记录
     */
    public List<Map<String, Object>> records(Long userId, String kpCode) {
        Long kpId = null;
        if (kpCode != null) {
            KnowledgePoint kp = kpMapper.selectOne(new LambdaQueryWrapper<KnowledgePoint>()
                    .eq(KnowledgePoint::getKpCode, kpCode));
            kpId = kp != null ? kp.getId() : -1L;
        }
        LambdaQueryWrapper<ExerciseRecord> qw = new LambdaQueryWrapper<ExerciseRecord>()
                .eq(ExerciseRecord::getUserId, userId)
                .orderByDesc(ExerciseRecord::getCreatedAt);
        if (kpId != null) {
            qw.eq(ExerciseRecord::getKpId, kpId);
        }
        List<Map<String, Object>> result = new ArrayList<>();
        for (ExerciseRecord r : recordMapper.selectList(qw)) {
            Exercise ex = exerciseMapper.selectById(r.getExerciseId());
            KnowledgePoint kp = kpMapper.selectById(r.getKpId());
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("id", String.valueOf(r.getId()));
            dto.put("exerciseId", r.getExerciseId());
            dto.put("kp", kp != null ? kp.getKpCode() : null);
            // 知识点中文名：历史练习可能绑定 LEGACY 旧节点（如 kp-intro），不在前端图谱数据里，
            // 前端 kpName() 会直接显示编码；由后端统一返回名称，kp 编码保留用于筛选
            dto.put("kpName", kp != null ? kp.getName() : null);
            dto.put("title", ex != null ? shorten(ex.getStem()) : "");
            dto.put("difficulty", ex != null ? ex.getDifficulty() : null);
            dto.put("correct", Boolean.TRUE.equals(r.getIsCorrect()));
            dto.put("delta", r.getDelta());
            dto.put("hintUsed", r.getHintUsed());
            // 详情弹窗所需：完整题干/题型/选项/正确答案/解析/用户当时作答
            dto.put("type", ex != null ? ex.getType() : null);
            dto.put("stem", ex != null ? ex.getStem() : "");
            dto.put("options", parseOptionsList(ex != null ? ex.getOptions() : null));
            dto.put("answer", ex != null ? ex.getAnswer() : null);
            dto.put("analysis", ex != null ? ex.getAnalysis() : null);
            dto.put("selected", r.getSelected());
            dto.put("userAnswer", r.getAnswer());
            dto.put("time", r.getCreatedAt() != null
                    ? r.getCreatedAt().format(DateTimeFormatter.ofPattern("MM-dd HH:mm")) : null);
            result.add(dto);
        }
        return result;
    }

    private String shorten(String stem) {
        String one = stem.replaceAll("\\s+", " ").trim();
        return one.length() > 40 ? one.substring(0, 40) + "…" : one;
    }

    /** options JSON 字符串（字符串数组）→ List，异常/空回退空列表 */
    private List<String> parseOptionsList(String json) {
        if (json == null || json.isBlank()) return List.of();
        try {
            return objectMapper.readValue(json, objectMapper.getTypeFactory()
                    .constructCollectionType(List.class, String.class));
        } catch (Exception e) {
            return List.of();
        }
    }

    private List<String> parseJsonArray(String json) {
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
}
