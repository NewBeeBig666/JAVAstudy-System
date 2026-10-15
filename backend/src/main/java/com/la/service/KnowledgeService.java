package com.la.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.dto.response.KnowledgeGraphResponse;
import com.la.dto.response.KnowledgeTreeResponse;
import com.la.dto.response.TraceChainResponse;
import com.la.entity.KpDependency;
import com.la.entity.KnowledgePoint;
import com.la.entity.Mastery;
import com.la.exception.BizException;
import com.la.mapper.KpDependencyMapper;
import com.la.mapper.KnowledgePointMapper;
import com.la.mapper.MasteryMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.*;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
public class KnowledgeService {

    private final KnowledgePointMapper kpMapper;
    private final KpDependencyMapper depMapper;
    private final MasteryMapper masteryMapper;
    private final ObjectMapper objectMapper;

    /**
     * 首屏聚合：模块（一级） + 知识点（二级，含本人掌握度与前置依赖）
     */
    public KnowledgeTreeResponse tree(Long userId) {
        List<KnowledgePoint> all = kpMapper.selectList(null);
        Map<Long, KnowledgePoint> byId = all.stream()
                .collect(Collectors.toMap(KnowledgePoint::getId, k -> k));

        Map<Long, Integer> masteryMap = masteryMap(userId);
        Map<Long, List<Long>> depMap = depMapper.selectList(
                        new LambdaQueryWrapper<KpDependency>().eq(KpDependency::getDepType, "PRE"))
                .stream().collect(Collectors.groupingBy(KpDependency::getKpId,
                        Collectors.mapping(KpDependency::getDepKpId, Collectors.toList())));

        List<KnowledgeTreeResponse.ModuleDto> modules = all.stream()
                .filter(k -> k.getLevel() == 1)
                .sorted(Comparator.comparing(KnowledgePoint::getSortOrder))
                .map(k -> new KnowledgeTreeResponse.ModuleDto(k.getKpCode(), k.getName()))
                .toList();

        List<KnowledgeTreeResponse.KpDto> kps = all.stream()
                .filter(k -> k.getLevel() == 2)
                .sorted(Comparator.comparing(KnowledgePoint::getSortOrder))
                .map(k -> {
                    KnowledgePoint parent = byId.get(k.getParentId());
                    List<String> deps = depMap.getOrDefault(k.getId(), List.of()).stream()
                            .map(id -> byId.get(id).getKpCode())
                            .toList();
                    return new KnowledgeTreeResponse.KpDto(
                            k.getKpCode(), k.getName(),
                            parent != null ? parent.getKpCode() : null,
                            masteryMap.getOrDefault(k.getId(), 0),
                            deps,
                            k.getDescription(),
                            parseResources(k.getResources()));
                }).toList();

        return new KnowledgeTreeResponse(modules, kps);
    }

    public KnowledgeTreeResponse.KpDto detail(String code, Long userId) {
        KnowledgeTreeResponse tree = tree(userId);
        return tree.getKnowledgePoints().stream()
                .filter(k -> code.equals(k.getId()))
                .findFirst()
                .orElseThrow(() -> new BizException("知识点不存在: " + code));
    }

    /**
     * 依赖链溯源：从目标知识点沿 PRE 依赖逐层向下追 weakest 前置，
     * 返回链与最弱根因（链上掌握度<60、离根最近者）
     */
    public TraceChainResponse traceChain(String code, Long userId) {
        List<KnowledgePoint> all = kpMapper.selectList(null);
        Map<Long, KnowledgePoint> byId = all.stream()
                .collect(Collectors.toMap(KnowledgePoint::getId, k -> k));
        Map<String, KnowledgePoint> byCode = all.stream()
                .collect(Collectors.toMap(KnowledgePoint::getKpCode, k -> k));
        Map<Long, Integer> masteryMap = masteryMap(userId);
        Map<Long, List<Long>> depMap = depMapper.selectList(
                        new LambdaQueryWrapper<KpDependency>().eq(KpDependency::getDepType, "PRE"))
                .stream().collect(Collectors.groupingBy(KpDependency::getKpId,
                        Collectors.mapping(KpDependency::getDepKpId, Collectors.toList())));

        KnowledgePoint target = byCode.get(code);
        if (target == null) {
            throw new BizException("知识点不存在: " + code);
        }

        List<KnowledgePoint> chain = new ArrayList<>();
        Set<Long> visited = new HashSet<>();
        KnowledgePoint current = target;
        while (true) {
            chain.add(current);
            visited.add(current.getId());
            List<Long> deps = depMap.getOrDefault(current.getId(), List.of());
            if (deps.isEmpty()) {
                break;
            }
            KnowledgePoint weakest = deps.stream()
                    .map(byId::get)
                    .filter(Objects::nonNull)
                    .min(Comparator.comparingInt(k -> masteryMap.getOrDefault(k.getId(), 0)))
                    .orElse(null);
            if (weakest == null || visited.contains(weakest.getId())) {
                break;
            }
            current = weakest;
        }

        KnowledgePoint rootCause = null;
        for (KnowledgePoint kp : chain) {
            if (masteryMap.getOrDefault(kp.getId(), 0) < 60) {
                rootCause = kp;
            }
        }

        List<TraceChainResponse.ChainNode> nodes = new ArrayList<>();
        for (int i = 0; i < chain.size(); i++) {
            KnowledgePoint kp = chain.get(i);
            String note;
            if (i == 0) {
                note = "目标知识点，直接得分最低";
            } else if (rootCause != null && kp.getId().equals(rootCause.getId())) {
                note = "前置薄弱 · 判定为根本原因";
            } else {
                note = masteryMap.getOrDefault(kp.getId(), 0) >= 60 ? "前置达标" : "前置薄弱";
            }
            nodes.add(new TraceChainResponse.ChainNode(kp.getKpCode(), kp.getName(),
                    masteryMap.getOrDefault(kp.getId(), 0), note));
        }

        String conclusion = rootCause != null
                ? "建议优先补「" + rootCause.getName() + "」，再回到「" + target.getName() + "」。"
                : "前置链整体达标，可直接攻克「" + target.getName() + "」。";
        return new TraceChainResponse(nodes, rootCause != null ? rootCause.getKpCode() : null, conclusion);
    }

    /**
     * 知识图谱全层级（数据源：课程知识点 Excel 全量树，source=XLSX）：
     * 一级模块 + 平铺节点（parentCode 组树）+ PRE 依赖边 + 本人掌握度。
     * 旧 LEGACY 节点不进入图谱与出题选项，保证与 Excel 源一致。
     */
    public KnowledgeGraphResponse graph(Long userId) {
        List<KnowledgePoint> all = kpMapper.selectList(new LambdaQueryWrapper<KnowledgePoint>()
                .eq(KnowledgePoint::getSource, "XLSX")
                .orderByAsc(KnowledgePoint::getSortOrder));
        Map<Long, KnowledgePoint> byId = all.stream()
                .collect(Collectors.toMap(KnowledgePoint::getId, k -> k));
        Map<Long, Integer> masteryMap = masteryMap(userId);
        List<String> moduleColors = List.of("#a78bfa", "#f472b6", "#fbbf24", "#22d3ee", "#60a5fa");

        List<KnowledgeGraphResponse.ModuleDto> modules = new ArrayList<>();
        List<KnowledgeGraphResponse.NodeDto> nodes = new ArrayList<>();
        int mi = 0;
        for (KnowledgePoint k : all) {
            if (k.getLevel() == 1) {
                modules.add(new KnowledgeGraphResponse.ModuleDto(
                        k.getKpCode(), k.getName(),
                        moduleColors.get(Math.min(mi++, moduleColors.size() - 1))));
            }
        }
        for (KnowledgePoint k : all) {
            KnowledgePoint parent = k.getParentId() != null ? byId.get(k.getParentId()) : null;
            Integer mastery = masteryMap.get(k.getId());
            nodes.add(new KnowledgeGraphResponse.NodeDto(
                    k.getKpCode(), k.getName(),
                    parent != null ? parent.getKpCode() : null,
                    k.getModuleCode() != null ? k.getModuleCode() : (k.getLevel() == 1 ? k.getKpCode() : null),
                    k.getLevel(), k.getSortOrder(),
                    mastery != null ? mastery : null,
                    k.getDescription() != null ? k.getDescription() : ""));
        }

        List<KnowledgeGraphResponse.EdgeDto> edges = new ArrayList<>();
        Set<Long> xlsxIds = all.stream().map(KnowledgePoint::getId).collect(Collectors.toSet());
        for (Map.Entry<Long, List<Long>> e : depMap().entrySet()) {
            if (!xlsxIds.contains(e.getKey())) {
                continue;
            }
            for (Long depId : e.getValue()) {
                KnowledgePoint dep = byId.get(depId);
                if (dep != null) {
                    edges.add(new KnowledgeGraphResponse.EdgeDto(
                            byId.get(e.getKey()).getKpCode(), dep.getKpCode()));
                }
            }
        }
        return new KnowledgeGraphResponse(modules, nodes, edges);
    }

    /**
     * 批量读取用户掌握度（kpId -> value）
     */
    public Map<Long, Integer> masteryMap(Long userId) {
        return masteryMapper.selectList(new LambdaQueryWrapper<Mastery>().eq(Mastery::getUserId, userId))
                .stream().collect(Collectors.toMap(Mastery::getKpId, Mastery::getMasteryValue, (a, b) -> a));
    }

    public KnowledgePoint byCode(String code) {
        return kpMapper.selectOne(new LambdaQueryWrapper<KnowledgePoint>()
                .eq(KnowledgePoint::getKpCode, code));
    }

    public KnowledgePoint byId(Long id) {
        return kpMapper.selectById(id);
    }

    /**
     * PRE 依赖映射（kpId -> 前置 kpId 列表）
     */
    public Map<Long, List<Long>> depMap() {
        return depMapper.selectList(new LambdaQueryWrapper<KpDependency>()
                        .eq(KpDependency::getDepType, "PRE"))
                .stream().collect(Collectors.groupingBy(KpDependency::getKpId,
                        Collectors.mapping(KpDependency::getDepKpId, Collectors.toList())));
    }

    private List<String> parseResources(String json) {
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
