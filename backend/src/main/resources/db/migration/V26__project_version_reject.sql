-- V26: 版本打回（教师端受控项目）
-- project_version.rejected：打回标记 0/1（重新提交后复位）
-- project_version.reject_reason：打回理由（≤500 字，打回时教师填写）
ALTER TABLE project_version
    ADD COLUMN rejected TINYINT NOT NULL DEFAULT 0 COMMENT '教师打回标记 0/1，重新提交复位',
    ADD COLUMN reject_reason VARCHAR(500) NULL COMMENT '打回理由（教师填写）';
