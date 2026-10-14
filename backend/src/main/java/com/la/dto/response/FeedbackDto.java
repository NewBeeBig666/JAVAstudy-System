package com.la.dto.response;

import lombok.Data;

/**
 * 教师端反馈列表项：学生标识 + 类型 + 内容 + 提交时间
 */
@Data
public class FeedbackDto {

    private Long id;

    /** 学生姓名 */
    private String studentName;

    /** 学号（登录名兜底） */
    private String studentNo;

    /** BUG / SUGGESTION / FEATURE */
    private String type;

    private String content;

    /** 展示用时间，如 10-14 09:30 */
    private String createdAt;
}
