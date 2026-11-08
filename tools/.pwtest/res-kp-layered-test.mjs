/* 上传资源弹窗·分层知识点选择重构验证（Playwright）
 * 覆盖：分层结构（模块卡/下钻/面包屑/返回）、多级选择（整选+点选）、标签回显与移除、
 *      搜索、提交数据格式（kpCodes）、取消、学生端 newSession 回归、分辨率适配 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:8080';
const errors = [];
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '（' + detail + '）' : '')); }
};

async function login(page, user) {
  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', user);
  await page.fill('#lgPass', '123456');
  await page.click('#lgBtn');
  await page.waitForURL(/index/, { timeout: 15000 });
  await page.waitForSelector('.mh-title', { timeout: 20000 });
}
async function gotoSection(page, val, title) {
  for (let i = 0; i < 25; i++) {
    if (i === 0) await page.click(`.act-btn[data-act="section"][data-val="${val}"]`).catch(() => {});
    await page.waitForTimeout(400);
    const t = await page.locator('.mh-title').first().textContent().catch(() => '');
    if (t && t.indexOf(title) === 0) return;
    if (t && t.indexOf('加载中') === 0) continue;
    await page.click(`.act-btn[data-act="section"][data-val="${val}"]`).catch(() => {});
  }
  throw new Error('未能进入 ' + title);
}

(async () => {
  let browser;
  for (const ch of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {}
  }
  if (!browser) throw new Error('无可用系统浏览器');
  process.on('exit', () => { try { browser.close(); } catch (e) {} });

  const page = await (await browser.newContext({ viewport: { width: 1366, height: 850 } })).newPage();
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push('http ' + r.status() + ': ' + r.url().slice(-70)); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await login(page, 'teacher');
  await gotoSection(page, 'resources', '学习资源');
  console.log('[1] 教师登录并进入学习资源页');

  // [2] 打开上传弹窗：分层结构（模块卡）
  await page.click('button[data-act="resUploadModal"]');
  await page.waitForSelector('#nsPickArea .pick.ns-mod', { timeout: 8000 });
  const modCount = await page.locator('#nsPickArea .ns-mod').count();
  ok('根层为模块卡（一级）', modCount >= 5, 'x' + modCount);
  const searchBox = await page.locator('.modal input[data-bind="reskpq"]').count();
  ok('搜索框保留', searchBox === 1);

  // [3] 下钻：点击第一个模块卡 → 章节层 + 面包屑 + 返回按钮
  await page.locator('#nsPickArea .ns-mod').first().click();
  await page.waitForTimeout(400);
  const crumbs = await page.locator('#nsPickArea .ns-crumbs').count();
  const backBtn = await page.locator('#nsPickArea .ns-back').count();
  const rows = await page.locator('#nsPickArea .pick').count();
  ok('下钻到章节层（面包屑+返回按钮+子级行）', crumbs === 1 && backBtn === 1 && rows > 0, 'x' + rows + ' 行');

  // [4] 多级选择：二级下钻（nsDrill）→ 平铺子树 → 点叶子选中
  const drillRow = page.locator('#nsPickArea .pick.ns-row').first();
  if (await drillRow.count()) {
    await drillRow.click();
    await page.waitForTimeout(400);
  }
  const leaf = page.locator('#nsPickArea .pick').nth(1);
  await leaf.click();
  await page.waitForTimeout(300);
  const pills = await page.locator('#nsPickArea .ns-pill').count();
  const cntText = (await page.locator('#resKpCount').textContent()).trim();
  ok('叶子点选 → 已选标签回显 + 计数同步', pills >= 1 && /已选/.test(cntText), cntText);

  // [5] 模块整选：回根层，点模块「＋」
  await page.locator('#nsPickArea .ns-crumb').first().click(); // 面包屑回「全部知识点」
  await page.waitForTimeout(400);
  const before = await page.locator('#nsPickArea .ns-pill').count();
  await page.locator('#nsPickArea .ns-mod .ns-sel').nth(1).click();
  await page.waitForTimeout(300);
  const after = await page.locator('#nsPickArea .ns-pill').count();
  ok('模块「＋」整选（支持整组选择）', after > before, before + ' → ' + after + ' 个标签');

  // [6] 标签移除
  await page.locator('#nsPickArea .ns-pill').last().click();
  await page.waitForTimeout(300);
  const afterRemove = await page.locator('#nsPickArea .ns-pill').count();
  ok('已选标签点击移除', afterRemove === after - 1);

  // [7] 搜索：清空导航态输入关键词
  await page.fill('.modal input[data-bind="reskpq"]', '泛型');
  await page.waitForTimeout(600);
  const hits = await page.locator('#nsPickArea .pick').count();
  const groupTitle = await page.locator('#nsPickArea .ns-group-title').count();
  ok('搜索匹配（分组+层级路径）', hits >= 1, '命中 x' + hits + '（分组 x' + groupTitle + '）');
  await page.fill('.modal input[data-bind="reskpq"]', '');
  await page.waitForTimeout(400);

  // [8] 窄窗口分辨率适配（无横向溢出）
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => {
    const m = document.querySelector('.modal');
    return m ? m.scrollWidth - m.clientWidth : 99;
  });
  ok('窄窗口（900px）无横向溢出', overflow <= 2, 'overflow=' + overflow);
  await page.setViewportSize({ width: 1366, height: 850 });

  // [9] 提交：填标题 + 选文件（含已选知识点）→ 上传成功 → kpCodes 数据验证
  const fname = '分层选择E2E-' + Date.now();
  await page.fill('.modal input[data-key="title"]', fname);
  const picked = await page.locator('#nsPickArea .ns-pill').count();
  await page.setInputFiles('#resFileInput', path.join(__dirname, '..', 'lab-template.docx'));
  await page.waitForTimeout(300);
  await page.click('.modal button[data-act="doResUpload"]');
  await page.waitForSelector('.toast, .toast-box', { timeout: 30000 }).catch(() => null);
  await page.waitForTimeout(1500);
  // 验证资源已创建且知识点已关联（API）
  const token = (await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'teacher', password: '123456' })
  })).json()).data.token;
  const list = (await (await fetch(BASE + '/api/teacher/resources', { headers: { Authorization: 'Bearer ' + token } })).json()).data;
  const created = list.find(r => r.title === fname);
  ok('上传成功（资源已创建）', !!created, 'id=' + (created && created.id));
  ok('提交数据格式兼容（kpCodes 随已选提交）', created && (created.kpCodes || []).length >= Math.min(picked, 1),
    '已选 ' + picked + ' → 关联 ' + (created ? (created.kpCodes || []).length : 0) + ' 个');
  if (created) {
    await fetch(BASE + '/api/teacher/resources/' + created.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
    console.log('    （测试资源已清理）');
  }

  // [10] 取消操作：重新打开弹窗 → 选择后取消 → 无残留
  await page.click('button[data-act="resUploadModal"]');
  await page.waitForSelector('#nsPickArea .ns-mod', { timeout: 8000 });
  await page.locator('#nsPickArea .ns-mod .ns-sel').first().click();
  await page.waitForTimeout(200);
  await page.click('.modal button[data-act="closeModal"]');
  await page.waitForTimeout(400);
  const modalGone = await page.locator('.modal').count();
  ok('取消操作正常（弹窗关闭无残留）', modalGone === 0);

  // [11] 学生端 newSession 回归（原分层组件不受影响）：
  // 学生登录后默认停在 chat（会话视图，标题为会话名），直接点侧栏「新建会话」入口
  const sctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const spage = await sctx.newPage();
  spage.on('pageerror', e => errors.push('student pageerror: ' + e.message));
  await login(spage, 'student');
  await spage.waitForSelector('[data-act="newSession"]', { timeout: 15000 });
  await spage.locator('[data-act="newSession"]').first().click();
  await spage.waitForSelector('.modal #nsPickArea .ns-mod', { timeout: 8000 });
  const nsMods = await spage.locator('.modal #nsPickArea .ns-mod').count();
  ok('学生端新建会话分层组件回归正常', nsMods >= 5, 'x' + nsMods);
  await spage.click('.modal button[data-act="closeModal"]').catch(() => {});
  await sctx.close();

  ok('全程无 JS 报错/异常请求', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log('\n=== 分层知识点选择重构验证: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); if (errors.length) console.error(errors.join('\n')); process.exit(1); });
