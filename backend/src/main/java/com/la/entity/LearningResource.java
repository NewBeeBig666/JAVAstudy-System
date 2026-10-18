package com.la.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 学习资源：教师上传的 PPT / 视频 / 图片 / Word / PDF，
 * AI 识别内容后生成简介并关联系统内知识点
 */
@Data
@TableName("learning_resource")
public class LearningResource {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long classId;

    private Long teacherId;

    private String title;

    private String fileName;

    /** 服务器存储相对路径（uploads/resource/ 下） */
    private String filePath;

    /** ppt / word / pdf / video / image */
    private String fileType;

    /** 文件大小（字节） */
    private Long fileSize;

    /** 关联知识点编码，JSON 数组字符串：["kp-array","kp-loop"] */
    private String kpCodes;

    /** AI 生成的内容简介 */
    private String aiSummary;

    private LocalDateTime createdAt;
}
