/* 排查：打印「滚动判定测试资源」卡片的完整 HTML 与各过滤条件的匹配情况 */
import { chromium } from 'playwright-core';
const BASE = 'http://localhost:8080';

(async () => {
  let browser;
  for (const ch of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {}
  }
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', 'student');
  await page.fill('#lgPass', '123456');
  await page.click('#lgBtn');
  await page.waitForURL(/index/, { timeout: 15000 });
  await page.click('.act-btn[data-act="section"][data-val="resources"]');
  await page.waitForSelector('.main-body .card h3', { timeout: 20000 });
  await page.waitForTimeout(2000);

  const info = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.main-body .card'));
    return {
      total: cards.length,
      matched: cards.filter(c => c.textContent.indexOf('滚动判定测试资源') >= 0).map(c => ({
        title: (c.querySelector('h3') || {}).textContent,
        hasViewBtn: !!c.querySelector('button[data-act="resView"]'),
        okBadges: Array.from(c.querySelectorAll('.badge.ok')).map(b => b.textContent.trim())
      }))
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
