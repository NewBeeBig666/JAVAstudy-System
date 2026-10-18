package com.la.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 学生在「学习资源」模块的学习进度
 */
@Data
@TableName("resource_progress")
public class ResourceProgress {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    private Long resourceId;

    /** 查看次数 */
    private Integer viewCount;

    /** 是否已学完 0/1 */
    private Integer completed;

    private LocalDateTime firstViewedAt;

    private LocalDateTime lastViewedAt;
}
