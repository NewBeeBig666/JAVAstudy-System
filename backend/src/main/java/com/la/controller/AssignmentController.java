package com.la.controller;

import com.la.dto.ApiResponse;
import com.la.security.CurrentUser;
import com.la.service.AssignmentService;
import com.la.service.LabGroupService;
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
    private final LabGroupService labGroupService;

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

    @Operation(summary = "实验报告作业：我的分组信息（所在小组成员/组长标注/组队邀请）")
    @GetMapping("/{id}/my-group")
    public ApiResponse<Map<String, Object>> myGroup(@PathVariable Long id) {
        return ApiResponse.ok(labGroupService.myGroup(CurrentUser.id(), id));
    }

    @Operation(summary = "实验报告作业：邀请同学组队（自行组队模式，发起者自动成为队长）")
    @PostMapping("/{id}/group/invite")
    public ApiResponse<Map<String, Object>> groupInvite(@PathVariable Long id,
                                                        @RequestBody GroupInviteRequest req) {
        return ApiResponse.ok(labGroupService.invite(CurrentUser.id(), id, req.getToStudentId()));
    }

    @Operation(summary = "实验报告作业：接受组队邀请（接受后其余待响应邀请自动失效）")
    @PostMapping("/{id}/group/invites/{inviteId}/accept")
    public ApiResponse<Map<String, Object>> acceptInvite(@PathVariable Long id,
                                                          @PathVariable Long inviteId) {
        return ApiResponse.ok(labGroupService.acceptInvite(CurrentUser.id(), id, inviteId));
    }

    @Operation(summary = "实验报告作业：拒绝组队邀请（拒绝后仍可接受其他邀请）")
    @PostMapping("/{id}/group/invites/{inviteId}/reject")
    public ApiResponse<Map<String, Object>> rejectInvite(@PathVariable Long id,
                                                          @PathVariable Long inviteId) {
        return ApiResponse.ok(labGroupService.rejectInvite(CurrentUser.id(), id, inviteId));
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

    @Data
    public static class GroupInviteRequest {
        /** 被邀请学生 id */
        private Long toStudentId;
    }
}
