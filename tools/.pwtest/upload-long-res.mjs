/* 上传新的长文本 word 资源（复用 id=7 的原文件），供滚动判定测试 */
import fs from 'node:fs';
import path from 'node:path';
const BASE = 'http://localhost:8080/api';

// 找 id=7 的磁盘文件（uploads/resource 下最新的 docx）
const dir = path.resolve('../../backend/uploads/resource');
const files = fs.readdirSync(dir)
  .filter(f => f.toLowerCase().endsWith('.docx'))
  .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t);
if (!files.length) throw new Error('uploads/resource 无 docx 文件');
const src = path.join(dir, files[0].f);
const buf = fs.readFileSync(src);
console.log('复用文件: ' + files[0].f + ' (' + buf.length + 'B)');

const login = async u => (await (await fetch(BASE + '/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: u, password: '123456' })
})).json()).data.token;

const tToken = await login('teacher');
const fd = new FormData();
fd.append('title', '滚动判定测试资源-' + Date.now());
fd.append('file', new Blob([buf]), 'scroll-test.docx');
fd.append('kpCodes', '');
const up = await fetch(BASE + '/teacher/resources', {
  method: 'POST', headers: { 'Authorization': 'Bearer ' + tToken }, body: fd
});
const j = await up.json();
if (j.code !== 0) throw new Error('上传失败: ' + j.msg);
console.log('新资源: id=' + j.data.id + ' title=' + j.data.title);

// 学生侧确认 text 可用
const sToken = await login('student');
const t = await (await fetch(BASE + '/resources/' + j.data.id + '/text', {
  headers: { 'Authorization': 'Bearer ' + sToken }
})).json();
console.log('text 提取: ' + ((t.data && t.data.text) || '').length + ' 字');
console.log('TEST_RESOURCE_ID=' + j.data.id);
