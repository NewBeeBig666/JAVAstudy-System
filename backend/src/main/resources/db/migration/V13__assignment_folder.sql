-- V13: 作业文件夹 —— 教师端作业管理左侧栏自定义文件夹分组收纳作业
-- 历史作业 folder_id 为 NULL，统一归属前端内置的「其他」文件夹（不可删除）

CREATE TABLE `assignment_folder` (
  id         BIGINT       NOT NULL AUTO_INCREMENT,
  teacher_id BIGINT       NOT NULL COMMENT '创建教师 id',
  name       VARCHAR(50)  NOT NULL COMMENT '文件夹名称',
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_folder_teacher (teacher_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='作业文件夹';

ALTER TABLE `assignment` ADD COLUMN folder_id BIGINT NULL COMMENT '所属文件夹（NULL=其他）';
