package com.la.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.entity.CodingProject;
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

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 项目迭代路线单元测试（发布/编辑项目弹窗可选模块，学生端时间线展示）
 * 覆盖：随项目绑定存储与 DTO 回传、空项过滤（选填不拦截）、上限 10 项校验、
 *       未配置/非法 JSON 的容错、编辑替换路线
 */
@ExtendWith(MockitoExtension.class)
class ProjectServiceRoadmapTest {

    @Mock private CodingProjectMapper codingProjectMapper;
    @Mock private StudentProjectMapper studentProjectMapper;
    @Mock private ProjectVersionMapper projectVersionMapper;
    @Mock private UserMapper userMapper;
    @Mock private ClassMapper classMapper;
    @Mock private ClassCoTeacherMapper classCoTeacherMapper;
    @Spy  private ObjectMapper objectMapper = new ObjectMapper();

    @InjectMocks private ProjectService service;

    private static final String RM_2 = "[{\"title\":\"第1周 · 基础搭建\",\"desc\":\"完成菜单与数据结构\"},{\"title\":\"第2周 · 增删改查\",\"desc\":\"完成 CRUD 与验收测试\"}]";

    private void stubInsert() {
        doAnswer(inv -> {
            CodingProject p = inv.getArgument(0);
            p.setId(77L);
            return 1;
        }).when(codingProjectMapper).insert(any(CodingProject.class));
        when(codingProjectMapper.selectById(77L)).thenAnswer(inv -> {
            CodingProject p = new CodingProject();
            p.setId(77L);
            p.setClassId(1L);
            p.setTeacherId(2L);
            p.setTitle("路线测试项目");
            p.setDescription("需求说明");
            p.setStatus("PUBLISHED");
            p.setRoadmap(RM_2);
            return p;
        });
    }

    /** 发布携带 2 项迭代路线 → 随项目绑定存储，DTO 解析回传同构列表 */
    @Test
    void publish_withRoadmap_storedAndReturned() {
        stubInsert();
        Map<String, Object> dto = service.publish(2L, 1L, "路线测试项目", "需求说明", RM_2, null);

        verify(codingProjectMapper).insert(argThat((CodingProject p) -> p.getRoadmap() != null
                && p.getRoadmap().contains("第1周 · 基础搭建")));
        @SuppressWarnings("unchecked")
        List<Map<String, String>> rm = (List<Map<String, String>>) dto.get("roadmap");
        assertEquals(2, rm.size());
        assertEquals("第1周 · 基础搭建", rm.get(0).get("title"));
        assertEquals("完成菜单与数据结构", rm.get(0).get("desc"));
    }

    /** 迭代路线为全空项（教师打开模块但未填写）→ 清洗为 NULL 存储，发布正常不受拦截 */
    @Test
    void publish_allEmptyEntries_savedAsNull() {
        stubInsert();
        String rm = "[{\"title\":\"\",\"desc\":\"  \"},{\"title\":\"\",\"desc\":\"\"}]";
        service.publish(2L, 1L, "路线测试项目", "需求说明", rm, null);

        verify(codingProjectMapper).insert(argThat((CodingProject p) -> p.getRoadmap() == null));
    }

    /** 3 项中 1 项全空 → 仅存 2 项（部分填写时空项被过滤） */
    @Test
    void publish_emptyEntryFiltered() {
        stubInsert();
        String rm = "[{\"title\":\"一\",\"desc\":\"任务一\"},{\"title\":\"\",\"desc\":\"\"},{\"title\":\"三\",\"desc\":\"任务三\"}]";
        service.publish(2L, 1L, "路线测试项目", "需求说明", rm, null);

        verify(codingProjectMapper).insert(argThat((CodingProject p) ->
                p.getRoadmap() != null && !p.getRoadmap().contains("二") && p.getRoadmap().contains("三")));
    }

    /** 超过 10 个非空迭代项 → 拒绝发布（上限校验） */
    @Test
    void publish_over10Entries_rejected() {
        StringBuilder rm = new StringBuilder("[");
        for (int i = 1; i <= 11; i++) {
            rm.append("{\"title\":\"阶段").append(i).append("\",\"desc\":\"任务").append(i).append("\"}").append(i < 11 ? "," : "");
        }
        rm.append("]");
        assertThrows(BizException.class, () -> service.publish(2L, 1L, "路线测试项目", "需求说明", rm.toString(), null));
    }

    /** 未配置路线（null）与非法 JSON → 均按未配置处理，发布不受影响（选填容错） */
    @Test
    void publish_nullOrInvalidRoadmap_tolerated() {
        stubInsert();
        service.publish(2L, 1L, "路线测试项目", "需求说明", null, null);
        service.publish(2L, 1L, "路线测试项目", "需求说明", "不是JSON{{{", null);
        verify(codingProjectMapper, org.mockito.Mockito.times(2)).insert(argThat((CodingProject p) -> p.getRoadmap() == null));
    }

    /** 编辑项目：路线随需求一并替换为新的路线内容 */
    @Test
    void update_replacesRoadmap() {
        CodingProject old = new CodingProject();
        old.setId(9L);
        old.setClassId(1L);
        old.setTeacherId(2L);
        old.setTitle("旧标题");
        old.setDescription("旧说明");
        old.setStatus("PUBLISHED");
        old.setRoadmap(RM_2);
        when(codingProjectMapper.selectById(9L)).thenReturn(old);

        service.update(2L, 9L, "新标题", "新说明",
                "[{\"title\":\"唯一阶段\",\"desc\":\"合并后的任务\"}]", null);
        verify(codingProjectMapper).updateById(argThat((CodingProject p) ->
                "新标题".equals(p.getTitle()) && p.getRoadmap() != null && p.getRoadmap().contains("唯一阶段")));
    }

    /** 编辑项目：清空路线（空数组）→ 存 NULL */
    @Test
    void update_clearsRoadmap() {
        CodingProject old = new CodingProject();
        old.setId(9L);
        old.setClassId(1L);
        old.setTeacherId(2L);
        old.setTitle("标题");
        old.setDescription("说明");
        old.setStatus("PUBLISHED");
        old.setRoadmap(RM_2);
        when(codingProjectMapper.selectById(9L)).thenReturn(old);

        service.update(2L, 9L, null, null, "[]", null);
        verify(codingProjectMapper).updateById(argThat((CodingProject p) -> p.getRoadmap() == null));
    }

    /** 项目 DTO 无路线时返回空列表（学生端/教师端按「未配置」渲染，不报错） */
    @Test
    void dto_roadmapAbsent_returnsEmptyList() {
        CodingProject p = new CodingProject();
        p.setId(5L);
        p.setClassId(1L);
        p.setTitle("无路线项目");
        p.setDescription("说明");
        p.setStatus("PUBLISHED");
        when(codingProjectMapper.selectById(5L)).thenReturn(p);

        Map<String, Object> dto = service.changeStatus(2L, 5L, "PUBLISHED");
        Object rm = dto.get("roadmap");
        assertTrue(rm instanceof List && ((List<?>) rm).isEmpty());
        assertNull(p.getRoadmap());
    }
}
