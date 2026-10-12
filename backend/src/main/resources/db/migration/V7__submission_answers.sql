-- V7: 学生答题系统 —— submission 扩展结构化作答（题目型作业）
-- answers: JSON 数组 [{questionId, value}]（单选 key / 多选 [keys] / 判断 true|false / 文本内容）

ALTER TABLE `submission`
  ADD COLUMN answers JSON NULL COMMENT '题目型作业的结构化作答';
