package com.la.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.ai.ChatMessage;
import com.la.ai.LlmClient;
import com.la.entity.KnowledgePoint;
import com.la.exception.BizException;
import com.la.mapper.KnowledgePointMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 出题组卷：一键 AI 生成题目（基于关联知识点 + 已添加题目参考）
 * DeepSeek 不可用或解析失败时降级为本地模板生成，保证功能始终可用。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ComposeAiService {

    private final LlmClient llmClient;
    private final KnowledgePointMapper knowledgePointMapper;
    private final ObjectMapper objectMapper;

    /**
     * 生成符合规范的题目：每题完整包含题干、正确答案、难度、关联知识点、答案解析
     * blankTypes：待填充空白题的题型列表（按顺序），生成结果的前 blankTypes.size() 道按此题型出题
     */
    public List<Map<String, Object>> generate(List<String> kpCodes, List<Map<String, Object>> existing,
                                               int count, List<String> blankTypes) {
        if (kpCodes == null || kpCodes.isEmpty()) {
            throw new BizException("请先关联知识点");
        }
        List<KnowledgePoint> kps = knowledgePointMapper.selectList(new LambdaQueryWrapper<KnowledgePoint>()
                .in(KnowledgePoint::getKpCode, kpCodes));
        if (kps.isEmpty()) {
            throw new BizException("关联的知识点不存在");
        }
        int blanks = blankTypes == null ? 0 : blankTypes.size();
        int want = Math.max(Math.max(1, Math.min(count, 5)), blanks);
        if (llmClient.isMock()) {
            return mockGenerate(kps, want, blankTypes);
        }
        try {
            List<Map<String, Object>> result = llmGenerate(kps, existing, want, blankTypes);
            if (!result.isEmpty()) {
                return result;
            }
        } catch (Exception e) {
            log.warn("AI 出题生成失败，降级为本地模板：{}", e.getMessage());
        }
        return mockGenerate(kps, want, blankTypes);
    }

    /** DeepSeek 生成：要求输出严格 JSON 数组并做字段校验清洗 */
    private List<Map<String, Object>> llmGenerate(List<KnowledgePoint> kps, List<Map<String, Object>> existing,
                                                  int count, List<String> blankTypes) {
        StringBuilder kpLine = new StringBuilder();
        for (KnowledgePoint k : kps) {
            kpLine.append(k.getKpCode()).append("（").append(k.getName()).append("）").append("，");
        }
        StringBuilder existLine = new StringBuilder();
        if (existing != null && !existing.isEmpty()) {
            existLine.append("已添加的题目（出题风格与难度参考，不要重复）：");
            for (Map<String, Object> q : existing) {
                existLine.append('[').append(q.get("type")).append("] ").append(q.get("title")).append("；");
            }
        } else {
            existLine.append("暂无已有题目");
        }
        // 前 blankTypes.size() 道按教师已选好的空白题题型出题，其余自由发挥
        StringBuilder typeLine = new StringBuilder();
        if (blankTypes != null && !blankTypes.isEmpty()) {
            typeLine.append("前 ").append(blankTypes.size()).append(" 道题的 type 必须依次为：");
            for (String t : blankTypes) {
                typeLine.append(t).append("、");
            }
            typeLine.append("（这些题将用于填充教师已建好的空白题目，题型不可更改）；其余 ").append(count - blankTypes.size()).append(" 道题自选题型。\n");
        }
        String system = "你是 Java 教学出题专家。根据给定的知识点和已有题目参考，生成 " + count + " 道 Java 作业题。\n"
                + (typeLine.length() > 0 ? typeLine + "\n" : "题型尽量分散。\n")
                + "严格只输出一个 JSON 数组，不要输出任何其他文字或代码块标记。每个元素字段：\n"
                + "type：SINGLE（单选）/MULTI（多选）/FILL（填空）/JUDGE（判断）/SHORT（简答）/CODE（编程）之一；\n"
                + "title：题干字符串；\n"
                + "options：仅单选/多选提供，4 个元素的数组 [{\"key\":\"A\",\"text\":\"...\"},...]，text 不为空；\n"
                + "answer：单选 [\"A\"]、多选 [\"A\",\"B\"]、判断 [true 或 false]、填空/简答/编程 [\"参考答案文本\"]；\n"
                + "difficulty：0.8 或 0.5 或 0.2；\n"
                + "kpCode：从给定知识点编码中选一个；\n"
                + "analysis：答案解析字符串（说明为什么正确、易错点）。\n"
                + "每题内容不得与已有题目重复。";
        String user = "知识点：" + kpLine + "\n" + existLine;
        String content = llmClient.chat(List.of(ChatMessage.system(system), ChatMessage.user(user)), 0.7);
        return parseQuestions(content, kps);
    }

    /** 解析并清洗模型输出（容错：剥离代码块围栏、截取首个 JSON 数组） */
    private List<Map<String, Object>> parseQuestions(String content, List<KnowledgePoint> kps) {
        List<Map<String, Object>> result = new ArrayList<>();
        if (content == null || content.isBlank()) {
            return result;
        }
        String text = content.trim();
        int s = text.indexOf('[');
        int e = text.lastIndexOf(']');
        if (s < 0 || e <= s) {
            return result;
        }
        try {
            JsonNode arr = objectMapper.readTree(text.substring(s, e + 1));
            List<String> validTypes = List.of("SINGLE", "MULTI", "FILL", "JUDGE", "SHORT", "CODE");
            List<String> kpIds = kps.stream().map(KnowledgePoint::getKpCode).toList();
            for (JsonNode q : arr) {
                String type = q.path("type").asText("");
                if (!validTypes.contains(type)) {
                    continue;
                }
                String title = q.path("title").asText("").trim();
                if (title.isEmpty()) {
                    continue;
                }
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("type", type);
                m.put("title", title);
                if ("SINGLE".equals(type) || "MULTI".equals(type)) {
                    List<Map<String, Object>> opts = new ArrayList<>();
                    if (q.path("options").isArray()) {
                        for (JsonNode o : q.path("options")) {
                            String t = o.path("text").asText("").trim();
                            if (!t.isEmpty()) {
                                Map<String, Object> om = new LinkedHashMap<>();
                                om.put("key", o.path("key").asText(String.valueOf((char) ('A' + opts.size()))));
                                om.put("text", t);
                                opts.add(om);
                            }
                        }
                    }
                    if (opts.size() < 2) {
                        continue;
                    }
                    m.put("options", opts);
                    List<Object> ans = new ArrayList<>();
                    if (q.path("answer").isArray()) {
                        q.path("answer").forEach(a -> ans.add(a.isBoolean() ? a.asBoolean() : a.asText()));
                    }
                    if (ans.isEmpty()) {
                        continue;
                    }
                    m.put("answer", ans);
                } else if ("JUDGE".equals(type)) {
                    boolean ans = false;
                    if (q.path("answer").isArray() && q.path("answer").size() > 0) {
                        JsonNode a = q.path("answer").get(0);
                        ans = a.isBoolean() ? a.asBoolean() : "true".equalsIgnoreCase(a.asText());
                    }
                    m.put("answer", List.of(ans));
                } else {
                    List<Object> ans = new ArrayList<>();
                    if (q.path("answer").isArray() && q.path("answer").size() > 0) {
                        ans.add(q.path("answer").get(0).asText());
                    }
                    m.put("answer", ans);
                }
                double diff = 0.5;
                try { diff = q.path("difficulty").asDouble(0.5); } catch (Exception ignore) { }
                m.put("difficulty", diff);
                String kpCode = q.path("kpCode").asText("");
                m.put("kpCode", kpIds.contains(kpCode) ? kpCode : kpIds.get(0));
                m.put("analysis", q.path("analysis").asText(""));
                result.add(m);
            }
        } catch (Exception ex) {
            log.warn("AI 出题 JSON 解析失败：{}", ex.getMessage());
        }
        return result;
    }

    /** 本地模板生成（DeepSeek 未配置 / 调用失败时的兜底），字段同样完整；支持按指定题型出题 */
    private List<Map<String, Object>> mockGenerate(List<KnowledgePoint> kps, int count, List<String> blankTypes) {
        List<Map<String, Object>> result = new ArrayList<>();
        String[] diffs = {"0.8", "0.5", "0.2"};
        for (int i = 0; i < count; i++) {
            KnowledgePoint k = kps.get(i % kps.size());
            // 指定题型的按序使用，其余随机选择
            String type;
            if (blankTypes != null && i < blankTypes.size()) {
                type = blankTypes.get(i);
            } else {
                String[] all = {"SINGLE", "JUDGE", "FILL"};
                type = all[(i * 7 + kps.size()) % 3];
            }
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("kpCode", k.getKpCode());
            m.put("difficulty", diffs[i % 3]);
            m.put("analysis", "本题考查「" + k.getName() + "」的核心概念。解析：结合定义与典型场景判断，注意区分相近概念，避免被表面措辞干扰。");
            switch (type) {
                case "SINGLE", "MULTI" -> {
                    m.put("type", "SINGLE".equals(type) ? "SINGLE" : "MULTI");
                    m.put("title", "关于「" + k.getName() + "」，下列说法" + ("MULTI".equals(type) ? "正确的有" : "正确的是") + "（　）。");
                    m.put("options", List.of(
                            Map.of("key", "A", "text", "它是 Java 语言中需要重点掌握的核心概念之一"),
                            Map.of("key", "B", "text", "它仅在编译阶段生效，运行期完全无效"),
                            Map.of("key", "C", "text", "它只能用于基本数据类型，不能用于引用类型"),
                            Map.of("key", "D", "text", "它与其他知识点没有任何关联，孤立存在")));
                    m.put("answer", "MULTI".equals(type) ? List.of("A", "D") : List.of("A"));
                }
                case "JUDGE" -> {
                    m.put("type", "JUDGE");
                    m.put("title", "理解并正确运用「" + k.getName() + "」是编写规范 Java 程序的前提。");
                    m.put("answer", List.of(true));
                }
                case "SHORT" -> {
                    m.put("type", "SHORT");
                    m.put("title", "请简述「" + k.getName() + "」的核心概念及其一个典型应用场景。");
                    m.put("answer", List.of("概念定义 + 应用场景说明（示例参考答案）"));
                }
                case "CODE" -> {
                    m.put("type", "CODE");
                    m.put("title", "编写一段代码演示「" + k.getName() + "」的基本用法。");
                    m.put("answer", List.of("能体现该知识点核心语法的完整可运行示例（示例参考答案）"));
                }
                default -> {
                    m.put("type", "FILL");
                    m.put("title", "请简述「" + k.getName() + "」的一个典型应用场景，并填写其核心要点：____。");
                    m.put("answer", List.of("要点与定义相关，言之有理即可（示例参考答案）"));
                }
            }
            result.add(m);
        }
        return result;
    }
}
