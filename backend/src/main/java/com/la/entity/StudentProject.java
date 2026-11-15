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

    /**
     * 教师可见版本水位：version_no <= 该值的版本对教师端开放查看；
     * 仅学生点击「保存并提交」时原子更新为当前版本号；NULL=未开放任何版本（学生本地不受影响）
     */
    private Integer submittedVersionNo;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;
}
