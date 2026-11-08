/* 学情看板侧栏「授课班级」右键删除班级功能验证
 * [API] classes 返回 owned 标记；非所有者（共同管理教师）删除被拒且数据保留；学生 403；
 *       所有者删除成功；级联清理无残留（class_co_teacher/assignment/submission/warning/
 *       learning_resource/resource_progress 清空，学生 class_id 置空）；幂等（重复删除返回成功）
 * [UI] 右键菜单（所有者可删；共同管理教师只读提示）→ 二次确认弹窗文案 → 取消不删 →
 *      确认删除 toast + 列表即时移除 → 网络异常 toast 失败且列表保留 →
 *      删除当前选中班级自动切换 → 无 JS 报错
 * [联动] 所有者删除班级后，原共同管理教师刷新后班级列表不再显示该班级（不再有对应教师管理条目）
 * 说明：临时班级用 ASCII 命名避免 GBK 控制台 → mysql 的中文编码问题；测试前后均 SQL 清场
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

/* mysql 直连（本地默认 root/root）：执行 SQL / 查询单值。
 * 注意：模板字符串里的换行 / Windows 的 \r 都会破坏 cmd 传参后的 SQL，统一压缩为单行空格 */
function sql(q) {
  try {
    const s = String(q).replace(/[\r\n]+/g, ' ');
    return execSync(`mysql -uroot -proot learning_agent -e ${JSON.stringify(s)}`, { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  } catch (e) { return null; }
}
function sqlRows(q) {
  try {
    const s = String(q).replace(/[\r\n]+/g, ' ');
    const out = execSync(`mysql -uroot -proot -N -B learning_agent -e ${JSON.stringify(s)}`, { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
    return out.split(/\r?\n/).filter(l => l.trim()).map(l => l.split('\t'));
  } catch (e) { return null; }
}
const one = (q) => { const r = sqlRows(q); return r && r[0] ? r[0][0] : null; };
const cnt = (table, where) => Number(one(`SELECT COUNT(*) FROM ${table} WHERE ${where}`) || 0);

async function login(u) {
  const r = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ username: u, password: '123456' })
  });
  const d = await j(r);
  if (d.code !== 0) throw new Error('登录失败(' + u + '): ' + d.msg);
  return d.data.token;
}

(async () => {
  const tt = await login('teacher');        // 陈老师（班级所有者）
  const t2 = await login('teacher0000001'); // 朱老师（共同管理教师）
  const st = await login('student');
  const H = (t) => ({ Authorization: 'Bearer ' + t, 'Content-Type': 'application/json;charset=utf-8' });

  const zhuId = one(`SELECT id FROM user WHERE username='teacher0000001'`);

  /* ---------- 清场：移除历史遗留的测试班级 / 测试学生（关联数据一并清理） ---------- */
  sql(`DELETE ct FROM class_co_teacher ct JOIN class c ON c.id=ct.class_id WHERE c.name LIKE 'DelTest%'`);
  sql(`DELETE a FROM assignment a JOIN class c ON c.id=a.class_id WHERE c.name LIKE 'DelTest%'`);
  sql(`DELETE w FROM warning w JOIN class c ON c.id=w.class_id WHERE c.name LIKE 'DelTest%'`);
  sql(`DELETE r FROM learning_resource r JOIN class c ON c.id=r.class_id WHERE c.name LIKE 'DelTest%'`);
  sql(`UPDATE user u JOIN class c ON c.id=u.class_id SET u.class_id=NULL WHERE c.name LIKE 'DelTest%'`);
  sql(`DELETE FROM class WHERE name LIKE 'DelTest%'`);
  sql(`DELETE FROM user WHERE username LIKE 'delstu%'`);

  /* ---------- 造数：DelTest-A（API 级联验证）+ B/C/D（UI 场景） ---------- */
  for (const n of ['DelTest-A', 'DelTest-B', 'DelTest-C', 'DelTest-D']) {
    sql(`INSERT INTO class (name, grade, teacher_id) VALUES ('${n}', '2024', 1)`);
  }
  const clsA = Number(one(`SELECT id FROM class WHERE name='DelTest-A'`));
  const clsB = Number(one(`SELECT id FROM class WHERE name='DelTest-B'`));
  const clsC = Number(one(`SELECT id FROM class WHERE name='DelTest-C'`));
  const clsD = Number(one(`SELECT id FROM class WHERE name='DelTest-D'`));
  ok('临时班级就绪', !!clsA && !!clsB && !!clsC && !!clsD, 'A=' + clsA + ' B=' + clsB + ' C=' + clsC + ' D=' + clsD);

  // A 班挂全量关联数据：共同管理教师 + 学生 + 作业/提交 + 预警 + 学习资源/进度
  sql(`INSERT INTO class_co_teacher (class_id, teacher_id) VALUES (${clsA}, ${zhuId})`);
  sql(`INSERT INTO user (username, password_hash, real_name, role, student_no, class_id) VALUES ('delstu01', '$2a$10$lRIP406sPNtpi3ZeEntMm.Eu0fp9ZCIESRYdsL8Hlay0O0CMjaMDu', 'DelStu01', 'STUDENT', 'T0001', ${clsA})`);
  const stuId = Number(one(`SELECT id FROM user WHERE username='delstu01'`));
  sql(`INSERT INTO assignment (teacher_id, class_id, title, status) VALUES (1, ${clsA}, 'DelTest-Asm', 'ONGOING')`);
  const asmId = Number(one(`SELECT id FROM assignment WHERE title='DelTest-Asm'`));
  sql(`INSERT INTO submission (assignment_id, student_id, status) VALUES (${asmId}, ${stuId}, 'GRADED')`);
  sql(`INSERT INTO warning (class_id, student_id, level, type, description) VALUES (${clsA}, ${stuId}, 'MID', 'DelTest', 'DelTest warn')`);
  sql(`INSERT INTO learning_resource (class_id, teacher_id, title, file_name, file_path, file_type, file_size) VALUES (${clsA}, 1, 'DelTest-Res', 't.pdf', 'uploads/resource/t.pdf', 'pdf', 100)`);
  const resId = Number(one(`SELECT id FROM learning_resource WHERE title='DelTest-Res'`));
  sql(`INSERT INTO resource_progress (user_id, resource_id, view_count, completed) VALUES (${stuId}, ${resId}, 1, 1)`);
  // B/C/D 班：B 交给朱老师共同管理（前端只读右键 + 联动验证用）
  sql(`INSERT INTO class_co_teacher (class_id, teacher_id) VALUES (${clsB}, ${zhuId})`);
  if (cnt('class_co_teacher', `class_id IN (${clsA},${clsB}) AND teacher_id=${zhuId}`) !== 2
    || cnt('assignment', `title='DelTest-Asm'`) !== 1 || cnt('submission', `student_id=${stuId}`) !== 1) {
    throw new Error('测试造数失败（SQL 执行异常），中止后续断言');
  }

  /* ==================== API 层 ==================== */
  const cls1 = await j(await fetch(API + '/teacher/classes', { headers: H(tt) }));
  const aOwned = (cls1.data || []).find(c => String(c.id) === String(clsA));
  const cls2 = await j(await fetch(API + '/teacher/classes', { headers: H(t2) }));
  const aCoOwned = (cls2.data || []).find(c => String(c.id) === String(clsA));
  ok('[API] classes 返回 owned 标记（所有者=true / 共同管理教师=false）',
    aOwned && aOwned.owned === true && aCoOwned && aCoOwned.owned === false, '');

  const del1 = await fetch(API + '/teacher/classes/' + clsA, { method: 'DELETE', headers: H(t2) });
  const del1j = await j(del1);
  ok('[API] 共同管理教师删除被拒（双重权限校验）', del1j.code !== 0, del1j.msg);
  ok('[API] 被拒后班级数据保留', cnt('class', `id=${clsA}`) === 1, '');

  const del2 = await fetch(API + '/teacher/classes/' + clsA, { method: 'DELETE', headers: { Authorization: 'Bearer ' + st } });
  ok('[API] 学生调用被拒（403）', del2.status === 403, 'HTTP ' + del2.status);

  const del3 = await j(await fetch(API + '/teacher/classes/' + clsA, { method: 'DELETE', headers: H(tt) }));
  ok('[API] 所有者删除成功', del3.code === 0, '');

  ok('[API] 级联清理：班级/共同管理/作业/提交/预警/资源/进度全部清空',
    cnt('class', `id=${clsA}`) === 0
    && cnt('class_co_teacher', `class_id=${clsA}`) === 0
    && cnt('assignment', `class_id=${clsA}`) === 0
    && cnt('submission', `assignment_id=${asmId}`) === 0
    && cnt('warning', `class_id=${clsA}`) === 0
    && cnt('learning_resource', `class_id=${clsA}`) === 0
    && cnt('resource_progress', `resource_id=${resId}`) === 0,
    '各表计数均为 0');
  ok('[API] 学生账号保留但已移出班级（class_id 置空）',
    one(`SELECT class_id FROM user WHERE id=${stuId}`) === 'NULL', '');

  const del4 = await j(await fetch(API + '/teacher/classes/' + clsA, { method: 'DELETE', headers: H(tt) }));
  ok('[API] 幂等：重复删除已不存在的班级仍返回成功', del4.code === 0, '');

  const cls2b = await j(await fetch(API + '/teacher/classes', { headers: H(t2) }));
  ok('[API] 联动：共同管理教师班级列表不再含已删班级',
    !(cls2b.data || []).some(c => String(c.id) === String(clsA)), '');

  /* ==================== UI 层 ==================== */
  let browser;
  for (const ch of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {}
  }
  if (!browser) throw new Error('无可用系统浏览器');
  process.on('exit', () => { try { browser.close(); } catch (e) {} });

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push('http ' + r.status() + ': ' + r.url().slice(-70)); });

  async function teacherLogin(p, user) {
    await p.goto(BASE + '/login.html');
    await p.fill('#lgUser', user);
    await p.fill('#lgPass', '123456');
    await p.click('button[type="submit"]');
    await p.waitForSelector('.brand-sub', { timeout: 15000 });
    for (let i = 0; i < 25; i++) {
      const t = await p.textContent('.mh-title').catch(() => '');
      if (t && !t.includes('加载中')) break;
      await p.waitForTimeout(300);
    }
    await p.waitForTimeout(600);
  }
  const classItem = (id) => `#side .list-item[data-act="classPick"][data-val="${id}"]`;
  const toastTxt = () => page.textContent('.toast:last-child').catch(() => '');

  // [UI-1] 共同管理教师：右键非本人班级 → 只读提示，无可点的删除入口
  await teacherLogin(page, 'teacher0000001');
  await page.click(classItem(clsB), { button: 'right' });
  await page.waitForSelector('.as-menu', { timeout: 5000 });
  const menuHtml = await page.$eval('.as-menu', e => e.innerHTML);
  ok('[UI] 共同管理教师右键菜单为只读提示', menuHtml.includes('仅班级所有者') && !menuHtml.includes('classDelModal'), '');
  await page.mouse.click(400, 300); // 点击空白处关闭菜单
  await page.waitForTimeout(200);

  // [UI-2] 所有者：右键 → 菜单含可点的「删除班级」→ 确认弹窗文案 → 取消
  await teacherLogin(page, 'teacher');
  await page.click(classItem(clsB), { button: 'right' });
  await page.waitForSelector('.as-menu', { timeout: 5000 });
  const menuHtml2 = await page.$eval('.as-menu', e => e.innerHTML);
  ok('[UI] 所有者右键菜单含「删除班级」', menuHtml2.includes('classDelModal') && menuHtml2.includes('删除班级'), '');
  await page.click('.as-menu [data-act="classDelModal"]');
  await page.waitForSelector('.modal', { timeout: 5000 });
  const modalTxt = (await page.textContent('.modal .modal-body')).trim();
  ok('[UI] 二次确认弹窗明确告知清空关联权限与数据', modalTxt.includes('清空该班级的全部关联管理权限与数据关联关系'), '');
  await page.click('.modal [data-act="closeModal"]');
  await page.waitForTimeout(300);
  ok('[UI] 取消删除：班级项保留', !!(await page.$(classItem(clsB))) && cnt('class', `id=${clsB}`) === 1, '');

  // [UI-3] 确认删除：toast 成功 + 列表即时移除（非当前选中班级）
  await page.click(classItem(clsB), { button: 'right' });
  await page.waitForSelector('.as-menu', { timeout: 5000 });
  await page.click('.as-menu [data-act="classDelModal"]');
  await page.waitForSelector('.modal', { timeout: 5000 });
  await page.click('.modal [data-act="doClassDel"]');
  await page.waitForTimeout(1200);
  const tDel = (await toastTxt()).trim();
  ok('[UI] 删除成功提示', tDel.includes('已删除'), tDel);
  ok('[UI] 删除后班级项即时从列表移除', !(await page.$(classItem(clsB))), '');
  ok('[UI] 删除后其余班级仍在列表', !!(await page.$(classItem(clsC))) && !!(await page.$(classItem(clsD))), '');

  // [UI-4] 联动：共同管理教师刷新后侧栏不再显示已删班级（对应教师管理条目随之消失）
  const page2 = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  await teacherLogin(page2, 'teacher0000001');
  ok('[UI][联动] 共同管理教师刷新后不再显示已删班级', !(await page2.$(classItem(clsB))), '');
  await page2.close();

  // [UI-5] 网络异常：删除请求中断 → 失败提示 + 班级保留（数据不丢失）
  await page.route('**/api/teacher/classes/**', route => route.abort());
  await page.click(classItem(clsC), { button: 'right' });
  await page.waitForSelector('.as-menu', { timeout: 5000 });
  await page.click('.as-menu [data-act="classDelModal"]');
  await page.waitForSelector('.modal', { timeout: 5000 });
  await page.click('.modal [data-act="doClassDel"]');
  await page.waitForTimeout(1200);
  const tNet = (await toastTxt()).trim();
  ok('[UI] 网络异常：明确失败提示', tNet.includes('删除失败'), tNet);
  ok('[UI] 网络异常：班级项保留（原数据不变）', !!(await page.$(classItem(clsC))) && cnt('class', `id=${clsC}`) === 1, '');
  // 失败后确认弹窗保留（busy 解除，可取消或重试），先取消再走完整右键流程
  ok('[UI] 网络异常：确认弹窗保留可重试', !!(await page.$('.modal [data-act="doClassDel"]'))
    && !(await page.$eval('.modal [data-act="doClassDel"]', e => e.disabled)), '');
  await page.click('.modal [data-act="closeModal"]');
  await page.waitForTimeout(300);
  await page.unroute('**/api/teacher/classes/**');
  // 网络恢复后重试删除成功（顺带清理 C）
  await page.click(classItem(clsC), { button: 'right' });
  await page.waitForSelector('.as-menu', { timeout: 5000 });
  await page.click('.as-menu [data-act="classDelModal"]');
  await page.waitForSelector('.modal', { timeout: 5000 });
  await page.click('.modal [data-act="doClassDel"]');
  await page.waitForTimeout(1200);
  ok('[UI] 网络恢复后重试删除成功', !(await page.$(classItem(clsC))) && cnt('class', `id=${clsC}`) === 0, '');

  // [UI-6] 删除当前选中的班级：自动切换到剩余首个班级，页面状态正常
  await page.click(classItem(clsD)); // 左键切换到 D
  await page.waitForTimeout(2500);
  const onD = await page.$eval(classItem(clsD), e => e.classList.contains('on')).catch(() => false);
  ok('[UI] 已切换到待删班级（当前选中）', onD, '');
  await page.click(classItem(clsD), { button: 'right' });
  await page.waitForSelector('.as-menu', { timeout: 5000 });
  await page.click('.as-menu [data-act="classDelModal"]');
  await page.waitForSelector('.modal', { timeout: 5000 });
  await page.click('.modal [data-act="doClassDel"]');
  await page.waitForTimeout(2500);
  ok('[UI] 删除当前选中班级后班级项移除', !(await page.$(classItem(clsD))) && cnt('class', `id=${clsD}`) === 0, '');
  const firstId = (await page.$$eval('#side .list-item[data-act="classPick"]',
    els => els.length ? els[0].dataset.val : null));
  const onFirst = firstId != null
    ? await page.$eval(classItem(firstId), e => e.classList.contains('on')).catch(() => false)
    : false;
  ok('[UI] 删除当前班级后自动切换到首个剩余班级', onFirst, '切换到班级 ' + firstId);
  const brand = await page.textContent('.brand-sub').catch(() => '');
  ok('[UI] 顶栏班级标识同步为新班级', !!brand && brand.trim() !== '', brand.trim());

  ok('无 JS 报错 / 无意外 4xx 5xx', errors.length === 0, errors.slice(0, 3).join(' ; '));

  /* ---------- 清场：移除测试残留（delstu01 用户与 D 班共同管理行等） ---------- */
  sql(`DELETE FROM user WHERE username LIKE 'delstu%'`);

  console.log('\n=== 删除班级（右键菜单）验证: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
