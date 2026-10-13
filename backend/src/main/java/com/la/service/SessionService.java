package com.la.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.dto.response.SessionDto;
import com.la.dto.response.TraceChainResponse;
import com.la.entity.*;
import com.la.exception.BizException;
import com.la.mapper.*;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
public class SessionService {

    private final SessionMapper sessionMapper;
    private final SessionStepMapper stepMapper;
    private final MessageMapper messageMapper;
    private final KnowledgePointMapper kpMapper;
    private final KnowledgeService knowledgeService;
    private final PathPlanService pathPlanService;
    private final ExerciseMapper exerciseMapper;
    private final ExerciseService exerciseService;
    private final ObjectMapper objectMapper;

    private static final DateTimeFormatter DT = DateTimeFormatter.ofPattern("MM-dd HH:mm");
    private static final DateTimeFormatter TM = DateTimeFormatter.ofPattern("HH:mm");

    /**
     * 新建学习会话：依赖链溯源诊断 + 路径规划 + 首批消息（sys / 诊断Agent / 规划Agent）
     */
    @Transactional
    public SessionDto create(Long userId, String kpCode) {
        KnowledgePoint kp = kpMapper.selectOne(new LambdaQueryWrapper<KnowledgePoint>()
                .eq(KnowledgePoint::getKpCode, kpCode));
        if (kp == null) {
            throw new BizException("知识点不存在: " + kpCode);
        }

        TraceChainResponse chain = knowledgeService.traceChain(kpCode, userId);
        List<PathPlanService.PlannedStep> plan = pathPlanService.plan(kpCode, kp.getName(), chain);

        SessionEntity session = new SessionEntity();
        session.setUserId(userId);
        session.setTitle(kp.getName() + "：个性化攻克路径");
        session.setKpId(kp.getId());
        session.setStatus("ACTIVE");
        session.setStepIndex(0);
        session.setCreatedAt(LocalDateTime.now());
        session.setUpdatedAt(LocalDateTime.now());
        sessionMapper.insert(session);

        List<SessionStep> steps = new ArrayList<>();
        for (int i = 0; i < plan.size(); i++) {
            PathPlanService.PlannedStep ps = plan.get(i);
            SessionStep st = new SessionStep();
            st.setSessionId(session.getId());
            st.setSortOrder(i + 1);
            st.setTitle(ps.title);
            st.setDescription(ps.description);
            st.setDurationMin(ps.durationMin);
            st.setStatus(i == 0 ? "ACTIVE" : "PENDING");
            stepMapper.insert(st);
            steps.add(st);
        }

        int totalMin = plan.stream().mapToInt(p -> p.durationMin).sum();

        // sys 消息
        insertMessage(session.getId(), "SYS", null, "会话已创建 · 已载入你的知识图谱快照（"
                + countKps() + " 个知识点）", null, null);

        // 诊断 Agent 消息（规则化生成，含 diagnosis 卡片）
        StringBuilder diagText = new StringBuilder("我先调了你的历史练习记录和错题本，做了次快速诊断：\n\n");
        diagText.append("你的「").append(kp.getName()).append("」掌握度为 **")
                .append(chain.getChain().get(0).getMastery()).append(" 分**");
        if (chain.getRootCause() != null) {
            TraceChainResponse.ChainNode root = chain.getChain().stream()
                    .filter(n -> n.getId().equals(chain.getRootCause())).findFirst().orElse(null);
            diagText.append("，但更关键的是——**根源不在目标知识点本身**。\n\n顺着依赖链往上追：");
            StringJoiner joiner = new StringJoiner(" ← ");
            for (TraceChainResponse.ChainNode n : chain.getChain()) {
                joiner.add(n.getName() + "（" + n.getMastery() + " 分）");
            }
            diagText.append(joiner).append("。\n\n你真正缺的是「")
                    .append(root != null ? root.getName() : "前置基础")
                    .append("」这块地基，直接刷目标知识点的题目，收益很低。");
        } else {
            diagText.append("，前置链整体达标，可以直接攻克。");
        }

        List<Map<String, Object>> items = new ArrayList<>();
        for (int i = 0; i < chain.getChain().size(); i++) {
            TraceChainResponse.ChainNode n = chain.getChain().get(i);
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("kp", n.getId());
            item.put("mastery", n.getMastery());
            item.put("note", n.getNote());
            items.add(item);
        }
        Map<String, Object> diagCard = new LinkedHashMap<>();
        diagCard.put("type", "diagnosis");
        diagCard.put("items", items);
        diagCard.put("conclusion", chain.getConclusion());
        insertMessage(session.getId(), "AGENT", "diagnosis", diagText.toString(),
                "diagnosis", diagCard);

        // 规划 Agent 消息（path 卡片）
        String planText = "按诊断结果，我给你排了一条 " + totalMin + " 分钟的路径，从第 1 步开始。"
                + "每一步都可以点开看详情，右侧上下文区会同步当前知识点摘要。";
        Map<String, Object> pathCard = new LinkedHashMap<>();
        pathCard.put("type", "path");
        pathCard.put("kp", kpCode);
        insertMessage(session.getId(), "AGENT", "planning", planText, "path", pathCard);

        return detail(userId, session.getId());
    }

    /**
     * 多知识点 / 全知识点学习会话：
     *  - 不选（空列表）：覆盖整个学习系统——按掌握度取最薄弱的前 3 个知识点生成全局补弱路径；
     *  - 多选：所选知识点依次规划「概念精讲 + 代码陪练」，首尾配全局诊断与巩固测验。
     * 单个知识点仍走原 create()（诊断/路径逻辑零改动）。
     */
    @Transactional
    public SessionDto createMulti(Long userId, List<String> kpCodes) {
        List<KnowledgePoint> all = kpMapper.selectList(new LambdaQueryWrapper<KnowledgePoint>()
                .eq(KnowledgePoint::getLevel, 2).orderByAsc(KnowledgePoint::getSortOrder));
        if (all.isEmpty()) {
            throw new BizException("知识点数据缺失");
        }
        boolean global = kpCodes == null || kpCodes.isEmpty();

        List<KnowledgePoint> chosen = new ArrayList<>();
        if (global) {
            Map<Long, Integer> masteryMap = knowledgeService.masteryMap(userId);
            chosen = all.stream()
                    .sorted(Comparator.comparingInt(k -> masteryMap.getOrDefault(k.getId(), 0)))
                    .limit(3).collect(Collectors.toList());
        } else {
            Map<String, KnowledgePoint> byCode = new LinkedHashMap<>();
            for (String code : kpCodes) {
                KnowledgePoint kp = all.stream()
                        .filter(k -> code != null && code.equals(k.getKpCode())).findFirst().orElse(null);
                if (kp != null) {
                    byCode.put(kp.getKpCode(), kp);
                }
            }
            if (byCode.isEmpty()) {
                throw new BizException("所选知识点不存在");
            }
            chosen.addAll(byCode.values());
        }
        if (chosen.size() == 1) {
            return create(userId, chosen.get(0).getKpCode());
        }

        String names = chosen.stream().map(KnowledgePoint::getName).collect(Collectors.joining("、"));
        String title = (global ? "全知识点（" + names + " 补弱优先）" : names) + "：个性化攻克路径";

        // 多知识点诊断：逐个追溯所选知识点的掌握度与薄弱根因
        List<Map<String, Object>> items = new ArrayList<>();
        StringBuilder diagText = new StringBuilder(
                global ? "你没有指定知识点，我按你的学习数据做了一次全局诊断，锁定最值得补的薄弱点：\n\n"
                        : "你选择了 " + chosen.size() + " 个知识点，我逐个调了你的练习记录做快速诊断：\n\n");
        for (KnowledgePoint kp : chosen) {
            TraceChainResponse chain = knowledgeService.traceChain(kp.getKpCode(), userId);
            TraceChainResponse.ChainNode node = chain.getChain().isEmpty() ? null : chain.getChain().get(0);
            if (node != null) {
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("kp", node.getId());
                item.put("mastery", node.getMastery());
                item.put("note", node.getNote());
                items.add(item);
                diagText.append("「").append(node.getName()).append("」掌握度 **")
                        .append(node.getMastery()).append(" 分**")
                        .append(chain.getRootCause() != null ? "，前置链上存在薄弱根因，规划中已优先补强。"
                                : "，前置链达标，可直接攻克。").append('\n');
            }
        }
        if (items.isEmpty()) {
            throw new BizException("诊断失败：未获取到所选知识点的学习数据");
        }
        diagText.append("\n路径已按「先补地基 → 再逐点攻克」的顺序排好，从第 1 步开始。");

        // 多知识点路径：全局诊断 → 每个知识点（概念精讲 + 代码陪练）→ 巩固测验
        List<PathPlanService.PlannedStep> plan = new ArrayList<>();
        plan.add(new PathPlanService.PlannedStep(
                "诊断定位：" + (global ? "全局摸底" : names) + (global ? "（最薄弱知识点）" : ""),
                global ? "锁定掌握度最低的知识点，先补最大短板，再逐点推进。"
                        : "综合判断所选知识点中哪些存在前置薄弱，优先补强。",
                5, chosen.get(0).getKpCode()));
        for (KnowledgePoint kp : chosen) {
            plan.add(new PathPlanService.PlannedStep(
                    "概念精讲：" + kp.getName(),
                    "围绕「" + kp.getName() + "」的高频考点做渐进式讲解，配代码示例与反例。",
                    15, kp.getKpCode()));
            plan.add(new PathPlanService.PlannedStep(
                    "代码陪练：" + kp.getName(),
                    "针对「" + kp.getName() + "」给出测试用例，分三级提示引导补全核心逻辑，不直接给完整答案。",
                    25, kp.getKpCode()));
        }
        plan.add(new PathPlanService.PlannedStep(
                "巩固测验 + 错题归档",
                "对所学知识点做变式题即时评测，错题自动进入间隔重复（SM-2）复习队列。",
                10, chosen.get(chosen.size() - 1).getKpCode()));

        SessionEntity session = new SessionEntity();
        session.setUserId(userId);
        session.setTitle(title);
        session.setKpId(chosen.get(0).getId());
        session.setKps(chosen.stream().map(KnowledgePoint::getKpCode).collect(Collectors.joining(",")));
        session.setStatus("ACTIVE");
        session.setStepIndex(0);
        session.setCreatedAt(LocalDateTime.now());
        session.setUpdatedAt(LocalDateTime.now());
        sessionMapper.insert(session);

        int totalMin = plan.stream().mapToInt(p -> p.durationMin).sum();
        List<SessionStep> steps = new ArrayList<>();
        for (int i = 0; i < plan.size(); i++) {
            PathPlanService.PlannedStep ps = plan.get(i);
            SessionStep st = new SessionStep();
            st.setSessionId(session.getId());
            st.setSortOrder(i + 1);
            st.setTitle(ps.title);
            st.setDescription(ps.description);
            st.setDurationMin(ps.durationMin);
            st.setStatus(i == 0 ? "ACTIVE" : "PENDING");
            stepMapper.insert(st);
            steps.add(st);
        }

        insertMessage(session.getId(), "SYS", null, "会话已创建 · 已载入你的知识图谱快照（"
                + countKps() + " 个知识点）", null, null);
        Map<String, Object> diagCard = new LinkedHashMap<>();
        diagCard.put("type", "diagnosis");
        diagCard.put("items", items);
        diagCard.put("conclusion", global
                ? "全局模式：已锁定最薄弱的 " + chosen.size() + " 个知识点并按优先级排序。"
                : "多知识点模式：已按依赖关系排定攻克顺序。");
        insertMessage(session.getId(), "AGENT", "diagnosis", diagText.toString(), "diagnosis", diagCard);

        String planText = "按诊断结果，我给你排了一条 " + totalMin + " 分钟的路径，共 "
                + plan.size() + " 步，覆盖 " + names + "。每一步都可以点开看详情。";
        Map<String, Object> pathCard = new LinkedHashMap<>();
        pathCard.put("type", "path");
        pathCard.put("kp", chosen.get(0).getKpCode());
        insertMessage(session.getId(), "AGENT", "planning", planText, "path", pathCard);

        return detail(userId, session.getId());
    }

    public List<SessionDto> list(Long userId) {
        List<SessionEntity> sessions = sessionMapper.selectList(new LambdaQueryWrapper<SessionEntity>()
                .eq(SessionEntity::getUserId, userId)
                .orderByDesc(SessionEntity::getUpdatedAt));
        return sessions.stream().map(s -> {
            List<SessionStep> steps = stepMapper.selectList(new LambdaQueryWrapper<SessionStep>()
                    .eq(SessionStep::getSessionId, s.getId())
                    .orderByAsc(SessionStep::getSortOrder));
            KnowledgePoint kp = kpMapper.selectById(s.getKpId());
            return toDto(s, steps, List.of(), kp, true);
        }).collect(Collectors.toList());
    }

    public SessionDto detail(Long userId, Long sessionId) {
        SessionEntity s = ownedSession(userId, sessionId);
        List<SessionStep> steps = stepMapper.selectList(new LambdaQueryWrapper<SessionStep>()
                .eq(SessionStep::getSessionId, sessionId).orderByAsc(SessionStep::getSortOrder));
        List<Message> messages = messageMapper.selectList(new LambdaQueryWrapper<Message>()
                .eq(Message::getSessionId, sessionId).orderByAsc(Message::getCreatedAt));
        KnowledgePoint kp = kpMapper.selectById(s.getKpId());
        return toDto(s, steps, messages, kp, false);
    }

    /**
     * 开始某一步骤；代码陪练步骤会自动生成练习卡片消息
     */
    @Transactional
    public SessionDto startStep(Long userId, Long sessionId, int stepNo) {
        SessionEntity s = ownedSession(userId, sessionId);
        List<SessionStep> steps = stepMapper.selectList(new LambdaQueryWrapper<SessionStep>()
                .eq(SessionStep::getSessionId, sessionId).orderByAsc(SessionStep::getSortOrder));
        for (int i = 0; i < steps.size(); i++) {
            SessionStep st = steps.get(i);
            if (i + 1 < stepNo) {
                st.setStatus("DONE");
            } else if (i + 1 == stepNo) {
                if (!"DONE".equals(st.getStatus())) {
                    st.setStatus("ACTIVE");
                }
            }
            stepMapper.updateById(st);
        }
        s.setStepIndex(stepNo - 1);
        s.setUpdatedAt(LocalDateTime.now());
        sessionMapper.updateById(s);

        SessionStep target = steps.stream()
                .filter(st -> st.getSortOrder() == stepNo).findFirst().orElse(null);
        if (target != null && target.getTitle().startsWith("代码陪练") && !exerciseCardExists(sessionId)) {
            List<Exercise> exList = exerciseMapper.selectList(new LambdaQueryWrapper<Exercise>()
                    .eq(Exercise::getKpId, s.getKpId()));
            if (!exList.isEmpty()) {
                Exercise ex = exList.get(new Random().nextInt(exList.size()));
                Map<String, Object> card = new LinkedHashMap<>();
                card.put("type", "exercise");
                card.put("exId", ex.getId());
                card.put("exercise", exerciseService.exerciseMap(ex));
                card.put("state", "answering");
                card.put("hintLevel", 0);
                card.put("selected", null);
                insertMessage(sessionId, "AGENT", "code",
                        "这道是代码陪练题。按规则我**不会直接给你完整实现**，先读题干，自己作答；卡住了再逐级要提示（提示使用次数教师端可见）。",
                        "exercise", card);
            }
        }
        return detail(userId, sessionId);
    }

    /**
     * 完成某一步骤（练习提交正确后由前端调用）
     */
    @Transactional
    public SessionDto completeStep(Long userId, Long sessionId, int stepNo) {
        SessionEntity s = ownedSession(userId, sessionId);
        List<SessionStep> steps = stepMapper.selectList(new LambdaQueryWrapper<SessionStep>()
                .eq(SessionStep::getSessionId, sessionId).orderByAsc(SessionStep::getSortOrder));
        SessionStep finished = steps.stream()
                .filter(st -> st.getSortOrder() == stepNo).findFirst().orElse(null);
        for (int i = 0; i < steps.size(); i++) {
            if (i + 1 == stepNo) {
                steps.get(i).setStatus("DONE");
                stepMapper.updateById(steps.get(i));
            }
        }
        boolean allDone = steps.stream().allMatch(st -> "DONE".equals(st.getStatus()));
        KnowledgePoint kp = kpMapper.selectById(s.getKpId());
        if (allDone) {
            s.setStatus("DONE");
            insertMessage(sessionId, "SYS", null, "会话已完成 · 学习报告已同步至画像与报告", null, null);
            // 步骤全部完成：追加路径卡片消息，让学生在对话流内直接看到完整收官路径
            insertMessage(sessionId, "AGENT", "planning",
                    "「" + (finished != null ? finished.getTitle() : "步骤 " + stepNo) + "」已完成，全部步骤已收官。学习路径回顾如下，可点击任意步骤在右侧查看上下文。",
                    "path", Map.of("type", "path", "kp", kp != null ? kp.getKpCode() : ""));
        } else {
            // 自动推进下一步
            int next = steps.stream().filter(st -> "PENDING".equals(st.getStatus()))
                    .mapToInt(SessionStep::getSortOrder).min().orElse(stepNo);
            startStep(userId, sessionId, next);
            // 追加路径更新卡片消息：完成后无需上滑查找，最新学习路径直接出现在当前对话可视区域
            insertMessage(sessionId, "AGENT", "planning",
                    "「" + (finished != null ? finished.getTitle() : "步骤 " + stepNo) + "」已完成，路径已自动推进到下一步。可直接点击下方步骤继续学习。",
                    "path", Map.of("type", "path", "kp", kp != null ? kp.getKpCode() : ""));
            return detail(userId, sessionId);
        }
        s.setUpdatedAt(LocalDateTime.now());
        sessionMapper.updateById(s);
        return detail(userId, sessionId);
    }

    /**
     * 重新规划路径
     */
    @Transactional
    public SessionDto replan(Long userId, Long sessionId) {
        SessionEntity s = ownedSession(userId, sessionId);
        KnowledgePoint kp = kpMapper.selectById(s.getKpId());
        TraceChainResponse chain = knowledgeService.traceChain(kp.getKpCode(), userId);
        List<PathPlanService.PlannedStep> plan = pathPlanService.plan(kp.getKpCode(), kp.getName(), chain);

        stepMapper.delete(new LambdaQueryWrapper<SessionStep>().eq(SessionStep::getSessionId, sessionId));
        for (int i = 0; i < plan.size(); i++) {
            PathPlanService.PlannedStep ps = plan.get(i);
            SessionStep st = new SessionStep();
            st.setSessionId(sessionId);
            st.setSortOrder(i + 1);
            st.setTitle(ps.title);
            st.setDescription(ps.description);
            st.setDurationMin(ps.durationMin);
            st.setStatus(i == 0 ? "ACTIVE" : "PENDING");
            stepMapper.insert(st);
        }
        s.setStatus("ACTIVE");
        s.setStepIndex(0);
        s.setUpdatedAt(LocalDateTime.now());
        sessionMapper.updateById(s);

        int totalMin = plan.stream().mapToInt(p -> p.durationMin).sum();
        insertMessage(sessionId, "AGENT", "planning",
                "已根据你的最新掌握度重新规划路径，共 " + totalMin + " 分钟，从头开始推进。",
                "path", Map.of("type", "path", "kp", kp.getKpCode()));
        return detail(userId, sessionId);
    }

    /**
     * 清空当前用户的全部学习会话（含步骤与消息）。
     * 仅删除 session / session_step / message 三张对话相关表，
     * 练习记录、掌握度、作业等学习数据不受影响。
     *
     * @return 删除的会话数量
     */
    @Transactional
    public int clearAll(Long userId) {
        List<SessionEntity> sessions = sessionMapper.selectList(new LambdaQueryWrapper<SessionEntity>()
                .eq(SessionEntity::getUserId, userId));
        if (sessions.isEmpty()) {
            return 0;
        }
        List<Long> ids = sessions.stream().map(SessionEntity::getId).collect(Collectors.toList());
        messageMapper.delete(new LambdaQueryWrapper<Message>().in(Message::getSessionId, ids));
        stepMapper.delete(new LambdaQueryWrapper<SessionStep>().in(SessionStep::getSessionId, ids));
        sessionMapper.delete(new LambdaQueryWrapper<SessionEntity>().eq(SessionEntity::getUserId, userId));
        return sessions.size();
    }

    /**
     * 校验会话归属并返回
     */
    public SessionEntity ownedSession(Long userId, Long sessionId) {
        SessionEntity s = sessionMapper.selectById(sessionId);
        if (s == null || !s.getUserId().equals(userId)) {
            throw new BizException("会话不存在");
        }
        return s;
    }

    public void touch(Long sessionId) {
        SessionEntity s = sessionMapper.selectById(sessionId);
        if (s != null) {
            s.setUpdatedAt(LocalDateTime.now());
            sessionMapper.updateById(s);
        }
    }

    public Message insertMessage(Long sessionId, String sender, String agentType, String content,
                                 String cardType, Map<String, Object> cardPayload) {
        Message m = new Message();
        m.setSessionId(sessionId);
        m.setSender(sender);
        m.setAgentType(agentType);
        m.setContent(content);
        m.setCardType(cardType);
        m.setCardPayload(cardPayload != null ? toJson(cardPayload) : null);
        m.setCreatedAt(LocalDateTime.now());
        messageMapper.insert(m);
        return m;
    }

    /**
     * 更新消息内容（流式对话完成后回填）
     */
    public void updateMessage(Message m) {
        messageMapper.updateById(m);
    }

    private SessionDto toDto(SessionEntity s, List<SessionStep> steps, List<Message> messages,
                             KnowledgePoint kp, boolean omitMessages) {
        List<SessionDto.StepDto> stepDtos = steps.stream().map(st -> new SessionDto.StepDto(
                st.getTitle(), st.getDescription(), st.getDurationMin() + " 分钟",
                st.getStatus().toLowerCase())).toList();

        List<SessionDto.MessageDto> msgDtos = omitMessages ? List.of() : messages.stream()
                .map(m -> new SessionDto.MessageDto(
                        String.valueOf(m.getId()),
                        m.getSender().toLowerCase(),
                        m.getAgentType(),
                        m.getCreatedAt() != null ? m.getCreatedAt().format(TM) : null,
                        m.getContent(),
                        parseCard(m.getCardType(), m.getCardPayload())))
                .toList();

        List<String> kps = s.getKps() == null || s.getKps().isBlank() ? List.of()
                : Arrays.stream(s.getKps().split(",")).map(String::trim).filter(x -> !x.isEmpty()).toList();
        return new SessionDto(String.valueOf(s.getId()), s.getTitle(),
                kp != null ? kp.getKpCode() : null, kps,
                s.getStatus().toLowerCase(),
                s.getCreatedAt() != null ? s.getCreatedAt().format(DT) : null,
                s.getUpdatedAt() != null ? s.getUpdatedAt().format(DT) : null,
                s.getStepIndex(), stepDtos, msgDtos);
    }

    private Map<String, Object> parseCard(String cardType, String payload) {
        if (cardType == null || payload == null) {
            return null;
        }
        try {
            return objectMapper.readValue(payload,
                    objectMapper.getTypeFactory().constructMapType(LinkedHashMap.class, String.class, Object.class));
        } catch (Exception e) {
            return null;
        }
    }

    private String toJson(Map<String, Object> map) {
        try {
            return objectMapper.writeValueAsString(map);
        } catch (Exception e) {
            return "{}";
        }
    }

    private Long pickExercise(Long kpId) {
        List<Exercise> list = exerciseMapper.selectList(new LambdaQueryWrapper<Exercise>()
                .eq(Exercise::getKpId, kpId));
        if (list.isEmpty()) {
            return null;
        }
        return list.get(new Random().nextInt(list.size())).getId();
    }

    private boolean exerciseCardExists(Long sessionId) {
        return messageMapper.selectCount(new LambdaQueryWrapper<Message>()
                .eq(Message::getSessionId, sessionId)
                .eq(Message::getCardType, "exercise")) > 0;
    }

    private long countKps() {
        return kpMapper.selectCount(new LambdaQueryWrapper<KnowledgePoint>()
                .eq(KnowledgePoint::getLevel, 2));
    }
}
