/* Word/PDF 版面还原跨浏览器验证：msedge + chrome 双内核渲染一致性 */
import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const BASE = 'http://localhost:8080';
const API = BASE + '/api';
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures') + path.sep;
const MARK = 'XBRPDF';
const j = async (r) => (await r.json());

async function run(channel) {
  let pass = 0, fail = 0;
  const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log('  ✓ [' + channel + '] ' + name + (detail ? '（' + detail + '）' : '')); }
    else { fail++; console.log('  ✗ [' + channel + '] ' + name + (detail ? '（' + detail + '）' : '')); }
  };
  const loginToken = async (u) => (await j(await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: '123456' })
  }))).data.token;
  const tt = await loginToken('teacher');

  // Word：真实 docx
  const list = await j(await fetch(API + '/teacher/resources?classId=1', { headers: { Authorization: 'Bearer ' + tt } }));
  const realDoc = (list.data || []).find(x => x.fileType === 'word' && (x.fileName || '').toLowerCase().endsWith('.docx'));
  // PDF：上传真实夹具（跨浏览器共用同一模型，验证渲染一致性）
  let pdfRes = null;
  {
    const fs = await import('node:fs');
    for (const r of (list.data || [])) {
      if ((r.title || '').includes(MARK)) {
        await fetch(API + '/teacher/resources/' + r.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + tt } });
      }
    }
    const buf = fs.readFileSync(FIX + 'test-doc.pdf');
    const fd = new FormData();
    fd.append('file', new Blob([buf]), 'test-doc.pdf');
    fd.append('title', MARK + '-跨浏览器');
    fd.append('classId', '1');
    const d = await j(await fetch(API + '/teacher/resources', {
      method: 'POST', headers: { Authorization: 'Bearer ' + tt }, body: fd
    }));
    if (d.code === 0) pdfRes = d.data;
  }

  let browser;
  try { browser = await chromium.launch({ channel, headless: true }); } catch (e) { return { pass, fail, skipped: true }; }
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', 'teacher');
  await page.fill('#lgPass', '123456');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.brand-sub', { timeout: 15000 });
  await page.click('[data-act="section"][data-val="resources"]');
  await page.waitForSelector(`[data-act="resFile"][data-id="${realDoc.id}"]`, { timeout: 8000 });

  if (realDoc) {
    await page.click(`[data-act="resFile"][data-id="${realDoc.id}"]`);
    await page.waitForSelector('.doc-page', { timeout: 15000 });
    const r = await page.evaluate(() => {
      const pg = document.querySelector('.doc-page');
      return {
        w: parseFloat(pg.style.width),
        blocks: pg.querySelectorAll('.doc-p,.doc-tbl').length,
        firstFs: (pg.querySelector('.doc-p') || {}).style ? (pg.querySelector('.doc-p span') || {}).style : {}
      };
    });
    ok('真实 docx 版面渲染', r.blocks > 3, '页面宽 ' + r.w + 'px · 块 ' + r.blocks);
    ok('页面几何一致（A4 595.3px）', Math.abs(r.w - 595.3) < 1, r.w + 'px');
    await page.click('.modal [data-act="resPreviewClose"]');
    await page.waitForTimeout(300);
  }

  if (pdfRes) {
    await page.click(`[data-act="resFile"][data-id="${pdfRes.id}"]`);
    await page.waitForSelector('.pdf-page-wrap', { timeout: 10000 });
    const r = await page.evaluate(() => {
      const wrap = document.querySelector('.pdf-page-wrap');
      const img = wrap.querySelector('.pdf-page-img');
      return {
        n: wrap.querySelectorAll('.pdf-page-img').length,
        w: parseFloat(img.style.width) || 0,
        h: parseFloat(img.style.height) || 0,
        loaded: img.complete && img.naturalWidth > 0,
        sw: document.getElementById('resPrevScroll').scrollWidth
      };
    });
    ok('PDF 版面逐页渲染', r.n === 1 && r.loaded, '页 ' + r.n + ' · 图片解码 ' + (r.loaded ? '完成' : '失败'));
    ok('PDF 几何一致（宽度封顶 850px 无横向溢出）', r.w === 850 && r.h === 1202 && r.sw <= wrapWidth(), r.w + '×' + r.h);
    ok('无 JS 报错', errors.length === 0, errors.slice(0, 2).join('|'));
    await page.click('.modal [data-act="resPreviewClose"]');
  } else {
    ok('PDF 夹具上传（跳过渲染断言）', false, '上传失败');
  }
  await browser.close();
  return { pass, fail };

  function wrapWidth() { return 1360; /* 视口宽，滚动区不得溢出 */ }
}

(async () => {
  let p = 0, f = 0;
  for (const c of ['msedge', 'chrome']) {
    console.log('\n== 内核：' + c + ' ==');
    const r = await run(c);
    p += r.pass; f += r.fail;
  }
  // 清理
  const tt = (await j(await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'teacher', password: '123456' })
  }))).data.token;
  const list = await j(await fetch(API + '/teacher/resources?classId=1', { headers: { Authorization: 'Bearer ' + tt } }));
  for (const r of (list.data || [])) {
    if ((r.title || '').includes(MARK)) {
      await fetch(API + '/teacher/resources/' + r.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + tt } });
    }
  }
  console.log('\n==== Word/PDF 跨浏览器：' + p + ' 通过 / ' + f + ' 失败 ====');
  process.exit(f ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
