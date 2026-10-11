package com.la.controller;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.la.dto.ApiResponse;
import com.la.entity.Assignment;
import com.la.entity.ClassEntity;
import com.la.mapper.AssignmentMapper;
import com.la.mapper.ClassMapper;
import com.la.security.CurrentUser;
import com.la.service.AssignmentService;
import com.la.service.GradingService;
import com.la.service.TeacherService;
import com.la.service.ClassImportService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;
import java.util.Map;

@Tag(name = "教师端")
@RestController
@RequestMapping("/api/teacher")
@RequiredArgsConstructor
public class TeacherController {

    private final TeacherService teacherService;
    private final AssignmentService assignmentService;
    private final GradingService gradingService;
    private final ClassMapper classMapper;
    private final AssignmentMapper assignmentMapper;
    private final ClassImportService classImportService;

    @Operation(summary = "上传 Excel/Word 名单批量添加班级（.xlsx/.xls/.docx/.doc）")
    @PostMapping(value = "/classes/import", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ApiResponse<Map<String, Object>> importClass(@RequestParam("file") MultipartFile file) {
        return ApiResponse.ok(classImportService.importClass(CurrentUser.id(), file));
    }

    @Operation(summary = "学情看板（4 KPI + 卡点 TOP6 + 重点关注学生）")
    @GetMapping("/dashboard")
    public ApiResponse<Map<String, Object>> dashboard(@RequestParam(required = false) Long classId) {
        return ApiResponse.ok(teacherService.dashboard(CurrentUser.id(),
                classId != null ? classId : defaultClassId()));
    }

    @Operation(summary = "班级列表")
    @GetMapping("/classes")
    public ApiResponse<List<ClassEntity>> classes() {
        // 优先返回当前教师授课的班级，无授课班级时回退到全部（兼容演示账号）
        List<ClassEntity> own = classMapper.selectList(new LambdaQueryWrapper<ClassEntity>()
                .eq(ClassEntity::getTeacherId, CurrentUser.id()));
        return ApiResponse.ok(own.isEmpty() ? classMapper.selectList(null) : own);
    }

    @Operation(summary = "学生列表（掌握度/提交率/风险/趋势）")
    @GetMapping("/students")
    public ApiResponse<List<TeacherService.StudentSummary>> students(@RequestParam(required = false) Long classId) {
        return ApiResponse.ok(teacherService.studentList(classId != null ? classId : defaultClassId()));
    }

    @Operation(summary = "重置学生密码为统一初始密码 GZgs@2026")
    @PostMapping("/students/{id}/reset-password")
    public ApiResponse<Void> resetStudentPassword(@PathVariable Long id) {
        teacherService.resetStudentPassword(CurrentUser.id(), id);
        return ApiResponse.ok();
    }

    @Operation(summary = "作业列表（教师视角，含草稿）")
    @GetMapping("/assignments")
    public ApiResponse<List<Map<String, Object>>> assignments(@RequestParam(required = false) Long classId) {
        Long cid = classId != null ? classId : defaultClassId();
        List<Assignment> list = assignmentMapper.selectList(new LambdaQueryWrapper<Assignment>()
                .eq(Assignment::getClassId, cid).orderByDesc(Assignment::getCreatedAt));
        return ApiResponse.ok(list.stream().map(assignmentService::toAssignmentDto).toList());
    }

    @Operation(summary = "发布/修改作业")
    @PostMapping("/assignments")
    public ApiResponse<Map<String, Object>> saveAssignment(@RequestBody SaveAssignmentRequest req) {
        return ApiResponse.ok(assignmentService.saveAssignment(CurrentUser.id(), req.getId(),
                req.getClassId() != null ? req.getClassId() : defaultClassId(),
                req.getTitle(), req.getDesc(), req.getKp(), req.getDue(),
                req.getStatus(), req.getRubric()));
    }

    @Operation(summary = "删除作业（级联删除其 Rubric 与学生提交）")
    @DeleteMapping("/assignments/{id}")
    public ApiResponse<Void> deleteAssignment(@PathVariable Long id) {
        assignmentService.deleteAssignment(CurrentUser.id(), id);
        return ApiResponse.ok();
    }

    @Operation(summary = "作业的提交列表（含相似度/AI初评）")
    @GetMapping("/assignments/{id}/submissions")
    public ApiResponse<List<Map<String, Object>>> submissions(@PathVariable Long id) {
        return ApiResponse.ok(assignmentService.submissionList(id));
    }

    @Operation(summary = "单份 AI 初评（同步）")
    @PostMapping("/submissions/{id}/ai-grade")
    public ApiResponse<Map<String, Object>> aiGrade(@PathVariable Long id) {
        return ApiResponse.ok(gradingService.aiGrade(id));
    }

    @Operation(summary = "批量 AI 初评（异步，完成后通知教师）")
    @PostMapping("/assignments/{id}/ai-grade-batch")
    public ApiResponse<Void> aiGradeBatch(@PathVariable Long id) {
        gradingService.aiGradeBatch(id, CurrentUser.id());
        return ApiResponse.ok();
    }

    @Operation(summary = "教师评分发布（回流学生通知+会话卡片）")
    @PostMapping("/submissions/{id}/grade")
    public ApiResponse<Void> grade(@PathVariable Long id, @RequestBody GradeRequest req) {
        gradingService.teacherGrade(id, req.getRubricScores(), req.getComment());
        return ApiResponse.ok();
    }

    @Operation(summary = "预警列表")
    @GetMapping("/warnings")
    public ApiResponse<List<Map<String, Object>>> warnings(@RequestParam(required = false) String level,
                                                           @RequestParam(required = false) Boolean handled) {
        return ApiResponse.ok(teacherService.warnings(defaultClassId(), level, handled));
    }

    @Operation(summary = "标记预警已处理")
    @PutMapping("/warnings/{id}/handle")
    public ApiResponse<Void> handleWarning(@PathVariable Long id) {
        teacherService.handleWarning(id);
        return ApiResponse.ok();
    }

    @Operation(summary = "预警推送提醒给学生")
    @PostMapping("/warnings/{id}/notify")
    public ApiResponse<Void> notifyStudent(@PathVariable Long id) {
        teacherService.notifyStudent(id);
        return ApiResponse.ok();
    }

    @Operation(summary = "班级薄弱点报告（学情 Agent 生成）")
    @PostMapping("/insight/run")
    public ApiResponse<Map<String, Object>> runInsight(@RequestParam(required = false) Long classId) {
        return ApiResponse.ok(teacherService.runInsight(CurrentUser.id(),
                classId != null ? classId : defaultClassId()));
    }

    private Long defaultClassId() {
        // 优先当前教师授课的班级，其次回退到第一个班级
        ClassEntity own = classMapper.selectOne(new LambdaQueryWrapper<ClassEntity>()
                .eq(ClassEntity::getTeacherId, CurrentUser.id()).last("LIMIT 1"));
        if (own != null) {
            return own.getId();
        }
        ClassEntity first = classMapper.selectOne(new LambdaQueryWrapper<ClassEntity>().last("LIMIT 1"));
        return first != null ? first.getId() : 1L;
    }

    @Data
    public static class SaveAssignmentRequest {
        private Long id;
        private Long classId;
        private String title;
        private String desc;
        private List<String> kp;
        private String due;
        /** DRAFT / ONGOING / CLOSED */
        private String status;
        private List<Map<String, Object>> rubric;
    }

    @Data
    public static class GradeRequest {
        private Map<String, Integer> rubricScores;
        private String comment;
    }
}
