/* 学生端 IDE 工作台 · 代码运行功能全面检测
 * 覆盖：A 基础语法 / B 标准输出（含中文编码修复验证） / C 标准输入输出（stdin 预置）
 *       D 业务逻辑（循环/数组/方法/多文件协作） / E 错误反馈（编译/运行时/入口）
 *       F 超时保护 / G 运行状态提示与完整流程 / H 输入型程序引导
 * 判定：输出功能有效性结论；异常项标注复现路径与表现 */
import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
const BASE = 'http://localhost:8080';
const API = BASE + '/api';
let pass = 0, fail = 0, anomalies = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else { fail++; anomalies.push(name); console.log('  ✗ ' + name + (detail ? '（' + detail + '）' : '')); }
};
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { code: -999, msg: t.slice(0, 120) }; } };

async function login(u) {
  const r = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ username: u, password: '123456' })
  });
  return (await j(r)).data.token;
}
function sql(q) {
  try {
    return execSync(`mysql -uroot -proot learning_agent -e ${JSON.stringify(String(q).replace(/[\r\n]+/g, ' '))}`,
      { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  } catch (e) { return null; }
}

(async () => {
  const stamp = Date.now().toString(36);
  const TITLE = 'E2E-RUN-' + stamp + ' 运行功能全量检测';
  const T = await login('teacher');
  const S = await login('student');
  const H = { Authorization: 'Bearer ' + T, 'Content-Type': 'application/json;charset=utf-8' };
  const HS = { Authorization: 'Bearer ' + S, 'Content-Type': 'application/json;charset=utf-8' };
  ["DELETE FROM project_version WHERE student_project_id IN (SELECT sp.id FROM student_project sp JOIN coding_project p ON sp.project_id=p.id WHERE p.title LIKE 'E2E-RUN-%' OR p.title LIKE 'RUNPROBE-%')",
   "DELETE FROM student_project WHERE project_id IN (SELECT id FROM coding_project WHERE title LIKE 'E2E-RUN-%' OR p.title LIKE 'RUNPROBE-%')",
   "DELETE FROM coding_project WHERE title LIKE 'E2E-RUN-%' OR title LIKE 'RUNPROBE-%'"].forEach(q => sql(q));
  const pub = await j(await fetch(API + '/teacher/projects', {
    method: 'POST', headers: H,
    body: JSON.stringify({ classId: 1, title: TITLE, description: '运行功能全量检测：覆盖基础语法/输入输出/业务逻辑/错误反馈/超时保护。' })
  }));
  const st = await j(await fetch(API + '/projects/' + pub.data.id + '/start', { method: 'POST', headers: HS, body: '{}' }));
  ok('[造数] 项目发布与学生创建', pub.code === 0 && st.code === 0, 'spId=' + st.data.id);

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

  console.log('\n== 完整流程：项目页 → 进入代码工作台 → 编辑运行 ==');
  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', 'student');
  await page.fill('#lgPass', '123456');
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-act="section"][data-val="homework"]', { timeout: 15000 });
  await page.click('[data-act="section"][data-val="projects"]');
  await page.waitForSelector('[data-act="projectEditorOpen"], [data-act="projectStart"]', { timeout: 10000 });
  await page.locator('[data-act="projectEditorOpen"], [data-act="projectStart"]').first().click();
  await page.waitForSelector('#ceTa', { timeout: 10000 });
  ok('编辑→运行的入口链路通畅（跳转 IDE 工作台）', true);

  // 运行用例工具：清空输出 → 写代码 →（预置输入）→ 运行 → 等待结束标志 → 断言
  const waitDone = (extra = 25) => page.waitForFunction(() => {
    const t = (document.querySelector('#bottomBody') || {}).textContent || '';
    return t.includes('退出代码') || t.includes('进程已强制终止') || t.includes('编译未通过') || t.includes('未找到可运行入口');
  }, null, { timeout: extra * 1000 });
  const outText = () => page.locator('#bottomBody').textContent();
  async function runCase(name, code, check, opts) {
    opts = opts || {};
    await page.click('#btnClearOut');
    // 用例代码统一写入 Main.java 标签（多文件用例中活动标签可能停在新增文件上）
    const mainTab = page.locator('#tabBar .ide-tab[data-tab="Main.java"]');
    if (await mainTab.count()) await mainTab.click();
    await page.fill('#ceTa', code);
    if (opts.stdin != null) {
      if (!(await page.locator('#stdinTa').count())) { await page.click('#btnStdin'); }
      await page.fill('#stdinTa', opts.stdin);
    }
    await page.click('#btnRun');
    if (opts.waitDone === false) return;
    await waitDone(opts.timeoutSec || 25);
    const txt = await outText();
    ok(name, check(txt), (txt.match(/[^\n]*退出代码[^\n]*/) || [''])[0].trim().slice(0, 40));
  }

  console.log('\n== A. 基础语法用例 ==');
  await runCase('A1 Hello World 输出', 'public class Main {\n  public static void main(String[] args) {\n    System.out.println("Hello World");\n  }\n}',
    t => t.includes('Hello World') && t.includes('退出代码 0'));
  await runCase('A2 变量声明与算术运算', 'public class Main {\n  public static void main(String[] args) {\n    int a = 7, b = 3;\n    System.out.println("sum=" + (a + b) + " div=" + (a / (double) b));\n  }\n}',
    t => t.includes('sum=10') && t.includes('div=2.3333333333333335'));
  await runCase('A3 printf 格式化输出', 'public class Main {\n  public static void main(String[] args) {\n    System.out.printf("name=%s score=%.2f%n", "Alice", 95.567);\n  }\n}',
    t => t.includes('name=Alice score=95.57'));

  console.log('\n== B. 标准输出用例（含中文编码修复验证） ==');
  await runCase('B1 中文输出无乱码（编码修复）', 'public class Main {\n  public static void main(String[] args) {\n    System.out.print("请输入第一个整数：");\n    System.out.println("你好，世界 sum=" + (1 + 2));\n  }\n}',
    t => t.includes('请输入第一个整数：') && t.includes('你好，世界 sum=3') && !t.includes('\uFFFD'));
  await runCase('B2 print/println 混合与转义字符', 'public class Main {\n  public static void main(String[] args) {\n    System.out.print("A\\tB\\n");\n    System.out.println("end");\n  }\n}',
    t => t.includes('A\tB') && t.includes('end'));

  console.log('\n== C. 标准输入输出用例（stdin 预置） ==');
  // C1 输入型程序引导：未展开输入区时运行 → 不直接执行，自动展开输入框并提示
  await page.click('#btnClearOut');
  await page.evaluate(() => { localStorage.removeItem('la-ide-layout'); location.reload(); });
  await page.waitForSelector('#ceTa', { timeout: 10000 });
  await page.fill('#ceTa', 'import java.util.Scanner;\npublic class Main {\n  public static void main(String[] args) {\n    Scanner sc = new Scanner(System.in);\n    int a = sc.nextInt();\n    int b = sc.nextInt();\n    System.out.println("sum=" + (a + b));\n  }\n}');
  await page.click('#btnRun');
  await page.waitForSelector('#stdinTa', { timeout: 5000 });
  ok('C1 输入型程序自动引导（展开输入框 + toast 提示，不盲目执行）',
    (await page.locator('#stdinTa').count()) === 1 && !(await outText()).includes('> javac'));
  // C2 预置输入运行
  await page.fill('#stdinTa', '3\n4');
  await page.click('#btnRun');
  await waitDone();
  const c2 = await outText();
  ok('C2 Scanner 读取预置输入（nextInt×2 → sum=7）', c2.includes('sum=7') && c2.includes('退出代码 0'));
  ok('C3 输入行数回显（已附带 2 行预置输入）', c2.includes('已附带 2 行预置输入'));
  // C4 nextLine 字符串输入
  await runCase('C4 nextLine 字符串输入', 'import java.util.Scanner;\npublic class Main {\n  public static void main(String[] args) {\n    Scanner sc = new Scanner(System.in);\n    String name = sc.nextLine();\n    System.out.println("hello, " + name + "!");\n  }\n}',
    t => t.includes('hello, 张三!'), { stdin: '张三' });

  console.log('\n== D. 业务逻辑用例 ==');
  await runCase('D1 循环累加 1..100', 'public class Main {\n  public static void main(String[] args) {\n    int s = 0;\n    for (int i = 1; i <= 100; i++) s += i;\n    System.out.println("total=" + s);\n  }\n}',
    t => t.includes('total=5050'));
  await runCase('D2 数组求最值与遍历', 'public class Main {\n  public static void main(String[] args) {\n    int[] a = {67, 434, 98, 2, 4};\n    int max = a[0], min = a[0];\n    for (int x : a) { if (x > max) max = x; if (x < min) min = x; }\n    System.out.println("max=" + max + " min=" + min);\n  }\n}',
    t => t.includes('max=434') && t.includes('min=2'));
  await runCase('D3 方法调用与字符串处理', 'public class Main {\n  static int add(int a, int b) { return a + b; }\n  public static void main(String[] args) {\n    String s = "Java Learning";\n    System.out.println(s.toUpperCase() + " " + add(20, 22));\n  }\n}',
    t => t.includes('JAVA LEARNING 42'));
  // D4 多文件协作：Main 调用 Book 类
  await page.fill('#newFileInput', 'Book.java');
  await page.click('#btnNewFile');
  await page.waitForSelector('#tabBar .ide-tab.on:has-text("Book.java")', { timeout: 5000 });
  await page.fill('#ceTa', 'public class Book {\n  String title;\n  public Book(String t) { title = t; }\n  public String greet() { return "book: " + title; }\n}');
  await runCase('D4 多文件协作（Main + Book 跨类调用）', 'public class Main {\n  public static void main(String[] args) {\n    Book b = new Book("Java 核心技术");\n    System.out.println(b.greet());\n  }\n}',
    t => t.includes('book: Java 核心技术') && t.includes('javac -encoding UTF-8 Main.java Book.java'));

  console.log('\n== E. 错误信息反馈用例 ==');
  await runCase('E1 语法错误：缺分号（编译诊断）', 'public class Main {\n  public static void main(String[] args) {\n    int a = 1\n    System.out.println(a);\n  }\n}',
    t => t.includes('error:') && t.includes('Main.java:3') && t.includes('编译未通过'));
  await runCase('E2 语法错误：未闭合字符串', 'public class Main {\n  public static void main(String[] args) {\n    System.out.println("broken\n  }\n}',
    t => t.includes('unclosed string literal') && t.includes('Main.java:3: error:'));
  await runCase('E3 运行时异常：数组越界（栈轨迹 + 退出码 1）', 'public class Main {\n  public static void main(String[] args) {\n    int[] a = new int[2];\n    System.out.println(a[9]);\n  }\n}',
    t => t.includes('ArrayIndexOutOfBoundsException') && t.includes('退出代码 1'));
  await runCase('E4 运行时异常：除零', 'public class Main {\n  public static void main(String[] args) {\n    System.out.println(5 / 0);\n  }\n}',
    t => t.includes('ArithmeticException: / by zero') && t.includes('退出代码 1'));
  await runCase('E5 入口缺失提示（无 main 方法）', 'public class Main {\n  int x;\n}',
    t => t.includes('未找到可运行入口'));
  // E6 空输入的 Scanner（EOF 快速失败而非挂起）
  await page.fill('#stdinTa', '');
  await runCase('E6 Scanner 空输入（EOF 快速失败，不再挂起超时）', 'import java.util.Scanner;\npublic class Main {\n  public static void main(String[] args) {\n    Scanner sc = new Scanner(System.in);\n    System.out.println("read=" + sc.nextInt());\n  }\n}',
    t => t.includes('NoSuchElementException') && t.includes('退出代码 1'), { stdin: '' });

  console.log('\n== F. 超时保护用例 ==');
  await runCase('F1 死循环 10 秒强杀（超时提示 + 非零退出）', 'public class Main {\n  public static void main(String[] args) {\n    while (true) { }\n  }\n}',
    t => t.includes('运行超时（10 秒），进程已被强制终止') && t.includes('进程已强制终止'),
    { timeoutSec: 30 });

  console.log('\n== G. 运行状态提示与流程稳定性 ==');
  // G1 运行中状态：拦截延迟观察按钮禁用与「运行中…」文案
  await page.route('**/api/projects/mine/*/run', async (route) => {
    await new Promise(r => setTimeout(r, 800));
    try { await route.continue(); } catch (e) { /* 忽略 */ }
  });
  await page.click('#btnClearOut');
  await page.fill('#ceTa', 'public class Main {\n  public static void main(String[] args) {\n    System.out.println("status check");\n  }\n}');
  await page.click('#btnRun');
  const runningLabel = (await page.locator('#btnRun').textContent()).includes('运行中')
    && await page.locator('#btnRun').isDisabled()
    && await page.locator('#btnSave').isDisabled();
  ok('G1 运行中状态提示（按钮禁用 + 「运行中…」文案 + 保存按钮联动禁用）', runningLabel);
  await page.unroute('**/api/projects/mine/*/run');
  await waitDone();
  ok('G1 运行结束后按钮恢复可用', !(await page.locator('#btnRun').isDisabled()));
  // G2 输出面板命令回显（IDEA 习惯）
  const g2 = await outText();
  ok('G2 命令行回显（javac / java 命令 + 编译通过 + 退出代码行）',
    g2.includes('> javac -encoding UTF-8 Main.java Book.java') && g2.includes('编译通过 · 入口类 Main') && g2.includes('进程已结束，退出代码 0'));
  // G3 连续多次运行结果正确（不清空累积，各自独立；直接等新结果出现，避免匹配到上次运行的结束行）
  await page.fill('#ceTa', 'public class Main {\n  public static void main(String[] args) {\n    System.out.println("round-2");\n  }\n}');
  await page.click('#btnRun');
  await page.waitForFunction(() => (document.querySelector('#bottomBody') || {}).textContent.includes('round-2'), null, { timeout: 25000 });
  const g3 = await outText();
  ok('G3 连续多次运行各自返回正确结果（无串扰/无丢失）', g3.includes('status check') && g3.includes('round-2'));
  // G4 编辑→运行→保存完整闭环（保存后版本记录含该代码）
  await page.fill('#noteInput', '运行检测：最终版本');
  await page.click('#btnSave');
  await page.waitForSelector('.ide-toast:has-text("已保存并自动生成新版本 v1")', { timeout: 8000 });
  ok('G4 编辑→运行→保存完整闭环（新版本 v1 留存）', true);
  await page.locator('.ide-btab[data-btab="versions"]').click();
  await page.waitForFunction(() => (document.querySelector('#bottomBody') || {}).textContent.includes('v1'), null, { timeout: 8000 });
  ok('G4 版本记录面板显示 v1 及版本说明', (await page.locator('#bottomBody').textContent()).includes('运行检测：最终版本'));

  // 清场
  ["DELETE FROM project_version WHERE student_project_id IN (SELECT sp.id FROM student_project sp JOIN coding_project p ON sp.project_id=p.id WHERE p.title LIKE 'E2E-RUN-%')",
   "DELETE FROM student_project WHERE project_id IN (SELECT id FROM coding_project WHERE title LIKE 'E2E-RUN-%')",
   "DELETE FROM coding_project WHERE title LIKE 'E2E-RUN-%'"].forEach(q => sql(q));
  ok('全程无页面报错/4xx5xx', errors.length === 0, errors.slice(0, 3).join(' | '));
  console.log('\n==== 运行功能检测：' + pass + ' 项通过 / ' + fail + ' 项异常 ====');
  if (anomalies.length) console.log('异常清单：\n' + anomalies.map(a => ' - ' + a).join('\n'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
