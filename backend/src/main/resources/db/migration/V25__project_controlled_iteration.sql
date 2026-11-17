-- V25: 项目「控制版本迭代」能力
-- ① coding_project.controlled_iteration：教师端开关（0=自由开发，1=受控迭代），
--    开启后学生端移除统一创建入口，改为按迭代逐版本解锁开发；
-- ② student_project.current_iteration：学生当前所处迭代序号（1-based，NULL=尚未开始），
--    受控模式下学生提交版本成功后自动推进至下一迭代，完成前其余迭代锁定不可进入。

ALTER TABLE `coding_project`
  ADD COLUMN `controlled_iteration` TINYINT NOT NULL DEFAULT 0 COMMENT '控制版本迭代开关：0=自由开发 1=受控迭代（学生按迭代逐版本解锁）';

ALTER TABLE `student_project`
  ADD COLUMN `current_iteration` INT NULL COMMENT '当前所处迭代序号（1-based，NULL=尚未开始；受控模式提交后自动推进）';
