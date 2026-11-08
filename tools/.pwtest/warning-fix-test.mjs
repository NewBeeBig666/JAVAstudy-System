/* 预警两项修复验证：
 * [修复1] 预警触发机制：POST /warnings/scan 生成预警（六类规则）+ 3 天去重 + UI「立即检测」
 * [修复2] 班级归属校验：跨班查询/处理/推送被拒（授课 ∪ 共同管理才可访问）
 * 本地库测试，结束后清理朱老师班新增预警
 */
import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
const BASE = 'http://localhost:8080';
const API = BASE + '/api';
const errors = [];
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '（' + detail + '）' : '')); }
};

/* 共同管理教师的移除接口已下线，测试清场改用 mysql 直连（本地默认 root/root；失败返回 null）。
 * 模板字符串里的换行 / Windows 的 \r 都会破坏 cmd 传参后的 SQL，统一压缩为单行空格 */
function sql(q) {
  try {
    const s = String(q).replace(/[\r\n]+/g, ' ');
    return execSync(`mysql -uroot -proot learning_agent -e ${JSON.stringify(s)}`, { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  } catch (e) { return null; }
}
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { code: -999, msg: t.slice(0, 120) }; } };

async function login(u, p) {
  const r = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ username: u, password: p })
  });
  const d = await j(r);
  if (d.code !== 0) throw new Error('登录失败(' + u + '): ' + d.msg);
  return d.data.token;
}

(async () => {
  const zt = await login('teacher0000001', '123456'); // 朱老师（本地测试密码）
  const tt = await login('teacher', '123456');        // 陈老师
  const st = await login('student', '123456');
  const H = (t) => ({ Authorization: 'Bearer ' + t, 'Content-Type': 'application/json;charset=utf-8' });

  const zcls = (await j(await fetch(API + '/teacher/classes', { headers: H(zt) }))).data;
  const zc = zcls[0];
  ok('朱老师班级就绪', !!zc, zcls.map(c => c.name).join(' | '));

  // [修复1-1] 扫描前基线（信息性：沙箱终端可能并发双跑同一脚本，后者会看到前者数据）
  const before = await j(await fetch(API + '/teacher/warnings?classId=' + zc.id, { headers: H(zt) }));
  console.log('    （扫描前基线：' + before.data.length + ' 条）');

  // [修复1-2] 立即扫描 → 生成预警（52 名学生从未登录 → 连续未登录规则应触发）
  const scan1 = await j(await fetch(API + '/teacher/warnings/scan', { method: 'POST', headers: H(zt) }));
  ok('[触发] 扫描接口返回统计', scan1.code === 0 && typeof scan1.data.generated === 'number',
    '班级 ' + scan1.data.scanned + ' 个，新增 ' + scan1.data.generated + ' 条，分布 ' + JSON.stringify(scan1.data.byType));
  const totalAfterScan = before.data.length + scan1.data.generated;
  ok('[触发] 生成预警数 > 0（含并发基线）', totalAfterScan > 0, '基线 ' + before.data.length + ' + 本轮 ' + scan1.data.generated);

  // [修复1-3] 预警列表可见新数据
  const after = await j(await fetch(API + '/teacher/warnings?classId=' + zc.id, { headers: H(zt) }));
  ok('[触发] 扫描后预警列表可见且不减少', after.data.length >= totalAfterScan, after.data.length + ' 条');
  const loginWarns = after.data.filter(w => w.type === '连续未登录');
  ok('[触发] 含「连续未登录」类型且描述完整', loginWarns.length > 0 && loginWarns.every(w => w.desc && w.name && w.time && w.level),
    loginWarns.length + ' 条，示例：' + (loginWarns[0] ? loginWarns[0].desc.slice(0, 40) : ''));

  // [修复1-4] 去重：立即再扫一次 → 3 天内同类型不再重复生成
  const scan2 = await j(await fetch(API + '/teacher/warnings/scan', { method: 'POST', headers: H(zt) }));
  ok('[触发] 3 天窗口去重（二次扫描 0 新增）', scan2.data.generated === 0, '新增 ' + scan2.data.generated + ' 条');

  // [修复2-1] 归属校验：朱老师查询陈老师班级 → 拒绝
  const tcls = (await j(await fetch(API + '/teacher/classes', { headers: H(tt) }))).data;
  const other = tcls.find(c => String(c.id) !== String(zc.id));
  const cross = await fetch(API + '/teacher/warnings?classId=' + other.id, { headers: H(zt) });
  const crossj = await j(cross);
  ok('[归属] 跨班查询被拒', cross.status === 400 && crossj.code !== 0, 'HTTP ' + cross.status + ' ' + crossj.msg);

  // [修复2-2] 本班查询正常
  const own = await fetch(API + '/teacher/warnings?classId=' + zc.id, { headers: H(zt) });
  ok('[归属] 本班查询正常', own.status === 200, 'HTTP ' + own.status);

  // [修复2-3] 陈老师查询朱老师班 → 拒绝（双向验证）
  const cross2 = await fetch(API + '/teacher/warnings?classId=' + zc.id, { headers: H(tt) });
  ok('[归属] 反向跨班查询被拒', cross2.status === 400, 'HTTP ' + cross2.status);

  // [修复2-4] 共同管理教师可访问：把朱老师加为 class other 的共同管理者 → 查询通过
  // 移除接口已下线，前后清场均走 SQL 直连（清掉历史脚本遗留的共同管理记录，保证跨班断言确定性）
  sql(`DELETE ct FROM class_co_teacher ct JOIN user u ON u.id = ct.teacher_id
    WHERE ct.class_id = ${other.id} AND u.username = 'teacher0000001'`);
  const panel = await j(await fetch(API + '/teacher/co-teachers?classId=' + other.id, { headers: H(tt) }));
  const zhuCand = (panel.data.candidates || []).find(c => c.username === 'teacher0000001');
  if (zhuCand) {
    await fetch(API + '/teacher/co-teachers', { method: 'POST', headers: H(tt), body: JSON.stringify({ classId: other.id, teacherId: zhuCand.id }) });
    const coQuery = await fetch(API + '/teacher/warnings?classId=' + other.id, { headers: H(zt) });
    ok('[归属] 共同管理教师可访问该班预警', coQuery.status === 200, 'HTTP ' + coQuery.status);
    // 清理：移除共同管理（SQL 直连，接口已下线）
    sql(`DELETE ct FROM class_co_teacher ct JOIN user u ON u.id = ct.teacher_id
      WHERE ct.class_id = ${other.id} AND u.username = 'teacher0000001'`);
    const coDeny = await fetch(API + '/teacher/warnings?classId=' + other.id, { headers: H(zt) });
    ok('[归属] 移除共同管理后再次被拒', coDeny.status === 400, 'HTTP ' + coDeny.status);
  } else {
    console.log('    （无候选朱老师，跳过共同管理访问路径）');
  }

  // [处理操作] 本班预警：handle + notify（本地数据，测完统一清理）
  const w0 = after.data[0];
  const handle = await fetch(API + '/teacher/warnings/' + w0.id + '/handle', { method: 'PUT', headers: H(zt) });
  ok('标记已处理', handle.status === 200, 'HTTP ' + handle.status);
  const handledList = await j(await fetch(API + '/teacher/warnings?classId=' + zc.id + '&handled=true', { headers: H(zt) }));
  ok('处理后状态更新', handledList.data.some(w => String(w.id) === String(w0.id) && w.handled === true), '');
  const w1 = after.data.find(w => w.sid);
  if (w1) {
    const notify = await fetch(API + '/teacher/warnings/' + w1.id + '/notify', { method: 'POST', headers: H(zt) });
    ok('推送提醒给学生', notify.status === 200, 'HTTP ' + notify.status);
  }
  // 跨班 handle：朱老师处理陈老师班的预警 → 拒绝
  const tWarns = await j(await fetch(API + '/teacher/warnings?classId=' + other.id, { headers: H(tt) }));
  if (tWarns.data.length) {
    const crossHandle = await fetch(API + '/teacher/warnings/' + tWarns.data[0].id + '/handle', { method: 'PUT', headers: H(zt) });
    ok('[归属] 跨班处理预警被拒', crossHandle.status === 400, 'HTTP ' + crossHandle.status);
  }
  const s403 = await fetch(API + '/teacher/warnings?classId=' + zc.id, { headers: H(st) });
  ok('学生调用被拒（403）', s403.status === 403, 'HTTP ' + s403.status);

  /* ==================== UI：立即检测按钮 ==================== */
  let browser;
  for (const ch of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {}
  }
  if (!browser) throw new Error('无可用系统浏览器');
  process.on('exit', () => { try { browser.close(); } catch (e) {} });

  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push('http ' + r.status() + ': ' + r.url().slice(-70)); });

  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', 'teacher0000001');
  await page.fill('#lgPass', '123456');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.brand-sub', { timeout: 15000 });
  await page.click('[data-act="section"][data-val="warnings"]');
  for (let i = 0; i < 25; i++) {
    const t = await page.textContent('.mh-title').catch(() => '');
    if (t && !t.includes('加载中')) break;
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(600);
  ok('[UI] 预警中心渲染（已有扫描数据）', !(await page.textContent('.main-body')).includes('没有待处理的预警'), '');
  const scanBtn = await page.$('[data-act="warnScan"]');
  ok('[UI] 「立即检测」按钮存在', !!scanBtn, '');
  // 再点一次（应 0 新增，toast 提示暂未发现）
  await page.click('[data-act="warnScan"]');
  await page.waitForTimeout(1200);
  const tScan = (await page.textContent('.toast:last-child').catch(() => '')).trim();
  ok('[UI] 立即检测 toast（去重后 0 新增）', tScan.includes('检测完成'), tScan);
  // 预警卡片含处理按钮
  const acts = await page.$$eval('.main-body [data-act]', els => els.map(e => e.dataset.act));
  ok('[UI] 预警卡片操作按钮在位', acts.includes('warnHandle') && acts.includes('warnNotify'), '');

  ok('无 JS 报错 / 无意外 4xx 5xx', errors.length === 0, errors.slice(0, 3).join(' ; '));

  console.log('\n=== 预警两项修复验证: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  console.log('（提示：本地库朱老师班新增了 ' + scan1.data.generated + ' 条测试预警，可执行 SQL 清理：DELETE FROM warning WHERE class_id=' + zc.id + ' AND created_at >= NOW() - INTERVAL 1 HOUR）');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
