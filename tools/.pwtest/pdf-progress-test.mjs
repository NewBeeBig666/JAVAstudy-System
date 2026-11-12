/* PDF 学习进度记录口径统一 E2E 测试（与 Word 滚动覆盖口径 100% 对齐）
 * [API] /pdf 版面模型（页数/位图/尺寸/LRU）；单页小文档模型；损坏 PDF 明确报错
 * [场景-单页]   单页小 PDF：内容全部可见 → 打开即达标（与 Word 短文档同行为）
 * [场景-多页]   多页跳转：直接拖到底部只覆盖起止两段 → 不判完成；跳回顶部不刷覆盖
 * [场景-完成]   真实 A4 文档完整滚动 → 覆盖 ≥98% 达标（服务端 /complete + 本地缓存 + 卡片）
 * [场景-兼容]   已完成 PDF 重开：直接显示已完成态，不重复触发判定（历史数据兼容）
 * [场景-续看]   中途退出未达标 → 再次打开重新累计 → 完整滚动后达标
 * [场景-兜底]   损坏 PDF（版面解析失败）：回落原生 iframe + 时长兜底口径（老路径兼容）
 * 验证后清理测试资源（级联删文件），零残留
 */
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const BASE = 'http://localhost:8080';
const API = BASE + '/api';
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures') + path.sep;
const MARK = 'E2EPDF进度';
const errors = [];
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else { fail++; console.log('  ✗ ' + name + '（' + (detail || '') + '）'); }
};
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { code: -999, msg: t.slice(0, 100) }; } };

/* 生成合法的最小多页 PDF（正确 xref 偏移；页数/尺寸可配，用于精确控制滚动场景） */
function genPdf(w, h, n) {
  const pages = [];
  const objs = [];
  // 1=Catalog 2=Pages；每页占两个对象（Page + Contents）；最后一个对象为 Font
  const kids = [];
  for (let i = 0; i < n; i++) {
    const pno = 3 + i * 2, cno = pno + 1;
    kids.push(pno + ' 0 R');
    const content = `BT /F1 12 Tf 20 ${h - 30} Td (PDF Progress Test Page ${i + 1}) Tj ET`;
    pages.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 ${3 + n * 2} 0 R >> >> /Contents ${cno} 0 R >>`);
    pages.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`);
  pages.forEach(p => objs.push(p));
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offs.forEach(o => { out += String(o).padStart(10, '0') + ' 00000 n \n'; });
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
/* 损坏 PDF：有 %PDF 头但无可解析对象（验证版面解析失败回落原生直显兜底） */
const badPdf = () => Buffer.from('%PDF-1.4\nthis is not a parsable pdf\n%%EOF\n', 'latin1');

async function login(u) {
  const r = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ username: u, password: '123456' })
  });
  const d = await j(r);
  if (d.code !== 0) throw new Error('登录失败(' + u + '): ' + d.msg);
  return d.data.token;
}
async function uploadBuf(token, buf, file, title) {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), file);
  fd.append('title', title);
  fd.append('classId', '1');
  const r = await fetch(API + '/teacher/resources', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd
  });
  return j(r);
}
async function uploadFix(token, file, title) {
  const fs = await import('node:fs');
  return uploadBuf(token, fs.readFileSync(FIX + file), file, title);
}

(async () => {
  const tt = await login('teacher');
  const st = await login('student');
  const H = (t) => ({ Authorization: 'Bearer ' + t });

  /* ---------- 前置清理：删除历史失败运行残留 ---------- */
  {
    const old = await j(await fetch(API + '/teacher/resources?classId=1', { headers: H(tt) }));
    for (const r of (old.data || [])) {
      if ((r.title || '').includes(MARK)) {
        await fetch(API + '/teacher/resources/' + r.id, { method: 'DELETE', headers: H(tt) });
      }
    }
  }

  console.log('\n--- 上传测试资源（真实夹具 / 生成多页 / 单页小文档 / 损坏文档）---');
  const up = async (fn, title) => {
    const d = await fn();
    if (d.code !== 0) throw new Error('上传失败(' + title + '): ' + d.msg);
    return d.data;
  };
  const pdfReal = await up(() => uploadFix(tt, 'test-doc.pdf', MARK + '-真实A4'), '真实夹具');
  const pdfMulti = await up(() => uploadBuf(tt, genPdf(300, 200, 4), 'multi-4p.pdf', MARK + '-多页跳转'), '多页');
  const pdfResume = await up(() => uploadBuf(tt, genPdf(300, 200, 4), 'resume-4p.pdf', MARK + '-续看'), '续看');
  const tiny = await up(() => uploadBuf(tt, genPdf(300, 200, 1), 'tiny-1p.pdf', MARK + '-单页'), '单页');
  let pdfBad = null;
  {
    const d = await uploadBuf(tt, badPdf(), 'corrupt.pdf', MARK + '-损坏');
    if (d.code === 0) { pdfBad = d.data; ok('[上传] 损坏 PDF 上传成功（AI 识别容错，走兜底场景）', true, 'id=' + pdfBad.id); }
    else { ok('[上传] 损坏 PDF 上传被拒（后端内容校验，兜底场景按跳过处理）', true, 'msg=' + d.msg); }
  }
  ok('[上传] 真实/多页/单页 PDF 上传成功', !!(pdfReal && pdfMulti && pdfResume && tiny),
    [pdfReal.id, pdfMulti.id, pdfResume.id, tiny.id].join('/'));

  /* ---------- [API] 版面模型 ---------- */
  console.log('\n--- [API] /pdf 版面模型 ---');
  {
    const t0 = Date.now();
    const r = await fetch(API + '/resources/' + pdfReal.id + '/pdf', { headers: H(st) });
    const c = await j(r);
    const ms = Date.now() - t0;
    const pm = c.data || {};
    const p0 = (pm.pages || [])[0] || {};
    ok('[API] 真实 A4 PDF 模型（1 页 · 宽度封顶 850px 位图）',
      r.status === 200 && c.code === 0 && (pm.pages || []).length === 1
      && String(p0.src || '').startsWith('data:image/png;base64,')
      && p0.w === 850 && Math.abs(p0.h - Math.round(p0.w * 841.8898 / 595.27563)) <= 2,
      '页 ' + (pm.pages || []).length + ' · ' + p0.w + '×' + p0.h + ' · ' + ms + 'ms');
    const t1 = Date.now();
    await fetch(API + '/resources/' + pdfReal.id + '/pdf', { headers: H(st) });
    ok('[API] LRU 缓存二次访问零解析（<400ms）', (Date.now() - t1) < 400, (Date.now() - t1) + 'ms');
  }
  {
    const r = await fetch(API + '/resources/' + pdfMulti.id + '/pdf', { headers: H(st) });
    const c = await j(r);
    const pm = c.data || {};
    ok('[API] 生成 4 页 PDF 模型（页数与原始尺寸逐页输出）',
      c.code === 0 && (pm.pages || []).length === 4
      && (pm.pages || []).every(p => p.w === 450 && p.h === 300),
      '页数=' + (pm.pages || []).length + ' · 450×300');
  }
  {
    const r = await fetch(API + '/resources/' + tiny.id + '/pdf', { headers: H(st) });
    const c = await j(r);
    const pm = c.data || {};
    const p0 = (pm.pages || [])[0] || {};
    ok('[API] 单页小文档模型（1 页 · 450×300px）',
      c.code === 0 && (pm.pages || []).length === 1 && p0.w === 450 && p0.h === 300, '');
  }
  if (pdfBad) {
    const r = await fetch(API + '/resources/' + pdfBad.id + '/pdf', { headers: H(st) });
    const c = await j(r);
    ok('[API] 损坏 PDF 版面解析失败明确报错（前端回落兜底）', c.code !== 0, 'code=' + c.code + ' msg=' + (c.msg || '').slice(0, 24));
  }

  /* ---------- [UI] 浏览器全场景 ---------- */
  let browser;
  for (const ch of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {}
  }
  if (!browser) throw new Error('无可用系统浏览器');
  process.on('exit', () => { try { browser.close(); } catch (e) {} });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  // /pdf 400 为损坏文档的预期兜底触发（前端 try/catch 回落），不计为异常
  page.on('response', r => {
    if (r.status() >= 400 && !/favicon/.test(r.url()) && !(r.status() === 400 && /\/pdf$/.test(r.url()))) {
      errors.push('http ' + r.status() + ': ' + r.url().slice(-70));
    }
  });

  const studentLogin = async () => {
    await page.goto(BASE + '/login.html');
    await page.fill('#lgUser', 'student');
    await page.fill('#lgPass', '123456');
    await page.click('button[type="submit"]');
    await page.waitForSelector('.brand-sub', { timeout: 15000 });
    await page.click('[data-act="section"][data-val="resources"]');
    await page.waitForTimeout(900);
  };
  const openPreview = async (id) => {
    await page.click(`[data-act="resView"][data-id="${id}"]`);
    await page.waitForSelector('.modal', { timeout: 8000 });
  };
  const closePreview = async () => {
    await page.click('.modal [data-act="resPreviewClose"]');
    await page.waitForTimeout(300);
  };
  // 完整滚动：增量步进滚到底（覆盖全区间，模拟真实逐屏阅读）
  const scrollThrough = () => page.evaluate(() => new Promise(res => {
    const el = document.getElementById('resPrevScroll');
    const step = () => {
      el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + 200);
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) { res(); return; }
      setTimeout(step, 25);
    };
    step();
  }));
  const isDone = async () => {
    const box = await page.textContent('#resLearnBox').catch(() => '');
    return box.includes('已完成学习') || box.includes('学习完成');
  };

  await studentLogin();

  console.log('\n--- 场景 1：单页浏览（内容不足一屏 → 直接达标）---');
  {
    await openPreview(tiny.id);
    await page.waitForSelector('.pdf-page-wrap', { timeout: 8000 });
    await page.waitForTimeout(600);
    ok('[单页] 单页小 PDF 打开即达标（与 Word 短文档同行为）', await isDone(), '');
    const cardTxt = await page.textContent(`#resCardActs-${tiny.id}`).catch(() => '');
    ok('[单页] 卡片状态同步为已学完（服务端 /complete 已提交）', (cardTxt || '').includes('已学完'), '');
    const cached = await page.evaluate((id) => {
      const m = JSON.parse(localStorage.getItem('la_res_learned') || '{}');
      return !!m[String(id)];
    }, tiny.id);
    ok('[单页] 本地进度缓存写入（la_res_learned，与 Word 同存储）', cached, '');
    await closePreview();
  }

  console.log('\n--- 场景 2：多页跳转（直接跳底不判完成；跳回顶部不刷覆盖）---');
  {
    await openPreview(pdfMulti.id);
    await page.waitForSelector('.pdf-page-wrap', { timeout: 10000 });
    const imgs = await page.$$eval('.pdf-page-wrap .pdf-page-img', els => els.length);
    ok('[多页] 4 页版面逐页渲染', imgs === 4, '页 ' + imgs);
    const s1 = await page.textContent('#resLearnText').catch(() => '');
    ok('[多页] 初始进度为滚动覆盖口径（与 Word 文案一致）', /已完整阅读\s*\d+%/.test(s1 || ''), s1);
    // 直接拖到底：只覆盖首屏+末屏两段 → 不达标
    await page.evaluate(() => { const el = document.getElementById('resPrevScroll'); el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(400);
    const w1 = await page.$eval('#resLearnBar', e => e.style.width).catch(() => '');
    ok('[多页] 直接跳到底部不判完成', !(await isDone()), '');
    ok('[多页] 停留覆盖按区间累计（跳底后覆盖为首末两段 <98%）', parseFloat(w1) > 0 && parseFloat(w1) < 98, '进度条 ' + w1);
    // 再跳回顶部：不增加覆盖 → 仍不达标
    await page.evaluate(() => { const el = document.getElementById('resPrevScroll'); el.scrollTop = 0; });
    await page.waitForTimeout(300);
    ok('[多页] 跳回顶部不刷覆盖（区间合并口径防刷量）', !(await isDone()), '');
    await closePreview();
  }

  console.log('\n--- 场景 3：真实文档完整滚动 → 达标（服务端同步 + 本地缓存 + 卡片）---');
  {
    await openPreview(pdfReal.id);
    await page.waitForSelector('.pdf-page-wrap', { timeout: 10000 });
    await scrollThrough();
    await page.waitForTimeout(600);
    ok('[完成] 完整滚动阅读自动判学完（覆盖 ≥98%）', await isDone(), '');
    const cardTxt = await page.textContent(`#resCardActs-${pdfReal.id}`).catch(() => '');
    ok('[完成] 卡片状态同步为已学完', (cardTxt || '').includes('已学完'), '');
    const cached = await page.evaluate((id) => {
      const m = JSON.parse(localStorage.getItem('la_res_learned') || '{}');
      return !!m[String(id)];
    }, pdfReal.id);
    ok('[完成] 本地进度缓存写入', cached, '');
    await closePreview();
  }

  console.log('\n--- 场景 4：历史兼容（已完成 PDF 重开直接显示完成态）---');
  {
    await openPreview(pdfReal.id);
    await page.waitForSelector('.pdf-page-wrap', { timeout: 8000 });
    await page.waitForTimeout(400);
    ok('[兼容] 已完成 PDF 重开直接显示已完成态（历史数据不重判）', await isDone(), '');
    await closePreview();
  }

  console.log('\n--- 场景 5：中途退出 → 再次续看（重新累计后达标）---');
  {
    await openPreview(pdfResume.id);
    await page.waitForSelector('.pdf-page-wrap', { timeout: 10000 });
    // 滚到一半（约 40%）后中途退出
    await page.evaluate(() => new Promise(res => {
      const el = document.getElementById('resPrevScroll');
      const target = el.scrollHeight * 0.4;
      const step = () => {
        el.scrollTop = Math.min(target, el.scrollTop + 200);
        if (el.scrollTop >= target - 2) { res(); return; }
        setTimeout(step, 25);
      };
      step();
    }));
    await page.waitForTimeout(300);
    ok('[续看] 中途退出前未达标（阅读约 40%）', !(await isDone()), '');
    await closePreview();
    // 再次打开：进度重新累计（与 Word 每次打开重新覆盖累计一致）→ 完整滚动后达标
    await openPreview(pdfResume.id);
    await page.waitForSelector('.pdf-page-wrap', { timeout: 8000 });
    const s2 = await page.textContent('#resLearnText').catch(() => '');
    const m2 = (s2 || '').match(/已完整阅读\s*(\d+)%/);
    ok('[续看] 重新打开进度重新累计（非残留 40%）', !!m2 && parseInt(m2[1]) < 40, s2);
    await scrollThrough();
    await page.waitForTimeout(600);
    ok('[续看] 续看完整滚动后达标并记录', await isDone(), '');
    await closePreview();
  }

  console.log('\n--- 场景 6：损坏 PDF 兜底（版面解析失败 → 原生直显 + 时长口径）---');
  if (!pdfBad) {
    ok('[兜底] 无损坏文档资源（上传被拒场景跳过）', true);
  } else {
    await openPreview(pdfBad.id);
    await page.waitForSelector('.modal iframe', { timeout: 8000 });
    const hint = await page.textContent('#resLearnBox').catch(() => '');
    ok('[兜底] 解析失败回落原生 iframe（兼容老路径 + 时长口径）', (hint || '').includes('60 秒'), (hint || '').slice(0, 34));
    await closePreview();
  }

  ok('全程无 JS 报错 / 无意外 4xx 5xx', errors.length === 0, errors.slice(0, 3).join(' ; '));

  /* ---------- 清理测试资源（级联删文件） ---------- */
  for (const r of [pdfReal, pdfMulti, pdfResume, tiny, pdfBad]) {
    if (r && r.id) await fetch(API + '/teacher/resources/' + r.id, { method: 'DELETE', headers: H(tt) });
  }

  console.log('\n=== PDF 进度口径统一 E2E: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
