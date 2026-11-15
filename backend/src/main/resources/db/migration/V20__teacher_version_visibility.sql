-- V20: 教师端版本可见性管控——学生点击「保存并提交」前的版本不对教师开放
-- 语义：submitted_version_no 为「教师可见版本水位」，version_no <= 水位的版本对教师开放；NULL = 未开放任何版本
-- 学生仅点「保存新版本」：只写版本不动水位，新版本及水位之后的版本对教师不可见
-- 学生点「保存并提交」：水位原子更新为当前版本号，当前版本及全部历史版本即刻对教师开放

ALTER TABLE `student_project`
  ADD COLUMN `submitted_version_no` INT NULL COMMENT '教师可见版本水位：version_no<=该值的版本对教师开放；NULL=未开放任何版本';

-- 存量已提交项目回填水位=当前最新版本（保持既有已提交数据对教师持续可见，行为平滑过渡）；
-- 存量开发中项目不回填（保持 NULL）：按新规则待学生下次「保存并提交」后才开放
UPDATE `student_project` sp
  SET `submitted_version_no` = (SELECT MAX(pv.`version_no`) FROM `project_version` pv WHERE pv.`student_project_id` = sp.`id`)
  WHERE sp.`status` = 'SUBMITTED';
