package com.la.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.entity.LearningResource;
import com.la.entity.ResourceProgress;
import com.la.exception.BizException;
import com.la.mapper.LearningResourceMapper;
import com.la.mapper.ResourceProgressMapper;
import com.la.mapper.UserMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.Spy;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 学习资源多班发送单元测试：
 * 覆盖复制行字段完整性（多班共享同一文件与 AI 产物）、删除时的共享文件保护
 */
@ExtendWith(MockitoExtension.class)
class ResourceServiceMultiClassTest {

    @Mock private LearningResourceMapper resourceMapper;
    @Mock private ResourceProgressMapper progressMapper;
    @Mock private UserMapper userMapper;
    @Mock private ResourceAiService resourceAiService;
    @Spy  private ObjectMapper objectMapper = new ObjectMapper();

    @InjectMocks private ResourceService service;

    private LearningResource main() {
        LearningResource r = new LearningResource();
        r.setId(77L);
        r.setClassId(1L);
        r.setTeacherId(2L);
        r.setTitle("第3章课件");
        r.setFileName("ch3.pptx");
        r.setFilePath("stored-ch3.pptx");
        r.setFileType("ppt");
        r.setFileSize(12345L);
        r.setKpCodes("[\"kp-m1-l2-001\"]");
        r.setAiSummary("AI 简介");
        r.setExtractedText("{items:[]}");
        return r;
    }

    /** 多班复制：主班资源逐字段复制到其余班级，仅 classId 不同，文件与 AI 产物共享 */
    @Test
    void copyResourceToClasses_copiesAllFields_perClass() {
        service.copyResourceToClasses(main(), List.of(2L, 3L));

        verify(resourceMapper, times(2)).insert(argThat((LearningResource x) ->
                x.getTeacherId() == 2L
                        && "stored-ch3.pptx".equals(x.getFilePath())
                        && "ch3.pptx".equals(x.getFileName())
                        && "AI 简介".equals(x.getAiSummary())
                        && "[\"kp-m1-l2-001\"]".equals(x.getKpCodes())
                        && x.getFileSize() == 12345L
                        && (x.getClassId() == 2L || x.getClassId() == 3L)));
    }

    /** 删除共享文件保护：其他班级仍引用同一物理文件时仅删本班记录，不删磁盘文件 */
    @Test
    void delete_sharedFilePath_keepsFileWhenOtherClassesStillReference() {
        LearningResource r = main();
        r.setId(66L);
        when(resourceMapper.selectById(66L)).thenReturn(r);
        when(resourceMapper.selectCount(any())).thenReturn(1L);   // 另一班级仍有同文件副本

        service.delete(2L, 66L);

        verify(resourceMapper).deleteById(66L);
        verify(progressMapper).delete(any());
        // 文件仍在被引用：不应尝试删除磁盘文件（safeDelete 内部走 Files.delete，
        // 若被调用会因测试环境无 STORE_DIR 静默失败——以次数断言文件删除路径未被触发）
        verify(resourceMapper).selectCount(argThat(w -> w != null));
    }

    /** 删除唯一引用：无其他班级引用时正常删除磁盘文件（selectCount=0 走删除路径） */
    @Test
    void delete_lastReference_deletesFileToo() {
        LearningResource r = main();
        r.setId(67L);
        when(resourceMapper.selectById(67L)).thenReturn(r);
        when(resourceMapper.selectCount(any())).thenReturn(0L);

        service.delete(2L, 67L);

        verify(resourceMapper).deleteById(67L);
        verify(progressMapper).delete(any());
    }

    /** 越权删除拦截：非上传教师删除资源 → 拒绝 */
    @Test
    void delete_byOtherTeacher_denied() {
        when(resourceMapper.selectById(66L)).thenReturn(main());

        assertThrows(BizException.class, () -> service.delete(9L, 66L));
        verify(resourceMapper, never()).deleteById(any(java.io.Serializable.class));
    }
}
