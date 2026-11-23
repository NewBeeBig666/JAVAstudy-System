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

    /** 总结反思：学生针对该版本代码的总结与反思，随「保存并提交」写入并与版本绑定 */
    private String reflection;

    /** AI 初评分（0-100）：教师端触发，根据版本代码与项目/迭代路线需求生成 */
    private Integer aiScore;

    /** AI 初评评语 */
    private String aiComment;

    /** 教师调整后评分（0-100，覆盖 AI 初评展示；NULL=未调整） */
    private Integer teacherScore;

    /** 教师修改后评语（NULL=未修改） */
    private String teacherComment;

    /** 代码总字节数 */
    private Integer codeSize;

    /** 教师打回标记 0/1：打回后学生重新编辑提交该版本（版本号不变），提交后复位 0 */
    private Integer rejected;

    /** 打回理由（教师打回时填写，≤500 字，学生端可见） */
    private String rejectReason;

    private LocalDateTime createdAt;
}
