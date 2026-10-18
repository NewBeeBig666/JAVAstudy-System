-- V12: 学习资源模块 —— 教师上传 PPT/视频/图片/Word/PDF，AI 识别内容并关联知识点；学生查看并记录学习进度

CREATE TABLE `learning_resource` (
  id         BIGINT        NOT NULL AUTO_INCREMENT,
  class_id   BIGINT        NOT NULL COMMENT '所属班级 id',
  teacher_id BIGINT        NOT NULL COMMENT '上传教师 id',
  title      VARCHAR(200)  NOT NULL COMMENT '资源标题',
  file_name  VARCHAR(255)  NOT NULL COMMENT '原始文件名',
  file_path  VARCHAR(500)  NOT NULL COMMENT '服务器存储相对路径（uploads/resource/ 下）',
  file_type  VARCHAR(20)   NOT NULL COMMENT '类型：ppt/word/pdf/video/image',
  file_size  BIGINT        NOT NULL COMMENT '文件大小（字节）',
  kp_codes   TEXT          NULL COMMENT '关联知识点编码（JSON 数组字符串，AI 识别 + 教师选择）',
  ai_summary VARCHAR(1000) NULL COMMENT 'AI 生成的内容简介',
  created_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_res_class (class_id),
  KEY idx_res_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='学习资源';

CREATE TABLE `resource_progress` (
  id              BIGINT   NOT NULL AUTO_INCREMENT,
  user_id         BIGINT   NOT NULL COMMENT '学生 id',
  resource_id     BIGINT   NOT NULL COMMENT '资源 id',
  view_count      INT      NOT NULL DEFAULT 0 COMMENT '查看次数',
  completed       TINYINT  NOT NULL DEFAULT 0 COMMENT '是否已学完 0/1',
  first_viewed_at DATETIME NULL,
  last_viewed_at  DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_user_res (user_id, resource_id),
  KEY idx_rp_res (resource_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='学习资源学习进度';
