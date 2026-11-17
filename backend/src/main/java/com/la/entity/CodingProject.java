package com.la.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/** 教师发布的编程项目（需求说明 + 上/下架状态管理） */
@Data
@TableName("coding_project")
public class CodingProject {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long classId;

    private Long teacherId;

    private String title;

    /** 项目需求说明（详细要求，长文本） */
    private String description;

    /** PUBLISHED=已上架（学生可见） OFFLINE=已下架 */
    private String status;

    /** 项目迭代路线 JSON：[{name,title,desc}]，最多 10 项（选填），教师配置、学生端时间线展示 */
    private String roadmap;

    /** 控制版本迭代开关：0=自由开发 1=受控迭代（学生端按迭代逐版本解锁，完成当前迭代前不可切换） */
    private Integer controlledIteration;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;
}
