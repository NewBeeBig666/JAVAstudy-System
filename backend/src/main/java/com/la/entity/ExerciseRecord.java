package com.la.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("exercise_record")
public class ExerciseRecord {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    private Long exerciseId;

    private Long kpId;

    private Integer selected;

    /** 非选择题型的文本作答 */
    private String answer;

    private Boolean isCorrect;

    private Integer delta;

    private Integer hintUsed;

    private LocalDateTime createdAt;
}
