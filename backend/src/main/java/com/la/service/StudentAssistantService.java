package com.la.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.ai.ChatMessage;
import com.la.ai.LlmClient;
import com.la.dto.response.KnowledgeGraphResponse;
import com.la.exception.BizException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 学生端「智能助手」（非学习会话页面的右侧栏）：DeepSeek 多轮对话
 * - 与教师版差异：注入的是学生本人的学情摘要（掌握度均值 + 薄弱知识点 TOP5），
 *   不含班级与其他学生数据（权限隔离）；
 * - 产品定位：学习伙伴——遵循引导式学习约束（与系统「三级渐进提示」定位一致，
 *   不直接代写作业、不直接给完整作业代码，提供思路与提示）；
 * - 上下文数据与知识图谱同源（KnowledgeService.graph）。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class StudentAssistantService {

    private final LlmClient llmClient;
    private final KnowledgeService knowledgeService;
    private final ObjectMapper objectMapper;

    private static final int MAX_HISTORY = 12;

    public Map<String, Object> chat(Long studentId, List<Map<String, String>> messages) {
        long t0 = System.currentTimeMillis();
        String question = null;
        if (messages != null) {
            for (int i = messages.size() - 1; i >= 0; i--) {
                Map<String, String> m = messages.get(i);
                if (m != null && "user".equals(m.get("role"))) {
                    String c = m.get("content");
                    if (c != null && !c.isBlank()) { question = c; break; }
                }
            }
        }
        if (question == null) {
            throw new BizException("请输入你的问题");
        }

        List<ChatMessage> chat = new ArrayList<>();
        chat.add(ChatMessage.system(systemPrompt(studentId)));
        if (messages != null) {
            List<Map<String, String>> valid = new ArrayList<>();
            for (Map<String, String> m : messages) {
                if (m == null) continue;
                String role = m.get("role");
                String content = m.get("content");
                if (("user".equals(role) || "assistant".equals(role)) && content != null && !content.isBlank()) {
                    valid.add(m);
                }
            }
            int from = Math.max(0, valid.size() - MAX_HISTORY);
            for (int i = from; i < valid.size(); i++) {
                chat.add(new ChatMessage(valid.get(i).get("role"), valid.get(i).get("content")));
            }
        }

        String reply = llmClient.chat(chat, 0.5);
        if (reply == null || reply.isBlank()) {
            throw new BizException("AI 未返回有效回答，请重试");
        }
        log.info("学生智能助手回答完成 student={} rounds={} cost={}ms",
                studentId, messages == null ? 0 : messages.size(), System.currentTimeMillis() - t0);
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("reply", reply);
        return resp;
    }

    private String systemPrompt(Long studentId) {
        return "你是「Java 学习智能体」学生学习伙伴，面向本科软件工程（Java 方向）的学生，"
                + "帮助学生理解 Java 知识、分析自己的薄弱点、制定学习计划、推荐练习。\n\n"
                + "【该学生本人的学情摘要（与知识图谱同源）】\n"
                + studentSummary(studentId)
                + "\n\n【回答要求】\n"
                + "1. 优先结合该学生的掌握度数据：答学情问题时引用具体数字并给可执行的学习建议（先补哪些知识点、怎么练）。\n"
                + "2. 讲解 Java 知识时由浅入深、配合短小示例代码（代码用代码块），符合初学者认知顺序。\n"
                + "3. 引导式学习：学生拿作业题来问时，先给思路与提示，引导其自己完成；不直接代写作业、不直接给完整作业代码（可给关键步骤提示或讲解类似示例）。\n"
                + "4. 简洁实用、中文回答，长回答用短段落与小标题组织。\n"
                + "5. 只涉及该学生本人的数据，不推测班级与其他同学情况；数据未覆盖的问题如实说明。\n"
                + "6. 掌握度口径：<60 薄弱、60-79 一般、>=80 良好。";
    }

    /** 学生本人学情摘要：掌握度均值 + 有数据知识点数 + 薄弱 TOP5 */
    private String studentSummary(Long studentId) {
        try {
            KnowledgeGraphResponse g = knowledgeService.graph(studentId);
            List<KnowledgeGraphResponse.NodeDto> nodes = g == null || g.getNodes() == null
                    ? List.of() : g.getNodes();
            List<KnowledgeGraphResponse.NodeDto> scored = new ArrayList<>();
            for (KnowledgeGraphResponse.NodeDto n : nodes) {
                if (n.getMastery() != null) scored.add(n);
            }
            if (scored.isEmpty()) {
                return "（该学生还没有练习数据——建议先到「学习会话」做几道练习，掌握度会自动收集）";
            }
            double avg = scored.stream().mapToInt(KnowledgeGraphResponse.NodeDto::getMastery).average().orElse(0);
            List<KnowledgeGraphResponse.NodeDto> weak = new ArrayList<>(scored);
            weak.sort(Comparator.comparingInt(KnowledgeGraphResponse.NodeDto::getMastery));
            List<Map<String, Object>> weakTop = new ArrayList<>();
            for (int i = 0; i < Math.min(5, weak.size()) && weak.get(i).getMastery() < 60; i++) {
                KnowledgeGraphResponse.NodeDto n = weak.get(i);
                Map<String, Object> w = new LinkedHashMap<>();
                w.put("知识点", n.getName());
                w.put("掌握度", n.getMastery());
                weakTop.add(w);
            }
            Map<String, Object> brief = new LinkedHashMap<>();
            brief.put("掌握度均值", Math.round(avg));
            brief.put("已产生掌握度数据的知识点数", scored.size());
            if (!weakTop.isEmpty()) brief.put("薄弱知识点TOP5", weakTop);
            return objectMapper.writeValueAsString(brief);
        } catch (Exception e) {
            log.warn("学生助手学情摘要生成失败 student={} err={}", studentId, e.getMessage());
            return "（学生学情数据暂不可用，请基于通用学习方法回答）";
        }
    }
}
