package com.la.controller;

import com.la.dto.ApiResponse;
import com.la.dto.FeedbackRequest;
import com.la.dto.response.FeedbackDto;
import com.la.exception.BizException;
import com.la.security.CurrentUser;
import com.la.service.FeedbackService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 学生建议反馈（学生提交 / 教师查看与 AI 总结）
 */
@Tag(name = "建议反馈")
@RestController
@RequiredArgsConstructor
public class FeedbackController {

    private final FeedbackService feedbackService;

    @Operation(summary = "学生提交反馈")
    @PostMapping("/api/feedback")
    public ApiResponse<Void> submit(@RequestBody FeedbackRequest req) {
        // 反馈面向学生收集；教师端走查看与总结入口
        if (CurrentUser.isTeacher()) {
            throw new BizException("反馈由学生提交，教师可在顶栏「查看反馈」中查阅");
        }
        feedbackService.submit(CurrentUser.id(), req.getType(), req.getContent());
        return ApiResponse.ok();
    }

    @Operation(summary = "反馈列表（教师）")
    @GetMapping("/api/teacher/feedback")
    public ApiResponse<List<FeedbackDto>> list() {
        return ApiResponse.ok(feedbackService.list());
    }

    @Operation(summary = "AI 一键总结反馈（教师）")
    @PostMapping("/api/teacher/feedback/summary")
    public ApiResponse<Map<String, Object>> summary() {
        return ApiResponse.ok(feedbackService.summarize());
    }
}
