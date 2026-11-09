-- V18: 实验报告作业「分组实验」能力
-- 教师发布实验报告作业时可开启分组协作（随机分组 / 学生自行组队），
-- 分组数据实时同步：教师端可查看所有小组的组建状态与成员构成。

-- 小组（随机分组由系统在作业发布时生成；自行组队由首位发起邀请的学生创建并任组长）
CREATE TABLE `lab_group` (
  `id`               BIGINT       NOT NULL AUTO_INCREMENT,
  `assignment_id`    BIGINT       NOT NULL COMMENT '所属作业',
  `seq`              INT          NOT NULL COMMENT '作业内小组序号（名称=第N组）',
  `name`             VARCHAR(64)  NOT NULL COMMENT '小组名称（第N组）',
  `leader_student_id` BIGINT      NOT NULL COMMENT '组长学生 id',
  `created_at`       DATETIME     NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_lg_assign_seq` (`assignment_id`, `seq`),
  KEY `idx_lg_assignment` (`assignment_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='实验报告作业小组';

-- 组员（一名学生在同一作业内至多属于一个小组：唯一约束兜底并发入组冲突）
CREATE TABLE `lab_group_member` (
  `id`            BIGINT   NOT NULL AUTO_INCREMENT,
  `group_id`      BIGINT   NOT NULL COMMENT '所属小组',
  `assignment_id` BIGINT   NOT NULL COMMENT '所属作业（冗余存储，供唯一约束与直查）',
  `student_id`    BIGINT   NOT NULL COMMENT '学生 id',
  `created_at`    DATETIME NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_lgm_stu_assign` (`student_id`, `assignment_id`),
  KEY `idx_lgm_group` (`group_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='实验报告作业小组成员';

-- 组队邀请（自行组队模式）：PENDING 待响应 / ACCEPTED 已接受 / REJECTED 已拒绝 / EXPIRED 已失效（被邀请人已入其他队伍）
CREATE TABLE `lab_group_invite` (
  `id`              BIGINT      NOT NULL AUTO_INCREMENT,
  `assignment_id`   BIGINT      NOT NULL COMMENT '所属作业',
  `from_student_id` BIGINT      NOT NULL COMMENT '发起邀请的学生（队长）',
  `to_student_id`   BIGINT      NOT NULL COMMENT '被邀请学生',
  `status`           VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  `created_at`       DATETIME    NULL,
  `updated_at`       DATETIME    NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_lgi_pair` (`assignment_id`, `from_student_id`, `to_student_id`),
  KEY `idx_lgi_to` (`assignment_id`, `to_student_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='自行组队邀请';
