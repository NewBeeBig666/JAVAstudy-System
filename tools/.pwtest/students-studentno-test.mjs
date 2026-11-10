/* 教师端「班级学生」学生列表学号展示验证
 * [数据] /teacher/students 每生返回 studentNo 且与 user.student_no 一致
 * [UI] 姓名下方新增学号行（11.5px 辅助文字规范）；学号与姓名准确关联；
 *       无学号学生显示「—」；原有列与行点击打开学生档案的交互不受影响
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
function sql(q) {
  try {
    const s = String(q).replace(/[\r\n]+/g, ' ');
    return execSync(`mysql -uroot -proot learning_agent -e ${JSON.stringify(s)}`, { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  } catch (e) { return null; }
}
const sqlVal = (q) => {
  const out = sql(q);
  if (!out) return null;
  const line = out.replace(/\r/g, '').trim().split('\n')[1];
  return line ? line.trim() : null;
};

(async () => {
  // 造一个无学号学生（验证空值展示），结束后清理
  sql(`INSERT INTO user (username, password_hash, real_name, role, student_no, class_id) VALUES ('nostu_test', '$2a$10$lRIP406sPNtpi3ZeEntTm.Eu0fp9ZCIESRYdsL8Hlay0O0CMjaMDu', 'NoStuTest', 'STUDENT', NULL, 1) ON DUPLICATE KEY UPDATE student_no = NULL`);
  const noStuId = sqlVal("SELECT id FROM user WHERE username = 'nostu_test'");

  const lg = await j(await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ username: 'teacher', password: '123456' })
  }));
  const tt = lg.data.token;
  const H = { Authorization: 'Bearer ' + tt, 'Content-Type': 'application/json;charset=utf-8' };

  /* 1) API：studentNo 字段与数据一致性 */
  const list = await j(await fetch(API + '/teacher/students?classId=1', { headers: H }));
  const students = list.data || [];
  ok('[API] 学生列表可用', students.length > 0, students.length + ' 人');
  let allMatch = true, missCnt = 0;
  for (const s of students) {
    const dbNo = sqlVal(`SELECT student_no FROM user WHERE id = ${s.id}`);
    const dbNoTrim = dbNo === 'NULL' || dbNo == null ? '' : dbNo;
    if ((s.studentNo || '') !== dbNoTrim) { allMatch = false; console.log('    不匹配: id=' + s.id + ' api=' + s.studentNo + ' db=' + dbNoTrim); }
    if (!s.studentNo) missCnt++;
  }
  ok('[API] 每生 studentNo 与库内 user.student_no 一致', allMatch, '抽查 ' + students.length + ' 人');
  ok('[API] 无学号学生 studentNo 为空串', students.some(s => String(s.id) === String(noStuId)) && students.find(s => String(s.id) === String(noStuId)).studentNo === '', 'id=' + noStuId);

  /* 2) UI：姓名下方学号行 + 关联正确 + 空值展示 + 交互不受影响 */
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
  await page.click('[data-act="section"][data-val="students"]');
  await page.waitForSelector('table.table tbody tr', { timeout: 20000 });

  // 2.1 每行姓名下方均渲染学号行
  const rows = await page.$$('table.table tbody tr');
  const withNo = await page.$$eval('table.table tbody tr td:first-child div',
    els => els.filter(e => e.textContent.startsWith('学号')).length);
  ok('[UI] 每位学生姓名下方均有学号行', rows.length === withNo && rows.length > 0, rows.length + ' 行 / 学号行 ' + withNo + ' 个');
  const noFont = await page.$eval('table.table tbody tr td:first-child div', e => getComputedStyle(e));
  ok('[UI] 学号行样式符合界面规范（辅助文字 11.5px / 次级色）',
    noFont.fontSize === '11.5px', noFont.fontSize + ' / ' + noFont.color);

  // 2.2 学号与姓名准确关联（API 数据对照抽查首行与「张明」）
  const first = students[0];
  const firstCell = (await page.$eval('table.table tbody tr td:first-child', e => e.textContent.trim()));
  ok('[UI] 首行学号与该生姓名正确关联',
    firstCell.includes(first.name) && firstCell.includes(first.studentNo || '—'),
    firstCell.replace(/\s+/g, ' '));
  const zhang = students.find(s => s.name === '张明');
  const zhangCell = await page.$$eval('table.table tbody tr td:first-child',
    els => (els.find(e => e.textContent.includes('张明')) || {}).textContent || '').then(t => t.trim());
  ok('[UI] 张明行学号 2023211024 准确关联', zhangCell.includes('张明') && zhangCell.includes(zhang.studentNo), zhangCell.replace(/\s+/g, ' '));
  // 2.3 无学号学生显示 —
  const noStuCell = await page.$$eval('table.table tbody tr td:first-child',
    els => (els.find(e => e.textContent.includes('NoStuTest')) || {}).textContent || '').then(t => t.trim());
  ok('[UI] 无学号学生显示「学号 —」', noStuCell.includes('NoStuTest') && noStuCell.includes('学号 —'), noStuCell.replace(/\s+/g, ' '));
  // 2.4 交互不受影响：点击行 → 学生档案打开，档案卡头部展示该生学号
  await page.click('table.table tbody tr');
  await page.waitForTimeout(800);
  const bodyTxt = (await page.textContent('#main').catch(() => ''));
  ok('[UI] 行点击打开学生档案交互正常', bodyTxt.includes('学生档案'), '');
  const profileHead = (await page.$$eval('.card-head h3', els => {
    const hit = els.find(e => e.textContent.includes('学生档案'));
    return hit && hit.parentElement ? hit.parentElement.textContent : '';
  }).catch(() => '')).trim();
  ok('[UI] 档案卡头部展示该生学号并与选中行一致',
    profileHead.includes('学生档案') && profileHead.includes('学号 ' + (first.studentNo || '—'))
    && profileHead.includes(first.name), profileHead.replace(/\s+/g, ' '));
  ok('无 JS 报错 / 无意外 4xx 5xx', errors.length === 0, errors.slice(0, 2).join(' ; '));

  /* 3) 清场 */
  sql(`DELETE FROM user WHERE username = 'nostu_test'`);
  const left = sqlVal("SELECT COUNT(*) FROM user WHERE username = 'nostu_test'");
  ok('[清场] 测试学生已删除', left === '0', '');

  console.log('\n=== 学生列表学号展示验证: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
