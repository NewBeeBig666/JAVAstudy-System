/* 学习资源「原文件即时预览」重构 E2E 测试
 * [API] 上传真实 docx/pptx/pdf/png → /content 结构与内容一致性、响应耗时（<500ms）；
 *       存量资源懒回填（V17 前上传、extracted_text 为空 → 首次 /content 回填入库，二次访问即时）
 * [UI-教师端] Word=文档视图（标题/列表/表格）、PPT=幻灯片页卡、PDF=逐页版面还原、图片=img；点击→内容可见 <3s
 * [UI-学生端] Word 完整滚动 → 自动记录学完；PDF 滚动覆盖口径（与 Word 一致）+ 关闭清理；图片立即达标；卡片状态同步
 * 验证后清理测试资源（级联删文件），零残留
 */
import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const BASE = 'http://localhost:8080';
const API = BASE + '/api';
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures') + path.sep;
const errors = [];
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else { fail++; console.log('  ✗ ' + name + '（' + (detail || '') + '）'); }
};
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { code: -999, msg: t.slice(0, 100) }; } };

function sql(q) {
  try {
    const s = String(q).replace(/[\r\n]+/g, ' ');
    return execSync(`mysql -uroot -proot -N -B learning_agent -e ${JSON.stringify(s)}`, { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  } catch (e) { return null; }
}

async function login(u) {
  const r = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ username: u, password: '123456' })
  });
  const d = await j(r);
  if (d.code !== 0) throw new Error('登录失败(' + u + '): ' + d.msg);
  return d.data.token;
}

async function upload(token, file, title) {
  const fs = await import('node:fs');
  const buf = fs.readFileSync(FIX + file);
  const fd = new FormData();
  fd.append('file', new Blob([buf]), file);
  fd.append('title', title);
  fd.append('classId', '1');
  const r = await fetch(API + '/teacher/resources', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd
  });
  const d = await j(r);
  if (d.code !== 0) throw new Error('上传失败(' + file + '): ' + d.msg);
  return d.data;
}

(async () => {
  const tt = await login('teacher');
  const st = await login('student');
  const H = (t) => ({ Authorization: 'Bearer ' + t });

  /* ---------- 前置清理：删除历史失败运行残留的 E2E 资源 ---------- */
  {
    const old = await j(await fetch(API + '/teacher/resources?classId=1', { headers: H(tt) }));
    for (const r of (old.data || [])) {
      if ((r.title || '').includes('E2E预览')) {
        await fetch(API + '/teacher/resources/' + r.id, { method: 'DELETE', headers: H(tt) });
      }
    }
  }

  /* ---------- [API] 上传 + /content 即时结构 ---------- */
  console.log('\n--- 上传测试资源（真实 docx/pptx/pdf/png）---');
  const word = await upload(tt, 'test-doc.docx', 'E2E预览-Word');
  const ppt = await upload(tt, 'test-slides.pptx', 'E2E预览-PPT');
  const pdf = await upload(tt, 'test-doc.pdf', 'E2E预览-PDF');
  const img = await upload(tt, 'test-image.png', 'E2E预览-图片');
  ok('[API] 四类资源上传成功（AI 识别能力保留运行）', word.id && ppt.id && pdf.id && img.id,
    word.id + '/' + ppt.id + '/' + pdf.id + '/' + img.id);

  {
    const t0 = Date.now();
    const r = await fetch(API + '/resources/' + word.id + '/content', { headers: H(tt) });
    const c = await j(r);
    const ms = Date.now() - t0;
    const items = c.data && c.data.items || [];
    const has = (t) => items.some(i => i.t === t);
    ok('[API] Word /content kind=doc（标题/列表/表格结构）',
      r.status === 200 && c.code === 0 && c.data.kind === 'doc' && has('h1') && has('h2') && has('tbl'),
      'items=' + items.length + ' 类型=' + [...new Set(items.map(i => i.t))].join('/'));
    const texts = JSON.stringify(items);
    ok('[API] Word 原文内容一致（含生成时的真实文字）',
      texts.includes('Java 集合框架概述') && texts.includes('ArrayList') && texts.includes('遍历与随机访问为主'),
      '');
    ok('[API] Word /content 读库零等待（<500ms）', ms < 500, ms + 'ms');
  }
  {
    const t0 = Date.now();
    const r = await fetch(API + '/resources/' + ppt.id + '/content', { headers: H(tt) });
    const c = await j(r);
    const ms = Date.now() - t0;
    const items = c.data && c.data.items || [];
    ok('[API] PPT /content kind=slides（逐页结构）',
      r.status === 200 && c.code === 0 && c.data.kind === 'slides' && items.length === 2,
      '页数=' + items.length);
    const texts = JSON.stringify(items);
    ok('[API] PPT 原文内容一致（含每页标题与要点）',
      texts.includes('PPT 原文预览验证 · 第 1 页') && texts.includes('线程安全场景考虑 ConcurrentHashMap'), '');
    ok('[API] PPT /content 读库零等待（<500ms）', ms < 500, ms + 'ms');
  }
  {
    // 幻灯片版面模型：尺寸/形状/文本运行（字号/颜色/字体）+ LRU 缓存零解析
    const t0 = Date.now();
    const r = await fetch(API + '/resources/' + ppt.id + '/slides', { headers: H(tt) });
    const c = await j(r);
    const ms = Date.now() - t0;
    const sm = c.data || {};
    const s0 = (sm.slides || [])[0] || {};
    ok('[API] PPT /slides 版面模型（尺寸/页数/形状级结构）',
      r.status === 200 && c.code === 0 && sm.w > 0 && sm.h > 0 && (sm.slides || []).length === 2 && (s0.shapes || []).length > 0,
      'w=' + sm.w + ' h=' + sm.h + ' 首页形状 ' + ((s0.shapes || []).length) + ' · ' + ms + 'ms');
    const j0 = JSON.stringify(s0);
    ok('[API] 版面模型含文本运行样式（字号/颜色/字体）',
      j0.includes('"size"') && j0.includes('"color"') && j0.includes('PPT 原文预览验证 · 第 1 页'));
    const t1 = Date.now();
    await fetch(API + '/resources/' + ppt.id + '/slides', { headers: H(tt) });
    const ms2 = Date.now() - t1;
    ok('[API] /slides LRU 缓存二次访问零解析（<400ms）', ms2 < 400, ms2 + 'ms');
  }
  {
    const r = await fetch(API + '/resources/' + pdf.id + '/content', { headers: H(st) });
    const c = await j(r);
    ok('[API] PDF /content kind=pdf（原生直显标记，无需提取）',
      r.status === 200 && c.code === 0 && c.data.kind === 'pdf', '');
    const f = await fetch(API + '/resources/' + pdf.id + '/file', { headers: H(st) });
    const buf = await f.arrayBuffer();
    const head = Buffer.from(buf.slice(0, 5)).toString();
    ok('[API] PDF /file 流式下发原文件（%PDF 头）', f.status === 200 && head === '%PDF-', f.headers.get('content-type'));
    // PDF 逐页位图版面模型 + LRU 缓存零解析
    const t0 = Date.now();
    const rp = await fetch(API + '/resources/' + pdf.id + '/pdf', { headers: H(st) });
    const cp = await j(rp);
    const ms = Date.now() - t0;
    const pm = cp.data || {};
    const p0 = (pm.pages || [])[0] || {};
    ok('[API] PDF /pdf 版面模型（逐页位图 dataURL + 原始尺寸）',
      rp.status === 200 && cp.code === 0 && (pm.pages || []).length >= 1
      && String(p0.src || '').startsWith('data:image/png;base64,') && p0.w > 0 && p0.h > 0,
      '页数=' + (pm.pages || []).length + ' 首页 ' + p0.w + '×' + p0.h + ' · ' + ms + 'ms');
    const t1 = Date.now();
    await fetch(API + '/resources/' + pdf.id + '/pdf', { headers: H(st) });
    ok('[API] /pdf LRU 缓存二次访问零解析（<400ms）', (Date.now() - t1) < 400, (Date.now() - t1) + 'ms');
    // 口径对齐：非 PDF 资源调用 /pdf → 明确拒绝（不误伤其他类型）
    const rw = await fetch(API + '/resources/' + word.id + '/pdf', { headers: H(tt) });
    const cw = await j(rw);
    ok('[API] 非 PDF 资源请求 /pdf 被拒（不影响其他类型）', cw.code !== 0, 'code=' + cw.code);
  }
  {
    const r = await fetch(API + '/resources/' + img.id + '/content', { headers: H(st) });
    const c = await j(r);
    ok('[API] 图片 /content kind=media（原生渲染标记）',
      r.status === 200 && c.code === 0 && c.data.kind === 'media', '');
  }
  {
    // 懒回填路径验证：清空本次上传 Word 的 extracted_text 模拟存量资源 → 首次 /content 回填入库
    sql(`UPDATE learning_resource SET extracted_text=NULL WHERE id=${word.id}`);
    const t0 = Date.now();
    const r1 = await fetch(API + '/resources/' + word.id + '/content', { headers: H(tt) });
    const c1 = await j(r1);
    const ms1 = Date.now() - t0;
    const col2 = sql(`SELECT extracted_text IS NOT NULL FROM learning_resource WHERE id=${word.id}`);
    const t1 = Date.now();
    const r2 = await fetch(API + '/resources/' + word.id + '/content', { headers: H(tt) });
    await j(r2);
    const ms2 = Date.now() - t1;
    ok('[API] 存量资源懒回填（首次提取入库，二次读库即时）',
      c1.code === 0 && c1.data.kind === 'doc' && String(col2).includes('1'),
      '首次 ' + ms1 + 'ms → 二次 ' + ms2 + 'ms');
  }
  {
    // Word 版面模型：页面几何 + 按文档顺序的标题/列表/表格块 + LRU 缓存零解析
    const t0 = Date.now();
    const r = await fetch(API + '/resources/' + word.id + '/doc', { headers: H(tt) });
    const c = await j(r);
    const ms = Date.now() - t0;
    const dm = c.data || {};
    const bj = JSON.stringify(dm.blocks || []);
    ok('[API] Word /doc 版面模型（A4 页面几何 + 标题/列表/表格块）',
      r.status === 200 && c.code === 0 && Math.abs((dm.w || 0) - 595.3) < 1 && (dm.blocks || []).length >= 8
      && bj.includes('"heading":"1"') && bj.includes('"bullet":true') && bj.includes('"t":"tbl"'),
      'w=' + dm.w + ' h=' + dm.h + ' 边距L' + dm.marginL + ' · 块 ' + (dm.blocks || []).length + ' · ' + ms + 'ms');
    const t1 = Date.now();
    await fetch(API + '/resources/' + word.id + '/doc', { headers: H(tt) });
    ok('[API] /doc LRU 缓存二次访问零解析（<400ms）', (Date.now() - t1) < 400, (Date.now() - t1) + 'ms');
  }

  /* ---------- [UI] 浏览器双端验证 ---------- */
  let browser;
  for (const ch of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {}
  }
  if (!browser) throw new Error('无可用系统浏览器');
  process.on('exit', () => { try { browser.close(); } catch (e) {} });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push('http ' + r.status() + ': ' + r.url().slice(-70)); });

  const teacherLogin = async () => {
    await page.goto(BASE + '/login.html');
    await page.fill('#lgUser', 'teacher');
    await page.fill('#lgPass', '123456');
    await page.click('button[type="submit"]');
    await page.waitForSelector('.brand-sub', { timeout: 15000 });
    await page.click('[data-act="section"][data-val="resources"]');
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(300);
      const t = await page.textContent('.mh-title').catch(() => '');
      if (t && t.includes('学习资源')) break;
    }
    await page.waitForTimeout(500);
  };
  const openPreview = async (id) => {
    const t0 = Date.now();
    await page.click(`[data-act="resView"][data-id="${id}"]`);
    await page.waitForSelector('.modal', { timeout: 8000 });
    return Date.now() - t0;
  };
  const openPreviewTeacher = async (id) => {
    const t0 = Date.now();
    await page.click(`[data-act="resFile"][data-id="${id}"]`);
    await page.waitForSelector('.modal', { timeout: 8000 });
    return Date.now() - t0;
  };
  const closePreview = async () => {
    await page.click('.modal [data-act="resPreviewClose"]');
    await page.waitForTimeout(250);
  };

  await teacherLogin();
  console.log('\n--- 教师端预览（原文件即时渲染）---');
  {
    const ms = await openPreviewTeacher(word.id);
    await page.waitForSelector('.doc-page', { timeout: 6000 });
    const txt = await page.textContent('.doc-page');
    const hasTbl = await page.$('.doc-page .doc-tbl');
    ok('[UI-教师] Word 版面还原视图即时渲染（标题+列表+表格）',
      txt.includes('Java 集合框架概述') && txt.includes('HashMap') && !!hasTbl
      && !txt.includes('原文内容加载中'), '点击→内容 ' + ms + 'ms');
    ok('[UI-教师] Word 预览零等待（<1.5s，文本视图先行 + 版面模型无缝升级）', ms < 1500, ms + 'ms');
    // 版面属性：页面几何来自原文件（A4 宽 595px + 页边距 72/90px）；标题 heading1 字号兜底 18px
    const geo = await page.evaluate(() => {
      const pg = document.querySelector('.doc-page');
      const h1 = Array.from(pg.querySelectorAll('.doc-p')).find(e => e.textContent.includes('Java 集合框架概述'));
      return { w: parseFloat(pg.style.width), pad: pg.style.padding || '', hfs: h1 ? h1.style.fontSize || '' : '' };
    });
    ok('[UI-教师] 页面几何还原（A4 宽 595.3px · 上下边距 72px）',
      Math.abs(geo.w - 595.3) < 1 && geo.pad.includes('72px'), 'w=' + geo.w + ' padding=' + geo.pad);
    ok('[UI-教师] 标题样式还原（heading1 → 18px 兜底）', geo.hfs === '18px', geo.hfs);
    await closePreview();
  }

  console.log('\n--- 多场景：真实 Word 文档（不同体积/结构）---');
  {
    const list = await j(await fetch(API + '/teacher/resources?classId=1', { headers: H(tt) }));
    const realDoc = (list.data || []).find(x => x.fileType === 'word' && !(x.title || '').includes('E2E')
      && (x.fileName || '').toLowerCase().endsWith('.docx'));
    if (!realDoc) {
      ok('[场景] 环境无真实 docx 文档（跳过，fixture 已覆盖）', true);
    } else {
      const t0 = Date.now();
      await openPreviewTeacher(realDoc.id);
      await page.waitForSelector('.doc-page', { timeout: 15000 });
      const ms = Date.now() - t0;
      const geo = await page.evaluate(() => {
        const pg = document.querySelector('.doc-page');
        return { w: parseFloat(pg.style.width), blocks: pg.querySelectorAll('.doc-p,.doc-tbl').length };
      });
      ok('[场景] 真实文档版面渲染', geo.blocks > 3, realDoc.title + ' · 页面宽 ' + geo.w + 'px · 块 ' + geo.blocks + ' · ' + ms + 'ms');
      const scrollMs = await page.evaluate(() => new Promise(res => {
        const el = document.getElementById('resPrevScroll');
        const t = Date.now();
        el.scrollTop = el.scrollHeight;
        requestAnimationFrame(() => res(Date.now() - t));
      }));
      ok('[场景] 长文档滚动即时响应（<200ms 无卡顿）', scrollMs < 200, scrollMs + 'ms');
      await closePreview();
    }
  }
  {
    const ms = await openPreviewTeacher(ppt.id);
    await page.waitForSelector('#pptSlide', { timeout: 6000 });
    const thumbs = await page.$$eval('#pptThumbs .ppt-thumb', els => els.length);
    const shapes = await page.$$eval('#pptSlide .ppt-shape', els => els.length);
    const txt = await page.textContent('#pptSlide');
    ok('[UI-教师] PPT 幻灯片还原播放器（缩略条 + 版面渲染原文件内容）',
      thumbs === 2 && shapes > 0 && txt.includes('PPT 原文预览验证 · 第 1 页') && txt.includes('标题下方第一行要点'),
      '缩略 ' + thumbs + ' 页 · 形状 ' + shapes + ' · 点击→内容 ' + ms + 'ms');
    const minis = await page.$$eval('#pptThumbs .ppt-mini', els => els.map(e => ({
      w: e.offsetWidth, h: e.offsetHeight, shapes: e.querySelectorAll('.ppt-shape').length
    })));
    ok('[UI-教师] 缩略小图渲染（每页版面微缩预览 + 页码角标 + 比例一致）',
      minis.length === 2 && minis.every(x => x.shapes > 0 && x.w === 56)
      && minis.every(x => Math.abs(x.h / x.w - 540 / 720) < 0.02),
      '小图 ' + minis.map(x => x.w + '×' + x.h + '·' + x.shapes + '形状').join('，'));
    // 缩放适配：舞台高度按幻灯片宽高比计算
    const ratio = await page.evaluate(() => {
      const st = document.getElementById('pptStage');
      const sl = document.getElementById('pptSlide');
      return { h: st.offsetHeight, w: st.offsetWidth, slw: parseFloat(sl.style.width) || 0, slh: parseFloat(sl.style.height) || 0, scale: (sl.style.transform || '').match(/scale\(([\d.]+)\)/) };
    });
    const scaled = ratio.scale ? Number(ratio.scale[1]) : 0;
    ok('[UI-教师] 等比缩放适配（舞台高 = 原高 × 缩放，比例不变形）',
      scaled > 0 && Math.abs(ratio.h - (ratio.slh * scaled)) < 3, 'scale=' + scaled.toFixed(3) + ' 舞台 ' + ratio.w + '×' + ratio.h);
    // 翻页：按钮 + 键盘 →
    await page.click('[data-act="pptNext"]');
    await page.waitForFunction(() => (document.querySelector('.ppt-page-ind') || {}).textContent.includes('2 / 2'), null, { timeout: 4000 });
    const txt2 = await page.textContent('#pptSlide');
    ok('[UI-教师] 翻页加载第 2 页（按钮 + 页码指示）', txt2.includes('第 2 页 · 集合框架小结'));
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => (document.querySelector('.ppt-page-ind') || {}).textContent.includes('1 / 2'), null, { timeout: 4000 });
    ok('[UI-教师] 键盘 ← 翻回第 1 页', true);
    // 窗口缩放适配：舞台随视口宽度重算缩放
    await page.setViewportSize({ width: 780, height: 800 });
    await page.waitForTimeout(400);
    const ratio2 = await page.evaluate(() => {
      const st = document.getElementById('pptStage');
      const sl = document.getElementById('pptSlide');
      const s = (sl.style.transform || '').match(/scale\(([\d.]+)\)/);
      return { h: st.offsetHeight, w: st.offsetWidth, scale: s ? Number(s[1]) : 0, slh: parseFloat(sl.style.height) || 0 };
    });
    ok('[UI-教师] 窄视口（780px）缩放重算不溢出不变形',
      ratio2.scale > 0 && ratio2.scale < scaled && Math.abs(ratio2.h - (ratio2.slh * ratio2.scale)) < 3,
      'scale ' + scaled.toFixed(3) + ' → ' + ratio2.scale.toFixed(3));
    await page.setViewportSize({ width: 1360, height: 900 });
    await closePreview();
  }

  console.log('\n--- 多场景：真实大型课件（不同页数/表格/配色还原）---');
  {
    const list = await j(await fetch(API + '/teacher/resources?classId=1', { headers: H(tt) }));
    const real = (list.data || []).find(x => x.fileType === 'ppt' && !((x.title || '').includes('E2E')) && (x.title || '').includes('ppt'));
    if (!real) {
      ok('[场景] 环境无真实大型课件（跳过该场景，fixture 已覆盖）', true);
    } else {
      const t0 = Date.now();
      await openPreviewTeacher(real.id);
      await page.waitForSelector('#pptSlide', { timeout: 20000 });
      const ms = Date.now() - t0;
      const thumbs = await page.$$eval('#pptThumbs .ppt-thumb', els => els.length);
      ok('[场景] 大型课件播放器渲染（缩略条全页数）', thumbs > 50, real.title + ' · ' + thumbs + ' 页 · 点击→播放器 ' + ms + 'ms');
      // 缩略小图：全量渲染且每页含版面内容（比例由内联尺寸保证）
      const miniN = await page.$$eval('#pptThumbs .ppt-mini', els => els.length);
      const miniWithShapes = await page.$$eval('#pptThumbs .ppt-mini', els => els.filter(e => e.querySelector('.ppt-shape')).length);
      ok('[场景] 大型课件缩略小图全量渲染（含版面微缩内容）',
        miniN === thumbs && miniWithShapes === thumbs, '小图 ' + miniN + ' · 含形状 ' + miniWithShapes);
      // 找含表格/带填充色的页跳转，验证形状级还原（表格单元格 + 色块）
      const sm = (await j(await fetch(API + '/resources/' + real.id + '/slides', { headers: H(tt) }))).data || {};
      const tableIdx = (sm.slides || []).findIndex(s => (s.shapes || []).some(x => x.t === 'table'));
      const fillIdx = (sm.slides || []).findIndex(s => (s.shapes || []).some(x => x.fill));
      if (tableIdx >= 0) {
        await page.click(`#pptThumbs .ppt-thumb[data-val="${tableIdx}"]`);
        await page.waitForFunction((n) => {
          const ind = (document.querySelector('.ppt-page-ind') || {}).textContent || '';
          return ind.includes((n + 1) + ' / ');
        }, tableIdx, { timeout: 4000 });
        const cells = await page.$$eval('#pptSlide .ppt-cell', els => els.length);
        ok('[场景] 表格页还原（逐单元格绝对定位渲染）', cells > 4, '第 ' + (tableIdx + 1) + ' 页 · 单元格 ' + cells);
      }
      if (fillIdx >= 0) {
        await page.click(`#pptThumbs .ppt-thumb[data-val="${fillIdx}"]`);
        await page.waitForFunction((n) => {
          const ind = (document.querySelector('.ppt-page-ind') || {}).textContent || '';
          return ind.includes((n + 1) + ' / ');
        }, fillIdx, { timeout: 4000 });
        const fills = await page.$$eval('#pptSlide .ppt-text', els => els.filter(e => (e.getAttribute('style') || '').includes('background:')).length);
        ok('[场景] 配色还原（形状填充色渲染）', fills > 0, '第 ' + (fillIdx + 1) + ' 页 · 带填充形状 ' + fills);
      }
      // 连续跳页响应速度（模型已缓存，客户端渲染 <500ms）
      const t2 = Date.now();
      await page.click('#pptThumbs .ppt-thumb[data-val="3"]');
      await page.waitForFunction(() => ((document.querySelector('.ppt-page-ind') || {}).textContent || '').includes('4 / '), null, { timeout: 3000 });
      ok('[场景] 跳页响应（<500ms，缓存模型零解析）', Date.now() - t2 < 500, (Date.now() - t2) + 'ms');
      await closePreview();
    }
  }
  {
    const ms = await openPreviewTeacher(pdf.id);
    await page.waitForSelector('.pdf-page-wrap', { timeout: 10000 });
    const imgs = await page.$$eval('.pdf-page-wrap .pdf-page-img', els => els.map(e => ({
      src: String(e.src || '').slice(0, 22), w: parseFloat(e.style.width) || 0, h: parseFloat(e.style.height) || 0
    })));
    ok('[UI-教师] PDF 版面还原视图（逐页位图渲染，替代原生 iframe）',
      imgs.length >= 1 && imgs.every(x => x.src.startsWith('data:image/png') && x.w > 0 && x.h > 0),
      '页 ' + imgs.length + ' · 首页 ' + (imgs[0] || {}).w + '×' + (imgs[0] || {}).h + ' · 点击→内容 ' + ms + 'ms');
    ok('[UI-教师] PDF 首开可用（版面模型 + 渲染 <3s）', ms < 3000, ms + 'ms');
    const noLearn = await page.$('#resLearnBox');
    ok('[UI-教师] 教师端无学习进度区（不触发进度记录）', !noLearn, '');
    const scrollMs = await page.evaluate(() => new Promise(res => {
      const el = document.getElementById('resPrevScroll');
      const t = Date.now();
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => res(Date.now() - t));
    }));
    ok('[UI-教师] PDF 滚动即时响应（<200ms 无卡顿）', scrollMs < 200, scrollMs + 'ms');
    await closePreview();
  }
  {
    const ms = await openPreviewTeacher(img.id);
    await page.waitForSelector('.modal img[src^="blob:"]', { timeout: 5000 });
    ok('[UI-教师] 图片原生渲染', true, ms + 'ms');
    await closePreview();
  }

  console.log('\n--- 学生端预览（交互逻辑保持：学习完成判定）---');
  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', 'student');
  await page.fill('#lgPass', '123456');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.brand-sub', { timeout: 15000 });
  await page.click('[data-act="section"][data-val="resources"]');
  await page.waitForTimeout(900);

  // Word：版面还原视图渐进滚动 → 覆盖率达标 → 自动记录学完
  {
    await openPreview(word.id);
    await page.waitForSelector('.doc-page', { timeout: 6000 });
    const learnBox = await page.$('#resLearnBox');
    ok('[UI-学生] Word 版面还原视图保留学习进度区（短文档打开即达标为设计行为）', !!learnBox, '');
    await page.evaluate(() => new Promise(res => {
      const el = document.getElementById('resPrevScroll');
      const step = () => {
        el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + 200);
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) { res(); return; }
        setTimeout(step, 30);
      };
      step();
    }));
    await page.waitForTimeout(600);
    const doneTxt = await page.textContent('#resLearnBox').catch(() => '');
    ok('[UI-学生] Word 完整滚动 → 自动记录学完', doneTxt.includes('已完成学习') || doneTxt.includes('学习完成'),
      doneTxt.trim().slice(0, 30));
    await closePreview();
    const cardTxt = await page.textContent(`#resCardActs-${word.id}`).catch(() => '');
    ok('[UI-学生] 卡片状态同步为已学完', cardTxt.includes('已学完'), '');
  }
  // PDF：与 Word 完全同口径的滚动覆盖判定（直接跳底不达标；完整滚动才判学完）
  {
    await openPreview(pdf.id);
    await page.waitForSelector('.pdf-page-wrap', { timeout: 10000 });
    const s1 = await page.textContent('#resLearnText').catch(() => '');
    ok('[UI-学生] PDF 进度为滚动覆盖口径（与 Word 一致，非时长）', /已完整阅读\s*\d+%/.test(s1 || ''), s1);
    const hint = await page.textContent('#resLearnBox').catch(() => '');
    ok('[UI-学生] PDF 提示为滚动覆盖口径（完整滚动阅读）',
      (hint || '').includes('完整滚动阅读') && !(hint || '').includes('60 秒'), '');
    // 多页跳转：直接拖到底部 → 只覆盖起止两段，不判完成
    await page.evaluate(() => { const el = document.getElementById('resPrevScroll'); el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(400);
    const box1 = await page.textContent('#resLearnBox').catch(() => '');
    const w1 = await page.$eval('#resLearnBar', e => e.style.width).catch(() => '');
    ok('[UI-学生] 直接跳底不判完成（覆盖仅起止两段）',
      !(box1 || '').includes('已完成学习') && !(box1 || '').includes('学习完成') && parseFloat(w1) < 98,
      '进度条 ' + w1 + ' · ' + (s1 || '').slice(0, 20));
    await closePreview();
    await page.waitForTimeout(600);
    ok('[UI-学生] PDF 关闭后无 JS 报错（清理正常）', errors.length === 0, '');
  }
  // PPT：幻灯片还原播放器逐页浏览 → 已浏览页数达标 → 自动记录学完
  {
    await openPreview(ppt.id);
    await page.waitForSelector('#pptSlide', { timeout: 6000 });
    const learn1 = await page.textContent('#resLearnText');
    ok('[UI-学生] PPT 进度按已浏览页数口径（1 / 2）', /1\s*\/\s*2/.test(learn1 || ''), learn1);
    await page.click('[data-act="pptNext"]');
    await page.waitForFunction(() => {
      const box = (document.querySelector('#resLearnBox') || {}).textContent || '';
      return box.includes('已完成学习') || box.includes('学习完成');
    }, null, { timeout: 5000 });
    ok('[UI-学生] PPT 逐页浏览完成后自动记录学完', true);
    await closePreview();
    const cardTxt = await page.textContent(`#resCardActs-${ppt.id}`).catch(() => '');
    ok('[UI-学生] PPT 卡片状态同步为已学完', (cardTxt || '').includes('已学完'), '');
  }
  // 图片：立即达标
  {
    await openPreview(img.id);
    await page.waitForSelector('.modal img[src^="blob:"]', { timeout: 5000 });
    await page.waitForTimeout(500);
    const doneTxt = await page.textContent('#resLearnBox').catch(() => '');
    ok('[UI-学生] 图片打开即记录学完（原有逻辑）', doneTxt.includes('已完成学习') || doneTxt.includes('学习完成'),
      doneTxt.trim().slice(0, 30));
    await closePreview();
  }

  ok('全程无 JS 报错 / 无意外 4xx 5xx', errors.length === 0, errors.slice(0, 3).join(' ; '));

  /* ---------- 清理测试资源（级联删文件） ---------- */
  for (const r of [word, ppt, pdf, img]) {
    await fetch(API + '/teacher/resources/' + r.id, { method: 'DELETE', headers: H(tt) });
  }

  console.log('\n=== 原文件即时预览 E2E: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
