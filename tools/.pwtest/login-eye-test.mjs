/* 登录页密码可见性切换（小眼睛按钮）E2E
 * [默认] 密文态（type=password）+ 睁眼图标 + aria-label「显示密码」/aria-pressed=false
 * [切换] 点击 → 明文（type=text）值不丢 + 图标过渡到划线眼 + aria 同步；再点恢复密文
 * [连续] 连续 5 次切换状态正确交替、值始终不丢；切换后继续输入正常追加
 * [聚焦] 输入框聚焦态下点击按钮不失去焦点（pointerdown preventDefault）
 * [对齐] 按钮位于输入框内右侧且垂直居中（boundingBox 断言）
 * [动画] 按钮与图标均声明 transition（平滑过渡）
 * [无障碍] aria-label/aria-pressed/title 三态同步；Tab 聚焦按钮 + Enter/Space 触发切换
 * [键盘] 键盘可达可操作
 * [注册页] 注册表单密码框同功能
 * [移动] hasTouch 视口 tap 操作切换正常
 */
import { chromium } from 'playwright-core';
const BASE = 'http://localhost:8080';
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

  const page = await (await browser.newContext({ viewport: { width: 800, height: 800 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.goto(BASE + '/login.html');

  // 1. 默认密文态
  const defType = await page.$eval('#lgPass', e => e.type);
  const defAria = await page.$eval('#eyeLg', e => ({ label: e.getAttribute('aria-label'), pressed: e.getAttribute('aria-pressed'), title: e.title, cls: e.className }));
  ok('[默认] 密码框为密文（type=password）', defType === 'password', 'type=' + defType);
  ok('[默认] 按钮无障碍状态：显示密码 / aria-pressed=false',
    defAria.label === '显示密码' && defAria.pressed === 'false' && defAria.title === '显示密码', JSON.stringify(defAria));
  const openOp = await page.$eval('#eyeLg .eye-open', e => getComputedStyle(e).opacity);
  ok('[默认] 显示睁眼图标（提示可查看）', openOp === '1', 'opacity=' + openOp);

  // 2. 视觉对齐：按钮在输入框内右侧且垂直居中
  const ib = await page.$eval('#lgPass', e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, cx: (r.top + r.bottom) / 2 }; });
  const eb = await page.$eval('#eyeLg', e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, cy: (r.top + r.bottom) / 2 }; });
  ok('[对齐] 按钮位于输入框内右侧', eb.r <= ib.r && eb.l > ib.l, '按钮右缘 ' + Math.round(eb.r) + ' ≤ 输入框右缘 ' + Math.round(ib.r));
  ok('[对齐] 按钮垂直居中（偏差 < 2px）', Math.abs(eb.cy - ib.cx) < 2, '偏差 ' + Math.abs(Math.round(eb.cy - ib.cx)) + 'px');

  // 3. 动画过渡样式声明
  const tTr = await page.$eval('#eyeLg', e => getComputedStyle(e).transitionProperty);
  const iTr = await page.$eval('#eyeLg .eye-open', e => getComputedStyle(e).transitionProperty);
  ok('[动画] 按钮与图标均声明平滑过渡', /color/.test(tTr) && /opacity|all/.test(iTr), '按钮 ' + tTr + ' / 图标 ' + iTr);

  // 4. 切换明文：值不丢 + aria 同步 + 图标切换
  await page.fill('#lgPass', 'abc123!@#');
  await page.click('#eyeLg');
  // 等待过渡动画完成（0.18s）后再读取图标 computed opacity（立即读取会命中过渡起始值）
  await page.waitForTimeout(300);
  const st1 = await page.evaluate(() => ({
    type: document.getElementById('lgPass').type,
    val: document.getElementById('lgPass').value,
    label: document.getElementById('eyeLg').getAttribute('aria-label'),
    pressed: document.getElementById('eyeLg').getAttribute('aria-pressed'),
    cls: document.getElementById('eyeLg').className,
    openOp: getComputedStyle(document.querySelector('#eyeLg .eye-open')).opacity,
    closedOp: getComputedStyle(document.querySelector('#eyeLg .eye-closed')).opacity
  }));
  ok('[切换] 明文显示且输入内容完整保留', st1.type === 'text' && st1.val === 'abc123!@#', 'type=' + st1.type + ' value=' + st1.val);
  ok('[切换] aria 状态同步为「隐藏密码 / pressed=true」', st1.label === '隐藏密码' && st1.pressed === 'true' && st1.cls.includes('show'), JSON.stringify(st1.label));
  ok('[切换] 图标过渡到划线眼（open=0 / closed=1）', st1.openOp === '0' && st1.closedOp === '1', 'open=' + st1.openOp + ' closed=' + st1.closedOp);

  // 5. 连续切换 5 次：状态交替、值始终不丢
  let seqOk = true, seqDetail = [];
  for (let i = 0; i < 5; i++) {
    await page.click('#eyeLg');
    const s = await page.evaluate(() => ({
      type: document.getElementById('lgPass').type,
      val: document.getElementById('lgPass').value,
      pressed: document.getElementById('eyeLg').getAttribute('aria-pressed')
    }));
    if (s.val !== 'abc123!@#') seqOk = false;
    if (s.type === 'text' && s.pressed !== 'true') seqOk = false;
    if (s.type === 'password' && s.pressed !== 'false') seqOk = false;
    seqDetail.push(s.type + '/' + s.pressed);
  }
  ok('[连续] 连续 5 次切换状态交替且内容零丢失', seqOk, seqDetail.join(' '));

  // 6. 聚焦保持：聚焦密码框 → 点击按钮 → 焦点仍在密码框
  await page.click('#lgPass');
  await page.click('#eyeLg');
  const focusAfter = await page.evaluate(() => document.activeElement && document.activeElement.id);
  ok('[聚焦] 点击按钮后输入框保持聚焦', focusAfter === 'lgPass', 'activeElement=' + focusAfter);
  // 切换后继续输入正常追加（明文态）
  await page.keyboard.type('XY');
  const v2 = await page.$eval('#lgPass', e => e.value);
  ok('[输入] 切换后继续输入正常追加', v2 === 'abc123!@#XY', v2);

  // 7. 键盘可达：Tab 聚焦按钮，Enter / Space 触发切换
  await page.click('#lgUser');  // 从用户名开始 Tab 顺序
  await page.keyboard.press('Tab');  // → 密码框
  await page.keyboard.press('Tab');  // → 眼睛按钮
  const kbdFocus = await page.evaluate(() => document.activeElement && document.activeElement.id);
  ok('[键盘] Tab 可聚焦切换按钮', kbdFocus === 'eyeLg', 'activeElement=' + kbdFocus);
  const before = await page.$eval('#lgPass', e => e.type);
  await page.keyboard.press('Enter');
  const afterEnter = await page.$eval('#lgPass', e => e.type);
  await page.keyboard.press('Space');
  const afterSpace = await page.$eval('#lgPass', e => e.type);
  ok('[键盘] Enter / Space 均可触发切换', before !== afterEnter && afterEnter !== afterSpace,
    before + ' → ' + afterEnter + ' → ' + afterSpace);

  // 8. 注册表单同功能
  await page.click('#tabReg');
  await page.fill('#rgPass', 'reg123456');
  const rgDef = await page.$eval('#rgPass', e => e.type);
  await page.click('#eyeRg');
  const rgShow = await page.evaluate(() => ({
    type: document.getElementById('rgPass').type,
    val: document.getElementById('rgPass').value,
    label: document.getElementById('eyeRg').getAttribute('aria-label')
  }));
  ok('[注册页] 注册密码框同功能（明文 + 值保留 + aria 同步）',
    rgDef === 'password' && rgShow.type === 'text' && rgShow.val === 'reg123456' && rgShow.label === '隐藏密码',
    rgShow.type + ' ' + rgShow.val);

  ok('全程无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' ; '));

  // 9. 移动端触摸（hasTouch 视口 375px）：tap 切换正常
  const tp = await (await browser.newContext({ viewport: { width: 375, height: 700 }, hasTouch: true })).newPage();
  tp.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await tp.goto(BASE + '/login.html');
  await tp.fill('#lgPass', 'touch123');
  const eyeEl = await tp.$('#eyeLg');
  const tb = await eyeEl.boundingBox();
  ok('[移动] 375px 下按钮在视口内可触达', tb.x >= 0 && tb.x + tb.width <= 375 && tb.width >= 24, JSON.stringify({ x: Math.round(tb.x), w: Math.round(tb.width) }));
  await eyeEl.tap();
  const tState = await tp.evaluate(() => ({
    type: document.getElementById('lgPass').type,
    val: document.getElementById('lgPass').value
  }));
  ok('[移动] 触摸 tap 切换正常且内容保留', tState.type === 'text' && tState.val === 'touch123', tState.type + ' ' + tState.val);
  ok('移动端无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' ; '));

  console.log('\n=== 登录页密码可见性切换 E2E: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
