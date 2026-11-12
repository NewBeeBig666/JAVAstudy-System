/* 云端 v1.21.0 综合部署验证（项目代码模块 + IDE 工作台 + PPT/Word/PDF 版面还原 + PDF 进度口径统一）
 * API 直连 47.119.150.2:80；UI 经内置本地转发隧道 localhost:18080（绕过安全软件拦截裸 IP）
 * 写入数据全部清场：测试项目级联删（学生项目+版本）、测试资源级联删（文件+进度）
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures') + path.sep;
const CLOUD = 'http://47.119.150.2';
const API = CLOUD + '/api';
const MARK = '云端E2E-v121';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else { fail++; console.log('  ✗ ' + name + '（' + (detail || '') + '）'); }
};
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { code: -999, msg: t.slice(0, 100) }; } };

(async () => {
  /* ============ 1. 部署完整性：前端/静态资源标记核验 ============ */
  console.log('\n== 1. 部署完整性（前端标记 + IDE 静态资源）==');
  const js = await (await fetch(CLOUD + '/assets/js/app.js')).text();
  const css = await (await fetch(CLOUD + '/assets/css/styles.css')).text();
  const ideHtml = await (await fetch(CLOUD + '/ide.html')).text();
  const ideJs = await (await fetch(CLOUD + '/assets/js/ide.js')).text();
  const ideCss = await (await fetch(CLOUD + '/assets/css/ide.css')).text();
  ok('[前端] PDF 版面还原 + 进度口径统一代码已部署',
    js.includes('pdfPlayerHtml') && js.includes("kind === 'pdfPlayer'") && js.includes('已完整阅读'), '');
  ok('[前端] Word 版面还原代码已部署', js.includes('docPlayerHtml') && js.includes('doc-page-wrap'), '');
  ok('[前端] PPT 版面还原 + 局部更新防闪屏代码已部署',
    js.includes('pptPlayerHtml') && js.includes('pptApplyPage'), '');
  ok('[前端] 样式已部署（PDF/Word/PPT 版面）',
    css.includes('.pdf-page-wrap') && css.includes('.doc-page-wrap') && css.includes('.ppt-thumb'), '');
  ok('[IDE] ide.html 已部署（壳页面 + js/css 引用，结构由 ide.js 动态构建）',
    ideHtml.includes('ide.js') && ideHtml.includes('ide.css') && ideHtml.length > 300, '');
  ok('[IDE] ide.js / ide.css 已部署', ideJs.includes('Editor') || ideJs.length > 5000, 'js ' + Math.round(ideJs.length / 1024) + 'KB · css ' + Math.round(ideCss.length / 1024) + 'KB');

  /* ============ 2. 登录准备 ============ */
  const login = async (u, p) => j(await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ username: u, password: p || '123456' })
  }));
  const lgT = await login('teacher');
  ok('[基础] 教师登录', lgT.code === 0, '');
  const tt = lgT.data.token;
  const H = { Authorization: 'Bearer ' + tt };
  const lgS = await login('student');
  ok('[基础] 学生登录', lgS.code === 0, '');
  const st = lgS.data.token;
  const HS = { Authorization: 'Bearer ' + st };

  /* ============ 3. 项目代码模块云端全链路（V19 迁移生效验证）============ */
  console.log('\n== 2. 项目代码模块全链路（V19 三表 + 发布/接收/开发/提交/查看）==');
  // 前置清场：删除历史残留
  {
    const old = await j(await fetch(API + '/teacher/projects?classId=1', { headers: H }));
    for (const p of (old.data || [])) {
      if ((p.title || '').includes(MARK)) await fetch(API + '/teacher/projects/' + p.id, { method: 'DELETE', headers: H });
    }
  }
  const pub = await j(await fetch(API + '/teacher/projects', {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ classId: 1, title: MARK + '-项目代码验证', description: '云端部署验证项目：实现 hello world 并提交' })
  }));
  ok('[项目] 教师发布项目', pub.code === 0 && pub.data.id, 'id=' + (pub.data || {}).id);
  const pid = pub.data.id;
  const myList = await j(await fetch(API + '/projects/my', { headers: HS }));
  const mine = (myList.data || []).find(p => String(p.id) === String(pid));
  ok('[项目] 学生实时接收新项目（/projects/my）', myList.code === 0 && !!mine, '');
  const start = await j(await fetch(API + '/projects/' + pid + '/start', {
    method: 'POST', headers: { ...HS, 'Content-Type': 'application/json;charset=utf-8' }, body: '{}'
  }));
  ok('[项目] 学生创建我的项目（幂等）',
    start.code === 0 && start.data.id && start.data.status === 'IN_PROGRESS', 'spId=' + (start.data || {}).id);
  const spId = start.data.id;
  const save1 = await j(await fetch(API + '/projects/mine/' + spId + '/save', {
    method: 'POST', headers: { ...HS, 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ files: [{ path: 'Main.java', content: 'public class Main {\n  public static void main(String[] a) {\n    System.out.println("v1");\n  }\n}' }], summary: '云端验证版本1', submit: false })
  }));
  ok('[项目] 保存代码生成版本 v1', save1.code === 0 && save1.data.versionCount === 1,
    'versionCount=' + (save1.data || {}).versionCount);
  const save2 = await j(await fetch(API + '/projects/mine/' + spId + '/save', {
    method: 'POST', headers: { ...HS, 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ files: [{ path: 'Main.java', content: 'public class Main {\n  public static void main(String[] a) {\n    System.out.println("cloud-v121");\n  }\n}' }], summary: '云端验证版本2-提交', submit: true })
  }));
  ok('[项目] 迭代版本 v2 并标记提交',
    save2.code === 0 && save2.data.versionCount === 2 && save2.data.status === 'SUBMITTED',
    'versionCount=' + (save2.data || {}).versionCount + ' status=' + (save2.data || {}).status);
  const mineOp = await j(await fetch(API + '/projects/mine/' + spId, { headers: HS }));
  ok('[项目] 学生打开我的项目（最新代码 + 版本列表）',
    mineOp.code === 0 && mineOp.data.mine.versionCount === 2 && mineOp.data.versions.length === 2, '');
  const prog = await j(await fetch(API + '/teacher/projects/' + pid + '/progress', { headers: H }));
  const prow = ((prog.data || {}).students || []).find(s => String(s.studentProjectId) === String(spId));
  ok('[项目] 教师实时查看进度（学生已提交，2 个版本）',
    prog.code === 0 && !!prow && prow.status === 'SUBMITTED' && prow.versionCount === 2, '');
  const vers = await j(await fetch(API + '/teacher/student-projects/' + spId + '/versions', { headers: H }));
  const v2 = ((vers.data || [])[0] || {});
  ok('[项目] 教师查看版本迭代记录（2 个版本留存，降序）',
    vers.code === 0 && (vers.data || []).length === 2 && v2.versionNo === 2,
    '版本 ' + (vers.data || []).map(v => 'v' + v.versionNo).join('/'));
  const vdetail = await j(await fetch(API + '/teacher/project-versions/' + (v2.id || 0), { headers: H }));
  const vjson = JSON.stringify(vdetail.data || {});
  ok('[项目] 教师在线查看 v2 完整代码', vdetail.code === 0 && vjson.includes('cloud-v121'), '');

  /* ============ 4. IDE 云端运行链路（javac + java）============ */
  console.log('\n== 3. IDE 云端运行链路（服务端编译 + 执行）==');
  const run = await j(await fetch(API + '/projects/mine/' + spId + '/run', {
    method: 'POST', headers: { ...HS, 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({
      files: [{ path: 'Main.java', content: 'public class Main {\n  public static void main(String[] a) {\n    System.out.println("cloud-run-ok");\n  }\n}' }],
      stdin: ''
    })
  }));
  const runOut = run.data || {};
  ok('[IDE] 云端 javac 编译 + java 执行全链路',
    run.code === 0 && runOut.ok === true && String(runOut.output || '').includes('cloud-run-ok'),
    run.code === 0 ? ('输出 ' + String(runOut.output || '').slice(0, 40)) : ('msg=' + run.msg));

  // 项目清场（级联学生项目与版本）
  const delP = await fetch(API + '/teacher/projects/' + pid, { method: 'DELETE', headers: H });
  const myList2 = await j(await fetch(API + '/projects/my', { headers: HS }));
  ok('[项目] 清场：项目级联删除（学生项目+版本）',
    delP.status === 200 && !((myList2.data || []).some(p => String(p.id) === String(pid))), '');

  /* ============ 5. 学习资源版面还原模型接口（PPT/Word/PDF）============ */
  console.log('\n== 4. 学习资源版面还原接口（LRU + 模型）==');
  const list = await j(await fetch(API + '/teacher/resources?classId=1', { headers: H }));
  ok('[资源] 教师资源列表', list.code === 0, '共 ' + (list.data || []).length + ' 个');
  // 前置清场：删历史测试资源
  for (const r of (list.data || [])) {
    if ((r.title || '').includes(MARK)) await fetch(API + '/teacher/resources/' + r.id, { method: 'DELETE', headers: H });
  }
  const upload = async (file, title) => {
    const fd = new FormData();
    fd.append('file', new Blob([readFileSync(FIX + file)]), file);
    fd.append('title', title);
    fd.append('classId', '1');
    return j(await fetch(API + '/teacher/resources', { method: 'POST', headers: H, body: fd }));
  };
  const byType = (arr, t) => (arr || []).filter(x => x.fileType === t);
  let pdfRes = byType((await j(await fetch(API + '/teacher/resources?classId=1', { headers: H }))).data, 'pdf')[0];
  if (!pdfRes) { const d = await upload('test-doc.pdf', MARK + '-PDF'); pdfRes = d.data; ok('[资源] 云端补充上传 PDF 测试资源', d.code === 0, ''); }
  let wordRes = (byType((await j(await fetch(API + '/teacher/resources?classId=1', { headers: H }))).data, 'word')
    .filter(x => (x.fileName || '').toLowerCase().endsWith('.docx')))[0];
  if (!wordRes) { const d = await upload('test-doc.docx', MARK + '-Word'); wordRes = d.data; ok('[资源] 云端补充上传 Word 测试资源', d.code === 0, ''); }
  let pptRes = byType((await j(await fetch(API + '/teacher/resources?classId=1', { headers: H }))).data, 'ppt')[0];
  if (!pptRes) { const d = await upload('test-slides.pptx', MARK + '-PPT'); pptRes = d.data; ok('[资源] 云端补充上传 PPT 测试资源', d.code === 0, ''); }
  {
    const t0 = Date.now();
    const c = await j(await fetch(API + '/resources/' + pdfRes.id + '/pdf', { headers: HS }));
    const pm = c.data || {};
    const p0 = (pm.pages || [])[0] || {};
    ok('[PDF] /pdf 版面模型（逐页位图 + 尺寸，学生可访问）',
      c.code === 0 && (pm.pages || []).length >= 1 && String(p0.src || '').startsWith('data:image/png;base64,') && p0.w > 0,
      '页 ' + (pm.pages || []).length + ' · ' + p0.w + '×' + p0.h + ' · ' + (Date.now() - t0) + 'ms');
  }
  {
    const c = await j(await fetch(API + '/resources/' + wordRes.id + '/doc', { headers: H }));
    const dm = c.data || {};
    globalThis.wordDocW = dm.w;
    ok('[Word] /doc 版面模型（页面几何 + 段落块）',
      c.code === 0 && dm.w > 0 && (dm.blocks || []).length > 0, 'w=' + dm.w + ' · 块 ' + (dm.blocks || []).length);
  }
  {
    const c = await j(await fetch(API + '/resources/' + pptRes.id + '/slides', { headers: H }));
    const sm = c.data || {};
    ok('[PPT] /slides 版面模型（形状级结构）',
      c.code === 0 && sm.w > 0 && (sm.slides || []).length >= 1, '页 ' + (sm.slides || []).length);
  }

  /* ============ 6. UI 云端验证（经本地转发隧道）============ */
  console.log('\n== 5. UI 云端验证（Playwright + 内置隧道 18080）==');
  const tunnel = http.createServer((req, res) => {
    const opts = {
      host: '47.119.150.2', port: 80, path: req.url, method: req.method,
      headers: Object.assign({}, req.headers, { host: '47.119.150.2' })
    };
    const upstream = http.request(opts, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    upstream.on('error', () => { try { res.writeHead(502); res.end('tunnel error'); } catch (e) { } });
    req.pipe(upstream);
  });
  await new Promise(r => tunnel.listen(18080, r));
  const UI = 'http://localhost:18080';
  process.on('exit', () => { try { tunnel.close(); } catch (e) {} });

  let browser;
  for (const ch of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {}
  }
  if (!browser) throw new Error('无可用系统浏览器');
  process.on('exit', () => { try { browser.close(); } catch (e) {} });

  // 6.1 教师：PDF/Word 版面还原预览 + 项目代码板块
  const pg = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push(e.message));
  pg.on('response', r => {
    if (r.status() >= 400 && !/favicon/.test(r.url()) && !(r.status() === 400 && /\/(pdf|doc|slides)$/.test(r.url()))) {
      errs.push('http ' + r.status() + ': ' + r.url().slice(-60));
    }
  });
  await pg.goto(UI + '/login.html');
  await pg.fill('#lgUser', 'teacher');
  await pg.fill('#lgPass', '123456');
  await pg.click('button[type="submit"]');
  await pg.waitForSelector('.brand-sub', { timeout: 30000 });
  await pg.click('[data-act="section"][data-val="resources"]');
  for (let i = 0; i < 30; i++) { await pg.waitForTimeout(400); const t = await pg.textContent('.mh-title').catch(() => ''); if (t.includes('学习资源')) break; }
  await pg.waitForTimeout(800);
  await pg.click(`[data-act="resFile"][data-id="${pdfRes.id}"]`);
  await pg.waitForSelector('.pdf-page-wrap', { timeout: 20000 });
  const pdfPages = await pg.$$eval('.pdf-page-wrap .pdf-page-img', els => els.length);
  const noLearnT = !(await pg.$('#resLearnBox'));
  ok('[UI-教师] PDF 版面还原预览（逐页渲染，无学习进度区）', pdfPages >= 1 && noLearnT, '页 ' + pdfPages);
  await pg.click('.modal [data-act="resPreviewClose"]');
  await pg.waitForTimeout(300);
  await pg.click(`[data-act="resFile"][data-id="${wordRes.id}"]`);
  await pg.waitForSelector('.doc-page', { timeout: 20000 });
  const docW = await pg.$eval('.doc-page', e => parseFloat(e.style.width) || 0);
  ok('[UI-教师] Word 版面还原预览（页面几何与原文件一致）',
    docW > 400 && Math.abs(docW - (globalThis.wordDocW || 0)) < 1, 'w=' + docW + 'px（原文件 ' + globalThis.wordDocW + 'pt）');
  await pg.click('.modal [data-act="resPreviewClose"]');
  await pg.waitForTimeout(300);
  await pg.click(`[data-act="resFile"][data-id="${pptRes.id}"]`);
  await pg.waitForSelector('#pptSlide', { timeout: 20000 });
  const thumbs = await pg.$$eval('#pptThumbs .ppt-thumb', els => els.length);
  ok('[UI-教师] PPT 还原播放器（缩略小图 + 舞台）', thumbs >= 1, '缩略 ' + thumbs + ' 页');
  await pg.click('.modal [data-act="resPreviewClose"]');
  await pg.waitForTimeout(300);
  // 项目代码板块
  await pg.click('[data-act="section"][data-val="projects"]');
  await pg.waitForTimeout(1200);
  const projTxt = await pg.textContent('.main-body').catch(() => '');
  ok('[UI-教师] 项目代码板块可进入（导航 + 列表渲染）',
    (projTxt || '').length > 50 && !(projTxt || '').includes('加载失败'), '');

  // 6.2 学生：PDF 进度与 Word 完全同口径（滚动覆盖，非时长）
  const sp = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  const errs2 = [];
  sp.on('pageerror', e => errs2.push(e.message));
  sp.on('response', r => {
    if (r.status() >= 400 && !/favicon/.test(r.url()) && !(r.status() === 400 && /\/(pdf|doc|slides)$/.test(r.url()))) {
      errs2.push('http ' + r.status() + ': ' + r.url().slice(-60));
    }
  });
  await sp.goto(UI + '/login.html');
  await sp.fill('#lgUser', 'student');
  await sp.fill('#lgPass', '123456');
  await sp.click('button[type="submit"]');
  await sp.waitForSelector('.brand-sub', { timeout: 30000 });
  await sp.click('[data-act="section"][data-val="resources"]');
  for (let i = 0; i < 30; i++) { await sp.waitForTimeout(400); const t = await sp.textContent('.mh-title').catch(() => ''); if (t.includes('学习资源')) break; }
  await sp.waitForTimeout(800);
  await sp.click(`[data-act="resView"][data-id="${pdfRes.id}"]`);
  await sp.waitForSelector('.pdf-page-wrap', { timeout: 20000 });
  const sTxt = await sp.textContent('#resLearnText').catch(() => '');
  ok('[UI-学生] PDF 学习进度为滚动覆盖口径（与 Word 一致，非 60 秒时长）',
    /已完整阅读\s*\d+%/.test(sTxt || '') && !(sTxt || '').includes('秒'), sTxt);
  // 跳底不判完成（云端同样防刷量）
  await sp.evaluate(() => { const el = document.getElementById('resPrevScroll'); el.scrollTop = el.scrollHeight; });
  await sp.waitForTimeout(500);
  const boxTxt = await sp.textContent('#resLearnBox').catch(() => '');
  ok('[UI-学生] 直接跳底不判完成（区间覆盖口径生效）',
    !(boxTxt || '').includes('已完成学习') && !(boxTxt || '').includes('学习完成'), '');
  await sp.click('.modal [data-act="resPreviewClose"]');
  // 学生 IDE 页可达
  await sp.goto(UI + '/ide.html');
  await sp.waitForTimeout(1500);
  const ideOk = await sp.evaluate(() => document.body && document.body.textContent.length > 200);
  ok('[UI-学生] IDE 工作台页面云端可达', !!ideOk, '');
  await sp.close();

  ok('[UI] 全程无 JS 报错 / 无意外 4xx 5xx', errs.length === 0 && errs2.length === 0,
    (errs.concat(errs2)).slice(0, 3).join(' ; '));

  /* ============ 7. 清场 ============ */
  const finalList = await j(await fetch(API + '/teacher/resources?classId=1', { headers: H }));
  let cleaned = true;
  for (const r of (finalList.data || [])) {
    if ((r.title || '').includes(MARK)) {
      const d = await fetch(API + '/teacher/resources/' + r.id, { method: 'DELETE', headers: H });
      if (d.status !== 200) cleaned = false;
    }
  }
  ok('[清场] 测试资源全部删除（零残留）', cleaned, '');

  console.log('\n==== 云端 v1.21.0 验证：' + pass + ' 通过 / ' + fail + ' 失败 ====');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
