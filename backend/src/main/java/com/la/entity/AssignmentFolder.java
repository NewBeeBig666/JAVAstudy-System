package com.la.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/** 作业文件夹：教师端作业管理左侧栏自定义分组（NULL folder_id = 内置「其他」）；
 * 绑定班级维度 (teacher_id, class_id)，文件夹列表严格跟随当前选中班级 */
@Data
@TableName("assignment_folder")
public class AssignmentFolder {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long teacherId;

    private Long classId;

    private String name;

    private LocalDateTime createdAt;
}
