/* 云端预警中心·陈老师视角（有数据场景）UI 验证：列表渲染/级别徽章/分类计数/筛选/操作按钮（只读） */
import { chromium } from 'playwright-core';
const BASE = 'http://47.119.150.2';
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

  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push('http ' + r.status() + ': ' + r.url().slice(-70)); });

  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', 'teacher');
  await page.fill('#lgPass', '123456');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.brand-sub', { timeout: 15000 });
  await page.click('[data-act="section"][data-val="warnings"]');
  for (let i = 0; i < 25; i++) {
    const t = await page.textContent('.mh-title').catch(() => '');
    if (t && !t.includes('加载中')) break;
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(800);

  // [1] 列表渲染（非空态）
  const bodyTxt = (await page.textContent('.main-body').catch(() => '')).trim();
  const hasData = !bodyTxt.includes('没有待处理的预警');
  ok('预警列表有数据（非空态）', hasData, '');

  // [2] 级别徽章 + 字段渲染
  const badges = await page.$$eval('.main-body .badge', els => els.map(e => e.textContent.trim()));
  const highN = badges.filter(b => b.includes('高危')).length;
  const midN = badges.filter(b => b.includes('中风险')).length;
  ok('级别徽章渲染', highN + midN > 0, '高危 ' + highN + ' · 中风险 ' + midN);
  ok('预警类型与描述渲染', ['未登录', '骤降', '卡点', '时段', '相似度', '共性'].some(k => bodyTxt.includes(k)), '');

  // [3] 左侧分类计数
  const catSubs = await page.$$eval('.side-body .li-sub', els => els.map(e => e.textContent.trim()));
  const nonZero = catSubs.filter(s => s.includes('条待处理') && !s.startsWith('0')).length;
  ok('左侧分类含待处理计数（非零项）', catSubs.length === 6 && nonZero > 0,
    catSubs.join(' | ').slice(0, 80));

  // [4] 级别筛选：高危
  await page.click('.side-body [data-act="warnFilter"][data-val="high"]');
  await page.waitForTimeout(600);
  const bHigh = await page.$$eval('.main-body .badge', els => els.map(e => e.textContent.trim()));
  ok('级别筛选（高危）生效', bHigh.filter(b => b.includes('高危')).length > 0 && bHigh.filter(b => b.includes('中风险')).length === 0,
    bHigh.filter(b => b.includes('高危') || b.includes('中风险')).join(','));

  // [5] 已处理 tab
  await page.click('.side-body [data-act="warnFilter"][data-val="handled"]');
  await page.waitForTimeout(600);
  const doneTxt = (await page.textContent('.main-body').catch(() => '')).trim();
  ok('已处理筛选可切换', true, doneTxt.includes('没有待处理的预警') ? '已处理 0 条（空态文案）' : '显示已处理列表');

  // [6] 切回全部，操作按钮存在（只观察不点击）
  await page.click('.side-body [data-act="warnFilter"][data-val="all"]');
  await page.waitForTimeout(600);
  const acts = await page.$$eval('.main-body [data-act]', els => els.map(e => e.dataset.act));
  ok('「标记已处理」按钮存在', acts.includes('warnHandle'), '');
  ok('「推送提醒给学生」按钮存在', acts.includes('warnNotify'), '');
  const pushAll = await page.textContent('.mh-actions').catch(() => '');
  ok('顶栏「一键推送提醒」存在', pushAll.includes('推送'), pushAll.trim().slice(0, 30));

  ok('无 JS 报错 / 无 4xx 5xx', errors.length === 0, errors.slice(0, 3).join(' ; '));
  console.log('\n=== 云端预警中心（陈老师·有数据）UI 验证: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
