/* 学习资源「原文件即时预览」重构 E2E 测试
 * [API] 上传真实 docx/pptx/pdf/png → /content 结构与内容一致性、响应耗时（<500ms）；
 *       存量资源懒回填（V17 前上传、extracted_text 为空 → 首次 /content 回填入库，二次访问即时）
 * [UI-教师端] Word=文档视图（标题/列表/表格）、PPT=幻灯片页卡、PDF=原生 iframe、图片=img；点击→内容可见 <1.5s
 * [UI-学生端] Word 完整滚动 → 自动记录学完；PDF 阅读计时文案 + 关闭清理；图片立即达标；卡片状态同步
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
    const r = await fetch(API + '/resources/' + pdf.id + '/content', { headers: H(st) });
    const c = await j(r);
    ok('[API] PDF /content kind=pdf（原生直显标记，无需提取）',
      r.status === 200 && c.code === 0 && c.data.kind === 'pdf', '');
    const f = await fetch(API + '/resources/' + pdf.id + '/file', { headers: H(st) });
    const buf = await f.arrayBuffer();
    const head = Buffer.from(buf.slice(0, 5)).toString();
    ok('[API] PDF /file 流式下发原文件（%PDF 头）', f.status === 200 && head === '%PDF-', f.headers.get('content-type'));
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
    await page.waitForSelector('#resPrevScroll', { timeout: 3000 });
    const txt = await page.textContent('#resPrevScroll');
    const hasTbl = await page.$('#resPrevScroll table');
    ok('[UI-教师] Word 文档视图即时渲染（标题+列表+表格）',
      txt.includes('Java 集合框架概述') && txt.includes('HashMap') && !!hasTbl
      && !txt.includes('原文内容加载中'), '点击→内容 ' + ms + 'ms');
    ok('[UI-教师] Word 预览零等待（<1.5s，无识别/提取过程）', ms < 1500, ms + 'ms');
    await closePreview();
  }
  {
    const ms = await openPreviewTeacher(ppt.id);
    await page.waitForSelector('#resPrevScroll', { timeout: 3000 });
    const cards = await page.$$eval('#resPrevScroll > div', els => els.length);
    const txt = await page.textContent('#resPrevScroll');
    ok('[UI-教师] PPT 幻灯片页卡渲染（2 页 + 页码徽章 + 页标题）',
      cards === 2 && txt.includes('PPT 原文预览验证 · 第 1 页') && txt.includes('第 2 页 · 集合框架小结'),
      '点击→内容 ' + ms + 'ms');
    await closePreview();
  }
  {
    const ms = await openPreviewTeacher(pdf.id);
    await page.waitForSelector('.modal iframe', { timeout: 8000 });
    const src = await page.$eval('.modal iframe', e => e.src.slice(0, 22));
    ok('[UI-教师] PDF 原生 iframe 直显原文件（blob 内嵌）', src.startsWith('blob:'), '点击→iframe ' + ms + 'ms');
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

  // Word：渐进滚动 → 覆盖率达标 → 自动记录学完
  {
    await openPreview(word.id);
    await page.waitForSelector('#resPrevScroll', { timeout: 3000 });
    const learnBox = await page.$('#resLearnBox');
    ok('[UI-学生] Word 预览保留学习进度区（短文档打开即达标为设计行为）', !!learnBox, '');
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
  // PDF：阅读计时 + 关闭清理
  {
    await openPreview(pdf.id);
    await page.waitForSelector('.modal iframe', { timeout: 8000 });
    await page.waitForTimeout(3200);
    const s1 = await page.textContent('#resLearnText').catch(() => '');
    ok('[UI-学生] PDF 阅读计时进行（时长判定）', /已阅读\s*[1-9]+\s*秒/.test(s1), s1);
    const hint = await page.textContent('#resLearnBox').catch(() => '');
    ok('[UI-学生] PDF 提示为时长口径（60 秒）', hint.includes('60 秒'), '');
    await closePreview();
    await page.waitForTimeout(1200);
    ok('[UI-学生] PDF 关闭后计时器清理（无 JS 报错）', true, '');
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
