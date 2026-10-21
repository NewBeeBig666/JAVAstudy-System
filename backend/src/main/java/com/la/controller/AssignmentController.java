package com.la.controller;

import com.la.dto.ApiResponse;
import com.la.security.CurrentUser;
import com.la.service.AssignmentService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.constraints.NotBlank;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;
import java.util.Map;

@Tag(name = "作业（学生侧）")
@RestController
@RequestMapping("/api/assignments")
@RequiredArgsConstructor
public class AssignmentController {

    private final AssignmentService assignmentService;

    @Operation(summary = "我的作业列表（含本人提交状态）")
    @GetMapping("/my")
    public ApiResponse<List<Map<String, Object>>> my() {
        return ApiResponse.ok(assignmentService.myAssignments(CurrentUser.id()));
    }

    @Operation(summary = "提交作业（AI 初评异步进行，完成后通知）")
    @PostMapping("/{id}/submissions")
    public ApiResponse<Map<String, Object>> submit(@PathVariable Long id, @RequestBody SubmitRequest req) {
        return ApiResponse.ok(assignmentService.submit(CurrentUser.id(), id, req.getCode()));
    }

    @Operation(summary = "在线答题提交（题目型作业）：结构化作答 + 客观题自动判分")
    @PostMapping("/{id}/answer")
    public ApiResponse<Map<String, Object>> answer(@PathVariable Long id, @RequestBody AnswerRequest req) {
        return ApiResponse.ok(assignmentService.submitAnswer(CurrentUser.id(), id, req.getAnswers()));
    }

    @Operation(summary = "上传实验报告（实验报告型作业，Word 格式）")
    @PostMapping(value = "/{id}/report", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ApiResponse<Map<String, Object>> submitReport(@PathVariable Long id,
                                                         @RequestParam("file") MultipartFile file) {
        return ApiResponse.ok(assignmentService.submitReport(CurrentUser.id(), id, file));
    }

    @Data
    public static class SubmitRequest {
        @NotBlank(message = "代码不能为空")
        private String code;
    }

    @Data
    public static class AnswerRequest {
        /** [{"questionId":"5","value":"A"}]，value：单选 key / 多选 [keys] / 判断 true|false / 文本内容 */
        private List<Map<String, Object>> answers;
    }
}
