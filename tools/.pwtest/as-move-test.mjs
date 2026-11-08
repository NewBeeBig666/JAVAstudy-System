/* 作业移动到文件夹功能验证
 * [API] 合法移动 / 移回根目录 / 非法文件夹拒绝 / 学生 403
 * [UI] 右键菜单唤起 → 文件夹选择弹窗 → 跨文件夹移动 → 侧栏实时重分组
 * [边界] 同文件夹重复移动（友好提示不调接口）/ 网络异常（弹窗保留可重试）
 * [回归] 左键选中作业 / 文件夹展开收起 / 主区「更多」菜单不受影响
 * [响应式] 375px 视口右键菜单与弹窗正常
 */
import { chromium } from 'playwright-core';
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
  if (d.code !== 0) throw new Error('登录失败: ' + d.msg);
  return d.data.token;
}

(async () => {
  /* ==================== API 层 ==================== */
  const tt = await login('teacher');
  const st = await login('student');
  const asg = await j(await fetch(API + '/teacher/assignments', { headers: { Authorization: 'Bearer ' + tt } }));
  ok('作业列表加载', asg.code === 0 && asg.data.length >= 1, asg.data.length + ' 份');
  const target = asg.data[0];
  let folders = (await j(await fetch(API + '/teacher/folders', { headers: { Authorization: 'Bearer ' + tt } }))).data || [];
  if (!folders.length) {
    const cf = await j(await fetch(API + '/teacher/folders', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + tt, 'Content-Type': 'application/json;charset=utf-8' },
      body: JSON.stringify({ name: '移动测试文件夹' })
    }));
    folders = [cf.data];
  }
  const folder = folders[0];
  ok('测试文件夹就绪', !!folder, '「' + folder.name + '」id=' + folder.id);
  const origFolderId = target.folderId == null ? null : Number(target.folderId);

  const move = (id, fid, token) => fetch(API + '/teacher/assignments/' + id + '/folder', {
    method: 'PUT', headers: { 'Authorization': 'Bearer ' + (token || tt), 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ folderId: fid })
  });

  const m1 = await j(await move(target.id, folder.id));
  ok('[API] 移动到自建文件夹', m1.code === 0 && String(m1.data.folderId) === String(folder.id), 'folderId=' + m1.data.folderId);
  const m2 = await j(await move(target.id, null));
  ok('[API] 移回根目录（其他）', m2.code === 0 && m2.data.folderId == null, 'folderId=' + m2.data.folderId);
  const m3 = await j(await move(target.id, 999999));
  ok('[API] 非法文件夹 id 被拒绝', m3.code !== 0, m3.msg);
  const m4 = await move(target.id, folder.id, st);
  ok('[API] 学生调用被拒（403）', m4.status === 403, 'HTTP ' + m4.status);
  // 还原
  await move(target.id, origFolderId);

  /* ==================== UI 层 ==================== */
  let browser;
  for (const ch of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {}
  }
  if (!browser) throw new Error('无可用系统浏览器');
  process.on('exit', () => { try { browser.close(); } catch (e) {} });

  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  page.on('response', r => {
    if (r.status() >= 400 && !/favicon/.test(r.url()) && !/\/folder$/.test(r.url())) errors.push('http ' + r.status() + ': ' + r.url().slice(-70));
  });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', 'teacher');
  await page.fill('#lgPass', '123456');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.brand-sub', { timeout: 15000 });
  await page.click('[data-act="section"][data-val="assignments"]');
  for (let i = 0; i < 25; i++) {
    const t = await page.textContent('.mh-title').catch(() => '');
    if (t && !t.includes('加载中')) break;
    await page.waitForTimeout(300);
  }
  await page.waitForSelector('.as-folder-items .list-item', { timeout: 20000 });

  // 组装分组信息：作业 → 所在组 key（按 data-val 精确匹配，标题可能撞名）
  const groupOf = async (val) => page.evaluate(v => {
    const groups = document.querySelectorAll('.as-folder-items');
    for (const g of groups) {
      if (Array.from(g.querySelectorAll('.list-item')).some(e => e.dataset.val === v)) return g.id;
    }
    return null;
  }, val);
  const firstTitle = await page.$eval('.as-folder-items .list-item .li-title', e => e.textContent.trim());
  const firstVal = await page.$eval('.as-folder-items .list-item', e => e.dataset.val);
  // 精确按 data-val 定位条目（标题前缀可能撞名，不可用 has-text）
  const firstItem = '.as-folder-items .list-item[data-val="' + firstVal + '"]';
  // 确保某分组展开（移动后条目落入的分组可能是收起状态）
  const ensureOpen = async (key) => {
    const hidden = await page.evaluate(k => {
      const el = document.getElementById('asFolderItems-' + k);
      return el ? el.style.display === 'none' : false;
    }, key);
    if (hidden) {
      await page.click('#asFolderRow-' + key);
      await page.waitForTimeout(200);
    }
  };
  const startGroup = await groupOf(firstVal);
  ok('初始分组定位', !!startGroup, '「' + firstTitle.slice(0, 16) + '」在 ' + startGroup);

  // [1] 右键菜单
  await page.click(firstItem, { button: 'right' });
  await page.waitForSelector('.as-menu', { timeout: 5000 });
  const menuTxt = await page.textContent('.as-menu');
  ok('右键弹出菜单含「移动到文件夹」', menuTxt.includes('移动到文件夹'), menuTxt.trim());
  // 点击外部关闭
  await page.click('.mh-title');
  await page.waitForTimeout(200);
  ok('点击菜单外自动收起', !(await page.$('.as-menu')));

  // [2] 菜单 → 移动弹窗
  await page.click(firstItem, { button: 'right' });
  await page.waitForSelector('.as-menu', { timeout: 5000 });
  await page.click('.as-menu [data-act="asMoveModal"]');
  await page.waitForSelector('.modal #asMoveList', { timeout: 5000 });
  const opts = await page.$$eval('.modal #asMoveList .pick', els => els.map(e => ({
    name: e.querySelector('.pn').textContent.trim(),
    cur: !!e.querySelector('.pd'),
    badge: e.querySelector('.badge').textContent.trim()
  })));
  ok('弹窗展示完整文件夹目录', opts.length >= 2 && opts.some(o => o.name.includes('其他（根目录）')) && opts.some(o => o.name === folder.name),
    opts.map(o => o.name + (o.cur ? '[当前]' : '')).join(' | '));
  ok('当前归属有标记', opts.filter(o => o.cur).length === 1, '「' + (opts.find(o => o.cur) || {}).name + '」');

  // [3] 跨文件夹移动：选目标文件夹 → 移动 → 侧栏实时重分组
  const targetKey = 'asFolderItems-' + folder.id;
  await page.click('.modal #asMoveList .pick:has-text("' + folder.name + '")');
  await page.waitForTimeout(200);
  const badge = await page.textContent('.modal #asMoveList .pick.on .badge');
  ok('选择目标后标记「目标」', badge.trim() === '目标', badge.trim());
  // 记录移动前两组数量
  const cntBefore = await page.evaluate(k => document.getElementById(k) ? document.getElementById(k).querySelectorAll('.list-item').length : -1, targetKey);
  await page.click('.modal [data-act="doAsMove"]');
  await page.waitForTimeout(1000);
  const tMove = (await page.textContent('.toast:last-child').catch(() => '')).trim();
  ok('移动成功提示', tMove.includes('已将') && tMove.includes(folder.name), tMove);
  await ensureOpen(String(folder.id));
  const newGroup = await groupOf(firstVal);
  ok('侧栏实时重分组（条目移入目标文件夹）', newGroup === targetKey, startGroup + ' → ' + newGroup);
  const cntAfter = await page.evaluate(k => document.getElementById(k) ? document.getElementById(k).querySelectorAll('.list-item').length : -1, targetKey);
  ok('目标文件夹计数 +1', cntAfter === cntBefore + 1, cntBefore + ' → ' + cntAfter);
  ok('弹窗关闭', !(await page.$('.modal')));

  // [4] 同文件夹重复移动：友好提示，不调接口
  let apiCalled = false;
  const routeCatch = r => { apiCalled = true; r.continue(); };
  await page.route('**/api/teacher/assignments/*/folder', routeCatch);
  await page.click(firstItem, { button: 'right' });
  await page.waitForSelector('.as-menu', { timeout: 5000 });
  await page.click('.as-menu [data-act="asMoveModal"]');
  await page.waitForSelector('.modal #asMoveList', { timeout: 5000 });
  await page.click('.modal [data-act="doAsMove"]'); // 默认 target = 当前文件夹
  await page.waitForTimeout(500);
  const tSame = (await page.textContent('.toast:last-child').catch(() => '')).trim();
  ok('同文件夹重复移动友好提示', tSame.includes('无需移动'), tSame);
  ok('同文件夹不调接口', !apiCalled, apiCalled ? '意外调用' : '未发请求');
  await page.click('.modal [data-act="closeModal"]');
  await page.waitForTimeout(200);

  // [5] 网络异常：请求失败 → 弹窗保留 + 错误提示；恢复后重试成功
  await page.unroute('**/api/teacher/assignments/*/folder', routeCatch);
  await page.route('**/api/teacher/assignments/*/folder', r => r.abort());
  await page.click(firstItem, { button: 'right' });
  await page.waitForSelector('.as-menu', { timeout: 5000 });
  await page.click('.as-menu [data-act="asMoveModal"]');
  await page.waitForSelector('.modal #asMoveList', { timeout: 5000 });
  await page.click('.modal #asMoveList .pick[data-val=""]'); // 选「其他（根目录）」
  await page.waitForTimeout(200);
  await page.click('.modal [data-act="doAsMove"]');
  await page.waitForTimeout(800);
  const tErr = (await page.textContent('.toast:last-child').catch(() => '')).trim();
  ok('网络异常错误提示', tErr.includes('移动失败'), tErr);
  ok('失败后弹窗保留（可重试）', !!(await page.$('.modal #asMoveList')));
  await page.unroute('**/api/teacher/assignments/*/folder');
  await page.click('.modal [data-act="doAsMove"]');
  await page.waitForTimeout(1000);
  const tRetry = (await page.textContent('.toast:last-child').catch(() => '')).trim();
  ok('重试成功移回根目录', tRetry.includes('已将') && tRetry.includes('其他'), tRetry);
  await ensureOpen('other');
  const rootGroup = await groupOf(firstVal);
  ok('移回根目录后分组正确', rootGroup === 'asFolderItems-other', rootGroup);

  // [6] 回归：左键选中作业
  await page.click(firstItem, { button: 'left' });
  await page.waitForTimeout(400);
  const onCls = await page.$eval(firstItem, e => e.classList.contains('on')).catch(() => false);
  ok('左键选中作业正常', onCls, '');

  // [7] 回归：文件夹展开/收起
  const folderRow = '#asFolderRow-' + folder.id;
  const dispBefore = await page.$eval('#asFolderItems-' + folder.id, e => getComputedStyle(e).display);
  await page.click(folderRow);
  await page.waitForTimeout(200);
  const dispAfter = await page.$eval('#asFolderItems-' + folder.id, e => getComputedStyle(e).display);
  await page.click(folderRow); // 还原展开状态
  await page.waitForTimeout(100);
  ok('文件夹展开/收起正常', dispBefore !== dispAfter, dispBefore + ' → ' + dispAfter);

  // [8] 回归：主区作业卡片「更多」菜单
  const moreBtn = await page.$('[data-act="asMore"]');
  if (moreBtn) {
    await moreBtn.click();
    await page.waitForTimeout(300);
    ok('主区「更多」菜单正常', !!(await page.$('.as-menu')));
    await page.click('.mh-title');
  } else {
    console.log('    （当前视图无主区作业卡，跳过更多菜单回归）');
  }

  // [9] 数据还原：把作业移回原文件夹
  if (origFolderId != null) {
    await page.click(firstItem, { button: 'right' });
    await page.waitForSelector('.as-menu', { timeout: 5000 });
    await page.click('.as-menu [data-act="asMoveModal"]');
    await page.waitForSelector('.modal #asMoveList', { timeout: 5000 });
    await page.click('.modal #asMoveList .pick[data-val="' + origFolderId + '"]');
    await page.waitForTimeout(200);
    await page.click('.modal [data-act="doAsMove"]');
    await page.waitForTimeout(800);
    await ensureOpen(String(origFolderId));
    ok('还原原文件夹归属', (await groupOf(firstVal)) === ('asFolderItems-' + origFolderId), '');
  } else {
    console.log('    （原归属即「其他」，已由步骤5还原）');
  }

  ok('无 JS 报错 / 无意外 4xx 5xx', errors.length === 0, errors.slice(0, 3).join(' ; '));

  /* ==================== 响应式 375px ==================== */
  const mp = await (await browser.newContext({ viewport: { width: 375, height: 700 } })).newPage();
  await mp.goto(BASE + '/login.html');
  await mp.fill('#lgUser', 'teacher');
  await mp.fill('#lgPass', '123456');
  await mp.click('button[type="submit"]');
  // 小屏下 brand-sub 被响应式 CSS 隐藏；等渲染产物 .mh-title 出现（静态壳 #main 过早，
  // 登录跳转后导航可能尚未渲染，JS 派发点击会落空）
  await mp.waitForSelector('.mh-title', { timeout: 15000 });
  await mp.waitForTimeout(500);
  // 移动端导航在抽屉中隐藏，JS 派发点击进入作业管理（与真实点击同一事件委托链路）
  await mp.evaluate(() => {
    const el = document.querySelector('[data-act="section"][data-val="assignments"]');
    if (el) el.click();
  });
  for (let i = 0; i < 25; i++) {
    const t = await mp.textContent('.mh-title').catch(() => '');
    if (t === '作业管理') break;
    await mp.waitForTimeout(300);
  }
  // 移动端侧栏为抽屉，先点「功能面板」展开再操作
  await mp.click('[data-act="toggleSide"]');
  await mp.waitForTimeout(300);
  await mp.waitForSelector('.as-folder-items .list-item', { timeout: 20000 });
  await mp.click('.as-folder-items .list-item', { button: 'right' });
  await mp.waitForSelector('.as-menu', { timeout: 5000 });
  const menuBox = await mp.$eval('.as-menu', e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; });
  ok('[375px] 右键菜单在视口内', menuBox.l >= 0 && menuBox.r <= 375 && menuBox.t >= 0, JSON.stringify(menuBox));
  await mp.click('.as-menu [data-act="asMoveModal"]');
  await mp.waitForSelector('.modal #asMoveList', { timeout: 5000 });
  const modalBox = await mp.$eval('.modal', e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right }; });
  ok('[375px] 移动弹窗在视口内', modalBox.l >= 0 && modalBox.r <= 375, JSON.stringify(modalBox));
  await mp.keyboard.press('Escape');

  console.log('\n=== 作业移动到文件夹验证: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
