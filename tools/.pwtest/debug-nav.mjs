import { chromium } from 'playwright-core';
let b;
for (const ch of ['msedge', 'chrome']) { try { b = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {} }
const p = await (await b.newContext({ viewport: { width: 1366, height: 850 } })).newPage();
p.on('pageerror', e => console.log('pageerror:', e.message));
p.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) console.log('http', r.status(), r.url().slice(-60)); });
await p.goto('http://localhost:8080/login.html');
await p.fill('#lgUser', 'teacher');
await p.fill('#lgPass', '123456');
await p.click('#lgBtn');
await p.waitForURL(/index/, { timeout: 15000 });
await p.waitForSelector('.mh-title', { timeout: 20000 });
for (let i = 0; i < 10; i++) {
  await p.click('.act-btn[data-act="section"][data-val="knowledge"]').catch(e => console.log('click#' + i, 'ERR', e.message.split('\n')[0].slice(0, 60)));
  await p.waitForTimeout(400);
  const t = await p.locator('.mh-title').first().textContent().catch(e => 'ERR:' + e.message.slice(0, 30));
  console.log('round#' + i, 'mh-title =', JSON.stringify(t.trim ? t.trim() : t));
  if (t && t.indexOf('知识图谱') === 0) { console.log('>>> ENTERED'); break; }
}
await b.close();
