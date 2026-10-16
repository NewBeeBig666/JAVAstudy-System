package com.la.ai;

import lombok.extern.slf4j.Slf4j;
import reactor.core.publisher.Flux;

import java.util.List;
import java.util.concurrent.ThreadLocalRandom;

/**
 * Mock LLM 客户端：无 API Key / 离线演示时的降级实现。
 * 移植 demo 的规则化回复，保证核心流程可走通。
 */
@Slf4j
public class MockDeepSeekClient implements LlmClient {

    @Override
    public String chat(List<ChatMessage> messages, double temperature) {
        String lastUser = null;
        String system = null;
        for (int i = messages.size() - 1; i >= 0; i--) {
            if ("user".equals(messages.get(i).getRole()) && lastUser == null) {
                lastUser = messages.get(i).getContent();
            }
            if ("system".equals(messages.get(i).getRole()) && system == null) {
                system = messages.get(i).getContent();
            }
        }
        // 批改任务：返回合法 JSON（模拟 Temperature=0 的初评输出）
        if (system != null && system.contains("只输出严格的 JSON") && lastUser != null
                && lastUser.contains("Rubric 评分标准")) {
            return mockGradeJson(lastUser);
        }
        // 题目型作业逐题评审（简答题语义评分 / 编程题多维度评审）：按满分生成模拟评分与依据
        if (system != null && system.contains("只输出严格的 JSON") && lastUser != null
                && (lastUser.contains("待评分的简答题") || lastUser.contains("待评审的编程题"))) {
            return mockPerQuestionJson(lastUser, lastUser.contains("待评审的编程题"));
        }
        // 学情报告任务：生成结构化分析
        if (system != null && system.contains("学情") && lastUser != null
                && lastUser.contains("班级学情数据")) {
            return mockInsight(lastUser);
        }
        return ruleReply(lastUser);
    }

    /**
     * 模拟学情 Agent 报告
     */
    private String mockInsight(String data) {
        return "## 班级学情分析报告（离线演示模式）\n\n"
                + "### 总体概况\n"
                + "基于当前班级数据，整体掌握度处于中等水平，作业提交率有提升空间。\n\n"
                + "### 共性问题\n"
                + "- **面向对象高阶模块**（封装性、接口、多态）平均掌握度集中在 55 分左右，卡点率接近 60%，是当前最集中的薄弱区；\n"
                + "- 上游的「类与对象基础」掌握尚可，说明问题主要出在**继承与多态的概念辨析**，而非基础语法；\n"
                + "- 提交行为方面存在少量非正常时段提交与相似度偏高的情况，建议关注。\n\n"
                + "### 教学建议\n"
                + "1. 下节课用 15 分钟复盘「方法重写 vs 方法重载」与「向上/向下转型」，配合多态喂食案例做现场演示；\n"
                + "2. 把作业拆成「先写单类正确版，再抽象接口改造」两步，降低一次性认知负荷；\n"
                + "3. 对高风险学生单独推送针对性复习包，3 天后复查活跃度。\n\n"
                + "> 配置 DEEPSEEK_API_KEY 后，本报告将由学情Agent 基于真实数据智能生成。";
    }

    /**
     * 从批改 Prompt 中解析 Rubric 维度，生成模拟评分 JSON
     */
    private String mockGradeJson(String prompt) {
        java.util.List<String[]> rubrics = new java.util.ArrayList<>();
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("- (.+?)（满分 (\\d+)）：").matcher(prompt);
        int totalMax = 0;
        while (m.find()) {
            rubrics.add(new String[]{m.group(1), m.group(2)});
            totalMax += Integer.parseInt(m.group(2));
        }
        if (rubrics.isEmpty()) {
            return "{\"rubricScores\":{},\"aiScore\":0,\"comment\":\"Mock 初评：未解析到 Rubric。\"}";
        }
        StringBuilder sb = new StringBuilder("{\"rubricScores\":{");
        int total = 0;
        for (int i = 0; i < rubrics.size(); i++) {
            String name = rubrics.get(i)[0];
            int max = Integer.parseInt(rubrics.get(i)[1]);
            int score = (int) Math.round(max * (0.72 + (i % 3) * 0.04));
            total += score;
            if (i > 0) {
                sb.append(',');
            }
            sb.append('\"').append(name).append("\":").append(score);
        }
        sb.append("},\"aiScore\":").append(total)
                .append(",\"comment\":\"Mock 初评：整体结构清晰，核心逻辑基本正确（").append(total)
                .append('/').append(totalMax).append("）。建议关注边界条件与资源管理。\"}");
        return sb.toString();
    }

    /**
     * 题目型作业逐题评审 Mock：解析 Prompt 中的「### 第 N 题（满分 X 分）」，
     * 生成模拟得分与一句话评分依据。作答内容过短或未作答记 0 分（贴近真实 AI 行为）；
     * 有效作答按口径给分：简答 80%（核心表意一致）、编程 90%（语法正确、核心功能完整）。
     */
    private String mockPerQuestionJson(String prompt, boolean isCode) {
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("### 第 (\\d+) 题（满分 ([\\d.]+) 分）").matcher(prompt);
        java.util.List<int[]> marks = new java.util.ArrayList<>(); // {题号, 块起始, 块头结束}
        java.util.List<Double> maxs = new java.util.ArrayList<>();
        while (m.find()) {
            marks.add(new int[]{Integer.parseInt(m.group(1)), m.start(), m.end()});
            maxs.add(Double.parseDouble(m.group(2)));
        }
        StringBuilder scores = new StringBuilder();
        StringBuilder comments = new StringBuilder();
        double total = 0;
        for (int i = 0; i < marks.size(); i++) {
            int no = marks.get(i)[0];
            double max = maxs.get(i);
            int segEnd = i + 1 < marks.size() ? marks.get(i + 1)[1] : prompt.length();
            String answer = extractMockAnswer(prompt.substring(marks.get(i)[2], segEnd), isCode);
            double s;
            String c;
            if (answer.replaceAll("\\s", "").length() < 5) {
                s = 0;
                c = "作答内容缺失或无有效内容，记 0 分，请人工复核";
            } else {
                s = Math.round(max * (isCode ? 0.9 : 0.8) * 10) / 10.0;
                c = isCode ? "语法正确、可运行，核心功能实现完整，命名与注释存在次要瑕疵"
                           : "核心概念表述与参考答案一致，缺少部分展开细节";
            }
            total += s;
            if (i > 0) { scores.append(','); comments.append(','); }
            scores.append('"').append(no).append("\":").append(s);
            comments.append('"').append(no).append("\":\"").append(c).append('"');
        }
        return "{\"scores\":{" + scores + "},\"comments\":{" + comments + "},\"_total\":" + total + "}";
    }

    /** 从题目块中提取学生作答文本（简答取行；编程取 ```java 开栏之后、闭栏之前的代码体） */
    private String extractMockAnswer(String seg, boolean isCode) {
        String marker = isCode ? "学生代码：" : "学生作答：";
        int i = seg.indexOf(marker);
        if (i < 0) { return ""; }
        String rest = seg.substring(i + marker.length());
        if (!isCode) {
            int nl = rest.indexOf('\n');
            return nl >= 0 ? rest.substring(0, nl) : rest;
        }
        // 代码：跳过开栏（```java + 换行），取到闭栏 ``` 之前
        int open = rest.indexOf("```");
        if (open < 0) { return rest; }
        int lineEnd = rest.indexOf('\n', open);
        if (lineEnd < 0) { return ""; }
        int close = rest.indexOf("```", lineEnd);
        return close >= 0 ? rest.substring(lineEnd, close) : rest.substring(lineEnd);
    }

    @Override
    public Flux<String> chatStream(List<ChatMessage> messages, double temperature) {
        String reply = chat(messages, temperature);
        // 模拟流式：按 4-12 字符切片
        StringBuilder sb = new StringBuilder();
        return Flux.create(sink -> {
            Thread.ofVirtual().start(() -> {
                try {
                    for (int i = 0; i < reply.length(); ) {
                        int step = ThreadLocalRandom.current().nextInt(4, 12);
                        int end = Math.min(reply.length(), i + step);
                        sink.next(reply.substring(i, end));
                        i = end;
                        Thread.sleep(60);
                    }
                    sink.complete();
                } catch (Exception e) {
                    sink.error(e);
                }
            });
        });
    }

    /**
     * 规则化回复（移植自 demo answer() 的六类路由）
     */
    private String ruleReply(String text) {
        if (text == null || text.isBlank()) {
            return "请输入你的问题。";
        }
        String t = text.toLowerCase();
        if (t.contains("练习") || t.contains("出题") || t.contains("变式")) {
            return "好，我这就为你准备一道练习题（见下方卡片）。先自己作答，卡住了再逐级要提示。";
        }
        if (t.contains("报错") || t.contains("异常") || t.contains("帮我看") || t.contains("错误")) {
            return "先看报错信息的**第一行**和 `at` 开头的第一条你自己代码的堆栈，那是错误源头。\n\n"
                    + "常见排查顺序：① 空指针——哪个对象没初始化；② 类型不匹配——强转是否越界；"
                    + "③ 越界——数组/集合下标是否超范围。\n\n把报错贴给我，我帮你逐行分析。";
        }
        if (t.contains("路径") || t.contains("规划")) {
            return "学习路径要按「依赖链」来排：先补最弱的前置知识点，再攻克目标。"
                    + "你可以在知识图谱里点任意知识点查看依赖链溯源，或让我重新规划当前会话的路径。";
        }
        if (t.contains("薄弱") || t.contains("该补")) {
            return "从你的掌握度数据看，优先级最高的薄弱点已经在「我的报告 → 掌握度」里标红。"
                    + "建议从依赖链的**根部**补起，收益最大。";
        }
        if (t.contains("复习")) {
            return "今天的复习队列已推送到「我的报告 → 复习队列」，按 SM-2 算法安排，"
                    + "做完记得标记完成，下次复习时间会自动顺延。";
        }
        // 兜底：围绕 Java 学习的通用辅导回复
        return "这个问题可以从三个层面理解：\n\n1. **是什么**：先明确概念的定义与适用场景；\n"
                + "2. **为什么**：理解设计动机，它解决了什么问题；\n"
                + "3. **怎么用**：看一个最小可运行示例，然后自己改一改验证理解。\n\n"
                + "你可以把具体的代码或题目发给我，我会按「三级渐进提示」引导你，而不是直接给答案。"
                + "（当前为离线演示模式，配置 DEEPSEEK_API_KEY 后可获得完整智能回答）";
    }

    @Override
    public boolean isMock() {
        return true;
    }
}
