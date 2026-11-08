/* 作业提交两类异常修复验证（发布→编辑→提交→批改全链路）
 * [异常1] 教师编辑已发布作业保存草稿 → 作业不降级 DRAFT → 学生列表条目不消失；
 *         学生提交（题目 id 稳定）不再「作答内容无效」
 * [异常2] 学生提交后教师编辑作业（不改题）→ 详情页「学生作答」正常回显、教师端批改有记录；
 *         教师改题（id 保留）后历史作答仍匹配
 * [容错] 提交报「作答内容无效」时前端自动刷新列表并引导重作答（route 模拟）
 * 结束删除测试作业（级联清理提交），无数据污染
 */
import { chromium } from 'playwright-core';
const BASE = 'http://localhost:8080';
const API = BASE + '/api';
const errors = [];
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '（' + detail + '）' : '')); }
};
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { code: -999, msg: t.slice(0, 100) }; } };

async function login(u) {
  const r = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ username: u, password: '123456' })
  });
  const d = await j(r);
  if (d.code !== 0) throw new Error('登录失败: ' + d.msg);
  return d.data.token;
}

const Q1 = { type: 'SINGLE', title: '下列关于 Java 继承的说法，正确的是？', options: [{ key: 'A', text: '支持多重继承' }, { key: 'B', text: 'super() 须在构造方法首行' }, { key: 'C', text: 'final 类可被继承' }, { key: 'D', text: '私有成员可直接访问' }], answer: ['B'], analysis: 'super() 必须第一行', difficulty: 0.5 };
const Q2 = { type: 'JUDGE', title: 'Java 中所有类都直接或间接继承自 Object 类。', answer: [true], analysis: '', difficulty: 0.8 };

(async () => {
  const tt = await login('teacher');
  const st = await login('student');
  const H = (t) => ({ Authorization: 'Bearer ' + t, 'Content-Type': 'application/json;charset=utf-8' });
  const now = new Date();
  const iso = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  const start = iso(new Date(now.getTime() - 3600e3));
  const end = iso(new Date(now.getTime() + 7 * 86400e3));

  // [1] 教师发布作业（ONGOING，2 题）
  const create = await j(await fetch(API + '/teacher/compose', {
    method: 'POST', headers: H(tt),
    body: JSON.stringify({ title: '提交链路修复验证-' + Date.now().toString().slice(-6), scoreMode: 'AVERAGE', startAt: start, endAt: end, status: 'ONGOING', kps: [], questions: [Q1, Q2] })
  }));
  ok('[发布] 组卷发布成功', create.code === 0 && create.data.questionCount === 2, 'id=' + create.data.id);
  const asId = create.data.id;
  const qIds0 = create.data.questions.map(q => q.id);
  ok('[发布] 题目 id 已返回', qIds0.length === 2, qIds0.join(','));

  // [2] 学生列表可见 + 提交
  const my1 = await j(await fetch(API + '/assignments/my', { headers: H(st) }));
  const a1 = my1.data.find(a => String(a.id) === String(asId));
  ok('[学生] 发布后列表可见', !!a1, '');
  const sub1 = await j(await fetch(API + '/assignments/' + asId + '/answer', {
    method: 'POST', headers: H(st),
    body: JSON.stringify({ answers: [{ questionId: qIds0[0], value: 'B' }, { questionId: qIds0[1], value: true }] })
  }));
  ok('[学生] 提交成功', sub1.code === 0 && sub1.data.autoScore != null, '自动评分 ' + sub1.data.autoScore);

  /* ==================== [异常1] 教师编辑已发布作业 → 保存草稿 ==================== */
  const edit1 = await j(await fetch(API + '/teacher/compose', {
    method: 'POST', headers: H(tt),
    body: JSON.stringify({ id: Number(asId), title: create.data.title, scoreMode: 'AVERAGE', startAt: start, endAt: end, status: 'DRAFT', kps: [],
      questions: [
        Object.assign({}, Q1, { id: Number(qIds0[0]) }),
        Object.assign({}, Q2, { id: Number(qIds0[1]) })
      ] })
  }));
  ok('[异常1] 编辑保存草稿后状态保持 ONGOING（不降级）', edit1.code === 0 && edit1.data.status === 'ongoing', 'status=' + edit1.data.status);
  const my2 = await j(await fetch(API + '/assignments/my', { headers: H(st) }));
  ok('[异常1] 学生列表条目不消失', my2.data.some(a => String(a.id) === String(asId)), '');
  const qIds1 = edit1.data.questions.map(q => q.id);
  ok('[异常1] 编辑后题目 id 保持稳定', qIds1[0] === qIds0[0] && qIds1[1] === qIds0[1], qIds1.join(','));

  /* ==================== [异常2] 学生提交回显 + 教师端数据 ==================== */
  const my3 = await j(await fetch(API + '/assignments/my', { headers: H(st) }));
  const a3 = my3.data.find(a => String(a.id) === String(asId));
  const subAnswers = a3 && a3.mySubmission && a3.mySubmission.answers;
  ok('[异常2] 学生详情作答回显（questionId 匹配）',
    !!subAnswers && subAnswers.length === 2 && subAnswers.every(x => String(x.questionId) === String(qIds0.find(id => id === x.questionId))),
    subAnswers ? subAnswers.map(x => x.questionId + '=' + JSON.stringify(x.value)).join(' ') : '无');
  const subs = await j(await fetch(API + '/teacher/assignments/' + asId + '/submissions', { headers: H(tt) }));
  const rec = (subs.data || []).find(s => String(s.studentId) === '2' || (s.name || '').includes('张明'));
  ok('[异常2] 教师端批改页有学生提交记录', subs.code === 0 && (subs.data || []).length >= 1,
    (subs.data || []).map(s => s.name + '(' + s.status + ')').join(','));

  // [异常2-进阶] 教师修改题干（id 保留）→ 历史作答仍匹配
  const edit2 = await j(await fetch(API + '/teacher/compose', {
    method: 'POST', headers: H(tt),
    body: JSON.stringify({ id: Number(asId), title: create.data.title, scoreMode: 'AVERAGE', startAt: start, endAt: end, status: 'ONGOING', kps: [],
      questions: [
        Object.assign({}, Q1, { id: Number(qIds0[0]), title: '（改）下列关于 Java 继承的说法，正确的是？' }),
        Object.assign({}, Q2, { id: Number(qIds0[1]) })
      ] })
  }));
  const my4 = await j(await fetch(API + '/assignments/my', { headers: H(st) }));
  const a4 = my4.data.find(a => String(a.id) === String(asId));
  ok('[异常2] 改题干（id 保留）后历史作答仍回显', a4 && a4.mySubmission && (a4.mySubmission.answers || []).length === 2, '');
  ok('[异常2] 改题后题目 id 仍稳定', edit2.data.questions[0].id === qIds0[0], '');

  // [差量] 教师删除第 2 题 + 新增 1 题 → 保留题匹配 / 新题无作答（合理）
  const edit3 = await j(await fetch(API + '/teacher/compose', {
    method: 'POST', headers: H(tt),
    body: JSON.stringify({ id: Number(asId), title: create.data.title, scoreMode: 'AVERAGE', startAt: start, endAt: end, status: 'ONGOING', kps: [],
      questions: [
        Object.assign({}, Q1, { id: Number(qIds0[0]) }),
        { type: 'SINGLE', title: '新增题：哪个关键字防止类被继承？', options: [{ key: 'A', text: 'static' }, { key: 'B', text: 'final' }], answer: ['B'], analysis: '', difficulty: 0.5 }
      ] })
  }));
  const keptId = edit3.data.questions[0].id;
  const newId = edit3.data.questions[1].id;
  const deletedCount = await j(await fetch(API + '/teacher/assignments', { headers: H(tt) })).then(r =>
    r.data.find(a => String(a.id) === String(asId)));
  ok('[差量] 删旧增新：保留题 id 不变、新题新 id', keptId === qIds0[0] && newId !== qIds0[1], '保留 ' + keptId + ' / 新 ' + newId);

  /* ==================== [容错] 提交「作答内容无效」自动刷新（UI） ==================== */
  let browser;
  for (const ch of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {}
  }
  if (!browser) throw new Error('无可用系统浏览器');
  process.on('exit', () => { try { browser.close(); } catch (e) {} });

  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  // 先建第二份作业再打开页面（页面 boot 时拉取列表才会包含它）
  const create2 = await j(await fetch(API + '/teacher/compose', {
    method: 'POST', headers: H(tt),
    body: JSON.stringify({ title: '容错验证-' + Date.now().toString().slice(-6), scoreMode: 'AVERAGE', startAt: start, endAt: end, status: 'ONGOING', kps: [], questions: [Q1] })
  }));
  const asId2 = create2.data.id;

  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', 'student');
  await page.fill('#lgPass', '123456');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.brand-sub', { timeout: 15000 });
  // 拦截提交接口模拟「作答内容无效」（教师换题后旧缓存提交场景）
  await page.route('**/api/assignments/*/answer', r => r.fulfill({
    status: 400, contentType: 'application/json',
    body: JSON.stringify({ code: 400, msg: '作答内容无效' })
  }));
  await page.click('[data-act="section"][data-val="homework"]');
  // 学生登录默认在 chat 页（标题为会话名不含「加载中」），改为直接等作业卡片渲染
  await page.waitForSelector('.card[id^="hw-"]', { timeout: 20000 });
  await page.click('#hw-' + asId2 + ' [data-act="openAnswer"]');
  await page.waitForSelector('.compose-mask', { timeout: 8000 });
  // 选一个答案 → 提交（确认弹窗 → 确认；被拦截返回作答内容无效）
  await page.click('.ans-opt input[type="radio"]');
  await page.click('[data-act="answerSubmit"]');
  await page.waitForSelector('.modal [data-act="ansDoSubmit"]', { timeout: 5000 });
  await page.click('.modal [data-act="ansDoSubmit"]');
  await page.waitForTimeout(1500);
  const tErr = (await page.textContent('.toast:last-child').catch(() => '')).trim();
  ok('[容错] 「作答内容无效」时提示作业已更新并引导重作答', tErr.includes('已被教师更新'), tErr);
  await page.unroute('**/api/assignments/*/answer');
  // 解除拦截后重试提交（容错分支保留作答界面与已选答案，直接再提交）
  await page.click('[data-act="answerSubmit"]');
  await page.waitForSelector('.modal [data-act="ansDoSubmit"]', { timeout: 5000 });
  await page.click('.modal [data-act="ansDoSubmit"]');
  await page.waitForTimeout(1500);
  const tOk = (await page.textContent('.toast:last-child').catch(() => '')).trim();
  ok('[容错] 恢复后重试提交成功', tOk.includes('已提交'), tOk);
  ok('无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' ; '));

  // [清理] 删除两份测试作业（级联删除提交）
  await fetch(API + '/teacher/assignments/' + asId, { method: 'DELETE', headers: H(tt) });
  await fetch(API + '/teacher/assignments/' + asId2, { method: 'DELETE', headers: H(tt) });
  const myEnd = await j(await fetch(API + '/assignments/my', { headers: H(st) }));
  ok('清理完成（测试作业已删除，无数据污染）', !myEnd.data.some(a => String(a.id) === String(asId) || String(a.id) === String(asId2)), '');

  console.log('\n=== 作业提交链路修复验证: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
