package com.la.controller;

import com.la.dto.ApiResponse;
import com.la.dto.response.SessionDto;
import com.la.security.CurrentUser;
import com.la.service.SessionService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.constraints.NotBlank;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@Tag(name = "学习会话")
@RestController
@RequestMapping("/api/sessions")
@RequiredArgsConstructor
public class SessionController {

    private final SessionService sessionService;

    @Operation(summary = "会话列表")
    @GetMapping
    public ApiResponse<List<SessionDto>> list() {
        return ApiResponse.ok(sessionService.list(CurrentUser.id()));
    }

    @Operation(summary = "新建会话（诊断+路径规划，返回完整会话；支持单选/多选/不选知识点）")
    @PostMapping
    public ApiResponse<SessionDto> create(@RequestBody CreateRequest req) {
        // 多选/空选模式：kpIds 优先（空列表 = 覆盖全部知识点的学习路径）；单选走原 kpId 保持兼容
        if (req.getKpIds() != null) {
            return ApiResponse.ok(sessionService.createMulti(CurrentUser.id(), req.getKpIds()));
        }
        if (req.getKpId() == null || req.getKpId().isBlank()) {
            return ApiResponse.ok(sessionService.createMulti(CurrentUser.id(), List.of()));
        }
        return ApiResponse.ok(sessionService.create(CurrentUser.id(), req.getKpId()));
    }

    @Operation(summary = "会话详情（steps + messages）")
    @GetMapping("/{id}")
    public ApiResponse<SessionDto> detail(@PathVariable Long id) {
        return ApiResponse.ok(sessionService.detail(CurrentUser.id(), id));
    }

    @Operation(summary = "清空当前用户的全部会话（含步骤与消息，不影响学习数据）")
    @DeleteMapping
    public ApiResponse<Integer> clearAll() {
        return ApiResponse.ok(sessionService.clearAll(CurrentUser.id()));
    }

    @Operation(summary = "重新规划路径")
    @PostMapping("/{id}/replan")
    public ApiResponse<SessionDto> replan(@PathVariable Long id) {
        return ApiResponse.ok(sessionService.replan(CurrentUser.id(), id));
    }

    @Operation(summary = "开始某步骤（代码陪练步骤自动出练习卡片）")
    @PostMapping("/{id}/steps/{stepNo}/start")
    public ApiResponse<SessionDto> startStep(@PathVariable Long id, @PathVariable int stepNo) {
        return ApiResponse.ok(sessionService.startStep(CurrentUser.id(), id, stepNo));
    }

    @Operation(summary = "完成某步骤（全部完成后会话标记 DONE）")
    @PostMapping("/{id}/steps/{stepNo}/complete")
    public ApiResponse<SessionDto> completeStep(@PathVariable Long id, @PathVariable int stepNo) {
        return ApiResponse.ok(sessionService.completeStep(CurrentUser.id(), id, stepNo));
    }

    @Data
    public static class CreateRequest {
        private String kpId;
        /** 多选知识点编码列表；传空列表表示不选（生成覆盖全部知识点的学习路径） */
        private List<String> kpIds;
    }
}
