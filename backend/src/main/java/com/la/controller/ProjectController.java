package com.la.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.dto.ApiResponse;
import com.la.exception.BizException;
import com.la.security.CurrentUser;
import com.la.service.ProjectService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 「项目代码」板块接口
 * 教师端：项目发布 / 编辑 / 上下架 / 删除 / 学生进度实时查看 / 学生代码版本在线查看
 * 学生端：项目列表实时接收 / 创建项目 / 代码保存（自动多版本留存）/ 提交 / 版本管理
 */
@Tag(name = "项目代码")
@RestController
@RequestMapping("/api")
@RequiredArgsConstructor
public class ProjectController {

    private final ProjectService projectService;
    private final ObjectMapper objectMapper;

    /* ==================== 教师端 ==================== */

    @Operation(summary = "教师项目列表（当前班级，含参与学生数/版本数）")
    @GetMapping("/teacher/projects")
    public ApiResponse<List<Map<String, Object>>> teacherProjects(@RequestParam Long classId) {
        return ApiResponse.ok(projectService.teacherProjects(CurrentUser.id(), classId));
    }

    @Operation(summary = "发布新项目（标题 + 详细需求说明 + 可选迭代路线 roadmap=[{name,title,desc}]；controlled=1 开启控制版本迭代）")
    @PostMapping("/teacher/projects")
    public ApiResponse<Map<String, Object>> publish(@RequestBody Map<String, Object> body) {
        Object classId = body.get("classId");
        if (classId == null || String.valueOf(classId).isBlank()) {
            throw new BizException("缺少班级参数");
        }
        return ApiResponse.ok(projectService.publish(CurrentUser.id(),
                Long.valueOf(String.valueOf(classId)),
                (String) body.get("title"),
                (String) body.get("description"),
                toJsonString(body.get("roadmap")),
                toControlled(body.get("controlled"))));
    }

    @Operation(summary = "编辑项目需求（含可选迭代路线 roadmap=[{name,title,desc}] 与 controlled 受控开关，未传开关则不改动；路线未传或空数组则清除）")
    @PutMapping("/teacher/projects/{id}")
    public ApiResponse<Map<String, Object>> update(@PathVariable Long id,
                                                   @RequestBody Map<String, Object> body) {
        return ApiResponse.ok(projectService.update(CurrentUser.id(), id,
                (String) body.get("title"),
                (String) body.get("description"),
                toJsonString(body.get("roadmap")),
                body.containsKey("controlled") ? toControlled(body.get("controlled")) : null));
    }

    /** 受控开关解析：接受 1/0、true/false；null=未传（编辑时保持不变） */
    private Integer toControlled(Object v) {
        if (v == null) {
            return null;
        }
        return "1".equals(String.valueOf(v)) || "true".equalsIgnoreCase(String.valueOf(v)) ? 1 : 0;
    }

    /** 请求体中的半结构化字段（数组/对象）统一序列化为 JSON 字符串；null 原样透传 */
    private String toJsonString(Object v) {
        if (v == null) {
            return null;
        }
        try {
            return objectMapper.writeValueAsString(v);
        } catch (Exception e) {
            throw new BizException("数据格式不正确");
        }
    }

    @Operation(summary = "上架 / 下架状态管理")
    @PutMapping("/teacher/projects/{id}/status")
    public ApiResponse<Map<String, Object>> changeStatus(@PathVariable Long id,
                                                          @RequestBody Map<String, Object> body) {
        return ApiResponse.ok(projectService.changeStatus(CurrentUser.id(), id,
                (String) body.get("status")));
    }

    @Operation(summary = "删除项目（级联学生项目与全部版本）")
    @DeleteMapping("/teacher/projects/{id}")
    public ApiResponse<String> delete(@PathVariable Long id) {
        projectService.delete(CurrentUser.id(), id);
        return ApiResponse.ok("ok");
    }

    @Operation(summary = "实时查看项目下所有学生的完成进度与代码更新情况")
    @GetMapping("/teacher/projects/{id}/progress")
    public ApiResponse<Map<String, Object>> progress(@PathVariable Long id) {
        return ApiResponse.ok(projectService.progress(CurrentUser.id(), id));
    }

    @Operation(summary = "学生项目的版本迭代记录")
    @GetMapping("/teacher/student-projects/{spId}/versions")
    public ApiResponse<List<Map<String, Object>>> studentVersions(@PathVariable Long spId) {
        return ApiResponse.ok(projectService.studentVersions(CurrentUser.id(), spId));
    }

    @Operation(summary = "版本完整代码在线查看")
    @GetMapping("/teacher/project-versions/{versionId}")
    public ApiResponse<Map<String, Object>> versionDetail(@PathVariable Long versionId) {
        return ApiResponse.ok(projectService.versionDetail(CurrentUser.id(), versionId));
    }

    @Operation(summary = "触发版本 AI 评分：根据项目/迭代路线需求与版本代码生成 0-100 初评分与评语")
    @PostMapping("/teacher/project-versions/{versionId}/ai-score")
    public ApiResponse<Map<String, Object>> aiScore(@PathVariable Long versionId) {
        return ApiResponse.ok(projectService.aiScoreVersion(CurrentUser.id(), versionId));
    }

    @Operation(summary = "教师调整版本评分：score（0-100，可空沿用）/ comment（≤2000字，可空清空回显AI评语），保存后同步学生端")
    @PutMapping("/teacher/project-versions/{versionId}/score")
    public ApiResponse<Map<String, Object>> teacherScore(@PathVariable Long versionId,
                                                         @RequestBody Map<String, Object> body) {
        Object score = body.get("score");
        return ApiResponse.ok(projectService.teacherScoreVersion(CurrentUser.id(), versionId,
                score == null ? null : Integer.valueOf(String.valueOf(score)),
                body.get("comment") == null ? null : String.valueOf(body.get("comment"))));
    }

    /* ==================== 学生端 ==================== */

    @Operation(summary = "学生项目列表（本班全部上架项目 + 我的项目状态，实时接收教师发布）")
    @GetMapping("/projects/my")
    public ApiResponse<List<Map<String, Object>>> myProjects() {
        return ApiResponse.ok(projectService.myProjects(CurrentUser.id()));
    }

    @Operation(summary = "学生创建项目（每项目一份，幂等）")
    @PostMapping("/projects/{id}/start")
    public ApiResponse<Map<String, Object>> start(@PathVariable Long id) {
        return ApiResponse.ok(projectService.start(CurrentUser.id(), id));
    }

    @Operation(summary = "保存代码：mode=keep 覆盖更新当前版本（版本号不变）/ mode=iterate（或缺省）迭代新版本；submit=true 同时标记提交；reflection=总结反思（≤2000字，仅随提交写入并绑定版本）")
    @PostMapping("/projects/mine/{spId}/save")
    public ApiResponse<Map<String, Object>> save(@PathVariable Long spId,
                                                  @RequestBody Map<String, Object> body) {
        String filesJson;
        try {
            filesJson = body.get("files") == null ? null : objectMapper.writeValueAsString(body.get("files"));
        } catch (Exception e) {
            throw new BizException("代码文件格式不正确");
        }
        return ApiResponse.ok(projectService.save(CurrentUser.id(), spId, filesJson,
                (String) body.get("summary"),
                Boolean.valueOf(String.valueOf(body.get("submit"))),
                body.get("mode") == null ? null : String.valueOf(body.get("mode")),
                body.get("reflection") == null ? null : String.valueOf(body.get("reflection"))));
    }

    @Operation(summary = "打开我的项目：最新代码 + 版本列表")
    @GetMapping("/projects/mine/{spId}")
    public ApiResponse<Map<String, Object>> mine(@PathVariable Long spId) {
        return ApiResponse.ok(projectService.mine(CurrentUser.id(), spId));
    }

    @Operation(summary = "运行代码：服务端 javac 编译 + java 执行（stdin=预置标准输入），返回编译诊断与程序输出")
    @PostMapping("/projects/mine/{spId}/run")
    public ApiResponse<Map<String, Object>> run(@PathVariable Long spId,
                                                @RequestBody Map<String, Object> body) {
        String filesJson;
        try {
            filesJson = body.get("files") == null ? null : objectMapper.writeValueAsString(body.get("files"));
        } catch (Exception e) {
            throw new BizException("代码文件格式不正确");
        }
        return ApiResponse.ok(projectService.run(CurrentUser.id(), spId, filesJson,
                body.get("stdin") == null ? null : String.valueOf(body.get("stdin"))));
    }
}
