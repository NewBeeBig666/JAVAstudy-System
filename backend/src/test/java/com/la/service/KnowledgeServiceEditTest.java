package com.la.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.entity.KnowledgePoint;
import com.la.exception.BizException;
import com.la.mapper.KpDependencyMapper;
import com.la.mapper.KnowledgePointMapper;
import com.la.mapper.MasteryMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.Spy;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.Objects;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 教师端知识图谱编辑能力单元测试：
 * 覆盖一级模块新增（parentCode 为空）/ 无层级上限 / 一级模块可删 /
 * 属性编辑与同级去重 / 移动环检测（后代目标拒绝）/ 移动子树级联重算 / 批量删除并集
 */
@ExtendWith(MockitoExtension.class)
class KnowledgeServiceEditTest {

    @Mock private KnowledgePointMapper kpMapper;
    @Mock private KpDependencyMapper depMapper;
    @Mock private MasteryMapper masteryMapper;
    @Spy  private ObjectMapper objectMapper = new ObjectMapper();

    @InjectMocks private KnowledgeService service;

    private KnowledgePoint node(long id, String code, Long parentId, int level, String moduleCode) {
        KnowledgePoint k = new KnowledgePoint();
        k.setId(id);
        k.setKpCode(code);
        k.setName("节点" + id);
        k.setParentId(parentId);
        k.setLevel(level);
        k.setModuleCode(moduleCode);
        k.setSource(level == 1 ? "XLSX" : "CUSTOM");
        k.setDeleted(0);
        k.setSortOrder((int) id);
        return k;
    }

    /** parentCode 为空 = 新增一级模块：level=1、parentId=null、moduleCode=自身编码 */
    @Test
    void addChildNode_nullParent_createsLevel1Module() {
        when(kpMapper.selectList(any())).thenReturn(List.of());

        service.addChildNode(9L, null, "项目实战");

        verify(kpMapper).insert(argThat((KnowledgePoint x) ->
                x.getLevel() == 1
                        && x.getParentId() == null
                        && x.getKpCode() != null && x.getKpCode().equals(x.getModuleCode())
                        && "项目实战".equals(x.getName())
                        && "CUSTOM".equals(x.getSource())
                        && x.getDeleted() == 0));
        verify(kpMapper, never()).selectOne(any());
    }

    /** 层级不设上限：第 7 级父节点下新增子节点应为第 8 级（旧实现钳制为 7） */
    @Test
    void addChildNode_level7Parent_childIsLevel8() {
        KnowledgePoint parent = node(7L, "p7", 6L, 7, "m1");
        when(kpMapper.selectOne(any())).thenReturn(parent);
        when(kpMapper.selectCount(any())).thenReturn(0L);
        when(kpMapper.selectList(any())).thenReturn(List.of());

        service.addChildNode(9L, "p7", "第八级");

        verify(kpMapper).insert(argThat((KnowledgePoint x) ->
                x.getLevel() == 8 && Long.valueOf(7L).equals(x.getParentId())
                        && "m1".equals(x.getModuleCode())));
    }

    /** 数据校验：空白名称拒绝；超长名称拒绝 */
    @Test
    void addChildNode_blankOrOverlongName_throws() {
        assertThrows(BizException.class, () -> service.addChildNode(9L, null, "  "));
        assertThrows(BizException.class, () -> service.addChildNode(9L, null, "a".repeat(51)));
        verify(kpMapper, never()).insert(any(KnowledgePoint.class));
    }

    /** 一级模块可删除：删除入口不再因 level=1 拒绝，且级联软删除整棵子树 */
    @Test
    void deleteNode_level1Module_cascadesSubtreeSoftDelete() {
        KnowledgePoint root = node(1L, "m1", null, 1, "m1");
        KnowledgePoint child = node(2L, "c1", 1L, 2, "m1");
        when(kpMapper.selectOne(any())).thenReturn(root);
        when(kpMapper.selectList(any())).thenReturn(List.of(root, child));

        service.deleteNode(9L, "m1");

        verify(kpMapper).update(argThat((KnowledgePoint x) -> x.getDeleted() == 1), any());
    }

    /** 数据校验：删除不存在的编码给出明确错误 */
    @Test
    void deleteNode_notFound_throws() {
        when(kpMapper.selectOne(any())).thenReturn(null);
        assertThrows(BizException.class, () -> service.deleteNode(9L, "nope"));
        verify(kpMapper, never()).update(any(), any());
    }

    /** 属性编辑：名称与描述更新；同级兄弟重名拒绝 */
    @Test
    void updateNode_renamesAndSetsDescription() {
        KnowledgePoint target = node(3L, "c1", 1L, 2, "m1");
        target.setDescription("旧描述");
        when(kpMapper.selectOne(any())).thenReturn(target);
        when(kpMapper.selectCount(any())).thenReturn(0L);

        service.updateNode(9L, "c1", "新名称", "新描述");

        verify(kpMapper).update(argThat((KnowledgePoint x) ->
                "新名称".equals(x.getName()) && "新描述".equals(x.getDescription())), any());
    }

    @Test
    void updateNode_siblingDuplicateName_throws() {
        when(kpMapper.selectOne(any())).thenReturn(node(3L, "c1", 1L, 2, "m1"));
        when(kpMapper.selectCount(any())).thenReturn(1L);

        assertThrows(BizException.class, () -> service.updateNode(9L, "c1", "重名", ""));
        verify(kpMapper, never()).update(any(), any());
    }

    /** 环检测：把祖先节点移动到自己的后代下必须拒绝（否则形成环） */
    @Test
    void moveNode_toOwnDescendant_throwsCycle() {
        KnowledgePoint a = node(1L, "a", null, 1, "a");
        KnowledgePoint b = node(2L, "b", 1L, 2, "a");
        KnowledgePoint c = node(3L, "c", 2L, 3, "a");
        when(kpMapper.selectOne(any())).thenReturn(a);
        when(kpMapper.selectList(any())).thenReturn(List.of(a, b, c));

        assertThrows(BizException.class, () -> service.moveNode(9L, "a", "c"));
        verify(kpMapper, never()).update(any(), any());
    }

    /** 移动到自身节点下拒绝 */
    @Test
    void moveNode_toSelf_throws() {
        KnowledgePoint a = node(1L, "a", null, 1, "a");
        when(kpMapper.selectOne(any())).thenReturn(a);
        when(kpMapper.selectList(any())).thenReturn(List.of(a));

        assertThrows(BizException.class, () -> service.moveNode(9L, "a", "a"));
        verify(kpMapper, never()).update(any(), any());
    }

    /** 跨模块移动：子树整体随迁，级联重算 level 与 moduleCode */
    @Test
    void moveNode_crossModule_recalculatesSubtreeLevelsAndModules() {
        KnowledgePoint m1 = node(1L, "m1", null, 1, "m1");
        KnowledgePoint b = node(2L, "b", 1L, 2, "m1");       // 被移动节点（带一个子节点 c）
        KnowledgePoint c = node(3L, "c", 2L, 3, "m1");
        KnowledgePoint m2 = node(4L, "m2", null, 1, "m2");
        KnowledgePoint x = node(5L, "x", 4L, 2, "m2");       // 新父（L2 → b 变 L3）
        when(kpMapper.selectOne(any())).thenReturn(b);
        when(kpMapper.selectList(any())).thenReturn(List.of(m1, b, c, m2, x));

        service.moveNode(9L, "b", "x");

        ArgumentCaptor<KnowledgePoint> upd = ArgumentCaptor.forClass(KnowledgePoint.class);
        verify(kpMapper, times(2)).update(upd.capture(), any());
        KnowledgePoint moved = upd.getAllValues().stream()
                .filter(u -> Long.valueOf(5L).equals(u.getParentId())).findFirst().orElse(null);
        KnowledgePoint child = upd.getAllValues().stream()
                .filter(u -> u.getParentId() == null).findFirst().orElse(null);
        // 被移动节点：挂到 x 下、level 3、模块归属切换为 m2
        assertEquals(3, moved.getLevel());
        assertEquals("m2", moved.getModuleCode());
        // 后代子节点 c：level 4（跟随 +1）、模块归属同步切换为 m2
        assertEquals(4, child.getLevel());
        assertEquals("m2", child.getModuleCode());
    }

    /** 移为一级模块：parentId 置空、level=1、moduleCode=自身编码，子节点跟随重算。
     *  被移动根节点走 UpdateWrapper 显式 SET parent_id=NULL 分支（MyBatis-Plus 实体
     *  更新默认跳过 null 字段，实体 setParentId(null) 不会生成 SET parent_id=NULL），
     *  实体参数为 null；子节点仍走实体更新。 */
    @Test
    void moveNode_toRoot_promotesToLevel1() {
        KnowledgePoint m1 = node(1L, "m1", null, 1, "m1");
        KnowledgePoint b = node(2L, "b", 1L, 2, "m1");
        KnowledgePoint c = node(3L, "c", 2L, 3, "m1");
        when(kpMapper.selectOne(any())).thenReturn(b);
        when(kpMapper.selectList(any())).thenReturn(List.of(m1, b, c));

        service.moveNode(9L, "b", null);

        ArgumentCaptor<KnowledgePoint> upd = ArgumentCaptor.forClass(KnowledgePoint.class);
        verify(kpMapper, times(2)).update(upd.capture(), any());
        // 根节点走显式 NULL 更新（实体参数为 null），后代走实体更新：
        // 两次调用恰为一 null 一非 null（HashMap 遍历顺序不定，不按下标断言）
        assertTrue(upd.getAllValues().stream().anyMatch(Objects::isNull));
        KnowledgePoint child = upd.getAllValues().stream()
                .filter(Objects::nonNull)
                .findFirst().orElseThrow();
        // 子节点 c 跟随：level 2、模块归属改为 b
        assertEquals(2, child.getLevel());
        assertEquals("b", child.getModuleCode());
        // 根节点的显式置空更新：确认 wrapper 更新确实被触发（生成 SET parent_id=NULL）
        verify(kpMapper, times(1)).update(argThat(u -> u == null), argThat(w -> w != null));
    }

    /** 批量删除：多棵子树并集后一次 UPDATE（单事务原子生效），空列表拒绝 */
    @Test
    void batchDelete_mergesSubtrees_singleAtomicUpdate() {
        KnowledgePoint root = node(1L, "m1", null, 1, "m1");
        KnowledgePoint b = node(2L, "b", 1L, 2, "m1");
        KnowledgePoint c = node(3L, "c", 2L, 3, "m1");
        KnowledgePoint d = node(4L, "d", 1L, 2, "m1");
        when(kpMapper.selectList(any())).thenReturn(List.of(root, b, c, d));

        service.batchDelete(9L, List.of("b", "d"));

        // b（含子节点 c）与 d 并集后仅执行一次软删除 UPDATE
        verify(kpMapper, times(1)).update(argThat((KnowledgePoint x) -> x.getDeleted() == 1), any());
    }

    @Test
    void batchDelete_emptySelection_throws() {
        assertThrows(BizException.class, () -> service.batchDelete(9L, List.of()));
        verify(kpMapper, never()).update(any(), any());
    }

    /** 完全重置：恢复软删除 + 物理清除自定义节点 + 按初始快照还原结构字段（三步齐备） */
    @Test
    void reset_restoresSoftDeleted_clearsCustom_andRestoresSnapshot() {
        service.reset(9L);

        // ① 软删除恢复（deleted=0）② CUSTOM 物理清除 ③ 快照结构还原（撤销移动/改名/改描述）
        verify(kpMapper).update(argThat((KnowledgePoint x) -> x.getDeleted() == 0), any());
        verify(kpMapper).delete(any());
        verify(kpMapper).restoreFromSnapshot();
    }
}
