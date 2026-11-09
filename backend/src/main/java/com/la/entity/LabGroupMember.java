package com.la.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/** 实验报告作业小组成员（同一学生在同一作业内至多一个小组：uk_lgm_stu_assign 兜底） */
@Data
@TableName("lab_group_member")
public class LabGroupMember {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long groupId;

    /** 冗余作业 id：唯一约束 (student_id, assignment_id) 与直查用 */
    private Long assignmentId;

    private Long studentId;

    private LocalDateTime createdAt;
}
