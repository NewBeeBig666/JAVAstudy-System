package com.la.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.la.entity.LabGroup;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

public interface LabGroupMapper extends BaseMapper<LabGroup> {

    /** 行锁读取小组：接受邀请/队长邀人时串行化同一小组的人数校验，防止并发超员 */
    @Select("SELECT * FROM lab_group WHERE id = #{id} FOR UPDATE")
    LabGroup selectByIdForUpdate(@Param("id") Long id);

    /** 锁定读取作业内最大序号小组：并发建组时取号互斥（配合唯一键不撞号） */
    @Select("SELECT * FROM lab_group WHERE assignment_id = #{assignmentId} ORDER BY seq DESC LIMIT 1 FOR UPDATE")
    LabGroup selectLastByAssignmentForUpdate(@Param("assignmentId") Long assignmentId);
}
