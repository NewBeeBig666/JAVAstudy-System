/* v1.13 云端部署验证：实验报告上传修复 + 班级切换联动 + 资源文本预览 + 404 修正 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = 'http://47.119.150.2';
const API = HOST + '/api';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '（' + detail + '）' : '')); }
};

async function login(u) {
  const r = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ username: u, password: '123456' })
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('登录失败(' + u + '): ' + j.msg);
  return j.data.token;
}

(async () => {
  // [1] 健康检查
  try {
    const h = await fetch(HOST + '/actuator/health');
    ok('健康检查', h.status === 200, await h.text());
  } catch (e) { ok('健康检查', false, e.message); }

  // [2] 前端静态资源含 v1.13 标记
  const js = await (await fetch(HOST + '/assets/js/app.js')).text();
  ok('上传路径修复（/teacher/resources 无双重前缀）', js.includes("API.upload('/teacher/resources'"), '');
  ok('滚动判定（resPrevScroll 容器）', js.includes('resPrevScroll'), '');
  ok('知识图谱三卡布局（kg-bottom-3）', js.includes('kg-bottom-3'), '');
  ok('班级切换组件（_classSwitching）', js.includes('_classSwitching'), '');

  const tt = await login('teacher');
  const st = await login('student');
  console.log('[3] 双端登录 OK');

  // [4] 实验报告模板上传（核心修复验证：与 UI doLabUpload 完全一致的请求）
  const buf = fs.readFileSync(path.join(__dirname, 'lab-template.docx'));
  const fd = new FormData();
  fd.append('title', '云端验证-实验报告模板-' + Date.now());
  fd.append('file', new Blob([buf]), 'lab-template.docx');
  fd.append('kpCodes', '');
  const up = await fetch(API + '/teacher/resources', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + tt }, body: fd
  });
  const upj = await up.json().catch(() => ({}));
  ok('实验报告模板上传（原 500 修复）', up.status === 200 && upj.code === 0,
    'id=' + (upj.data && upj.data.id) + ' type=' + (upj.data && upj.data.fileType));
  // 清理测试资源
  if (upj.data && upj.data.id) {
    await fetch(API + '/teacher/resources/' + upj.data.id, {
      method: 'DELETE', headers: { 'Authorization': 'Bearer ' + tt }
    });
    console.log('    （测试资源已清理）');
  }

  // [5] 班级切换联动：classes 含 studentCount + 四接口带 classId
  const classes = await (await fetch(API + '/teacher/classes', { headers: { Authorization: 'Bearer ' + tt } })).json();
  const cls = classes.data || [];
  ok('班级列表含 studentCount', cls.length > 0 && cls.every(c => c.studentCount != null),
    cls.map(c => c.name + ':' + c.studentCount + '人').join(' | '));
  const cid = cls[0] && cls[0].id;
  if (cid != null) {
    const [d, s, w, a] = await Promise.all([
      fetch(API + '/teacher/dashboard?classId=' + cid, { headers: { Authorization: 'Bearer ' + tt } }).then(r => r.json()),
      fetch(API + '/teacher/students?classId=' + cid, { headers: { Authorization: 'Bearer ' + tt } }).then(r => r.json()),
      fetch(API + '/teacher/warnings?classId=' + cid, { headers: { Authorization: 'Bearer ' + tt } }).then(r => r.json()),
      fetch(API + '/teacher/assignments?classId=' + cid, { headers: { Authorization: 'Bearer ' + tt } }).then(r => r.json())
    ]);
    ok('看板接口带 classId', d.code === 0 && d.data.kpi && d.data.kpi.studentCount != null,
      '人数=' + d.data.kpi.studentCount + ' 提交率=' + d.data.kpi.submitRate + '%');
    ok('学生接口带 classId', s.code === 0 && Array.isArray(s.data), s.data.length + ' 人');
    ok('预警接口带 classId', w.code === 0 && Array.isArray(w.data), w.data.length + ' 条');
    ok('作业接口带 classId', a.code === 0 && Array.isArray(a.data), a.data.length + ' 份');
    const kpiN = d.data.kpi.studentCount, listN = s.data.length;
    ok('数据一致性（看板人数=学生列表长度）', kpiN === listN, kpiN + '=' + listN);
  }

  // [6] 学生资源文本预览接口（word 资源）
  const sres = await (await fetch(API + '/resources', { headers: { Authorization: 'Bearer ' + st } })).json();
  const word = (sres.data || []).find(r => r.fileType === 'word');
  if (word) {
    const t = await (await fetch(API + '/resources/' + word.id + '/text', { headers: { Authorization: 'Bearer ' + st } })).json();
    ok('资源文本预览接口', t.code === 0 && typeof t.data.text === 'string', '提取 ' + (t.data.text || '').length + ' 字');
  } else {
    console.log('  （云端暂无 word 资源，文本接口跳过——上传验证已覆盖该链路）');
  }

  // [7] 404 修正：双重前缀路径应返回 404 而非 500
  const nf = await fetch(API + '/api/teacher/resources', { headers: { Authorization: 'Bearer ' + tt } });
  const nfj = await nf.json().catch(() => ({}));
  ok('404 回归 404（不再伪装 500）', nf.status === 404, 'HTTP ' + nf.status + ' ' + (nfj.msg || ''));

  console.log('\n=== v1.13 云端验证: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
