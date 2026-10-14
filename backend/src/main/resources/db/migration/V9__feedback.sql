-- V9: 学生建议反馈 —— 学生端提交 / 教师端查看 + AI 一键总结

CREATE TABLE `feedback` (
  id         BIGINT       NOT NULL AUTO_INCREMENT,
  user_id    BIGINT       NOT NULL COMMENT '提交学生 id',
  type       VARCHAR(20)  NOT NULL COMMENT 'BUG/SUGGESTION/FEATURE',
  content    TEXT         NOT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_feedback_user (user_id),
  KEY idx_feedback_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='学生建议反馈';
