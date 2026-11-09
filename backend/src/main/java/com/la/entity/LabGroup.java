package com.la.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/** 实验报告作业小组（随机分组发布时生成 / 自行组队由首位邀请人创建） */
@Data
@TableName("lab_group")
public class LabGroup {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long assignmentId;

    /** 作业内小组序号（名称=第N组；唯一键 (assignment_id, seq) 防并发撞号） */
    private Integer seq;

    /** 小组名称（第N组） */
    private String name;

    /** 组长学生 id（随机分组=组内随机指定；自行组队=首位发起邀请者） */
    private Long leaderStudentId;

    private LocalDateTime createdAt;
}
