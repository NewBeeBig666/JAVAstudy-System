package com.la.controller;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.la.dto.ApiResponse;
import com.la.entity.ClassEntity;
import com.la.entity.LearningResource;
import com.la.entity.User;
import com.la.exception.BizException;
import com.la.mapper.ClassMapper;
import com.la.mapper.UserMapper;
import com.la.security.CurrentUser;
import com.la.service.ResourceService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.core.io.InputStreamResource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.List;
import java.util.Map;

/**
 * 学习资源模块：
 * - 教师端：上传（AI 识别内容并关联知识点）/ 列表 / 删除 / 编辑知识点 / 查看学生学习进度
 * - 学生端：本班资源列表 / 预览下载 / 学习进度记录（查看 + 标记学完）
 */
@Tag(name = "学习资源")
@RestController
@RequiredArgsConstructor
public class LearningResourceController {

    private final ResourceService resourceService;
    private final UserMapper userMapper;
    private final ClassMapper classMapper;

    /* ==================== 教师端 ==================== */

    @Operation(summary = "上传学习资源（PPT/视频/图片/Word/PDF），AI 识别内容并关联知识点")
    @PostMapping(value = "/api/teacher/resources", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ApiResponse<Map<String, Object>> upload(@RequestParam("file") MultipartFile file,
                                                    @RequestParam("title") String title,
                                                    @RequestParam(required = false) Long classId,
                                                    @RequestParam(required = false) String kpCodes) {
        // kpCodes：教师手动选择的知识点（逗号分隔），与 AI 识别结果合并
        List<String> manual = kpCodes == null || kpCodes.isBlank()
                ? List.of() : List.of(kpCodes.split(","));
        return ApiResponse.ok(resourceService.upload(CurrentUser.id(),
                classId != null ? classId : defaultClassId(), title, file, manual));
    }

    @Operation(summary = "教师资源列表（含每个资源已学完人数）")
    @GetMapping("/api/teacher/resources")
    public ApiResponse<List<Map<String, Object>>> teacherList(@RequestParam(required = false) Long classId) {
        return ApiResponse.ok(resourceService.teacherList(classId != null ? classId : defaultClassId()));
    }

    @Operation(summary = "删除资源（级联删除学习进度记录与磁盘文件）")
    @DeleteMapping("/api/teacher/resources/{id}")
    public ApiResponse<Void> delete(@PathVariable Long id) {
        resourceService.delete(CurrentUser.id(), id);
        return ApiResponse.ok();
    }

    @Operation(summary = "编辑资源关联知识点")
    @PutMapping("/api/teacher/resources/{id}/kp")
    public ApiResponse<Void> updateKp(@PathVariable Long id, @RequestBody UpdateKpRequest req) {
        resourceService.updateKpCodes(CurrentUser.id(), id, req.getKpCodes());
        return ApiResponse.ok();
    }

    @Operation(summary = "查看某学生的学习资源进度（班级学生页档案卡）")
    @GetMapping("/api/teacher/resources/student-progress")
    public ApiResponse<Map<String, Object>> studentProgress(@RequestParam Long studentId) {
        return ApiResponse.ok(resourceService.studentProgress(studentId));
    }

    @Data
    public static class UpdateKpRequest {
        /** 关联知识点编码（覆盖保存） */
        private List<String> kpCodes;
    }

    /* ==================== 学生端 ==================== */

    @Operation(summary = "学生资源列表（本班全部资源 + 我的学习进度）")
    @GetMapping("/api/resources")
    public ApiResponse<List<Map<String, Object>>> studentList() {
        return ApiResponse.ok(resourceService.studentList(CurrentUser.id()));
    }

    @Operation(summary = "记录一次资源查看（首次查看记开始时间，次数 +1）")
    @PostMapping("/api/resources/{id}/view")
    public ApiResponse<Map<String, Object>> view(@PathVariable Long id) {
        checkStudentAccess(id);
        return ApiResponse.ok(resourceService.markView(CurrentUser.id(), id));
    }

    @Operation(summary = "标记资源已学完")
    @PostMapping("/api/resources/{id}/complete")
    public ApiResponse<Void> complete(@PathVariable Long id) {
        checkStudentAccess(id);
        resourceService.markComplete(CurrentUser.id(), id);
        return ApiResponse.ok();
    }

    @Operation(summary = "资源文件流（预览/下载）：图片/视频/PDF 内联预览，PPT/Word 附件下载")
    @GetMapping("/api/resources/{id}/file")
    public ResponseEntity<InputStreamResource> file(@PathVariable Long id) {
        checkAccess(id);
        LearningResource r = resourceService.getById(id);
        File f = resourceService.getFile(id);
        String type = resourceService.contentType(r);
        boolean inline = r.getFileType().equals("image") || r.getFileType().equals("video")
                || r.getFileType().equals("pdf");
        try {
            return ResponseEntity.ok()
                    .header(HttpHeaders.CONTENT_TYPE, type)
                    .header(HttpHeaders.CONTENT_DISPOSITION,
                            resourceService.contentDisposition(r.getFileName(), inline))
                    .contentLength(f.length())
                    .body(new InputStreamResource(Files.newInputStream(f.toPath())));
        } catch (IOException e) {
            throw new BizException("文件读取失败，请稍后重试");
        }
    }

    /* ==================== 鉴权与工具 ==================== */

    /** 学生仅能访问本班资源 */
    private void checkStudentAccess(Long resourceId) {
        if (CurrentUser.isTeacher()) {
            throw new BizException("该操作仅学生可用");
        }
        checkAccess(resourceId);
    }

    /** 教师（任意登录教师）或资源所在班级的学生可访问文件流 */
    private void checkAccess(Long resourceId) {
        if (CurrentUser.isTeacher()) {
            return;
        }
        LearningResource r = resourceService.getById(resourceId);
        User u = userMapper.selectById(CurrentUser.id());
        if (u == null || u.getClassId() == null || !u.getClassId().equals(r.getClassId())) {
            throw new BizException("无权访问该资源");
        }
    }

    /** 优先当前教师授课的班级，回退第一个班级（与 TeacherController 口径一致） */
    private Long defaultClassId() {
        ClassEntity own = classMapper.selectOne(new LambdaQueryWrapper<ClassEntity>()
                .eq(ClassEntity::getTeacherId, CurrentUser.id()).last("LIMIT 1"));
        if (own != null) {
            return own.getId();
        }
        ClassEntity first = classMapper.selectOne(new LambdaQueryWrapper<ClassEntity>().last("LIMIT 1"));
        return first != null ? first.getId() : 1L;
    }
}
