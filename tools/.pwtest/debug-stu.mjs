import { chromium } from 'playwright-core';
let b;
for (const ch of ['msedge', 'chrome']) { try { b = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {} }
const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
p.on('pageerror', e => console.log('pageerror:', e.message));
await p.goto('http://localhost:8080/login.html');
await p.fill('#lgUser', 'student');
await p.fill('#lgPass', '123456');
await p.click('#lgBtn');
await p.waitForURL(/index/, { timeout: 15000 });
for (let i = 0; i < 8; i++) {
  await p.waitForTimeout(800);
  const t = await p.locator('.mh-title').first().textContent().catch(e => 'ERR');
  console.log('t+' + (i + 1) * 800 + 'ms:', JSON.stringify((t || '').trim ? (t || '').trim() : t));
}
await b.close();
