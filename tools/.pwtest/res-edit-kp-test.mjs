/* 编辑关联知识点弹窗 · 分层组件改造验证
 * 1. 打开编辑弹窗 → 分层 UI（模块卡 + 搜索框 + 面包屑），原有关联回显为已选标签
 * 2. 下钻模块 → 章节/知识点层级选择；标签点 × 取消关联
 * 3. 搜索匹配（含层级路径展示），搜索态点选；清空搜索恢复模块层
 * 4. 批量关联：整模块「＋」选中 → 保存 → 列表卡片知识点徽章更新（保存生效）
 * 5. 重新打开 → 回显一致；全部取消后保存 → 清空；再按原编码恢复原关联
 * 6. 上传弹窗回归（nsPickArea 不受影响）
 * 7. 全程无 JS 报错 / 无 4xx 5xx
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

  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push('http ' + r.status() + ': ' + r.url().slice(-70)); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', 'teacher');
  await page.fill('#lgPass', '123456');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.brand-sub', { timeout: 15000 });

  // 进入学习资源页（教师端）
  await page.click('[data-act="section"][data-val="resources"]');
  for (let i = 0; i < 25; i++) {
    const t = await page.textContent('.mh-title').catch(() => '');
    if (t && !t.includes('加载中')) break;
    await page.waitForTimeout(300);
  }
  await page.waitForSelector('[data-act="resEditKp"]', { timeout: 20000 });
  ok('进入教师端学习资源页', true);

  // [1] 打开第一个资源的编辑弹窗
  await page.click('[data-act="resEditKp"]');
  await page.waitForSelector('#nsPickArea', { timeout: 10000 });
  ok('编辑弹窗渲染分层组件（nsPickArea）', true);
  const modCards = await page.$$eval('#nsPickArea .ns-mod', els => els.map(e => e.querySelector('.pn').textContent.trim()));
  ok('根层显示一级模块卡', modCards.length >= 3, modCards.slice(0, 3).join(' | ') + '…');
  ok('搜索框存在', !!(await page.$('.modal input[data-bind="reskpq"]')));
  ok('面包屑导航存在', !!(await page.$('#nsPickArea .ns-crumbs')));
  // 记录原有关联（名称 + 编码，用于最终恢复）
  const orig = await page.$$eval('#nsPills .ns-pill', els => els.map(e => ({
    name: e.textContent.trim().replace(/\s*×$/, ''),
    code: e.getAttribute('data-val')
  }))).catch(() => []);
  const initCount = await page.textContent('#resKpCount');
  ok('原有关联回显', orig.length === 0 ? initCount.includes('未选择') : initCount.includes('已选 ' + orig.length),
    '「' + initCount.trim() + '」，' + orig.length + ' 个标签');

  // [2] 下钻第一个模块 → 章节层（点选用 pickKp 行，避免点到 nsDrill 行）
  await page.click('#nsPickArea .ns-mod');
  await page.waitForSelector('#nsPickArea .ns-back', { timeout: 5000 });
  const crumbTxt = (await page.textContent('#nsPickArea .ns-crumbs')).trim().replace(/\s+/g, ' ');
  ok('下钻后面包屑更新', crumbTxt.includes('›'), crumbTxt);

  const before = await page.$$eval('#nsPills .ns-pill', els => els.length).catch(() => 0);
  const beforeCnt = (await page.textContent('#resKpCount')).trim();
  await page.click('#nsPickArea .pick-list [data-act="pickKp"]');
  await page.waitForTimeout(300);
  const afterCnt = (await page.textContent('#resKpCount')).trim();
  const after = await page.$$eval('#nsPills .ns-pill', els => els.length).catch(() => 0);
  ok('点选知识点：计数/标签联动', after === before + 1 && afterCnt !== beforeCnt, '标签 ' + before + '→' + after + '，' + beforeCnt + '→' + afterCnt);

  // 返回上一级
  await page.click('#nsPickArea .ns-back');
  await page.waitForTimeout(200);
  ok('返回上一级正常', !!(await page.$('#nsPickArea .ns-mod')));

  // 标签点 × 取消刚选的
  const pillName = await page.$eval('#nsPills .ns-pill:last-child', e => e.textContent.trim());
  await page.click('#nsPills .ns-pill:last-child');
  await page.waitForTimeout(300);
  const removedCnt = await page.$$eval('#nsPills .ns-pill', els => els.length).catch(() => 0);
  ok('标签 × 取消关联', removedCnt === after - 1, '移除「' + pillName.replace('×', '').trim() + '」');

  // [3] 搜索
  await page.fill('.modal input[data-bind="reskpq"]', 'Java');
  await page.waitForTimeout(400);
  const searchRows = await page.$$eval('#nsPickArea .pick-list .pick', els => els.length);
  ok('搜索匹配出结果', searchRows > 0, searchRows + ' 行');
  await page.fill('.modal input[data-bind="reskpq"]', '');
  await page.waitForTimeout(400);
  ok('清空搜索恢复模块层', !!(await page.$('#nsPickArea .ns-mod')));

  // [4] 批量关联：整模块「＋」选中 → 保存 → 卡片徽章更新
  await page.click('#nsPickArea .ns-mod .ns-sel');
  await page.waitForTimeout(300);
  const modCnt = (await page.textContent('#resKpCount')).trim();
  ok('整模块批量关联', modCnt.includes('已选'), '「' + modCnt + '」');
  await page.click('[data-act="doResKpSave"]');
  await page.waitForTimeout(1200);
  const savedToast = (await page.textContent('.toast').catch(() => '')).trim();
  ok('保存成功提示', savedToast.includes('已更新'), savedToast);
  await page.waitForTimeout(1200);
  const cardBadges = await page.$$eval('.card', cards => Array.from(cards[0].querySelectorAll('.card-body .badge.brand')).map(b => b.textContent.trim()));
  ok('列表卡片知识点徽章更新（保存生效）', cardBadges.length > 0, cardBadges.length + ' 个徽章');

  // [5] 重新打开 → 回显一致；全部清空保存；再恢复原关联
  await page.click('[data-act="resEditKp"]');
  await page.waitForSelector('#nsPickArea', { timeout: 10000 });
  await page.waitForTimeout(300);
  const reopenCnt = (await page.textContent('#resKpCount')).trim();
  ok('重新打开回显一致', reopenCnt === modCnt, '「' + reopenCnt + '」');

  // 清空全部（逐个点 ×）后保存
  const pillN = await page.$$eval('#nsPills .ns-pill', els => els.length).catch(() => 0);
  for (let i = 0; i < pillN; i++) {
    await page.click('#nsPills .ns-pill:last-child');
    await page.waitForTimeout(120);
  }
  const emptyCnt = (await page.textContent('#resKpCount')).trim();
  ok('全部取消关联', emptyCnt.includes('未选择'), '「' + emptyCnt + '」');
  await page.click('[data-act="doResKpSave"]');
  await page.waitForTimeout(1500);
  await page.waitForTimeout(1200);
  const clearedBadges = await page.$$eval('.card', cards => cards[0].querySelectorAll('.card-body .badge.brand').length);
  ok('清空保存后卡片徽章为 0', clearedBadges === 0, clearedBadges + ' 个');

  // 恢复原有关联（避免污染数据）：搜索名称 → 按 data-val 编码精确点选
  if (orig.length) {
    await page.click('[data-act="resEditKp"]');
    await page.waitForSelector('#nsPickArea', { timeout: 10000 });
    for (const kp of orig) {
      await page.fill('.modal input[data-bind="reskpq"]', kp.name.slice(0, 6));
      await page.waitForTimeout(350);
      const row = await page.$('#nsPickArea [data-act="pickKp"][data-val="' + kp.code + '"]');
      if (row) { await row.click(); await page.waitForTimeout(150); }
    }
    await page.fill('.modal input[data-bind="reskpq"]', '');
    await page.waitForTimeout(300);
    const restoredCnt = (await page.textContent('#resKpCount')).trim();
    ok('恢复原有关联', restoredCnt.includes('已选 ' + orig.length), '「' + restoredCnt + '」，期望 ' + orig.length + ' 个');
    await page.click('[data-act="doResKpSave"]');
    await page.waitForTimeout(1200);
  } else {
    console.log('    （该资源原无关联，跳过恢复步骤）');
  }

  // [6] 上传弹窗回归
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const modalGone = !(await page.$('.modal'));
  await page.click('[data-act="resUploadModal"]');
  await page.waitForSelector('.modal #nsPickArea', { timeout: 10000 });
  const upMods = await page.$$eval('.modal #nsPickArea .ns-mod', els => els.length);
  ok('上传弹窗分层组件回归正常', upMods >= 3, upMods + ' 个模块卡');
  await page.keyboard.press('Escape');

  ok('无 JS 报错 / 无 4xx 5xx', errors.length === 0, errors.slice(0, 3).join(' ; '));
  console.log('\n=== 编辑知识点分层改造验证: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
