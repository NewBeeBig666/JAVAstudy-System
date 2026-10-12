package com.la.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("submission")
public class Submission {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long assignmentId;

    private Long studentId;

    private String code;

    /** 题目型作业的结构化作答：JSON 数组 [{questionId, value}] */
    private String answers;

    /** MISSING / PENDING / AI_REVIEWED / GRADED */
    private String status;

    private Integer attempts;

    private Integer similarity;

    private Integer aiScore;

    private String aiComment;

    private String teacherComment;

    private Integer score;

    private LocalDateTime submittedAt;

    private LocalDateTime gradedAt;
}