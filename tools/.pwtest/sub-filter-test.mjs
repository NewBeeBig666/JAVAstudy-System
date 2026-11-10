/* 教师端「提交批改」提交状态筛选功能 E2E
 * [位置] 筛选按钮位于「导出学生作业」左侧、同尺寸间距；筛选面板两项（已提交/未提交）+全部
 * [交互] 点击筛选 → 面板展开（含计数）→ 选择实时更新列表；筛选状态标识徽章 + 一键清除；
 *        清除后完整列表；行点击批改交互不受影响；切换作业筛选重置；空筛选结果提示
 * [响应式] 375px 下按钮可见可点、面板不溢出视口
 */
import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
const BASE = 'http://localhost:8080';
const API = BASE + '/api';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '（' + detail + '）' : '')); }
};
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { code: -999, msg: t.slice(0, 120) }; } };

async function login(u, p) {
  const r = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ username: u, password: p || '123456' })
  });
  const d = await j(r);
  if (d.code !== 0) throw new Error('登录失败: ' + d.msg);
  return d.data.token;
}
function sql(q) {
  try {
    const s = String(q).replace(/[\r\n]+/g, ' ');
    return execSync(`mysql -uroot -proot learning_agent -e ${JSON.stringify(s)}`, { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  } catch (e) { return null; }
}
const fmt = (ts) => {
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
};

(async () => {
  const tt = await login('teacher');
  const st2 = await login('s02');
  const H = { Authorization: 'Bearer ' + tt, 'Content-Type': 'application/json;charset=utf-8' };

  // 造数：班级1 发布一份作业（12 名学生，提交分布便于筛选：让部分学生提交）
  const stamp = Date.now().toString(36);
  ["DELETE FROM lab_group_invite WHERE assignment_id IN (SELECT id FROM assignment WHERE title LIKE 'E2E-SUBFLT-%')",
   "DELETE FROM lab_group_member WHERE assignment_id IN (SELECT id FROM assignment WHERE title LIKE 'E2E-SUBFLT-%')",
   "DELETE FROM lab_group WHERE assignment_id IN (SELECT id FROM assignment WHERE title LIKE 'E2E-SUBFLT-%')",
   "DELETE FROM submission WHERE assignment_id IN (SELECT id FROM assignment WHERE title LIKE 'E2E-SUBFLT-%')",
   "DELETE FROM question WHERE assignment_id IN (SELECT id FROM assignment WHERE title LIKE 'E2E-SUBFLT-%')",
   "DELETE FROM rubric WHERE assignment_id IN (SELECT id FROM assignment WHERE title LIKE 'E2E-SUBFLT-%')",
   "DELETE FROM assignment WHERE title LIKE 'E2E-SUBFLT-%'"
  ].forEach(q => sql(q));
  const c1 = await j(await fetch(API + '/teacher/compose', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      classId: 1, title: 'E2E-SUBFLT-' + stamp, scoreMode: 'AVERAGE', status: 'ONGOING',
      startAt: fmt(Date.now()), endAt: fmt(Date.now() + 7 * 864e5), kps: [],
      questions: [{ id: null, type: 'SINGLE', title: 'filter test', options: [{ key: 'A', text: 'aa' }, { key: 'B', text: 'bb' }], answer: ['A'] }]
    })
  }));
  ok('[造数] 测试作业发布', c1.code === 0, 'id=' + c1.data.id);
  const asId = c1.data.id;
  const asTitle = c1.data.title;
  const qId = c1.data.questions[0].id;
  // s02 提交 → 全班 12 人：1 已提交 + 11 未提交
  const sub1 = await j(await fetch(API + '/assignments/' + asId + '/answer', {
    method: 'POST', headers: { Authorization: 'Bearer ' + st2, 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ answers: [{ questionId: String(qId), value: 'A' }] })
  }));
  ok('[造数] 学生李思远提交作业', sub1.code === 0, '');

  let browser;
  for (const ch of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {}
  }
  if (!browser) throw new Error('无可用系统浏览器');
  process.on('exit', () => { try { browser.close(); } catch (e) {} });
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push('http ' + r.status() + ': ' + r.url().slice(-60)); });

  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', 'teacher');
  await page.fill('#lgPass', '123456');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.brand-sub', { timeout: 15000 });
  for (let i = 0; i < 30; i++) {
    const t = await page.textContent('.mh-title').catch(() => '');
    if (t && !t.includes('加载中')) break;
    await page.waitForTimeout(300);
  }
  await page.click('[data-act="section"][data-val="submissions"]');
  // 左侧栏选中测试作业
  await page.click('#side .list-item[data-act="subAsPick"][data-val="' + asId + '"]').catch(() => {});
  await page.waitForTimeout(1500);
  const rowAll = await page.$$('table.table tbody tr');
  ok('[初始] 默认展示完整名单 12 行', rowAll.length === 12, rowAll.length + ' 行');

  // 1. 按钮位置：「导出学生作业」左侧、同排
  const filterBtn = await page.$('[data-act="subFilterMenu"]');
  const exportBtn = await page.$('[data-act="exportSubs"]');
  ok('[位置] 筛选按钮存在且位于「导出学生作业」左侧', !!(filterBtn && exportBtn), '');
  if (filterBtn && exportBtn) {
    const fb = await filterBtn.boundingBox(), eb = await exportBtn.boundingBox();
    const sameRow = Math.abs(fb.y - eb.y) < 8, onLeft = fb.x + fb.width <= eb.x;
    ok('[位置] 与导出按钮同一行且在其左侧', sameRow && onLeft,
      '筛选 x=' + Math.round(fb.x) + ' 导出 x=' + Math.round(eb.x));
    const fs = await page.$eval('[data-act="subFilterMenu"]', e => e.className);
    const es = await page.$eval('[data-act="exportSubs"]', e => e.className);
    ok('[样式] 按钮尺寸样式与现有按钮统一（同 btn sm 规格）',
      fs.includes('btn') && fs.includes('sm') && es.includes('btn') && es.includes('sm'), fs + ' / ' + es);
  }

  // 2. 点击筛选 → 面板展开（三项含计数）
  await page.click('[data-act="subFilterMenu"]');
  await page.waitForSelector('.as-menu', { timeout: 5000 });
  const menuTxt = (await page.textContent('.as-menu')).trim();
  ok('[面板] 筛选面板含两选项与全部（带计数）',
    menuTxt.includes('已提交作业学生（1 人）') && menuTxt.includes('未提交作业学生（11 人）') && menuTxt.includes('全部学生（12 人）'), menuTxt.replace(/\s+/g, ' '));

  // 3. 选择「已提交作业学生」→ 列表实时更新为 1 行（李思远）
  await page.click('.as-menu [data-act="subFilter"][data-val="submitted"]');
  await page.waitForTimeout(800);
  const rowsSub = await page.$$('table.table tbody tr');
  const listTxt1 = await page.textContent('#main');
  ok('[筛选] 已提交名单：1 行且为李思远', rowsSub.length === 1 && listTxt1.includes('李思远'), rowsSub.length + ' 行');
  ok('[标识] 筛选状态标识徽章显示', listTxt1.includes('筛选中：仅显示已提交学生（1 / 12 人）'), '');
  ok('[标识] 筛选按钮高亮并显示当前条件', await page.$eval('[data-act="subFilterMenu"]', e => e.className.includes('brand') && e.textContent.includes('已提交')), '');
  ok('[清除] 一键清除按钮可见', !!(await page.$('[data-act="subFilterClear"]')), '');

  // 4. 行点击批改交互不受影响（筛选态下打开批改抽屉）
  await page.click('table.table tbody tr');
  await page.waitForSelector('.grade-mask', { timeout: 10000 });
  ok('[交互] 筛选态下行点击批改抽屉正常打开', (await page.textContent('.grade-mask')).includes('李思远'), '');
  await page.click('[data-act="closeGradePage"]').catch(() => {});
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);

  // 5. 切换筛选为「未提交」→ 11 行，不含李思远
  await page.click('[data-act="subFilterMenu"]');
  await page.waitForSelector('.as-menu', { timeout: 5000 });
  await page.click('.as-menu [data-act="subFilter"][data-val="missing"]');
  await page.waitForTimeout(800);
  const rowsMiss = await page.$$('table.table tbody tr');
  const listTxt2 = await page.textContent('#main');
  ok('[筛选] 未提交名单：11 行且不含已提交学生', rowsMiss.length === 11 && !listTxt2.includes('李思远'), rowsMiss.length + ' 行');

  // 6. 一键清除 → 恢复完整 12 行
  await page.click('[data-act="subFilterClear"]');
  await page.waitForTimeout(600);
  const rowsAll2 = await page.$$('table.table tbody tr');
  ok('[清除] 恢复完整名单 12 行', rowsAll2.length === 12, rowsAll2.length + ' 行');
  ok('[清除] 筛选标识消失、按钮恢复默认态',
    !(await page.$('[data-act="subFilterClear"]')) && await page.$eval('[data-act="subFilterMenu"]', e => !e.className.includes('brand')), '');

  // 7. 切换作业 → 筛选自动重置（选 missing 后切回第一份作业再切回）
  await page.click('[data-act="subFilterMenu"]');
  await page.waitForSelector('.as-menu', { timeout: 5000 });
  await page.click('.as-menu [data-act="subFilter"][data-val="missing"]');
  await page.waitForTimeout(600);
  const firstAs = await page.$eval('#side .list-item[data-act="subAsPick"]', e => e.dataset.val);
  await page.click('#side .list-item[data-act="subAsPick"][data-val="' + firstAs + '"]');
  await page.waitForTimeout(1200);
  await page.click('#side .list-item[data-act="subAsPick"][data-val="' + asId + '"]');
  await page.waitForTimeout(1500);
  const rowsAfterSwitch = await page.$$('table.table tbody tr');
  const btnTxtAfter = await page.$eval('[data-act="subFilterMenu"]', e => e.textContent);
  ok('[重置] 切换作业后筛选自动重置（完整 12 行 + 按钮无筛选态）',
    rowsAfterSwitch.length === 12 && !btnTxtAfter.includes('·'), rowsAfterSwitch.length + ' 行 / ' + btnTxtAfter.trim());

  // 8. 空筛选结果提示（再造一份全班未提交的作业 → 筛已提交 → 空态提示）
  const c2 = await j(await fetch(API + '/teacher/compose', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      classId: 1, title: 'E2E-SUBFLT-NOSUB-' + stamp, scoreMode: 'AVERAGE', status: 'ONGOING',
      startAt: fmt(Date.now()), endAt: fmt(Date.now() + 7 * 864e5), kps: [],
      questions: [{ id: null, type: 'SINGLE', title: 'no sub test', options: [{ key: 'A', text: 'aa' }, { key: 'B', text: 'bb' }], answer: ['A'] }]
    })
  }));
  await page.click('#side .list-item[data-act="subAsPick"][data-val="' + c2.data.id + '"]').catch(async () => {
    // 侧栏作业列表不会自动出现新发布的作业（页面 DB 未刷新）：重载页面重新拉取
    await page.reload();
    await page.waitForSelector('.brand-sub', { timeout: 15000 });
    for (let i = 0; i < 30; i++) {
      const t = await page.textContent('.mh-title').catch(() => '');
      if (t && !t.includes('加载中')) break;
      await page.waitForTimeout(300);
    }
    await page.click('[data-act="section"][data-val="submissions"]');
    await page.waitForTimeout(1000);
    await page.click('#side .list-item[data-act="subAsPick"][data-val="' + c2.data.id + '"]');
  });
  await page.waitForTimeout(1500);
  await page.click('[data-act="subFilterMenu"]');
  await page.waitForSelector('.as-menu', { timeout: 5000 });
  await page.click('.as-menu [data-act="subFilter"][data-val="submitted"]');
  await page.waitForTimeout(800);
  const emptyTxt = await page.textContent('table.table tbody');
  ok('[空态] 无匹配筛选时提示并可点击清除', emptyTxt.includes('没有学生') && emptyTxt.includes('清除筛选'), '');

  ok('无 JS 报错 / 无意外 4xx 5xx', errors.length === 0, errors.slice(0, 3).join(' ; '));

  // 9. 响应式 375px：按钮可见、面板不溢出视口
  const mp = await (await browser.newContext({ viewport: { width: 375, height: 700 } })).newPage();
  mp.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await mp.goto(BASE + '/login.html');
  await mp.fill('#lgUser', 'teacher');
  await mp.fill('#lgPass', '123456');
  await mp.click('button[type="submit"]');
  // 窄屏下顶栏 .brand-sub 折叠为隐藏，改等主区域标题渲染完成
  await mp.waitForSelector('.mh-title', { timeout: 15000 });
  for (let i = 0; i < 30; i++) {
    const t = await mp.textContent('.mh-title').catch(() => '');
    if (t && !t.includes('加载中')) break;
    await mp.waitForTimeout(300);
  }
  await mp.click('[data-act="section"][data-val="submissions"]');
  await mp.waitForSelector('[data-act="subFilterMenu"]', { timeout: 20000 });
  const mfBtn = await mp.$('[data-act="subFilterMenu"]');
  const mfb = await mfBtn.boundingBox();
  ok('[375px] 筛选按钮可见且在视口内', mfb.x >= 0 && mfb.x + mfb.width <= 375 && mfb.y >= 0, JSON.stringify({ x: Math.round(mfb.x), w: Math.round(mfb.width) }));
  await mfBtn.click();
  await mp.waitForSelector('.as-menu', { timeout: 5000 });
  const mMenu = await mp.$eval('.as-menu', e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right }; });
  ok('[375px] 筛选面板不溢出视口', mMenu.l >= 0 && mMenu.r <= 375, JSON.stringify(mMenu));
  await mp.click('.as-menu [data-act="subFilter"][data-val="missing"]');
  await mp.waitForTimeout(800);
  const mRows = await mp.$$('table.table tbody tr');
  ok('[375px] 筛选功能正常（未提交名单）', mRows.length >= 1, mRows.length + ' 行');

  // 清场
  const del1 = await fetch(API + '/teacher/assignments/' + asId, { method: 'DELETE', headers: H });
  const del2 = await fetch(API + '/teacher/assignments/' + c2.data.id, { method: 'DELETE', headers: H });
  ok('[清场] 测试作业全部删除', del1.status === 200 && del2.status === 200, '');

  console.log('\n=== 提交批改筛选功能 E2E: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
