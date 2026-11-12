package com.la.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/** 学生项目代码版本（每次保存自动生成新版本，多版本留存；files 为 JSON 数组 [{path,content}]） */
@Data
@TableName("project_version")
public class ProjectVersion {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long studentProjectId;

    /** 版本号（同一学生项目内递增） */
    private Integer versionNo;

    /** 代码文件 JSON：[{path:"Main.java", content:"..."}] */
    private String files;

    /** 本版本说明 */
    private String summary;

    /** 代码总字节数 */
    private Integer codeSize;

    private LocalDateTime createdAt;
}
