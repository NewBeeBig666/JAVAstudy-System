/* 「项目代码」左侧项目目录树 E2E 全链路
 * [目录] 树形折叠分组（教师=上架中/已下架；学生=开发中/已提交/未开始）· 点击切换聚焦项目
 * [交互] 点击项目项主区立即切换（响应 < 200ms）· 选中高亮同步 · 折叠/展开局部更新 · 多项目滚动
 * [加载] 切换过程加载状态提示 · 教师内联进度 4 秒轮询实时增量 · 学生最新代码与版本记录
 * [回归] 编辑/上下架（目录分组迁移）/删除 · 权限差异化列表
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
    return execSync(`mysql -uroot -proot learning_agent -e ${JSON.stringify(String(q).replace(/[\r\n]+/g, ' '))}`,
      { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  } catch (e) { return null; }
}
async function loginUi(page, u, p) {
  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', u);
  await page.fill('#lgPass', p || '123456');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.brand-sub', { timeout: 15000 });
}
const navOrder = (page) => page.$$eval('.act-btn[data-act="section"]', els => els.map(e => e.title || ''));
const pubItem = (page, title) => page.locator('#projFolderItems-pub [data-act="projectPick"]', { hasText: title });

(async () => {
  const stamp = Date.now().toString(36);
  const T1 = 'E2E-DIR-' + stamp + '-A 图书管理系统';
  const T2 = 'E2E-DIR-' + stamp + '-B 排序算法可视化';
  const T1q = 'E2E-DIR-' + stamp + '-A';
  const T2q = 'E2E-DIR-' + stamp + '-B';
  const T = await login('teacher');
  const S = await login('student');
  const H = { Authorization: 'Bearer ' + T, 'Content-Type': 'application/json;charset=utf-8' };
  const HS = { Authorization: 'Bearer ' + S, 'Content-Type': 'application/json;charset=utf-8' };
  // 清理历史测试数据
  ["DELETE FROM project_version WHERE student_project_id IN (SELECT sp.id FROM student_project sp JOIN coding_project p ON sp.project_id=p.id WHERE p.title LIKE 'E2E-DIR-%')",
   "DELETE FROM student_project WHERE project_id IN (SELECT id FROM coding_project WHERE title LIKE 'E2E-DIR-%')",
   "DELETE FROM coding_project WHERE title LIKE 'E2E-DIR-%'"].forEach(q => sql(q));
  const publish = async (title) => j(await fetch(API + '/teacher/projects', {
    method: 'POST', headers: H, body: JSON.stringify({ classId: 1, title, description: title + '：需求说明——实现核心功能，控制台交互，代码结构清晰。' })
  }));

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

  console.log('\n== A. 教师端：目录树 + 发布 + 点击切换 ==');
  await loginUi(page, 'teacher');
  await page.waitForSelector('[data-act="section"][data-val="assignments"]', { timeout: 15000 });
  const order = await navOrder(page);
  const ti = order.indexOf('知识图谱'), pi = order.indexOf('项目代码'), ai = order.indexOf('作业管理');
  ok('教师导航顺序：知识图谱 → 项目代码 → 作业管理', ti >= 0 && pi === ti + 1 && ai === pi + 1, order.join('/'));
  await page.click('[data-act="section"][data-val="projects"]');
  await page.waitForFunction(() => (document.querySelector('.mh-title') || {}).textContent === '项目代码');
  ok('侧栏出现「项目目录」标题', await page.locator('.side-title', { hasText: '项目目录' }).count() === 1);
  await page.waitForSelector('#projFolderRow-pub', { timeout: 10000 }); // 等目录数据异步加载完成（冷启动首轮 API 慢）
  ok('教师目录分组：上架中 / 已下架', await page.locator('#projFolderRow-pub .asf-name', { hasText: '上架中' }).count() === 1
    && await page.locator('#projFolderRow-off .asf-name', { hasText: '已下架' }).count() === 1);

  // UI 发布项目 A（选中项保持不变——IDE 目录习惯；点击新项目项聚焦）
  await page.click('[data-act="projectComposeModal"]');
  await page.waitForSelector('.modal');
  await page.fill('.modal [data-bind="modal"][data-key="title"]', T1);
  await page.fill('.modal [data-bind="modal"][data-key="description"]', '实现图书信息增删改查、借阅登记与按书名检索。');
  await page.click('.modal [data-act="doProjectSave"]');
  await page.waitForSelector('#projFolderItems-pub [data-act="projectPick"]:has-text("' + T1q + '")', { timeout: 8000 });
  ok('新项目进入「上架中」分组', await pubItem(page, T1q).count() === 1);
  await pubItem(page, T1q).click();
  await page.waitForSelector('.card:has-text("' + T1q + '")', { timeout: 8000 });
  ok('点击目录项后主区聚焦新项目', true);
  ok('选中项目高亮标识（.on）', (await pubItem(page, T1q).getAttribute('class')).includes('on'));
  await page.waitForSelector('#projectProgressMain', { timeout: 8000 });
  ok('主区内联「学生进度」卡片', true);

  // API 发布项目 B → 刷新目录 → 点击切换
  const p2 = await publish(T2);
  ok('[造数] API 发布项目 B', p2.code === 0, 'id=' + p2.data.id);
  await page.click('[data-act="projectNavRefresh"]');
  await page.waitForFunction((t) => Array.from(document.querySelectorAll('#projFolderItems-pub [data-act="projectPick"]')).some(b => b.textContent.includes(t)), T2q, { timeout: 8000 });
  // 加载状态提示：拦截进度接口延迟响应，保证切换瞬间的加载态可观测
  await page.route('**/api/teacher/projects/*/progress', async (route) => {
    await new Promise(r => setTimeout(r, 600));
    try { await route.continue(); } catch (e) { /* unroute 后在途请求已被处置，忽略 */ }
  });
  const switchMs = await page.evaluate((title) => {
    const btn = Array.from(document.querySelectorAll('#projFolderItems-pub [data-act="projectPick"]')).find(b => b.textContent.includes(title));
    const t0 = performance.now();
    btn.click();
    return performance.now() - t0; // 渲染同步完成，即交互响应耗时
  }, T2q);
  const loadingShown = (await page.textContent('#projectProgressMain')).includes('加载中');
  ok('切换过程出现加载状态提示', loadingShown, (await page.textContent('#projectProgressMain')).trim().slice(0, 20));
  await page.unroute('**/api/teacher/projects/*/progress');
  await page.waitForFunction(() => (document.querySelector('#projectProgressMain') || {}).textContent.includes('学生尚未创建项目'), null, { timeout: 8000 });
  ok('目录点击切换响应 < 200ms', switchMs < 200, switchMs.toFixed(0) + 'ms');
  ok('主区切换为项目 B 内容', (await page.locator('.card-head h3').first().textContent()).includes(T2q));
  ok('高亮随切换同步到项目 B', (await pubItem(page, T2q).getAttribute('class')).includes('on')
    && !(await pubItem(page, T1q).getAttribute('class')).includes('on'));

  // 折叠/展开
  await page.click('#projFolderRow-pub');
  ok('点击分组行收起（IDE 折叠习惯）', (await page.locator('#projFolderItems-pub').evaluate(el => getComputedStyle(el).display)) === 'none'
    && (await page.locator('#projFolderRow-pub').getAttribute('class')).includes('closed'));
  await page.click('#projFolderRow-pub');
  ok('再次点击重新展开', (await page.locator('#projFolderItems-pub').evaluate(el => getComputedStyle(el).display)) !== 'none');

  // 多项目滚动适配：再造 12 个项目（压低视口高度确保溢出，验证目录可滚动）
  for (let i = 1; i <= 12; i++) await publish('E2E-DIR-' + stamp + '-S' + i + ' 练习项目' + i);
  await page.click('[data-act="projectNavRefresh"]');
  await page.waitForFunction((t) => Array.from(document.querySelectorAll('#projFolderItems-pub [data-act="projectPick"]')).filter(b => b.textContent.includes(t)).length === 14, 'E2E-DIR-' + stamp, { timeout: 8000 });
  await page.setViewportSize({ width: 1360, height: 560 });
  await page.waitForTimeout(200);
  const scroll = await page.evaluate(() => {
    const sb = document.querySelector('.side-body');
    return { sh: sb.scrollHeight, ch: sb.clientHeight };
  });
  await page.setViewportSize({ width: 1360, height: 900 });
  ok('14 个项目目录可滚动浏览', scroll.sh > scroll.ch, 'scrollHeight=' + scroll.sh + ' > clientHeight=' + scroll.ch);
  // 切回项目 A（选中状态恢复）
  await pubItem(page, T1q).click();
  await page.waitForFunction(() => (document.querySelector('.mh-title') || {}).textContent === '项目代码');

  console.log('\n== B. 学生端：目录权限差异化 + 创建 + 多版本 + 代码聚焦 ==');
  const ctxS = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const sp = await ctxS.newPage();
  sp.on('pageerror', e => errors.push('stu pageerror: ' + e.message));
  await loginUi(sp, 'student');
  await sp.waitForSelector('[data-act="section"][data-val="homework"]', { timeout: 15000 });
  const sOrder = await navOrder(sp);
  const sti = sOrder.indexOf('知识图谱'), spi = sOrder.indexOf('项目代码'), shi = sOrder.indexOf('我的作业');
  ok('学生导航顺序：知识图谱 → 项目代码 → 我的作业', sti >= 0 && spi === sti + 1 && shi === spi + 1, sOrder.join('/'));
  await sp.click('[data-act="section"][data-val="projects"]');
  await sp.waitForFunction(() => (document.querySelector('.mh-title') || {}).textContent === '项目代码');
  await sp.waitForSelector('#projFolderRow-new', { timeout: 8000 }); // 等目录数据加载完成
  // 学生只见本班上架项目（不含教师视角的统计），分组为 开发中/已提交/未开始
  ok('学生目录分组：开发中 / 已提交 / 未开始', await sp.locator('#projFolderRow-dev .asf-name', { hasText: '开发中' }).count() === 1
    && await sp.locator('#projFolderRow-sub .asf-name', { hasText: '已提交' }).count() === 1
    && await sp.locator('#projFolderRow-new .asf-name', { hasText: '未开始' }).count() === 1);
  ok('学生目录不含「已下架」分组（权限差异化）', await sp.locator('#projFolderRow-off').count() === 0);

  const stuItem = (g, title) => sp.locator('#projFolderItems-' + g + ' [data-act="projectPick"]', { hasText: title });
  await stuItem('new', T1q).click();
  await sp.waitForSelector('.card:has-text("' + T1q + '")', { timeout: 8000 });
  ok('点击目录项聚焦项目 A（未开始徽章）', (await sp.locator('.card .badge').first().textContent()) === '未开始');
  ok('选中高亮同步', (await stuItem('new', T1q).getAttribute('class')).includes('on'));

  // 创建项目 → 跳转独立 IDE 页 → 编写保存 v1 → 返回（项目代码页显示最新代码与版本记录）
  await sp.locator('.card', { hasText: T1q }).locator('[data-act="projectStart"]').click();
  await sp.waitForSelector('#ceTa', { timeout: 10000 });
  const spUrl = sp.url();
  ok('点击编写跳转独立代码工作台（ide.html）', spUrl.includes('ide.html?sp='), spUrl.split('?')[1] || '');
  await sp.fill('#ceTa', 'public class Main {\n  public static void main(String[] args) {\n    System.out.println("Library v1");\n  }\n}');
  await sp.fill('#noteInput', 'v1：主入口骨架');
  await sp.click('#btnSave');
  await sp.waitForSelector('.ide-toast:has-text("已保存并自动生成新版本 v1")', { timeout: 8000 });
  ok('保存自动生成新版本 v1', true);
  await sp.click('#btnBack');
  await sp.waitForSelector('[data-act="section"][data-val="homework"]', { timeout: 15000 });
  await sp.waitForFunction(() => (document.querySelector('.mh-title') || {}).textContent === '项目代码', null, { timeout: 8000 });
  ok('返回直达「项目代码」板块并聚焦原项目', true);
  await sp.waitForSelector('.card:has-text("我的代码") .code-file-row', { timeout: 8000 });
  const rowTxt = await sp.locator('.card:has-text("我的代码") .code-file-row').first().textContent();
  ok('我的代码卡片简略模式（文件名/Java/行数/运行状态/保存时间）',
    rowTxt.includes('Main.java') && rowTxt.includes('Java') && rowTxt.includes('可运行') && rowTxt.includes('保存于'));
  ok('不再整段渲染完整代码', await sp.locator('.card:has-text("我的代码") .code-editor').count() === 0);
  await sp.waitForFunction(() => /1 个版本/.test(document.body.textContent), null, { timeout: 8000 });
  ok('版本迭代记录展示 v1', (await sp.locator('table tbody tr', { hasText: 'v1' }).count()) >= 1);
  ok('目录项迁入「开发中」分组', await stuItem('dev', T1q).count() === 1 && await stuItem('new', T1q).count() === 0);

  // 再入 IDE：新增文件 + 保存并提交 v2
  await sp.locator('.card', { hasText: T1q }).locator('[data-act="projectEditorOpen"]').first().click();
  await sp.waitForSelector('#ceTa', { timeout: 10000 });
  await sp.fill('#newFileInput', 'Book.java');
  await sp.click('#btnNewFile');
  await sp.waitForSelector('#tabBar .ide-tab.on:has-text("Book.java")', { timeout: 5000 });
  await sp.fill('#ceTa', 'public class Book {\n  String title;\n  Book(String t) { title = t; }\n}');
  await sp.fill('#noteInput', 'v2：新增 Book 类');
  await sp.click('#btnSubmit');
  await sp.waitForSelector('.ide-toast:has-text("已提交（v2）")', { timeout: 8000 });
  await sp.click('#btnBack');
  await sp.waitForSelector('[data-act="section"][data-val="homework"]', { timeout: 15000 });
  await sp.waitForFunction(() => (document.querySelector('.mh-title') || {}).textContent === '项目代码', null, { timeout: 8000 });
  await sp.waitForFunction(() => document.body.textContent.includes('已提交 · v2'), null, { timeout: 8000 });
  ok('聚焦徽章更新为「已提交 · v2」', true);
  ok('目录项迁入「已提交」分组', await stuItem('sub', T1q).count() === 1 && await stuItem('dev', T1q).count() === 0);
  // 目录点击切换到项目 B（另一项目）
  const stuSwitchMs = await sp.evaluate((title) => {
    const btn = Array.from(document.querySelectorAll('[data-act="projectPick"]')).find(b => b.textContent.includes(title));
    const t0 = performance.now();
    btn.click();
    return performance.now() - t0;
  }, T2q);
  await sp.waitForSelector('.card:has-text("' + T2q + '")', { timeout: 8000 });
  ok('学生目录点击切换响应 < 200ms', stuSwitchMs < 200, stuSwitchMs.toFixed(0) + 'ms');
  ok('切换到未参与项目显示「开始开发」', (await sp.locator('.card-head h3', { hasText: '开始开发' }).count()) === 1);
  await stuItem('sub', T1q).click();
  await sp.waitForSelector('.card:has-text("我的代码")', { timeout: 8000 });

  console.log('\n== C. 教师端：内联进度实时轮询 + 在线查看代码 ==');
  await page.reload();
  await page.waitForSelector('[data-act="section"][data-val="assignments"]', { timeout: 15000 });
  await page.click('[data-act="section"][data-val="projects"]');
  await pubItem(page, T1q).click();
  await page.waitForFunction(() => (document.querySelector('#projectProgressMain') || {}).textContent.includes('张明'), null, { timeout: 8000 });
  const row = page.locator('#projectProgressMain tbody tr', { hasText: '张明' });
  ok('内联进度显示学生行（含学号）', (await row.textContent()).includes('学号') && (await row.textContent()).includes('已提交'));
  ok('进度行版本数 = 2', (await row.locator('td').nth(2).textContent()).trim() === '2');
  // 学生在教师浏览期间保存 v3 → 4 秒轮询捕获
  const mine = await j(await fetch(API + '/projects/my', { headers: HS }));
  const myP = mine.data.find(p => p.title.includes(T1q));
  const sv = await j(await fetch(API + '/projects/mine/' + myP.mine.id + '/save', {
    method: 'POST', headers: HS,
    body: JSON.stringify({ files: [{ path: 'Main.java', content: 'public class Main {\n  public static void main(String[] a) {\n    System.out.println("Library v3");\n  }\n}' }, { path: 'Book.java', content: 'public class Book {\n  String title;\n}' }], summary: 'v3：教师视角增量验证', submit: false })
  }));
  ok('[造数] 学生保存 v3', sv.code === 0, 'v' + sv.data.versionCount);
  await page.waitForFunction(() => {
    const tds = document.querySelectorAll('#projectProgressMain tbody tr td');
    for (const td of tds) if (td.textContent.trim() === '3') return true;
    return false;
  }, null, { timeout: 9000 });
  ok('内联进度 4 秒轮询实时增量更新（2→3 版本）', true);
  // 查看学生代码版本
  await page.locator('#projectProgressMain [data-act="projectDetailModal"]').first().click();
  await page.waitForSelector('.modal:has-text("代码版本")', { timeout: 8000 });
  await page.waitForSelector('.modal .card:has-text("v3")', { timeout: 8000 });
  ok('版本迭代记录展示 v3~v1', await page.locator('.modal .card:has-text("v1")').count() === 1
    && await page.locator('.modal .card:has-text("v2")').count() === 1
    && await page.locator('.modal .card:has-text("v3")').count() === 1);
  await page.locator('.modal .card:has-text("v1") [data-act="projectVersionShow"]').click();
  await page.waitForSelector('.modal .code-editor', { timeout: 8000 });
  ok('在线展开 v1 完整代码', (await page.locator('.modal .code-editor').first().textContent()).includes('v1'));
  await page.click('.modal [data-act="closeModal"]');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 });

  console.log('\n== D. 教师端：编辑 / 上下架（目录分组迁移）/ 删除 ==');
  await pubItem(page, T1q).click();
  await page.waitForSelector('.card:has-text("' + T1q + '")', { timeout: 8000 });
  // 编辑
  await page.locator('.card', { hasText: T1q }).locator('[data-act="projectEditModal"]').click();
  await page.waitForSelector('.modal [data-bind="modal"][data-key="title"]');
  const prefill = await page.inputValue('.modal [data-bind="modal"][data-key="title"]');
  ok('编辑弹窗回显原标题', prefill.includes(T1q));
  await page.fill('.modal [data-bind="modal"][data-key="title"]', T1 + 'V2');
  await page.click('.modal [data-act="doProjectSave"]');
  await page.waitForSelector('.card:has-text("V2")', { timeout: 8000 });
  ok('编辑保存后主区与目录同步更新', await pubItem(page, T1 + 'V2').count() === 1);
  // 下架 → 目录分组迁移到「已下架」
  await page.locator('.card', { hasText: T1q }).locator('[data-act="projectToggleStatus"][data-val="OFFLINE"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#projFolderItems-off [data-act="projectPick"]').length >= 1, null, { timeout: 8000 });
  ok('下架后目录项迁入「已下架」分组', await page.locator('#projFolderItems-off [data-act="projectPick"]', { hasText: T1q }).count() === 1);
  ok('聚焦视图徽章变「已下架」', (await page.locator('.card .badge').first().textContent()) === '已下架');
  const myList = await j(await fetch(API + '/projects/my', { headers: HS }));
  ok('下架后学生列表不再展示', !myList.data.some(p => p.title.includes(T1q)));
  // 上架 → 迁回
  await page.locator('.card', { hasText: T1q }).locator('[data-act="projectToggleStatus"][data-val="PUBLISHED"]').click();
  await page.waitForFunction((t) => Array.from(document.querySelectorAll('#projFolderItems-pub [data-act="projectPick"]')).filter(b => b.textContent.includes(t)).length === 14, 'E2E-DIR-' + stamp, { timeout: 8000 });
  ok('重新上架后迁回「上架中」分组', await pubItem(page, T1q).count() === 1);
  // 删除项目 B
  await pubItem(page, T2q).click();
  await page.waitForSelector('.card:has-text("' + T2q + '")', { timeout: 8000 });
  await page.locator('.card', { hasText: T2q }).locator('[data-act="projectDeleteModal"]').click();
  await page.waitForSelector('.modal:has-text("删除项目")');
  ok('删除确认弹窗提示级联删除', (await page.locator('.modal').textContent()).includes('不可恢复'));
  await page.click('.modal [data-act="doProjectDelete"]');
  await page.waitForFunction((t) => Array.from(document.querySelectorAll('#projFolderItems-pub [data-act="projectPick"]')).filter(b => b.textContent.includes(t)).length === 13, 'E2E-DIR-' + stamp, { timeout: 8000 });
  ok('删除后目录移除并自动聚焦下一项目', (await page.locator('.card-head h3').first().textContent()).length > 0);

  // 清场：删除其余测试项目
  await j(await fetch(API + '/teacher/projects?classId=1', { headers: H })).then(async (r) => {
    for (const p of r.data.filter(x => x.title.includes('E2E-DIR-'))) {
      await j(await fetch(API + '/teacher/projects/' + p.id, { method: 'DELETE', headers: H }));
    }
  });
  await ctxS.close();
  ok('全程无页面报错/4xx5xx', errors.length === 0, errors.slice(0, 3).join(' | '));
  console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
