package com.la.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/** 自行组队邀请：PENDING / ACCEPTED / REJECTED / EXPIRED（被邀请人已加入其他队伍） */
@Data
@TableName("lab_group_invite")
public class LabGroupInvite {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long assignmentId;

    /** 发起邀请的学生（队长） */
    private Long fromStudentId;

    /** 被邀请学生 */
    private Long toStudentId;

    private String status;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;
}
