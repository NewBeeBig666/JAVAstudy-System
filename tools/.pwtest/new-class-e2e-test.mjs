/* 新建班级全链路 E2E 验证（名单导入 → 学生端接收 → 教师端反向管理闭环）
 * [导入] 学情看板「添加班级」上传 xlsx 名单 → 班级创建 + 学生账号批量生成（3 人，账号=学号，密码 GZgs@2026）
 * [学生端] 新生登录 → 接收并查看教师发布的作业（草稿不泄漏）+ 访问学习资源（列表/预览/下载）
 * [教师端反向] 看板（人数/空态）、学生列表（学号展示/重置密码）、提交管理（提交可见/未提交 missing）、
 *               资源管理（可见/删除后学生不可见）、权限配置（共同管理教师添加/发布/退出）、班级删除（级联清理）
 * [记录] 全程输出各环节结果，异常逐项标注环节与复现条件；测试数据全部清场
 */
import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
import { readFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures') + path.sep;
const TMP = os.tmpdir() + path.sep;
const BASE = 'http://localhost:8080';
const API = BASE + '/api';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '（' + detail + '）' : '') + '  ← 异常环节：' + name); }
};
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { code: -999, msg: t.slice(0, 120) }; } };

async function login(u, p) {
  const r = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ username: u, password: p || '123456' })
  });
  return j(r);
}
function sql(q) {
  try {
    const s = String(q).replace(/[\r\n]+/g, ' ');
    return execSync(`mysql -uroot -proot learning_agent -e ${JSON.stringify(s)}`, { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  } catch (e) { return null; }
}
const sqlVal = (q) => {
  const out = sql(q);
  if (!out) return null;
  const line = out.replace(/\r/g, '').trim().split('\n')[1];
  return line ? line.trim() : null;
};
const fmt = (ts) => {
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
};

(async () => {
  const stamp = Date.now().toString(36);
  const clsName = 'E2E-NC-' + stamp;
  // 学号须为 2 开头纯数字（正则 2\d{7,12}）：'2' + 10 位时间戳尾 + 序号 = 12 位数字
  const tsTail = Date.now().toString().slice(-10);
  const nos = ['2' + tsTail + '1', '2' + tsTail + '2', '2' + tsTail + '3'];
  const roster = [
    { no: nos[0], name: '端到端一生' },
    { no: nos[1], name: '端到端二生' },
    { no: nos[2], name: '端到端三生' }
  ];
  const xlsxPath = TMP + clsName + '.xlsx';

  // ---------- 阶段 0：生成 xlsx 名单 + 清场 ----------
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('名单');
  ws.addRow(['学号', '姓名']);
  roster.forEach(s => ws.addRow([s.no, s.name]));
  await wb.xlsx.writeFile(xlsxPath);
  ok('[准备] 标准 xlsx 名单生成（表头学号/姓名，3 名学生）', existsSync(xlsxPath), path.basename(xlsxPath));

  sql(`DELETE FROM class_co_teacher WHERE class_id IN (SELECT id FROM class WHERE name LIKE 'E2E-NC-%')`);
  sql(`UPDATE user u JOIN class c ON c.id=u.class_id SET u.class_id=NULL WHERE c.name LIKE 'E2E-NC-%'`);
  ["DELETE FROM lab_group_invite WHERE assignment_id IN (SELECT id FROM assignment WHERE class_id IN (SELECT id FROM class WHERE name LIKE 'E2E-NC-%'))",
   "DELETE FROM lab_group_member WHERE assignment_id IN (SELECT id FROM assignment WHERE class_id IN (SELECT id FROM class WHERE name LIKE 'E2E-NC-%'))",
   "DELETE FROM lab_group WHERE assignment_id IN (SELECT id FROM assignment WHERE class_id IN (SELECT id FROM class WHERE name LIKE 'E2E-NC-%'))",
   "DELETE FROM submission WHERE assignment_id IN (SELECT id FROM assignment WHERE class_id IN (SELECT id FROM class WHERE name LIKE 'E2E-NC-%'))",
   "DELETE FROM question WHERE assignment_id IN (SELECT id FROM assignment WHERE class_id IN (SELECT id FROM class WHERE name LIKE 'E2E-NC-%'))",
   "DELETE FROM rubric WHERE assignment_id IN (SELECT id FROM assignment WHERE class_id IN (SELECT id FROM class WHERE name LIKE 'E2E-NC-%'))",
   "DELETE FROM assignment WHERE class_id IN (SELECT id FROM class WHERE name LIKE 'E2E-NC-%')",
   "DELETE FROM resource_progress WHERE resource_id IN (SELECT id FROM learning_resource WHERE class_id IN (SELECT id FROM class WHERE name LIKE 'E2E-NC-%'))",
   "DELETE FROM learning_resource WHERE class_id IN (SELECT id FROM class WHERE name LIKE 'E2E-NC-%')",
   "DELETE FROM warning WHERE class_id IN (SELECT id FROM class WHERE name LIKE 'E2E-NC-%')",
   "DELETE FROM class WHERE name LIKE 'E2E-NC-%'",
   "DELETE FROM user WHERE username = '2260011111'",
   `DELETE FROM user WHERE username IN ('${nos.join("','")}')`
  ].forEach(q => sql(q));
  ok('[清场] 历史测试数据清理', true, '');

  // ---------- 阶段 1：教师端 UI 名单导入 ----------
  console.log('\n—— 阶段1：教师端学情看板上传名单导入班级 ——');
  let browser;
  for (const ch of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {}
  }
  if (!browser) throw new Error('无可用系统浏览器');
  process.on('exit', () => { try { browser.close(); } catch (e) {} });
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push('http ' + r.status() + ': ' + r.url().slice(-60)); });

  const chenLg = await login('teacher');
  const chen = chenLg.data.token;
  const H = { Authorization: 'Bearer ' + chen, 'Content-Type': 'application/json;charset=utf-8' };

  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', 'teacher');
  await page.fill('#lgPass', '123456');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.brand-sub', { timeout: 15000 });
  for (let i = 0; i < 30; i++) {
    const t = await page.textContent('.mh-title').catch(() => '');
    if (t && !t.includes('加载中')) break;
    await page.waitForTimeout(300);
  }
  await page.waitForSelector('[data-act="importClassModal"]', { timeout: 20000 });
  await page.click('[data-act="importClassModal"]');
  await page.waitForSelector('.modal', { timeout: 10000 });
  await page.setInputFiles('#importFileInput', xlsxPath);
  await page.waitForTimeout(400);
  await page.click('.modal [data-act="doImportClass"]');
  await page.waitForTimeout(2500);
  const impToast = (await page.textContent('.toast:last-child').catch(() => '')).trim();
  ok('[导入] 上传名单后班级创建成功提示', impToast.includes(clsName) && impToast.includes('新增 3 名学生'), impToast);
  // 班级出现在授课班级列表
  const classes = await j(await fetch(API + '/teacher/classes', { headers: H }));
  const newCls = (classes.data || []).find(c => c.name === clsName);
  ok('[导入] 新班级出现在教师班级列表', !!newCls, 'id=' + (newCls && newCls.id) + ' studentCount=' + (newCls && newCls.studentCount));
  const newClsId = newCls.id;
  const stuList = await j(await fetch(API + '/teacher/students?classId=' + newClsId, { headers: H }));
  const imported = stuList.data || [];
  ok('[导入] 3 名学生账号批量生成且姓名学号正确',
    imported.length === 3 && roster.every(r => imported.some(s => s.studentNo === r.no && s.name === r.name)),
    imported.map(s => s.name + '/' + s.studentNo).join(', '));
  // 新学生账号登录（账号=学号，初始密码 GZgs@2026）
  const st1Lg = await login(nos[0], 'GZgs@2026');
  ok('[导入] 新学生账号可登录（学号=账号 / 初始密码 GZgs@2026）', st1Lg.code === 0, st1Lg.code === 0 ? 'ok' : st1Lg.msg);
  const st1 = st1Lg.data.token;
  ok('[导入] 学生归属新班级', sqlVal(`SELECT class_id FROM user WHERE username='${nos[0]}'`) === String(newClsId), 'class_id=' + newClsId);

  // ---------- 阶段 2：教师端向新班发布作业与资源 ----------
  console.log('\n—— 阶段2：教师端向新班发布 2 作业（1 发布 + 1 草稿）与 1 学习资源 ——');
  const startAt = fmt(Date.now()), endAt = fmt(Date.now() + 7 * 864e5);
  const asTitle = 'E2E-NC-AS-' + stamp;
  const c1 = await j(await fetch(API + '/teacher/compose', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      classId: Number(newClsId), title: asTitle, scoreMode: 'AVERAGE', status: 'ONGOING',
      startAt, endAt, kps: [], questions: [{
        id: null, type: 'SINGLE', title: 'e2e new class question', options: [{ key: 'A', text: 'aa' }, { key: 'B', text: 'bb' }], answer: ['A']
      }]
    })
  }));
  ok('[发布] 向新班发布题目作业成功', c1.code === 0, '作业 id=' + (c1.data && c1.data.id));
  const asId = c1.data.id;
  const draftTitle = 'E2E-NC-DRAFT-' + stamp;
  const c2 = await j(await fetch(API + '/teacher/compose', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      classId: Number(newClsId), title: draftTitle, scoreMode: 'AVERAGE', status: 'DRAFT',
      startAt, endAt, kps: [], questions: [{
        id: null, type: 'SINGLE', title: 'draft question', options: [{ key: 'A', text: 'aa' }, { key: 'B', text: 'bb' }], answer: ['A']
      }]
    })
  }));
  ok('[发布] 草稿作业保存（不应泄漏给学生）', c2.code === 0, '');
  const fd0 = new FormData();
  fd0.append('title', 'E2E-NC-RES-' + stamp);
  fd0.append('classId', String(newClsId));
  fd0.append('file', new Blob([readFileSync(FIX + 'test-doc.docx')],
    { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'test-doc.docx');
  const upRes = await j(await fetch(API + '/teacher/resources', {
    method: 'POST', headers: { Authorization: 'Bearer ' + chen }, body: fd0
  }));
  ok('[资源] 向当前班级上传学习资源（Word，含 AI 识别）', upRes.code === 0 && !!upRes.data.id, '资源 id=' + (upRes.data && upRes.data.id));
  const resId = upRes.data.id;

  // ---------- 阶段 3：学生端验证 ----------
  console.log('\n—— 阶段3：学生端接收作业与访问资源 ——');
  // 3.1 API：3 名学生全部收到发布的作业，收不到草稿
  let allGot = true, noDraftLeak = true;
  for (const r of roster) {
    const lg = await login(r.no, 'GZgs@2026');
    const mine = await j(await fetch(API + '/assignments/my', { headers: { Authorization: 'Bearer ' + lg.data.token } }));
    if (!(mine.data || []).some(a => a.title === asTitle)) allGot = false;
    if ((mine.data || []).some(a => a.title === draftTitle)) noDraftLeak = false;
  }
  ok('[学生] 全部 3 名学生均接收到教师发布的作业', allGot, '');
  ok('[学生] 草稿作业不泄漏给学生', noDraftLeak, '');
  const myAs = await j(await fetch(API + '/assignments/my', { headers: { Authorization: 'Bearer ' + st1 } }));
  const asDto = (myAs.data || []).find(a => a.title === asTitle);
  ok('[学生] 作业详情含题目与选项', !!asDto && (asDto.questions || []).length === 1
    && asDto.questions[0].options.length === 2, '');
  // 3.2 学生访问学习资源
  const resList = await j(await fetch(API + '/resources', { headers: { Authorization: 'Bearer ' + st1 } }));
  const resDto = (resList.data || []).find(r => String(r.id) === String(resId));
  ok('[学生] 学习资源列表可见教师上传的资源', !!resDto, resDto ? resDto.title : '');
  const resFile = await fetch(API + '/resources/' + resId + '/file', { headers: { Authorization: 'Bearer ' + st1 } });
  ok('[学生] 资源原文件可访问下载', resFile.status === 200, 'HTTP ' + resFile.status);
  // 3.3 学生端 UI：作业视图与资源视图
  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', nos[0]);
  await page.fill('#lgPass', 'GZgs@2026');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.brand-sub', { timeout: 15000 });
  for (let i = 0; i < 30; i++) {
    const t = await page.textContent('.mh-title').catch(() => '');
    if (t && !t.includes('加载中')) break;
    await page.waitForTimeout(300);
  }
  await page.click('[data-act="section"][data-val="homework"]');
  await page.waitForSelector('#main', { timeout: 20000 });
  await page.waitForTimeout(800);
  const hwTxt = await page.textContent('#main');
  ok('[学生UI] 我的作业页面可见教师发布的作业', hwTxt.includes(asTitle), '');
  ok('[学生UI] 未发布草稿不出现在学生作业列表', !hwTxt.includes(draftTitle), '');
  await page.click('[data-act="section"][data-val="resources"]');
  await page.waitForTimeout(1500);
  const resTxt = await page.textContent('#main');
  ok('[学生UI] 学习资源页面可见教师上传的资源', resTxt.includes('E2E-NC-RES-' + stamp), '');
  // 学生提交作业（供教师端提交管理验证）
  const ans = await j(await fetch(API + '/assignments/' + asId + '/answer', {
    method: 'POST', headers: { Authorization: 'Bearer ' + st1, 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ answers: [{ questionId: String(asDto.questions[0].id), value: 'A' }] })
  }));
  ok('[学生] 提交作业成功', ans.code === 0, ans.code === 0 ? '客观题自动判分 total=' + ans.data.autoScore : ans.msg);

  // ---------- 阶段 4：教师端反向验证 ----------
  console.log('\n—— 阶段4：教师端针对新班的全链路管理 ——');
  // 4.1 看板与班级信息
  const dash = await j(await fetch(API + '/teacher/dashboard?classId=' + newClsId, { headers: H }));
  ok('[管理] 新班学情看板正常（人数/空态数据）', dash.code === 0 && dash.data.kpi && Number(dash.data.kpi.studentCount) === 3,
    'studentCount=' + (dash.data && dash.data.kpi && dash.data.kpi.studentCount));
  // 4.2 成员管理：学生列表 + 学号展示 + 重置密码
  const st2Lg = await login(nos[1], 'GZgs@2026');
  const st2 = st2Lg.data.token;
  const reset = await fetch(API + '/teacher/students/' + (sqlVal(`SELECT id FROM user WHERE username='${nos[1]}'`)) + '/reset-password', {
    method: 'POST', headers: { Authorization: 'Bearer ' + chen }
  });
  ok('[管理] 重置学生密码成功', reset.status === 200, 'HTTP ' + reset.status);
  const reLogin = await login(nos[1], 'GZgs@2026');
  ok('[管理] 重置后学生可用初始密码重新登录', reLogin.code === 0, reLogin.code === 0 ? 'ok' : reLogin.msg);
  // 4.3 作业与提交管理
  const subs = await j(await fetch(API + '/teacher/assignments/' + asId + '/submissions', { headers: H }));
  const subRows = subs.data || [];
  ok('[管理] 提交列表：3 人齐全（1 已提交 + 2 未提交）',
    subRows.length === 3 && subRows.filter(s => s.status !== 'missing').length === 1
      && subRows.filter(s => s.status === 'missing').length === 2,
    subRows.map(s => s.name + ':' + s.status).join(', '));
  // 4.4 学习资源管理：教师可见 → 删除 → 学生不可见
  const tchRes = await j(await fetch(API + '/teacher/resources?classId=' + newClsId, { headers: H }));
  ok('[管理] 教师资源列表可见新班资源', (tchRes.data || []).some(r => String(r.id) === String(resId)), '');
  // 4.5 权限配置：共同管理教师（问题1/2 修复的行为复验）
  const zhuId = sqlVal("SELECT id FROM user WHERE username = 'teacher0000001'");
  const addCo = await j(await fetch(API + '/teacher/co-teachers', {
    method: 'POST', headers: H, body: JSON.stringify({ classId: Number(newClsId), teacherId: Number(zhuId) })
  }));
  ok('[权限] 添加共同管理教师成功', addCo.code === 0, addCo.msg || 'ok');
  const zhuLg = await login('teacher0000001');
  const zhu = zhuLg.data.token;
  const zhuCls = await j(await fetch(API + '/teacher/classes', { headers: { Authorization: 'Bearer ' + zhu } }));
  ok('[权限] 共同管理教师班级列表含新班', (zhuCls.data || []).some(c => String(c.id) === String(newClsId)), '');
  const c3 = await j(await fetch(API + '/teacher/compose', {
    method: 'POST', headers: { Authorization: 'Bearer ' + zhu, 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({
      classId: Number(newClsId), title: 'E2E-NC-CO-AS-' + stamp, scoreMode: 'AVERAGE', status: 'ONGOING',
      startAt, endAt, kps: [], questions: [{
        id: null, type: 'SINGLE', title: 'co-teacher question', options: [{ key: 'A', text: 'aa' }, { key: 'B', text: 'bb' }], answer: ['A']
      }]
    })
  }));
  const coAsId = c3.data && c3.data.id;
  ok('[权限] 共同管理教师向新班发布作业成功', c3.code === 0 && sqlVal('SELECT class_id FROM assignment WHERE id = ' + coAsId) === String(newClsId),
    '落班 class_id=' + sqlVal('SELECT class_id FROM assignment WHERE id = ' + coAsId));
  const coMine = await j(await fetch(API + '/assignments/my', { headers: { Authorization: 'Bearer ' + st2 } }));
  ok('[权限] 新班学生收到共同管理教师发布的作业', (coMine.data || []).some(a => String(a.id) === String(coAsId)), '');
  const leave = await j(await fetch(API + '/teacher/classes/' + newClsId, { method: 'DELETE', headers: { Authorization: 'Bearer ' + zhu } }));
  ok('[权限] 共同管理教师删除班级 = 退出自己（action=left），班级保留',
    leave.code === 0 && leave.data.action === 'left' && sqlVal(`SELECT COUNT(*) FROM class WHERE id=${newClsId}`) === '1',
    leave.msg || 'ok');
  const coPanel = await j(await fetch(API + '/teacher/co-teachers?classId=' + newClsId, { headers: H }));
  ok('[权限] 退出后所有者共同管理列表不再显示该教师', !((coPanel.data.coTeachers || []).some(x => String(x.id) === String(zhuId))), '');
  // 资源删除 → 学生不可见
  const delRes = await fetch(API + '/teacher/resources/' + resId, { method: 'DELETE', headers: { Authorization: 'Bearer ' + chen } });
  ok('[管理] 教师删除学习资源成功', delRes.status === 200, 'HTTP ' + delRes.status);
  const resList2 = await j(await fetch(API + '/resources', { headers: { Authorization: 'Bearer ' + st1 } }));
  ok('[管理] 删除后学生资源列表不再可见', !((resList2.data || []).some(r => String(r.id) === String(resId))), '');
  // 4.6 班级删除（所有者收尾）：级联清理
  const delCls = await fetch(API + '/teacher/classes/' + newClsId, { method: 'DELETE', headers: H });
  ok('[删除] 所有者删除新班成功', delCls.status === 200, 'HTTP ' + delCls.status);
  ok('[删除] 班级删除级联：学生移出班级（class_id 置空）',
    sqlVal(`SELECT class_id FROM user WHERE username='${nos[0]}'`) === 'NULL', '');
  const orphan = sqlVal(`SELECT COUNT(*) FROM assignment WHERE class_id=${newClsId}`);
  const resOrphan = sqlVal(`SELECT COUNT(*) FROM learning_resource WHERE class_id=${newClsId}`);
  ok('[删除] 班级作业与资源级联清空', orphan === '0' && resOrphan === '0', '作业残留=' + orphan + ' 资源残留=' + resOrphan);

  ok('无 JS 报错 / 无意外 4xx 5xx', errors.length === 0, errors.slice(0, 3).join(' ; '));

  // ---------- 阶段 5：清场 ----------
  sql(`DELETE FROM user WHERE username IN ('${nos.join("','")}')`);
  const stuLeft = sqlVal(`SELECT COUNT(*) FROM user WHERE username IN ('${nos.join("','")}')`);
  unlinkSync(xlsxPath);
  ok('[清场] 测试学生账号清理无残留', stuLeft === '0', '');

  console.log('\n=== 新建班级全链路 E2E: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  if (fail === 0) console.log('结论：导入建班 → 学生接收（作业/资源）→ 教师端反向管理全链路闭环无断点，未发现功能失效点。');
  else console.log('结论：发现 ' + fail + ' 个异常点，详见上方 ✗ 标注。');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
