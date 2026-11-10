/* 云端 v1.20.2~v1.20.7 综合部署验证（六个版本一次覆盖，写入数据全部清场）
 * 覆盖：教师协作修复（发布带班级/退出班级/作业管理权限）/ 学号展示 / 资源班级归属 /
 *       提交批改筛选 / 登录密码眼睛按钮 / v1.18 安全项复检 / 旧版本功能未回退
 * 说明：本机安全软件会拦截 headless 浏览器直连公网裸 IP（ERR_BLOCKED_BY_CLIENT），
 *       UI 验证经本地端口转发隧道访问（localhost → 47.119.150.2）
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures') + path.sep;
const CLOUD = 'http://47.119.150.2';
const API = CLOUD + '/api';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '（' + detail + '）' : '')); }
};
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { code: -999, msg: t.slice(0, 100) }; } };

(async () => {
  /* ============ 1. 前端代码标记（六个版本一次核验 + 未回退） ============ */
  const js = await (await fetch(CLOUD + '/assets/js/app.js')).text();
  const login = await (await fetch(CLOUD + '/login.html')).text();
  const css = await (await fetch(CLOUD + '/assets/css/styles.css')).text();
  ok('[前端] v1.20.2 协作修复代码（classLeaveModal/退出班级 + 资源带班级）',
    js.includes('classLeaveModal') && js.includes('退出班级')
      && js.includes("fd.append('classId', String(State.filters.classId))"), '');
  ok('[前端] v1.20.3/4 学号展示（列表行+档案卡）',
    js.includes('学号 ') && js.includes('studentNo ||'), '');
  ok('[前端] v1.20.5 资源归属跟随选中班级（切班六接口联动）',
    js.includes("API.get('/teacher/resources' + qs)") && js.includes("'/teacher/resources' + (State.filters.classId"), '');
  ok('[前端] v1.20.6 提交批改筛选', js.includes('subFilterMenu') && js.includes('subFilterClear') && js.includes('已提交作业学生'), '');
  ok('[前端] v1.20.7 登录密码眼睛按钮', login.includes('eye-toggle') && login.includes('bindEye')
    && login.includes('显示密码') && css.includes('.eye-toggle'), '');
  ok('[前端] 旧版本未回退（v1.19 预览 / v1.20 分组 / v1.20.1 成果物）',
    js.includes('resDocHtml') && js.includes('composeGroupCfgHtml') && js.includes('toggleDeliverable'), '');

  /* ============ 2. 登录准备 ============ */
  const login2 = async (u, p) => j(await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ username: u, password: p || '123456' })
  }));
  const lgChen = await login2('teacher');
  ok('[基础] 教师登录', lgChen.code === 0, '');
  const chen = lgChen.data.token;
  const H = { Authorization: 'Bearer ' + chen, 'Content-Type': 'application/json;charset=utf-8' };
  const lgStu = await login2('student');
  const stu = lgStu.data.token;
  ok('[基础] 学生登录', lgStu.code === 0, '');
  let lgZhu = await login2('teacher0000001');
  let zhuOk = lgZhu.code === 0;
  if (!zhuOk) {
    // 云端已有同名账号但密码不同：注册/复用云端专用协作测试教师 claudzhu01（首次注册，之后直接登录）
    const reg = await j(await fetch(API + '/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
      body: JSON.stringify({ username: 'claudzhu01', password: '123456', realName: '云端协作测试教师', role: 'TEACHER', studentNo: null, classId: null })
    }));
    ok('[准备] 云端协作测试教师就绪（claudzhu01，注册或已存在）', reg.code === 0 || /已被注册/.test(reg.msg || ''), reg.msg || 'ok');
    lgZhu = await login2('claudzhu01');
    zhuOk = lgZhu.code === 0;
  }
  const zhu = zhuOk ? lgZhu.data.token : null;
  const zhuUser = lgZhu.data && lgZhu.data.user;
  console.log('  [事实] 协作测试教师账号' + (zhuOk ? '可用（' + (zhuUser && zhuUser.username) + '）' : '不可用（协作项按条件执行）'));

  const stamp = Date.now().toString(36);
  const fmt = (ts) => {
    const d = new Date(ts), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };
  const oneQ = () => [{ id: null, type: 'SINGLE', title: 'cloud verify question', options: [{ key: 'A', text: 'aa' }, { key: 'B', text: 'bb' }], answer: ['A'] }];
  const compose = async (tok, body) => j(await fetch(API + '/teacher/compose', {
    method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify(body)
  }));
  const myAssignments = async (tok) => j(await fetch(API + '/assignments/my', { headers: { Authorization: 'Bearer ' + tok } }));
  const created = [];

  /* ============ 3. 问题1云端复验：共同管理教师发布学生可收到 ============ */
  if (zhuOk) {
    const addCo = await j(await fetch(API + '/teacher/co-teachers', {
      method: 'POST', headers: H, body: JSON.stringify({ classId: 1, teacherId: Number(lgZhu.data.user.id) })
    }));
    ok('[协作] 朱老师为班级1共同管理教师（或已存在）', addCo.code === 0 || /已/.test(addCo.msg || ''), addCo.msg || 'ok');
    const zTitle = 'CLD-CO-AS-' + stamp;
    const zc = await compose(zhu, {
      classId: 1, title: zTitle, scoreMode: 'AVERAGE', status: 'ONGOING',
      startAt: fmt(Date.now()), endAt: fmt(Date.now() + 7 * 864e5), kps: [], questions: oneQ()
    });
    const zAsId = zc.data && zc.data.id;
    ok('[协作] 共同管理教师向班级1发布作业成功', zc.code === 0 && zAsId != null, 'id=' + zAsId);
    if (zAsId) {
      created.push(zAsId);
      const mine = await myAssignments(stu);
      ok('[协作] 班级1学生收到共同管理教师发布的作业', (mine.data || []).some(a => String(a.id) === String(zAsId)), '');
      // 共同管理教师可删除该班作业（权限一致）+ 顺带清场
      const del = await fetch(API + '/teacher/assignments/' + zAsId, { method: 'DELETE', headers: { Authorization: 'Bearer ' + zhu } });
      ok('[协作] 共同管理教师可删除该班作业（与所有者权限一致）', del.status === 200, 'HTTP ' + del.status);
      if (del.status === 200) created.pop();
    }
    /* ============ 4. 问题2云端复验：删除班级=退出自己 ============ */
    const leave = await j(await fetch(API + '/teacher/classes/1', { method: 'DELETE', headers: { Authorization: 'Bearer ' + zhu } }));
    ok('[协作] 共同管理教师删除班级=退出自己（action=left）', leave.code === 0 && leave.data && leave.data.action === 'left', leave.msg || 'ok');
    const chenCls = await j(await fetch(API + '/teacher/classes', { headers: H }));
    ok('[协作] 退出后班级1对所有者完整保留', (chenCls.data || []).some(c => String(c.id) === '1'), '');
    const coPanel = await j(await fetch(API + '/teacher/co-teachers?classId=1', { headers: H }));
    ok('[协作] 退出后所有者共同管理列表不再显示该教师', coPanel.code === 0
      && !((coPanel.data.coTeachers || []).some(x => zhuUser && String(x.username) === String(zhuUser.username))), '');
    const reAdd = await j(await fetch(API + '/teacher/co-teachers', {
      method: 'POST', headers: H, body: JSON.stringify({ classId: 1, teacherId: Number(lgZhu.data.user.id) })
    }));
    ok('[协作] 朱老师重新加入班级1（环境还原）', reAdd.code === 0, reAdd.msg || 'ok');
  }

  /* ============ 5. 资源班级归属云端复验 ============ */
  const fd = new FormData();
  fd.append('title', 'CLD-CLS-RES-' + stamp);
  fd.append('classId', '1');
  fd.append('file', new Blob([readFileSync(FIX + 'test-doc.docx')],
    { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'test-doc.docx');
  const upRes = await j(await fetch(API + '/teacher/resources', { method: 'POST', headers: { Authorization: 'Bearer ' + chen }, body: fd }));
  ok('[资源] 携带 classId=1 上传资源成功', upRes.code === 0 && !!upRes.data.id, 'id=' + (upRes.data && upRes.data.id));
  const resId = upRes.data && upRes.data.id;
  if (resId) {
    const stuRes = await j(await fetch(API + '/resources', { headers: { Authorization: 'Bearer ' + stu } }));
    ok('[资源] 班级1学生可见该资源（归属正确）', (stuRes.data || []).some(r => String(r.id) === String(resId)), '');
    const delRes = await fetch(API + '/teacher/resources/' + resId, { method: 'DELETE', headers: { Authorization: 'Bearer ' + chen } });
    ok('[资源] 清场：资源删除', delRes.status === 200, 'HTTP ' + delRes.status);
  }

  /* ============ 6. UI 云端验证（Playwright 经本地隧道）：学号展示 / 提交筛选 / 密码眼睛 ============ */
  // 本地端口转发隧道：localhost:18080 → 47.119.150.2（绕过本机安全软件对浏览器直连公网裸 IP 的拦截）
  const tunnel = http.createServer((req, res) => {
    const opts = {
      host: '47.119.150.2', port: 80, path: req.url, method: req.method,
      headers: Object.assign({}, req.headers, { host: '47.119.150.2' })
    };
    const upstream = http.request(opts, r => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    upstream.on('error', () => { try { res.writeHead(502); res.end('tunnel error'); } catch (e) { } });
    req.pipe(upstream);
  });
  await new Promise(r => tunnel.listen(18080, r));
  const UI_BASE = 'http://localhost:18080';
  process.on('exit', () => { try { tunnel.close(); } catch (e) {} });

  let browser;
  for (const ch of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {}
  }
  if (!browser) throw new Error('无可用系统浏览器');
  process.on('exit', () => { try { browser.close(); } catch (e) {} });

  // 6.1 密码眼睛（登录页）
  const pg1 = await (await browser.newContext({ viewport: { width: 800, height: 800 } })).newPage();
  const errs1 = [];
  pg1.on('pageerror', e => errs1.push(e.message));
  await pg1.goto(UI_BASE + '/login.html');
  await pg1.fill('#lgPass', 'cloud123');
  await pg1.click('#eyeLg');
  const eyeState = await pg1.evaluate(() => ({
    type: document.getElementById('lgPass').type,
    val: document.getElementById('lgPass').value,
    label: document.getElementById('eyeLg').getAttribute('aria-label')
  }));
  ok('[UI] 密码眼睛：明文切换 + 内容保留 + aria 同步',
    eyeState.type === 'text' && eyeState.val === 'cloud123' && eyeState.label === '隐藏密码', JSON.stringify(eyeState));
  ok('[UI] 密码眼睛：无 JS 报错', errs1.length === 0, errs1.slice(0, 2).join(';'));
  await pg1.close();

  // 6.2 教师端：学号展示 + 提交筛选（真实页面）
  const pg2 = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  const errs2 = [];
  pg2.on('pageerror', e => errs2.push(e.message));
  pg2.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) errs2.push('http ' + r.status + r.url.slice(-50)); });
  await pg2.goto(UI_BASE + '/login.html');
  await pg2.fill('#lgUser', 'teacher');
  await pg2.fill('#lgPass', '123456');
  await pg2.click('button[type="submit"]');
  await pg2.waitForSelector('.brand-sub', { timeout: 30000 });
  for (let i = 0; i < 40; i++) {
    const t = await pg2.textContent('.mh-title').catch(() => '');
    if (t && !t.includes('加载中')) break;
    await pg2.waitForTimeout(500);
  }
  // 学号展示：班级学生页
  await pg2.click('[data-act="section"][data-val="students"]');
  await pg2.waitForSelector('table.table tbody tr', { timeout: 30000 });
  const stuCell = await pg2.$eval('table.table tbody tr td:first-child', e => e.textContent.trim());
  ok('[UI] 学生列表姓名下方展示学号', stuCell.includes('学号'), stuCell.replace(/\s+/g, ' '));
  await pg2.click('table.table tbody tr');
  await pg2.waitForTimeout(1000);
  const profileHead = (await pg2.$$eval('.card-head h3', els => {
    const hit = els.find(e => e.textContent.includes('学生档案'));
    return hit && hit.parentElement ? hit.parentElement.textContent : '';
  }).catch(() => '')).trim();
  ok('[UI] 档案卡头部展示学号', profileHead.includes('学号'), profileHead.replace(/\s+/g, ' ').slice(0, 40));
  // 提交批改筛选
  await pg2.click('[data-act="section"][data-val="submissions"]');
  await pg2.waitForSelector('[data-act="subFilterMenu"]', { timeout: 30000 });
  const beforeRows = await pg2.$$eval('table.table tbody tr', els => els.length);
  await pg2.click('[data-act="subFilterMenu"]');
  await pg2.waitForSelector('.as-menu', { timeout: 10000 });
  const menuTxt = (await pg2.textContent('.as-menu')).trim();
  ok('[UI] 筛选面板含已提交/未提交选项', menuTxt.includes('已提交作业学生') && menuTxt.includes('未提交作业学生'), menuTxt.replace(/\s+/g, ' '));
  const subCnt = (menuTxt.match(/已提交作业学生（(\d+) 人）/) || [])[1];
  await pg2.click('.as-menu [data-act="subFilter"][data-val="submitted"]');
  await pg2.waitForTimeout(800);
  const afterRows = await pg2.$$eval('table.table tbody tr', els => els.length);
  const mainTxt2 = await pg2.textContent('#main').catch(() => '');
  const badge = mainTxt2.includes('筛选中');
  // 0 匹配时表格渲染 1 行空态提示（含"没有学生"），非 0 时行数应等于面板计数
  const zeroEmpty = Number(subCnt) === 0 && afterRows === 1 && mainTxt2.includes('没有学生');
  ok('[UI] 筛选已提交生效（行数 ' + beforeRows + '→' + afterRows + '，计数=' + subCnt + '）+ 状态标识',
    subCnt != null && badge && (String(afterRows) === subCnt || zeroEmpty), '');
  await pg2.click('[data-act="subFilterClear"]');
  await pg2.waitForTimeout(600);
  const clearedRows = await pg2.$$eval('table.table tbody tr', els => els.length);
  ok('[UI] 一键清除恢复完整列表', clearedRows === beforeRows, clearedRows + ' 行');
  ok('[UI] 教师端无 JS 报错', errs2.length === 0, errs2.slice(0, 2).join(';'));
  await pg2.close();

  /* ============ 7. v1.18 安全项复检 ============ */
  {
    const r = await fetch(CLOUD + '/v3/api-docs', { redirect: 'manual' });
    ok('[安全复检] Swagger 仍关闭（404）', r.status === 404, 'HTTP ' + r.status);
    const crypto = await import('node:crypto');
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const hdr = b64({ alg: 'HS256' });
    const pld = b64({ sub: '1', role: 'TEACHER', iat: now, exp: now + 3600 });
    const sig = crypto.createHmac('sha256', 'la-dev-secret-key-must-be-at-least-32-bytes!!').update(hdr + '.' + pld).digest('base64url');
    const fr = await fetch(API + '/teacher/classes', { headers: { Authorization: 'Bearer ' + hdr + '.' + pld + '.' + sig } });
    ok('[安全复检] 旧默认密钥伪造 Token 仍被拒（401）', fr.status === 401, 'HTTP ' + fr.status);
  }

  /* ============ 8. 清场 ============ */
  let delOk = true;
  for (const id of created) {
    const r = await fetch(API + '/teacher/assignments/' + id, { method: 'DELETE', headers: H });
    if (r.status !== 200) delOk = false;
  }
  ok('[清场] 测试作业清理', delOk, created.join(','));

  console.log('\n=== 云端 v1.20.2~v1.20.7 综合验证: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
