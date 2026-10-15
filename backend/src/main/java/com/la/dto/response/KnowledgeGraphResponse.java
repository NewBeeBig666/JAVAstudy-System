package com.la.dto.response;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * 知识图谱全层级响应（数据源：课程知识点 Excel 全量树）
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class KnowledgeGraphResponse {

    /** 一级模块（首页气泡） */
    private List<ModuleDto> modules;

    /** 全部课程体系节点（平铺 + parentCode 组树） */
    private List<NodeDto> nodes;

    /** PRE 依赖边（from 依赖 to） */
    private List<EdgeDto> edges;

    @Data
    public static class ModuleDto {
        private String code;
        private String name;
        private String color;

        public ModuleDto(String code, String name, String color) {
            this.code = code;
            this.name = name;
            this.color = color;
        }
    }

    @Data
    public static class NodeDto {
        private String code;
        private String name;
        private String parentCode;
        private String moduleCode;
        private Integer level;
        private Integer sortOrder;
        /** 本人掌握度（0-100，无记录为 null） */
        private Integer mastery;
        /** 知识点文字说明（V11 起全量补全） */
        private String desc;

        public NodeDto(String code, String name, String parentCode, String moduleCode,
                       Integer level, Integer sortOrder, Integer mastery, String desc) {
            this.code = code;
            this.name = name;
            this.parentCode = parentCode;
            this.moduleCode = moduleCode;
            this.level = level;
            this.sortOrder = sortOrder;
            this.mastery = mastery;
            this.desc = desc;
        }
    }

    @Data
    public static class EdgeDto {
        private String from;
        private String to;

        public EdgeDto(String from, String to) {
            this.from = from;
            this.to = to;
        }
    }
}
