-- V21: 版本总结反思——学生提交版本时可针对本版本代码编写总结与反思，随版本提交一同保存并绑定
ALTER TABLE `project_version`
  ADD COLUMN `reflection` TEXT NULL COMMENT '总结反思：学生针对该版本代码的总结与反思，随「保存并提交」写入并与版本绑定';
