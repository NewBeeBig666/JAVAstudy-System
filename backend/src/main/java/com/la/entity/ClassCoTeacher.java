package com.la.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/** 班级共同管理教师：班级所有者授权其他教师共同管理该班级 */
@Data
@TableName("class_co_teacher")
public class ClassCoTeacher {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long classId;

    private Long teacherId;

    private LocalDateTime createdAt;
}
