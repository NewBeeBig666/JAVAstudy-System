/* 资源命名编辑功能验证（第二个按钮 → 功能菜单 → 改名/知识点编辑）
 * [API] 改名接口校验：空名/特殊字符/超长拒绝，合法名通过，学生 403
 * [UI] 菜单弹出 → 两选项；改名弹窗回显/校验/保存/取消；卡片实时更新；刷新后持久
 * [UI] 原编辑关联知识点功能回归（菜单入口进入，分层组件正常）
 * [UI] 多资源条目互不干扰
 * 全程无 JS 报错 / 无 4xx 5xx（接口负例校验除外）
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
  const list = await j(await fetch(API + '/teacher/resources', { headers: { Authorization: 'Bearer ' + tt } }));
  const res0 = list.data[0];
  const res1 = list.data[1];
  ok('初始资源列表 ≥ 2 条（多资源场景）', list.code === 0 && list.data.length >= 2, list.data.length + ' 条');
  const origTitle0 = res0.title, origTitle1 = res1.title;

  const putTitle = async (id, title, token) => fetch(API + '/teacher/resources/' + id + '/title', {
    method: 'PUT', headers: { 'Authorization': 'Bearer ' + (token || tt), 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ title })
  });

  const e1 = await j(await putTitle(res0.id, '   '));
  ok('[API] 空名称被拒绝', e1.code !== 0, e1.msg);
  const e2 = await j(await putTitle(res0.id, '第3章<数组>'));
  ok('[API] 特殊字符被拒绝', e2.code !== 0, e2.msg);
  const e3 = await j(await putTitle(res0.id, 'a/b\\c|d:e*f?g"h'));
  ok('[API] 文件名类特殊字符被拒绝', e3.code !== 0, e3.msg);
  const e4 = await j(await putTitle(res0.id, 'x'.repeat(51)));
  ok('[API] 超 50 字被拒绝', e4.code !== 0, e4.msg);
  const s1 = await j(await putTitle(res0.id, 'API改名验证-第3章 数组与循环（2026）'));
  ok('[API] 合法名称（含中文括号空格）保存成功', s1.code === 0, '');
  const forbid = await putTitle(res0.id, 'x', st);
  ok('[API] 学生调用被拒（403）', forbid.status === 403, 'HTTP ' + forbid.status);
  // 还原
  await putTitle(res0.id, origTitle0);
  const back = await j(await fetch(API + '/teacher/resources', { headers: { Authorization: 'Bearer ' + tt } }));
  ok('[API] 还原原标题', back.data[0].title === origTitle0, back.data[0].title);

  /* ==================== UI 层 ==================== */
  let browser;
  for (const ch of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {}
  }
  if (!browser) throw new Error('无可用系统浏览器');
  process.on('exit', () => { try { browser.close(); } catch (e) {} });

  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  page.on('response', r => {
    if (r.status() >= 400 && !/favicon/.test(r.url()) && !/\/title$/.test(r.url())) errors.push('http ' + r.status() + ': ' + r.url().slice(-70));
  });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', 'teacher');
  await page.fill('#lgPass', '123456');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.brand-sub', { timeout: 15000 });
  await page.click('[data-act="section"][data-val="resources"]');
  for (let i = 0; i < 25; i++) {
    const t = await page.textContent('.mh-title').catch(() => '');
    if (t && !t.includes('加载中')) break;
    await page.waitForTimeout(300);
  }
  await page.waitForSelector('[data-act="resEditMenu"]', { timeout: 20000 });

  // [1] 第二个按钮 → 功能菜单
  const btns = await page.$$eval('.card', cards => cards.map(c =>
    Array.from(c.querySelectorAll('.card-head [data-act]')).map(b => b.getAttribute('data-act'))));
  ok('按钮组顺序：预览 / 编辑菜单 / 删除', btns[0][1] === 'resEditMenu' && btns[0][0] === 'resFile' && btns[0][2] === 'resDel', btns[0].join(' | '));
  await page.click('.card:first-child [data-act="resEditMenu"]');
  await page.waitForSelector('.modal .res-edit-menu', { timeout: 5000 });
  const menuOpts = await page.$$eval('.modal .res-edit-menu .btn', els => els.map(e => e.textContent.trim()));
  ok('功能菜单含两个选项', menuOpts.length === 2 && menuOpts[0].includes('编辑资源名称') && menuOpts[1].includes('编辑关联知识点'), menuOpts.join(' / '));

  // [2] 菜单 → 编辑关联知识点（原功能回归）
  await page.click('.modal .res-edit-menu [data-act="resEditKp"]');
  await page.waitForSelector('.modal #nsPickArea', { timeout: 5000 });
  const kpMods = await page.$$eval('.modal #nsPickArea .ns-mod', els => els.length);
  ok('原知识点编辑功能正常（分层组件）', kpMods >= 3, kpMods + ' 个模块卡');
  const kpCount = (await page.textContent('.modal #resKpCount')).trim();
  ok('知识点回显正常', kpCount.includes('已选') || kpCount.includes('未选择'), '「' + kpCount + '」');
  await page.click('.modal [data-act="closeModal"]');
  await page.waitForTimeout(300);

  // [3] 菜单 → 编辑资源名称：回显
  await page.click('.card:first-child [data-act="resEditMenu"]');
  await page.waitForSelector('.modal .res-edit-menu', { timeout: 5000 });
  await page.click('.modal .res-edit-menu [data-act="resRenameModal"]');
  await page.waitForSelector('.modal input[data-key="name"]', { timeout: 5000 });
  const curVal = await page.inputValue('.modal input[data-key="name"]');
  ok('改名弹窗回显当前名称', curVal === origTitle0, '「' + curVal + '」');

  // [4] 校验：空名称
  await page.fill('.modal input[data-key="name"]', '   ');
  await page.click('.modal [data-act="doResRename"]');
  await page.waitForTimeout(400);
  const t1 = (await page.textContent('.toast:last-child').catch(() => '')).trim();
  ok('空名称校验拦截', t1.includes('不能为空') && !!(await page.$('.modal input[data-key="name"]')), t1);

  // [5] 校验：特殊字符
  await page.fill('.modal input[data-key="name"]', '测试<名称>');
  await page.click('.modal [data-act="doResRename"]');
  await page.waitForTimeout(400);
  const t2 = (await page.textContent('.toast:last-child').catch(() => '')).trim();
  ok('特殊字符校验拦截', t2.includes('特殊字符') && !!(await page.$('.modal input[data-key="name"]')), t2);

  // [6] 校验：超长（maxlength=50 拦截真实键入，此处程序化派发 51 字验证 JS 兜底）
  await page.evaluate(() => {
    const i = document.querySelector('.modal input[data-key="name"]');
    i.value = '长'.repeat(51);
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('.modal [data-act="doResRename"]');
  await page.waitForTimeout(400);
  const t3 = (await page.textContent('.toast:last-child').catch(() => '')).trim();
  ok('超长校验拦截', t3.includes('50') && !!(await page.$('.modal input[data-key="name"]')), t3);

  // [7] 取消：不保存
  await page.fill('.modal input[data-key="name"]', '取消测试名称');
  await page.click('.modal [data-act="closeModal"]');
  await page.waitForTimeout(400);
  const titleAfterCancel = await page.textContent('.card:first-child h3');
  ok('取消不改名', titleAfterCancel.trim() === origTitle0, '「' + titleAfterCancel.trim() + '」');

  // [8] 正常改名：保存 → 卡片实时更新
  const NEW = 'UI改名验证-第2章 流程控制（课堂课件）';
  await page.click('.card:first-child [data-act="resEditMenu"]');
  await page.waitForSelector('.modal .res-edit-menu', { timeout: 5000 });
  await page.click('.modal .res-edit-menu [data-act="resRenameModal"]');
  await page.waitForSelector('.modal input[data-key="name"]', { timeout: 5000 });
  await page.fill('.modal input[data-key="name"]', NEW);
  await page.click('.modal [data-act="doResRename"]');
  await page.waitForTimeout(1000);
  const t4 = (await page.textContent('.toast:last-child').catch(() => '')).trim();
  ok('保存成功提示', t4.includes('已更新'), t4);
  const newTitle = (await page.textContent('.card:first-child h3')).trim();
  ok('卡片实时更新新名称', newTitle === NEW, '「' + newTitle + '」');

  // [9] 刷新后持久
  await page.reload();
  await page.waitForSelector('.brand-sub', { timeout: 15000 });
  await page.click('[data-act="section"][data-val="resources"]');
  for (let i = 0; i < 25; i++) {
    const t = await page.textContent('.mh-title').catch(() => '');
    if (t && !t.includes('加载中')) break;
    await page.waitForTimeout(300);
  }
  await page.waitForSelector('.card h3', { timeout: 20000 });
  const persistTitle = (await page.textContent('.card:first-child h3')).trim();
  ok('刷新后名称持久化', persistTitle === NEW, '「' + persistTitle + '」');

  // [10] 多资源互不干扰：第二个资源菜单显示自己的标题，改名不影响第一个
  await page.click('.card:nth-child(2) [data-act="resEditMenu"]');
  await page.waitForSelector('.modal .res-edit-menu', { timeout: 5000 });
  const menuTitle = (await page.textContent('.modal .modal-head h3')).trim();
  ok('第二个资源菜单显示自身标题', menuTitle.includes(origTitle1.slice(0, 8)), '「' + menuTitle + '」');
  await page.click('.modal .res-edit-menu [data-act="resRenameModal"]');
  await page.waitForSelector('.modal input[data-key="name"]', { timeout: 5000 });
  const v2 = await page.inputValue('.modal input[data-key="name"]');
  ok('第二个资源改名弹窗回显自身名称', v2 === origTitle1, '「' + v2 + '」');
  await page.click('.modal [data-act="closeModal"]');
  await page.waitForTimeout(300);
  const stillNew = (await page.textContent('.card:first-child h3')).trim();
  ok('第一个资源名称不受干扰', stillNew === NEW, '「' + stillNew + '」');

  // 还原原标题
  await page.click('.card:first-child [data-act="resEditMenu"]');
  await page.waitForSelector('.modal .res-edit-menu', { timeout: 5000 });
  await page.click('.modal .res-edit-menu [data-act="resRenameModal"]');
  await page.waitForSelector('.modal input[data-key="name"]', { timeout: 5000 });
  await page.fill('.modal input[data-key="name"]', origTitle0);
  await page.click('.modal [data-act="doResRename"]');
  await page.waitForTimeout(800);
  const restored = (await page.textContent('.card:first-child h3')).trim();
  ok('还原原标题（数据无污染）', restored === origTitle0, '「' + restored + '」');

  ok('无 JS 报错 / 无意外 4xx 5xx', errors.length === 0, errors.slice(0, 3).join(' ; '));
  console.log('\n=== 资源命名编辑验证: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
