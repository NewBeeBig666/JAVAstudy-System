/* 作业管理侧栏文件夹「班级维度绑定 + 右键删除」功能验证
 * [API] folders?classId= 严格按班级过滤（无文件夹班级返回空）；创建绑定班级；
 *       不同班级可同名、同班级重名被拒；非所有者删除被拒；删除后其内作业移回「其他」；幂等
 * [UI] 班级 1（有文件夹）↔ 班级 2（无文件夹）切换：侧栏严格跟随当前班级，
 *       无文件夹班级仅显示内置「其他」；跨班新建文件夹互不可见；
 *       右键文件夹 → 删除（二次确认 → 取消保留 / 确认删除并即时刷新）；
 *       右键「其他」为只读提示；有作业的文件夹删除后作业移回「其他」；无 JS 报错
 * 说明：临时数据用 ASCII 命名避免 GBK 控制台 → mysql 的中文编码问题；测试前后 SQL 清场
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

function sql(q) {
  try {
    const s = String(q).replace(/[\r\n]+/g, ' ');
    return execSync(`mysql -uroot -proot learning_agent -e ${JSON.stringify(s)}`, { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  } catch (e) { return null; }
}
function one(q) {
  try {
    const s = String(q).replace(/[\r\n]+/g, ' ');
    const out = execSync(`mysql -uroot -proot -N -B learning_agent -e ${JSON.stringify(s)}`, { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
    const rows = out.split(/\r?\n/).filter(l => l.trim()).map(l => l.split('\t'));
    return rows && rows[0] ? rows[0][0] : null;
  } catch (e) { return null; }
}
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
  const tt = await login('teacher');        // 陈老师（拥有班级 1、2）
  const t2 = await login('teacher0000001'); // 朱老师（无权操作陈老师文件夹）
  const H = (t) => ({ Authorization: 'Bearer ' + t, 'Content-Type': 'application/json;charset=utf-8' });

  /* ---------- 清场 ---------- */
  sql(`DELETE FROM assignment WHERE title LIKE 'BindTest%'`);
  sql(`DELETE FROM assignment_folder WHERE name LIKE 'BindTest%'`);

  const cls = await j(await fetch(API + '/teacher/classes', { headers: H(tt) }));
  const c1 = cls.data.find(c => c.name.includes('2 班')) || cls.data[0]; // 班级 1（有存量文件夹）
  const c2 = cls.data.find(c => c.id !== c1.id);                          // 班级 2（无文件夹）
  ok('两个授课班级就绪', !!c1 && !!c2, c1.name + ' / ' + c2.name);

  /* ==================== API 层 ==================== */
  const f1 = await j(await fetch(API + '/teacher/folders?classId=' + c1.id, { headers: H(tt) }));
  const f2 = await j(await fetch(API + '/teacher/folders?classId=' + c2.id, { headers: H(tt) }));
  ok('[API] 班级维度过滤：有文件夹班级返回列表', (f1.data || []).length >= 1, f1.data.length + ' 个');
  ok('[API] 班级维度过滤：无文件夹班级返回空（不加载其他班级数据）', (f2.data || []).length === 0, '');

  const cr = await j(await fetch(API + '/teacher/folders', {
    method: 'POST', headers: H(tt), body: JSON.stringify({ name: 'BindTest-Folder', classId: c2.id })
  }));
  ok('[API] 创建文件夹绑定指定班级', cr.code === 0 && String(cr.data.classId) === String(c2.id), 'classId=' + cr.data.classId);
  const f2b = await j(await fetch(API + '/teacher/folders?classId=' + c2.id, { headers: H(tt) }));
  const f1b = await j(await fetch(API + '/teacher/folders?classId=' + c1.id, { headers: H(tt) }));
  ok('[API] 新文件夹仅出现在所属班级列表', f2b.data.some(f => f.name === 'BindTest-Folder')
    && !f1b.data.some(f => f.name === 'BindTest-Folder'), '');

  const cr2 = await j(await fetch(API + '/teacher/folders', {
    method: 'POST', headers: H(tt), body: JSON.stringify({ name: 'BindTest-Folder', classId: c1.id })
  }));
  ok('[API] 不同班级允许同名文件夹', cr2.code === 0, 'classId=' + c1.id);
  const dup = await j(await fetch(API + '/teacher/folders', {
    method: 'POST', headers: H(tt), body: JSON.stringify({ name: 'BindTest-Folder', classId: c2.id })
  }));
  ok('[API] 同班级重名被拒', dup.code !== 0, dup.msg);

  // 有作业的文件夹：删除后作业移回「其他」
  const asmFolder = cr2.data.id;
  sql(`INSERT INTO assignment (teacher_id, class_id, title, status, folder_id) VALUES (1, ${c1.id}, 'BindTest-Asm', 'ONGOING', ${asmFolder})`);
  const asmId = Number(one(`SELECT id FROM assignment WHERE title='BindTest-Asm'`));

  const noPerm = await fetch(API + '/teacher/folders/' + asmFolder, { method: 'DELETE', headers: H(t2) });
  const noPermJ = await j(noPerm);
  ok('[API] 非所有者删除被拒', noPermJ.code !== 0, noPermJ.msg);

  const del = await j(await fetch(API + '/teacher/folders/' + asmFolder, { method: 'DELETE', headers: H(tt) }));
  ok('[API] 所有者删除成功', del.code === 0, '');
  ok('[API] 其内作业移回「其他」（folder_id 置空、作业保留）',
    one(`SELECT folder_id FROM assignment WHERE id=${asmId}`) === 'NULL'
    && cnt('assignment', `id=${asmId}`) === 1, '');
  const del2 = await j(await fetch(API + '/teacher/folders/' + asmFolder, { method: 'DELETE', headers: H(tt) }));
  ok('[API] 幂等：重复删除返回成功', del2.code === 0, '');
  sql(`DELETE FROM assignment WHERE title LIKE 'BindTest%'`);
  // API 造数清场：移除班级 2 的 BindTest-Folder，保证 UI 段「班级 2 无文件夹」前提成立
  const f2c = await j(await fetch(API + '/teacher/folders?classId=' + c2.id, { headers: H(tt) }));
  const apiFolder = (f2c.data || []).find(f => f.name === 'BindTest-Folder');
  if (apiFolder) await fetch(API + '/teacher/folders/' + apiFolder.id, { method: 'DELETE', headers: H(tt) });

  /* ==================== UI 层 ==================== */
  let browser;
  for (const ch of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {}
  }
  if (!browser) throw new Error('无可用系统浏览器');
  process.on('exit', () => { try { browser.close(); } catch (e) {} });

  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push('http ' + r.status() + ': ' + r.url().slice(-70)); });

  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', 'teacher');
  await page.fill('#lgPass', '123456');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.brand-sub', { timeout: 15000 });
  await page.waitForTimeout(800);

  const gotoSection = async (name, title) => {
    await page.click(`[data-act="section"][data-val="${name}"]`);
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(300);
      const t = await page.textContent('.mh-title').catch(() => '');
      if (t && t.includes(title)) break;
    }
    await page.waitForTimeout(400);
  };
  const switchClass = async (id) => {
    await gotoSection('dashboard', '学情看板');
    await page.click(`#side .list-item[data-act="classPick"][data-val="${id}"]`);
    await page.waitForFunction((vid) => {
      const on = document.querySelector(`#side .list-item[data-act="classPick"][data-val="${vid}"].on`);
      return on && !document.querySelector('.skel');
    }, id, { timeout: 20000 });
    await page.waitForTimeout(500);
  };
  const folderRows = () => page.$$eval('.side .as-folder', els =>
    els.map(e => ({ name: e.querySelector('.asf-name').textContent, count: e.querySelector('.asf-count').textContent })));
  const toastTxt = () => page.textContent('.toast:last-child').catch(() => '');

  // [UI-1] 班级 1（有文件夹）：侧栏显示自建文件夹
  await gotoSection('assignments', '作业管理');
  let rows = await folderRows();
  ok('[UI] 有文件夹班级：侧栏显示「其他 + 自建文件夹」', rows.length >= 2,
    rows.map(r => r.name + '(' + r.count + ')').join(' | '));

  // [UI-2] 切换到班级 2（无文件夹）：侧栏文件夹区域仅剩内置「其他」——核心修复点
  await switchClass(c2.id);
  await gotoSection('assignments', '作业管理');
  rows = await folderRows();
  ok('[UI] 无文件夹班级：侧栏仅显示「其他」（不加载其他班级文件夹）', rows.length === 1 && rows[0].name === '其他',
    rows.map(r => r.name).join(' | '));

  // [UI-3] 班级 2 下新建文件夹 → 出现
  await page.click('button[data-act="asNewFolder"]');
  await page.waitForSelector('.modal input[data-key="name"]');
  await page.fill('.modal input[data-key="name"]', 'BindTest-UI');
  await page.click('.modal button[data-act="doAsFolderCreate"]');
  await page.waitForTimeout(900);
  rows = await folderRows();
  ok('[UI] 新建文件夹出现在当前班级侧栏', rows.some(r => r.name === 'BindTest-UI'), '');

  // [UI-4] 切回班级 1：新文件夹互不可见（严格班级隔离）
  await switchClass(c1.id);
  await gotoSection('assignments', '作业管理');
  rows = await folderRows();
  ok('[UI] 切回班级 1：班级 2 的文件夹不显示', rows.length >= 2 && !rows.some(r => r.name === 'BindTest-UI'),
    rows.map(r => r.name).join(' | '));

  // [UI-5] 班级 1 新建有作业的文件夹（API + SQL 造数）→ 右键删除：取消保留
  const cr3 = await j(await fetch(API + '/teacher/folders', {
    method: 'POST', headers: H(tt), body: JSON.stringify({ name: 'BindTest-UIDel', classId: c1.id })
  }));
  const uiFolder = cr3.data.id;
  sql(`INSERT INTO assignment (teacher_id, class_id, title, status, folder_id) VALUES (1, ${c1.id}, 'BindTest-Asm2', 'ONGOING', ${uiFolder})`);
  await page.reload();
  await page.waitForSelector('.brand-sub', { timeout: 15000 });
  await page.waitForTimeout(1000);
  await gotoSection('assignments', '作业管理');
  const folderRow = `#asFolderRow-${uiFolder}`;
  ok('[UI] 新文件夹行就绪（含 1 份作业）', !!(await page.$(folderRow))
    && (await page.$eval(folderRow, e => e.querySelector('.asf-count').textContent)) === '1', '');

  await page.click(folderRow, { button: 'right' });
  await page.waitForSelector('.as-menu', { timeout: 5000 });
  let menuHtml = await page.$eval('.as-menu', e => e.innerHTML);
  ok('[UI] 右键文件夹弹出「删除文件夹」菜单', menuHtml.includes('asFolderDelModal') && menuHtml.includes('删除文件夹'), '');
  await page.click('.as-menu [data-act="asFolderDelModal"]');
  await page.waitForSelector('.modal', { timeout: 5000 });
  const modalTxt = (await page.textContent('.modal .modal-body')).trim();
  ok('[UI] 二次确认弹窗提示作业将移回「其他」', modalTxt.includes('移回') && modalTxt.includes('1') , '');
  await page.click('.modal [data-act="closeModal"]');
  await page.waitForTimeout(400);
  ok('[UI] 取消删除：文件夹保留', !!(await page.$(folderRow)) && cnt('assignment_folder', `id=${uiFolder}`) === 1, '');

  // [UI-6] 确认删除：文件夹移除、作业移回「其他」、侧栏即时刷新
  await page.click(folderRow, { button: 'right' });
  await page.waitForSelector('.as-menu', { timeout: 5000 });
  await page.click('.as-menu [data-act="asFolderDelModal"]');
  await page.waitForSelector('.modal', { timeout: 5000 });
  await page.click('.modal [data-act="doAsFolderDel"]');
  await page.waitForTimeout(1200);
  const tDel = (await toastTxt()).trim();
  ok('[UI] 删除成功提示（作业移回「其他」）', tDel.includes('已删除') && tDel.includes('其他'), tDel);
  ok('[UI] 删除后文件夹即时从侧栏移除', !(await page.$(folderRow)) && cnt('assignment_folder', `id=${uiFolder}`) === 0, '');
  const asm2 = Number(one(`SELECT id FROM assignment WHERE title='BindTest-Asm2'`));
  ok('[UI] 其内作业移回「其他」且保留', asm2 > 0
    && one(`SELECT folder_id FROM assignment WHERE id=${asm2}`) === 'NULL', '');

  // [UI-7] 右键内置「其他」分组：只读提示不可删
  await page.click('#asFolderRow-other', { button: 'right' });
  await page.waitForSelector('.as-menu', { timeout: 5000 });
  menuHtml = await page.$eval('.as-menu', e => e.innerHTML);
  ok('[UI] 右键「其他」为只读提示（不可删除）', menuHtml.includes('不可删除') && !menuHtml.includes('asFolderDelModal'), '');
  await page.mouse.click(400, 300);
  await page.waitForTimeout(200);

  // [UI-8] 班级 2 的 BindTest-Folder / BindTest-UI 清理（右键删除路径回归）
  await switchClass(c2.id);
  await gotoSection('assignments', '作业管理');
  for (const nm of ['BindTest-UI']) {
    const fid = one(`SELECT id FROM assignment_folder WHERE name='${nm}' AND class_id=${c2.id}`);
    if (!fid) continue;
    await page.click(`#asFolderRow-${fid}`, { button: 'right' });
    await page.waitForSelector('.as-menu', { timeout: 5000 });
    await page.click('.as-menu [data-act="asFolderDelModal"]');
    await page.waitForSelector('.modal', { timeout: 5000 });
    await page.click('.modal [data-act="doAsFolderDel"]');
    await page.waitForTimeout(1000);
    ok('[UI][清理] 右键删除「' + nm + '」成功', cnt('assignment_folder', `id=${fid}`) === 0, '');
  }

  ok('无 JS 报错 / 无意外 4xx 5xx', errors.length === 0, errors.slice(0, 3).join(' ; '));

  /* ---------- 清场 ---------- */
  sql(`DELETE FROM assignment WHERE title LIKE 'BindTest%'`);
  sql(`DELETE FROM assignment_folder WHERE name LIKE 'BindTest%'`);

  console.log('\n=== 文件夹（班级绑定 + 右键删除）验证: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
