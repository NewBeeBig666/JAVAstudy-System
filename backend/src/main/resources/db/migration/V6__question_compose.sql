-- V6: 出题组卷系统 —— 题目表 + 作业扩展（评分机制 / 有效时段 / 允许补交）
-- 结束时间复用现有 due_at 列（学生端截止展示与提交流程零改动）

CREATE TABLE `question` (
  id            BIGINT        NOT NULL AUTO_INCREMENT,
  assignment_id BIGINT        NOT NULL,
  type          VARCHAR(20)   NOT NULL COMMENT 'SINGLE/MULTI/FILL/JUDGE/SHORT/CODE',
  title         TEXT          NOT NULL,
  options       JSON          NULL COMMENT '[{"key":"A","text":".."}]',
  answer        JSON          NULL COMMENT '单选["A"] 多选["A","B"] 判断[true] 其余为文本',
  analysis      TEXT          NULL COMMENT '答案解析',
  difficulty    DECIMAL(3,2)  NOT NULL DEFAULT 0.50 COMMENT '难度系数 0-1，越大越易',
  kp_code       VARCHAR(50)   NULL COMMENT '关联知识点编码',
  score         DECIMAL(5,1)  NULL COMMENT 'CUSTOM 模式每题分值',
  sort_order    INT           NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  KEY idx_assignment (assignment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='作业题目';

ALTER TABLE `assignment`
  ADD COLUMN score_mode VARCHAR(10) NULL COMMENT '评分机制 AVERAGE=百分制均分 / CUSTOM=自定义分值',
  ADD COLUMN start_at   DATETIME    NULL COMMENT '有效时段开始时间',
  ADD COLUMN allow_late TINYINT     NOT NULL DEFAULT 0 COMMENT '允许学生补交 0/1';
