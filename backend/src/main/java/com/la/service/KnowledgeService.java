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
        // 根因判定：仅有掌握数据（做过练习/作业）且 <60 分的节点才构成"卡住"根因；
        // 无数据节点显示 0 是缺数据而非真薄弱，不参与判定
        for (KnowledgePoint kp : chain) {
            if (masteryMap.containsKey(kp.getId()) && masteryMap.get(kp.getId()) < 60) {
                rootCause = kp;
            }
        }
        boolean targetHasData = masteryMap.containsKey(target.getId());

        List<TraceChainResponse.ChainNode> nodes = new ArrayList<>();
        for (int i = 0; i < chain.size(); i++) {
            KnowledgePoint kp = chain.get(i);
            boolean hasData = masteryMap.containsKey(kp.getId());
            int mastery = masteryMap.getOrDefault(kp.getId(), 0);
            String note;
            if (!hasData) {
                note = "暂无数据 · 需练习收集";
            } else if (i == 0) {
                note = "目标知识点，直接得分最低";
            } else if (rootCause != null && kp.getId().equals(rootCause.getId())) {
                note = "前置薄弱 · 判定为根本原因";
            } else {
                note = mastery >= 60 ? "前置达标" : "前置薄弱";
            }
            nodes.add(new TraceChainResponse.ChainNode(kp.getKpCode(), kp.getName(),
                    mastery, note, hasData));
        }

        String conclusion;
        if (!targetHasData) {
            conclusion = "「" + target.getName() + "」暂无掌握数据——掌握度由学习会话的练习与教师批改的作业自动收集，去做几道练习即可生成前置链诊断。";
        } else if (rootCause != null && rootCause.getId().equals(target.getId())) {
            conclusion = "「" + target.getName() + "」（" + masteryMap.get(target.getId()) + " 分）正是当前链上最薄弱的环节，建议直接攻克它，从做一道练习开始。";
        } else if (rootCause != null) {
            conclusion = "建议优先补「" + rootCause.getName() + "」，再回到「" + target.getName() + "」。";
        } else {
            conclusion = "前置链整体达标，可直接攻克「" + target.getName() + "」。";
        }
        return new TraceChainResponse(nodes, rootCause != null ? rootCause.getKpCode() : null, conclusion);
    }

    /**
     * 知识图谱全层级（数据源：课程知识点 Excel 全量树，source=XLSX）：
     * 一级模块 + 平铺节点（parentCode 组树）+ PRE 依赖边 + 本人掌握度。
     * 旧 LEGACY 节点不进入图谱与出题选项，保证与 Excel 源一致。
     */
    public KnowledgeGraphResponse graph(Long userId) {
        List<KnowledgePoint> all = kpMapper.selectList(new LambdaQueryWrapper<KnowledgePoint>()
                .in(KnowledgePoint::getSource, "XLSX", "CUSTOM")
                .eq(KnowledgePoint::getDeleted, 0)
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

    /* ==================== 教师端图谱维护：添加子节点 / 删除子树 / 重置 ====================
     * 自定义节点 source=CUSTOM（重置时物理清除）；删除为软删除（deleted=1 级联子树，
     * 重置恢复），掌握度/练习/资源关联等业务数据一律不动。 */

    /** 添加子知识点：挂到指定父节点下（level 继承 +1，模块归属继承，source=CUSTOM） */
    @org.springframework.transaction.annotation.Transactional
    public KnowledgeGraphResponse addChildNode(Long teacherId, String parentCode, String name) {
        if (name == null || name.isBlank()) {
            throw new BizException("请输入知识点名称");
        }
        name = name.trim();
        if (name.length() > 50) {
            throw new BizException("知识点名称不能超过 50 字");
        }
        KnowledgePoint parent = kpMapper.selectOne(new LambdaQueryWrapper<KnowledgePoint>()
                .eq(KnowledgePoint::getKpCode, parentCode)
                .eq(KnowledgePoint::getDeleted, 0));
        if (parent == null) {
            throw new BizException("父知识点不存在或已被删除");
        }
        // 同名兄弟去重提示（允许跨层级同名，如不同模块都有「泛型」）
        Long same = kpMapper.selectCount(new LambdaQueryWrapper<KnowledgePoint>()
                .eq(KnowledgePoint::getParentId, parent.getId())
                .eq(KnowledgePoint::getName, name)
                .eq(KnowledgePoint::getDeleted, 0));
        if (same > 0) {
            throw new BizException("「" + parent.getName() + "」下已存在同名子知识点「" + name + "」");
        }
        Integer maxSort = kpMapper.selectList(new LambdaQueryWrapper<KnowledgePoint>()
                        .eq(KnowledgePoint::getParentId, parent.getId()))
                .stream().map(KnowledgePoint::getSortOrder)
                .filter(Objects::nonNull).max(Integer::compareTo).orElse(0);
        KnowledgePoint node = new KnowledgePoint();
        node.setKpCode("cst-" + System.currentTimeMillis());
        node.setName(name);
        node.setParentId(parent.getId());
        node.setLevel(Math.min((parent.getLevel() == null ? 2 : parent.getLevel()) + 1, 7));
        node.setModuleCode(parent.getLevel() != null && parent.getLevel() == 1
                ? parent.getKpCode() : parent.getModuleCode());
        node.setSource("CUSTOM");
        node.setUnitNo(parent.getUnitNo());
        node.setDescription("");
        node.setSortOrder(maxSort + 1);
        node.setDeleted(0);
        kpMapper.insert(node);
        return graph(teacherId);
    }

    /** 删除知识点（级联软删除整个子树；一级模块节点不可删，防止破坏模块结构） */
    @org.springframework.transaction.annotation.Transactional
    public KnowledgeGraphResponse deleteNode(Long teacherId, String code) {
        KnowledgePoint target = kpMapper.selectOne(new LambdaQueryWrapper<KnowledgePoint>()
                .eq(KnowledgePoint::getKpCode, code)
                .eq(KnowledgePoint::getDeleted, 0));
        if (target == null) {
            throw new BizException("知识点不存在或已被删除");
        }
        if (target.getLevel() != null && target.getLevel() == 1) {
            throw new BizException("一级模块不可删除（如需调整请联系管理员）");
        }
        // 收集整个子树（含目标自身）统一软删除
        List<KnowledgePoint> all = kpMapper.selectList(new LambdaQueryWrapper<KnowledgePoint>()
                .in(KnowledgePoint::getSource, "XLSX", "CUSTOM"));
        Map<Long, List<KnowledgePoint>> byParent = all.stream()
                .collect(Collectors.groupingBy(k -> k.getParentId() == null ? -1L : k.getParentId()));
        List<Long> subtree = new ArrayList<>();
        Deque<Long> stack = new ArrayDeque<>();
        stack.push(target.getId());
        while (!stack.isEmpty()) {
            Long cur = stack.pop();
            if (subtree.contains(cur)) {
                continue;
            }
            subtree.add(cur);
            byParent.getOrDefault(cur, List.of()).forEach(c -> stack.push(c.getId()));
        }
        KnowledgePoint upd = new KnowledgePoint();
        upd.setDeleted(1);
        kpMapper.update(upd, new LambdaQueryWrapper<KnowledgePoint>()
                .in(KnowledgePoint::getId, subtree));
        return graph(teacherId);
    }

    /** 统计子树规模（前端删除确认弹窗展示），不含目标自身 */
    public int subtreeSize(String code) {
        KnowledgePoint target = kpMapper.selectOne(new LambdaQueryWrapper<KnowledgePoint>()
                .eq(KnowledgePoint::getKpCode, code).eq(KnowledgePoint::getDeleted, 0));
        if (target == null) {
            return 0;
        }
        List<KnowledgePoint> all = kpMapper.selectList(new LambdaQueryWrapper<KnowledgePoint>()
                .in(KnowledgePoint::getSource, "XLSX", "CUSTOM"));
        Map<Long, List<KnowledgePoint>> byParent = all.stream()
                .collect(Collectors.groupingBy(k -> k.getParentId() == null ? -1L : k.getParentId()));
        int n = 0;
        Deque<Long> stack = new ArrayDeque<>();
        stack.push(target.getId());
        Set<Long> seen = new HashSet<>();
        while (!stack.isEmpty()) {
            Long cur = stack.pop();
            if (!seen.add(cur)) {
                continue;
            }
            for (KnowledgePoint c : byParent.getOrDefault(cur, List.of())) {
                n++;
                stack.push(c.getId());
            }
        }
        return n;
    }

    /** 重置图谱：恢复所有软删除的课程体系节点 + 物理清除自定义节点（还原默认状态） */
    @org.springframework.transaction.annotation.Transactional
    public KnowledgeGraphResponse reset(Long teacherId) {
        KnowledgePoint upd = new KnowledgePoint();
        upd.setDeleted(0);
        kpMapper.update(upd, new LambdaQueryWrapper<KnowledgePoint>()
                .eq(KnowledgePoint::getDeleted, 1));
        kpMapper.delete(new LambdaQueryWrapper<KnowledgePoint>()
                .eq(KnowledgePoint::getSource, "CUSTOM"));
        return graph(teacherId);
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
