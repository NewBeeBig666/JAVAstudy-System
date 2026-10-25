package com.la.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.ai.ChatMessage;
import com.la.ai.LlmClient;
import com.la.exception.BizException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 教师端右侧栏「智能助手」：DeepSeek 多轮对话
 * - 系统提示注入教师当前班级学情摘要（复用学情看板数据源 TeacherService.dashboard），
 *   助手可结合班级真实数据回答学情/教学问题
 * - 前端持有完整对话历史（刷新即清空，轻量助手定位），每次请求回传最近若干轮
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class TeacherAssistantService {

    private final LlmClient llmClient;
    private final TeacherService teacherService;
    private final ObjectMapper objectMapper;

    /** 单次请求最多携带的历史消息数（含本次提问），防止上下文膨胀 */
    private static final int MAX_HISTORY = 12;

    public Map<String, Object> chat(Long teacherId, Long classId, List<Map<String, String>> messages) {
        long t0 = System.currentTimeMillis();
        // 校验：至少一条用户消息
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
        chat.add(ChatMessage.system(systemPrompt(teacherId, classId)));
        // 回传历史截断（保留最近 N 条，user/assistant 合法角色、内容非空）
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
        log.info("教师智能助手回答完成 teacher={} class={} rounds={} cost={}ms",
                teacherId, classId, messages == null ? 0 : messages.size(), System.currentTimeMillis() - t0);
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("reply", reply);
        return resp;
    }

    /**
     * 系统提示词：教学助手角色 + 班级学情实时摘要（看板同源数据）
     */
    private String systemPrompt(Long teacherId, Long classId) {
        return "你是「Java 学习智能体」教师端的智能助手，面向本科软件工程（Java 方向）课程教师，"
                + "帮助教师分析班级学情、答疑 Java 教学问题、给出可操作的教学建议。\n\n"
                + "【当前教师的班级学情数据（实时聚合，与学情看板同源）】\n"
                + classSummary(teacherId, classId)
                + "\n\n【回答要求】\n"
                + "1. 优先结合上方班级数据回答；教师问及学情时，引用具体数字并给出可操作的教学建议（如调整讲解重点、布置针对性练习）。\n"
                + "2. 涉及 Java 知识的教学问题，讲解准确、条理清晰，代码用代码块展示。\n"
                + "3. 简洁实用、中文回答，长回答用短段落与小标题组织，避免冗长铺垫。\n"
                + "4. 数据未覆盖的问题（如学生个人隐私细节、系统外信息）如实说明，不编造。\n"
                + "5. 掌握度口径：<60 薄弱、60-79 一般、>=80 良好；卡点率=该知识点掌握度低于60分的学生人数占比。";
    }

    /** 班级学情摘要（JSON 形式注入，精简字段） */
    private String classSummary(Long teacherId, Long classId) {
        try {
            Map<String, Object> d = teacherService.dashboard(teacherId, classId);
            Map<String, Object> brief = new LinkedHashMap<>();
            Object kpi = d.get("kpi");
            if (kpi != null) brief.put("核心指标", kpi);
            List<?> stuck = (List<?>) d.get("stuckPoints");
            if (stuck != null && !stuck.isEmpty()) {
                List<Object> top = new ArrayList<>();
                for (int i = 0; i < Math.min(6, stuck.size()); i++) top.add(stuck.get(i));
                brief.put("卡点知识点TOP6", top);
            }
            List<?> watch = (List<?>) d.get("watchList");
            if (watch != null && !watch.isEmpty()) {
                List<Object> top = new ArrayList<>();
                for (int i = 0; i < Math.min(5, watch.size()); i++) top.add(watch.get(i));
                brief.put("重点关注学生", top);
            }
            return objectMapper.writeValueAsString(brief);
        } catch (Exception e) {
            log.warn("教师助手学情摘要生成失败 teacher={} class={} err={}", teacherId, classId, e.getMessage());
            return "（班级数据暂不可用，请基于通用教学经验回答）";
        }
    }
}
