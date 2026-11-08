/* 学习完成滚动判定 · 真实浏览器全场景测试（Playwright + 系统浏览器）
 * 覆盖：场景A 防绕过（jump到底不达标）、场景B 连续滚动达标+自动同步后端、
 *      小视口重复验证、控制台错误收集、API 复核 completed 状态
 * 用法: node tools/.pwtest/scroll-judge-test.mjs
 */
import { chromium } from 'playwright-core';

const BASE = 'http://localhost:8080';
const API = BASE + '/api';
const errors = [];
const ok = (name, cond, detail) => {
  if (!cond) throw new Error('[FAIL] ' + name + (detail ? ' :: ' + detail : ''));
  console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : ''));
};

async function apiLogin() {
  const r = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'student', password: '123456' })
  });
  return (await r.json()).data.token;
}

// 进入学习资源页（防时序竞态：boot 期间点击导航会被 loadRemote 完成后的 section 重置覆盖，
// 表现为点击后仍停留在学习会话页 → 卡片过滤 0 匹配超时。轮询验证页面标题确保真正进入）
async function gotoResources(page) {
  await page.waitForSelector('.mh-title', { timeout: 20000 }); // 等 boot 完成、主区渲染
  let lastTitle = '';
  for (let i = 0; i < 12; i++) {
    await page.click('.act-btn[data-act="section"][data-val="resources"]').catch(e => {
      console.log('    click#' + i + ' error: ' + e.message.split('\n')[0].slice(0, 80));
    });
    await page.waitForTimeout(500);
    lastTitle = await page.locator('.mh-title').first().textContent().catch(() => '');
    if (lastTitle && lastTitle.indexOf('学习资源') === 0) return;
    console.log('    click#' + i + ' → mh-title="' + lastTitle.trim().slice(0, 20) + '"');
  }
  await page.screenshot({ path: 'goto-fail.png', fullPage: true });
  const state = await page.evaluate(() => ({
    navBtns: Array.from(document.querySelectorAll('.act-btn[data-act="section"]')).map(b => b.dataset.val),
    modal: !!document.querySelector('.mask'),
    toast: (document.querySelector('.toast, .toast-box') || {}).textContent || ''
  })).catch(() => ({}));
  throw new Error('未能进入学习资源页 last="' + lastTitle + '" state=' + JSON.stringify(state));
}

async function openPreviewAndScroll(page, cardIdx, mode) {
  // 打开第 cardIdx 张未学完 word 卡片的预览；mode: 'jump' | 'smooth'
  // 限定 .main-body 排除骨架/右侧栏干扰；等待资源列表数据渲染完成
  await page.waitForSelector('.main-body .card h3', { timeout: 20000 });
  const cards = page.locator('.main-body .card', { hasText: '滚动判定测试资源' }).filter({
    has: page.locator('button[data-act="resView"]')
  }).filter({ hasNot: page.locator('.badge.ok:has-text("已学完")') });
  const cardTitle = await cards.nth(cardIdx).locator('h3').textContent();
  console.log('    打开卡片: ' + cardTitle.trim().slice(0, 40));
  await cards.nth(cardIdx).locator('button[data-act="resView"]').click();
  await page.waitForSelector('#resPrevScroll', { timeout: 15000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('resPrevScroll');
    return el && el.scrollHeight > 0;
  }, null, { timeout: 15000 });
  const el = await page.$('#resPrevScroll');
  if (mode === 'jump') {
    // 模拟拖动滚动条/End 键一次性跳到底：只触发一次 scroll 事件
    await page.evaluate(() => {
      const el = document.getElementById('resPrevScroll');
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(400);
  } else {
    // 模拟真实滚轮：分步连续滚动（每步 60% 视口高，间隔 100ms）
    await page.evaluate(async () => {
      const el = document.getElementById('resPrevScroll');
      const step = Math.max(1, Math.round(el.clientHeight * 0.6));
      let y = 0;
      while (el.scrollTop + el.clientHeight < el.scrollHeight - 2) {
        y += step;
        el.scrollTop = y;
        await new Promise(r => setTimeout(r, 100));
      }
      el.scrollTop = el.scrollHeight;
      await new Promise(r => setTimeout(r, 400));
    });
  }
  return el;
}

async function readProgress(page) {
  return page.evaluate(() => {
    const el = document.getElementById('resPrevScroll');
    const txt = document.getElementById('resLearnText');
    const bar = document.getElementById('resLearnBar');
    const doneBadge = document.querySelector('#resLearnBox .badge.ok');
    return {
      scrollHeight: el ? el.scrollHeight : 0,
      clientHeight: el ? el.clientHeight : 0,
      text: txt ? txt.textContent : '',
      barWidth: bar ? bar.style.width : '',
      done: !!doneBadge, doneText: doneBadge ? doneBadge.textContent.trim() : ''
    };
  });
}

(async () => {
  // 启动系统浏览器（优先 Edge，回退 Chrome）；finally 兜底关闭，防进程残留导致
  // 「失败后页面仍在后台继续执行交互」的幽灵重放问题
  let browser;
  for (const channel of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel, headless: true }); break; }
    catch (e) { console.log('  （' + channel + ' 不可用，尝试下一个）'); }
  }
  if (!browser) throw new Error('未找到可用的系统浏览器（Edge/Chrome）');
  console.log('[0] 浏览器启动 OK');
  process.on('exit', () => { try { browser.close(); } catch (e) {} });
  const finish = async code => { try { await browser.close(); } catch (e) {} process.exit(code); };

  const token = await apiLogin();
  console.log('[1] 学生 API 登录 OK（用于最终 completed 复核）');

  // ===== 场景 A + B：默认视口 1280x800 =====
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.on('response', r => {
      if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push('1280 http ' + r.status() + ': ' + r.url().slice(-80));
    });
    page.on('pageerror', e => errors.push('1280 pageerror: ' + e.message));
    await page.goto(BASE + '/login.html');
    await page.fill('#lgUser', 'student');
    await page.fill('#lgPass', '123456');
    await page.click('#lgBtn');
    await page.waitForURL(/index/, { timeout: 15000 });
    console.log('[2] UI 登录 OK（1280x800）');

    await gotoResources(page);
    await page.waitForSelector('.card', { timeout: 15000 });
    const headBefore = await page.locator('.main-head h2, h2').first().textContent().catch(() => '');
    console.log('    页头: ' + headBefore.trim());

    // ---- 场景 A：jump 到底，防绕过 ----
    console.log('[3] 场景A · 跳转到底部（应不达标）');
    await openPreviewAndScroll(page, 0, 'jump');
    const pa = await readProgress(page);
    ok('内容可滚动（scrollHeight > clientHeight）', pa.scrollHeight > pa.clientHeight,
      pa.scrollHeight + '>' + pa.clientHeight);
    ok('跳转后覆盖率 < 98%（无完成徽章）', !pa.done,
      '文案="' + pa.text + '" bar=' + pa.barWidth);
    await page.click('button[data-act="resPreviewClose"]');
    await page.waitForSelector('#resPrevScroll', { state: 'detached' });

    // ---- 场景 B：连续滚动，达标自动完成 ----
    console.log('[4] 场景B · 连续滚动到底（应自动完成并同步后端）');
    await openPreviewAndScroll(page, 0, 'smooth');
    await page.waitForSelector('#resLearnBox .badge.ok', { timeout: 8000 });
    const pb = await readProgress(page);
    ok('滚动达标出现完成徽章', pb.done, '"' + pb.doneText + '"');
    await page.click('button[data-act="resPreviewClose"]');
    await page.waitForTimeout(600);
    // 卡片状态与页头计数
    const cardBadge = await page.locator('.card', { hasText: '滚动判定测试资源' })
      .filter({ has: page.locator('.badge.ok:has-text("已学完，进度已记录")') }).count();
    ok('卡片显示「已学完，进度已记录」', cardBadge >= 1, 'x' + cardBadge);
    // toast（可能已消失，跳过 toast 断言，以徽章为准）

    // ---- API 复核：后端 completed 已实时同步 ----
    const list = (await (await fetch(API + '/resources', {
      headers: { 'Authorization': 'Bearer ' + token }
    })).json()).data;
    const doneWords = list.filter(r => r.fileType === 'word' && r.myProgress && r.myProgress.completed).length;
    ok('后端学习档案已记录（word 已学完 ≥1）', doneWords >= 1, 'x' + doneWords);
    await ctx.close();
  }

  // ===== 小视口 800x600：重复核心滚动判定 =====
  {
    const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await ctx.newPage();
    page.on('response', r => {
      if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push('800 http ' + r.status() + ': ' + r.url().slice(-80));
    });
    page.on('pageerror', e => errors.push('800 pageerror: ' + e.message));
    await page.goto(BASE + '/login.html');
    await page.fill('#lgUser', 'student');
    await page.fill('#lgPass', '123456');
    await page.click('#lgBtn');
    await page.waitForURL(/index/, { timeout: 15000 });
    await gotoResources(page);
    await page.waitForSelector('.card', { timeout: 15000 });
    console.log('[5] 小视口（800x600）重复滚动判定');
    // 场景B 已将第一张标记完成，此时剩余未完成资源为 nth(0)
    await openPreviewAndScroll(page, 0, 'smooth');
    await page.waitForSelector('#resLearnBox .badge.ok', { timeout: 8000 });
    ok('小视口下滚动达标同样自动完成', true);
    await page.click('button[data-act="resPreviewClose"]');
    await ctx.close();
  }

  await browser.close();
  ok('全程无 JS 报错', errors.length === 0, errors.length ? errors.join(' | ') : '');
  console.log('\n=== 滚动判定全场景测试通过 ===');
  process.exit(0);
})().catch(e => {
  console.error('\n=== FAILED ===');
  console.error(e.message);
  if (errors.length) console.error('console errors:', errors.join('\n'));
  process.exit(1);
});
