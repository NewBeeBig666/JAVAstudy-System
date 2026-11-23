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
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 教师端版本可见性单元测试（「保存并提交」才开放，仅「保存新版本」对教师保密）
 * 覆盖：提交刷新水位的原子性、仅保存不动水位（交替操作边界）、越界版本拒绝、
 *       未提交学生教师零感知、教师进度聚合仅统计可见版本
 */
@ExtendWith(MockitoExtension.class)
class ProjectServiceTeacherVisibilityTest {

    @Mock private CodingProjectMapper codingProjectMapper;
    @Mock private StudentProjectMapper studentProjectMapper;
    @Mock private ProjectVersionMapper projectVersionMapper;
    @Mock private UserMapper userMapper;
    @Mock private ClassMapper classMapper;
    @Mock private ClassCoTeacherMapper classCoTeacherMapper;
    @Spy  private ObjectMapper objectMapper = new ObjectMapper();

    @InjectMocks private ProjectService service;

    private static final String FILES = "[{\"path\":\"Main.java\",\"content\":\"public class Main { public static void main(String[] a) {} }\"}]";

    private StudentProject sp(Integer watermark) {
        StudentProject sp = new StudentProject();
        sp.setId(9L);
        sp.setProjectId(5L);
        sp.setStudentId(15L);
        sp.setStatus(watermark == null ? "IN_PROGRESS" : "SUBMITTED");
        sp.setSubmittedVersionNo(watermark);
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
        v.setFiles(FILES);
        v.setCodeSize(10);
        v.setCreatedAt(LocalDateTime.now());
        return v;
    }

    private User user() {
        User u = new User();
        u.setId(15L);
        u.setRealName("张明");
        u.setStudentNo("2023001");
        return u;
    }

    /** 提交（迭代 v4）→ 水位原子刷新为 4：v1~v4 立即对教师开放 */
    @Test
    void submit_iterate_setsWatermarkToNewVersion() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(3));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());
        when(projectVersionMapper.selectOne(any())).thenReturn(version(3));

        service.save(15L, 9L, FILES, "提交 v4", true, "iterate", null);

        verify(studentProjectMapper).updateById(argThat((StudentProject x) ->
                "SUBMITTED".equals(x.getStatus()) && Integer.valueOf(4).equals(x.getSubmittedVersionNo())));
    }

    /** 提交（保留 v5）→ 水位更新为当前版本号 5（版本号不变，内容已更新） */
    @Test
    void submit_keep_setsWatermarkToSameVersionNo() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(3));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());
        when(projectVersionMapper.selectOne(any())).thenReturn(version(5));

        service.save(15L, 9L, FILES, "保留并提交", true, "keep", null);

        verify(studentProjectMapper).updateById(argThat((StudentProject x) ->
                Integer.valueOf(5).equals(x.getSubmittedVersionNo())));
    }

    /** 仅保存新版本（迭代）→ 水位保持 NULL 不变：新版本对教师不可见 */
    @Test
    void plainSave_iterate_keepsWatermarkNull() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(null));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());
        when(projectVersionMapper.selectOne(any())).thenReturn(null);

        service.save(15L, 9L, FILES, "初版", false, "iterate", null);

        verify(studentProjectMapper).updateById(argThat((StudentProject x) ->
                "IN_PROGRESS".equals(x.getStatus()) && x.getSubmittedVersionNo() == null));
    }

    /** 交替操作边界：提交开放到 v3 后，连续仅保存 v4、v5 → 水位保持 3，v4/v5 对教师不可见 */
    @Test
    void plainSaves_afterSubmit_keepWatermarkUnchanged() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(3));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());
        when(projectVersionMapper.selectOne(any())).thenReturn(version(5));

        service.save(15L, 9L, FILES, "迭代 v6 但不提交", false, "iterate", null);

        verify(studentProjectMapper).updateById(argThat((StudentProject x) ->
                Integer.valueOf(3).equals(x.getSubmittedVersionNo())));
    }

    /** 再次提交时水位越过旧值：v3 → 提交 v6 → 水位 6（当前及全部历史版本开放） */
    @Test
    void submitAgain_raisesWatermarkToLatest() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(3));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());
        when(projectVersionMapper.selectOne(any())).thenReturn(version(5));

        service.save(15L, 9L, FILES, "提交到 v6", true, "iterate", null);

        verify(studentProjectMapper).updateById(argThat((StudentProject x) ->
                Integer.valueOf(6).equals(x.getSubmittedVersionNo())));
    }

    /** 未提交学生（水位 NULL）→ 教师版本列表为空且不查询版本表：教师零感知 */
    @Test
    void studentVersions_neverSubmitted_returnsEmptyWithoutQuery() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(null));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());

        Map<String, Object> r = service.studentVersions(2L, 9L);

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> vs = (List<Map<String, Object>>) r.get("versions");
        assertTrue(vs.isEmpty());
        assertEquals(Integer.valueOf(0), r.get("controlled"));
        verify(projectVersionMapper, never()).selectList(any());
    }

    /** 教师进度聚合：水位 3 → 仅统计 v1~v3（stub 模拟 SQL 水位过滤后的结果），最新可见版本为 v3 */
    @Test
    void progress_aggregatesOnlyVisibleVersions() {
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());
        when(studentProjectMapper.selectList(any())).thenReturn(List.of(sp(3)));
        when(userMapper.selectById(15L)).thenReturn(user());
        when(projectVersionMapper.selectList(any())).thenReturn(List.of(version(3), version(2), version(1)));

        Map<String, Object> r = service.progress(2L, 5L);

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> rows = (List<Map<String, Object>>) r.get("students");
        assertEquals(1, rows.size());
        Map<String, Object> row = rows.get(0);
        assertEquals(Integer.valueOf(3), row.get("versionCount"));
        assertEquals(Integer.valueOf(3), row.get("lastVersionNo"));
        assertEquals("张明", row.get("name"));
    }

    /** 教师进度聚合：水位 NULL → 版本数 0、最新版本与说明为空：教师端看不到任何未提交内容 */
    @Test
    void progress_neverSubmitted_hidesAllVersionInfo() {
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());
        when(studentProjectMapper.selectList(any())).thenReturn(List.of(sp(null)));
        when(userMapper.selectById(15L)).thenReturn(user());

        Map<String, Object> r = service.progress(2L, 5L);

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> rows = (List<Map<String, Object>>) r.get("students");
        Map<String, Object> row = rows.get(0);
        assertEquals(Integer.valueOf(0), row.get("versionCount"));
        assertNull(row.get("lastVersionNo"));
        assertNull(row.get("lastSummary"));
        assertEquals(0, row.get("codeSize"));
    }

    /** 教师查看未开放版本（v5 > 水位 3）→ 一律拒绝，不返回任何代码内容 */
    @Test
    void versionDetail_aboveWatermark_denied() {
        when(projectVersionMapper.selectById(105L)).thenReturn(version(5));
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(3));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());

        assertThrows(BizException.class, () -> service.versionDetail(2L, 105L));
    }

    /** 学生本地版本列表逐版本附带提交状态：水位 3 时 v1~v3 已提交、v4/v5 未提交（与可见性规则同源） */
    @Test
    void mine_marksPerVersionSubmitStatus_byWatermark() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(3));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());
        when(projectVersionMapper.selectList(any()))
                .thenReturn(List.of(version(5), version(4), version(3), version(2), version(1)));

        Map<String, Object> r = service.mine(15L, 9L);

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> vs = (List<Map<String, Object>>) r.get("versions");
        assertEquals(5, vs.size());
        assertEquals(Boolean.FALSE, vs.get(0).get("submitted"));  // v5（列表降序首条）
        assertEquals(Boolean.FALSE, vs.get(1).get("submitted"));  // v4
        assertEquals(Boolean.TRUE, vs.get(2).get("submitted"));   // v3
        assertEquals(Boolean.TRUE, vs.get(3).get("submitted"));   // v2
        assertEquals(Boolean.TRUE, vs.get(4).get("submitted"));   // v1
    }

    /** 从未提交（水位 NULL）：学生本地版本全部显示未提交状态 */
    @Test
    void mine_neverSubmitted_allVersionsUnsubmitted() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(null));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());
        when(projectVersionMapper.selectList(any())).thenReturn(List.of(version(2), version(1)));

        Map<String, Object> r = service.mine(15L, 9L);

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> vs = (List<Map<String, Object>>) r.get("versions");
        assertEquals(2, vs.size());
        assertEquals(Boolean.FALSE, vs.get(0).get("submitted"));
        assertEquals(Boolean.FALSE, vs.get(1).get("submitted"));
    }

    /** 学生本地版本 DTO 携带总结反思内容：自己写的反思随版本可见（v2 有反思、v1 无） */
    @Test
    void mine_returnsReflectionInVersionDto() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(3));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());
        ProjectVersion v2 = version(2);
        v2.setReflection("本版本理清了循环边界逻辑。");
        when(projectVersionMapper.selectList(any())).thenReturn(List.of(v2, version(1)));

        Map<String, Object> r = service.mine(15L, 9L);

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> vs = (List<Map<String, Object>>) r.get("versions");
        assertEquals("本版本理清了循环边界逻辑。", vs.get(0).get("reflection"));
        assertNull(vs.get(1).get("reflection"));
    }

    /** 教师版本列表携带学生总结反思：仅随水位内可见版本返回（水位外版本教师不可见亦不可得反思） */
    @Test
    void studentVersions_returnsReflectionForVisibleVersions() {
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(2));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());
        ProjectVersion v2 = version(2);
        v2.setReflection("卡点已解决，理解了循环边界。");
        when(projectVersionMapper.selectList(any())).thenReturn(List.of(v2, version(1)));

        Map<String, Object> r = service.studentVersions(2L, 9L);

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> vs = (List<Map<String, Object>>) r.get("versions");
        assertEquals(2, vs.size());
        assertEquals("卡点已解决，理解了循环边界。", vs.get(0).get("reflection"));
        assertNull(vs.get(1).get("reflection"));
    }

    /** 教师查看已开放版本（v2 <= 水位 3）→ 正常返回完整代码 */
    @Test
    void versionDetail_withinWatermark_ok() {
        when(projectVersionMapper.selectById(102L)).thenReturn(version(2));
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(3));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());

        Map<String, Object> dto = service.versionDetail(2L, 102L);

        assertEquals(Integer.valueOf(2), dto.get("versionNo"));
        @SuppressWarnings("unchecked")
        List<Map<String, String>> files = (List<Map<String, String>>) dto.get("files");
        assertEquals("Main.java", files.get(0).get("path"));
    }
}
