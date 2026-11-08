/* 云端 v1.16 UI 冒烟（只读：不点立即检测、不提交、不添加知识点，组卷不保存） */
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

  const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push('http ' + r.status() + ': ' + r.url().slice(-70)); });

  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', 'teacher');
  await page.fill('#lgPass', '123456');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.brand-sub', { timeout: 15000 });

  // [1] 预警中心：立即检测按钮 + 预警卡片
  await page.click('[data-act="section"][data-val="warnings"]');
  for (let i = 0; i < 25; i++) {
    const t = await page.textContent('.mh-title').catch(() => '');
    if (t && !t.includes('加载中')) break;
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(600);
  ok('[陈老师] 预警中心「立即检测」按钮存在', !!(await page.$('[data-act="warnScan"]')));
  const warnCards = await page.$$eval('.main-body .card', els => els.length).catch(() => 0);
  const badges = await page.$$eval('.main-body .badge', els => els.map(e => e.textContent.trim()));
  const highN = badges.filter(b => b.includes('高危')).length;
  ok('[陈老师] 预警列表有数据', warnCards > 0, warnCards + ' 张卡片，高危 ' + highN + ' 条');

  // [2] 发布新作业 → 题卡分层下拉
  await page.click('[data-act="section"][data-val="assignments"]');
  for (let i = 0; i < 25; i++) {
    const t = await page.textContent('.mh-title').catch(() => '');
    if (t && !t.includes('加载中')) break;
    await page.waitForTimeout(300);
  }
  await page.click('[data-act="openCompose"]');
  await page.waitForSelector('.compose-mask', { timeout: 10000 });
  await page.click('[data-act="composeAddQ"][data-val="SINGLE"]');
  await page.waitForSelector('#cpq-0', { timeout: 5000 });
  await page.click('#cpq-0 .cp-kp-add');
  await page.waitForSelector('.qkp-menu', { timeout: 5000 });
  const mods = await page.$$eval('.qkp-menu .ns-mod', els => els.map(e => e.querySelector('.pn').textContent.trim()));
  ok('[分层] 根层模块卡', mods.length >= 4, mods.slice(0, 3).join(' | ') + '…');
  await page.click('.qkp-menu .ns-mod');
  await page.waitForSelector('.qkp-menu .ns-back', { timeout: 5000 });
  const crumb = (await page.textContent('.qkp-menu .ns-crumbs')).trim();
  ok('[分层] 下钻面包屑', crumb.includes('›'), crumb.replace(/\s+/g, ' '));
  await page.click('.qkp-menu .ns-back');
  await page.waitForTimeout(300);
  ok('[分层] 返回上级', !!(await page.$('.qkp-menu .ns-mod')));
  await page.click('.cp-tb-label').catch(() => page.click('.compose-top'));
  await page.waitForTimeout(200);

  // [3] 导入作业页：AI 识别按钮存在（不点）
  await page.click('[data-act="openImport"]');
  await page.waitForSelector('#ciAiKp', { timeout: 5000 });
  ok('[导入] AI 识别知识点按钮存在', !!(await page.$('#ciAiKp')));
  // 关闭（不保存）
  await page.click('[data-act="importBack"]');
  await page.click('[data-act="closeCompose"]');
  await page.waitForTimeout(300);
  ok('组卷已关闭（未保存无数据污染）', !(await page.$('.compose-mask')));

  ok('[陈老师] 无 JS 报错 / 无意外 4xx 5xx', errors.length === 0, errors.slice(0, 3).join(' ; '));

  // [4] 朱老师预警中心（只读）
  const p2 = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  p2.on('pageerror', e => errors.push('zhu pageerror: ' + e.message));
  await p2.goto(BASE + '/login.html');
  await p2.fill('#lgUser', 'teacher0000001');
  await p2.fill('#lgPass', 'GZgs@1009');
  await p2.click('button[type="submit"]');
  await p2.waitForSelector('.mh-title', { timeout: 15000 });
  await p2.waitForTimeout(800);
  await p2.click('[data-act="section"][data-val="warnings"]');
  for (let i = 0; i < 25; i++) {
    const t = await p2.textContent('.mh-title').catch(() => '');
    if (t === '预警中心') break;
    await p2.waitForTimeout(300);
  }
  await p2.waitForTimeout(600);
  ok('[朱老师] 预警中心渲染 + 立即检测按钮', !!(await p2.$('[data-act="warnScan"]')));

  console.log('\n=== 云端 v1.16 UI 冒烟: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
