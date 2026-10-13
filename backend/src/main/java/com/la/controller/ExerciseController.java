package com.la.controller;

import com.la.dto.ApiResponse;
import com.la.dto.response.AttemptResponse;
import com.la.dto.response.ExerciseDto;
import com.la.security.CurrentUser;
import com.la.service.ExerciseService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@Tag(name = "练习")
@RestController
@RequestMapping("/api")
@RequiredArgsConstructor
public class ExerciseController {

    private final ExerciseService exerciseService;

    @Operation(summary = "知识点下的题目列表（不含答案）")
    @GetMapping("/exercises")
    public ApiResponse<List<ExerciseDto>> list(@RequestParam String kpId) {
        return ApiResponse.ok(exerciseService.listByKp(kpId));
    }

    @Operation(summary = "题目详情（不含答案）")
    @GetMapping("/exercises/{id}")
    public ApiResponse<ExerciseDto> detail(@PathVariable Long id) {
        return ApiResponse.ok(exerciseService.detail(id));
    }

    @Operation(summary = "请求一级渐进提示（level 1-3）")
    @PostMapping("/exercises/{id}/hint")
    public ApiResponse<Map<String, Object>> hint(@PathVariable Long id, @RequestBody HintRequest req) {
        return ApiResponse.ok(exerciseService.hint(id, req.getLevel()));
    }

    @Operation(summary = "提交答案（判分+掌握度回写+错题本+SM-2入队，单事务；非选择题传 answer 文本）")
    @PostMapping("/exercises/{id}/attempt")
    public ApiResponse<AttemptResponse> attempt(@PathVariable Long id, @RequestBody AttemptRequest req) {
        if (req.getSelected() == null && req.getAnswer() != null && !req.getAnswer().isBlank()) {
            return ApiResponse.ok(exerciseService.attemptText(CurrentUser.id(), id,
                    req.getAnswer(), req.getHintUsed()));
        }
        return ApiResponse.ok(exerciseService.attempt(CurrentUser.id(), id,
                req.getSelected(), req.getHintUsed()));
    }

    @Operation(summary = "错题本")
    @GetMapping("/wrong-book")
    public ApiResponse<List<Map<String, Object>>> wrongBook() {
        return ApiResponse.ok(exerciseService.wrongBook(CurrentUser.id()));
    }

    @Operation(summary = "练习记录（可按知识点过滤）")
    @GetMapping("/exercise-records")
    public ApiResponse<List<Map<String, Object>>> records(@RequestParam(required = false) String kpId) {
        return ApiResponse.ok(exerciseService.records(CurrentUser.id(), kpId));
    }

    @Data
    public static class HintRequest {
        private Integer level;
    }

    @Data
    public static class AttemptRequest {
        private Integer selected;
        private Integer hintUsed;
        /** 非选择题型（编程/填空/简答/判断）的文本作答 */
        private String answer;
    }
}
