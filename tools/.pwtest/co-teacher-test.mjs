/* 顶栏「其他教师」· 班级共同管理教师功能验证（v2：手动输入账号 + 纯展示列表）
 * [API] 面板数据/添加/重复添加/添加所有者/添加学生/不存在账号拒绝；
 *       非所有者只读；共同管理教师可见该班级（classes 含 + dashboard 可查）；
 *       移除接口已下线（DELETE 404）；学生 403
 * [UI] 按钮位置（user-chip 右侧）→ 弹窗（当前班级绑定）→ 手动输入账号实时校验：
 *       不完整/不存在/已添加教师账号 → 无匹配卡片且「添加」按钮禁用；
 *       输入完整有效教师账号 → 显示「X老师」信息卡片并支持添加 → 列表实时更新（纯展示，无移除按钮）→
 *       重开拉取最新 → 切换班级后面板跟随 → 无 JS 报错
 * [响应式] 375px 按钮仅图标且在视口内，弹窗可用
 * [清场] 移除接口已下线，测试数据清场改用 mysql 直连（本地默认 root/root），
 *        并确保存在第三位教师 teacher0000002（王老师）用于 UI 输入匹配路径
 */
import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
const BASE = 'http://localhost:8080';
const API = BASE + '/api';
const errors = [];
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '（' + detail + '）' : '')); }
};
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { code: -999, msg: t.slice(0, 100) }; } };

async function login(u) {
  const r = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ username: u, password: '123456' })
  });
  const d = await j(r);
  if (d.code !== 0) throw new Error('登录失败(' + u + '): ' + d.msg);
  return d.data.token;
}

/* mysql 直连执行 SQL（密码仅本地默认 root/root；失败返回 null，调用方自行降级）。
 * 模板字符串里的换行 / Windows 的 \r 都会破坏 cmd 传参后的 SQL，统一压缩为单行空格 */
function sql(q) {
  try {
    const s = String(q).replace(/[\r\n]+/g, ' ');
    return execSync(`mysql -uroot -proot learning_agent -e ${JSON.stringify(s)}`, { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  } catch (e) { return null; }
}

(async () => {
  const tt = await login('teacher');       // 班级所有者（陈老师）
  const t2 = await login('teacher0000001'); // 第二教师（朱老师）
  const st = await login('student');
  const classes = await j(await fetch(API + '/teacher/classes', { headers: { Authorization: 'Bearer ' + tt } }));
  const cls = classes.data[0];
  const cls2 = classes.data[1];
  ok('班级列表加载', !!cls && !!cls2, cls.name + ' / ' + cls2.name);

  const H = (t) => ({ Authorization: 'Bearer ' + t, 'Content-Type': 'application/json;charset=utf-8' });

  // 清场：移除接口已下线，改用 SQL 直连清理两个测试班级的共同管理数据；
  // 同时确保存在第三位教师 teacher0000002（王老师，密码 123456，仅测试用）
  const cleaned = sql(`DELETE FROM class_co_teacher WHERE class_id IN (${cls.id},${cls2.id})`);
  if (cleaned === null) console.log('    （SQL 清场失败：本轮以现状数据自适应断言，建议确认本地 mysql root/root 可用）');
  const seeded = sql(`INSERT INTO user (username, password_hash, real_name, role, created_at, last_login_at)
    VALUES ('teacher0000002', '$2a$10$lRIP406sPNtpi3ZeEntMm.Eu0fp9ZCIESRYdsL8Hlay0O0CMjaMDu', '王老师', 'TEACHER', NOW(), NOW())
    ON DUPLICATE KEY UPDATE real_name = '王老师'`);
  if (seeded === null) console.log('    （SQL 写入测试教师失败：UI 完整账号匹配路径将按实际候选自适应）');

  /* ==================== API 层 ==================== */
  let p0 = await j(await fetch(API + '/teacher/co-teachers?classId=' + cls.id, { headers: H(tt) }));
  ok('[API] 面板数据（班级/所有者/可管理）', p0.code === 0 && p0.data.className === cls.name && p0.data.manageable === true,
    '「' + p0.data.className + '」所有者 ' + p0.data.owner);
  const zhu = (p0.data.candidates || []).find(c => c.username === 'teacher0000001');
  const wang = (p0.data.candidates || []).find(c => c.username === 'teacher0000002');
  ok('[API] 候选含其他教师、不含所有者', (!!zhu || !!wang) && !(p0.data.candidates || []).some(c => c.username === 'teacher'),
    '候选 ' + (p0.data.candidates || []).length + ' 人');

  const addTarget = zhu || wang; // 首选朱老师；本地无朱老师时退回王老师
  if (addTarget) {
    const a1 = await j(await fetch(API + '/teacher/co-teachers', {
      method: 'POST', headers: H(tt), body: JSON.stringify({ classId: cls.id, teacherId: addTarget.id })
    }));
    ok('[API] 添加共同管理教师', a1.code === 0 && a1.data.coTeachers.length >= 1
      && a1.data.coTeachers.some(t => t.username === addTarget.username), addTarget.realName);
    ok('[API] 添加后候选实时排除', !(a1.data.candidates || []).some(c => c.id === addTarget.id), '');

    const a2 = await j(await fetch(API + '/teacher/co-teachers', {
      method: 'POST', headers: H(tt), body: JSON.stringify({ classId: cls.id, teacherId: addTarget.id })
    }));
    ok('[API] 重复添加被拒绝', a2.code !== 0, a2.msg);
  } else {
    console.log('    （无候选教师，跳过添加路径 API 断言）');
  }
  const a3 = await j(await fetch(API + '/teacher/co-teachers', {
    method: 'POST', headers: H(tt), body: JSON.stringify({ classId: cls.id, teacherId: 1 })
  }));
  ok('[API] 添加所有者本人被拒绝', a3.code !== 0, a3.msg);
  const a4 = await j(await fetch(API + '/teacher/co-teachers', {
    method: 'POST', headers: H(tt), body: JSON.stringify({ classId: cls.id, teacherId: 99999 })
  }));
  ok('[API] 不存在的账号被拒绝', a4.code !== 0, a4.msg);
  const stu = await j(await fetch(API + '/teacher/students', { headers: H(tt) }));
  const a5 = await j(await fetch(API + '/teacher/co-teachers', {
    method: 'POST', headers: H(tt), body: JSON.stringify({ classId: cls.id, teacherId: stu.data[0].id })
  }));
  ok('[API] 学生账号被拒绝', a5.code !== 0, a5.msg);

  // 非所有者视角：只读面板
  const p2 = await j(await fetch(API + '/teacher/co-teachers?classId=' + cls.id, { headers: H(t2) }));
  ok('[API] 非所有者面板只读（manageable=false）', p2.code === 0 && p2.data.manageable === false, '');
  const a6 = await fetch(API + '/teacher/co-teachers', {
    method: 'POST', headers: H(t2), body: JSON.stringify({ classId: cls.id, teacherId: 71 })
  });
  ok('[API] 非所有者添加被拒绝', a6.status === 400 || (await j(a6)).code !== 0, 'HTTP ' + a6.status);

  // 共同管理生效：第二教师班级列表含该班 + 可查学情
  const c2 = await j(await fetch(API + '/teacher/classes', { headers: H(t2) }));
  ok('[API] 共同管理教师班级列表含该班级', c2.code === 0 && c2.data.some(c => String(c.id) === String(cls.id)),
    c2.data.map(c => c.name).join(' | '));
  ok('[API] 未授权班级不出现（仅授权班级）', !c2.data.some(c => String(c.id) === String(cls2.id)) || String(cls2.id) === String(cls.id), '');
  const d2 = await j(await fetch(API + '/teacher/dashboard?classId=' + cls.id, { headers: H(t2) }));
  ok('[API] 共同管理教师可查看该班学情', d2.code === 0 && d2.data.kpi != null, '人数=' + (d2.data.kpi && d2.data.kpi.studentCount));

  // 移除接口已随「纯展示列表」改版下线：DELETE 应无路由可用（404/405）
  const delRow = (p2.data.coTeachers || [])[0];
  if (delRow) {
    const rm = await fetch(API + '/teacher/co-teachers/' + delRow.id + '?classId=' + cls.id, { method: 'DELETE', headers: H(tt) });
    ok('[API] 移除接口已下线（无删除入口）', rm.status === 404 || rm.status === 405, 'HTTP ' + rm.status);
  }

  const s403 = await fetch(API + '/teacher/co-teachers?classId=' + cls.id, { headers: H(st) });
  ok('[API] 学生调用被拒（403）', s403.status === 403, 'HTTP ' + s403.status);

  /* ==================== UI 层 ==================== */
  let browser;
  for (const ch of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {}
  }
  if (!browser) throw new Error('无可用系统浏览器');
  process.on('exit', () => { try { browser.close(); } catch (e) {} });

  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push('http ' + r.status() + ': ' + r.url().slice(-70)); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', 'teacher');
  await page.fill('#lgPass', '123456');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.brand-sub', { timeout: 15000 });
  for (let i = 0; i < 25; i++) {
    const t = await page.textContent('.mh-title').catch(() => '');
    if (t && !t.includes('加载中')) break;
    await page.waitForTimeout(300);
  }

  // [1] 按钮位置：user-chip 右侧
  const btn = await page.$('.ot-chip[data-act="coTeacherModal"]');
  ok('顶栏「其他教师」按钮存在', !!btn, '');
  if (btn) {
    const chipBox = await btn.boundingBox();
    const userBox = await page.$eval('.user-chip', e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right }; });
    ok('按钮位于用户身份标识右侧', chipBox.x > userBox.r, 'user 右缘 ' + Math.round(userBox.r) + ' < 按钮 x ' + Math.round(chipBox.x));
  }

  // [2] 打开弹窗：绑定当前选中班级
  await page.click('.ot-chip');
  await page.waitForSelector('.modal', { timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('.modal .empty-title') || document.querySelector('.modal input[data-bind="coTeacherAccount"]'), { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(600);
  const brandCls = (await page.textContent('.brand-sub')).trim();
  const modalTitle = (await page.textContent('.modal .modal-head h3')).trim();
  ok('弹窗标题绑定当前选中班级', modalTitle.includes(brandCls), '「' + modalTitle + '」');
  const noteTxt = await page.textContent('.modal .note').catch(() => '');
  ok('面板显示班级与所有者', noteTxt.includes(brandCls) && noteTxt.includes('陈老师'), '');

  const inputSel = '.modal input[data-bind="coTeacherAccount"]';
  const addBtnSel = '.modal [data-act="doCoTeacherAdd"]';
  const cardText = () => page.$eval('#coTeacherMatchCard', e => e.textContent.trim()).catch(() => '');
  const addDisabled = () => page.$eval(addBtnSel, e => e.disabled).catch(() => true);

  // [3] 输入不完整账号 → 无匹配卡片、添加按钮禁用
  await page.fill(inputSel, 'teacher000');
  await page.waitForTimeout(200);
  ok('不完整账号：无匹配信息', (await cardText()) === '', '输入 teacher000');
  ok('不完整账号：添加按钮禁用', await addDisabled(), '');

  // [4] 输入不存在的账号 → 无匹配卡片、添加按钮禁用
  await page.fill(inputSel, 'teacher_not_exist_9');
  await page.waitForTimeout(200);
  ok('不存在账号：无匹配信息', (await cardText()) === '', '输入 teacher_not_exist_9');
  ok('不存在账号：添加按钮禁用', await addDisabled(), '');

  // [5] 输入已添加教师（addTarget）的完整账号 → 已被排除，无匹配、按钮禁用
  if (addTarget) {
    await page.fill(inputSel, addTarget.username);
    await page.waitForTimeout(200);
    ok('已添加教师账号：无匹配信息（已排除）', (await cardText()) === '', '输入 ' + addTarget.username);
    ok('已添加教师账号：添加按钮禁用', await addDisabled(), '');
  }

  // [6] 输入完整且有效的教师账号 → 实时匹配显示「X老师」信息卡片，添加可用
  //     （addTarget 已添加，此处用另一位候选教师：优先王老师，否则取候选列表首位）
  const pUi = await j(await fetch(API + '/teacher/co-teachers?classId=' + cls.id, { headers: H(tt) }));
  const uiTarget = (pUi.data.candidates || []).find(c => c.username === 'teacher0000002')
    || (pUi.data.candidates || []).find(c => c.username !== (addTarget && addTarget.username));
  if (uiTarget) {
    await page.fill(inputSel, uiTarget.username);
    await page.waitForTimeout(200);
    const cardTxt = await cardText();
    ok('完整有效账号：实时显示教师信息卡片', cardTxt.includes(uiTarget.realName + '老师') && cardTxt.includes(uiTarget.username), cardTxt.slice(0, 30));
    ok('完整有效账号：添加按钮可用', !(await addDisabled()), '');
    await page.click(addBtnSel);
    await page.waitForTimeout(1000);
    const tAdd = (await page.textContent('.toast:last-child').catch(() => '')).trim();
    ok('添加成功提示', tAdd.includes('已添加'), tAdd);
    const listTxt = await page.textContent('.modal .pick-list').catch(() => '');
    ok('列表实时更新（含新教师）', listTxt.includes(uiTarget.realName) && listTxt.includes(uiTarget.username), '');
    const cntLabel = (await page.$$eval('.modal .form-row label', els =>
      els.map(e => e.textContent.trim()).find(t => t.includes('已关联教师')) || '')).trim();
    ok('已关联计数更新', /\d+/.test(cntLabel) && parseInt(cntLabel.replace(/[^0-9]/g, ''), 10) >= (addTarget ? 2 : 1), cntLabel);
  } else {
    console.log('    （无第二位候选教师，跳过 UI 添加路径断言）');
  }

  // [7] 共同管理教师列表纯展示：无任何移除/删除操作入口
  const rmBtns = await page.$$('.modal [data-act="coTeacherRemove"]');
  const anyBtnsInList = await page.$$eval('.modal .pick-list .pick button', els => els.length).catch(() => 0);
  ok('列表无移除按钮（纯展示）', rmBtns.length === 0 && anyBtnsInList === 0,
    '移除按钮 ' + rmBtns.length + ' 个，列表内按钮 ' + anyBtnsInList + ' 个');

  // [8] 关闭重开 → 自动拉取最新数据
  await page.click('.modal [data-act="closeModal"]');
  await page.waitForTimeout(300);
  await page.click('.ot-chip');
  await page.waitForTimeout(800);
  const listTxt2 = await page.textContent('.modal .pick-list').catch(() => '');
  ok('重开自动拉取最新数据', !uiTarget || listTxt2.includes(uiTarget.realName), '');
  const rmBtns2 = await page.$$('.modal [data-act="coTeacherRemove"]');
  ok('重开后仍无移除按钮', rmBtns2.length === 0, '');
  await page.click('.modal [data-act="closeModal"]');
  await page.waitForTimeout(300);

  // [9] 切换班级 → 面板跟随新班级
  if (cls2) {
    await page.$$eval('[data-act="classPick"]', els => els[1].click());
    await page.waitForFunction(() => {
      const on = document.querySelector('[data-act="classPick"].on .li-title');
      return on && !document.querySelector('.skel');
    }, { timeout: 20000 });
    await page.waitForTimeout(600);
    const newBrand = (await page.textContent('.brand-sub')).trim();
    await page.click('.ot-chip');
    await page.waitForTimeout(800);
    const title2 = (await page.textContent('.modal .modal-head h3')).trim();
    ok('切换班级后面板跟随新班级', title2.includes(newBrand) && newBrand !== brandCls, '「' + title2 + '」');
    await page.click('.modal [data-act="closeModal"]');
    // 切回原班级（保持现场）
    await page.$$eval('[data-act="classPick"]', els => els[0].click());
    await page.waitForTimeout(800);
  }

  ok('无 JS 报错 / 无意外 4xx 5xx', errors.length === 0, errors.slice(0, 3).join(' ; '));

  /* ==================== 响应式 375px ==================== */
  const mp = await (await browser.newContext({ viewport: { width: 375, height: 700 } })).newPage();
  await mp.goto(BASE + '/login.html');
  await mp.fill('#lgUser', 'teacher');
  await mp.fill('#lgPass', '123456');
  await mp.click('button[type="submit"]');
  await mp.waitForSelector('.mh-title', { timeout: 15000 });
  await mp.waitForTimeout(800);
  const mBtn = await mp.$('.ot-chip');
  ok('[375px] 按钮可见', !!mBtn && await mBtn.isVisible(), '');
  if (mBtn) {
    const b = await mBtn.boundingBox();
    ok('[375px] 按钮在视口内', b.x >= 0 && b.x + b.width <= 375, JSON.stringify({ x: Math.round(b.x), w: Math.round(b.width) }));
    const txtHidden = await mp.$eval('.ot-chip .ot-txt', e => getComputedStyle(e).display === 'none');
    ok('[375px] 窄屏折叠文字仅留图标', txtHidden, '');
    await mBtn.click();
    await mp.waitForTimeout(800);
    const mb = await mp.$eval('.modal', e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right }; });
    ok('[375px] 弹窗在视口内', mb.l >= 0 && mb.r <= 375, JSON.stringify(mb));
    await mp.keyboard.press('Escape');
  }

  console.log('\n=== 其他教师（手动输入账号 + 纯展示列表）验证: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
