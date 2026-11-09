-- V17: 学习资源「原文件即时预览」重构
-- 上传时一次性提取结构化原文内容存库（Word 文档段落 / PPT 幻灯片页卡，JSON），
-- 预览改为读库即时渲染（零等待、不保排版的纯文本提取模式废弃）；
-- PDF 走浏览器原生 iframe 直显原文件，无需提取；图片/视频保持原生渲染。

ALTER TABLE `learning_resource`
  ADD COLUMN `extracted_text` MEDIUMTEXT NULL COMMENT '结构化原文内容 JSON（doc:{items:[{t,x}]} / slides:{items:[{title,lines}]}；pdf/image/video 为空走原生渲染）' AFTER `ai_summary`;
