package com.la.service;

import com.la.ai.*;
import com.la.config.DeepSeekProperties;
import com.la.dto.response.ReviewItemDto;
import com.la.entity.*;
import com.la.exception.BizException;
import com.la.mapper.ExerciseMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 智能体对话编排：意图路由 → 上下文注入 → DeepSeek 流式 → 教学边界护栏 → 落库
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ChatService {

    private final LlmClient llmClient;
    private final AgentPrompts agentPrompts;
    private final IntentRouter intentRouter;
    private final ContextInjector contextInjector;
    private final TeachingGuardrail guardrail;
    private final SessionService sessionService;
    private final KnowledgeService knowledgeService;
    private final ExerciseMapper exerciseMapper;
    private final ExerciseService exerciseService;
    private final ReviewService reviewService;
    private final DeepSeekProperties deepSeekProperties;
    private final ObjectMapper objectMapper;

    /** 每用户 LLM 并发限制（防刷屏） */
    private final Map<Long, Semaphore> userSemaphores = new ConcurrentHashMap<>();

    private static final DateTimeFormatter TM = DateTimeFormatter.ofPattern("HH:mm");

    public void streamChat(Long userId, Long sessionId, String content, String agentHint, SseEmitter emitter) {
        Semaphore semaphore = userSemaphores.computeIfAbsent(userId, k -> new Semaphore(2));
        // 每用户并发限制在同步段（controller 调用线程）判断：
        // 失败直接抛 BizException → 统一 400 JSON，前端提示"请求太频繁"。
        // 不能在虚拟线程里拿到锁后立即向 emitter 发事件——此时 controller 刚返回、
        // 容器 async 提交尚未完成，并发操作同一 Response 的 MimeHeaders 会触发 Tomcat 竞态异常。
        if (!semaphore.tryAcquire()) {
            throw new BizException("你的请求太频繁了，请等上一条回答完成");
        }
        Thread.ofVirtual().name("sse-chat-", 0).start(() -> {
            // 流式对话为异步订阅：释放责任移交给 Reactive 流的 doFinally（流结束时释放）。
            // 若在虚拟线程 finally 直接释放，subscribe() 返回即释放，每用户并发限制将失效。
            AtomicBoolean transferred = new AtomicBoolean(false);
            try {
                // 归属校验
                SessionEntity session = sessionService.ownedSession(userId, sessionId);
                KnowledgePoint kp = knowledgeService.byId(session.getKpId());

                // 保存用户消息
                sessionService.insertMessage(sessionId, "USER", null, content, null, null);

                IntentRouter.Intent intent = intentRouter.route(content, agentHint);

                switch (intent.getAction()) {
                    case EXERCISE -> handleExercise(emitter, sessionId, kp, intent.getAgent());
                    case REVIEW -> handleReview(emitter, sessionId, userId);
                    default -> transferred.set(handleChat(emitter, sessionId, userId, kp,
                            content, intent.getAgent(), semaphore::release));
                }
                sessionService.touch(sessionId);
            } catch (BizException e) {
                sendEvent(emitter, "error", Map.of("code", "BIZ", "msg", e.getMessage()));
                emitter.complete();
            } catch (Exception e) {
                log.error("对话处理失败", e);
                sendEvent(emitter, "error", Map.of("code", "INTERNAL",
                        "msg", "智能体开小差了，请重试"));
                emitter.complete();
            } finally {
                if (!transferred.get()) {
                    semaphore.release();
                }
            }
        });
    }

    /**
     * 出题：练习卡片不走向 LLM（数据 100% 可靠），卡片内嵌题目 DTO
     */
    private void handleExercise(SseEmitter emitter, Long sessionId, KnowledgePoint kp, String agent) {
        Exercise ex = null;
        if (kp != null) {
            List<Exercise> list = exerciseMapper.selectList(new LambdaQueryWrapper<Exercise>()
                    .eq(Exercise::getKpId, kp.getId()));
            if (!list.isEmpty()) {
                ex = list.get(new Random().nextInt(list.size()));
            }
        }
        if (ex == null) {
            sendEvent(emitter, "error", Map.of("code", "NO_EXERCISE",
                    "msg", "当前知识点暂无练习题"));
            emitter.complete();
            return;
        }
        String text = "来，用一道题验证一下你是否真的掌握了（按规则我不会直接给答案，卡住了可以逐级要提示）：";
        Map<String, Object> card = new LinkedHashMap<>();
        card.put("type", "exercise");
        card.put("exId", ex.getId());
        card.put("exercise", exerciseService.exerciseMap(ex));
        card.put("state", "answering");
        card.put("hintLevel", 0);
        card.put("selected", null);
        Message saved = sessionService.insertMessage(sessionId, "AGENT", agent, text, "exercise", card);
        sendEvent(emitter, "meta", Map.of("messageId", String.valueOf(saved.getId()),
                "agent", agent, "mock", llmClient.isMock()));
        sendEvent(emitter, "delta", Map.of("text", text));
        sendEvent(emitter, "card", card);
        sendEvent(emitter, "done", Map.of("messageId", String.valueOf(saved.getId())));
        emitter.complete();
    }

    /**
     * 今日复习：直接查库生成文本
     */
    private void handleReview(SseEmitter emitter, Long sessionId, Long userId) {
        List<ReviewItemDto> items = reviewService.today(userId);
        StringBuilder sb = new StringBuilder("你的今日复习队列（SM-2 间隔重复）：\n\n");
        if (items.isEmpty()) {
            sb.append("今天没有到期的复习项，保持节奏！可以去「我的报告 → 复习队列」查看后续安排。");
        } else {
            for (int i = 0; i < items.size(); i++) {
                ReviewItemDto it = items.get(i);
                sb.append(i + 1).append(". **").append(it.getTitle()).append("**（")
                        .append(it.getDue()).append(" · ").append(it.getReason()).append("）\n");
            }
            sb.append("\n完成复习后记得在复习队列里标记，下次复习时间会自动按 SM-2 顺延。");
        }
        String text = sb.toString();
        Message saved = sessionService.insertMessage(sessionId, "AGENT", AgentPrompts.TUTOR,
                text, null, null);
        sendEvent(emitter, "meta", Map.of("messageId", String.valueOf(saved.getId()),
                "agent", AgentPrompts.TUTOR, "mock", llmClient.isMock()));
        sendEvent(emitter, "delta", Map.of("text", text));
        sendEvent(emitter, "done", Map.of("messageId", String.valueOf(saved.getId())));
        emitter.complete();
    }

    /**
     * 普通对话：DeepSeek 流式。
     * 返回 true 表示已订阅异步流，信号量释放责任移交给流的 doFinally（覆盖 complete/error/cancel）。
     */
    private boolean handleChat(SseEmitter emitter, Long sessionId, Long userId, KnowledgePoint kp,
                               String content, String agent, Runnable release) {
        List<ChatMessage> messages = contextInjector.build(userId, sessionId, kp, agent);
        messages.add(ChatMessage.user(content));

        Message placeholder = sessionService.insertMessage(sessionId, "AGENT", agent, "", null, null);
        sendEvent(emitter, "meta", Map.of("messageId", String.valueOf(placeholder.getId()),
                "agent", agent, "mock", llmClient.isMock()));

        StringBuilder buffer = new StringBuilder();
        llmClient.chatStream(messages, 0.7)
                .doOnNext(delta -> {
                    buffer.append(delta);
                    sendEvent(emitter, "delta", Map.of("text", delta));
                })
                .doOnComplete(() -> {
                    String full = buffer.toString();
                    String sanitized = guardrail.sanitize(full);
                    // 更新占位消息为最终内容
                    placeholder.setContent(sanitized);
                    updateMessage(placeholder);
                    if (!sanitized.equals(full)) {
                        // 护栏拦截了完整实现代码，通知前端整体替换
                        sendEvent(emitter, "replace", Map.of("text", sanitized));
                    }
                    sendEvent(emitter, "done", Map.of("messageId", String.valueOf(placeholder.getId())));
                    emitter.complete();
                })
                .doOnError(e -> {
                    log.error("DeepSeek 流式调用失败", e);
                    String fallback = "智能体暂时无法回答（" + e.getClass().getSimpleName() + "），请稍后重试。";
                    placeholder.setContent(fallback);
                    updateMessage(placeholder);
                    sendEvent(emitter, "delta", Map.of("text", fallback));
                    sendEvent(emitter, "done", Map.of("messageId", String.valueOf(placeholder.getId())));
                    emitter.complete();
                })
                // 流终止（完成/失败/取消）时释放该用户的并发信号量——订阅后即返回，
                // 释放必须挂在流上，否则 subscribe() 返回瞬间信号量即被释放导致限流失效
                .doFinally(signal -> release.run())
                .subscribe();
        return true;
    }

    private void updateMessage(Message m) {
        // 通过 SessionService 暴露的 mapper 更新
        sessionService.updateMessage(m);
    }

    private void sendEvent(SseEmitter emitter, String name, Object payload) {
        try {
            emitter.send(SseEmitter.event().name(name)
                    .data(objectMapper.writeValueAsString(payload), MediaType.APPLICATION_JSON));
        } catch (Exception e) {
            log.debug("SSE 发送失败（客户端可能已断开）: {}", e.getMessage());
        }
    }

    public DeepSeekProperties props() {
        return deepSeekProperties;
    }
}
