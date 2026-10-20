package com.la.dto.response;

import lombok.AllArgsConstructor;
import lombok.Data;

import java.time.LocalDate;

@Data
@AllArgsConstructor
public class AttemptResponse {

    private boolean correct;
    private Integer answer;
    private String analysis;
    private int delta;
    /** 做对 = 回写后的新掌握度；做错 = 原掌握度（无记录时为 null，表示暂无数据） */
    private Integer newMastery;
    private boolean wrongBookAdded;
    private LocalDate reviewNext;
}
