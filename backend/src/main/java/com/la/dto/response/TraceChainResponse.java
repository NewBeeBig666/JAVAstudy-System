package com.la.dto.response;

import lombok.AllArgsConstructor;
import lombok.Data;

import java.util.List;

@Data
@AllArgsConstructor
public class TraceChainResponse {

    private List<ChainNode> chain;
    /** 最弱根因知识点编码，可为 null */
    private String rootCause;
    private String conclusion;

    @Data
    @AllArgsConstructor
    public static class ChainNode {
        private String id;
        private String name;
        private int mastery;
        private String note;
        /** 是否已有掌握数据（学生做过该知识点的练习/作业）；false 时 mastery 的 0 不代表真实掌握度 */
        private boolean hasData;
    }
}
