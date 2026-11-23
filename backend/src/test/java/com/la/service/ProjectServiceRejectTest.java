package com.la.service;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.entity.CodingProject;
import com.la.entity.ProjectVersion;
import com.la.entity.StudentProject;
import com.la.exception.BizException;
import com.la.mapper.ClassCoTeacherMapper;
import com.la.mapper.ClassMapper;
import com.la.mapper.CodingProjectMapper;
import com.la.mapper.ProjectVersionMapper;
import com.la.mapper.StudentProjectMapper;
import com.la.mapper.UserMapper;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.Spy;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.LocalDateTime;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 「教师打回代码」单元测试：
 * 覆盖打回成功全链路（作废草稿/标记理由/迭代回退/通知学生）、
 *       权限边界（非受控项目拒绝、非最新已提交版本拒绝）、理由校验（空/超长）、
 *       学生重做提交后打回状态复位（keep 覆盖同版本号）
 */
@ExtendWith(MockitoExtension.class)
class ProjectServiceRejectTest {

    @Mock private CodingProjectMapper codingProjectMapper;
    @Mock private StudentProjectMapper studentProjectMapper;
    @Mock private ProjectVersionMapper projectVersionMapper;
    @Mock private UserMapper userMapper;
    @Mock private ClassMapper classMapper;
    @Mock private ClassCoTeacherMapper classCoTeacherMapper;
    @Mock private NotificationService notificationService;
    @Spy  private ObjectMapper objectMapper = new ObjectMapper();

    @InjectMocks private ProjectService service;

    /** 初始化 ProjectVersion 表元数据：单测环境无 MyBatis-Plus 启动流程，
     *  LambdaUpdateWrapper 解析列名依赖该缓存（否则 can not find lambda cache） */
    @BeforeAll
    static void initTableInfo() {
        TableInfoHelper.initTableInfo(new MapperBuilderAssistant(new MybatisConfiguration(), ""), ProjectVersion.class);
    }

    private static final String FILES = "[{\"path\":\"Main.java\",\"content\":\"public class Main { public static void main(String[] a) {} }\"}]";
    private static final String ROADMAP = "[{\"name\":\"环境搭建\",\"title\":\"第1周\",\"desc\":\"完成菜单\"},{\"name\":\"\",\"title\":\"第2周\",\"desc\":\"完成增删改查\"}]";

    private CodingProject cp(boolean controlled) {
        CodingProject p = new CodingProject();
        p.setId(5L);
        p.setClassId(1L);
        p.setTeacherId(2L);
        p.setTitle("测试项目");
        p.setDescription("需求说明");
        p.setStatus("PUBLISHED");
        p.setRoadmap(ROADMAP);
        p.setControlledIteration(controlled ? 1 : 0);
        return p;
    }

    /** 学生项目：curIter=当前迭代，watermark=提交水位（null=从未提交） */
    private StudentProject sp(Integer curIter, Integer watermark) {
        StudentProject sp = new StudentProject();
        sp.setId(9L);
        sp.setProjectId(5L);
        sp.setStudentId(15L);
        sp.setStatus("IN_PROGRESS");
        sp.setCurrentIteration(curIter);
        sp.setSubmittedVersionNo(watermark);
        sp.setCreatedAt(LocalDateTime.now());
        sp.setUpdatedAt(LocalDateTime.now());
        return sp;
    }

    private ProjectVersion version(int no) {
        ProjectVersion v = new ProjectVersion();
        v.setId(100L + no);
        v.setStudentProjectId(9L);
        v.setVersionNo(no);
        v.setFiles(FILES);
        v.setCodeSize(10);
        v.setCreatedAt(LocalDateTime.now());
        return v;
    }

    /** 打回成功全链路：作废水位之上草稿 + 标记打回理由 + 迭代回退 + 站内通知学生 */
    @Test
    void reject_latestSubmittedOnControlled_marksAndNotifies() {
        ProjectVersion v2 = version(2);
        when(projectVersionMapper.selectById(102L)).thenReturn(v2);
        when(projectVersionMapper.selectList(any())).thenReturn(List.of(v2, version(1)));
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(2, 2));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp(true));

        service.rejectVersion(2L, 102L, " 菜单删除功能缺失，请补全后重交 ");

        // ① 作废打回版本之上的未提交草稿
        verify(projectVersionMapper).delete(any());
        // ② 版本标记打回状态与理由（理由去首尾空白）
        verify(projectVersionMapper).updateById(argThat((ProjectVersion v) ->
                v.getRejected() == 1 && "菜单删除功能缺失，请补全后重交".equals(v.getRejectReason())));
        // ③ 学生当前迭代回退到被打回版本号（重做同版本号）
        verify(studentProjectMapper).updateById(argThat((StudentProject x) -> x.getCurrentIteration() == 2));
        // ④ 站内通知学生（含打回理由）
        verify(notificationService).push(eq(15L), contains("已被教师打回"), eq("PROJECT"));
    }

    /** 权限边界：非受控（未开启控制版本迭代）项目打回被拒绝 */
    @Test
    void reject_onFreeProject_throws() {
        when(projectVersionMapper.selectById(102L)).thenReturn(version(2));
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(2, 2));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp(false));

        BizException e = assertThrows(BizException.class,
                () -> service.rejectVersion(2L, 102L, "理由"));
        assertTrue(e.getMessage().contains("控制版本迭代"));
        verify(projectVersionMapper, never()).updateById(any(ProjectVersion.class));
        verify(notificationService, never()).push(any(), any(), any());
    }

    /** 权限边界：链式打回严格逆序——更新版本未打回时直接打回历史版本被拒（不可跳过） */
    @Test
    void reject_historyVersion_throws() {
        when(projectVersionMapper.selectById(101L)).thenReturn(version(1));
        when(projectVersionMapper.selectList(any())).thenReturn(List.of(version(2), version(1)));
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(2, 2));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp(true));

        BizException e = assertThrows(BizException.class,
                () -> service.rejectVersion(2L, 101L, "理由"));
        assertTrue(e.getMessage().contains("当前可打回版本为 v2"));
        verify(projectVersionMapper, never()).updateById(any(ProjectVersion.class));
    }

    /** 理由校验：空白理由拒绝（前端弹窗与后端双重校验） */
    @Test
    void reject_blankReason_throws() {
        when(projectVersionMapper.selectById(102L)).thenReturn(version(2));
        when(projectVersionMapper.selectList(any())).thenReturn(List.of(version(2), version(1)));
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(2, 2));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp(true));

        BizException e = assertThrows(BizException.class,
                () -> service.rejectVersion(2L, 102L, "   "));
        assertTrue(e.getMessage().contains("打回理由"));
    }

    /** 理由校验：超过 500 字拒绝（与弹窗 maxlength 一致） */
    @Test
    void reject_reasonTooLong_throws() {
        when(projectVersionMapper.selectById(102L)).thenReturn(version(2));
        when(projectVersionMapper.selectList(any())).thenReturn(List.of(version(2), version(1)));
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(2, 2));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp(true));

        BizException e = assertThrows(BizException.class,
                () -> service.rejectVersion(2L, 102L, "理".repeat(501)));
        assertTrue(e.getMessage().contains("500"));
    }

    /** 打回闭环：学生重做后 keep+提交同一版本号 → 打回状态与理由复位（版本号不变） */
    @Test
    void save_resubmitRejectedVersion_resetsRejectState() {
        ProjectVersion v2 = version(2);
        v2.setRejected(1);
        v2.setRejectReason("菜单删除功能缺失");
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(2, 2));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp(true));
        when(projectVersionMapper.selectOne(any())).thenReturn(v2);

        service.save(15L, 9L, FILES, "补全删除功能后重交", true, "keep", null);

        // 覆盖更新同一版本（无新建）且打回状态复位；提交水位保持 v2，迭代封顶 v2
        verify(projectVersionMapper).updateById(argThat((ProjectVersion v) ->
                v.getVersionNo() == 2 && v.getRejected() == 0 && v.getRejectReason() == null));
        // reject_reason 显式置空的条件更新必须触发（updateById 默认跳过 null 字段，理由才会残留）
        verify(projectVersionMapper).update(isNull(), any());
        verify(projectVersionMapper, never()).insert(any(ProjectVersion.class));
        verify(studentProjectMapper).updateById(argThat((StudentProject x) ->
                x.getSubmittedVersionNo() == 2 && x.getCurrentIteration() == 2));
    }

    /** 打回后重做期间的保存（未提交）：打回状态保持，不复位（仅提交动作解除打回） */
    @Test
    void save_rejectedVersionWithoutSubmit_keepsRejectState() {
        ProjectVersion v2 = version(2);
        v2.setRejected(1);
        v2.setRejectReason("菜单删除功能缺失");
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(2, 2));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp(true));
        when(projectVersionMapper.selectOne(any())).thenReturn(v2);

        service.save(15L, 9L, FILES, "修改中", false, "keep", null);

        assertEquals(Integer.valueOf(1), v2.getRejected());
        // 未提交不触发打回状态清零的条件更新
        verify(projectVersionMapper, never()).update(isNull(), any());
        verify(studentProjectMapper).updateById(argThat((StudentProject x) -> x.getCurrentIteration() == 2));
    }

    /* ==================== 链式打回（逆序依次开放上一版本打回入口） ==================== */

    /** 链式打回：依次打回 v3→v2→v1，每步打回后其紧邻上一版本自动获得打回入口，迭代逐步回退 */
    @Test
    void reject_chain_opensPreviousVersionInReverseOrder() {
        ProjectVersion v1 = version(1), v2 = version(2), v3 = version(3);
        // 已提交清单（降序）返回同一组实体：service 对 rejected 的修改在后续打回判定中实时生效
        when(projectVersionMapper.selectList(any())).thenReturn(List.of(v3, v2, v1));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp(true));
        // 每次打回读取独立的 sp 实例（避免同一可变对象导致 argThat 延迟求值错位）
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(3, 3), sp(3, 3), sp(2, 3));

        when(projectVersionMapper.selectById(103L)).thenReturn(v3);
        service.rejectVersion(2L, 103L, "打回v3");
        verify(studentProjectMapper).updateById(argThat((StudentProject x) -> x.getCurrentIteration() == 3));

        // v3 已打回 → v2 自动获得入口
        when(projectVersionMapper.selectById(102L)).thenReturn(v2);
        service.rejectVersion(2L, 102L, "打回v2");
        assertEquals(Integer.valueOf(1), v3.getRejected());
        assertEquals(Integer.valueOf(1), v2.getRejected());
        // v1 尚未进入打回链（保持未打回：null 与 0 均视为未打回）
        assertTrue(v1.getRejected() == null || v1.getRejected() != 1);
        verify(studentProjectMapper).updateById(argThat((StudentProject x) -> x.getCurrentIteration() == 2));

        // v2 已打回 → v1 自动获得入口；v1 打回后迭代回退至 v1
        when(projectVersionMapper.selectById(101L)).thenReturn(v1);
        service.rejectVersion(2L, 101L, "打回v1");
        assertEquals(Integer.valueOf(1), v1.getRejected());
        verify(studentProjectMapper).updateById(argThat((StudentProject x) -> x.getCurrentIteration() == 1));
    }

    /** 跳过中间版本直接打回更早版本：两个阶段均被拒（严格逆序不可跳过） */
    @Test
    void reject_skipIntermediate_throws() {
        ProjectVersion v1 = version(1), v3 = version(3);
        when(projectVersionMapper.selectList(any())).thenReturn(List.of(v3, version(2), v1));
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(3, 3));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp(true));
        when(projectVersionMapper.selectById(101L)).thenReturn(v1);
        when(projectVersionMapper.selectById(103L)).thenReturn(v3);

        // 阶段一：v3 未打回时直接打回 v1 → 被拒（当前可打回为 v3）
        BizException e1 = assertThrows(BizException.class,
                () -> service.rejectVersion(2L, 101L, "跳过"));
        assertTrue(e1.getMessage().contains("当前可打回版本为 v3"));

        // 阶段二：打回 v3 后跳过 v2 直接打回 v1 → 仍被拒（当前可打回为 v2）
        service.rejectVersion(2L, 103L, "先打最新");
        BizException e2 = assertThrows(BizException.class,
                () -> service.rejectVersion(2L, 101L, "跳过"));
        assertTrue(e2.getMessage().contains("当前可打回版本为 v2"));
    }

    /** 单版本提交场景：打回 v1 后无更早版本可开放入口（全部已提交版本均已被打回） */
    @Test
    void reject_singleVersion_exhausted_throws() {
        ProjectVersion v1 = version(1);
        when(projectVersionMapper.selectList(any())).thenReturn(List.of(v1));
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(1, 1));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp(true));
        when(projectVersionMapper.selectById(101L)).thenReturn(v1);

        service.rejectVersion(2L, 101L, "唯一版本打回");

        // 再次打回：无更早版本可开放 → 被拒
        BizException e = assertThrows(BizException.class,
                () -> service.rejectVersion(2L, 101L, "再打回"));
        assertTrue(e.getMessage().contains("全部已提交版本均已被打回"));
    }

    /** 链式重做：keep 覆盖最深被打回版本 v1（而非最新行 v2），提交复位 v1、v2 保持打回、水位不降、迭代停 v2 */
    @Test
    void save_chainRedo_overwritesDeepestRejected() {
        ProjectVersion v2 = version(2);
        v2.setRejected(1);                          // v2 亦处于打回链中
        ProjectVersion v1 = version(1);
        v1.setRejected(1);
        v1.setRejectReason("打回v1");
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(1, 2));   // curIter=1（最深打回），水位=2
        when(codingProjectMapper.selectById(5L)).thenReturn(cp(true));
        // selectOne 两次调用：第一次取最新版本（v2），第二次取重做目标（v1，行锁）
        when(projectVersionMapper.selectOne(any())).thenReturn(v2, v1);

        service.save(15L, 9L, FILES, "重做v1", true, "keep", null);

        // 覆盖目标是 v1 行（id=101）且打回状态复位；无新建版本
        verify(projectVersionMapper).updateById(argThat((ProjectVersion v) ->
                v.getId() == 101L && v.getRejected() == 0 && v.getRejectReason() == null));
        verify(projectVersionMapper).update(isNull(), any());
        verify(projectVersionMapper, never()).insert(any(ProjectVersion.class));
        // 水位只升不降（保持 2，v2 对教师仍可见）；迭代停在下一个待重做版本 v2（封顶 2 迭代内）
        verify(studentProjectMapper).updateById(argThat((StudentProject x) ->
                x.getSubmittedVersionNo() == 2 && x.getCurrentIteration() == 2));
    }

    /** 链式重做期间禁止迭代新版本：仅可覆盖重做当前最深被打回版本（防直调 API 越界） */
    @Test
    void save_chainRedoIterate_blocked() {
        ProjectVersion v2 = version(2);
        ProjectVersion v1 = version(1);
        v1.setRejected(1);
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(1, 2));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp(true));
        when(projectVersionMapper.selectOne(any())).thenReturn(v2, v1);

        BizException e = assertThrows(BizException.class,
                () -> service.save(15L, 9L, FILES, "越界", false, "iterate", null));
        assertTrue(e.getMessage().contains("当前迭代为 v1"));
        verify(projectVersionMapper, never()).insert(any(ProjectVersion.class));
    }

    /** 链式重做未提交：仅覆盖保存最深被打回版本，打回状态保持（重做未完成，迭代不推进） */
    @Test
    void save_chainRedoWithoutSubmit_keepsRejected() {
        ProjectVersion v2 = version(2);
        ProjectVersion v1 = version(1);
        v1.setRejected(1);
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(1, 2));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp(true));
        when(projectVersionMapper.selectOne(any())).thenReturn(v2, v1);

        service.save(15L, 9L, FILES, "重做中", false, "keep", null);

        // 覆盖到 v1 行但打回状态保持、不触发清零条件更新
        verify(projectVersionMapper).updateById(argThat((ProjectVersion v) -> v.getId() == 101L && v.getRejected() == 1));
        verify(projectVersionMapper, never()).update(isNull(), any());
        verify(studentProjectMapper).updateById(argThat((StudentProject x) -> x.getCurrentIteration() == 1));
    }
}
