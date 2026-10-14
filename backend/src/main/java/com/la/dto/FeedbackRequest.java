package com.la.dto;

import lombok.Data;

/**
 * 学生反馈提交请求
 */
@Data
public class FeedbackRequest {

    /** BUG / SUGGESTION / FEATURE */
    private String type;

    /** 反馈内容（必填，1-1000 字） */
    private String content;
}
