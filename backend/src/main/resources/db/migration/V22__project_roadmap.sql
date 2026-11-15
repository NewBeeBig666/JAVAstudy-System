-- V22: 项目迭代路线——教师发布/编辑项目时可选配置分阶段迭代路线（≤10项），学生端时间线展示
ALTER TABLE `coding_project`
  ADD COLUMN `roadmap` JSON NULL COMMENT '项目迭代路线：[{title,desc}]，最多10项，选填；描述该版本任务、验收标准与时间节点';
