/* 顶栏班级标签验证：教师端 brand-sub 动态显示学情看板当前选中班级
 * 1. 登录后标签 = 默认选中班级（与侧栏选中项完全一致）
 * 2. 切换班级 → 标签同步更新为目标班级名（文本完全一致）
 * 3. 快速采样切换全程：只出现 旧值/新值 两个状态（无空串/undefined/闪烁中间态）
 * 4. 再次切回 → 标签恢复
 * 5. 学生端回归：标签仍显示学生班级名，不受影响
 * 6. 全程无 JS 报错 / 无 4xx 5xx
 */
import { chromium } from 'playwright-core';
const BASE = 'http://localhost:8080';
const errors = [];
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '（' + detail + '）' : '')); }
};

(async () => {
  let browser;
  for (const ch of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {}
  }
  if (!browser) throw new Error('无可用系统浏览器');
  process.on('exit', () => { try { browser.close(); } catch (e) {} });

  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push('http ' + r.status() + ': ' + r.url().slice(-70)); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', 'teacher');
  await page.fill('#lgPass', '123456');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.brand-sub', { timeout: 15000 });
  // 等 teacher 数据全部落库（侧栏班级列表出现且不在骨架屏）
  await page.waitForSelector('[data-act="classPick"]', { timeout: 15000 });
  for (let i = 0; i < 25; i++) {
    const t = await page.textContent('.mh-title').catch(() => '');
    if (t && !t.includes('加载中')) break;
    await page.waitForTimeout(300);
  }

  const brandSub = () => page.textContent('.brand-sub').then(t => (t || '').trim());
  const sideNames = await page.$$eval('[data-act="classPick"] .li-title', els =>
    els.map(e => e.textContent.trim().replace(/\s*切换中…/g, '')));
  ok('侧栏班级列表加载', sideNames.length >= 2, sideNames.join(' | '));

  // [1] 初始：标签 = 默认选中班级（第一个授课班级）
  const first = sideNames[0];
  let cur = await brandSub();
  ok('初始标签显示默认班级', cur === first, '「' + cur + '」');
  // 视觉属性：仍为 .brand-sub 元素（未改动样式类）
  const clsAttr = await page.getAttribute('.brand-sub', 'class');
  ok('样式类保持 .brand-sub 不变', clsAttr === 'brand-sub', clsAttr);

  // [2] 切换到第二个班级：采样全程，仅允许 旧值→新值
  const second = sideNames[1];
  const before = await brandSub();
  const seen = new Set([before]);
  const sampler = setInterval(async () => {
    try { seen.add(await brandSub()); } catch (e) {}
  }, 40);
  await page.$$eval('[data-act="classPick"]', els => els[1].click());
  // 等切换完成：toast 消失 + 侧栏高亮落位
  await page.waitForFunction((name) => {
    const on = document.querySelector('[data-act="classPick"].on .li-title');
    return on && on.textContent.trim().startsWith(name);
  }, second, { timeout: 20000 });
  clearInterval(sampler);
  seen.add(await brandSub());
  await page.waitForTimeout(600); // 收尾 render 完成后再终读一次
  const after = await brandSub();
  ok('切换后标签同步更新', after === second, '「' + before + '」→「' + after + '」');
  const badStates = [...seen].filter(t => t !== before && t !== second);
  ok('切换过程无闪烁/无异常中间态', badStates.length === 0,
    '采样 ' + seen.size + ' 种状态' + (badStates.length ? '，异常: ' + badStates.join('/') : ''));

  // [3] 切换失败场景不适用本地；改为切回第一个班级验证往返
  await page.$$eval('[data-act="classPick"]', els => els[0].click());
  await page.waitForFunction(() => {
    const on = document.querySelector('[data-act="classPick"].on .li-title');
    return on && !document.querySelector('.skel');
  }, { timeout: 20000 });
  await page.waitForTimeout(600);
  const back = await brandSub();
  ok('切回后标签恢复', back === first, '「' + back + '」');

  // [4] 学生端回归
  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', 'student');
  await page.fill('#lgPass', '123456');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.brand-sub', { timeout: 15000 });
  await page.waitForTimeout(2500);
  const stu = (await brandSub());
  ok('学生端标签不受影响', !!stu && stu !== '教师工作台', '「' + stu + '」（学生本人班级名）');

  ok('无 JS 报错 / 无 4xx 5xx', errors.length === 0, errors.slice(0, 3).join(' ; '));
  console.log('\n=== 顶栏班级标签验证: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
