-- V16: 作业文件夹绑定班级维度
-- 修复左侧栏文件夹跨班级显示问题：文件夹严格归属 (teacher_id, class_id)，
-- 选中班级下无文件夹时侧栏仅显示内置「其他」，不再加载其他班级的文件夹数据

ALTER TABLE `assignment_folder`
  ADD COLUMN `class_id` BIGINT NULL COMMENT '所属班级 id' AFTER `teacher_id`,
  ADD KEY `idx_af_teacher_class` (`teacher_id`, `class_id`);

-- 存量数据回填：优先取文件夹内首份作业的班级，其次所有者首个授课班级，最后全库首个班级
UPDATE `assignment_folder` f SET f.`class_id` = COALESCE(
  (SELECT a.`class_id` FROM `assignment` a WHERE a.`folder_id` = f.`id` ORDER BY a.`id` LIMIT 1),
  (SELECT MIN(c.`id`) FROM `class` c WHERE c.`teacher_id` = f.`teacher_id`),
  (SELECT MIN(c2.`id`) FROM `class` c2));
