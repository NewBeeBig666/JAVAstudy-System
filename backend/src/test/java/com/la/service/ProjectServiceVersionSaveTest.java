package com.la.service;

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
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 项目版本保存策略单元测试（保存弹窗：保留当前版本 / 迭代新版本）
 * 覆盖：不同初始版本下的版本号规则、保留当前版本的版本号一致性、
 *       迭代新版本的版本号递增准确性、缺省 mode 的向后兼容、提交状态流转、越权防护
 */
@ExtendWith(MockitoExtension.class)
class ProjectServiceVersionSaveTest {

    @Mock private CodingProjectMapper codingProjectMapper;
    @Mock private StudentProjectMapper studentProjectMapper;
    @Mock private ProjectVersionMapper projectVersionMapper;
    @Mock private UserMapper userMapper;
    @Mock private ClassMapper classMapper;
    @Mock private ClassCoTeacherMapper classCoTeacherMapper;
    @Spy  private ObjectMapper objectMapper = new ObjectMapper();

    @InjectMocks private ProjectService service;

    private static final String FILES = "[{\"path\":\"Main.java\",\"content\":\"public class Main { public static void main(String[] a) {} }\"}]";

    private StudentProject sp() {
        StudentProject sp = new StudentProject();
        sp.setId(9L);
        sp.setProjectId(5L);
        sp.setStudentId(15L);
        sp.setStatus("IN_PROGRESS");
        sp.setCreatedAt(LocalDateTime.now());
        sp.setUpdatedAt(LocalDateTime.now());
        return sp;
    }

    private CodingProject cp() {
        CodingProject p = new CodingProject();
        p.setId(5L);
        p.setClassId(1L);
        p.setTeacherId(2L);
        p.setTitle("测试项目");
        p.setDescription("需求说明");
        p.setStatus("PUBLISHED");
        return p;
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

    /** 场景一：当前 v3 选择「迭代为 v4」→ 新增版本号严格 +1，不产生覆盖更新 */
    @Test
    void iterate_fromV3_createsV4() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp());
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());
        when(projectVersionMapper.selectOne(any())).thenReturn(version(3));

        Map<String, Object> r = service.save(15L, 9L, FILES, "迭代说明", false, "iterate", null);

        verify(projectVersionMapper).insert(argThat((ProjectVersion x) -> x.getVersionNo() == 4
                && x.getStudentProjectId().equals(9L)
                && "迭代说明".equals(x.getSummary())
                && x.getFiles().contains("Main.java")));
        verify(projectVersionMapper, never()).updateById(any(ProjectVersion.class));
        assertEquals(Integer.valueOf(4), r.get("versionCount"));
    }

    /** 场景二：当前 v3 选择「保留为 v3」→ 覆盖更新 v3 内容，版本号不变、不新增记录 */
    @Test
    void keep_fromV3_overwritesV3_versionNoUnchanged() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp());
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());
        when(projectVersionMapper.selectOne(any())).thenReturn(version(3));

        Map<String, Object> r = service.save(15L, 9L, FILES, "修正 v3 内容", false, "keep", null);

        verify(projectVersionMapper, never()).insert(any(ProjectVersion.class));
        verify(projectVersionMapper).updateById(argThat((ProjectVersion x) -> x.getVersionNo() == 3
                && x.getId().equals(103L)
                && "修正 v3 内容".equals(x.getSummary())
                && x.getFiles().contains("Main.java")));
        assertEquals(Integer.valueOf(3), r.get("versionCount"));
    }

    /** 场景三：当前 v6 选择「迭代为 v7」→ 任意初始版本下递增规则一致 */
    @Test
    void iterate_fromV6_createsV7() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp());
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());
        when(projectVersionMapper.selectOne(any())).thenReturn(version(6));

        service.save(15L, 9L, FILES, null, false, "iterate", null);

        verify(projectVersionMapper).insert(argThat((ProjectVersion x) -> x.getVersionNo() == 7));
    }

    /** 场景四：尚无版本时选择「保留」→ 按初始版本 v1 新建（keep 无可保留对象时退化为新建） */
    @Test
    void keep_fromNone_createsV1() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp());
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());
        when(projectVersionMapper.selectOne(any())).thenReturn(null);

        service.save(15L, 9L, FILES, "初版", false, "keep", null);

        verify(projectVersionMapper).insert(argThat((ProjectVersion x) -> x.getVersionNo() == 1));
        verify(projectVersionMapper, never()).updateById(any(ProjectVersion.class));
    }

    /** 场景五：尚无版本时正常迭代 → 生成初始版本 v1 */
    @Test
    void iterate_fromNone_createsV1() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp());
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());
        when(projectVersionMapper.selectOne(any())).thenReturn(null);

        Map<String, Object> r = service.save(15L, 9L, FILES, "初版", false, "iterate", null);

        verify(projectVersionMapper).insert(argThat((ProjectVersion x) -> x.getVersionNo() == 1));
        assertEquals(Integer.valueOf(1), r.get("versionCount"));
    }

    /** 场景六：mode 缺省（兼容旧客户端/未传参）→ 维持原自动迭代行为 */
    @Test
    void nullMode_defaultsToIterate_backwardCompatible() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp());
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());
        when(projectVersionMapper.selectOne(any())).thenReturn(version(2));

        service.save(15L, 9L, FILES, null, false, null, null);

        verify(projectVersionMapper).insert(argThat((ProjectVersion x) -> x.getVersionNo() == 3));
        verify(projectVersionMapper, never()).updateById(any(ProjectVersion.class));
    }

    /** 场景七：提交标记与版本策略正交——保留版本的同时 submit=true 仍置为 SUBMITTED */
    @Test
    void submit_withKeep_stillMarksSubmitted() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp());
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());
        when(projectVersionMapper.selectOne(any())).thenReturn(version(5));

        service.save(15L, 9L, FILES, "保留并提交", true, "keep", null);

        verify(projectVersionMapper).updateById(argThat((ProjectVersion x) -> x.getVersionNo() == 5));
        verify(studentProjectMapper).updateById(argThat((StudentProject x) -> "SUBMITTED".equals(x.getStatus())));
    }

    /** 场景八：非本人项目保存 → 拒绝，不产生任何版本写入 */
    @Test
    void save_byOtherStudent_denied() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp());

        assertThrows(BizException.class, () -> service.save(16L, 9L, FILES, null, false, "iterate", null));

        verify(projectVersionMapper, never()).insert(any(ProjectVersion.class));
        verify(projectVersionMapper, never()).updateById(any(ProjectVersion.class));
    }

    /** 场景九：提交（迭代）携带总结反思 → 反思随新版本一并落库绑定 */
    @Test
    void submit_iterate_withReflection_boundToNewVersion() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp());
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());
        when(projectVersionMapper.selectOne(any())).thenReturn(version(3));

        service.save(15L, 9L, FILES, "说明", true, "iterate", "本版本完成了查找功能，卡点在边界条件，收获是对增强 for 的理解。");

        verify(projectVersionMapper).insert(argThat((ProjectVersion x) -> x.getVersionNo() == 4
                && "本版本完成了查找功能，卡点在边界条件，收获是对增强 for 的理解。".equals(x.getReflection())));
    }

    /** 场景十：提交（保留）携带总结反思 → 反思覆盖更新到当前版本 */
    @Test
    void submit_keep_withReflection_boundToCurrentVersion() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp());
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());
        when(projectVersionMapper.selectOne(any())).thenReturn(version(3));

        service.save(15L, 9L, FILES, "说明", true, "keep", "重写后逻辑更清晰。");

        verify(projectVersionMapper).updateById(argThat((ProjectVersion x) -> x.getVersionNo() == 3
                && "重写后逻辑更清晰。".equals(x.getReflection())));
    }

    /** 场景十一：仅保存（迭代）传入反思 → 不绑定，新版本反思为空（待提交时写入） */
    @Test
    void plainSave_iterate_reflectionNotStored() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp());
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());
        when(projectVersionMapper.selectOne(any())).thenReturn(version(3));

        service.save(15L, 9L, FILES, "说明", false, "iterate", "草稿反思不应入库");

        verify(projectVersionMapper).insert(argThat((ProjectVersion x) -> x.getVersionNo() == 4
                && x.getReflection() == null));
    }

    /** 场景十二：仅保存（保留）→ 不触碰已有反思（实体反思字段保持库中原值） */
    @Test
    void plainSave_keep_preservesExistingReflection() {
        ProjectVersion last = version(3);
        last.setReflection("上次提交写的反思");
        when(studentProjectMapper.selectById(9L)).thenReturn(sp());
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());
        when(projectVersionMapper.selectOne(any())).thenReturn(last);

        service.save(15L, 9L, FILES, null, false, "keep", null);

        verify(projectVersionMapper).updateById(argThat((ProjectVersion x) -> "上次提交写的反思".equals(x.getReflection())));
    }

    /** 场景十三：总结反思超长（>2000 字）→ 拒绝，不产生版本写入 */
    @Test
    void reflection_over2000_rejected() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp());
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());

        assertThrows(BizException.class,
                () -> service.save(15L, 9L, FILES, null, true, "iterate", "反".repeat(2001)));

        verify(projectVersionMapper, never()).insert(any(ProjectVersion.class));
    }

    /** 场景十四：反思超长校验优先于版本写入，且纯空白反思按空处理 */
    @Test
    void reflection_blank_treatedAsNull() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp());
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());
        when(projectVersionMapper.selectOne(any())).thenReturn(version(3));

        service.save(15L, 9L, FILES, null, true, "iterate", "   ");

        verify(projectVersionMapper).insert(argThat((ProjectVersion x) -> x.getReflection() == null));
    }
}
