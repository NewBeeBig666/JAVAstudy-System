package com.la.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.la.ai.ChatMessage;
import com.la.ai.LlmClient;
import com.la.dto.response.FeedbackDto;
import com.la.entity.Feedback;
import com.la.entity.User;
import com.la.exception.BizException;
import com.la.mapper.FeedbackMapper;
import com.la.mapper.UserMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.stream.Collectors;

/**
 * 学生建议反馈：提交（非空校验）、教师列表、AI 一键总结
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class FeedbackService {

    private static final Set<String> TYPES = Set.of("BUG", "SUGGESTION", "FEATURE");
    private static final int MAX_CONTENT = 1000;
    private static final DateTimeFormatter TM = DateTimeFormatter.ofPattern("MM-dd HH:mm");

    private final FeedbackMapper feedbackMapper;
    private final UserMapper userMapper;
    private final LlmClient llmClient;

    /**
     * 学生提交反馈：类型合法 + 内容非空（1-1000 字），避免无效提交
     */
    public void submit(Long userId, String type, String content) {
        if (type == null || !TYPES.contains(type)) {
            throw new BizException("无效的反馈类型");
        }
        String text = content == null ? "" : content.trim();
        if (text.isEmpty()) {
            throw new BizException("反馈内容不能为空");
        }
        if (text.length() > MAX_CONTENT) {
            throw new BizException("反馈内容不能超过 " + MAX_CONTENT + " 字");
        }
        Feedback f = new Feedback();
        f.setUserId(userId);
        f.setType(type);
        f.setContent(text);
        f.setCreatedAt(LocalDateTime.now());
        feedbackMapper.insert(f);
        log.info("学生反馈已提交 userId={} type={} length={}", userId, type, text.length());
    }

    /**
     * 教师端反馈列表（按时间倒序，含学生标识）
     */
    public List<FeedbackDto> list() {
        List<Feedback> rows = feedbackMapper.selectList(new LambdaQueryWrapper<Feedback>()
                .orderByDesc(Feedback::getCreatedAt));
        if (rows.isEmpty()) {
            return List.of();
        }
        Map<Long, User> users = userMapper.selectBatchIds(
                        rows.stream().map(Feedback::getUserId).distinct().toList())
                .stream().collect(Collectors.toMap(User::getId, u -> u, (a, b) -> a));
        return rows.stream().map(f -> {
            FeedbackDto dto = new FeedbackDto();
            dto.setId(f.getId());
            User u = users.get(f.getUserId());
            dto.setStudentName(u != null ? u.getRealName() : "未知学生");
            dto.setStudentNo(u != null ? (u.getStudentNo() != null ? u.getStudentNo() : u.getUsername()) : "-");
            dto.setType(f.getType());
            dto.setContent(f.getContent());
            dto.setCreatedAt(f.getCreatedAt() != null ? f.getCreatedAt().format(TM) : "");
            return dto;
        }).toList();
    }

    /**
     * AI 一键总结：对全部反馈做归纳汇总（Markdown 输出）。
     * 沿用 AI 初评的稳定性约定：网络波动自动重试 1 次（退避 800ms），
     * 全链路埋点（条数 / 耗时 / 失败原因）。
     */
    public Map<String, Object> summarize() {
        List<FeedbackDto> list = list();
        if (list.isEmpty()) {
            throw new BizException("暂无学生反馈，无需总结");
        }
        long t0 = System.currentTimeMillis();
        StringBuilder sb = new StringBuilder("以下是某 Java 学习平台学生提交的反馈列表（类型 | 学生 | 内容 | 时间）：\n");
        Map<String, String> labels = Map.of("BUG", "系统bug", "SUGGESTION", "功能优化建议", "FEATURE", "新增功能需求");
        for (int i = 0; i < list.size(); i++) {
            FeedbackDto f = list.get(i);
            sb.append(i + 1).append(". [").append(labels.getOrDefault(f.getType(), f.getType()))
                    .append("] ").append(f.getStudentName())
                    .append("（").append(f.getStudentNo()).append("）：")
                    .append(f.getContent()).append("（").append(f.getCreatedAt()).append("）\n");
        }
        String summary = chatWithRetry(List.of(
                ChatMessage.system("你是一位教学平台的产品助手，负责帮教师归纳学生反馈。" +
                        "请根据学生反馈列表输出 Markdown 格式总结，包含：1) 总体概况（总条数与三类反馈的分布）；" +
                        "2) 共性问题与典型反馈提炼（点名具体要点，不逐条罗列原文）；" +
                        "3) 处理优先级建议（系统bug 优先，其次高频建议）。" +
                        "语言简洁、条理清晰，总长不超过 400 字。"),
                ChatMessage.user(sb.toString())), "feedback-summary");
        log.info("反馈 AI 总结完成 count={} costMs={} length={}", list.size(),
                System.currentTimeMillis() - t0, summary == null ? 0 : summary.length());
        return Map.of("summary", summary == null ? "" : summary, "count", list.size());
    }

    /**
     * AI 调用（带一次自动重试）：临时故障退避 800ms 重试一次，仍失败抛友好异常
     */
    private String chatWithRetry(List<ChatMessage> messages, String bizKey) {
        RuntimeException last = null;
        for (int attempt = 0; attempt < 2; attempt++) {
            try {
                return llmClient.chat(messages, 0.3);
            } catch (RuntimeException e) {
                last = e;
                if (attempt == 0) {
                    log.warn("AI 调用失败（将重试一次）biz={} reason={}", bizKey, e.getMessage());
                    try { Thread.sleep(800); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); }
                }
            }
        }
        log.error("AI 调用重试后仍失败 biz={}", bizKey, last);
        throw new BizException("AI 总结失败：AI 服务暂不可用（网络波动或服务超时），请稍后重试");
    }
}
