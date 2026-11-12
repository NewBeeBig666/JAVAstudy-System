package com.la.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/** 学生的项目实现（每学生对每项目一份，唯一键防重复创建） */
@Data
@TableName("student_project")
public class StudentProject {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long projectId;

    private Long studentId;

    /** IN_PROGRESS=开发中 SUBMITTED=已提交 */
    private String status;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;
}
