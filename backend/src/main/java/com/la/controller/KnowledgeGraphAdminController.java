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

import java.util.List;
import java.util.Map;

/**
 * 教师端知识图谱维护：增（任意层级，含一级模块）/ 删（单个与批量，级联子树软删除）/
 * 改（属性编辑）/ 移动（层级调整与拖拽）/ 重置。
 * 路径挂 /api/teacher/** 自动限 TEACHER 角色（学生与其他无权限角色一律 403 只读）；
 * 所有操作单事务原子写入并返回最新图谱数据，前端 applyKnowledgeGraph 后
 * 教师/学生两端加载即为最新——knowledge_point 全局共享（无班级维度），
 * 事务提交即对全部班级同步生效，不存在部分班级同步失败的问题。
 */
@Tag(name = "知识图谱维护（教师）")
@RestController
@RequestMapping("/api/teacher/graph")
@RequiredArgsConstructor
public class KnowledgeGraphAdminController {

    private final KnowledgeService knowledgeService;

    @Operation(summary = "添加节点：parentCode 为空 = 新增一级模块；否则挂到指定父节点下（层级不设上限）")
    @PostMapping("/nodes")
    public ApiResponse<KnowledgeGraphResponse> addNode(@RequestBody AddNodeRequest req) {
        return ApiResponse.ok(knowledgeService.addChildNode(CurrentUser.id(),
                req.getParentCode(), req.getName()));
    }

    @Operation(summary = "编辑节点属性：名称（必填，同级去重）与描述")
    @PutMapping("/nodes/{code}")
    public ApiResponse<KnowledgeGraphResponse> updateNode(@PathVariable String code,
                                                          @RequestBody UpdateNodeRequest req) {
        return ApiResponse.ok(knowledgeService.updateNode(CurrentUser.id(),
                code, req.getName(), req.getDescription()));
    }

    @Operation(summary = "移动节点：targetCode 为空 = 移为一级模块；禁止移动到自身/自身后代（环检测）")
    @PostMapping("/nodes/{code}/move")
    public ApiResponse<KnowledgeGraphResponse> moveNode(@PathVariable String code,
                                                        @RequestBody MoveNodeRequest req) {
        return ApiResponse.ok(knowledgeService.moveNode(CurrentUser.id(),
                code, req.getTargetCode()));
    }

    @Operation(summary = "删除知识点（级联软删除整个子树，一级模块可删；重置可恢复）")
    @DeleteMapping("/nodes/{code}")
    public ApiResponse<KnowledgeGraphResponse> deleteNode(@PathVariable String code) {
        return ApiResponse.ok(knowledgeService.deleteNode(CurrentUser.id(), code));
    }

    @Operation(summary = "批量删除：多棵子树并集一次事务内软删除")
    @PostMapping("/nodes/batch-delete")
    public ApiResponse<KnowledgeGraphResponse> batchDelete(@RequestBody BatchDeleteRequest req) {
        return ApiResponse.ok(knowledgeService.batchDelete(CurrentUser.id(), req.getCodes()));
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
        /** 父知识点编码（前端节点 id = kpCode）；为空表示新增一级模块 */
        private String parentCode;
        private String name;
    }

    @Data
    public static class UpdateNodeRequest {
        private String name;
        private String description;
    }

    @Data
    public static class MoveNodeRequest {
        /** 目标父知识点编码；为空表示移为一级模块 */
        private String targetCode;
    }

    @Data
    public static class BatchDeleteRequest {
        private List<String> codes;
    }
}
