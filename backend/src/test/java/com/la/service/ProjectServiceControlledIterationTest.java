package com.la.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.entity.CodingProject;
import com.la.entity.ProjectVersion;
import com.la.entity.StudentProject;
import com.la.entity.User;
import com.la.exception.BizException;
import com.la.mapper.ClassCoTeacherMapper;
import com.la.mapper.ClassMapper;
import com.la.mapper.CodingProjectMapper;
import com.la.mapper.ProjectVersionMapper;
import com.la.mapper.StudentProjectMapper;
import com.la.mapper.UserMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.Spy;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.LocalDateTime;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 「控制版本迭代」单元测试：
 * 覆盖受控发布校验（无路线拒绝）、迭代名称清洗、受控开关落库、
 *       学生创建初始化当前迭代、提交后迭代推进与封顶、非受控不受影响
 */
@ExtendWith(MockitoExtension.class)
class ProjectServiceControlledIterationTest {

    @Mock private CodingProjectMapper codingProjectMapper;
    @Mock private StudentProjectMapper studentProjectMapper;
    @Mock private ProjectVersionMapper projectVersionMapper;
    @Mock private UserMapper userMapper;
    @Mock private ClassMapper classMapper;
    @Mock private ClassCoTeacherMapper classCoTeacherMapper;
    @Spy  private ObjectMapper objectMapper = new ObjectMapper();

    @InjectMocks private ProjectService service;

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

    private StudentProject sp(Integer curIter) {
        StudentProject sp = new StudentProject();
        sp.setId(9L);
        sp.setProjectId(5L);
        sp.setStudentId(15L);
        sp.setStatus("IN_PROGRESS");
        sp.setCurrentIteration(curIter);
        sp.setCreatedAt(LocalDateTime.now());
        sp.setUpdatedAt(LocalDateTime.now());
        return sp;
    }

    private ProjectVersion version(int no) {
        ProjectVersion v = new ProjectVersion();
        v.setId(100L + no);
        v.setStudentProjectId(9L);
        v.setVersionNo(no);
        v.setFiles("[]");
        v.setCodeSize(10);
        v.setCreatedAt(LocalDateTime.now());
        return v;
    }

    /** 受控开启但未配置迭代路线：发布被拒绝 */
    @Test
    void publish_controlledWithoutRoadmap_throws() {
        BizException e = assertThrows(BizException.class,
                () -> service.publish(2L, 1L, "项目", "需求", null, 1));
        assertTrue(e.getMessage().contains("控制版本迭代"));
        verify(codingProjectMapper, org.mockito.Mockito.never()).insert(any(CodingProject.class));
    }

    /** 受控发布：开关与迭代名称均落库，名称保留（受控 1） */
    @Test
    void publish_controlledWithRoadmap_persistsSwitchAndIterName() {
        when(codingProjectMapper.selectById(any())).thenReturn(cp(true));

        service.publish(2L, 1L, "项目", "需求", ROADMAP, 1);

        verify(codingProjectMapper).insert(argThat((CodingProject x) ->
                x.getControlledIteration() == 1 && x.getRoadmap().contains("环境搭建")));
    }

    /** 迭代名称清洗：非法字符剔除、超长截断（20 字上限） */
    @Test
    void publish_iterNameSanitized_inRoadmapJson() {
        String raw = "[{\"name\":\"阶段<一>:/\\\\|?*\",\"title\":\"t\",\"desc\":\"d\"}]";
        when(codingProjectMapper.selectById(any())).thenReturn(cp(false));

        service.publish(2L, 1L, "项目", "需求", raw, 0);

        verify(codingProjectMapper).insert(argThat((CodingProject x) -> {
            String rm = x.getRoadmap();
            // 清洗后仅保留合法文字：无 < > / 反斜杠 | ? *，保留中文与序号
            return rm != null && !rm.contains("<") && !rm.contains(">") && !rm.contains("/")
                    && !rm.contains("|") && !rm.contains("?") && !rm.contains("*")
                    && rm.contains("阶段一");
        }));
    }

    /** 学生创建受控项目：直接进入第 1 个迭代 */
    @Test
    void start_controlledProject_initializesCurrentIteration1() {
        User u = new User();
        u.setId(15L);
        u.setClassId(1L);
        when(userMapper.selectById(15L)).thenReturn(u);
        when(codingProjectMapper.selectById(5L)).thenReturn(cp(true));
        when(studentProjectMapper.selectOne(any())).thenReturn(null);
        when(studentProjectMapper.insert(any(StudentProject.class))).thenAnswer(inv -> {
            ((StudentProject) inv.getArgument(0)).setId(9L);
            return 1;
        });
        when(projectVersionMapper.selectOne(any())).thenReturn(null);

        service.start(15L, 5L);

        verify(studentProjectMapper).insert(argThat((StudentProject x) ->
                x.getCurrentIteration() != null && x.getCurrentIteration() == 1));
    }

    /** 受控项目提交：当前迭代完成 → 解锁并推进至下一迭代（1→2）；版本落在当前迭代版本上 */
    @Test
    void save_submitOnControlled_advancesToNextIteration() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(1));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp(true));
        when(projectVersionMapper.selectOne(any())).thenReturn(version(1));

        service.save(15L, 9L, FILES, "提交迭代1", true, "keep", "第一版反思");

        verify(studentProjectMapper).updateById(argThat((StudentProject x) -> x.getCurrentIteration() == 2));
    }

    /** 受控项目提交至最后一个迭代：迭代序号封顶不再越界 */
    @Test
    void save_submitOnLastIteration_capsAtRoadmapSize() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(2));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp(true));
        when(projectVersionMapper.selectOne(any())).thenReturn(version(2));

        service.save(15L, 9L, FILES, "最终提交", true, "keep", null);

        verify(studentProjectMapper).updateById(argThat((StudentProject x) -> x.getCurrentIteration() == 2));
    }

    /** 受控项目最终迭代首次提交（iterate）：新建最终版本并封顶（v2 路线 → v2 提交） */
    @Test
    void save_submitFinalIterationFirstTime_iteratesAndCaps() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(2));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp(true));
        when(projectVersionMapper.selectOne(any())).thenReturn(version(1));

        service.save(15L, 9L, FILES, "最终迭代首版", true, "iterate", null);

        verify(projectVersionMapper).insert(argThat((ProjectVersion v) -> v.getVersionNo() == 2));
        verify(studentProjectMapper).updateById(argThat((StudentProject x) -> x.getCurrentIteration() == 2));
    }

    /** 受控 keep 新迭代首次保存：自动转为迭代，创建当前迭代版本（v1 阶段完成进入 v2 后首存） */
    @Test
    void save_controlledKeepOnNewIteration_autoIterates() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(2));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp(true));
        when(projectVersionMapper.selectOne(any())).thenReturn(version(1));

        service.save(15L, 9L, FILES, "v2 阶段首存", false, "keep", null);

        verify(projectVersionMapper).insert(argThat((ProjectVersion v) -> v.getVersionNo() == 2));
        verify(studentProjectMapper).updateById(argThat((StudentProject x) -> x.getCurrentIteration() == 2));
    }

    /** 受控 iterate 越界防护：版本水位已达当前迭代时禁止再迭代（防直调 API 产生路线外版本） */
    @Test
    void save_controlledIterateBeyondCurrent_throws() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(1));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp(true));
        when(projectVersionMapper.selectOne(any())).thenReturn(version(1));

        BizException e = assertThrows(BizException.class,
                () -> service.save(15L, 9L, FILES, "越界", false, "iterate", null));
        assertTrue(e.getMessage().contains("当前迭代为 v1"));
        verify(projectVersionMapper, org.mockito.Mockito.never()).insert(any(ProjectVersion.class));
    }

    /** 受控项目尚无版本时 keep：按 v1 新建（首存自动落到当前迭代版本） */
    @Test
    void save_controlledKeepNoVersion_createsV1() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(1));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp(true));
        when(projectVersionMapper.selectOne(any())).thenReturn(null);

        Map<String, Object> r = service.save(15L, 9L, FILES, "首存", false, "keep", null);

        verify(projectVersionMapper).insert(argThat((ProjectVersion v) -> v.getVersionNo() == 1));
        assertEquals(Integer.valueOf(1), r.get("versionCount"));
    }

    /** 非受控项目提交：不产生迭代推进（currentIteration 保持原状/为空） */
    @Test
    void save_submitOnFreeProject_doesNotTouchIteration() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(null));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp(false));
        when(projectVersionMapper.selectOne(any())).thenReturn(null);   // 尚无历史版本 → 首版 v1

        Map<String, Object> r = service.save(15L, 9L, FILES, "s", true, "iterate", null);

        verify(studentProjectMapper).updateById(argThat((StudentProject x) -> x.getCurrentIteration() == null));
        assertEquals(Integer.valueOf(1), r.get("versionCount"));
    }

    /** 仅保存不提交：受控项目不推进迭代（覆盖更新当前迭代版本） */
    @Test
    void save_withoutSubmit_keepsIterationUnchanged() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(1));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp(true));
        when(projectVersionMapper.selectOne(any())).thenReturn(version(1));

        service.save(15L, 9L, FILES, "s", false, "keep", null);

        verify(studentProjectMapper).updateById(argThat((StudentProject x) -> x.getCurrentIteration() == 1));
    }
}
