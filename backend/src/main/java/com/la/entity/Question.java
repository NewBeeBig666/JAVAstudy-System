package com.la.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.math.BigDecimal;

@Data
@TableName("question")
public class Question {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long assignmentId;

    /** SINGLE / MULTI / FILL / JUDGE / SHORT / CODE */
    private String type;

    private String title;

    /** JSON 数组字符串：[{"key":"A","text":".."}]（单选/多选） */
    private String options;

    /** JSON：单选 ["A"] / 多选 ["A","B"] / 判断 [true] / 其余为文本 */
    private String answer;

    /** 答案解析 */
    private String analysis;

    /** 难度系数 0-1，越大越易 */
    private BigDecimal difficulty;

    /** 关联知识点编码 */
    private String kpCode;

    /** CUSTOM 模式每题分值 */
    private BigDecimal score;

    private Integer sortOrder;
}
