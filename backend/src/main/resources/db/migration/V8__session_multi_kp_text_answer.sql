-- V8: 学习会话多知识点 + 会话内文本作答
-- session.kps: 多知识点会话的所选知识点编码（逗号分隔），单选时为 NULL
-- exercise_record.answer: 非选择题（编程/填空/简答等）的文本作答内容

ALTER TABLE `session`
  ADD COLUMN kps VARCHAR(255) NULL COMMENT '多选知识点的编码列表，逗号分隔';

ALTER TABLE `exercise_record`
  ADD COLUMN answer TEXT NULL COMMENT '非选择题型的文本作答';
