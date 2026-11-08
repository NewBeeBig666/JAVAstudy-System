/* 调试：打印学习资源页卡片列表与点击查看后的状态 */
import { chromium } from 'playwright-core';
const BASE = 'http://localhost:8080';

(async () => {
  let browser;
  for (const ch of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {}
  }
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  page.on('console', m => { if (m.type() === 'error') console.log('  [console.error]', m.text()); });
  page.on('response', r => { if (r.status() >= 400) console.log('  [http ' + r.status() + ']', r.url().slice(-70)); });

  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', 'student');
  await page.fill('#lgPass', '123456');
  await page.click('#lgBtn');
  await page.waitForURL(/index/, { timeout: 15000 });
  await page.click('.act-btn[data-act="section"][data-val="resources"]');
  await page.waitForSelector('.card', { timeout: 15000 });

  const infos = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.main-body .card')).map(c => {
      const h = c.querySelector('h3');
      const btn = c.querySelector('button[data-act="resView"]');
      const done = c.querySelector('.badge.ok');
      return { title: h ? h.textContent.trim() : '?', hasView: !!btn, doneText: done ? done.textContent.trim() : '' };
    });
  });
  console.log('卡片列表:');
  infos.forEach((c, i) => console.log('  #' + i, c.title.slice(0, 40), '| 查看:' + (c.hasView ? 'Y' : 'N'), '|' + c.doneText.slice(0, 20)));

  // 点击第一张有查看按钮的卡
  const target = page.locator('.main-body .card', { has: page.locator('button[data-act="resView"]') }).first();
  await target.locator('button[data-act="resView"]').click();
  await page.waitForTimeout(2500);
  const state = await page.evaluate(() => ({
    modalExists: !!document.querySelector('.mask'),
    scrollEl: !!document.getElementById('resPrevScroll'),
    learnBox: !!document.getElementById('resLearnBox'),
    learnText: (document.getElementById('resLearnText') || {}).textContent || ''
  }));
  console.log('点击查看后:', JSON.stringify(state));
  await page.screenshot({ path: 'debug-preview.png' });
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
