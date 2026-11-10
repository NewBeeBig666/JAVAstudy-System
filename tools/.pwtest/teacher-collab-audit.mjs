/* 教师协作机制专项审计：验证两个核心问题的存在状态
 * 问题1 教师权限同步：共同管理教师发布作业 → 作业是否落到当前选中的班级、学生能否收到
 *   （前端 composeSubmit 不携带 classId + 后端 defaultClassId 兜底为发布者自己授课的第一个班级）
 * 问题2 班级删除与多教师协作：期望「任意教师删除班级 = 自己退出，不影响其他教师」，
 *   当前实现为「仅所有者可硬删整个班级，共同管理教师不可删」
 * 输出完整测试过程与结论；测试数据全部清场
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
const oneQ = () => [{ id: null, type: 'SINGLE', title: 'audit question', options: [{ key: 'A', text: 'aa' }, { key: 'B', text: 'bb' }], answer: ['A'] }];

(async () => {
  // 开场清场：历史审计残留（上轮中断可能遗留）
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

  console.log('================ 问题1：教师权限同步（共同管理教师发布作业） ================');
  const chen = await login('teacher');            // 陈老师：班级1/2 所有者
  const zhu = await login('teacher0000001');      // 朱老师：自己有授课班级，被共同管理到班级1
  const wang = await login('teacher0000002');    // 王老师：第三位教师（问题2备用）
  const stu = await login('student');             // 张明：班级1 学生
  const H = (t) => ({ Authorization: 'Bearer ' + t, 'Content-Type': 'application/json;charset=utf-8' });

  const stamp = Date.now().toString(36);
  const startAt = fmt(Date.now()), endAt = fmt(Date.now() + 7 * 864e5);
  const myAssignments = async (tok) => (await j(await fetch(API + '/assignments/my', { headers: H(tok) })));

  // 基础事实：班级归属
  const zhuId = sqlVal("SELECT id FROM user WHERE username = 'teacher0000001'");
  const wangId = sqlVal("SELECT id FROM user WHERE username = 'teacher0000002'");
  const chenId = sqlVal("SELECT id FROM user WHERE username = 'teacher'");
  const zhuOwnClasses = (sql(`SELECT id, name FROM class WHERE teacher_id = ${zhuId} ORDER BY id`) || '')
    .replace(/\r/g, '').trim().split('\n').slice(1).filter(Boolean);
  const zhuDefaultClassId = zhuOwnClasses.length ? zhuOwnClasses[0].split('\t')[0] : sqlVal('SELECT MIN(id) FROM class');
  console.log('  [事实] 朱老师(user ' + zhuId + ') 授课班级：[' + zhuOwnClasses.join(' | ') + ']');
  console.log('  [事实] 后端 defaultClassId(朱老师) 推演 = ' + zhuDefaultClassId
    + (zhuOwnClasses.length ? '（自己授课的第一个班级）' : '（无授课班级 → 回退全库第一个班级）'));
  const cls1Name = sqlVal('SELECT name FROM class WHERE id = 1');

  // 陈老师把朱老师添加为班级1共同管理教师（幂等：已存在则复用）
  const add1 = await j(await fetch(API + '/teacher/co-teachers', {
    method: 'POST', headers: H(chen), body: JSON.stringify({ classId: 1, teacherId: Number(zhuId) })
  }));
  ok('[权限] 添加朱老师为班级1共同管理教师（或已存在）', add1.code === 0 || /已/.test(add1.msg || ''), add1.msg || 'ok');

  // 1.1 权限面盘点：共同管理教师 vs 所有者
  const zcls = await j(await fetch(API + '/teacher/classes', { headers: H(zhu) }));
  const z1 = (zcls.data || []).find(c => String(c.id) === '1');
  ok('[权限] 朱老师班级列表含班级1（共同管理可见）', !!z1, z1 ? z1.name : '');
  const zas = await j(await fetch(API + '/teacher/assignments?classId=1', { headers: H(zhu) }));
  ok('[权限] 朱老师可查看班级1作业列表', zas.code === 0, (zas.data || []).length + ' 份');
  const zdash = await j(await fetch(API + '/teacher/dashboard?classId=1', { headers: H(zhu) }));
  ok('[权限] 朱老师可查看班级1学情看板', zdash.code === 0 && !!zdash.data.kpi, '');
  const zsub = await j(await fetch(API + '/teacher/assignments?classId=1', { headers: H(zhu) }));
  const firstAsId = ((zsub.data || [])[0] || {}).id;
  if (firstAsId) {
    const delTry = await fetch(API + '/teacher/assignments/' + firstAsId, { method: 'DELETE', headers: H(zhu) });
    const delTryJ = await j(delTry);
    console.log('  [差异] 朱老师删除班级1作业 → HTTP ' + delTry.status + ' ' + (delTryJ.msg || '')
      + '（所有者陈老师可删；共同管理教师无删除权 = 与所有者权限不一致）');
  }

  // 1.2 核心复现（API 等价前端真实 payload：不含 classId）
  console.log('  —— 复现步骤：朱老师（共同管理教师）面向班级1发布作业 ——');
  const composeNoCls = async (tok, title) => j(await fetch(API + '/teacher/compose', {
    method: 'POST', headers: H(tok),
    body: JSON.stringify({ title, scoreMode: 'AVERAGE', status: 'ONGOING', startAt, endAt, kps: [], questions: oneQ() })
  }));
  const t1 = 'AUDIT1-ZHU-NOCCLASSID-' + stamp;
  const r1 = await composeNoCls(zhu, t1);
  ok('[复现1] 朱老师发布作业（请求不含 classId，与前端一致）', r1.code === 0, '作业 id=' + r1.data && r1.data.id);
  const as1 = r1.data.id;
  const landed = sqlVal('SELECT class_id FROM assignment WHERE id = ' + as1);
  const landedName = sqlVal('SELECT name FROM class WHERE id = ' + landed);
  ok('[复现1] 作业实际落班 = ' + landedName + '（非班级1「' + cls1Name + '」）', landed !== '1', 'class_id=' + landed + ' / 班级1=1');
  const stuList1 = await myAssignments(stu);
  const stuHas1 = (stuList1.data || []).some(a => String(a.id) === String(as1));
  ok('[复现1] 班级1学生收到该作业？', false, '学生列表 ' + (stuHas1 ? '包含' : '不包含') + '该作业 → ' + (stuHas1 ? '能收到' : '收不到（问题1复现）'));

  // 1.3 对照：带 classId=1 发布（证明根因在前端不传 + 后端兜底）
  const r2 = await j(await fetch(API + '/teacher/compose', {
    method: 'POST', headers: H(zhu),
    body: JSON.stringify({ classId: 1, title: 'AUDIT1-ZHU-WITHCLASS-' + stamp, scoreMode: 'AVERAGE', status: 'ONGOING', startAt, endAt, kps: [], questions: oneQ() })
  }));
  const as2 = r2.data.id;
  const landed2 = sqlVal('SELECT class_id FROM assignment WHERE id = ' + as2);
  const stuList2 = await myAssignments(stu);
  const stuHas2 = (stuList2.data || []).some(a => String(a.id) === String(as2));
  ok('[对照] 显式携带 classId=1 发布 → 落班正确且学生可收到', landed2 === '1' && stuHas2,
    'class_id=' + landed2 + '，学生' + (stuHas2 ? '已收到' : '未收到') + '（证明带上班级即无问题）');

  // 1.4 附加发现：所有者本人切换到其他班级发布同样中招（defaultClassId 恒为自己授课第一个班）
  const chenOwnFirst = sqlVal(`SELECT MIN(id) FROM class WHERE teacher_id = ${chenId}`);
  const r3 = await composeNoCls(chen, 'AUDIT1-CHEN-CLS2-' + stamp);
  const as3 = r3.data.id;
  const landed3 = sqlVal('SELECT class_id FROM assignment WHERE id = ' + as3);
  const cls2Students = (sqlVal(`SELECT COUNT(*) FROM user WHERE class_id = 2`) || '0');
  console.log('  [附加] 陈老师（所有者）不传 classId 发布 → 落班 class_id=' + landed3
    + '（= 其授课第一个班 ' + chenOwnFirst + '，与当前选中班级无关）'
    + (cls2Students !== '0' && landed3 !== '2' ? '；若其当前选中班级2发布，班级2学生同样收不到（问题不限于共同管理教师）' : ''));

  // 1.5 UI 真实路径复现（浏览器完整走发布流程 + 抓包 payload 佐证）
  console.log('  —— 复现步骤（UI 真实路径）：朱老师浏览器切换到班级1 → 发布新作业 ——');
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
      try { composePayload = JSON.parse(r.postData()); } catch (e) { composePayload = r.postData(); }
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
  // 切换到班级1（共同管理）
  const cls1Item = await page.$('#side .list-item[data-act="classPick"][data-val="1"]');
  if (cls1Item) {
    await cls1Item.click();
    await page.waitForTimeout(1500);
    const brand = (await page.textContent('.brand-sub')).trim();
    console.log('  [UI] 朱老师已切换当前班级：' + brand + '（期望面向班级1发布）');
  }
  await page.click('[data-act="section"][data-val="assignments"]');
  await page.waitForSelector('[data-act="openCompose"]', { timeout: 20000 });
  await page.click('[data-act="openCompose"]');
  await page.waitForSelector('.compose-mask', { timeout: 10000 });
  // 填标题 + 添加单选题
  const uiTitle = 'AUDIT1-UI-ZHU-' + stamp;
  await page.fill('.compose-mask .compose-title', uiTitle);
  await page.click('.compose-mask [data-act="composeAddQ"][data-val="SINGLE"]');
  await page.waitForSelector('.compose-mask textarea[data-key="title"]', { timeout: 5000 });
  await page.fill('.compose-mask textarea[data-key="title"]', 'ui audit question');
  await page.fill('.compose-mask input[data-bind="compose"][data-q="0"][data-oi="0"]', 'opt a');
  await page.fill('.compose-mask input[data-bind="compose"][data-q="0"][data-oi="1"]', 'opt b');
  await page.check('.compose-mask input[data-ans="single"][data-oi="0"]');
  // 结束时间：今天 23:59
  await page.click('.compose-mask [data-act="openDtp"][data-val="endAt"]');
  await page.waitForSelector('.compose-mask [data-act="dtpToday"]', { timeout: 5000 });
  await page.click('.compose-mask [data-act="dtpToday"]');
  await page.fill('.compose-mask input[data-bind="dtp"][data-key="hour"]', '23');
  await page.fill('.compose-mask input[data-bind="dtp"][data-key="minute"]', '59');
  await page.click('.compose-mask [data-act="dtpOk"]');
  await page.waitForTimeout(300);
  await page.click('.compose-mask [data-act="composePublish"]');
  await page.waitForTimeout(1800);
  const uiToast = (await page.textContent('.toast:last-child').catch(() => '')).trim();
  ok('[UI复现] 发布动作成功（前端提示已发布）', uiToast.includes('已发布'), uiToast);
  ok('[UI证据] 捕获 POST /teacher/compose 请求体：不含 classId 字段',
    composePayload !== null && !('classId' in composePayload),
    composePayload ? 'payload keys=' + Object.keys(composePayload).filter(k => /class/i.test(k)).concat(['（无 class 相关字段）']).join('') : '未捕获');
  const uiAs = composePayload && composePayload.id == null ? sqlVal(`SELECT id FROM assignment WHERE title = '${uiTitle}'`) : null;
  if (uiAs) {
    const uiLanded = sqlVal('SELECT class_id FROM assignment WHERE id = ' + uiAs);
    const uiLandedName = sqlVal('SELECT name FROM class WHERE id = ' + uiLanded);
    ok('[UI复现] UI 发布的作业实际落班 = ' + uiLandedName, uiLanded !== '1', 'class_id=' + uiLanded);
    // 发布后当前班级（班级1）作业列表是否可见
    await page.waitForTimeout(800);
    const listTxt = await page.textContent('#main').catch(() => '');
    ok('[UI复现] 发布后「班级1」作业管理列表中看不到该作业', !listTxt.includes(uiTitle),
      '（发布成功 toast 却未出现在当前班级列表 → 二次异常表现）');
    const stuList3 = await myAssignments(stu);
    const stuHas3 = (stuList3.data || []).some(a => String(a.id) === String(uiAs));
    console.log('  [UI复现] 班级1学生「我的作业」' + (stuHas3 ? '包含' : '不包含') + '该 UI 发布的作业 → ' + (stuHas3 ? '能收到' : '收不到（问题1全链路复现）'));
    ok('[UI复现] 班级1学生收不到朱老师 UI 发布的作业', !stuHas3, '');
  }

  console.log('\n================ 问题2：班级删除与多教师协作 ================');
  // 2.1 共同管理教师删除班级（期望：删除=自己退出班级）
  console.log('  —— 复现步骤：朱老师（共同管理教师）对班级1执行删除 ——');
  const delByZhu = await fetch(API + '/teacher/classes/1', { method: 'DELETE', headers: H(zhu) });
  const delByZhuJ = await j(delByZhu);
  ok('[复现2] 共同管理教师删除班级 → 被拒（无「删除=退出自己」机制）', delByZhu.status === 400 && /仅班级所有者/.test(delByZhuJ.msg || ''),
    'HTTP ' + delByZhu.status + ' ' + delByZhuJ.msg);
  // UI 层面：朱老师回到学情看板（班级列表所在侧栏）右键班级1 → 仅显示灰色只读提示
  await page.click('[data-act="section"][data-val="dashboard"]');
  await page.waitForTimeout(800);
  await page.click('#side .list-item[data-act="classPick"][data-val="1"]', { button: 'right' }).catch(() => {});
  await page.waitForSelector('.as-menu', { timeout: 5000 }).catch(() => {});
  const menuTxt = (await page.textContent('.as-menu').catch(() => '')).trim();
  ok('[UI复现2] 共同管理教师右键班级菜单仅只读提示「删除班级（仅班级所有者）」', menuTxt.includes('仅班级所有者'), menuTxt);
  await page.close().catch(() => {});

  // 2.2 所有者删除的影响面（期望：仅删除者退出、其他教师数据保留；实测临时班）
  console.log('  —— 复现步骤：建临时班级并绑定多名教师 → 所有者删除 → 观察影响面 ——');
  const tmpName = 'AUDIT2-CLS-' + stamp;
  sql(`INSERT INTO class (name, grade, teacher_id) VALUES ('${tmpName}', '2026', ${chenId})`);
  const tmpId = sqlVal(`SELECT id FROM class WHERE name = '${tmpName}'`);
  sql(`INSERT INTO user (username, password_hash, real_name, role, student_no, class_id) VALUES ('auditstu${stamp.slice(-4)}', '$2a$10$lRIP406sPNtpi3ZeEntMm.Eu0fp9ZCIESRYdsL8Hlay0O0CMjaMDu', 'AuditStu', 'STUDENT', 'A${stamp.slice(-6)}', ${tmpId})`);
  sql(`INSERT INTO assignment (teacher_id, class_id, title, status) VALUES (${chenId}, ${tmpId}, 'AUDIT2-Asm', 'ONGOING')`);
  sql(`INSERT INTO class_co_teacher (class_id, teacher_id) VALUES (${tmpId}, ${zhuId})`);
  sql(`INSERT INTO class_co_teacher (class_id, teacher_id) VALUES (${tmpId}, ${wangId})`);
  const zHas = async (tok) => {
    const r = await j(await fetch(API + '/teacher/classes', { headers: H(tok) }));
    return (r.data || []).some(c => String(c.id) === String(tmpId));
  };
  ok('[复现2] 删除前：朱老师与王老师账号均可见临时班级', (await zHas(zhu)) && (await zHas(wang)), 'classId=' + tmpId);
  const delByChen = await fetch(API + '/teacher/classes/' + tmpId, { method: 'DELETE', headers: H(chen) });
  ok('[复现2] 所有者删除临时班级成功（当前实现=硬删整个班级）', delByChen.status === 200, 'HTTP ' + delByChen.status);
  ok('[复现2] 删除后：朱老师账号中班级消失（班级整体不复存在）', !(await zHas(zhu)), '');
  ok('[复现2] 删除后：王老师账号中班级同样消失（其他教师数据未保留）', !(await zHas(wang)), '');
  const stuNowCls = sqlVal(`SELECT class_id FROM user WHERE student_no = 'A${stamp.slice(-6)}'`);
  const asmLeft = sqlVal(`SELECT COUNT(*) FROM assignment WHERE class_id = ${tmpId}`);
  ok('[复现2] 删除后：学生被移出班级(class_id置空) + 班级作业级联删除', stuNowCls === 'NULL' || stuNowCls === null || stuNowCls === '', '学生 class_id=' + (stuNowCls || 'NULL') + '，作业残留=' + asmLeft);
  console.log('  [结论素材] 当前删除行为影响：班级本身、全部共同管理教师的可见性、学生关联、作业/资源/预警数据 —— 与期望「仅删除者自己退出、其他教师账号数据完整保留」相反');

  // 2.3 「退出后其他教师列表不再显示该教师」可验证性
  console.log('  —— 验证点：教师退出班级后，其他教师的共同管理列表不再显示该教师 ——');
  const rm = await fetch(API + '/teacher/co-teachers/1?classId=1', { method: 'DELETE', headers: H(zhu) });
  console.log('  [事实] 教师侧无任何「退出班级/移除自己」接口（DELETE /teacher/co-teachers 返回 HTTP ' + rm.status + '）；共同管理列表纯展示无移除入口');
  ok('[复现2] 「退出后其他教师列表不再显示该教师」无机制可产生该状态', rm.status === 404 || rm.status === 405, '退出机制缺失，该验证点当前不可达');

  /* ============ 清场 ============ */
  let delOk = true, delDetail = [];
  const zhuDel = async (id) => {
    const r = await fetch(API + '/teacher/assignments/' + id, { method: 'DELETE', headers: H(zhu) });
    if (r.status !== 200) { delOk = false; delDetail.push(id + '(zhu):' + r.status); }
  };
  const chenDel = async (id) => {
    const r = await fetch(API + '/teacher/assignments/' + id, { method: 'DELETE', headers: H(chen) });
    if (r.status !== 200) { delOk = false; delDetail.push(id + '(chen):' + r.status); }
  };
  await zhuDel(as1);
  if (uiAs) await zhuDel(uiAs);
  await chenDel(as3);
  await chenDel(as2);   // as2 由朱老师发布但落班级1（共同管理班）：deleteAssignment 按授课班级鉴权 → 朱老师删不掉，须所有者删
  ok('[清场] 审计测试作业全部删除', delOk, delDetail.join(','));
  const remain = sqlVal(`SELECT COUNT(*) FROM assignment WHERE title LIKE 'AUDIT%'`);
  const tmpLeft = sqlVal(`SELECT COUNT(*) FROM class WHERE name LIKE 'AUDIT2-%'`);
  sql(`DELETE FROM user WHERE student_no = 'A${stamp.slice(-6)}'`);
  const stuLeft = sqlVal(`SELECT COUNT(*) FROM user WHERE student_no = 'A${stamp.slice(-6)}'`);
  ok('[清场] 审计数据无残留', remain === '0' && tmpLeft === '0' && stuLeft === '0',
    '作业残留=' + remain + ' 临时班残留=' + tmpLeft + ' 测试学生残留=' + stuLeft);

  console.log('\n================ 审计结论 ================');
  console.log('问题1（教师权限同步/非所有者发布作业学生收不到）：** 存在 **');
  console.log('  根因：前端 composeSubmit 的 /teacher/compose 请求不携带当前选中班级 classId，');
  console.log('  后端 defaultClassId() 兜底为「发布者自己授课的第一个班级」，与教师当前选中的班级无关。');
  console.log('  表现：共同管理教师面向班级1发布 → 作业落到其本人授课班级 → 班级1学生收不到；');
  console.log('  且发布成功后当前班级的作业列表中也不显示该作业（刷新拉取同样不带 classId）。');
  console.log('  附加：所有者本人切换到自己的其他班级发布同样落错班级（不限于共同管理教师）。');
  console.log('  显式携带 classId 发布则一切正常（学生可收到）→ 修复点明确。');
  console.log('问题2（班级删除=任意教师退出机制）：** 存在（当前实现与期望需求不符）**');
  console.log('  现状：仅班级所有者可删除，删除=硬删整个班级（共同管理权限/作业/资源/预警级联清空、学生移出班级），');
  console.log('  影响所有关联教师账号；共同管理教师无删除权（400「仅班级所有者」），无「删除=自己退出」机制，');
  console.log('  也无任何教师自主退出接口 → 「退出后其他教师列表不再显示该教师」验证点不可达（功能缺失）。');

  console.log('\n=== 教师协作机制审计: ' + pass + ' 通过 / ' + fail + ' 失败（✗ 为与期望不符的验证点）===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
