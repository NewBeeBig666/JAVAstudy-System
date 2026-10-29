-- V14: 知识图谱教师端维护 —— 软删除标记（重置可恢复）+ 自定义节点（source=CUSTOM，重置时清除）

ALTER TABLE `knowledge_point` ADD COLUMN deleted TINYINT NOT NULL DEFAULT 0 COMMENT '教师端软删除 0/1（重置可恢复）';
