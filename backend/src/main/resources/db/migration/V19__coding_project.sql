-- v1.20.8 「项目代码」板块：教师发布编程项目 / 学生创建项目并多版本留存 / 教师实时查看进度与代码
-- coding_project   教师发布的项目（需求说明 + 上/下架状态管理）
-- student_project  学生对某项目的实现（每学生每项目一份，唯一键防重复创建）
-- project_version  学生存档的代码版本（每次保存自动生成新版本，多版本留存）

CREATE TABLE coding_project (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  class_id    BIGINT       NOT NULL COMMENT '所属班级',
  teacher_id  BIGINT       NOT NULL COMMENT '发布教师',
  title       VARCHAR(120) NOT NULL COMMENT '项目标题',
  description MEDIUMTEXT   NOT NULL COMMENT '项目需求说明（详细要求）',
  status      VARCHAR(16)  NOT NULL DEFAULT 'PUBLISHED' COMMENT 'PUBLISHED=已上架 OFFLINE=已下架',
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_cp_class (class_id),
  KEY idx_cp_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='教师发布的编程项目';

CREATE TABLE student_project (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  project_id  BIGINT      NOT NULL COMMENT '对应 coding_project.id',
  student_id  BIGINT      NOT NULL COMMENT '学生 user.id',
  status      VARCHAR(16) NOT NULL DEFAULT 'IN_PROGRESS' COMMENT 'IN_PROGRESS=开发中 SUBMITTED=已提交',
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_sp_project_student (project_id, student_id),
  KEY idx_sp_student (student_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='学生的项目实现（每学生每项目一份）';

CREATE TABLE project_version (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_project_id BIGINT      NOT NULL COMMENT '对应 student_project.id',
  version_no         INT         NOT NULL COMMENT '版本号（每次保存自动递增）',
  files              MEDIUMTEXT  NOT NULL COMMENT '代码文件 JSON：[{path,content}]',
  summary            VARCHAR(500)         DEFAULT NULL COMMENT '本版本说明',
  code_size          INT         NOT NULL DEFAULT 0 COMMENT '代码总字节数',
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_pv_sp_no (student_project_id, version_no),
  KEY idx_pv_sp (student_project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='学生项目代码版本（多版本自动留存）';
