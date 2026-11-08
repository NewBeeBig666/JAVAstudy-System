/* 修复验证：导入作业 AI 自动识别知识点（文本粘贴路径自动触发）
 * [A] 单题导入：粘贴 1 题 → 不点任何按钮 → parse 后自动 AI 匹配 → 预览徽章 → join → 题卡 pills
 * [B] 整份作业导入：8 题多题型粘贴 → 自动识别 → 全部题徽章 → join → 题卡 pills
 * [C] 分层回显：AI 关联编码在下拉列表中被排除（已关联态）；pill 名称正常显示
 * [D] API 兼容：ai-match 返回编码全部存在于当前图谱节点集（与分层结构同源匹配）
 * 全程无 JS 报错；不发布（无数据污染）
 * 注意：parse 与 match 均走真实 DeepSeek，单场景等待最长 90s
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

const SINGLE = `一、单选题
1. 下列关于 Java 继承的说法，正确的是（  ）
A. Java 支持类的多重继承
B. 子类可以直接访问父类的 private 成员
C. 子类可以通过 super 关键字调用父类的构造方法
D. 被 final 修饰的类可以被继承
答案：C`;

const FULL = `一、单选题
1. 下列关于 Java 继承的说法，正确的是（  ）
A. Java 支持类的多重继承
B. 子类可以直接访问父类的 private 成员
C. 子类可以通过 super 关键字调用父类的构造方法
D. 被 final 修饰的类可以被继承
答案：C
2. 关于 ArrayList 与 LinkedList，下列说法正确的是（  ）
A. ArrayList 底层是链表结构
B. LinkedList 查询元素比 ArrayList 快
C. ArrayList 随机访问效率高
D. 两者都不能存储 null
答案：C

二、判断题
3. Java 中所有的类都直接或间接继承自 Object 类。
答案：正确
4. HashSet 中的元素是有序且可重复的。
答案：错误

三、填空题
5. Java 中用于处理键值对映射的集合接口是____。
答案：Map

四、简答题
6. 简述方法重载（overload）与方法重写（override）的区别。
答案：重载是同一个类中方法名相同参数不同；重写是子类覆盖父类的同名同参方法。

五、编程题
7. 使用 HashMap 实现图书价格快速查询：创建 HashMap<String, Double> 存储至少 4 本图书的价格，编写方法 price(String bookName) 根据书名返回价格，书名不存在时返回 -1。
8. 定义一个抽象类 Shape，包含抽象方法 area()，再分别用 Circle 和 Rectangle 继承实现面积计算。`;

// 等待预览题目 + AI 匹配自动完成（不点任何按钮）
async function waitAuto(page, expectN) {
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1500);
    const n = await page.$$eval('#ciPreview .hw-q', els => els.length).catch(() => 0);
    const busy = await page.textContent('#ciStat').then(t => t.includes('识别中')).catch(() => false);
    const aiBusy = await page.textContent('#ciAiKp').then(t => t.includes('匹配中')).catch(() => false);
    const badges = await page.$$eval('#ciPreview .hw-q', els =>
      els.map(e => Array.from(e.querySelectorAll('.badge.brand')).length)).catch(() => []);
    if (n >= expectN && !busy && !aiBusy && badges.filter(b => b > 0).length >= expectN) {
      return await page.$$eval('#ciPreview .hw-q', els =>
        els.map(e => Array.from(e.querySelectorAll('.badge.brand')).map(b => b.textContent.trim())));
    }
  }
  return null;
}

(async () => {
  /* ==================== [D] API：返回编码与图谱节点同源 ==================== */
  const lr = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'teacher', password: '123456' })
  });
  const tok = (await j(lr)).data.token;
  const H = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json;charset=utf-8' };
  const graph = (await j(await fetch(API + '/knowledge/graph', { headers: H }))).data;
  const nodeIds = new Set(graph.nodes.map(n => n.code));
  const m = await j(await fetch(API + '/teacher/compose/ai-match-kps', {
    method: 'POST', headers: H,
    body: JSON.stringify({ questions: [
      { type: 'SINGLE', title: '关于 Java 继承与 super 关键字的说法正确的是' },
      { type: 'CODE', title: '使用 HashMap 存储图书价格并实现 O(1) 查询' }
    ] })
  }));
  const allCodes = (m.data || []).flat();
  ok('[D] AI 返回编码全部存在于当前图谱节点集', m.code === 0 && allCodes.length > 0 && allCodes.every(c => nodeIds.has(c)),
    allCodes.join(','));

  /* ==================== UI ==================== */
  let browser;
  for (const ch of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {}
  }
  if (!browser) throw new Error('无可用系统浏览器');
  process.on('exit', () => { try { browser.close(); } catch (e) {} });

  const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push('http ' + r.status() + ': ' + r.url().slice(-70)); });

  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', 'teacher');
  await page.fill('#lgPass', '123456');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.brand-sub', { timeout: 15000 });
  await page.click('[data-act="section"][data-val="assignments"]');
  for (let i = 0; i < 25; i++) {
    const t = await page.textContent('.mh-title').catch(() => '');
    if (t && !t.includes('加载中')) break;
    await page.waitForTimeout(300);
  }

  /* ==================== [A] 单题导入（纯粘贴，零点击） ==================== */
  await page.click('[data-act="openCompose"]');
  await page.waitForSelector('.compose-mask', { timeout: 10000 });
  await page.click('[data-act="openImport"]');
  await page.waitForSelector('#ciTextArea', { timeout: 5000 });
  await page.fill('#ciTextArea', SINGLE);
  const aBadges = await waitAuto(page, 1);
  ok('[A] 单题粘贴后自动识别（零点击）', !!aBadges && aBadges.length === 1 && aBadges[0].length > 0,
    aBadges ? aBadges[0].join('+') : '超时未识别');
  const aToast = await page.textContent('.toast:last-child').catch(() => '');
  ok('[A] 自动识别 toast', aToast.includes('AI 已为'), aToast.trim());
  await page.click('[data-act="importJoin"]');
  await page.waitForTimeout(500);
  const aPills = await page.$$eval('#cpq-0 .cp-kp-pill', els => els.map(e => e.textContent.replace('×', '').trim()));
  ok('[A] 加入作业后题卡显示知识点 pills', aPills.length > 0, aPills.join('、'));

  /* ==================== [B] 整份作业导入（8 题多题型） ==================== */
  await page.click('[data-act="openImport"]');
  await page.waitForSelector('#ciTextArea', { timeout: 5000 });
  await page.fill('#ciTextArea', FULL);
  const bBadges = await waitAuto(page, 8);
  const withKp = bBadges ? bBadges.filter(a => a.length > 0).length : 0;
  ok('[B] 整份作业粘贴后自动识别（8 题多题型）', bBadges !== null && withKp === 8,
    withKp + '/8 题有关联' + (bBadges ? '：' + bBadges.map(a => a.join('+') || '无').join(' | ').slice(0, 120) : ''));
  // 匹配准确性抽检：HashMap 题（第 7 题）→ 集合相关；Shape 抽象类题（第 8 题）→ 抽象/继承相关
  const q7 = bBadges ? (bBadges[6] || []).join(',') : '';
  const q8 = bBadges ? (bBadges[7] || []).join(',') : '';
  ok('[B] HashMap 题匹配集合框架', /Map|集合|哈希|散列/.test(q7), q7);
  ok('[B] 抽象类题匹配面向对象', /抽象|继承|多态|接口/.test(q8), q8);
  await page.click('[data-act="importJoin"]');
  await page.waitForTimeout(500);
  // 题卡：0=单题导入，1-8=整份导入
  const kpBoxes = [];
  for (let i = 1; i <= 8; i++) {
    kpBoxes.push(await page.$$eval('#cpq-' + i + ' .cp-kp-pill', els => els.length).catch(() => 0));
  }
  ok('[B] 加入作业后 8 张题卡全部带知识点 pills', kpBoxes.every(n => n > 0), kpBoxes.join(','));

  /* ==================== [C] 分层回显：已关联节点从下拉排除 ==================== */
  // 取第 8 题（抽象类题）的一个已关联编码，打开下拉验证该节点不在可选列表
  const q8pill = await page.$eval('#cpq-7 .cp-kp-pill', e => e.dataset.val).catch(() => '');
  await page.click('#cpq-7 .cp-kp-add');
  await page.waitForSelector('.qkp-menu', { timeout: 5000 });
  const inList = await page.$$eval('.qkp-menu [data-act="qKpPick"]',
    els => els.some(e => e.dataset.val === q8pill || e.getAttribute('data-val') === q8pill)).catch(() => false);
  ok('[C] AI 关联的节点在下拉中呈已关联态（不可重复选）', !!q8pill && !inList, 'pill=' + q8pill);
  const menuMods = await page.$$eval('.qkp-menu .ns-mod', els => els.length);
  ok('[C] 分层下拉结构正常', menuMods >= 3, menuMods + ' 个模块卡');
  await page.click('.cp-tb-label').catch(() => page.click('.compose-top'));
  await page.waitForTimeout(200);

  // 关闭组卷（不发布）
  await page.click('[data-act="closeCompose"]');
  await page.waitForTimeout(300);
  ok('关闭组卷不发布（无数据污染）', !(await page.$('.compose-mask')));

  ok('无 JS 报错 / 无意外 4xx 5xx', errors.length === 0, errors.slice(0, 3).join(' ; '));
  console.log('\n=== 导入 AI 自动识别修复验证: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
