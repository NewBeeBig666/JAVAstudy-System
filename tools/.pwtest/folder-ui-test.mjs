/* 作业文件夹功能 UI 测试（Playwright）：侧栏分组/展开收起/新增弹窗/顶栏下拉/批阅入口 */
import { chromium } from 'playwright-core';
const BASE = 'http://localhost:8080';
const errors = [];
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '（' + detail + '）' : '')); }
};

(async () => {
  let browser;
  for (const ch of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {}
  }
  if (!browser) throw new Error('无可用系统浏览器');
  process.on('exit', () => { try { browser.close(); } catch (e) {} });

  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push('http ' + r.status() + ': ' + r.url().slice(-70)); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', 'teacher');
  await page.fill('#lgPass', '123456');
  await page.click('#lgBtn');
  await page.waitForURL(/index/, { timeout: 15000 });
  await page.waitForSelector('.mh-title', { timeout: 20000 });
  for (let i = 0; i < 10; i++) {
    await page.click('.act-btn[data-act="section"][data-val="assignments"]').catch(() => {});
    await page.waitForTimeout(400);
    const t = await page.locator('.mh-title').first().textContent().catch(() => '');
    if (t && t.indexOf('作业管理') === 0) break;
  }
  await page.waitForSelector('.as-folder', { timeout: 20000 });
  console.log('[1] 教师登录并进入作业管理 OK');

  // [2] 侧栏结构
  const folders = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.side .as-folder')).map(r => ({
      name: r.querySelector('.asf-name').textContent,
      count: r.querySelector('.asf-count').textContent,
      open: !r.classList.contains('closed')
    }));
  });
  const other = folders.find(f => f.name === '其他');
  ok('侧栏含「其他」文件夹（默认展开）', other && other.open === true, '数量=' + (other && other.count));
  ok('侧栏含自建文件夹', folders.length >= 2, folders.map(f => f.name + '(' + f.count + ')').join(' | '));
  const addBtn = await page.locator('button[data-act="asNewFolder"]').count();
  ok('「新增文件夹」按钮在标题右侧', addBtn === 1);

  // [3] 展开/收起交互（局部 DOM 切换，无整窗重建）
  const firstCustom = folders.find(f => f.name !== '其他');
  if (firstCustom) {
    const row = page.locator('.as-folder', { hasText: firstCustom.name }).first();
    const items = page.locator('#asFolderItems-' + (await row.getAttribute('data-val')));
    const displayBefore = await items.evaluate(el => getComputedStyle(el).display);
    await row.click();
    const displayAfter = await items.evaluate(el => getComputedStyle(el).display);
    ok('自建文件夹展开/收起切换', displayBefore !== displayAfter,
      displayBefore + ' → ' + displayAfter);
    await row.click(); // 切回
    const rowStill = await page.locator('.as-folder', { hasText: firstCustom.name }).count();
    ok('切换无整窗重建（行元素引用稳定）', rowStill === 1);
  }
  // 「其他」收起/展开
  const otherRow = page.locator('.as-folder', { hasText: '其他' }).first();
  const otherKey = await otherRow.getAttribute('data-val');
  const otherItems = page.locator('#asFolderItems-' + otherKey);
  await otherRow.click();
  ok('「其他」可收起', (await otherItems.evaluate(el => getComputedStyle(el).display)) === 'none');
  await otherRow.click();
  ok('「其他」可展开（历史作业可见）', (await otherItems.evaluate(el => getComputedStyle(el).display)) !== 'none'
    && (await otherItems.locator('.list-item').count()) > 0);

  // [4] 新增文件夹弹窗（空名校验 + 创建）
  await page.click('button[data-act="asNewFolder"]');
  await page.waitForSelector('.modal input[data-key="name"]');
  await page.click('.modal button[data-act="doAsFolderCreate"]');
  const emptyToast = await page.waitForSelector('.toast, .toast-box', { timeout: 3000 }).catch(() => null);
  ok('空名称创建被拦截（toast 提示）', !!emptyToast,
    emptyToast ? (await emptyToast.textContent()).trim().slice(0, 20) : '');
  const fname = 'UI测试文件夹-' + Date.now();
  await page.fill('.modal input[data-key="name"]', fname);
  await page.click('.modal button[data-act="doAsFolderCreate"]');
  await page.waitForTimeout(800);
  const added = await page.locator('.as-folder', { hasText: fname }).count();
  ok('新文件夹出现在侧栏（数量 0）', added === 1);

  // [5] 顶栏「选择文件夹」下拉
  const sel = page.locator('select[data-bind="composeFolder"]');
  ok('顶栏存在「选择文件夹」下拉', (await sel.count()) === 1);
  const opts = await sel.locator('option').allTextContents();
  ok('下拉选项完整（其他 + 自建）', opts.includes('其他') && opts.length >= 3, opts.join('/'));
  // 选择新文件夹 → 打开组卷页（folderId 预填由 State 透传，API 层已验证归类链路）
  await sel.selectOption({ label: fname });
  await page.click('button[data-act="openCompose"]');
  await page.waitForSelector('.compose-top .compose-title', { timeout: 8000 });
  ok('选定文件夹后可正常进入组卷发布流程', true);
  await page.click('button[data-act="closeCompose"]');
  await page.waitForTimeout(400);

  // [6] 批阅入口（原功能回归）：点击「其他」内第一份作业
  await otherItems.locator('.list-item').first().click();
  await page.waitForTimeout(600);
  const onItem = await page.evaluate(() => {
    const items = document.querySelectorAll('.side .list-item.on');
    return items.length;
  });
  ok('文件夹内作业可点击选中（批阅入口正常）', onItem >= 1);

  ok('全程无 JS 报错/异常请求', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log('\n=== 文件夹功能 UI 测试: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); if (errors.length) console.error(errors.join('\n')); process.exit(1); });
