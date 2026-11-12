package com.la.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/** 教师发布的编程项目（需求说明 + 上/下架状态管理） */
@Data
@TableName("coding_project")
public class CodingProject {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long classId;

    private Long teacherId;

    private String title;

    /** 项目需求说明（详细要求，长文本） */
    private String description;

    /** PUBLISHED=已上架（学生可见） OFFLINE=已下架 */
    private String status;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;
}
