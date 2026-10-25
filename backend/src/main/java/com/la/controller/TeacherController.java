package com.la.controller;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.la.dto.ApiResponse;
import com.la.dto.ComposeRequest;
import com.la.entity.Assignment;
import com.la.entity.ClassEntity;
import com.la.mapper.AssignmentMapper;
import com.la.mapper.ClassMapper;
import com.la.security.CurrentUser;
import com.la.exception.BizException;
import com.la.service.AssignmentService;
import com.la.service.ComposeAiService;
import com.la.service.ComposeImportService;
import com.la.service.GradingService;
import com.la.service.TeacherService;
import com.la.service.TeacherAssistantService;
import com.la.service.ClassImportService;
import com.la.service.ScoreExportService;
import com.la.service.SubmissionExportService;
import org.springframework.http.ResponseEntity;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Tag(name = "教师端")
@RestController
@RequestMapping("/api/teacher")
@RequiredArgsConstructor
public class TeacherController {

    private final TeacherService teacherService;
    private final AssignmentService assignmentService;
    private final ComposeAiService composeAiService;
    private final ComposeImportService composeImportService;
    private final GradingService gradingService;
    private final ClassMapper classMapper;
    private final AssignmentMapper assignmentMapper;
    private final ClassImportService classImportService;
    private final ScoreExportService scoreExportService;
    private final SubmissionExportService submissionExportService;
    private final TeacherAssistantService teacherAssistantService;

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
        return ApiResponse.ok(list.stream().map(a -> assignmentService.toAssignmentDto(a, true)).toList());
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

    @Operation(summary = "出题组卷：保存/发布题目型作业（单选/多选/填空/判断/简答/编程题）")
    @PostMapping("/compose")
    public ApiResponse<Map<String, Object>> compose(@RequestBody ComposeRequest req) {
        if (req.getClassId() == null) {
            req.setClassId(defaultClassId());
        }
        return ApiResponse.ok(assignmentService.saveCompose(CurrentUser.id(), req));
    }

    @Operation(summary = "出题组卷：一键 AI 生成题目（数量与题型完全由教师添加的空白题决定）")
    @PostMapping("/compose/ai-generate")
    public ApiResponse<List<Map<String, Object>>> aiGenerate(@RequestBody AiGenerateRequest req) {
        // 生成数量与题型唯一依据 = blanks（教师界面上添加的空白题序列），不使用任何默认数量
        return ApiResponse.ok(composeAiService.generate(req.getKpCodes(), req.getExisting(),
                req.getBlanks(), req.getTypes()));
    }

    @Operation(summary = "出题组卷：导入作业——解析粘贴的题目文本")
    @PostMapping("/compose/import-parse")
    public ApiResponse<List<Map<String, Object>>> importParse(@RequestBody ImportParseRequest req) {
        return ApiResponse.ok(composeImportService.parseQuestions(req.getText()));
    }

    @Operation(summary = "出题组卷：导入作业——上传 Word/Excel 文件解析（图片暂未开放）")
    @PostMapping(value = "/compose/import-file", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ApiResponse<Map<String, Object>> importFile(@RequestParam("file") MultipartFile file) {
        String text = composeImportService.extractText(file);
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("text", text);
        data.put("questions", composeImportService.parseQuestions(text));
        return ApiResponse.ok(data);
    }

    @Data
    public static class ImportParseRequest {
        private String text;
    }

    @Data
    public static class AiGenerateRequest {
        /** 关联的知识点编码 */
        private List<String> kpCodes;
        /** 已添加题目（type/title），作为出题风格参考 */
        private List<Map<String, Object>> existing;
        /** 待填充空白题的题型列表（按顺序），生成结果前 N 道按此题型出题 */
        private List<String> blanks;
        /** 教师选定的题型范围：生成题目的 type 只能从中选择（空则不限制） */
        private List<String> types;
    }

    @Operation(summary = "作业的提交列表（含相似度/AI初评）")
    @GetMapping("/assignments/{id}/submissions")
    public ApiResponse<List<Map<String, Object>>> submissions(@PathVariable Long id) {
        return ApiResponse.ok(assignmentService.submissionList(id));
    }

    @Operation(summary = "导出班级作业成绩 Excel（全部作业或指定发布时间段，含学生姓名/学号/各作业成绩/提交时间）")
    @GetMapping("/export/scores")
    public ResponseEntity<byte[]> exportScores(@RequestParam(required = false) Long classId,
                                               @RequestParam(required = false) String start,
                                               @RequestParam(required = false) String end) {
        return scoreExportService.export(classId != null ? classId : defaultClassId(), start, end);
    }

    @Operation(summary = "导出学生作业：每个已提交学生一份 Word（作答+批改+评语+得分），打包 ZIP 下载")
    @GetMapping("/assignments/{id}/export-submissions")
    public ResponseEntity<byte[]> exportSubmissions(@PathVariable Long id) {
        return submissionExportService.export(id);
    }

    @Operation(summary = "单份 AI 初评（同步）")
    @PostMapping("/submissions/{id}/ai-grade")
    public ApiResponse<Map<String, Object>> aiGrade(@PathVariable Long id) {
        return ApiResponse.ok(gradingService.aiGrade(id));
    }

    @Operation(summary = "下载学生上传的实验报告（实验报告型作业）")
    @GetMapping("/submissions/{id}/report-file")
    public ResponseEntity<byte[]> reportFile(@PathVariable Long id) {
        Map<String, Object> r = assignmentService.studentReport(id);
        File f = (File) r.get("file");
        String fileName = (String) r.get("fileName");
        try {
            return ResponseEntity.ok()
                    .header(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_OCTET_STREAM_VALUE)
                    .header(HttpHeaders.CONTENT_DISPOSITION,
                            "attachment; filename*=UTF-8''" + java.net.URLEncoder.encode(fileName, java.nio.charset.StandardCharsets.UTF_8))
                    .contentLength(f.length())
                    .body(Files.readAllBytes(f.toPath()));
        } catch (IOException e) {
            throw new BizException("报告文件读取失败");
        }
    }

    @Operation(summary = "批量 AI 初评（异步，完成后通知教师）")
    @PostMapping("/assignments/{id}/ai-grade-batch")
    public ApiResponse<Void> aiGradeBatch(@PathVariable Long id) {
        gradingService.aiGradeBatch(id, CurrentUser.id());
        return ApiResponse.ok();
    }

    @Operation(summary = "多作业批量 AI 初评（异步，一次勾选多份作业一键触发，完成后汇总通知）")
    @PostMapping("/assignments/ai-grade-batch")
    public ApiResponse<Void> aiGradeBatchMulti(@RequestBody AiBatchGradeRequest req) {
        if (req.getAssignmentIds() == null || req.getAssignmentIds().isEmpty()) {
            throw new BizException("请至少选择一份作业");
        }
        gradingService.aiGradeBatch(req.getAssignmentIds(), CurrentUser.id());
        return ApiResponse.ok();
    }

    @Data
    public static class AiBatchGradeRequest {
        /** 勾选的作业 ID 列表 */
        private List<Long> assignmentIds;
    }

    @Operation(summary = "教师评分发布（回流学生通知+会话卡片）")
    @PostMapping("/submissions/{id}/grade")
    public ApiResponse<Void> grade(@PathVariable Long id, @RequestBody GradeRequest req) {
        gradingService.teacherGrade(id, req.getRubricScores(), req.getComment(), req.getTotalScore());
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

    /** 右侧栏「智能助手」：DeepSeek 多轮对话（前端持有历史，每次回传最近若干轮） */
    @Operation(summary = "智能助手对话（注入班级学情上下文）")
    @PostMapping("/assistant")
    public ApiResponse<Map<String, Object>> assistant(@RequestBody AssistantRequest req) {
        return ApiResponse.ok(teacherAssistantService.chat(CurrentUser.id(), defaultClassId(), req.getMessages()));
    }

    @Data
    public static class AssistantRequest {
        /** [{role: "user"|"assistant", content: "..."}]，按时间升序，末条为本次提问 */
        private List<Map<String, String>> messages;
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
        /** 题目型作业（无 Rubric）教师直接录入的总分 */
        private Integer totalScore;
    }
}
