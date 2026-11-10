package com.la.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.entity.*;
import com.la.exception.BizException;
import com.la.mapper.*;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/**
 * 班级管理（教师端学情看板左侧栏「授课班级」）：
 * - 删除/退出班级按操作者身份分流：
 *   · 班级所有者 → 删除整个班级（级联清空关联管理权限与数据关联关系：共同管理教师、
 *     作业（含提交/评分/题目）、预警、学习资源（含学习进度），学生账号保留但移出该班级）；
 *   · 共同管理教师 → 仅退出该班级（删除自己的 class_co_teacher 关联行），
 *     班级本身与其他教师账号中的完整数据不受影响；其他教师的共同管理列表随即不再显示该教师；
 *   · 与班级无任何关联的教师 → 拒绝（400 仅班级所有者可以删除班级）；
 * - 幂等：目标班级不存在（含已被删除）时直接视为成功返回，不报错、不产生副作用。
 */
@Service
@RequiredArgsConstructor
public class ClassService {

    private final ClassMapper classMapper;
    private final ClassCoTeacherMapper coTeacherMapper;
    private final AssignmentMapper assignmentMapper;
    private final SubmissionMapper submissionMapper;
    private final RubricMapper rubricMapper;
    private final RubricScoreMapper rubricScoreMapper;
    private final QuestionMapper questionMapper;
    private final WarningMapper warningMapper;
    private final LearningResourceMapper learningResourceMapper;
    private final ResourceProgressMapper resourceProgressMapper;
    private final UserMapper userMapper;
    /** 磁盘文件 best-effort 清理：解析 LAB 报告提交中的存储文件名用 */
    private static final ObjectMapper JSON = new ObjectMapper();

    /** 上传目录基址（与 ResourceService/AssignmentService 存储口径一致） */
    private static final Path RESOURCE_DIR = Path.of("uploads", "resource");
    private static final Path REPORT_DIR = Path.of("uploads", "report");

    /** 安全删除上传目录内的文件：解析后必须仍位于基目录下（防路径穿越），失败静默不影响主流程 */
    private void deleteUploadedFile(Path base, String relativeName) {
        if (relativeName == null || relativeName.isBlank()) {
            return;
        }
        try {
            Path absBase = base.toAbsolutePath().normalize();
            Path target = absBase.resolve(relativeName).normalize();
            if (target.startsWith(absBase)) {
                Files.deleteIfExists(target);
            }
        } catch (Exception ignore) { }
    }

    /**
     * 删除/退出班级（按操作者身份分流）：
     * - 所有者 → 硬删整个班级（级联清理，行为不变）→ action=deleted
     * - 共同管理教师 → 仅删除自己的关联行（退出班级）→ action=left
     * - 幂等：班级不存在时静默成功（action=deleted）
     */
    @Transactional
    public Map<String, Object> deleteClass(Long teacherId, Long classId) {
        if (classId == null) {
            throw new BizException("缺少班级参数");
        }
        ClassEntity cls = classMapper.selectById(classId);
        if (cls == null) {
            // 幂等：重复提交 / 班级已被删除时不再报错，保证多次删除结果一致
            return Map.of("action", "deleted");
        }
        boolean isOwner = cls.getTeacherId() != null && cls.getTeacherId().equals(teacherId);
        if (!isOwner) {
            // 非所有者：须为共同管理教师，删除 = 仅退出自己（班级数据与其他教师不受影响）
            Long coCnt = coTeacherMapper.selectCount(new LambdaQueryWrapper<ClassCoTeacher>()
                    .eq(ClassCoTeacher::getClassId, classId)
                    .eq(ClassCoTeacher::getTeacherId, teacherId));
            if (coCnt == null || coCnt == 0) {
                throw new BizException("仅班级所有者可以删除班级");
            }
            coTeacherMapper.delete(new LambdaQueryWrapper<ClassCoTeacher>()
                    .eq(ClassCoTeacher::getClassId, classId)
                    .eq(ClassCoTeacher::getTeacherId, teacherId));
            return Map.of("action", "left");
        }

        // 1) 清空共同管理教师权限（对应教师随即失去该班级的管理入口）
        coTeacherMapper.delete(new LambdaQueryWrapper<ClassCoTeacher>()
                .eq(ClassCoTeacher::getClassId, classId));

        // 2) 级联删除该班作业：提交评分 → 学生提交（含磁盘实验报告文件）→ Rubric → 题目 → 作业
        List<Assignment> assigns = assignmentMapper.selectList(new LambdaQueryWrapper<Assignment>()
                .eq(Assignment::getClassId, classId));
        if (!assigns.isEmpty()) {
            List<Long> aIds = assigns.stream().map(Assignment::getId).toList();
            List<Submission> subs = submissionMapper.selectList(new LambdaQueryWrapper<Submission>()
                    .in(Submission::getAssignmentId, aIds));
            if (!subs.isEmpty()) {
                rubricScoreMapper.delete(new LambdaQueryWrapper<RubricScore>()
                        .in(RubricScore::getSubmissionId, subs.stream().map(Submission::getId).toList()));
                // LAB 报告的磁盘文件随提交记录一并清理（best-effort，失败不影响事务）
                for (Submission s : subs) {
                    String stored = extractReportFile(s.getAnswers());
                    if (stored != null) {
                        deleteUploadedFile(REPORT_DIR, stored);
                    }
                }
            }
            submissionMapper.delete(new LambdaQueryWrapper<Submission>()
                    .in(Submission::getAssignmentId, aIds));
            rubricMapper.delete(new LambdaQueryWrapper<Rubric>()
                    .in(Rubric::getAssignmentId, aIds));
            questionMapper.delete(new LambdaQueryWrapper<Question>()
                    .in(Question::getAssignmentId, aIds));
            assignmentMapper.delete(new LambdaQueryWrapper<Assignment>()
                    .eq(Assignment::getClassId, classId));
        }

        // 3) 清空该班预警
        warningMapper.delete(new LambdaQueryWrapper<Warning>()
                .eq(Warning::getClassId, classId));

        // 4) 级联删除该班学习资源（DB 记录 + 学习进度 + 磁盘文件）
        List<LearningResource> resources = learningResourceMapper.selectList(
                new LambdaQueryWrapper<LearningResource>()
                        .eq(LearningResource::getClassId, classId));
        if (!resources.isEmpty()) {
            resourceProgressMapper.delete(new LambdaQueryWrapper<ResourceProgress>()
                    .in(ResourceProgress::getResourceId,
                            resources.stream().map(LearningResource::getId).toList()));
            learningResourceMapper.delete(new LambdaQueryWrapper<LearningResource>()
                    .eq(LearningResource::getClassId, classId));
            for (LearningResource r : resources) {
                deleteUploadedFile(RESOURCE_DIR, r.getFilePath());
            }
        }

        // 5) 学生账号保留，但移出该班级（解除关联关系）
        userMapper.update(null, new LambdaUpdateWrapper<User>()
                .set(User::getClassId, null)
                .eq(User::getClassId, classId));

        // 6) 删除班级本身
        classMapper.deleteById(classId);
        return Map.of("action", "deleted");
    }

    /** 从提交 answers JSON 中提取实验报告存储文件名（数组/对象两种历史格式兼容） */
    private String extractReportFile(String answers) {
        if (answers == null || answers.isBlank()) {
            return null;
        }
        try {
            JsonNode n = JSON.readTree(answers);
            if (n.isArray()) {
                for (JsonNode item : n) {
                    String f = item.path("reportFile").asText("");
                    if (!f.isBlank()) {
                        return f;
                    }
                }
            }
            String f = n.path("reportFile").asText("");
            return f.isBlank() ? null : f;
        } catch (Exception e) {
            return null;
        }
    }
}
