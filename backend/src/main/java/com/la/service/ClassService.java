package com.la.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.la.entity.*;
import com.la.exception.BizException;
import com.la.mapper.*;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/**
 * 班级管理（教师端学情看板左侧栏「授课班级」）：
 * - 删除班级：仅班级所有者可操作（前后端双重权限校验）；
 * - 级联清空该班级的关联管理权限与数据关联关系：共同管理教师、作业（含提交/评分/题目）、
 *   预警、学习资源（含学习进度），学生账号保留但移出该班级（class_id 置空）；
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

    /** 删除班级（仅所有者；事务内级联清理关联数据；幂等：班级不存在时静默成功） */
    @Transactional
    public void deleteClass(Long teacherId, Long classId) {
        if (classId == null) {
            throw new BizException("缺少班级参数");
        }
        ClassEntity cls = classMapper.selectById(classId);
        if (cls == null) {
            // 幂等：重复提交 / 班级已被删除时不再报错，保证多次删除结果一致
            return;
        }
        if (cls.getTeacherId() == null || !cls.getTeacherId().equals(teacherId)) {
            throw new BizException("仅班级所有者可以删除班级");
        }

        // 1) 清空共同管理教师权限（对应教师随即失去该班级的管理入口）
        coTeacherMapper.delete(new LambdaQueryWrapper<ClassCoTeacher>()
                .eq(ClassCoTeacher::getClassId, classId));

        // 2) 级联删除该班作业：提交评分 → 学生提交 → Rubric → 题目 → 作业
        List<Assignment> assigns = assignmentMapper.selectList(new LambdaQueryWrapper<Assignment>()
                .eq(Assignment::getClassId, classId));
        if (!assigns.isEmpty()) {
            List<Long> aIds = assigns.stream().map(Assignment::getId).toList();
            List<Submission> subs = submissionMapper.selectList(new LambdaQueryWrapper<Submission>()
                    .in(Submission::getAssignmentId, aIds));
            if (!subs.isEmpty()) {
                rubricScoreMapper.delete(new LambdaQueryWrapper<RubricScore>()
                        .in(RubricScore::getSubmissionId, subs.stream().map(Submission::getId).toList()));
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

        // 4) 级联删除该班学习资源及其学习进度记录
        List<LearningResource> resources = learningResourceMapper.selectList(
                new LambdaQueryWrapper<LearningResource>()
                        .eq(LearningResource::getClassId, classId));
        if (!resources.isEmpty()) {
            resourceProgressMapper.delete(new LambdaQueryWrapper<ResourceProgress>()
                    .in(ResourceProgress::getResourceId,
                            resources.stream().map(LearningResource::getId).toList()));
            learningResourceMapper.delete(new LambdaQueryWrapper<LearningResource>()
                    .eq(LearningResource::getClassId, classId));
        }

        // 5) 学生账号保留，但移出该班级（解除关联关系）
        userMapper.update(null, new LambdaUpdateWrapper<User>()
                .set(User::getClassId, null)
                .eq(User::getClassId, classId));

        // 6) 删除班级本身
        classMapper.deleteById(classId);
    }
}
