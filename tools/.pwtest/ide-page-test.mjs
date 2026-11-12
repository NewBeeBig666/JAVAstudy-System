/* 学生端独立代码工作台（ide.html）E2E
 * [跳转] 项目代码页点击编写按钮 → 独立 IDE 页面（无弹窗编辑）
 * [布局] IDEA 风格：顶部工具栏 / 左侧文件树 / 标签页 / 行号高亮补全 / 底部输出面板 / 状态栏
 * [能力] 代码补全 / 语法高亮 / 保存(Ctrl+S) / 提交 / 运行（成功输出+编译错误诊断+运行时异常）
 * [适配] 分栏拖拽调整 / 面板折叠 / 未保存拦截 / 跳转流畅性
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

(async () => {
  const stamp = Date.now().toString(36);
  const TITLE = 'E2E-IDE-' + stamp + ' 学生成绩管理系统';
  const TQ = 'E2E-IDE-' + stamp;
  const T = await login('teacher');
  const S = await login('student');
  const H = { Authorization: 'Bearer ' + T, 'Content-Type': 'application/json;charset=utf-8' };
  const HS = { Authorization: 'Bearer ' + S, 'Content-Type': 'application/json;charset=utf-8' };
  ["DELETE FROM project_version WHERE student_project_id IN (SELECT sp.id FROM student_project sp JOIN coding_project p ON sp.project_id=p.id WHERE p.title LIKE 'E2E-IDE-%')",
   "DELETE FROM student_project WHERE project_id IN (SELECT id FROM coding_project WHERE title LIKE 'E2E-IDE-%')",
   "DELETE FROM coding_project WHERE title LIKE 'E2E-IDE-%'"].forEach(q => sql(q));
  const pub = await j(await fetch(API + '/teacher/projects', {
    method: 'POST', headers: H,
    body: JSON.stringify({ classId: 1, title: TITLE, description: '实现学生成绩增删改查与均分统计，控制台交互。' })
  }));
  const st = await j(await fetch(API + '/projects/' + pub.data.id + '/start', {
    method: 'POST', headers: HS, body: '{}'
  }));
  ok('[造数] 发布项目 + 学生创建', pub.code === 0 && st.code === 0, 'spId=' + st.data.id);
  const spId = st.data.id;

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

  console.log('\n== A. 跳转流程：项目代码页 → 独立 IDE 页面 ==');
  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', 'student');
  await page.fill('#lgPass', '123456');
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-act="section"][data-val="homework"]', { timeout: 15000 });
  await page.click('[data-act="section"][data-val="projects"]');
  await page.waitForSelector('#projFolderRow-new', { timeout: 8000 });
  const t0 = Date.now();
  await page.locator('[data-act="projectEditorOpen"], [data-act="projectStart"]', { hasText: /创建项目并开始开发|继续开发|进入代码工作台/ }).first().click();
  // 造数中学生已 start → mine 存在 → 按钮为「继续开发」/「进入代码工作台」；点击后跳转 ide.html
  await page.waitForURL('**/ide.html?sp=' + spId, { timeout: 8000 });
  const navMs = Date.now() - t0;
  ok('点击编写按钮跳转独立 IDE 页面（无弹窗）', true, navMs + 'ms');

  console.log('\n== B. IDEA 风格布局 ==');
  await page.waitForSelector('#ceTa', { timeout: 8000 });
  ok('顶部工具栏（返回/运行/保存/提交）', await page.locator('#btnBack,#btnRun,#btnSave,#btnSubmit').count() === 4);
  ok('左侧文件树（项目根 + Main.java）', (await page.locator('#treeBody .ide-tree-root').textContent()).includes(TQ.slice(0, 12))
    && (await page.locator('#treeBody .tree-item[data-file="Main.java"]').count()) === 1);
  ok('编辑区标签页（Main.java 激活）', (await page.locator('#tabBar .ide-tab.on').textContent()).includes('Main.java'));
  ok('底部输出面板 + 版本记录标签', (await page.locator('.ide-btab[data-btab="output"], .ide-btab[data-btab="versions"]').count()) === 2);
  ok('底部状态栏', await page.locator('.ide-status').count() === 1);
  ok('行号栏渲染', await page.locator('.ce-gutter-inner div').count() >= 1);

  console.log('\n== C. 编辑能力：高亮 / 补全 / 缩进 ==');
  await page.fill('#ceTa', 'public class Main {\n}');
  ok('语法高亮（关键字着色）', (await page.locator('.ce-hl .ce-kw').count()) >= 1);
  // 智能补全：输入 sout 触发补全弹窗 → Enter 展开 System.out.println();
  await page.click('#ceTa');
  await page.evaluate(() => { const ta = document.querySelector('#ceTa'); ta.focus(); ta.setSelectionRange(19, 19); }); // 光标置于行尾
  await page.keyboard.type('sout', { delay: 30 });
  await page.waitForSelector('.ce-ac:visible', { timeout: 5000 });
  ok('输入 sout 弹出智能补全', (await page.locator('.ce-ac .ce-ac-name').first().textContent()) === 'sout');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#ceTa').value.includes('System.out.println()'));
  ok('补全展开 System.out.println()', true);
  // 括号自动闭合（光标落在成对括号中间）
  await page.keyboard.type('(');
  const pair = await page.evaluate(() => {
    const ta = document.querySelector('#ceTa');
    const p = ta.selectionStart;
    return ta.value.slice(p - 1, p + 1);
  });
  ok('括号自动闭合', pair === '()');

  console.log('\n== D. 运行能力（编译 + 执行 + 诊断） ==');
  // 1) 正常运行
  await page.fill('#ceTa', 'public class Main {\n  public static void main(String[] args) {\n    System.out.println("hello ide");\n    System.out.println("sum=" + (1 + 2));\n  }\n}');
  await page.click('#btnRun');
  await page.waitForFunction(() => (document.querySelector('#bottomBody') || {}).textContent.includes('退出代码 0'), null, { timeout: 30000 });
  const out1 = await page.locator('#bottomBody').textContent();
  ok('运行成功输出程序结果', out1.includes('hello ide') && out1.includes('sum=3'));
  ok('输出面板含编译与运行命令行（IDEA 习惯）', out1.includes('javac') && out1.includes('java -Dfile.encoding=UTF-8 Main'));
  // 2) 编译错误（语法校验）
  await page.fill('#ceTa', 'public class Main {\n  public static void main(String[] args) {\n    System.out.println("broken\n  }\n}');
  await page.click('#btnRun');
  await page.waitForFunction(() => (document.querySelector('#bottomBody') || {}).textContent.includes('error:'), null, { timeout: 30000 });
  const out2 = await page.locator('#bottomBody').textContent();
  ok('语法校验失败显示编译诊断（文件:行号）', out2.includes('Main.java:3: error:') && out2.includes('unclosed string'));
  // 3) 运行时异常
  await page.fill('#ceTa', 'public class Main {\n  public static void main(String[] args) {\n    int[] a = new int[2];\n    System.out.println(a[9]);\n  }\n}');
  await page.click('#btnRun');
  await page.waitForFunction(() => (document.querySelector('#bottomBody') || {}).textContent.includes('退出代码 1'), null, { timeout: 30000 });
  ok('运行时异常捕获（栈轨迹 + 退出代码 1）', (await page.locator('#bottomBody').textContent()).includes('ArrayIndexOutOfBoundsException'));

  console.log('\n== E. 文件树 / 标签页管理 ==');
  await page.fill('#newFileInput', 'Book.java');
  await page.click('#btnNewFile');
  await page.waitForSelector('#tabBar .ide-tab.on:has-text("Book.java")', { timeout: 5000 });
  ok('新增文件并自动打开标签', await page.locator('#treeBody .tree-item[data-file="Book.java"]').count() === 1);
  await page.fill('#ceTa', 'public class Book {\n  String title;\n}');
  await page.locator('#tabBar .ide-tab[data-tab="Main.java"]').click();
  await page.waitForFunction(() => document.querySelector('#ceTa').value.includes('hello ide') === false && document.querySelector('#ceTa').value.includes('ArrayIndexOutOfBounds') === false);
  ok('切换标签后内容保留（Main.java 代码仍在）', (await page.locator('#ceTa').evaluate(el => el.value)).includes('public class Main'));
  // 删除文件（树项 hover ×）
  await page.locator('#treeBody .tree-item[data-file="Book.java"]').hover();
  await page.locator('#treeBody [data-del="Book.java"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#treeBody .tree-item').length === 1, null, { timeout: 5000 });
  ok('删除文件后树与标签同步移除', await page.locator('#treeBody .tree-item[data-file="Book.java"]').count() === 0
    && await page.locator('#tabBar .ide-tab[data-tab="Book.java"]').count() === 0);

  console.log('\n== F. 保存 / 提交 / 版本记录 ==');
  await page.fill('#ceTa', 'public class Main {\n  public static void main(String[] args) {\n    System.out.println("v1 code");\n  }\n}');
  await page.fill('#noteInput', 'v1：主程序完成');
  await page.click('#btnSave');
  await page.waitForSelector('.ide-toast:has-text("已保存并自动生成新版本 v1")', { timeout: 8000 });
  ok('保存新版本 v1（toast 提示）', true);
  ok('状态栏版本数更新', (await page.locator('#stVersion').textContent()).includes('1 个版本'));
  await page.locator('.ide-btab[data-btab="versions"]').click();
  await page.waitForFunction(() => (document.querySelector('#bottomBody') || {}).textContent.includes('v1'), null, { timeout: 8000 });
  ok('版本记录面板显示 v1（含版本说明）', (await page.locator('#bottomBody').textContent()).includes('v1：主程序完成'));
  // 提交 v2
  await page.fill('#ceTa', 'public class Main {\n  public static void main(String[] args) {\n    System.out.println("v2 code");\n  }\n}');
  await page.fill('#noteInput', 'v2：优化输出');
  await page.click('#btnSubmit');
  await page.waitForSelector('.ide-toast:has-text("已提交（v2）")', { timeout: 8000 });
  ok('保存并提交 v2', true);
  await page.waitForFunction(() => (document.querySelector('#stVersion') || {}).textContent.includes('已提交'), null, { timeout: 8000 });
  ok('状态栏显示已提交', true);

  console.log('\n== G. 面板折叠 / 分栏拖拽 / 未保存拦截 ==');
  // 左树折叠/展开（折叠保留窄条标题，切换按钮始终可点）
  await page.click('#btnTreeFold');
  ok('文件树可折叠（目录项隐藏）', await page.locator('#treeBody .tree-item').first().isHidden());
  await page.click('#btnTreeFold');
  ok('文件树可展开', await page.locator('#treeBody .tree-item[data-file="Main.java"]').isVisible());
  // 底部面板折叠/展开（折叠保留页签行）
  await page.click('#btnBottomFold');
  ok('底部面板可折叠（内容区隐藏）', await page.locator('#bottomBody').isHidden());
  await page.click('#btnBottomFold');
  ok('底部面板可展开', await page.locator('#bottomBody').isVisible());
  // 左树拖宽
  const w0 = await page.evaluate(() => document.querySelector('#treePanel').offsetWidth);
  const vs = await page.locator('#vsplit').boundingBox();
  await page.mouse.move(vs.x + vs.width / 2, vs.y + 300);
  await page.mouse.down();
  await page.mouse.move(vs.x + vs.width / 2 + 80, vs.y + 300, { steps: 6 });
  await page.mouse.up();
  const w1 = await page.evaluate(() => document.querySelector('#treePanel').offsetWidth);
  ok('左栏拖拽调整宽度', w1 - w0 >= 70, w0 + 'px → ' + w1 + 'px');
  // 底部拖高（分隔条上移 → 面板变高）
  const h0 = await page.evaluate(() => document.querySelector('#bottomPanel').offsetHeight);
  const hs = await page.locator('#hsplit').boundingBox();
  await page.mouse.move(hs.x + 400, hs.y + 2);
  await page.mouse.down();
  await page.mouse.move(hs.x + 400, hs.y - 90, { steps: 6 });
  await page.mouse.up();
  const h1 = await page.evaluate(() => document.querySelector('#bottomPanel').offsetHeight);
  ok('底部面板拖拽调整高度', h1 - h0 >= 70, h0 + 'px → ' + h1 + 'px');
  // 未保存拦截：修改代码 → 返回触发确认 → 取消后留在 IDE
  await page.fill('#ceTa', 'public class Main {\n  public static void main(String[] args) {\n    System.out.println("dirty");\n  }\n}');
  let dialogSeen = false;
  page.on('dialog', async d => { dialogSeen = true; await d.dismiss(); });
  await page.click('#btnBack');
  await page.waitForTimeout(400);
  ok('未保存修改返回时弹确认', dialogSeen);
  ok('取消确认后仍留在 IDE 页', page.url().includes('ide.html'));
  // 保存后返回顺畅
  page.removeAllListeners('dialog');
  await page.click('#btnSave');
  await page.waitForSelector('.ide-toast:has-text("已保存并自动生成新版本 v3")', { timeout: 8000 });
  await page.click('#btnBack');
  await page.waitForFunction(() => location.pathname.endsWith('index.html'), null, { timeout: 8000 });
  ok('已保存后返回项目列表（跳转流畅）', true);

  console.log('\n== H. 回流校验：返回直达项目代码板块 + 边界场景 ==');
  await page.waitForSelector('[data-act="section"][data-val="homework"]', { timeout: 15000 });
  await page.waitForFunction(() => (document.querySelector('.mh-title') || {}).textContent === '项目代码', null, { timeout: 8000 });
  ok('返回后直达「项目代码」板块（不再跳回学习会话）', true);
  await page.waitForSelector('.card .badge', { timeout: 8000 });
  await page.waitForFunction(() => /已提交/.test((document.querySelector('.card .badge') || {}).textContent || ''), null, { timeout: 8000 });
  ok('聚焦原项目并显示「已提交」徽章', true);
  // 边界1：多项目切换——目录切到另一项目 → 进工作台 → 返回聚焦该新项目
  const pub2 = await j(await fetch(API + '/teacher/projects', {
    method: 'POST', headers: H,
    body: JSON.stringify({ classId: 1, title: TITLE + '·B', description: '边界项目 B' })
  }));
  await j(await fetch(API + '/projects/' + pub2.data.id + '/start', { method: 'POST', headers: HS, body: '{}' }));
  await page.click('[data-act="projectNavRefresh"]');
  await page.waitForFunction((t) => {
    return Array.from(document.querySelectorAll('[data-act="projectPick"]')).some(b => b.textContent.includes(t));
  }, '·B', { timeout: 8000 });
  await page.locator('[data-act="projectPick"]', { hasText: '·B' }).click();
  await page.locator('[data-act="projectEditorOpen"]').first().click();
  await page.waitForSelector('#ceTa', { timeout: 10000 });
  await page.click('#btnBack');
  await page.waitForSelector('[data-act="section"][data-val="homework"]', { timeout: 15000 });
  await page.waitForFunction(() => (document.querySelector('.mh-title') || {}).textContent === '项目代码', null, { timeout: 8000 });
  const focusedB = (await page.locator('.card-head h3').first().textContent()).includes('·B');
  ok('边界·多项目切换：返回后聚焦新进入的项目 B', focusedB);
  // 边界2：会话中断后重新进入——直接重载 IDE 页（URL 仍带 sp）→ 返回仍直达并聚焦
  await page.goto(BASE + '/ide.html?sp=' + spId);
  await page.waitForSelector('#ceTa', { timeout: 10000 });
  await page.click('#btnBack');
  await page.waitForSelector('[data-act="section"][data-val="homework"]', { timeout: 15000 });
  await page.waitForFunction(() => (document.querySelector('.mh-title') || {}).textContent === '项目代码', null, { timeout: 8000 });
  ok('边界·中断重进：IDE 重载后返回仍直达项目页', true);
  const focusedA = await page.locator('.card-head h3').first().textContent();
  ok('边界·中断重进：返回后聚焦原项目 A（?p 定位）', focusedA.includes('管理系统') && !focusedA.includes('·B'));
  const prog = await j(await fetch(API + '/teacher/projects/' + pub.data.id + '/progress', { headers: H }));
  const row = prog.code === 0 && prog.data.students.find(s => s.studentProjectId === spId);
  ok('教师端实时可见 v3 版本与提交状态', !!row && row.status === 'SUBMITTED' && row.versionCount === 3, 'v' + (row && row.versionCount));

  console.log('\n== I. 右侧智能助手（复用平台助手能力 + IDE 上下文捕获） ==');
  // 从项目页再次进入 IDE 工作台
  await page.locator('[data-act="projectEditorOpen"]').first().click();
  await page.waitForSelector('#ceTa', { timeout: 10000 });
  // 拦截助手接口：确定性验证请求负载中的上下文注入与回复渲染（不依赖真实 LLM）
  let asaPayload = null;
  await page.route('**/api/student/assistant', async (route) => {
    asaPayload = route.request().postDataJSON();
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: { reply: '示例回复：\n\n```java\nSystem.out.println("hi");\n```\n\n**要点**：先看编译报错的行号。' } })
    });
  });
  await page.waitForSelector('#asaPanel .asa-title', { timeout: 8000 });
  ok('右侧智能助手面板（标题 + 欢迎 + 快捷建议）', (await page.locator('#asaPanel .asa-title').textContent()).includes('智能助手')
    && await page.locator('#asaPanel .asa-chip').count() === 4);
  const asaW = await page.evaluate(() => document.querySelector('#asaPanel').offsetWidth);
  const edW = await page.evaluate(() => document.querySelector('#editorRoot').offsetWidth);
  ok('助手加宽（≥340px）且编辑区保留合理宽度（≥600px）', asaW >= 340 && edW >= 600, '助手 ' + asaW + 'px · 编辑器 ' + edW + 'px');
  ok('不遮挡核心编辑区（编辑器/文件树/输出面板均在）', await page.locator('#ceTa').isVisible()
    && await page.locator('#treeBody').isVisible() && await page.locator('#bottomBody').isVisible());
  // 折叠/展开（收起态 rail 单图标，再点展开）
  await page.click('#btnAsaToggle');
  ok('助手可收起为单图标 rail', (await page.locator('#asaPanel').getAttribute('class')).includes('mini')
    && await page.locator('#ceTa').isVisible());
  await page.click('#btnAsaToggle');
  await page.waitForSelector('#asaInput', { timeout: 5000 });
  ok('助手可重新展开（输入框恢复）', await page.locator('#asaInput').isVisible());
  // 快捷建议：点击填入输入框
  await page.locator('[data-asaquick]').first().click();
  await page.waitForFunction(() => (document.querySelector('#asaInput') || {}).value.length > 0);
  ok('快捷建议一键填入输入框', true);
  await page.fill('#asaInput', '');
  // 上下文捕获 1：当前文件 + 光标位置 + 选中代码
  await page.fill('#ceTa', 'public class Main {\n  public static void main(String[] args) {\n    System.out.println("sel code line");\n  }\n}');
  await page.evaluate(() => {
    const ta = document.querySelector('#ceTa');
    ta.focus();
    ta.setSelectionRange(ta.value.indexOf('sel code'), ta.value.indexOf('sel code') + 11);
  });
  await page.fill('#asaInput', '这段代码是什么意思？');
  await page.locator('#btnAsaSend').click();
  await page.waitForSelector('#asaPanel .asa-bubble-ai', { timeout: 8000 });
  ok('用户气泡显示原始问题（不显示注入的上下文）', (await page.locator('#asaPanel .asa-bubble-user').first().textContent()).trim() === '这段代码是什么意思？');
  const lastMsg = asaPayload.messages[asaPayload.messages.length - 1].content;
  ok('请求注入 IDE 上下文（项目/当前文件/光标 Ln,Col）', lastMsg.includes('【IDE 代码上下文】')
    && lastMsg.includes('当前文件：Main.java') && lastMsg.includes('Ln ') && lastMsg.includes('【我的问题】'));
  ok('捕获选中代码与当前文件内容', lastMsg.includes('选中代码：') && lastMsg.includes('sel code line') && lastMsg.includes('public class Main'));
  ok('AI 回复渲染 Markdown（代码块 + 加粗）', await page.locator('#asaPanel .asa-bubble-ai .md-code').count() === 1
    && await page.locator('#asaPanel .asa-bubble-ai strong').count() >= 1);
  // 上下文捕获 2：编译报错自动携带
  await page.fill('#ceTa', 'public class Main {\n  public static void main(String[] args) {\n    System.out.println("broken\n  }\n}');
  await page.click('#btnRun');
  await page.waitForFunction(() => (document.querySelector('#bottomBody') || {}).textContent.includes('error:'), null, { timeout: 30000 });
  await page.fill('#asaInput', '帮我排查这个报错');
  await page.locator('#btnAsaSend').click();
  await page.waitForFunction(() => document.querySelectorAll('#asaPanel .asa-bubble-user').length >= 2, null, { timeout: 8000 });
  const last2 = asaPayload.messages[asaPayload.messages.length - 1].content;
  ok('自动携带最近编译报错信息', last2.includes('最近编译报错') && last2.includes('unclosed string'));
  // 多轮历史透传 + 新对话清空
  await page.click('#btnAsaNew');
  await page.waitForSelector('#asaPanel .asa-welcome', { timeout: 5000 });
  ok('新对话一键清空历史', await page.locator('#asaPanel .asa-bubble-user').count() === 0);
  await page.unroute('**/api/student/assistant');
  // 窄屏适配：清布局偏好 + 缩窗口重载 → 助手默认收起，编辑区不受挤压
  await page.evaluate(() => localStorage.removeItem('la-ide-layout'));
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.reload();
  await page.waitForSelector('#ceTa', { timeout: 10000 });
  ok('窄屏（1100px）助手默认收起（rail 形态）', (await page.locator('#asaPanel').getAttribute('class')).includes('mini'));
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.click('#btnAsaToggle');
  await page.waitForSelector('#asaInput', { timeout: 5000 });
  ok('窄屏默认收起后可手动展开', await page.locator('#asaInput').isVisible());
  // 助手开启状态下 IDE 核心功能不受影响：保存仍正常
  await page.fill('#ceTa', 'public class Main {\n  public static void main(String[] args) {\n  }\n}');
  await page.fill('#noteInput', 'v4：助手开启下保存');
  await page.click('#btnSave');
  await page.waitForSelector('.ide-toast:has-text("已保存并自动生成新版本 v4")', { timeout: 8000 });
  ok('助手开启时保存/提交等核心功能不受影响', true);

  console.log('\n== J. 我的代码卡片简略模式（信息密度 + 交互回归） ==');
  // 造 6 文件版本：新增 5 个类文件后保存 v5
  for (const name of ['Book', 'Util', 'Helper', 'Tool', 'Data']) {
    await page.fill('#newFileInput', name + '.java');
    await page.click('#btnNewFile');
    await page.waitForSelector('#tabBar .ide-tab.on:has-text("' + name + '.java")', { timeout: 5000 });
    await page.fill('#ceTa', 'class ' + name + ' {\n  int x;\n}');
  }
  await page.fill('#noteInput', 'v5：多文件密度验证');
  await page.click('#btnSave');
  await page.waitForSelector('.ide-toast:has-text("已保存并自动生成新版本 v5")', { timeout: 8000 });
  await page.click('#btnBack');
  await page.waitForSelector('[data-act="section"][data-val="homework"]', { timeout: 15000 });
  await page.waitForFunction(() => (document.querySelector('.mh-title') || {}).textContent === '项目代码', null, { timeout: 8000 });
  await page.waitForSelector('.card:has-text("我的代码") .code-file-row', { timeout: 8000 });
  const nRows = await page.locator('.card:has-text("我的代码") .code-file-row').count();
  ok('6 个文件以简略行展示（不再整段渲染代码）', nRows === 6
    && await page.locator('.card:has-text("我的代码") .code-editor').count() === 0, nRows + ' 行');
  const rowTxt2 = await page.locator('.card:has-text("我的代码") .code-file-row').first().textContent();
  ok('每行保留核心字段（名称/Java 类型/行数·大小/运行状态/保存时间）',
    rowTxt2.includes('Main.java') && rowTxt2.includes('Java') && rowTxt2.includes('可运行') && rowTxt2.includes('保存于'));
  ok('运行状态识别准确（仅 Main 可运行，其余类文件）',
    await page.locator('.card:has-text("我的代码") .code-file-row .badge.ok').count() === 1
    && await page.locator('.card:has-text("我的代码") .code-file-row', { hasText: '类文件' }).count() === 5);
  // 密度：6 文件卡片高度 vs 旧模式（每文件 ≥100px 编辑器 + 间距 ≈ 6×110+60）
  const cardH = await page.evaluate(() => {
    const c = Array.from(document.querySelectorAll('.card')).find(x => x.textContent.includes('我的代码'));
    return c ? c.offsetHeight : 0;
  });
  const oldEst = 60 + nRows * 110;
  ok('同屏承载量提升 ≥50%', cardH * 1.5 <= oldEst,
    '新 ' + cardH + 'px vs 旧估算 ' + oldEst + 'px · 提升 ' + Math.round((oldEst / cardH - 1) * 100) + '%');
  // 响应式：375px 窄屏下文件行不溢出
  await page.setViewportSize({ width: 375, height: 800 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => {
    const rows = document.querySelectorAll('.code-file-row');
    return Array.from(rows).every(r => r.scrollWidth <= r.clientWidth + 2);
  });
  ok('窄屏（375px）文件行换行适配无溢出', overflow);
  await page.setViewportSize({ width: 1360, height: 900 });
  // 操作入口保留：进入代码工作台
  await page.locator('.card:has-text("我的代码") [data-act="projectEditorOpen"]').click();
  await page.waitForSelector('#ceTa', { timeout: 10000 });
  ok('「进入代码工作台」操作入口保留可用', true);

  // 清场
  ["DELETE FROM project_version WHERE student_project_id IN (SELECT sp.id FROM student_project sp JOIN coding_project p ON sp.project_id=p.id WHERE p.title LIKE 'E2E-IDE-%')",
   "DELETE FROM student_project WHERE project_id IN (SELECT id FROM coding_project WHERE title LIKE 'E2E-IDE-%')",
   "DELETE FROM coding_project WHERE title LIKE 'E2E-IDE-%'"].forEach(q => sql(q));
  ok('全程无页面报错/4xx5xx', errors.length === 0, errors.slice(0, 3).join(' | '));
  console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
