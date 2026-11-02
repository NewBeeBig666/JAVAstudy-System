-- 班级共同管理教师（co-teacher）：班级所有者可添加其他教师共同管理指定班级，
-- 仅作用于该班级，不影响其他班级权限；(class_id, teacher_id) 唯一防重复添加
CREATE TABLE `class_co_teacher` (
  `id`         BIGINT AUTO_INCREMENT PRIMARY KEY,
  `class_id`   BIGINT      NOT NULL COMMENT '班级 id',
  `teacher_id` BIGINT      NOT NULL COMMENT '被授权的教师 id',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '添加时间',
  UNIQUE KEY `uk_class_teacher` (`class_id`, `teacher_id`),
  KEY `idx_co_teacher_teacher` (`teacher_id`)
) COMMENT '班级共同管理教师';
