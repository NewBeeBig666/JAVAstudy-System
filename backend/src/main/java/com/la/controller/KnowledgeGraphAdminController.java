package com.la.controller;

import com.la.dto.ApiResponse;
import com.la.dto.response.KnowledgeGraphResponse;
import com.la.security.CurrentUser;
import com.la.service.KnowledgeService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * 教师端知识图谱维护：添加子知识点 / 删除知识点（级联子树软删除）/ 重置默认图谱。
 * 路径挂 /api/teacher/** 自动限 TEACHER 角色；所有操作返回最新图谱数据，
 * 前端 applyKnowledgeGraph 后教师/学生两端加载即为最新（数据层一致性同步）。
 */
@Tag(name = "知识图谱维护（教师）")
@RestController
@RequestMapping("/api/teacher/graph")
@RequiredArgsConstructor
public class KnowledgeGraphAdminController {

    private final KnowledgeService knowledgeService;

    @Operation(summary = "添加子知识点（挂在指定父节点下，自定义节点）")
    @PostMapping("/nodes")
    public ApiResponse<KnowledgeGraphResponse> addNode(@RequestBody AddNodeRequest req) {
        if (req.getParentCode() == null || req.getParentCode().isBlank()) {
            throw new com.la.exception.BizException("缺少父知识点");
        }
        return ApiResponse.ok(knowledgeService.addChildNode(CurrentUser.id(),
                req.getParentCode().trim(), req.getName()));
    }

    @Operation(summary = "删除知识点（级联软删除整个子树；一级模块不可删；重置可恢复）")
    @DeleteMapping("/nodes/{code}")
    public ApiResponse<KnowledgeGraphResponse> deleteNode(@PathVariable String code) {
        return ApiResponse.ok(knowledgeService.deleteNode(CurrentUser.id(), code));
    }

    @Operation(summary = "子树规模统计（删除确认弹窗展示，不含目标自身）")
    @GetMapping("/nodes/{code}/subtree-size")
    public ApiResponse<Map<String, Object>> subtreeSize(@PathVariable String code) {
        return ApiResponse.ok(Map.of("children", knowledgeService.subtreeSize(code)));
    }

    @Operation(summary = "重置图谱（恢复所有软删除节点 + 清除全部自定义节点，还原默认状态）")
    @PostMapping("/reset")
    public ApiResponse<KnowledgeGraphResponse> reset() {
        return ApiResponse.ok(knowledgeService.reset(CurrentUser.id()));
    }

    @Data
    public static class AddNodeRequest {
        /** 父知识点编码（前端节点 id = kpCode） */
        private String parentCode;
        private String name;
    }
}
