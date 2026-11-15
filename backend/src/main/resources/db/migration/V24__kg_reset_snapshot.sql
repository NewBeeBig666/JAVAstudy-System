-- V24: 知识图谱初始默认状态快照表（教师端「重置」的完全还原基准）
-- 背景：重置原先仅"恢复软删除 + 物理清除自定义节点"，无法撤销教师的
-- 移动（parent_id/level/module_code/sort_order 变更）与属性编辑
-- （name/description 变更）。为满足"重置后所有层级模块与初始默认状态
-- 完全一致"，固化一份课程体系节点（source=XLSX）的初始结构快照，
-- reset 时按快照逐字段还原。
-- 幂等：快照仅在表为空时固化一次，之后教师的一切编辑均不再影响快照；
-- 若课程体系重新导入（V10 变更），需清空本表后重启应用重新固化。

CREATE TABLE IF NOT EXISTS `knowledge_point_initial` (
  `id` BIGINT NOT NULL PRIMARY KEY,
  `kp_code` VARCHAR(64) NOT NULL,
  `parent_id` BIGINT NULL,
  `level` INT NOT NULL,
  `module_code` VARCHAR(64) NULL,
  `sort_order` INT NULL,
  `name` VARCHAR(100) NOT NULL,
  `description` TEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `knowledge_point_initial` (`id`,`kp_code`,`parent_id`,`level`,`module_code`,`sort_order`,`name`,`description`)
SELECT k.`id`, k.`kp_code`, k.`parent_id`, k.`level`, k.`module_code`, k.`sort_order`, k.`name`, k.`description`
FROM `knowledge_point` k
WHERE k.`source` = 'XLSX'
  AND NOT EXISTS (SELECT 1 FROM `knowledge_point_initial`);
