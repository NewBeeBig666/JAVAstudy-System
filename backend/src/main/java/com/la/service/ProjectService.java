package com.la.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.ai.ChatMessage;
import com.la.ai.LlmClient;
import com.la.config.DeepSeekProperties;
import com.la.entity.CodingProject;
import com.la.entity.ProjectVersion;
import com.la.entity.StudentProject;
import com.la.entity.User;
import com.la.entity.ClassCoTeacher;
import com.la.entity.ClassEntity;
import com.la.exception.BizException;
import com.la.mapper.CodingProjectMapper;
import com.la.mapper.ClassCoTeacherMapper;
import com.la.mapper.ClassMapper;
import com.la.mapper.ProjectVersionMapper;
import com.la.mapper.StudentProjectMapper;
import com.la.mapper.UserMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * 「项目代码」板块：教师发布编程项目 / 学生创建项目并多版本留存 / 教师实时查看进度与代码
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ProjectService {

    private final CodingProjectMapper codingProjectMapper;
    private final StudentProjectMapper studentProjectMapper;
    private final ProjectVersionMapper projectVersionMapper;
    private final UserMapper userMapper;
    private final ClassMapper classMapper;
    private final ClassCoTeacherMapper classCoTeacherMapper;
    private final NotificationService notificationService;
    private final ObjectMapper objectMapper;
    private final LlmClient llmClient;
    private final DeepSeekProperties deepSeekProperties;

    private static final DateTimeFormatter DT = DateTimeFormatter.ofPattern("MM-dd HH:mm");

    /* ==================== 教师端 ==================== */

    /** 教师可见班级（授课 ∪ 共同管理）内某班的项目列表（含参与学生数/版本数） */
    public List<Map<String, Object>> teacherProjects(Long teacherId, Long classId) {
        requireManageable(teacherId, classId);
        List<CodingProject> projects = codingProjectMapper.selectList(new LambdaQueryWrapper<CodingProject>()
                .eq(CodingProject::getClassId, classId)
                .orderByDesc(CodingProject::getUpdatedAt));
        List<Map<String, Object>> result = new ArrayList<>();
        for (CodingProject p : projects) {
            Map<String, Object> dto = toProjectDto(p);
            List<StudentProject> sps = studentProjectMapper.selectList(new LambdaQueryWrapper<StudentProject>()
                    .eq(StudentProject::getProjectId, p.getId()));
            dto.put("studentCount", sps.size());
            dto.put("submittedCount", sps.stream().filter(s -> "SUBMITTED".equals(s.getStatus())).count());
            dto.put("versionCount", sps.isEmpty() ? 0
                    : Optional.ofNullable(projectVersionMapper.selectCount(new LambdaQueryWrapper<ProjectVersion>()
                            .in(ProjectVersion::getStudentProjectId, sps.stream().map(StudentProject::getId).collect(Collectors.toList()))))
                    .map(Number::intValue).orElse(0));
            result.add(dto);
        }
        return result;
    }

    /** 发布项目 */
    @Transactional
    public Map<String, Object> publish(Long teacherId, Long classId, String title, String description, String roadmapJson, Integer controlled) {
        requireManageable(teacherId, classId);
        if (title == null || title.isBlank()) {
            throw new BizException("项目标题不能为空");
        }
        if (title.length() > 120) {
            throw new BizException("项目标题不能超过 120 字");
        }
        if (description == null || description.isBlank()) {
            throw new BizException("项目需求说明不能为空");
        }
        String roadmap = sanitizeRoadmap(roadmapJson);
        boolean ctrl = controlled != null && controlled == 1;
        if (ctrl && roadmap == null) {
            throw new BizException("开启「控制版本迭代」需至少配置 1 个迭代版本");
        }
        CodingProject p = new CodingProject();
        p.setClassId(classId);
        p.setTeacherId(teacherId);
        p.setTitle(title.trim());
        p.setDescription(description.trim());
        p.setStatus("PUBLISHED");
        p.setRoadmap(roadmap);
        p.setControlledIteration(ctrl ? 1 : 0);
        codingProjectMapper.insert(p);
        return toProjectDto(codingProjectMapper.selectById(p.getId()));
    }

    /** 编辑项目（不改动状态与归属） */
    @Transactional
    public Map<String, Object> update(Long teacherId, Long projectId, String title, String description, String roadmapJson, Integer controlled) {
        CodingProject p = requireOwnProject(teacherId, projectId);
        if (title != null && !title.isBlank()) {
            if (title.length() > 120) {
                throw new BizException("项目标题不能超过 120 字");
            }
            p.setTitle(title.trim());
        }
        if (description != null && !description.isBlank()) {
            p.setDescription(description.trim());
        }
        String roadmap = sanitizeRoadmap(roadmapJson);
        if (controlled != null) {
            boolean ctrl = controlled == 1;
            if (ctrl && roadmap == null) {
                throw new BizException("开启「控制版本迭代」需至少配置 1 个迭代版本");
            }
            p.setControlledIteration(ctrl ? 1 : 0);
        }
        p.setRoadmap(roadmap);
        p.setUpdatedAt(LocalDateTime.now());
        codingProjectMapper.updateById(p);
        return toProjectDto(p);
    }

    /** 上架 / 下架状态管理 */
    @Transactional
    public Map<String, Object> changeStatus(Long teacherId, Long projectId, String status) {
        CodingProject p = requireOwnProject(teacherId, projectId);
        if (!"PUBLISHED".equals(status) && !"OFFLINE".equals(status)) {
            throw new BizException("状态仅支持上架（PUBLISHED）/ 下架（OFFLINE）");
        }
        p.setStatus(status);
        p.setUpdatedAt(LocalDateTime.now());
        codingProjectMapper.updateById(p);
        return toProjectDto(p);
    }

    /** 删除项目（级联删除学生项目与全部版本） */
    @Transactional
    public void delete(Long teacherId, Long projectId) {
        CodingProject p = requireOwnProject(teacherId, projectId);
        List<StudentProject> sps = studentProjectMapper.selectList(new LambdaQueryWrapper<StudentProject>()
                .eq(StudentProject::getProjectId, p.getId()));
        if (!sps.isEmpty()) {
            projectVersionMapper.delete(new LambdaQueryWrapper<ProjectVersion>()
                    .in(ProjectVersion::getStudentProjectId, sps.stream().map(StudentProject::getId).collect(Collectors.toList())));
            studentProjectMapper.delete(new LambdaQueryWrapper<StudentProject>()
                    .eq(StudentProject::getProjectId, p.getId()));
        }
        codingProjectMapper.deleteById(p.getId());
    }

    /** 教师实时查看：项目下所有学生的完成进度（仅统计学生已通过「保存并提交」开放的可见版本） */
    public Map<String, Object> progress(Long teacherId, Long projectId) {
        CodingProject p = requireOwnProject(teacherId, projectId);
        List<StudentProject> sps = studentProjectMapper.selectList(new LambdaQueryWrapper<StudentProject>()
                .eq(StudentProject::getProjectId, p.getId())
                .orderByDesc(StudentProject::getUpdatedAt));
        List<Map<String, Object>> rows = new ArrayList<>();
        for (StudentProject sp : sps) {
            User u = userMapper.selectById(sp.getStudentId());
            if (u == null) {
                continue;
            }
            // 教师可见版本：仅统计水位之内（version_no <= submitted_version_no）的版本，
            // 水位之后的未提交版本对学生保密——版本数 / 最新保存 / 代码量 / 说明均不外泄
            List<ProjectVersion> vs = visibleVersions(sp);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("studentProjectId", sp.getId());
            row.put("studentId", u.getId());
            row.put("name", u.getRealName());
            row.put("studentNo", u.getStudentNo());
            row.put("status", sp.getStatus());
            row.put("submittedVersionNo", sp.getSubmittedVersionNo());  // 提交水位：教师端「版本筛选」依据
            row.put("versionCount", vs.size());
            ProjectVersion last = vs.isEmpty() ? null : vs.get(0);
            row.put("lastVersionNo", last == null ? null : last.getVersionNo());
            row.put("lastVersionAt", last == null ? null : last.getCreatedAt().format(DT));
            row.put("lastSummary", last == null ? null : last.getSummary());
            row.put("codeSize", last == null ? 0 : last.getCodeSize());
            row.put("updatedAt", sp.getUpdatedAt().format(DT));
            rows.add(row);
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("project", toProjectDto(p));
        result.put("students", rows);
        return result;
    }

    /** 教师在线查看：某学生项目的版本列表（仅水位之内已开放版本，轻量不含代码正文）。
     *  返回 {controlled, versions}：controlled=项目是否受控迭代（前端「打回代码」按钮权限依据）；
     *  版本行含 rejected/rejectReason 打回状态（学生重新提交后复位）。 */
    public Map<String, Object> studentVersions(Long teacherId, Long studentProjectId) {
        StudentProject sp = requireViewableStudentProject(teacherId, studentProjectId);
        CodingProject p = codingProjectMapper.selectById(sp.getProjectId());
        List<Map<String, Object>> versions = new ArrayList<>();
        for (ProjectVersion v : visibleVersions(sp)) {
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("id", v.getId());
            dto.put("versionNo", v.getVersionNo());
            dto.put("summary", v.getSummary());
            dto.put("reflection", v.getReflection());
            dto.put("score", scoreDto(v));
            dto.put("codeSize", v.getCodeSize());
            dto.put("fileCount", parseFiles(v.getFiles()).size());
            dto.put("rejected", v.getRejected() != null && v.getRejected() == 1 ? 1 : 0);
            dto.put("rejectReason", v.getRejectReason());
            dto.put("createdAt", v.getCreatedAt().format(DT));
            versions.add(dto);
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("controlled", p != null && p.getControlledIteration() != null && p.getControlledIteration() == 1 ? 1 : 0);
        result.put("versions", versions);
        return result;
    }

    /**
     * 教师打回代码版本（仅受控迭代项目）：将学生最新已提交版本标记为打回并填写理由。
     * 打回语义 = 回退迭代重做：学生当前迭代回退到被打回版本号，水位之上的未提交草稿
     * 一并作废删除（重做后基于合格版本重新迭代），被打回版本保持已提交可见状态；
     * 学生重新编辑后「保存并提交」该版本（版本号不变）即视为重做完成——rejected 复位、迭代恢复推进。
     * 同时向学生推送站内通知。
     * 链式打回规则：仅「已提交版本中版本号最大的未打回版本」可打回——初始仅最新提交版本可打回；
     * 每打回一个版本，其紧邻的上一历史版本自动获得打回入口，教师按版本提交逆序依次打回，
     * 不可跳过中间版本直接打回更早版本；全部已提交版本均被打回后无版本可再打回。
     */
    @Transactional
    public void rejectVersion(Long teacherId, Long versionId, String reason) {
        ProjectVersion v = projectVersionMapper.selectById(versionId);
        if (v == null) {
            throw new BizException("代码版本不存在");
        }
        StudentProject sp = requireViewableStudentProject(teacherId, v.getStudentProjectId());
        CodingProject p = codingProjectMapper.selectById(sp.getProjectId());
        if (p == null || p.getControlledIteration() == null || p.getControlledIteration() != 1) {
            throw new BizException("仅开启「控制版本迭代」的项目支持打回代码");
        }
        Integer watermark = sp.getSubmittedVersionNo();
        if (watermark == null || v.getVersionNo() > watermark) {
            throw new BizException("该版本尚未提交：学生点击「保存并提交」后版本才会对教师可见");
        }
        // 可打回版本 = 已提交版本中版本号最大的未打回版本（列表按版本号降序，取首个未打回）
        List<ProjectVersion> submitted = projectVersionMapper.selectList(new LambdaQueryWrapper<ProjectVersion>()
                .eq(ProjectVersion::getStudentProjectId, sp.getId())
                .le(ProjectVersion::getVersionNo, watermark)
                .orderByDesc(ProjectVersion::getVersionNo));
        ProjectVersion rejectable = submitted.stream()
                .filter(x -> x.getRejected() == null || x.getRejected() != 1)
                .findFirst().orElse(null);
        if (rejectable == null) {
            throw new BizException("该学生的全部已提交版本均已被打回，暂无可打回版本");
        }
        if (!rejectable.getId().equals(v.getId())) {
            throw new BizException("仅可按版本逆序依次打回：当前可打回版本为 v" + rejectable.getVersionNo()
                    + "，请先完成较新版本的打回");
        }
        String r = reason == null ? "" : reason.trim();
        if (r.isEmpty()) {
            throw new BizException("请填写打回理由");
        }
        if (r.length() > 500) {
            throw new BizException("打回理由不能超过 500 字");
        }
        // ① 作废水位之上的未提交草稿（version_no > 水位必为未提交草稿；链式打回时被提交的历史版本行不受影响）
        projectVersionMapper.delete(new LambdaQueryWrapper<ProjectVersion>()
                .eq(ProjectVersion::getStudentProjectId, sp.getId())
                .gt(ProjectVersion::getVersionNo, watermark));
        // ② 标记打回状态与理由
        v.setRejected(1);
        v.setRejectReason(r);
        projectVersionMapper.updateById(v);
        // ③ 迭代回退至被打回版本（即当前最深打回版本）：学生从该版本起重做
        //    （受控保存 keep 覆盖更新该版本号，版本号不变；若上方仍有被打回版本，逐版本向上依次重做）
        sp.setCurrentIteration(v.getVersionNo());
        sp.setUpdatedAt(LocalDateTime.now());
        studentProjectMapper.updateById(sp);
        // ④ 站内通知学生
        notificationService.push(sp.getStudentId(),
                "你的项目「" + p.getTitle() + "」v" + v.getVersionNo()
                        + " 版本代码已被教师打回：" + shortenFor(r, 80)
                        + "，请修改后重新提交该版本", "PROJECT");
        log.info("[项目打回] teacher={} sp={} version={} reasonLen={}",
                teacherId, sp.getId(), v.getVersionNo(), r.length());
    }

    /** 教师在线查看：某版本完整代码文件（仅水位之内的版本，未开放版本一律拒绝） */
    public Map<String, Object> versionDetail(Long teacherId, Long versionId) {
        ProjectVersion v = projectVersionMapper.selectById(versionId);
        if (v == null) {
            throw new BizException("代码版本不存在");
        }
        StudentProject sp = requireViewableStudentProject(teacherId, v.getStudentProjectId());
        Integer watermark = sp.getSubmittedVersionNo();
        if (watermark == null || v.getVersionNo() > watermark) {
            throw new BizException("该版本尚未开放查看：学生点击「保存并提交」后版本才会对教师可见");
        }
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("id", v.getId());
        dto.put("studentProjectId", v.getStudentProjectId());
        dto.put("versionNo", v.getVersionNo());
        dto.put("summary", v.getSummary());
        dto.put("reflection", v.getReflection());
        dto.put("codeSize", v.getCodeSize());
        dto.put("rejected", v.getRejected() != null && v.getRejected() == 1 ? 1 : 0);
        dto.put("rejectReason", v.getRejectReason());
        dto.put("createdAt", v.getCreatedAt().format(DT));
        dto.put("files", parseFiles(v.getFiles()));
        dto.put("score", scoreDto(v));
        return dto;
    }

    /* ==================== 版本 AI 评分（教师端触发，同步学生端） ==================== */

    /** AI 评分代码长度上限：超出截断，防超长 token 打爆请求 */
    private static final int AI_CODE_LIMIT = 6000;

    /**
     * 教师触发 AI 评分：根据项目需求（含迭代路线各阶段任务）与该版本代码、版本说明、学生反思，
     * 评估该版本对当前阶段需求的完成度，生成 0-100 初评分与评语并写入版本行。
     * 仅教师可见水位内的版本可评分；AI 结果仅写 ai_score/ai_comment，教师已有调整不受影响。
     */
    @Transactional
    public Map<String, Object> aiScoreVersion(Long teacherId, Long versionId) {
        ProjectVersion v = requireVisibleVersion(teacherId, versionId);
        CodingProject p = codingProjectMapper.selectById(
                studentProjectMapper.selectById(v.getStudentProjectId()).getProjectId());
        StringBuilder prompt = new StringBuilder("你是 Java 课程编程项目评审老师。请根据项目需求与该学生版本的代码，");
        prompt.append("评估该版本对项目需求（或当前迭代阶段任务）的完成度，给出 0-100 的整数分数与简短评语（100~200字，肯定完成点，指出不足与改进建议）。\n\n");
        prompt.append("【项目需求说明】\n").append(shortenFor(p.getDescription(), 1500)).append('\n');
        List<Map<String, String>> roadmap = parseRoadmap(p.getRoadmap());
        if (!roadmap.isEmpty()) {
            prompt.append("【项目迭代路线（分阶段任务）】\n");
            for (int i = 0; i < roadmap.size(); i++) {
                Map<String, String> it = roadmap.get(i);
                prompt.append("阶段").append(i + 1).append("：").append(it.getOrDefault("title", ""))
                        .append(" —— ").append(it.getOrDefault("desc", "")).append('\n');
            }
        }
        if (v.getSummary() != null && !v.getSummary().isBlank()) {
            prompt.append("【该版本学生说明】\n").append(shortenFor(v.getSummary(), 500)).append('\n');
        }
        if (v.getReflection() != null && !v.getReflection().isBlank()) {
            prompt.append("【学生总结反思】\n").append(shortenFor(v.getReflection(), 800)).append('\n');
        }
        prompt.append("【该版本代码】\n");
        int used = 0;
        for (Map<String, String> f : parseFiles(v.getFiles())) {
            String content = f.getOrDefault("content", "");
            String part = content.length() + used > AI_CODE_LIMIT
                    ? content.substring(0, Math.max(0, AI_CODE_LIMIT - used)) + "\n…（过长已截断）" : content;
            used += part.length();
            prompt.append("--- ").append(f.getOrDefault("path", "")).append(" ---\n").append(part).append('\n');
            if (used >= AI_CODE_LIMIT) { break; }
        }
        prompt.append("\n严格只输出 JSON：{\"score\":0-100整数,\"comment\":\"评语\"}");

        String raw;
        try {
            raw = llmClient.chat(List.of(ChatMessage.user(prompt.toString())),
                    deepSeekProperties.getGradeTemperature());
        } catch (RuntimeException e) {
            throw new BizException("AI 评分暂不可用，请稍后重试");
        }
        int score;
        String comment;
        try {
            JsonNode n = objectMapper.readTree(extractJson(raw));
            score = n.path("score").asInt(-1);
            comment = n.path("comment").asText("");
        } catch (Exception e) {
            throw new BizException("AI 评分结果解析失败，请重试");
        }
        if (score < 0 || score > 100 || comment.isBlank()) {
            throw new BizException("AI 评分结果异常，请重试");
        }
        v.setAiScore(score);
        v.setAiComment(comment.trim());
        projectVersionMapper.updateById(v);
        return scoreDto(v);
    }

    /**
     * 教师调整评分：写 teacher_score/teacher_comment（覆盖展示），score 允许为空（沿用现有展示分）、
     * comment 允许为空（清空教师评语、回显 AI 评语）；范围为 0-100、评语 ≤2000 字。
     */
    @Transactional
    public Map<String, Object> teacherScoreVersion(Long teacherId, Long versionId, Integer score, String comment) {
        ProjectVersion v = requireVisibleVersion(teacherId, versionId);
        if (score != null && (score < 0 || score > 100)) {
            throw new BizException("评分范围为 0-100 分");
        }
        String c = comment == null ? null : comment.trim();
        if (c != null && c.isEmpty()) {
            c = null;
        }
        if (c != null && c.length() > 2000) {
            throw new BizException("评语不能超过 2000 字");
        }
        v.setTeacherScore(score);
        v.setTeacherComment(c);
        projectVersionMapper.updateById(v);
        return scoreDto(v);
    }

    /** 权限：版本必须存在且处于教师可见水位之内（与代码查看同口径） */
    private ProjectVersion requireVisibleVersion(Long teacherId, Long versionId) {
        ProjectVersion v = projectVersionMapper.selectById(versionId);
        if (v == null) {
            throw new BizException("代码版本不存在");
        }
        StudentProject sp = requireViewableStudentProject(teacherId, v.getStudentProjectId());
        Integer watermark = sp.getSubmittedVersionNo();
        if (watermark == null || v.getVersionNo() > watermark) {
            throw new BizException("该版本尚未开放评分：学生提交后版本才会对教师可见");
        }
        return v;
    }

    /**
     * 版本评分 DTO（教师/学生端共用）：
     * aiScore/aiComment=AI 初评；teacherScore/teacherComment=教师调整；finalScore/source 供展示端直接取用。
     */
    private Map<String, Object> scoreDto(ProjectVersion v) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("aiScore", v.getAiScore());
        dto.put("aiComment", v.getAiComment());
        dto.put("teacherScore", v.getTeacherScore());
        dto.put("teacherComment", v.getTeacherComment());
        dto.put("finalScore", v.getTeacherScore() != null ? v.getTeacherScore() : v.getAiScore());
        dto.put("teacherAdjusted", v.getTeacherScore() != null || v.getTeacherComment() != null);
        return dto;
    }

    private String shortenFor(String s, int limit) {
        if (s == null) {
            return "";
        }
        return s.length() > limit ? s.substring(0, limit) + "…（过长已截断）" : s;
    }

    private String extractJson(String raw) {
        if (raw == null) {
            return "{}";
        }
        String t = raw.trim().replace("```json", "").replace("```", "").trim();
        int start = t.indexOf('{');
        int end = t.lastIndexOf('}');
        if (start >= 0 && end > start) {
            return t.substring(start, end + 1);
        }
        return t;
    }

    /**
     * 教师可见版本清单：学生项目全部版本中 version_no <= 提交水位的子集（按版本号降序）。
     * 水位为 NULL（从未提交）时返回空清单——教师不可感知任何版本信息。
     */
    private List<ProjectVersion> visibleVersions(StudentProject sp) {
        Integer watermark = sp.getSubmittedVersionNo();
        if (watermark == null) {
            return List.of();
        }
        return projectVersionMapper.selectList(new LambdaQueryWrapper<ProjectVersion>()
                        .eq(ProjectVersion::getStudentProjectId, sp.getId())
                        .le(ProjectVersion::getVersionNo, watermark)
                        .orderByDesc(ProjectVersion::getVersionNo));
    }

    /* ==================== 学生端 ==================== */

    /** 学生视角项目列表：本班全部上架项目 + 我的项目状态（实时接收教师发布） */
    public List<Map<String, Object>> myProjects(Long userId) {
        User user = userMapper.selectById(userId);
        if (user == null || user.getClassId() == null) {
            return List.of();
        }
        List<CodingProject> projects = codingProjectMapper.selectList(new LambdaQueryWrapper<CodingProject>()
                .eq(CodingProject::getClassId, user.getClassId())
                .eq(CodingProject::getStatus, "PUBLISHED")
                .orderByDesc(CodingProject::getUpdatedAt));
        List<Map<String, Object>> result = new ArrayList<>();
        for (CodingProject p : projects) {
            Map<String, Object> dto = toProjectDto(p);
            StudentProject sp = studentProjectMapper.selectOne(new LambdaQueryWrapper<StudentProject>()
                    .eq(StudentProject::getProjectId, p.getId())
                    .eq(StudentProject::getStudentId, userId));
            if (sp != null) {
                ProjectVersion last = projectVersionMapper.selectOne(new LambdaQueryWrapper<ProjectVersion>()
                        .eq(ProjectVersion::getStudentProjectId, sp.getId())
                        .orderByDesc(ProjectVersion::getVersionNo)
                        .last("LIMIT 1"));
                dto.put("mine", studentProjectDto(sp, last));
            }
            result.add(dto);
        }
        return result;
    }

    /** 学生创建项目（每项目一份，重复创建幂等返回已有） */
    @Transactional
    public Map<String, Object> start(Long userId, Long projectId) {
        User user = userMapper.selectById(userId);
        if (user == null || user.getClassId() == null) {
            throw new BizException("学生未加入班级");
        }
        CodingProject p = codingProjectMapper.selectById(projectId);
        if (p == null || !Objects.equals(p.getClassId(), user.getClassId()) || !"PUBLISHED".equals(p.getStatus())) {
            throw new BizException("项目不存在或未开放");
        }
        StudentProject sp = studentProjectMapper.selectOne(new LambdaQueryWrapper<StudentProject>()
                .eq(StudentProject::getProjectId, projectId)
                .eq(StudentProject::getStudentId, userId));
        if (sp == null) {
            // 并发下唯一键兜底：第二个插入报 DuplicateKey 由全局异常处理器转 400，事务内幂等
            try {
                sp = new StudentProject();
                sp.setProjectId(projectId);
                sp.setStudentId(userId);
                sp.setStatus("IN_PROGRESS");
                // 受控迭代项目：创建即进入第 1 个迭代；自由开发项目不使用迭代序号
                if (p.getControlledIteration() != null && p.getControlledIteration() == 1) {
                    sp.setCurrentIteration(1);
                }
                sp.setCreatedAt(LocalDateTime.now());
                sp.setUpdatedAt(LocalDateTime.now());
                studentProjectMapper.insert(sp);
            } catch (org.springframework.dao.DuplicateKeyException e) {
                sp = studentProjectMapper.selectOne(new LambdaQueryWrapper<StudentProject>()
                        .eq(StudentProject::getProjectId, projectId)
                        .eq(StudentProject::getStudentId, userId));
            }
        }
        ProjectVersion last = projectVersionMapper.selectOne(new LambdaQueryWrapper<ProjectVersion>()
                .eq(ProjectVersion::getStudentProjectId, sp.getId())
                .orderByDesc(ProjectVersion::getVersionNo)
                .last("LIMIT 1"));
        return studentProjectDto(sp, last);
    }

    /**
     * 学生保存代码：版本策略由用户在保存弹窗中选择。
     * mode=keep  → 保留当前版本：覆盖更新最新版本内容（files/summary/codeSize/时间），版本号不变；
     * mode=iterate 或缺省 → 迭代新版本（多版本留存，历史版本完整保留），版本号 = 最新版本号 + 1；
     * reflection → 总结反思（≤2000 字）：仅随「保存并提交」（submit=true）写入并与本次版本绑定，
     *              仅保存不触碰已有反思（历史反思保留）；submit=true 同时标记提交。
     * 并发安全：行锁取最新版本 + 唯一键兜底，版本号不冲突、不重复、不跳号。
     */
    @Transactional
    public Map<String, Object> save(Long userId, Long studentProjectId, String filesJson, String summary, Boolean submit, String mode, String reflection) {
        StudentProject sp = studentProjectMapper.selectById(studentProjectId);
        if (sp == null || !Objects.equals(sp.getStudentId(), userId)) {
            throw new BizException("项目不存在或无权操作");
        }
        CodingProject p = codingProjectMapper.selectById(sp.getProjectId());
        if (p == null || !"PUBLISHED".equals(p.getStatus())) {
            throw new BizException("项目已下架，无法继续开发");
        }
        List<Map<String, String>> files = parseFiles(filesJson);
        if (files.isEmpty()) {
            throw new BizException("至少保存一个代码文件");
        }
        for (Map<String, String> f : files) {
            if (f.get("path") == null || f.get("path").isBlank()) {
                throw new BizException("文件名不能为空");
            }
        }
        // 总结反思：去空白、限长（与前端 maxlength=2000 一致）
        String ref = reflection == null ? null : reflection.trim();
        if (ref != null && ref.isEmpty()) {
            ref = null;
        }
        if (ref != null && ref.length() > 2000) {
            throw new BizException("总结反思不能超过 2000 字");
        }
        // 序号行锁防并发保存撞号（配合唯一键）；同一学生连续保存版本号严格递增
        ProjectVersion last = projectVersionMapper.selectOne(new LambdaQueryWrapper<ProjectVersion>()
                .eq(ProjectVersion::getStudentProjectId, sp.getId())
                .orderByDesc(ProjectVersion::getVersionNo)
                .last("LIMIT 1 FOR UPDATE"));
        // 受控迭代项目：版本号严格受当前迭代约束，保证学生版本数与迭代路线总数对齐——
        // ① 新迭代尚未建版本时 keep 自动转为迭代（保存/提交一律落到当前迭代版本）；
        // ② iterate 不得超出当前迭代阶段（防绕过前端直调 API 产生路线外版本）；
        // ③ 已到最终迭代时仅可覆盖更新当前版本，提交不再推进（封顶），版本数不越界
        int lastNo = last == null ? 0 : last.getVersionNo();
        // 链式打回重做目标：最新版本号 > 当前迭代（= 当前最深被打回版本）说明存在待重做的历史版本，
        // keep 覆盖目标须切换为版本号最小的被打回版本行（而非最新版本行），学生从最深打回版本起
        // 逐版本向上重做（keep 覆盖 + 提交复位），保证重做始终落在被打回版本上、版本号不变
        ProjectVersion redoTarget = null;
        if (p.getControlledIteration() != null && p.getControlledIteration() == 1) {
            int curIter = sp.getCurrentIteration() == null ? 1 : sp.getCurrentIteration();
            if ("keep".equals(mode) && lastNo < curIter) {
                mode = "iterate";
            } else if (!"keep".equals(mode) && lastNo >= curIter) {
                throw new BizException("当前迭代为 v" + curIter + "：仅可保存为该版本，完成「保存并提交」后才解锁下一迭代");
            }
            if ("keep".equals(mode) && last != null && lastNo > curIter) {
                redoTarget = projectVersionMapper.selectOne(new LambdaQueryWrapper<ProjectVersion>()
                        .eq(ProjectVersion::getStudentProjectId, sp.getId())
                        .eq(ProjectVersion::getRejected, 1)
                        .orderByAsc(ProjectVersion::getVersionNo)
                        .last("LIMIT 1 FOR UPDATE"));
            }
        }
        int size = files.stream().mapToInt(f -> (f.get("content") == null ? "" : f.get("content"))
                .getBytes(java.nio.charset.StandardCharsets.UTF_8).length + f.get("path").getBytes().length).sum();
        ProjectVersion v;
        if ("keep".equals(mode) && last != null) {
            // 保留当前版本：覆盖更新当前重做目标版本（链式打回重做时为最深被打回版本，常规为最新版本），
            // 版本号保持不变（尚无版本时按 v1 新建）；仅保存（非提交）不触碰反思字段——已有总结反思原样保留
            v = redoTarget != null ? redoTarget : last;
            try {
                v.setFiles(objectMapper.writeValueAsString(files));
            } catch (Exception e) {
                throw new BizException("代码文件格式不正确");
            }
            v.setSummary(summary == null ? null : summary.trim());
            v.setCodeSize(size);
            v.setCreatedAt(LocalDateTime.now());
            boolean wasRejected = v.getRejected() != null && v.getRejected() == 1;
            if (Boolean.TRUE.equals(submit)) {
                v.setReflection(ref);
                // 打回重做提交：重做完成，打回状态与理由复位（学生端不再显示打回提醒）
                if (wasRejected) {
                    v.setRejected(0);
                    v.setRejectReason(null);
                }
            }
            projectVersionMapper.updateById(v);
            // MyBatis-Plus updateById 默认跳过 null 字段（NOT_NULL 策略）：
            // reject_reason 置空必须走显式 set null 的条件更新，否则理由残留、学生端仍显示打回提醒
            if (Boolean.TRUE.equals(submit) && wasRejected) {
                projectVersionMapper.update(null, new LambdaUpdateWrapper<ProjectVersion>()
                        .eq(ProjectVersion::getId, v.getId())
                        .set(ProjectVersion::getRejected, 0)
                        .set(ProjectVersion::getRejectReason, null));
            }
        } else {
            // 迭代新版本（原自动留存逻辑）：版本号 = 最新版本号 + 1，无历史版本时为 v1；
            // 总结反思仅随提交写入新版本，仅保存的版本反思为空
            int nextNo = last == null ? 1 : last.getVersionNo() + 1;
            v = new ProjectVersion();
            v.setStudentProjectId(sp.getId());
            v.setVersionNo(nextNo);
            try {
                v.setFiles(objectMapper.writeValueAsString(files));
            } catch (Exception e) {
                throw new BizException("代码文件格式不正确");
            }
            v.setSummary(summary == null ? null : summary.trim());
            v.setReflection(Boolean.TRUE.equals(submit) ? ref : null);
            v.setCodeSize(size);
            v.setCreatedAt(LocalDateTime.now());
            projectVersionMapper.insert(v);
        }
        if (Boolean.TRUE.equals(submit)) {
            if (!"SUBMITTED".equals(sp.getStatus())) {
                sp.setStatus("SUBMITTED");
            }
            // 提交即开放：教师可见版本水位原子刷新为当前版本号——当前版本及全部历史版本即刻对教师可见，
            // 后续「仅保存新版本」产生的版本仍不可见；与版本写入同事务，无延迟、无遗漏、无越界。
            // 水位只升不降：链式打回重做历史版本（版本号 < 水位）时，其后已提交版本的教师可见性保持不变
            int wmBefore = sp.getSubmittedVersionNo() == null ? 0 : sp.getSubmittedVersionNo();
            sp.setSubmittedVersionNo(Math.max(wmBefore, v.getVersionNo()));
            if (p.getControlledIteration() != null && p.getControlledIteration() == 1) {
                if (redoTarget != null) {
                    // 链式打回重做提交：打回链逆序连续（f+1..水位在打回时已全部打回），
                    // 完成最深版本 f 的重做后，迭代停在紧邻的下一个待重做版本 f+1（封顶兜底不越界）
                    sp.setCurrentIteration(Math.min(v.getVersionNo() + 1, Math.max(parseRoadmap(p.getRoadmap()).size(), 1)));
                } else {
                    // 受控迭代项目：提交即视为完成当前迭代 → 解锁下一迭代（封顶不越界；
                    // 历史存量 sp 的 current_iteration 为 NULL 时按第 1 迭代处理）
                    int iterCount = parseRoadmap(p.getRoadmap()).size();
                    int cur = sp.getCurrentIteration() == null ? 1 : sp.getCurrentIteration();
                    sp.setCurrentIteration(Math.min(cur + 1, Math.max(iterCount, 1)));
                }
            }
        }
        sp.setUpdatedAt(LocalDateTime.now());
        studentProjectMapper.updateById(sp);
        return studentProjectDto(sp, v);
    }

    /** 学生打开我的项目：最新代码 + 版本列表 */
    public Map<String, Object> mine(Long userId, Long studentProjectId) {
        StudentProject sp = studentProjectMapper.selectById(studentProjectId);
        if (sp == null || !Objects.equals(sp.getStudentId(), userId)) {
            throw new BizException("项目不存在或无权查看");
        }
        CodingProject p = codingProjectMapper.selectById(sp.getProjectId());
        if (p == null) {
            throw new BizException("项目不存在");
        }
        List<ProjectVersion> vs = projectVersionMapper.selectList(new LambdaQueryWrapper<ProjectVersion>()
                .eq(ProjectVersion::getStudentProjectId, sp.getId())
                .orderByDesc(ProjectVersion::getVersionNo));
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("project", toProjectDto(p));
        ProjectVersion last = vs.isEmpty() ? null : vs.get(0);
        // 链式打回重做中：编辑基准切换为版本号最小的被打回版本（最深打回版本）——
        // 学生打开 IDE 基于该版本代码重做，逐版本向上依次完成；非重做状态基准仍为最新版本
        ProjectVersion base = last;
        if (sp.getSubmittedVersionNo() != null) {
            base = vs.stream()
                    .filter(x -> x.getRejected() != null && x.getRejected() == 1
                            && x.getVersionNo() <= sp.getSubmittedVersionNo())
                    .min(Comparator.comparingInt(ProjectVersion::getVersionNo))
                    .orElse(last);
        }
        result.put("mine", studentProjectDto(sp, last, base));
        // 版本迭代记录逐版本附带提交状态：version_no <= 提交水位 即为「已提交」（已随提交对教师开放），
        // 水位之后为「未提交」；从未提交（水位 NULL）时全部为未提交——状态与可见性规则同源，杜绝状态错配
        Integer watermark = sp.getSubmittedVersionNo();
        result.put("versions", vs.stream().map(v -> {
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("id", v.getId());
            dto.put("versionNo", v.getVersionNo());
            dto.put("summary", v.getSummary());
            dto.put("codeSize", v.getCodeSize());
            dto.put("createdAt", v.getCreatedAt().format(DT));
            dto.put("submitted", watermark != null && v.getVersionNo() <= watermark);
            dto.put("reflection", v.getReflection());
            dto.put("rejected", v.getRejected() != null && v.getRejected() == 1 ? 1 : 0);
            dto.put("rejectReason", v.getRejectReason());
            dto.put("score", scoreDto(v));
            return dto;
        }).collect(Collectors.toList()));
        return result;
    }

    /** 单次运行输出上限（字节），防止死循环刷屏打爆响应 */
    private static final int RUN_OUTPUT_LIMIT = 32 * 1024;
    private static final Pattern MAIN_PATTERN = Pattern.compile("static\\s+void\\s+main\\s*\\(");
    private static final Pattern PUBLIC_CLASS_PATTERN = Pattern.compile("public\\s+class\\s+([A-Za-z_$][\\w$]*)");
    private static final Pattern SAFE_JAVA_NAME = Pattern.compile("[\\w$.-]+\\.java");

    /**
     * 学生运行代码（IDE 风格运行能力）：临时目录写盘 → javac 编译（语法校验）→ java 执行入口类。
     * 编译失败返回 javac 诊断；运行捕获 stdout+stderr 合并输出，超时强制终止；
     * stdin：预置标准输入（≤4KB）写入进程后立即关闭，支持 Scanner 等输入型程序；
     * 运行不留存任何数据，代码版本仍以「保存」为准，结束即清理临时目录。
     */
    public Map<String, Object> run(Long userId, Long studentProjectId, String filesJson, String stdin) {
        StudentProject sp = studentProjectMapper.selectById(studentProjectId);
        if (sp == null || !Objects.equals(sp.getStudentId(), userId)) {
            throw new BizException("项目不存在或无权操作");
        }
        CodingProject p = codingProjectMapper.selectById(sp.getProjectId());
        if (p == null) {
            throw new BizException("项目不存在");
        }
        List<Map<String, String>> files = parseFiles(filesJson);
        if (files.isEmpty()) {
            throw new BizException("至少需要一个代码文件");
        }
        List<Map<String, String>> javaFiles = new ArrayList<>();
        for (Map<String, String> f : files) {
            String path = f.get("path");
            // 文件名校验：仅允许本目录内的 .java 平面文件名（防路径穿越与非法资源写入）
            if (path == null || !SAFE_JAVA_NAME.matcher(path).matches()) {
                throw new BizException("文件名不合法（仅支持 .java 文件，不允许路径分隔符）");
            }
            javaFiles.add(f);
        }
        // 入口类解析：优先取含 main 方法的 public 类（与声明文件名一致由 javac 校验）
        String mainClass = null;
        for (Map<String, String> f : javaFiles) {
            String content = f.get("content") == null ? "" : f.get("content");
            if (MAIN_PATTERN.matcher(content).find()) {
                Matcher cm = PUBLIC_CLASS_PATTERN.matcher(content);
                if (cm.find()) {
                    mainClass = cm.group(1);
                    break;
                }
            }
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("mainClass", mainClass);
        if (mainClass == null) {
            result.put("ok", false);
            result.put("stage", "ENTRY");
            result.put("output", "未找到可运行入口：需要一个包含 public static void main(String[] args) 的 public 类。");
            return result;
        }
        boolean win = System.getProperty("os.name", "").toLowerCase().contains("win");
        Path dir = null;
        try {
            dir = Files.createTempDirectory("la-run-");
            for (Map<String, String> f : javaFiles) {
                Files.writeString(dir.resolve(f.get("path")),
                        f.get("content") == null ? "" : f.get("content"), StandardCharsets.UTF_8);
            }
            String javac = Paths.get(System.getProperty("java.home"), "bin", win ? "javac.exe" : "javac").toString();
            // 诊断固定英文（避免中文 Windows 上 javac 输出 GBK 与 UTF-8 读取产生乱码）；
            // 工作目录=临时目录 + 相对路径执行，诊断信息不带系统临时路径前缀，更贴近 IDE 展示
            List<String> compileCmd = new ArrayList<>();
            compileCmd.add(javac);
            compileCmd.add("-J-Duser.language=en");
            compileCmd.add("-encoding");
            compileCmd.add("UTF-8");
            compileCmd.add("-d");
            compileCmd.add(".");
            for (Map<String, String> f : javaFiles) {
                compileCmd.add(f.get("path"));
            }
            ProcOut co = exec(compileCmd, 15, dir, null);
            if (co.exit() != 0) {
                result.put("ok", false);
                result.put("stage", "COMPILE");
                result.put("output", co.output().isBlank()
                        ? "编译未通过（语法校验失败），退出代码 " + co.exit()
                        : "编译未通过（语法校验失败）：\n" + co.output());
                return result;
            }
            String javaBin = Paths.get(System.getProperty("java.home"), "bin", win ? "java.exe" : "java").toString();
            // -Dstdout/-Dstderr.encoding=UTF-8：JDK 19+ 管道场景 System.out 默认取 native 编码
            //（中文 Windows = GBK），导致中文输出乱码；显式固定 UTF-8 与读取端一致
            ProcOut ro = exec(List.of(javaBin, "-Dfile.encoding=UTF-8",
                            "-Dstdout.encoding=UTF-8", "-Dstderr.encoding=UTF-8", "-cp", ".", mainClass),
                    10, dir, stdin);
            result.put("ok", ro.exit() == 0);
            result.put("stage", "RUN");
            result.put("exitCode", ro.exit());
            result.put("timeout", ro.timeout());
            result.put("output", ro.output());
            return result;
        } catch (IOException e) {
            throw new BizException("运行环境异常，请稍后再试");
        } finally {
            if (dir != null) {
                deleteRecursively(dir);
            }
        }
    }

    /** 进程执行：合并输出流、限时等待、超时连后代一起强杀；stdin 预置标准输入（≤4KB，写完即关闭） */
    private record ProcOut(int exit, String output, boolean timeout) { }

    private static final int STDIN_LIMIT = 4 * 1024;

    private ProcOut exec(List<String> cmd, int timeoutSec, Path workDir, String stdin) throws IOException {
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.directory(workDir.toFile());
        pb.redirectErrorStream(true);
        Process proc = pb.start();
        // 预置标准输入：守护线程写入后立即关闭——Scanner 等输入型程序读到 EOF 正常结束。
        // 线程化写入避免极端情况下（Windows 管道缓冲小于输入量且程序未及时消费）主线程阻塞；
        // 未提供 stdin 时同样关闭写入端，程序读 System.in 直接得到 EOF
        Thread stdinWriter = new Thread(() -> {
            try (var os = proc.getOutputStream()) {
                if (stdin != null && !stdin.isBlank()) {
                    String safe = stdin.length() > STDIN_LIMIT ? stdin.substring(0, STDIN_LIMIT) : stdin;
                    os.write(safe.getBytes(StandardCharsets.UTF_8));
                    os.flush();
                }
            } catch (IOException e) {
                // 程序提前退出导致管道关闭，属正常现象，不影响输出捕获
            }
        });
        stdinWriter.setDaemon(true);
        stdinWriter.start();
        StringBuilder buf = new StringBuilder();
        Thread reader = new Thread(() -> {
            try (BufferedReader r = new BufferedReader(
                    new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8))) {
                char[] chunk = new char[2048];
                int c;
                while ((c = r.read(chunk)) >= 0) {
                    if (buf.length() < RUN_OUTPUT_LIMIT) {
                        buf.append(chunk, 0, Math.min(c, RUN_OUTPUT_LIMIT - buf.length()));
                    }
                }
            } catch (Exception e) {
                // 进程被终止时输入流关闭，属正常现象
            }
        });
        reader.setDaemon(true);
        reader.start();
        boolean finished = false;
        try {
            finished = proc.waitFor(timeoutSec, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        if (!finished) {
            proc.descendants().forEach(ProcessHandle::destroyForcibly);
            proc.destroyForcibly();
            try { reader.join(1000); } catch (InterruptedException e) { /* 忽略 */ }
            String out = buf.length() > RUN_OUTPUT_LIMIT ? buf.substring(0, RUN_OUTPUT_LIMIT) : buf.toString();
            return new ProcOut(-1, out + "\n运行超时（" + timeoutSec + " 秒），进程已被强制终止。", true);
        }
        try { reader.join(1500); } catch (InterruptedException e) { /* 忽略 */ }
        String out = buf.length() > RUN_OUTPUT_LIMIT
                ? buf.substring(0, RUN_OUTPUT_LIMIT) + "\n…（输出过长已截断）"
                : buf.toString();
        return new ProcOut(proc.exitValue(), out, false);
    }

    private void deleteRecursively(Path dir) {
        try (var walk = Files.walk(dir)) {
            walk.sorted(Comparator.reverseOrder()).forEach(f -> {
                try { Files.deleteIfExists(f); } catch (Exception e) { // 清理尽力而为
                }
            });
        } catch (Exception e) { // 清理尽力而为
        }
    }

    /* ==================== 私有 ==================== */

    /**
     * 教师可管理班级口径：授课班级（class.teacher_id）∪ 共同管理班级；
     * 教师无任何可管理班级时回退兼容演示账号（与作业管理 deleteAssignment 同口径）
     */
    private List<Long> manageableClassIds(Long teacherId) {
        List<Long> ids = new ArrayList<>(classMapper.selectList(new LambdaQueryWrapper<ClassEntity>()
                        .eq(ClassEntity::getTeacherId, teacherId))
                .stream().map(ClassEntity::getId).toList());
        classCoTeacherMapper.selectList(new LambdaQueryWrapper<ClassCoTeacher>()
                        .eq(ClassCoTeacher::getTeacherId, teacherId))
                .forEach(ct -> {
                    if (!ids.contains(ct.getClassId())) {
                        ids.add(ct.getClassId());
                    }
                });
        return ids;
    }

    private void requireManageable(Long teacherId, Long classId) {
        List<Long> own = manageableClassIds(teacherId);
        if (!own.isEmpty() && !own.contains(classId)) {
            throw new BizException("无权管理该班级");
        }
    }

    private CodingProject requireOwnProject(Long teacherId, Long projectId) {
        CodingProject p = codingProjectMapper.selectById(projectId);
        if (p == null) {
            throw new BizException("项目不存在");
        }
        try {
            requireManageable(teacherId, p.getClassId());
        } catch (BizException e) {
            throw new BizException("无权操作该项目");
        }
        return p;
    }

    private StudentProject requireViewableStudentProject(Long teacherId, Long studentProjectId) {
        StudentProject sp = studentProjectMapper.selectById(studentProjectId);
        if (sp == null) {
            throw new BizException("学生项目不存在");
        }
        CodingProject p = codingProjectMapper.selectById(sp.getProjectId());
        if (p == null) {
            throw new BizException("项目不存在");
        }
        try {
            requireManageable(teacherId, p.getClassId());
        } catch (BizException e) {
            throw new BizException("无权查看该项目");
        }
        return sp;
    }

    private Map<String, Object> toProjectDto(CodingProject p) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("id", p.getId());
        dto.put("classId", p.getClassId());
        dto.put("title", p.getTitle());
        dto.put("description", p.getDescription());
        dto.put("status", p.getStatus());
        dto.put("roadmap", parseRoadmap(p.getRoadmap()));
        dto.put("controlled", p.getControlledIteration() != null && p.getControlledIteration() == 1 ? 1 : 0);
        dto.put("createdAt", p.getCreatedAt() == null ? null : p.getCreatedAt().format(DT));
        dto.put("updatedAt", p.getUpdatedAt() == null ? null : p.getUpdatedAt().format(DT));
        return dto;
    }

    /**
     * 迭代路线清洗：解析 JSON 数组 [{name,title,desc}] → 过滤全空项 → 限长
     * （迭代名称20/标题60/描述2000）→ 迭代名称去除非法字符 → 上限 10 项；
     * 清洗后为空返回 NULL（选填，未配置不占存储）；JSON 非法按未配置处理不拦截发布。
     */
    private String sanitizeRoadmap(String roadmapJson) {
        List<Map<String, String>> items = parseRoadmap(roadmapJson);
        List<Map<String, String>> cleaned = new ArrayList<>();
        for (Map<String, String> it : items) {
            String name = it.getOrDefault("name", "") == null ? "" : it.getOrDefault("name", "").trim();
            String title = it.getOrDefault("title", "") == null ? "" : it.getOrDefault("title", "").trim();
            String desc = it.getOrDefault("desc", "") == null ? "" : it.getOrDefault("desc", "").trim();
            if (title.isEmpty() && desc.isEmpty()) {
                continue;  // 全空项不保存
            }
            Map<String, String> row = new LinkedHashMap<>();
            if (!name.isEmpty()) {
                row.put("name", sanitizeIterName(name));
            }
            row.put("title", title.length() > 60 ? title.substring(0, 60) : title);
            row.put("desc", desc.length() > 2000 ? desc.substring(0, 2000) : desc);
            cleaned.add(row);
        }
        if (cleaned.size() > 10) {
            throw new BizException("项目迭代路线最多支持 10 个迭代版本");
        }
        if (cleaned.isEmpty()) {
            return null;
        }
        try {
            return objectMapper.writeValueAsString(cleaned);
        } catch (Exception e) {
            return null;
        }
    }

    /** 迭代名称清洗：≤20 字；剔除路径/引号/尖括号等易引发注入或显示异常的非法字符 */
    private String sanitizeIterName(String name) {
        String s = name.replaceAll("[<>:\"\\\\/|?*\\u0000-\\u001F]", "").trim();
        return s.length() > 20 ? s.substring(0, 20) : s;
    }

    /** 迭代路线解析：JSON 字符串 → List<Map>；null/非法/非对象结构一律返回空列表 */
    private List<Map<String, String>> parseRoadmap(String roadmapJson) {
        if (roadmapJson == null || roadmapJson.isBlank()) {
            return List.of();
        }
        try {
            return objectMapper.readValue(roadmapJson, new TypeReference<List<Map<String, String>>>() {
            });
        } catch (Exception e) {
            return List.of();
        }
    }

    private Map<String, Object> studentProjectDto(StudentProject sp, ProjectVersion last) {
        return studentProjectDto(sp, last, last);
    }

    /**
     * last = 实际最新版本（决定版本总数）；base = 编辑基准版本（链式打回重做时为最深被打回版本，
     * 学生端 IDE 以 base 的代码为编辑底稿；常规场景 base = last）
     */
    private Map<String, Object> studentProjectDto(StudentProject sp, ProjectVersion last, ProjectVersion base) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("id", sp.getId());
        dto.put("projectId", sp.getProjectId());
        dto.put("status", sp.getStatus());
        dto.put("currentIteration", sp.getCurrentIteration());
        dto.put("versionCount", last == null ? 0 : last.getVersionNo());
        dto.put("lastFiles", base == null ? List.of() : parseFiles(base.getFiles()));
        dto.put("lastSummary", base == null ? null : base.getSummary());
        dto.put("lastVersionAt", base == null ? null : base.getCreatedAt().format(DT));
        dto.put("updatedAt", sp.getUpdatedAt() == null ? null : sp.getUpdatedAt().format(DT));
        return dto;
    }

    private List<Map<String, String>> parseFiles(String filesJson) {
        if (filesJson == null || filesJson.isBlank()) {
            return List.of();
        }
        try {
            return objectMapper.readValue(filesJson, new TypeReference<List<Map<String, String>>>() {
            });
        } catch (Exception e) {
            return List.of();
        }
    }
}
