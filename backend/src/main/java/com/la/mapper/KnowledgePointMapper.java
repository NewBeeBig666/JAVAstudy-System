package com.la.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.la.entity.KnowledgePoint;
import org.apache.ibatis.annotations.Update;

public interface KnowledgePointMapper extends BaseMapper<KnowledgePoint> {

    /**
     * 重置：按初始快照（knowledge_point_initial，V24 固化）逐字段还原课程体系节点——
     * parent_id / level / module_code / sort_order / name / description / deleted，
     * 撤销教师端的移动与属性编辑，保证所有层级模块与初始默认状态完全一致。
     */
    @Update("UPDATE knowledge_point k JOIN knowledge_point_initial s ON k.id = s.id " +
            "SET k.parent_id = s.parent_id, k.level = s.level, k.module_code = s.module_code, " +
            "k.sort_order = s.sort_order, k.name = s.name, k.description = s.description, " +
            "k.deleted = 0 WHERE k.source = 'XLSX'")
    int restoreFromSnapshot();
}
