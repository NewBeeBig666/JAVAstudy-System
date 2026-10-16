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
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ThreadLocalRandom;

/**
 * 出题组卷：一键 AI 生成题目（基于关联知识点 + 已添加题目参考）
 * DeepSeek 不可用或解析失败时降级为本地模板生成，保证功能始终可用。
 *
 * 生成质量控制（专项优化）：
 * 1. 题型硬约束：生成题目的题型必须落在教师选定的题型范围内（prompt 约束 + 解析层白名单双重保证）；
 * 2. 去重：同一批次内题目互不重复，且与已添加题目不重复（题干规范化后比对）；
 * 3. 选项质量：选择题须 4 个选项、互不重复、答案 key 合法、围绕同一考察点且具备迷惑性；
 * 4. 答案随机化：选择题选项随机打乱并重映射答案 key（LLM 与模板路径统一生效），
 *    杜绝正确答案固定为 A / AD 的模式；编程题参考答案为可直接运行的完整示例代码（含注释）。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ComposeAiService {

    private static final List<String> ALL_TYPES = List.of("SINGLE", "MULTI", "FILL", "JUDGE", "SHORT", "CODE");

    private final LlmClient llmClient;
    private final KnowledgePointMapper knowledgePointMapper;
    private final ObjectMapper objectMapper;

    /**
     * 生成符合规范的题目：每题完整包含题干、正确答案、难度、关联知识点、答案解析。
     *
     * 参数唯一依据原则：生成题目的数量与题型完全由教师界面上添加的空白题决定——
     * blankTypes 即题型序列，生成结果的数量 = blankTypes.size()、题型与之完全对应，
     * 不追加、不少生成、不使用任何硬编码默认数量。
     * allowedTypes：教师选定的题型范围（用于解析层白名单），空则回退为 blankTypes 的题型集合。
     *
     * 数量保障：LLM 输出经清洗（题型/去重/选项质量）后如有缺口，自动按缺口题型补一轮生成，
     * 仍有缺口则用本地模板逐题补齐，确保最终数量与题型严格等于用户指定。
     */
    public List<Map<String, Object>> generate(List<String> kpCodes, List<Map<String, Object>> existing,
                                             List<String> blankTypes, List<String> allowedTypes) {
        if (kpCodes == null || kpCodes.isEmpty()) {
            throw new BizException("请先关联知识点");
        }
        if (blankTypes == null || blankTypes.isEmpty()) {
            throw new BizException("请先用题型按钮添加空白题目（题型与数量为生成依据），再点击生成");
        }
        for (String t : blankTypes) {
            if (!ALL_TYPES.contains(t)) {
                throw new BizException("存在无效题型：" + t);
            }
        }
        List<KnowledgePoint> kps = knowledgePointMapper.selectList(new LambdaQueryWrapper<KnowledgePoint>()
                .in(KnowledgePoint::getKpCode, kpCodes));
        if (kps.isEmpty()) {
            throw new BizException("关联的知识点不存在");
        }
        List<String> types = sanitizeTypes(allowedTypes);
        if (types.isEmpty()) {
            types = sanitizeTypes(blankTypes);
        }
        // 待生成槽位：题型 -> 剩余数量（保持题型出现顺序）
        LinkedHashMap<String, Integer> pending = new LinkedHashMap<>();
        for (String t : blankTypes) {
            pending.merge(t, 1, Integer::sum);
        }
        Set<String> usedKeys = new HashSet<>();
        if (existing != null) {
            for (Map<String, Object> q : existing) {
                String k = normTitle(String.valueOf(q.getOrDefault("title", "")));
                if (k.length() >= 2) {
                    usedKeys.add(k);
                }
            }
        }
        List<Map<String, Object>> result = new ArrayList<>();
        if (!llmClient.isMock()) {
            // 最多两轮 LLM：首轮全量生成，清洗后按题型消化；仍有缺口则按缺口题型补一轮
            for (int round = 1; round <= 2 && !pending.isEmpty(); round++) {
                List<String> seq = expandPending(pending);
                try {
                    List<Map<String, Object>> qs = llmGenerate(kps, existing, seq, usedKeys);
                    for (Map<String, Object> q : qs) {
                        String t = String.valueOf(q.get("type"));
                        Integer left = pending.get(t);
                        if (left != null && left > 0) {
                            pending.put(t, left - 1);
                            result.add(q);
                        }
                    }
                } catch (Exception e) {
                    log.warn("AI 出题第 {} 轮生成失败：{}", round, e.getMessage());
                    break;
                }
            }
        }
        // 剩余缺口：本地模板逐题补齐（保证数量与题型严格匹配用户指定）
        int seqNo = result.size();
        for (Map.Entry<String, Integer> e : pending.entrySet()) {
            for (int i = 0; i < e.getValue(); i++) {
                result.add(mockQuestion(kps, e.getKey(), usedKeys, ++seqNo));
            }
            if (e.getValue() > 0) {
                log.info("AI 出题题型 {} 缺口 {} 道，已用本地模板补齐", e.getKey(), e.getValue());
            }
        }
        return result;
    }

    /** 展开待生成槽位为题型序列 */
    private List<String> expandPending(LinkedHashMap<String, Integer> pending) {
        List<String> seq = new ArrayList<>();
        for (Map.Entry<String, Integer> e : pending.entrySet()) {
            for (int i = 0; i < e.getValue(); i++) {
                seq.add(e.getKey());
            }
        }
        return seq;
    }

    /** 清洗题型范围：仅保留合法题型并去重 */
    private List<String> sanitizeTypes(List<String> types) {
        if (types == null || types.isEmpty()) {
            return List.of();
        }
        List<String> out = new ArrayList<>();
        for (String t : types) {
            if (ALL_TYPES.contains(t) && !out.contains(t)) {
                out.add(t);
            }
        }
        return out;
    }

    /** 题干规范化：去空白与标点后小写比较，用于批次内 / 与已有题目的去重判断 */
    private String normTitle(String title) {
        if (title == null) {
            return "";
        }
        return title.toLowerCase(Locale.ROOT)
                .replaceAll("\\s+", "")
                .replaceAll("[\\p{Punct}\\p{IsPunctuation}，。、；：？！“”‘’（）《》…—·]", "");
    }

    /** DeepSeek 生成：题型序列硬指令（数量与题型完全等于教师指定的空白题序列）+ 去重 + 选项质量要求 */
    private List<Map<String, Object>> llmGenerate(List<KnowledgePoint> kps, List<Map<String, Object>> existing,
                                                  List<String> seq, Set<String> usedKeys) {
        StringBuilder kpLine = new StringBuilder();
        for (KnowledgePoint k : kps) {
            kpLine.append(k.getKpCode()).append("（").append(k.getName()).append("），");
        }
        StringBuilder existLine = new StringBuilder();
        if (existing != null && !existing.isEmpty()) {
            existLine.append("已添加的题目（出题风格与难度参考，严禁重复其内容）：");
            for (Map<String, Object> q : existing) {
                existLine.append('[').append(q.get("type")).append("] ").append(q.get("title")).append("；");
            }
        } else {
            existLine.append("暂无已有题目");
        }
        // 题型硬指令：生成数量与题型序列完全等于教师指定的空白题序列
        StringBuilder typeLine = new StringBuilder("必须恰好生成 ").append(seq.size()).append(" 道题，type 必须依次为：");
        for (String t : seq) {
            typeLine.append(t).append("、");
        }
        typeLine.append("不得多生成、不得少生成、不得改变题型顺序与类型。\n");
        List<String> allowedTypes = seq.stream().distinct().toList();
        String system = "你是面向大学软件工程专业的 Java 教学出题专家。根据给定的知识点和已有题目参考，生成考查严谨、表述无歧义的 Java 作业题。\n"
                + typeLine + "\n"
                + "命题范围硬约束（最高优先级，必须严格遵守）：\n"
                + "本次命题范围严格限定为「知识点」列表中给定的知识点（即当前课程已教授的教学进度范围）。"
                + "题目各部分内容（题干、选项、参考答案、答案解析、编程题代码）只允许考查这些给定知识点及其前置基础语法"
                + "（变量与基本数据类型、运算符与表达式、选择/循环/跳转结构、方法定义与调用、数组、字符串基础操作、标准输出）；"
                + "严禁引入给定列表之外的、后续章节才会教授的未学知识点、类库或语法特性"
                + "（例如：仅关联了数组相关知识点时，不得考查集合框架、泛型、Lambda、Stream、多线程、IO 等后续内容；编程题代码同样只能使用给定知识点与上述前置基础语法）。\n"
                + "\n"
                + "出题质量要求：\n"
                + "1. 每题必须紧扣所关联知识点的本科教学考察要求，题干表述严谨、无歧义，不出现超纲或过于生僻的内容；\n"
                + "2. 题干排版规范：题干包含多点要求（如 1)、2)、3) 各点）时，每个要点必须单独成行——要点之间用换行符（\\n）分隔，严禁多个要点在同一行连续排列；无多点要求的普通题干保持单行即可；\n"
                + "3. 单选/多选题必须提供 4 个选项：四个选项须围绕同一考察点、长度与句式相近，干扰项应基于学生常见错误概念设计、具备迷惑性；严禁出现与考察点无关、长度悬殊或明显荒谬的选项；正确答案的位置随机分布；\n"
                + "4. 判断题须是容易因概念混淆而出错、但答案明确的陈述；\n"
                + "5. 同一批次内题目互不重复，也不得重复已有题目，考点尽量覆盖不同知识点（如有多个）；\n"
                + "6. answer 与 analysis 必须准确无误，analysis 说明正确原因与学生易错点；编程题 answer 必须是完整可直接编译运行的 Java 示例代码（含逐行注释说明解题思路，public 类名为 Main）。\n"
                + "严格只输出一个 JSON 数组，不要输出任何其他文字或代码块标记。每个元素字段：\n"
                + "type：SINGLE（单选）/MULTI（多选）/FILL（填空）/JUDGE（判断）/SHORT（简答）/CODE（编程）之一；\n"
                + "title：题干字符串；\n"
                + "options：仅单选/多选提供，4 个元素的数组 [{\"key\":\"A\",\"text\":\"...\"},...]，text 不为空；\n"
                + "answer：单选 [\"A\"]、多选 [\"A\",\"B\"]、判断 [true 或 false]、填空/简答 [\"参考答案文本\"]、编程 [\"完整可运行的 Java 示例代码（含注释）\"]；\n"
                + "difficulty：0.8 或 0.5 或 0.2；\n"
                + "kpCodes：本题实际考查的全部知识点编码组成的数组（可包含多个，必须全部来自给定知识点列表，按考查侧重程度排序，至少 1 个）；\n"
                + "analysis：答案解析字符串。";
        String user = "知识点：" + kpLine + "\n" + existLine;
        String content = llmClient.chat(List.of(ChatMessage.system(system), ChatMessage.user(user)), 0.7);
        return parseQuestions(content, kps, allowedTypes, usedKeys);
    }

    /**
     * 解析并清洗模型输出（容错：剥离代码块围栏、截取首个 JSON 数组）。
     * 硬校验：题型白名单、批内去重、与已有题去重、选择题选项数量/重复/答案合法性。
     */
    private List<Map<String, Object>> parseQuestions(String content, List<KnowledgePoint> kps,
                                                     List<String> allowedTypes, Set<String> existKeys) {
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
            List<String> kpIds = kps.stream().map(KnowledgePoint::getKpCode).toList();
            Set<String> batchKeys = new HashSet<>(existKeys);
            int typeFiltered = 0, dupFiltered = 0, optFiltered = 0;
            for (JsonNode q : arr) {
                String type = q.path("type").asText("");
                if (!allowedTypes.contains(type)) {
                    typeFiltered++;
                    continue;
                }
                String title = q.path("title").asText("").trim();
                if (title.isEmpty()) {
                    continue;
                }
                // 批内 / 已有题目去重
                String key = normTitle(title);
                if (key.length() < 2 || batchKeys.contains(key)) {
                    dupFiltered++;
                    continue;
                }
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("type", type);
                m.put("title", title);
                if ("SINGLE".equals(type) || "MULTI".equals(type)) {
                    List<Map<String, Object>> opts = new ArrayList<>();
                    Set<String> optKeys = new HashSet<>();
                    if (q.path("options").isArray()) {
                        for (JsonNode o : q.path("options")) {
                            String t = o.path("text").asText("").trim();
                            String normOpt = normTitle(t);
                            if (!t.isEmpty() && !optKeys.contains(normOpt)) {
                                optKeys.add(normOpt);
                                Map<String, Object> om = new LinkedHashMap<>();
                                om.put("key", String.valueOf((char) ('A' + opts.size())));
                                om.put("text", t);
                                opts.add(om);
                            }
                        }
                    }
                    List<Object> ans = new ArrayList<>();
                    if (q.path("answer").isArray()) {
                        q.path("answer").forEach(a -> ans.add(a.isBoolean() ? a.asBoolean() : a.asText()));
                    }
                    // 选项质量硬校验：必须 4 个选项（去重后），答案 key 必须合法
                    if (opts.size() != 4 || ans.isEmpty()) {
                        optFiltered++;
                        continue;
                    }
                    boolean ansOk = true;
                    for (Object a : ans) {
                        boolean hit = opts.stream().anyMatch(o -> String.valueOf(a).equals(o.get("key")));
                        if (!hit) { ansOk = false; break; }
                    }
                    if (!ansOk) {
                        optFiltered++;
                        continue;
                    }
                    m.put("options", opts);
                    m.put("answer", ans);
                    // 答案随机化：打乱选项并重映射 key，消除模型输出中正确答案位置聚集的偏差
                    randomizeOptions(m);
                } else if ("JUDGE".equals(type)) {
                    boolean ans = false;
                    if (q.path("answer").isArray() && !q.path("answer").isEmpty()) {
                        JsonNode a = q.path("answer").get(0);
                        ans = a.isBoolean() ? a.asBoolean() : "true".equalsIgnoreCase(a.asText());
                    }
                    m.put("answer", List.of(ans));
                } else {
                    List<Object> ans = new ArrayList<>();
                    if (q.path("answer").isArray() && !q.path("answer").isEmpty()) {
                        ans.add(q.path("answer").get(0).asText());
                    }
                    if (ans.isEmpty()) {
                        continue;
                    }
                    m.put("answer", ans);
                }
                double diff = 0.5;
                try { diff = q.path("difficulty").asDouble(0.5); } catch (Exception ignore) { }
                m.put("difficulty", diff);
                // 知识点标签：完整提取模型返回的全部关联知识点（kpCodes 数组，兼容旧版单值 kpCode），
                // 解析层白名单过滤——严禁出现教师给定范围（已教授知识点）之外的编码
                List<String> kpList = new ArrayList<>();
                if (q.path("kpCodes").isArray()) {
                    for (JsonNode k : q.path("kpCodes")) {
                        String kc = k.asText("");
                        if (kpIds.contains(kc) && !kpList.contains(kc)) {
                            kpList.add(kc);
                        }
                    }
                }
                String kpSingle = q.path("kpCode").asText("");
                if (kpList.isEmpty() && kpIds.contains(kpSingle)) {
                    kpList.add(kpSingle);
                }
                if (kpList.isEmpty()) {
                    kpList.add(kpIds.get(0));
                }
                m.put("kpCodes", kpList);
                m.put("kpCode", kpList.get(0));
                m.put("analysis", q.path("analysis").asText(""));
                batchKeys.add(key);
                result.add(m);
            }
            if (typeFiltered + dupFiltered + optFiltered > 0) {
                log.info("AI 出题清洗：保留 {} 道，过滤 题型越界 {} / 重复 {} / 选项或答案不合格 {}",
                        result.size(), typeFiltered, dupFiltered, optFiltered);
            }
        } catch (Exception ex) {
            log.warn("AI 出题 JSON 解析失败：{}", ex.getMessage());
        }
        return result;
    }

    /** 本地模板单题生成（DeepSeek 未配置 / 调用失败 / 清洗后缺口的兜底补齐）：
        按指定题型生成一道题，字段完整，题干带序号参与批内去重 */
    private Map<String, Object> mockQuestion(List<KnowledgePoint> kps, String type, Set<String> usedKeys, int seqNo) {
        KnowledgePoint k = kps.get(seqNo % kps.size());
        String seq = "（" + seqNo + "）";
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", type);
        m.put("kpCodes", List.of(k.getKpCode()));
        m.put("kpCode", k.getKpCode());
        m.put("difficulty", new String[]{"0.8", "0.5", "0.2"}[seqNo % 3]);
        m.put("analysis", "本题考查「" + k.getName() + "」的核心概念" + seq + "。解析：结合定义与典型场景判断，注意区分相近概念，避免被表面措辞干扰。");
        switch (type) {
            case "SINGLE", "MULTI" -> {
                m.put("title", "关于「" + k.getName() + "」，下列说法" + seq + ("MULTI".equals(type) ? "正确的有" : "正确的是") + "（　）。");
                m.put("options", List.of(
                        Map.of("key", "A", "text", "它是 Java 语言中需要重点掌握的核心概念之一"),
                        Map.of("key", "B", "text", "它仅在编译阶段生效，运行期完全无效"),
                        Map.of("key", "C", "text", "它只能用于基本数据类型，不能用于引用类型"),
                        Map.of("key", "D", "text", "它与其他知识点没有任何关联，孤立存在")));
                m.put("answer", "MULTI".equals(type) ? List.of("A", "D") : List.of("A"));
                // 答案随机化：选项打乱 + key 重映射，正确位置均匀分布（修复恒为 A / AD 的固定模式）
                randomizeOptions(m);
            }
            case "JUDGE" -> {
                m.put("title", "理解并正确运用「" + k.getName() + "」是编写规范 Java 程序的前提" + seq + "。");
                m.put("answer", List.of(true));
            }
            case "SHORT" -> {
                m.put("title", "请简述「" + k.getName() + "」的核心概念及其一个典型应用场景" + seq + "。");
                m.put("answer", List.of("概念定义 + 应用场景说明（示例参考答案）"));
            }
            case "CODE" -> {
                m.put("title", "编写一段代码演示「" + k.getName() + "」的基本用法" + seq + "。");
                // 参考答案为按知识点主题匹配、可直接编译运行的完整示例代码（含注释）
                m.put("answer", List.of(codeDemo(k.getName())));
            }
            default -> {
                m.put("title", "请简述「" + k.getName() + "」的一个典型应用场景" + seq + "，并填写其核心要点：____。");
                m.put("answer", List.of("要点与定义相关，言之有理即可（示例参考答案）"));
            }
        }
        usedKeys.add(normTitle(String.valueOf(m.get("title"))));
        return m;
    }

    /**
     * 选择题答案随机化：随机打乱选项顺序并按新位置重映射答案 key。
     * 对 LLM 路径与本地模板路径统一生效——无论生成源是否存在答案位置偏差
     * （如恒为 A / AD），最终正确答案都均匀分布在各选项位置，保证不可预测性。
     * 前置条件：options 文本互不重复且 answer key 均合法（上游已硬校验）。
     */
    @SuppressWarnings("unchecked")
    private void randomizeOptions(Map<String, Object> q) {
        List<Object> options = (List<Object>) q.get("options");
        List<Object> answers = (List<Object>) q.get("answer");
        if (options == null || answers == null || options.size() < 2 || answers.isEmpty()) {
            return;
        }
        // 记录正确选项的文本集合（文本互不重复，可安全作为映射依据）
        Set<String> correctTexts = new HashSet<>();
        for (Object a : answers) {
            for (Object o : options) {
                Map<String, Object> om = (Map<String, Object>) o;
                if (String.valueOf(a).equals(String.valueOf(om.get("key")))) {
                    correctTexts.add(String.valueOf(om.get("text")));
                }
            }
        }
        if (correctTexts.size() != answers.size()) {
            return; // 防御：文本映射不完整时保持原样
        }
        // 随机打乱选项并按新顺序重排 key（A、B、C、D...）
        List<Object> shuffled = new ArrayList<>(options);
        Collections.shuffle(shuffled, ThreadLocalRandom.current());
        List<String> newAnswers = new ArrayList<>();
        for (int i = 0; i < shuffled.size(); i++) {
            Map<String, Object> om = new LinkedHashMap<>((Map<String, Object>) shuffled.get(i));
            String key = String.valueOf((char) ('A' + i));
            om.put("key", key);
            shuffled.set(i, om);
            if (correctTexts.contains(String.valueOf(om.get("text")))) {
                newAnswers.add(key);
            }
        }
        Collections.sort(newAnswers); // 答案 key 按字母序展示（如 ["A","C"]）
        q.put("options", shuffled);
        q.put("answer", newAnswers);
    }

    /**
     * 编程题参考答案：按知识点名称主题匹配生成可直接编译运行的完整 Java 示例代码（含注释）。
     * 覆盖五大模块常见主题（语法/面向对象/集合/异常/持久化分层），未命中主题时回退通用示例。
     */
    private String codeDemo(String kpName) {
        String n = kpName == null ? "" : kpName.toLowerCase(Locale.ROOT);
        if (containsAny(n, "整型", "整数", "int", "long", "byte", "short", "浮点", "double", "float",
                "数据类型", "类型转换", "boolean", "布尔", "char", "字符")) {
            return """
                    public class Main {
                        public static void main(String[] args) {
                            // 基本数据类型取值范围：byte/short/int/long 依次为 8/16/32/64 位
                            System.out.println("int 最大值 = " + Integer.MAX_VALUE);  // 2147483647（2^31-1）
                            System.out.println("int 最小值 = " + Integer.MIN_VALUE);  // -2147483648（-2^31）
                            System.out.println("long 最大值 = " + Long.MAX_VALUE);    // 64 位整型
                            // 溢出演示：最大值 +1 会回绕到最小值（编译/运行均不报错）
                            int overflow = Integer.MAX_VALUE + 1;
                            System.out.println("int 最大值 + 1 = " + overflow);
                            // 超出 int 范围的字面量必须加 L 后缀
                            long big = 2200000000L;
                            System.out.println("用 long 表示的超大数 = " + big);
                        }
                    }""";
        }
        if (containsAny(n, "变量", "赋值", "作用域")) {
            return """
                    public class Main {
                        static int member = 10; // 成员变量：属于类，整个类内可见
                        public static void main(String[] args) {
                            int local = 5; // 局部变量：方法内定义，仅在本方法内可见
                            System.out.println("成员变量 member = " + member);
                            System.out.println("局部变量 local = " + local);
                            local = local * 2; // 重新赋值
                            System.out.println("重新赋值后 local = " + local);
                            if (local > 5) {
                                int blockVar = 100; // 块级作用域：仅在该 if 块内有效
                                System.out.println("块内变量 blockVar = " + blockVar);
                            }
                            // System.out.println(blockVar); // 取消注释会编译报错：变量已超出作用域
                        }
                    }""";
        }
        if (containsAny(n, "运算符", "算术", "表达式")) {
            return """
                    public class Main {
                        public static void main(String[] args) {
                            int a = 7, b = 3;
                            System.out.println("a + b = " + (a + b)); // 10：加
                            System.out.println("a - b = " + (a - b)); // 4：减
                            System.out.println("a * b = " + (a * b)); // 21：乘
                            System.out.println("a / b = " + (a / b)); // 2：整数相除舍弃小数部分
                            System.out.println("a % b = " + (a % b)); // 1：取余
                            b += a; // 复合赋值：等价于 b = b + a
                            System.out.println("b += a 后 b = " + b);
                            System.out.println("a++ = " + (a++)); // 后自增：先取原值参与运算再 +1
                            System.out.println("a 最终 = " + a);  // 8
                        }
                    }""";
        }
        if (containsAny(n, "if", "else", "条件", "分支", "switch")) {
            return """
                    public class Main {
                        public static void main(String[] args) {
                            int score = 76;
                            // if ... else if ... else：自上而下依次判断，命中即终止
                            if (score >= 90) {
                                System.out.println("优秀");
                            } else if (score >= 60) {
                                System.out.println("及格");
                            } else {
                                System.out.println("不及格");
                            }
                            // switch：多值匹配场景更简洁（箭头语法无需 break）
                            switch (score / 10) {
                                case 10, 9 -> System.out.println("等级 A");
                                case 8, 7 -> System.out.println("等级 B");
                                default -> System.out.println("等级 C");
                            }
                        }
                    }""";
        }
        if (containsAny(n, "循环", "for", "while", "do")) {
            return """
                    public class Main {
                        public static void main(String[] args) {
                            int sum = 0;
                            for (int i = 1; i <= 100; i++) sum += i; // for：已知重复次数
                            System.out.println("1~100 求和 = " + sum);
                            int n = 1;
                            while (n < 1000) n *= 2; // while：条件满足就继续执行
                            System.out.println("第一个 >= 1000 的 2 的幂 = " + n);
                            int k = 0;
                            do { k++; } while (k < 3); // do-while：循环体至少执行一次
                            System.out.println("do-while 执行后 k = " + k);
                        }
                    }""";
        }
        if (containsAny(n, "数组")) {
            return """
                    public class Main {
                        public static void main(String[] args) {
                            int[] arr = {5, 3, 9, 1, 7}; // 静态初始化
                            int total = 0;
                            for (int x : arr) total += x; // 增强 for 遍历
                            System.out.println("总和 = " + total + "，长度 = " + arr.length);
                            java.util.Arrays.sort(arr); // 升序排序
                            System.out.println("排序后首元素 = " + arr[0] + "，末元素 = " + arr[arr.length - 1]);
                            int[] dyn = new int[3]; // 动态初始化：元素默认值 0
                            dyn[2] = 99; // 下标从 0 开始
                            System.out.println("动态数组末位 = " + dyn[2]);
                        }
                    }""";
        }
        if (containsAny(n, "string", "字符串")) {
            return """
                    public class Main {
                        public static void main(String[] args) {
                            String s = "Hello, Java";
                            System.out.println("长度 = " + s.length());
                            System.out.println("大写 = " + s.toUpperCase());
                            System.out.println("替换 = " + s.replace("Java", "World"));
                            System.out.println("包含 Java? " + s.contains("Java"));
                            // String 不可变：每次拼接都产生新对象；频繁拼接建议用 StringBuilder
                            StringBuilder sb = new StringBuilder();
                            for (int i = 1; i <= 3; i++) sb.append(i).append(",");
                            System.out.println("StringBuilder 拼接 = " + sb);
                        }
                    }""";
        }
        if (containsAny(n, "封装", "getter", "setter", "类与对象", "对象", "成员")) {
            return """
                    public class Main {
                        // 封装：字段私有化，通过公有方法访问，隐藏内部实现细节
                        static class Student {
                            private String name; // 私有字段：外界不能直接访问
                            Student(String name) { this.name = name; }
                            public String getName() { return name; }             // 读访问器
                            public void setName(String name) { this.name = name; } // 写访问器
                        }
                        public static void main(String[] args) {
                            Student s = new Student("张三"); // new 创建对象实例
                            System.out.println("姓名 = " + s.getName());
                            s.setName("李四"); // 通过公有方法修改状态
                            System.out.println("改名后 = " + s.getName());
                        }
                    }""";
        }
        if (containsAny(n, "构造方法", "构造器")) {
            return """
                    public class Main {
                        static class Book {
                            String title;
                            Book() { this("未命名"); }      // 无参构造：this(...) 复用另一构造
                            Book(String title) { this.title = title; } // 有参构造：重载
                        }
                        public static void main(String[] args) {
                            Book b1 = new Book("Java 核心技术"); // 匹配有参构造
                            Book b2 = new Book();                 // 匹配无参构造
                            System.out.println(b1.title);
                            System.out.println(b2.title);
                        }
                    }""";
        }
        if (containsAny(n, "多态")) {
            return """
                    public class Main {
                        static class Shape { double area() { return 0; } }
                        static class Circle extends Shape {
                            double r;
                            Circle(double r) { this.r = r; }
                            @Override double area() { return Math.PI * r * r; }
                        }
                        static class Rect extends Shape {
                            double w, h;
                            Rect(double w, double h) { this.w = w; this.h = h; }
                            @Override double area() { return w * h; }
                        }
                        public static void main(String[] args) {
                            // 多态：父类引用指向子类对象，同一调用产生不同行为
                            Shape[] shapes = { new Circle(2), new Rect(3, 4) };
                            for (Shape s : shapes) System.out.println("面积 = " + s.area());
                        }
                    }""";
        }
        if (containsAny(n, "接口", "interface", "implements")) {
            return """
                    public class Main {
                        interface Flyable { void fly(); } // 接口：定义行为契约
                        static class Bird implements Flyable {
                            @Override public void fly() { System.out.println("鸟用翅膀飞"); }
                        }
                        public static void main(String[] args) {
                            Flyable f = new Bird(); // 面向接口编程
                            f.fly();
                        }
                    }""";
        }
        if (containsAny(n, "抽象", "abstract")) {
            return """
                    public class Main {
                        abstract static class Shape {
                            abstract double area(); // 抽象方法：子类必须实现
                            void print() { System.out.println("面积 = " + area()); } // 模板方法复用
                        }
                        static class Square extends Shape {
                            double side;
                            Square(double side) { this.side = side; }
                            @Override double area() { return side * side; }
                        }
                        public static void main(String[] args) {
                            new Square(5).print(); // 输出：面积 = 25.0
                        }
                    }""";
        }
        if (containsAny(n, "继承", "extends", "super")) {
            return """
                    public class Main {
                        static class Animal {
                            void speak() { System.out.println("动物发出声音"); }
                        }
                        static class Dog extends Animal { // extends 实现继承
                            @Override
                            void speak() { System.out.println("汪汪"); } // 方法重写
                        }
                        public static void main(String[] args) {
                            Animal a = new Dog(); // 向上转型
                            a.speak();            // 动态绑定到 Dog 的实现
                        }
                    }""";
        }
        if (containsAny(n, "静态", "static")) {
            return """
                    public class Main {
                        static int count = 0;           // 静态字段：全类共享一份
                        static final double PI = 3.14;  // 常量：static final 修饰
                        Main() { count++; }             // 每创建一个对象 count +1
                        static void printCount() {      // 静态方法：随类加载，无需对象即可调用
                            System.out.println("已创建对象数 = " + count);
                        }
                        public static void main(String[] args) {
                            new Main(); new Main(); new Main();
                            Main.printCount(); // 输出 3
                            System.out.println("PI = " + PI);
                        }
                    }""";
        }
        if (containsAny(n, "重载", "overload")) {
            return """
                    public class Main {
                        static int add(int a, int b) { return a + b; }         // 同名不同参数列表 → 重载
                        static double add(double a, double b) { return a + b; }
                        static int add(int a, int b, int c) { return a + b + c; }
                        public static void main(String[] args) {
                            System.out.println(add(1, 2));     // 3：匹配 int 版本
                            System.out.println(add(1.5, 2.5)); // 4.0：匹配 double 版本
                            System.out.println(add(1, 2, 3));  // 6：匹配三参版本
                        }
                    }""";
        }
        if (containsAny(n, "重写", "override")) {
            return """
                    public class Main {
                        static class Father {
                            void greet() { System.out.println("父类的问候"); }
                        }
                        static class Son extends Father {
                            @Override // 重写：方法签名与父类一致，实现按子类
                            void greet() { System.out.println("子类重写后的问候"); }
                        }
                        public static void main(String[] args) {
                            new Son().greet();
                        }
                    }""";
        }
        if (containsAny(n, "枚举", "enum")) {
            return """
                    public class Main {
                        enum Season { SPRING, SUMMER, AUTUMN, WINTER } // 枚举：有限常量集合
                        public static void main(String[] args) {
                            Season s = Season.SUMMER;
                            System.out.println("当前季节 = " + s);
                            for (Season x : Season.values()) { // values() 遍历所有常量
                                System.out.println(x + " 序号 " + x.ordinal());
                            }
                            switch (s) {
                                case SUMMER -> System.out.println("炎热");
                                default -> System.out.println("其他季节");
                            }
                        }
                    }""";
        }
        if (containsAny(n, "内部类", "inner")) {
            return """
                    public class Main {
                        private static String msg = "外部类字段";
                        static class Inner { // 静态内部类
                            void show() { System.out.println("访问 " + msg); }
                        }
                        public static void main(String[] args) {
                            new Main.Inner().show(); // 创建并调用内部类实例
                        }
                    }""";
        }
        if (containsAny(n, "泛型", "generic")) {
            return """
                    import java.util.ArrayList;
                    import java.util.List;

                    public class Main {
                        // 泛型方法：类型参数 T 由调用方指定，编译期保证类型安全
                        static <T> T first(List<T> list) { return list.get(0); }
                        public static void main(String[] args) {
                            List<String> names = new ArrayList<>(); // 只能存放 String
                            names.add("张三");
                            String n = first(names); // 无需强制类型转换
                            System.out.println("第一个元素 = " + n);
                            // names.add(123); // 取消注释会编译报错：泛型在编译期拦截类型错误
                        }
                    }""";
        }
        if (containsAny(n, "stream")) {
            return """
                    import java.util.List;

                    public class Main {
                        public static void main(String[] args) {
                            List<Integer> nums = List.of(5, 3, 8, 1, 9, 2);
                            // 链式流水线：过滤奇数 → 排序 → 求和
                            int sum = nums.stream()
                                    .filter(x -> x % 2 == 1)
                                    .sorted()
                                    .mapToInt(Integer::intValue)
                                    .sum();
                            System.out.println("奇数排序求和 = " + sum); // 5+3+1+9 = 18
                            nums.stream().filter(x -> x > 4)
                                    .forEach(x -> System.out.print(x + " ")); // 5 8 9
                            System.out.println();
                        }
                    }""";
        }
        if (containsAny(n, "list", "arraylist", "集合")) {
            return """
                    import java.util.ArrayList;
                    import java.util.List;

                    public class Main {
                        public static void main(String[] args) {
                            List<String> list = new ArrayList<>(); // List：有序、可重复
                            list.add("Java");
                            list.add("Python");
                            list.add("Java"); // 允许重复元素
                            System.out.println("大小 = " + list.size());
                            System.out.println("第 1 个 = " + list.get(0));
                            list.remove("Python"); // 按内容删除首个匹配
                            System.out.println("遍历 = " + list);
                            System.out.println("包含 Java? " + list.contains("Java"));
                        }
                    }""";
        }
        if (containsAny(n, "map", "hashmap")) {
            return """
                    import java.util.HashMap;
                    import java.util.Map;

                    public class Main {
                        public static void main(String[] args) {
                            Map<String, Integer> scores = new HashMap<>(); // key-value 映射
                            scores.put("张三", 92);
                            scores.put("李四", 85);
                            scores.put("张三", 95); // 重复 key 会覆盖旧值
                            System.out.println("张三成绩 = " + scores.get("张三")); // 95
                            System.out.println("条目数 = " + scores.size());
                            for (Map.Entry<String, Integer> e : scores.entrySet()) { // 遍历
                                System.out.println(e.getKey() + " -> " + e.getValue());
                            }
                        }
                    }""";
        }
        if (containsAny(n, "set", "hashset")) {
            return """
                    import java.util.HashSet;
                    import java.util.Set;

                    public class Main {
                        public static void main(String[] args) {
                            Set<String> set = new HashSet<>(); // Set：不重复、无序
                            set.add("Java");
                            set.add("Python");
                            boolean added = set.add("Java"); // 重复元素添加失败
                            System.out.println("第二次添加 Java 成功? " + added); // false
                            System.out.println("元素个数 = " + set.size());       // 2
                            System.out.println("包含 Python? " + set.contains("Python"));
                        }
                    }""";
        }
        if (containsAny(n, "异常", "try", "throw", "捕获")) {
            return """
                    public class Main {
                        public static void main(String[] args) {
                            try {
                                int r = divide(10, 0); // 可能抛出异常的代码
                                System.out.println(r);
                            } catch (ArithmeticException e) { // 捕获并处理
                                System.out.println("捕获异常: " + e.getMessage());
                            } finally {
                                System.out.println("finally 总会执行（常用于释放资源）");
                            }
                        }
                        static int divide(int a, int b) {
                            if (b == 0) throw new ArithmeticException("除数不能为 0"); // 主动抛出
                            return a / b;
                        }
                    }""";
        }
        if (containsAny(n, "jdbc", "数据库", "sql", "持久化", "事务", "连接池", "dao", "dao层")) {
            return """
                    import java.util.ArrayList;
                    import java.util.List;

                    public class Main {
                        // 演示持久化分层思想：真实项目中 DAO 层通过 JDBC + 连接池访问数据库；
                        // 此处用内存集合模拟数据源，保证示例代码可直接编译运行
                        static class StudentDao {
                            private final List<String> data = new ArrayList<>(List.of("张三", "李四"));
                            public List<String> findAll() { return data; }              // 对应 SELECT
                            public void insert(String name) { data.add(name); }         // 对应 INSERT
                            public boolean delete(String name) { return data.remove(name); } // 对应 DELETE
                        }
                        public static void main(String[] args) {
                            StudentDao dao = new StudentDao();
                            dao.insert("王五");
                            System.out.println("全部学生 = " + dao.findAll());
                            System.out.println("删除王五 = " + dao.delete("王五"));
                            System.out.println("删除后 = " + dao.findAll());
                        }
                    }""";
        }
        // 通用回退：可运行的最小示例框架，围绕知识点定位与验证思路展开
        return """
                public class Main {
                    public static void main(String[] args) {
                        System.out.println("== 「%s」知识点用法演示 ==");
                        // 1) 概念定位：结合课程讲义明确该知识点的定义与适用场景
                        // 2) 基本用法：按语法规范在具体场景中正确使用（此处可展开具体代码）
                        String demo = "结合课程示例理解「%s」的定义与用法";
                        System.out.println(demo);
                        // 3) 验证思路：编写小段代码观察输出，与预期结果对照
                        System.out.println("示例代码可直接编译运行");
                    }
                }""".formatted(kpName, kpName);
    }

    private boolean containsAny(String text, String... words) {
        for (String w : words) {
            if (text.contains(w)) {
                return true;
            }
        }
        return false;
    }
}
