package com.la.dto;

import lombok.Data;

import java.util.List;
import java.util.Map;

/**
 * 出题组卷：保存/发布题目型作业请求
 */
@Data
public class ComposeRequest {

    /** 为空 = 新建，否则为修改 */
    private Long id;

    private Long classId;

    private String title;

    /** 评分机制：AVERAGE=百分制均分 / CUSTOM=自定义分值 */
    private String scoreMode;

    /** 有效时段开始时间 yyyy-MM-dd HH:mm */
    private String startAt;

    /** 有效时段结束时间 yyyy-MM-dd HH:mm（存入 dueAt） */
    private String endAt;

    /** 允许学生补交 */
    private Boolean allowLate;

    /** DRAFT / ONGOING */
    private String status;

    /** 教师在「关联知识点」面板选择的作业级知识点编码（作业展示/掌握度回写以此为准） */
    private List<String> kps;

    /** 实验报告作业：Word 模板对应的学习资源 ID（scoreMode=LAB 时必填） */
    private Long labTemplateId;

    /** 实验报告作业：模板标题（资源标题，展示用） */
    private String labTemplateTitle;

    /** 实验报告作业：开启分组实验（scoreMode=LAB 时有效） */
    private Boolean groupEnabled;

    /** 分组模式：RANDOM=随机分组 / SELF=学生自行组队 */
    private String groupMode;

    /** 分组数量：随机分组用于均衡分配；自行组队用于折算每组人数上限 */
    private Integer groupCount;

    /** 所属作业文件夹（NULL/缺省 = 内置「其他」；修改时仅在该值非空时覆盖） */
    private Long folderId;

    private List<QuestionReq> questions;

    @Data
    public static class QuestionReq {
        /** 编辑场景携带原题目 id：未变化的题目按 id 原位更新保持稳定
         *  （学生已提交作答按 questionId 关联，全删重建会使历史作答全部失配） */
        private Long id;
        /** SINGLE / MULTI / FILL / JUDGE / SHORT / CODE */
        private String type;
        private String title;
        /** [{"key":"A","text":".."}]（单选/多选） */
        private List<Map<String, Object>> options;
        /** 单选 ["A"] / 多选 ["A","B"] / 判断 [true] / 其余为文本 */
        private Object answer;
        private String analysis;
        private Double difficulty;
        private String kpCode;
        /** CUSTOM 模式每题分值 */
        private Double score;
    }
}
