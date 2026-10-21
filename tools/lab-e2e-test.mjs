/* 实验报告作业功能端到端测试（无头 API 测试）
 * 链路：教师上传模板 → 发布 LAB 作业 → 学生见 lab 字段 → 学生下载模板
 *      → 学生上传报告 → 教师 AI 初评（真实 DeepSeek）→ 教师下载学生报告
 * 用法: node tools/lab-e2e-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:8080/api';

async function api(method, p, { token, body, formData, raw } = {}) {
  const opt = { method, headers: {} };
  if (token) opt.headers['Authorization'] = 'Bearer ' + token;
  if (formData) opt.body = formData;
  else if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json;charset=utf-8';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, opt);
  if (raw) return res;
  let data = null;
  try { data = await res.json(); } catch (e) { /* 非 JSON */ }
  if (!res.ok || !data || data.code !== 0) {
    throw new Error((data && data.msg) || ('HTTP ' + res.status + ' ' + p));
  }
  return data.data;
}

async function login(username, password) {
  const r = await api('POST', '/auth/login', { body: { username, password } });
  return r.token;
}

function fmt(dt) { // 2026-10-21T20:30 → '2026-10-21 20:30'
  return dt.replace('T', ' ');
}

(async () => {
  const tToken = await login('teacher', '123456');
  console.log('[1] 教师登录 OK');

  // ---- 教师上传 Word 模板（复用资源接口，自动入学习资源板块）----
  const tplBuf = fs.readFileSync(path.join(__dirname, 'lab-template.docx'));
  const fd1 = new FormData();
  fd1.append('title', 'E2E实验 实验报告模板');
  fd1.append('file', new Blob([tplBuf]), 'lab-template.docx');
  fd1.append('kpCodes', '');
  const tpl = await api('POST', '/teacher/resources', { token: tToken, formData: fd1 });
  console.log('[2] 模板上传 OK: id=' + tpl.id + ' title=' + tpl.title + ' fileType=' + tpl.fileType);
  if (!tpl.id) throw new Error('模板资源 ID 缺失');

  // ---- 发布 LAB 作业 ----
  const start = new Date(Date.now() - 3600e3);
  const end = new Date(Date.now() + 7 * 24 * 3600e3);
  const pad = n => String(n).padStart(2, '0');
  const f = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const asg = await api('POST', '/teacher/compose', {
    token: tToken,
    body: {
      title: 'E2E实验报告作业-' + Date.now(),
      scoreMode: 'LAB',
      status: 'ONGOING',
      startAt: f(start), endAt: f(end),
      allowLate: true,
      labTemplateId: Number(tpl.id),
      labTemplateTitle: tpl.title,
      kps: [], questions: []
    }
  });
  console.log('[3] LAB 作业发布 OK: id=' + (asg.id || asg.assignmentId));
  const asgId = asg.id || asg.assignmentId;

  // ---- 教师作业列表确认 lab 字段 ----
  const tList = await api('GET', '/teacher/assignments', { token: tToken });
  const tA = tList.find(x => String(x.id) === String(asgId));
  if (!tA) throw new Error('教师作业列表未找到新作业');
  if (!tA.lab || String(tA.lab.templateId) !== String(tpl.id)) {
    throw new Error('教师作业 DTO 缺 lab 字段或 templateId 不符: ' + JSON.stringify(tA.lab));
  }
  if (tA.questionCount !== 0) throw new Error('LAB 作业 questionCount 应为 0，实际 ' + tA.questionCount);
  console.log('[4] 教师 DTO.lab OK: templateId=' + tA.lab.templateId + ' templateTitle=' + tA.lab.templateTitle);

  // ---- 学生视角 ----
  const sToken = await login('student', '123456');
  const myList = await api('GET', '/assignments/my', { token: sToken });
  const my = myList.find(x => String(x.id) === String(asgId));
  if (!my) throw new Error('学生作业列表未找到 LAB 作业（班级不匹配？）');
  if (!my.lab) throw new Error('学生作业 DTO 缺 lab 字段');
  if (my.mySubmission) throw new Error('未提交时不应有 mySubmission');
  console.log('[5] 学生可见 LAB 作业 OK，无 autoScore 误报: ' + (my.mySubmission && my.mySubmission.autoScore));

  // ---- 学生下载模板 ----
  const dl = await api('GET', '/resources/' + tpl.id + '/file', { token: sToken, raw: true });
  if (!dl.ok) throw new Error('模板下载失败 HTTP ' + dl.status);
  const dlBlob = await dl.arrayBuffer();
  if (dlBlob.byteLength < 1000) throw new Error('模板下载内容异常');
  console.log('[6] 学生下载模板 OK: ' + dlBlob.byteLength + 'B, disposition=' + (dl.headers.get('content-disposition') || '').slice(0, 60));

  // ---- 学生上传报告 ----
  const repBuf = fs.readFileSync(path.join(__dirname, 'lab-report.docx'));
  const fd2 = new FormData();
  fd2.append('file', new Blob([repBuf]), '张三-实验报告.docx');
  const sub = await api('POST', '/assignments/' + asgId + '/report', { token: sToken, formData: fd2 });
  console.log('[7] 学生上传报告 OK: submissionId=' + (sub.id || sub.submissionId || JSON.stringify(sub).slice(0, 80)));
  const subId = sub.id || sub.submissionId;

  // ---- 学生重复上传（重新提交覆盖）----
  const fd3 = new FormData();
  fd3.append('file', new Blob([repBuf]), '张三-实验报告-改.docx');
  const sub2 = await api('POST', '/assignments/' + asgId + '/report', { token: sToken, formData: fd3 });
  if (String(sub2.id || sub2.submissionId) !== String(subId)) {
    console.log('    注意：重复上传返回不同 submission id（' + (sub2.id || sub2.submissionId) + '）');
  }
  console.log('[8] 学生重新上传 OK');

  // ---- 教师提交列表 ----
  const subs = await api('GET', '/teacher/assignments/' + asgId + '/submissions', { token: tToken });
  const mine = subs.find(s => String(s.asId) === String(asgId) && s.aiScore !== undefined);
  const target = subs.find(s => s.status === 'pending');
  if (!target) throw new Error('提交列表无 pending 记录');
  const tSubId = target.id;
  const repInfo = (target.answers || []).find(x => x && x.reportFile);
  if (!repInfo) throw new Error('教师提交 DTO answers 无 reportFile: ' + JSON.stringify(target.answers));
  console.log('[9] 教师提交列表 OK: subId=' + tSubId + ' reportFile=' + repInfo.reportFile + ' fileName=' + repInfo.fileName);

  // ---- 教师下载学生报告 ----
  const rf = await api('GET', '/teacher/submissions/' + tSubId + '/report-file', { token: tToken, raw: true });
  if (!rf.ok) throw new Error('教师下载报告失败 HTTP ' + rf.status);
  const rfBuf = await rf.arrayBuffer();
  if (rfBuf.byteLength < 1000) throw new Error('报告下载内容异常');
  console.log('[10] 教师下载学生报告 OK: ' + rfBuf.byteLength + 'B');

  // ---- AI 初评（真实 DeepSeek，读模板要求评审学生报告）----
  console.log('[11] AI 初评执行中（真实 DeepSeek，可能需 30-90 秒）…');
  const t0 = Date.now();
  const grade = await api('POST', '/teacher/submissions/' + tSubId + '/ai-grade', { token: tToken });
  const cost = ((Date.now() - t0) / 1000).toFixed(1);
  if (grade.aiScore == null) throw new Error('AI 初评无分数');
  console.log('[12] AI 初评 OK: aiScore=' + grade.aiScore + ' 耗时=' + cost + 's');
  console.log('     评语: ' + (grade.aiComment || '').slice(0, 120));

  console.log('\n=== E2E 全链路通过 ===');
  console.log('assignmentId=' + asgId + ' submissionId=' + tSubId + ' templateResourceId=' + tpl.id);
})().catch(e => {
  console.error('\n=== E2E FAILED ===');
  console.error(e.message);
  process.exit(1);
});
