package com.la.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

@Data
@TableName("knowledge_point")
public class KnowledgePoint {

    @TableId(type = IdType.AUTO)
    private Long id;

    /** 对外字符串编码，如 kp-collection / m1 */
    private String kpCode;

    private String name;

    private Long parentId;

    /** 1 一级（模块）/ 2-7 二~七级（课程知识点树，V10 起） */
    private Integer level;

    /** 一级模块归属 kp_code（V10 起，课程体系节点） */
    private String moduleCode;

    /** XLSX=课程体系节点（图谱与出题可见）/ LEGACY=历史兼容节点（仅存量数据引用） */
    private String source;

    /** 教学大纲单元号 1-11 */
    private Integer unitNo;

    /** 教师端软删除 0/1（重置可恢复；CUSTOM 节点重置时物理清除） */
    private Integer deleted;

    private String description;

    /** JSON 数组字符串 */
    private String resources;

    private Integer sortOrder;
}
