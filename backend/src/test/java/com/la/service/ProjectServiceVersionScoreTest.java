package com.la.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.ai.LlmClient;
import com.la.config.DeepSeekProperties;
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
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyDouble;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 项目版本 AI 评分单元测试（教师触发 AI 初评 + 教师调整，同步学生端）
 * 覆盖：AI 初评写入与 DTO 语义、水位外版本拒绝、AI 不可用降级、教师调整覆盖展示、
 *       分数范围校验、评语空值语义（沿用 AI 分数 / 清空回显）
 */
@ExtendWith(MockitoExtension.class)
class ProjectServiceVersionScoreTest {

    @Mock private CodingProjectMapper codingProjectMapper;
    @Mock private StudentProjectMapper studentProjectMapper;
    @Mock private ProjectVersionMapper projectVersionMapper;
    @Mock private UserMapper userMapper;
    @Mock private ClassMapper classMapper;
    @Mock private ClassCoTeacherMapper classCoTeacherMapper;
    @Mock private LlmClient llmClient;
    @Mock private DeepSeekProperties deepSeekProperties;
    @Spy  private ObjectMapper objectMapper = new ObjectMapper();

    @InjectMocks private ProjectService service;

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
        p.setTitle("图书管理系统");
        p.setDescription("控制台版图书管理，含增删改查与借阅功能。");
        p.setStatus("PUBLISHED");
        p.setRoadmap("[{\"title\":\"第1周 · 基础搭建\",\"desc\":\"完成菜单与数据结构\"}]");
        return p;
    }

    private ProjectVersion version(int no) {
        ProjectVersion v = new ProjectVersion();
        v.setId(100L + no);
        v.setStudentProjectId(9L);
        v.setVersionNo(no);
        v.setFiles("[{\"path\":\"Main.java\",\"content\":\"public class Main { public static void main(String[] a) {} }\"}]");
        v.setSummary("完成菜单");
        v.setCreatedAt(LocalDateTime.now());
        return v;
    }

    /** AI 初评：LLM 返回合法 JSON → ai_score/ai_comment 写入版本行，finalScore=AI 分且未标注教师调整 */
    @Test
    void aiScore_success_writesAndReturns() {
        ProjectVersion v = version(3);
        when(projectVersionMapper.selectById(103L)).thenReturn(v);
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(3));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());
        when(llmClient.chat(anyList(), anyDouble()))
                .thenReturn("```json\n{\"score\":85,\"comment\":\"菜单与数据结构完成良好，建议补充异常处理。\"}\n```");

        Map<String, Object> s = service.aiScoreVersion(2L, 103L);

        verify(projectVersionMapper).updateById(argThat((ProjectVersion x) -> x.getAiScore() == 85
                && "菜单与数据结构完成良好，建议补充异常处理。".equals(x.getAiComment())));
        assertEquals(Integer.valueOf(85), s.get("finalScore"));
        assertEquals(Boolean.FALSE, s.get("teacherAdjusted"));
        assertEquals(Integer.valueOf(85), s.get("aiScore"));
    }

    /** 水位外版本（学生仅保存未提交）→ 拒绝 AI 评分，不产生写入 */
    @Test
    void aiScore_aboveWatermark_denied() {
        ProjectVersion v = version(5);
        when(projectVersionMapper.selectById(105L)).thenReturn(v);
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(3));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());

        assertThrows(BizException.class, () -> service.aiScoreVersion(2L, 105L));
        verify(projectVersionMapper, org.mockito.Mockito.never()).updateById(any(ProjectVersion.class));
    }

    /** LLM 调用失败 → 友好降级提示，不写任何评分 */
    @Test
    void aiScore_llmUnavailable_degrades() {
        ProjectVersion v = version(3);
        when(projectVersionMapper.selectById(103L)).thenReturn(v);
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(3));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());
        when(llmClient.chat(anyList(), anyDouble())).thenThrow(new RuntimeException("timeout"));

        assertThrows(BizException.class, () -> service.aiScoreVersion(2L, 103L));
        verify(projectVersionMapper, org.mockito.Mockito.never()).updateById(any(ProjectVersion.class));
    }

    /** 教师调整：写 teacher_score/teacher_comment，finalScore 切换为教师分并标注教师已调整 */
    @Test
    void teacherScore_overridesDisplay() {
        ProjectVersion v = version(3);
        v.setAiScore(85);
        v.setAiComment("AI 初评");
        when(projectVersionMapper.selectById(103L)).thenReturn(v);
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(3));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());

        Map<String, Object> s = service.teacherScoreVersion(2L, 103L, 88, "教师复核后调高，异常处理已补充。");

        verify(projectVersionMapper).updateById(argThat((ProjectVersion x) -> x.getTeacherScore() == 88
                && "教师复核后调高，异常处理已补充。".equals(x.getTeacherComment())));
        assertEquals(Integer.valueOf(88), s.get("finalScore"));
        assertEquals(Boolean.TRUE, s.get("teacherAdjusted"));
        assertEquals(Integer.valueOf(85), s.get("aiScore"));
    }

    /** 分数范围校验：101 分 → 拒绝 */
    @Test
    void teacherScore_outOfRange_rejected() {
        ProjectVersion v = version(3);
        when(projectVersionMapper.selectById(103L)).thenReturn(v);
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(3));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());

        assertThrows(BizException.class, () -> service.teacherScoreVersion(2L, 103L, 101, null));
    }

    /** 教师仅改评语不带分数 → 沿用 AI 分数展示，仍标注教师已调整 */
    @Test
    void teacherScore_nullScore_keepsAiScore() {
        ProjectVersion v = version(3);
        v.setAiScore(85);
        when(projectVersionMapper.selectById(103L)).thenReturn(v);
        when(studentProjectMapper.selectById(9L)).thenReturn(sp(3));
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());

        Map<String, Object> s = service.teacherScoreVersion(2L, 103L, null, "评语已润色。");

        assertEquals(Integer.valueOf(85), s.get("finalScore"));
        assertEquals(Boolean.TRUE, s.get("teacherAdjusted"));
        assertEquals("评语已润色。", s.get("teacherComment"));
    }

    /** 教师版本列表逐版本携带评分摘要（studentVersions DTO 含 score） */
    @Test
    void studentVersions_carriesScore() {
        StudentProject sp = sp(3);
        when(studentProjectMapper.selectById(9L)).thenReturn(sp);
        when(codingProjectMapper.selectById(5L)).thenReturn(cp());
        ProjectVersion v3 = version(3);
        v3.setAiScore(90);
        when(projectVersionMapper.selectList(any())).thenReturn(List.of(v3, version(2)));

        List<Map<String, Object>> vs = service.studentVersions(2L, 9L);

        @SuppressWarnings("unchecked")
        Map<String, Object> score = (Map<String, Object>) vs.get(0).get("score");
        assertEquals(Integer.valueOf(90), score.get("finalScore"));
        assertEquals(Boolean.FALSE, score.get("teacherAdjusted"));
    }
}
