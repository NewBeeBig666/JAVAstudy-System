package com.la.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("`session`")
public class SessionEntity {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    private String title;

    private Long kpId;

    /** 多知识点会话的所选编码列表（逗号分隔），单选时为空 */
    private String kps;

    /** ACTIVE / DONE */
    private String status;

    private Integer stepIndex;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;
}
