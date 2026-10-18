package com.la.service;

import com.la.dto.response.TraceChainResponse;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 学习路径推荐算法单元测试
 */
class PathPlanServiceTest {

    private final PathPlanService service = new PathPlanService();

    private TraceChainResponse chain(String rootCause, String... codes) {
        List<TraceChainResponse.ChainNode> nodes = java.util.Arrays.stream(codes)
                .map(c -> new TraceChainResponse.ChainNode(c, c, 50, "note", true))
                .toList();
        return new TraceChainResponse(nodes, rootCause, "结论");
    }

    @Test
    void withRootCause_firstRemedialStepBindsRoot() {
        // 链：[目标, 前置1, 前置2]，根因=前置2
        TraceChainResponse c = chain("kp-2", "kp-target", "kp-1", "kp-2");
        List<PathPlanService.PlannedStep> plan = service.plan("kp-target", "目标", c);

        assertEquals(4, plan.size());
        assertTrue(plan.get(0).title.contains("诊断定位"));
        // 第二步（概念精讲）应绑定根因 kp-2
        assertEquals("kp-2", plan.get(1).bindKp);
        assertTrue(plan.get(1).title.contains("根因补强"));
        assertTrue(plan.get(2).title.contains("代码陪练"));
        assertTrue(plan.get(3).title.contains("巩固测验"));
    }

    @Test
    void withoutRootCause_lectureBindsTarget() {
        TraceChainResponse c = chain(null, "kp-target", "kp-1");
        List<PathPlanService.PlannedStep> plan = service.plan("kp-target", "目标", c);

        assertEquals(4, plan.size());
        assertEquals("kp-target", plan.get(1).bindKp);
        assertFalse(plan.get(1).title.contains("根因补强"));
    }

    @Test
    void totalDuration_is55Minutes() {
        TraceChainResponse c = chain(null, "kp-target");
        List<PathPlanService.PlannedStep> plan = service.plan("kp-target", "目标", c);
        assertEquals(55, plan.stream().mapToInt(p -> p.durationMin).sum());
    }

    @Test
    void emptyChain_stillProducesFourSteps() {
        TraceChainResponse c = new TraceChainResponse(List.of(), null, "无");
        List<PathPlanService.PlannedStep> plan = service.plan("kp-target", "目标", c);
        assertEquals(4, plan.size());
    }
}
