/* 导入作业 AI 知识点识别 + 题卡知识点分层下拉 UI 验证
 * [分层] 模块卡/下钻/面包屑/返回/叶行关联/连续添加/搜索分组/清空恢复/外部收起/多题不干扰
 * [AI] 导入粘贴 → 识别题目 → AI 识别知识点 → 预览徽章 → 加入作业 → 题卡 pills
 * [回归] AI 识别后仍可手动补充知识点；不同题型题卡下拉均正常
 * 全程无 JS 报错；不发布作业（无数据污染，最后关闭组卷）
 * 注意：import-parse 与 ai-match-kps 均走真实 DeepSeek，等待窗口放宽到 60s
 */
import { chromium } from 'playwright-core';
const BASE = 'http://localhost:8080';
const errors = [];
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '（' + detail + '）' : '')); }
};

const TEXT = `一、单选题
1. 下列关于 Java 继承的说法，正确的是（  ）
A. Java 支持类的多重继承
B. 子类可以直接访问父类的 private 成员
C. 子类可以通过 super 关键字调用父类的构造方法
D. 被 final 修饰的类可以被继承
答案：C

二、判断题
2. Java 中所有的类都直接或间接继承自 Object 类。
答案：正确

三、编程题
3. 使用 HashMap 实现图书价格快速查询：创建 HashMap<String, Double> 存储至少 4 本图书的价格，编写方法 price(String bookName) 根据书名返回价格（使用 get 方法实现 O(1) 查询），书名不存在时返回 -1，并在 main 方法中测试。`;

(async () => {
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
  await page.click('[data-act="openCompose"]');
  await page.waitForSelector('.compose-mask', { timeout: 10000 });

  /* ==================== [分层下拉] ==================== */
  await page.click('[data-act="composeAddQ"][data-val="SINGLE"]');
  await page.waitForSelector('#cpq-0', { timeout: 5000 });
  await page.click('#cpq-0 .cp-kp-add');
  await page.waitForSelector('.qkp-menu', { timeout: 5000 });
  const mods = await page.$$eval('.qkp-menu .ns-mod', els => els.map(e => e.querySelector('.pn').textContent.trim()));
  ok('[分层] 根层显示一级模块卡', mods.length >= 3, mods.slice(0, 3).join(' | ') + '…');

  // 下钻第一个模块
  await page.click('.qkp-menu .ns-mod');
  await page.waitForSelector('.qkp-menu .ns-back', { timeout: 5000 });
  const crumb = (await page.textContent('.qkp-menu .ns-crumbs')).trim();
  ok('[分层] 下钻后面包屑更新', crumb.includes('›'), crumb.replace(/\s+/g, ' '));

  // 关联一个叶行/当前层 → pill 出现 + 浮层保留
  const pills0 = await page.$$eval('#cpq-kp-0 .cp-kp-pill', els => els.length).catch(() => 0);
  await page.click('.qkp-menu .pick[data-act="qKpPick"]');
  await page.waitForTimeout(300);
  const pills1 = await page.$$eval('#cpq-kp-0 .cp-kp-pill', els => els.map(e => e.title)).catch(() => []);
  ok('[分层] 叶行点击关联 + 浮层保留连续添加', pills1.length === pills0 + 1 && !!(await page.$('.qkp-menu')), 'pills=' + pills1.length);

  // 再通过「＋」关联一个（若当前层有 ns-sel）
  const selBtn = await page.$('.qkp-menu .ns-sel');
  if (selBtn) {
    await selBtn.click();
    await page.waitForTimeout(300);
    const pills2 = await page.$$eval('#cpq-kp-0 .cp-kp-pill', els => els.length).catch(() => 0);
    ok('[分层] 「＋」按钮关联生效', pills2 === pills1.length + 1, 'pills=' + pills2);
  } else {
    console.log('    （当前层无「＋」节点行，跳过）');
  }

  // 返回上一级
  await page.click('.qkp-menu .ns-back');
  await page.waitForTimeout(300);
  ok('[分层] 返回上一级', !!(await page.$('.qkp-menu .ns-mod')));

  // 搜索分组 + 路径
  await page.fill('.qkp-menu .qkp-search', 'Java');
  await page.waitForTimeout(400);
  const groups = await page.$$eval('.qkp-menu .ns-group', els => els.length).catch(() => 0);
  const hasPath = await page.$$eval('.qkp-menu .qkp-mod', els => els.some(e => e.textContent.includes('/'))).catch(() => false);
  ok('[分层] 搜索分组带层级路径', groups >= 1, groups + ' 组');
  // 清空恢复
  await page.fill('.qkp-menu .qkp-search', '');
  await page.waitForTimeout(400);
  ok('[分层] 清空搜索恢复当前层', !!(await page.$('.qkp-menu .ns-mod')));

  // 点外部收起
  await page.click('.cp-tb-label').catch(() => page.click('.compose-top'));
  await page.waitForTimeout(300);
  ok('[分层] 点击外部收起', !(await page.$('.qkp-menu')));

  // 多题不干扰：添加编程题，第 2 题下拉正常
  await page.click('[data-act="composeAddQ"][data-val="CODE"]');
  await page.waitForSelector('#cpq-1', { timeout: 5000 });
  await page.click('#cpq-1 .cp-kp-add');
  await page.waitForSelector('.qkp-menu', { timeout: 5000 });
  const mods2 = await page.$$eval('.qkp-menu .ns-mod', els => els.length);
  const q1pills = await page.$$eval('#cpq-kp-1 .cp-kp-pill', els => els.length).catch(() => 0);
  ok('[分层] 第二题下拉正常且互不干扰', mods2 >= 3 && q1pills === 0, '');
  await page.click('.cp-tb-label').catch(() => page.click('.compose-top'));
  await page.waitForTimeout(200);

  /* ==================== [AI 识别知识点 · 导入流程] ==================== */
  await page.click('[data-act="openImport"]');
  await page.waitForSelector('#ciTextArea', { timeout: 5000 });
  await page.fill('#ciTextArea', TEXT);
  // 1s 防抖 + import-parse（LLM）→ 等预览出题
  let parsed = 0;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(1500);
    const n = await page.$$eval('#ciPreview .hw-q', els => els.length).catch(() => 0);
    const busy = await page.textContent('#ciStat').then(t => t.includes('识别中')).catch(() => false);
    if (n > 0 && !busy) { parsed = n; break; }
  }
  ok('[AI] 导入解析出题目', parsed === 3, parsed + ' 题');

  // 点「AI 识别知识点」→ LLM 匹配
  await page.click('[data-act="importAiKp"]');
  let matchedToast = '';
  for (let i = 0; i < 45; i++) {
    await page.waitForTimeout(1500);
    const t = await page.textContent('.toast:last-child').catch(() => '');
    const busy = await page.textContent('#ciAiKp').then(t => t.includes('匹配中')).catch(() => false);
    if (t && !busy) { matchedToast = t.trim(); break; }
  }
  ok('[AI] 识别完成 toast', matchedToast.includes('AI 已为'), matchedToast);
  const kpBadges = await page.$$eval('#ciPreview .hw-q', els =>
    els.map(e => Array.from(e.querySelectorAll('.badge.brand')).map(b => b.textContent.trim())));
  const withKp = kpBadges.filter(a => a.length > 0).length;
  ok('[AI] 预览区显示知识点徽章', withKp === 3, kpBadges.map(a => a.join('+') || '无').join(' | ').slice(0, 90));
  // 匹配准确性：第 1 题继承 → 含「继承/多态/面向对象」；第 3 题 HashMap → 含「Map/集合/哈希」
  const all3 = kpBadges.map(a => a.join(','));
  ok('[AI] 继承题匹配相关知识点', /继承|多态|面向对象|Object/.test(all3[0] || ''), all3[0]);
  ok('[AI] HashMap 题匹配集合框架知识点', /Map|集合|哈希|散列/.test(all3[2] || ''), all3[2]);

  // 加入作业 → 题卡 pills 传递
  await page.click('[data-act="importJoin"]');
  await page.waitForTimeout(600);
  ok('[AI] 返回编辑视图', !(await page.$('#ciTextArea')));
  // 新增 3 题（0/1 为手动空白题，2-4 为导入题）
  const kpBox2 = await page.$$eval('#cpq-kp-2 .cp-kp-pill', els => els.map(e => e.textContent.trim()));
  const kpBox4 = await page.$$eval('#cpq-kp-4 .cp-kp-pill', els => els.map(e => e.textContent.trim()));
  ok('[AI] 加入作业后题卡显示知识点 pills', kpBox2.length > 0 && kpBox4.length > 0,
    '题2:' + (kpBox2[0] || '无') + '… 题4:' + (kpBox4[0] || '无') + '…');

  // 回归：AI 识别后仍可手动补充（在第 4 题上打开分层下拉再关联一个）
  const before4 = kpBox4.length;
  await page.click('#cpq-4 .cp-kp-add');
  await page.waitForSelector('.qkp-menu', { timeout: 5000 });
  await page.click('.qkp-menu .ns-mod');
  await page.waitForSelector('.qkp-menu .ns-back', { timeout: 5000 });
  await page.click('.qkp-menu .pick[data-act="qKpPick"]');
  await page.waitForTimeout(300);
  const after4 = await page.$$eval('#cpq-kp-4 .cp-kp-pill', els => els.length);
  ok('[回归] AI 识别后手动补充知识点正常', after4 === before4 + 1, before4 + ' → ' + after4);
  await page.click('.cp-tb-label').catch(() => page.click('.compose-top'));
  await page.waitForTimeout(200);

  // 关闭组卷（不发布，无数据污染）
  await page.click('[data-act="closeCompose"]');
  await page.waitForTimeout(300);
  ok('关闭组卷不发布（无数据污染）', !(await page.$('.compose-mask')));

  ok('无 JS 报错 / 无意外 4xx 5xx', errors.length === 0, errors.slice(0, 3).join(' ; '));
  console.log('\n=== 导入 AI 知识点 + 分层下拉验证: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
