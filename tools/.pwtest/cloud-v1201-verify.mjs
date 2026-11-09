/* 云端 v1.20.1「上传成果物」部署验证
 * 只读项：前端代码标记（含 v1.20 分组/v1.19 预览不回退）+ v1.18 安全复检
 * 写入项（全部清场）：上传测试模板 → 开启/未开启成果物作业发布 →
 *   学生端必填/格式/双文件提交/重传覆盖 → 教师下载成果物 → 删除测试作业与模板
 * 说明：201MB 超限公网传输耗时过长，超限路径已在本地 E2E 验证（同一 jar 部署），云端不重复实测
 */
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, statSync, unlinkSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures') + path.sep;
const TMP = os.tmpdir() + path.sep;
const BASE = 'http://47.119.150.2';
const API = BASE + '/api';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else { fail++; console.log('  ✗ ' + name + '（' + (detail || '') + '）'); }
};
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { code: -999, msg: t.slice(0, 100) }; } };

(async () => {
  /* 1) 前端发布核验 */
  const js = await (await fetch(BASE + '/assets/js/app.js')).text();
  const m201 = ['toggleDeliverable', 'labPickDeliverable', 'labDeliverableInput', 'deliverable-file', '允许学生上传成果物', '上传报告与成果物'];
  ok('[前端] v1.20.1 成果物代码已发布', m201.every(m => js.includes(m)),
    m201.map(m => (js.includes(m) ? '+' : '-') + m).join(' '));
  const mBack = ['composeGroupCfgHtml', 'labGroupsBodyHtml', 'resDocHtml'];
  ok('[前端] v1.20 分组 / v1.19 预览代码未回退', mBack.every(m => js.includes(m)), '');

  /* 2) 登录 */
  const login = async (u) => j(await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ username: u, password: '123456' })
  }));
  const lg = await login('teacher');
  ok('[基础] 教师登录', lg.code === 0, '');
  const tt = lg.data.token;
  const H = { Authorization: 'Bearer ' + tt, 'Content-Type': 'application/json;charset=utf-8' };
  const st = await login('student');
  ok('[基础] 学生登录', st.code === 0, '');

  const stamp = Date.now().toString(36);
  const TPL = 'E2E-CLD-DEL-TPL-' + stamp;
  const fmt = (ts) => {
    const d = new Date(ts), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };
  const startAt = fmt(Date.now()), endAt = fmt(Date.now() + 7 * 864e5);
  const created = [];
  const compose = async (body) => j(await fetch(API + '/teacher/compose', { method: 'POST', headers: H, body: JSON.stringify(body) }));
  const uploadReport = async (asId, deliverablePath) => {
    const fd = new FormData();
    fd.append('file', new Blob([readFileSync(FIX + 'test-doc.docx')],
      { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'test-doc.docx');
    if (deliverablePath !== undefined) {
      fd.append('deliverable', new Blob([readFileSync(deliverablePath)]), path.basename(deliverablePath));
    }
    return j(await fetch(API + '/assignments/' + asId + '/report', {
      method: 'POST', headers: { Authorization: 'Bearer ' + st.data.token }, body: fd
    }));
  };

  // 测试素材：真 zip + 伪 txt 压缩包
  const zipPath = TMP + 'e2e-cld-deliverable.zip';
  execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${FIX}cp.txt' -DestinationPath '${zipPath}' -Force"`);
  const txtPath = TMP + 'e2e-cld-deliverable.txt';
  writeFileSync(txtPath, 'not-an-archive');
  ok('测试素材就绪', existsSync(zipPath) && statSync(zipPath).size > 100, statSync(zipPath).size + 'B');

  /* 3) 模板上传 + 作业发布 */
  const fd0 = new FormData();
  fd0.append('title', TPL);
  fd0.append('file', new Blob([readFileSync(FIX + 'test-doc.docx')],
    { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'test-doc.docx');
  const up = await j(await fetch(API + '/teacher/resources', { method: 'POST', headers: { Authorization: 'Bearer ' + tt }, body: fd0 }));
  ok('[发布] Word 测试模板上传', up.code === 0 && !!up.data.id, 'id=' + (up.data && up.data.id));
  const tplId = up.data.id;

  const c1 = await compose({
    title: 'E2E-CLD-DEL-ON-' + stamp, scoreMode: 'LAB', status: 'ONGOING',
    startAt, endAt, labTemplateId: tplId, labTemplateTitle: TPL,
    deliverableEnabled: true, kps: [], questions: []
  });
  ok('[发布] 开启成果物作业 + 配置回读', c1.code === 0 && c1.data.lab && c1.data.lab.deliverable
    && c1.data.lab.deliverable.enabled === true, JSON.stringify(c1.data && c1.data.lab && c1.data.lab.deliverable));
  const asOn = c1.data.id;
  created.push(asOn);
  const c2 = await compose({
    title: 'E2E-CLD-DEL-OFF-' + stamp, scoreMode: 'LAB', status: 'ONGOING',
    startAt, endAt, labTemplateId: tplId, labTemplateTitle: TPL,
    kps: [], questions: []
  });
  created.push(c2.data.id);
  ok('[发布] 未开启作业无 deliverable 配置', c2.code === 0 && !(c2.data.lab && c2.data.lab.deliverable), '');

  /* 4) 学生端校验与提交全链路 */
  const r1 = await uploadReport(asOn, undefined);
  ok('[必填] 缺成果物被拒（缺一不可）', r1.code !== 0 && /成果物压缩包/.test(r1.msg) && /缺一不可/.test(r1.msg), r1.msg);
  const r2 = await uploadReport(asOn, txtPath);
  ok('[格式] 非压缩包格式被拒', r2.code !== 0 && /zip \/ rar/.test(r2.msg), r2.msg);
  const r3 = await uploadReport(asOn, zipPath);
  ok('[提交] 双文件提交成功', r3.code === 0 && r3.data.deliverableName === 'e2e-cld-deliverable.zip',
    'deliverable=' + (r3.data && r3.data.deliverableName));
  const subId = r3.data.submissionId;

  // 教师下载成果物
  const dres = await fetch(API + '/teacher/submissions/' + subId + '/deliverable-file', { headers: { Authorization: 'Bearer ' + tt } });
  ok('[教师] 下载成果物接口可用', dres.status === 200
    && Number(dres.headers.get('content-length')) === statSync(zipPath).size,
    'HTTP ' + dres.status + ' ' + dres.headers.get('content-length') + 'B');
  const rres = await fetch(API + '/teacher/submissions/' + subId + '/report-file', { headers: { Authorization: 'Bearer ' + tt } });
  ok('[兼容] 报告下载不受影响', rres.status === 200, 'HTTP ' + rres.status);

  // 未开启作业仅报告可提交（兼容）
  const r4 = await uploadReport(c2.data.id, undefined);
  ok('[兼容] 未开启作业仅传报告成功', r4.code === 0, r4.msg || '');
  const dres2 = await fetch(API + '/teacher/submissions/' + r4.data.submissionId + '/deliverable-file', { headers: { Authorization: 'Bearer ' + tt } });
  const dres2j = await j(dres2);
  ok('[教师] 无成果物提交下载被拒（明确提示）', dres2.status === 400 && /没有成果物/.test(dres2j.msg || ''), dres2j.msg);

  // 教师关闭开关 → 学生重新仅传报告成功（配置变更实时生效）
  const c3 = await compose({
    id: Number(asOn), title: 'E2E-CLD-DEL-ON-' + stamp, scoreMode: 'LAB', status: 'ONGOING',
    startAt, endAt, labTemplateId: tplId, labTemplateTitle: TPL,
    deliverableEnabled: false, kps: [], questions: []
  });
  ok('[切换] 教师关闭成果物开关', c3.code === 0 && !(c3.data.lab && c3.data.lab.deliverable), '');
  const r5 = await uploadReport(asOn, undefined);
  ok('[切换] 关闭后仅传报告成功（配置实时生效）', r5.code === 0, r5.msg || '');

  /* 5) v1.18 安全复检 */
  {
    const r = await fetch(BASE + '/v3/api-docs', { redirect: 'manual' });
    ok('[安全复检] Swagger 仍关闭（404）', r.status === 404, 'HTTP ' + r.status);
    const crypto = await import('node:crypto');
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const hdr = b64({ alg: 'HS256' });
    const pld = b64({ sub: '1', role: 'TEACHER', iat: now, exp: now + 3600 });
    const sig = crypto.createHmac('sha256', 'la-dev-secret-key-must-be-at-least-32-bytes!!').update(hdr + '.' + pld).digest('base64url');
    const fr = await fetch(API + '/teacher/classes', { headers: { Authorization: 'Bearer ' + hdr + '.' + pld + '.' + sig } });
    ok('[安全复检] 旧默认密钥伪造 Token 仍被拒（401）', fr.status === 401, 'HTTP ' + fr.status);
    const page = await fetch(BASE + '/login.html');
    ok('[安全复检] 登录页正常', page.status === 200, 'HTTP ' + page.status);
  }

  /* 6) 清场 */
  let delOk = true, delDetail = [];
  for (const id of created) {
    const dr = await fetch(API + '/teacher/assignments/' + id, { method: 'DELETE', headers: H });
    if (dr.status !== 200) { delOk = false; delDetail.push(id + ':' + dr.status); }
  }
  ok('[清场] 测试作业全部删除', delOk, delDetail.join(','));
  const dr2 = await fetch(API + '/teacher/resources/' + tplId, { method: 'DELETE', headers: { Authorization: 'Bearer ' + tt } });
  ok('[清场] 测试模板资源已删除', dr2.status === 200, 'HTTP ' + dr2.status);
  unlinkSync(zipPath); unlinkSync(txtPath);

  console.log('\n=== 云端 v1.20.1 成果物功能验证: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
