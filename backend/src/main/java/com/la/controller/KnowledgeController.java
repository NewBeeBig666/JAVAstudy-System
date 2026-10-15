package com.la.controller;

import com.la.dto.ApiResponse;
import com.la.dto.response.KnowledgeGraphResponse;
import com.la.dto.response.KnowledgeTreeResponse;
import com.la.dto.response.TraceChainResponse;
import com.la.security.CurrentUser;
import com.la.service.KnowledgeService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

@Tag(name = "知识点")
@RestController
@RequestMapping("/api/knowledge")
@RequiredArgsConstructor
public class KnowledgeController {

    private final KnowledgeService knowledgeService;

    @Operation(summary = "知识点树（含本人掌握度）")
    @GetMapping("/tree")
    public ApiResponse<KnowledgeTreeResponse> tree() {
        return ApiResponse.ok(knowledgeService.tree(CurrentUser.id()));
    }

    @Operation(summary = "知识图谱全层级（课程知识点 Excel 全量树，含掌握度与依赖边）")
    @GetMapping("/graph")
    public ApiResponse<KnowledgeGraphResponse> graph() {
        return ApiResponse.ok(knowledgeService.graph(CurrentUser.id()));
    }

    @Operation(summary = "知识点详情")
    @GetMapping("/{code}")
    public ApiResponse<KnowledgeTreeResponse.KpDto> detail(@PathVariable String code) {
        return ApiResponse.ok(knowledgeService.detail(code, CurrentUser.id()));
    }

    @Operation(summary = "依赖链溯源（定位最弱根因）")
    @GetMapping("/{code}/trace-chain")
    public ApiResponse<TraceChainResponse> traceChain(@PathVariable String code) {
        return ApiResponse.ok(knowledgeService.traceChain(code, CurrentUser.id()));
    }
}
