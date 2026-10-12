package com.la.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("assignment")
public class Assignment {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long teacherId;

    private Long classId;

    private String title;

    private String description;

    /** JSON 数组字符串：知识点编码 */
    private String kpIds;

    private LocalDateTime dueAt;

    /** DRAFT / ONGOING / CLOSED */
    private String status;

    /** 出题组卷：评分机制 AVERAGE=百分制均分 / CUSTOM=自定义分值（NULL 表示 Rubric 型作业） */
    private String scoreMode;

    /** 出题组卷：有效时段开始时间（结束时间复用 dueAt） */
    private LocalDateTime startAt;

    /** 出题组卷：允许学生补交 0/1 */
    private Integer allowLate;

    private LocalDateTime createdAt;
}