-- V23: 项目版本 AI 评分——教师端查看代码弹窗内对每个版本生成 AI 初评分/评语，教师可调整分数与修改评语，同步至学生端
ALTER TABLE `project_version`
  ADD COLUMN `ai_score` SMALLINT NULL COMMENT 'AI 初评分（0-100）：根据版本代码与项目/迭代路线需求自动生成',
  ADD COLUMN `ai_comment` TEXT NULL COMMENT 'AI 初评评语',
  ADD COLUMN `teacher_score` SMALLINT NULL COMMENT '教师调整后评分（0-100，覆盖 AI 初评展示，NULL=未调整）',
  ADD COLUMN `teacher_comment` TEXT NULL COMMENT '教师修改后评语（NULL=未修改）';
