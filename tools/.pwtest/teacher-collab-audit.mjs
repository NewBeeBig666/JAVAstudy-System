/* 教师协作机制修复验证（原 teacher-collab-audit 审计确认的两个问题的修复回归）
 * 问题1 教师权限同步：前端发布作业携带当前选中班级 classId；共同管理教师面向所选班级发布学生可收到；
 *        后端 defaultClassId 兜底增强（授课班→共同管理班→全库首个）；共同管理教师获得一致的作业管理权限（删除/移动）
 * 问题2 班级删除=退出机制：共同管理教师右键「退出班级」仅移除自己关联；班级与其他教师数据完整保留；
 *        所有者（其他教师）的共同管理列表不再显示已退出教师；所有者硬删整班行为保留；无关联教师仍被拒
 */
import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
const BASE = 'http://localhost:8080';
const API = BASE + '/api';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '（' + detail + '）' : '')); }
};
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { code: -999, msg: t.slice(0, 120) }; } };

async function login(u) {
  const r = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ username: u, password: '123456' })
  });
  const d = await j(r);
  if (d.code !== 0) throw new Error('登录失败(' + u + '): ' + d.msg);
  return d.data.token;
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
const oneQ = () => [{ id: null, type: 'SINGLE', title: 'fix verify question', options: [{ key: 'A', text: 'aa' }, { key: 'B', text: 'bb' }], answer: ['A'] }];

(async () => {
  // 开场清场
  ["DELETE FROM lab_group_invite WHERE assignment_id IN (SELECT id FROM assignment WHERE title LIKE 'AUDIT%')",
   "DELETE FROM lab_group_member WHERE assignment_id IN (SELECT id FROM assignment WHERE title LIKE 'AUDIT%')",
   "DELETE FROM lab_group WHERE assignment_id IN (SELECT id FROM assignment WHERE title LIKE 'AUDIT%')",
   "DELETE FROM submission WHERE assignment_id IN (SELECT id FROM assignment WHERE title LIKE 'AUDIT%')",
   "DELETE FROM question WHERE assignment_id IN (SELECT id FROM assignment WHERE title LIKE 'AUDIT%')",
   "DELETE FROM rubric WHERE assignment_id IN (SELECT id FROM assignment WHERE title LIKE 'AUDIT%')",
   "DELETE FROM assignment WHERE title LIKE 'AUDIT%'",
   "DELETE FROM class_co_teacher WHERE class_id IN (SELECT id FROM class WHERE name LIKE 'AUDIT2-%')",
   "DELETE FROM class WHERE name LIKE 'AUDIT2-%'",
   "DELETE FROM user WHERE role = 'STUDENT' AND username LIKE 'auditstu%'"
  ].forEach(q => sql(q));

  console.log('================ 问题1 修复验证：共同管理教师发布作业学生可收到 ================');
  const chen = await login('teacher');            // 陈老师：班级1/2 所有者
  const zhu = await login('teacher0000001');      // 朱老师：授课班3，被共同管理到班级1
  const wang = await login('teacher0000002');     // 王老师：无授课班（兜底验证用）
  const stu = await login('student');             // 张明：班级1 学生
  const H = (t) => ({ Authorization: 'Bearer ' + t, 'Content-Type': 'application/json;charset=utf-8' });

  const stamp = Date.now().toString(36);
  const startAt = fmt(Date.now()), endAt = fmt(Date.now() + 7 * 864e5);
  const zhuId = sqlVal("SELECT id FROM user WHERE username = 'teacher0000001'");
  const wangId = sqlVal("SELECT id FROM user WHERE username = 'teacher0000002'");

  // 陈老师将朱老师、王老师设为班级1共同管理教师（幂等）
  for (const tid of [zhuId, wangId]) {
    const r = await j(await fetch(API + '/teacher/co-teachers', {
      method: 'POST', headers: H(chen), body: JSON.stringify({ classId: 1, teacherId: Number(tid) })
    }));
    ok('[准备] 班级1共同管理教师就绪（' + tid + '）', r.code === 0 || /已/.test(r.msg || ''), r.msg || 'ok');
  }

  // 1.1 UI 真实路径：朱老师切班1 → 发布 → payload 含 classId → 学生收到
  let browser;
  for (const ch of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {}
  }
  if (!browser) throw new Error('无可用系统浏览器');
  process.on('exit', () => { try { browser.close(); } catch (e) {} });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  let composePayload = null;
  page.on('request', r => {
    if (r.url().endsWith('/teacher/compose') && r.method() === 'POST') {
      try { composePayload = JSON.parse(r.postData()); } catch (e) { composePayload = null; }
    }
  });
  const waitView = async (pg) => {
    for (let i = 0; i < 30; i++) {
      const t = await pg.textContent('.mh-title').catch(() => '');
      if (t && !t.includes('加载中')) break;
      await pg.waitForTimeout(300);
    }
  };
  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', 'teacher0000001');
  await page.fill('#lgPass', '123456');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.brand-sub', { timeout: 15000 });
  await waitView(page);
  await page.click('#side .list-item[data-act="classPick"][data-val="1"]');
  await page.waitForTimeout(1500);
  console.log('  [UI] 朱老师切换当前班级：' + (await page.textContent('.brand-sub')).trim());
  await page.click('[data-act="section"][data-val="assignments"]');
  await page.waitForSelector('[data-act="openCompose"]', { timeout: 20000 });
  await page.click('[data-act="openCompose"]');
  await page.waitForSelector('.compose-mask', { timeout: 10000 });
  const uiTitle = 'AUDIT1-UI-ZHU-' + stamp;
  await page.fill('.compose-mask .compose-title', uiTitle);
  await page.click('.compose-mask [data-act="composeAddQ"][data-val="SINGLE"]');
  await page.waitForSelector('.compose-mask textarea[data-key="title"]', { timeout: 5000 });
  await page.fill('.compose-mask textarea[data-key="title"]', 'fix verify question');
  await page.fill('.compose-mask input[data-bind="compose"][data-q="0"][data-oi="0"]', 'opt a');
  await page.fill('.compose-mask input[data-bind="compose"][data-q="0"][data-oi="1"]', 'opt b');
  await page.check('.compose-mask input[data-ans="single"][data-oi="0"]');
  await page.click('.compose-mask [data-act="openDtp"][data-val="endAt"]');
  await page.waitForSelector('.compose-mask [data-act="dtpToday"]', { timeout: 5000 });
  await page.click('.compose-mask [data-act="dtpToday"]');
  await page.fill('.compose-mask input[data-bind="dtp"][data-key="hour"]', '23');
  await page.fill('.compose-mask input[data-bind="dtp"][data-key="minute"]', '59');
  await page.click('.compose-mask [data-act="dtpOk"]');
  await page.waitForTimeout(300);
  await page.click('.compose-mask [data-act="composePublish"]');
  await page.waitForTimeout(1800);
  ok('[UI] 发布成功提示', ((await page.textContent('.toast:last-child').catch(() => '')).trim()).includes('已发布'), '');
  ok('[UI] 发布请求体携带当前选中班级 classId=1',
    composePayload !== null && Number(composePayload.classId) === 1,
    'payload classId=' + (composePayload && composePayload.classId));
  const uiAs = composePayload && composePayload.classId == 1
    ? sqlVal(`SELECT id FROM assignment WHERE title = '${uiTitle}'`) : null;
  if (uiAs) {
    const landed = sqlVal('SELECT class_id FROM assignment WHERE id = ' + uiAs);
    ok('[UI] 作业落班 = 当前选中班级1', landed === '1', 'class_id=' + landed);
    await page.waitForTimeout(600);
    const listTxt = await page.textContent('#main').catch(() => '');
    ok('[UI] 发布后当前班级作业列表立即可见', listTxt.includes(uiTitle), '');
    const stuList = await j(await fetch(API + '/assignments/my', { headers: H(stu) }));
    ok('[核心] 班级1学生收到共同管理教师发布的作业',
      (stuList.data || []).some(a => String(a.id) === String(uiAs)), '作业 id=' + uiAs);
    // 1.2 权限一致性：共同管理教师可删除（管理）共同管理班级的作业（测试作业同时作为清场手段）
    const delTry = await fetch(API + '/teacher/assignments/' + uiAs, { method: 'DELETE', headers: H(zhu) });
    ok('[权限] 共同管理教师可删除该班作业（与所有者一致）', delTry.status === 200, 'HTTP ' + delTry.status);
    var uiAsDeleted = delTry.status === 200;
  }

  // 1.3 API 显式班级：陈老师显式 classId=2 发布 → 落班2（多班所有者切班场景）
  const r2 = await j(await fetch(API + '/teacher/compose', {
    method: 'POST', headers: H(chen),
    body: JSON.stringify({ classId: 2, title: 'AUDIT1-CHEN-CLS2-' + stamp, scoreMode: 'AVERAGE', status: 'ONGOING', startAt, endAt, kps: [], questions: oneQ() })
  }));
  ok('[API] 所有者显式指定班级2发布成功', r2.code === 0
    && sqlVal('SELECT class_id FROM assignment WHERE id = ' + r2.data.id) === '2', '');
  const as2 = r2.data.id;

  // 1.4 后端兜底增强：无授课班级的共同管理教师（王老师）不带 classId 发布 → 落其共同管理班级
  const r4 = await j(await fetch(API + '/teacher/compose', {
    method: 'POST', headers: H(wang),
    body: JSON.stringify({ title: 'AUDIT1-WANG-NOCLS-' + stamp, scoreMode: 'AVERAGE', status: 'ONGOING', startAt, endAt, kps: [], questions: oneQ() })
  }));
  const as4 = r4.data.id;
  ok('[兜底] 无授课班级的共同管理教师未传 classId → 落共同管理班级1',
    r4.code === 0 && sqlVal('SELECT class_id FROM assignment WHERE id = ' + as4) === '1',
    'class_id=' + sqlVal('SELECT class_id FROM assignment WHERE id = ' + as4));

  console.log('\n================ 问题2 修复验证：删除班级=退出自己（多教师协作） ================');
  // 2.1 共同管理教师右键菜单「退出班级」
  await page.click('[data-act="section"][data-val="dashboard"]');
  await page.waitForTimeout(800);
  await page.click('#side .list-item[data-act="classPick"][data-val="1"]', { button: 'right' }).catch(() => {});
  await page.waitForSelector('.as-menu', { timeout: 5000 }).catch(() => {});
  const menuHtml = await page.$eval('.as-menu', e => e.innerHTML).catch(() => '');
  ok('[UI] 共同管理教师右键菜单含「退出班级」入口',
    menuHtml.includes('classLeaveModal') && menuHtml.includes('退出班级') && !menuHtml.includes('classDelModal'), '');
  // 2.2 UI 退出全流程
  await page.click('.as-menu [data-act="classLeaveModal"]').catch(() => {});
  await page.waitForSelector('.modal', { timeout: 5000 }).catch(() => {});
  const leaveTxt = (await page.textContent('.modal .modal-body').catch(() => '')).trim();
  ok('[UI] 退出弹窗说明数据完整保留', leaveTxt.includes('完整保留') && leaveTxt.includes('其他教师不受影响'), '');
  await page.click('.modal [data-act="doClassLeave"]').catch(() => {});
  await page.waitForTimeout(1500);
  const tLeave = (await page.textContent('.toast:last-child').catch(() => '')).trim();
  ok('[UI] 退出成功提示', tLeave.includes('已退出'), tLeave);
  ok('[UI] 退出后自己列表移除班级项但班级保留',
    !(await page.$('#side .list-item[data-act="classPick"][data-val="1"]').catch(() => null))
      && sqlVal('SELECT COUNT(*) FROM class WHERE id = 1') === '1', '');
  await page.close().catch(() => {});

  // 2.3 API 验证：退出后数据完整性 + 其他教师视角
  const coPanel = await j(await fetch(API + '/teacher/co-teachers?classId=1', { headers: H(chen) }));
  ok('[核心] 退出后所有者的共同管理列表不再显示已退出的教师',
    coPanel.code === 0 && !((coPanel.data.coTeachers || []).some(x => String(x.id) === String(zhuId))),
    '剩余共同管理教师：' + (coPanel.data.coTeachers || []).map(t => t.username).join(','));
  const cls1OfChen = await j(await fetch(API + '/teacher/classes', { headers: H(chen) }));
  ok('[核心] 班级1对所有者完整保留（作业/学生/数据不受退出影响）',
    ((cls1OfChen.data || []).some(c => String(c.id) === '1'))
      && sqlVal('SELECT COUNT(*) FROM assignment WHERE class_id = 1') !== '0', '');
  // 2.4 恢复环境：陈老师重新添加朱老师为班级1共同管理（后续测试依赖）
  const reAdd = await j(await fetch(API + '/teacher/co-teachers', {
    method: 'POST', headers: H(chen), body: JSON.stringify({ classId: 1, teacherId: Number(zhuId) })
  }));
  ok('[恢复] 朱老师重新加入班级1共同管理（环境还原）', reAdd.code === 0, reAdd.msg || 'ok');

  // 2.5 无关联教师仍被拒（王老师先退出班级1，再删除 → 400）
  const leaveWang = await j(await fetch(API + '/teacher/classes/1', { method: 'DELETE', headers: H(wang) }));
  ok('[API] 王老师退出班级1（action=left）', leaveWang.code === 0 && leaveWang.data.action === 'left', leaveWang.msg || 'ok');
  const delWang2 = await fetch(API + '/teacher/classes/1', { method: 'DELETE', headers: H(wang) });
  const delWang2j = await j(delWang2);
  ok('[API] 与班级无关联的教师删除仍被拒（400）', delWang2.status === 400 && /仅班级所有者/.test(delWang2j.msg || ''), delWang2j.msg);
  const reAddWang = await j(await fetch(API + '/teacher/co-teachers', {
    method: 'POST', headers: H(chen), body: JSON.stringify({ classId: 1, teacherId: Number(wangId) })
  }));
  ok('[恢复] 王老师重新加入班级1共同管理（环境还原）', reAddWang.code === 0, reAddWang.msg || 'ok');

  /* ============ 清场 ============ */
  let delOk = true, delDetail = [];
  for (const id of [uiAsDeleted ? null : uiAs, as2, as4].filter(Boolean)) {
    const r = await fetch(API + '/teacher/assignments/' + id, { method: 'DELETE', headers: H(chen) });
    if (r.status !== 200) { delOk = false; delDetail.push(id + ':' + r.status); }
  }
  ok('[清场] 测试作业全部删除', delOk, delDetail.join(','));
  const remain = sqlVal(`SELECT COUNT(*) FROM assignment WHERE title LIKE 'AUDIT%'`);
  ok('[清场] 审计数据无残留', remain === '0', '作业残留=' + remain);

  console.log('\n=== 教师协作机制修复验证: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
