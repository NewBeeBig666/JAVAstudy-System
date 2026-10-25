package com.la.controller;

import com.la.dto.ApiResponse;
import com.la.security.CurrentUser;
import com.la.service.StudentAssistantService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * 智能助手（学生侧）：非学习会话页面右侧栏的 DeepSeek 对话
 * 教师侧助手见 /api/teacher/assistant（TeacherController）
 */
@Tag(name = "智能助手（学生侧）")
@RestController
@RequestMapping("/api/student")
@RequiredArgsConstructor
public class AssistantController {

    private final StudentAssistantService studentAssistantService;

    @Operation(summary = "智能助手对话（注入学生本人学情上下文，引导式学习）")
    @PostMapping("/assistant")
    public ApiResponse<Map<String, Object>> assistant(@RequestBody AssistantRequest req) {
        return ApiResponse.ok(studentAssistantService.chat(CurrentUser.id(), req.getMessages()));
    }

    @Data
    public static class AssistantRequest {
        /** [{role: "user"|"assistant", content: "..."}]，按时间升序，末条为本次提问 */
        private List<Map<String, String>> messages;
    }
}
