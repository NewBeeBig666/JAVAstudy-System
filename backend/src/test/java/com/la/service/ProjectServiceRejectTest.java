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

    /** 权限边界：仅最新已提交版本可打回（打回历史版本 v1 被拒绝，防版本链错乱） */
    @Test
    void reject_historyVersion_throws() {
        when(projectVersionMapper.selectById(101L)).thenReturn(version(1));
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(2, 2));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp(true));

        BizException e = assertThrows(BizException.class,
                () -> service.rejectVersion(2L, 101L, "理由"));
        assertTrue(e.getMessage().contains("最新已提交版本"));
        verify(projectVersionMapper, never()).updateById(any(ProjectVersion.class));
    }

    /** 理由校验：空白理由拒绝（前端弹窗与后端双重校验） */
    @Test
    void reject_blankReason_throws() {
        when(projectVersionMapper.selectById(102L)).thenReturn(version(2));
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
}
