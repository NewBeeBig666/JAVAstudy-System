package com.la.controller;

import com.la.dto.ApiResponse;
import com.la.security.CurrentUser;
import com.la.service.CoTeacherService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * 班级共同管理教师（教师端顶栏「其他教师」面板）：
 * 权限仅作用于指定班级，不影响其他班级；仅班级所有者可添加，共同管理教师列表为纯展示。
 */
@Tag(name = "班级共同管理教师")
@RestController
@RequestMapping("/api/teacher/co-teachers")
@RequiredArgsConstructor
public class CoTeacherController {

    private final CoTeacherService coTeacherService;

    @Operation(summary = "面板数据：班级信息 + 已关联教师列表 + 可添加候选")
    @GetMapping
    public ApiResponse<Map<String, Object>> panel(@RequestParam Long classId) {
        return ApiResponse.ok(coTeacherService.panel(classId, CurrentUser.id()));
    }

    @Operation(summary = "添加共同管理教师（仅所有者；目标须为有效教师账号且未重复）")
    @PostMapping
    public ApiResponse<Map<String, Object>> add(@RequestBody AddRequest req) {
        return ApiResponse.ok(coTeacherService.add(req.getClassId(), CurrentUser.id(), req.getTeacherId()));
    }

    @Data
    public static class AddRequest {
        private Long classId;
        private Long teacherId;
    }
}
