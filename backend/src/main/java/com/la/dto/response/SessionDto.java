package com.la.dto.response;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * 学习会话 DTO（形状对齐 MOCK.sessions）
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class SessionDto {

    private String id;
    private String title;
    private String kp;
    /** 多知识点会话的所选知识点编码列表（单选会话为空数组） */
    private List<String> kps;
    private String status;
    private String createdAt;
    private String updatedAt;
    private Integer stepIndex;
    private List<StepDto> steps;
    private List<MessageDto> messages;

    @Data
    @AllArgsConstructor
    public static class StepDto {
        private String title;
        private String desc;
        private String dur;
        private String status;
    }

    @Data
    @AllArgsConstructor
    public static class MessageDto {
        private String id;
        private String from;
        private String agent;
        private String time;
        private String text;
        private Object card;
    }
}
