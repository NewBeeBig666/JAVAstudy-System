/* 上传问题最小复现：教师登录 → multipart 上传 Word 模板（复现 500 抓响应） */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.BASE || 'http://localhost:8080') + '/api';

(async () => {
  // 1. 教师登录
  const lr = await fetch(BASE + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ username: 'teacher', password: '123456' })
  });
  const ld = await lr.json();
  if (ld.code !== 0) throw new Error('登录失败: ' + ld.msg);
  const token = ld.data.token;
  console.log('[1] 教师登录 OK');

  // 2. 上传模板（与前端 doLabUpload 完全一致的 FormData 结构）
  const buf = fs.readFileSync(path.join(__dirname, 'lab-template.docx'));
  const fd = new FormData();
  fd.append('title', '复现实验 实验报告模板');
  fd.append('file', new Blob([buf]), 'lab-template.docx');
  fd.append('kpCodes', 'java_basic');
  console.log('[2] 正在上传（file=' + buf.length + 'B）…');
  const t0 = Date.now();
  const res = await fetch(BASE + '/teacher/resources', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token },
    body: fd
  });
  const cost = ((Date.now() - t0) / 1000).toFixed(1);
  const text = await res.text();
  console.log('[3] HTTP ' + res.status + ' 耗时=' + cost + 's');
  console.log('    响应: ' + text.slice(0, 500));
  if (res.ok) {
    let data = null;
    try { data = JSON.parse(text); } catch (e) {}
    console.log('[4] 上传成功 id=' + (data && data.data && data.data.id));
  } else {
    console.log('[4] 复现失败 ✗ — 请查看后端日志「未处理异常」堆栈');
  }
})().catch(e => { console.error('REPRO ERROR: ' + e.message); process.exit(1); });
