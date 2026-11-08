/* 知识图谱维护 UI 测试（Playwright）：工具栏/节点菜单/弹窗交互/兼容性回归/学生端同步 */
import { chromium } from 'playwright-core';
const BASE = 'http://localhost:8080';
const errors = [];
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '（' + detail + '）' : '')); }
};

async function teacherLogin(page) {
  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', 'teacher');
  await page.fill('#lgPass', '123456');
  await page.click('#lgBtn');
  await page.waitForURL(/index/, { timeout: 15000 });
  await page.waitForSelector('.mh-title', { timeout: 20000 });
  // section 切换触发骨架屏（「加载中…」420ms）+ 教师端 8 接口并行加载，
  // 需容忍加载态并给足轮次
  for (let i = 0; i < 25; i++) {
    if (i === 0) {
      await page.click('.act-btn[data-act="section"][data-val="knowledge"]').catch(() => {});
    }
    await page.waitForTimeout(400);
    const t = await page.locator('.mh-title').first().textContent().catch(() => '');
    if (t && t.indexOf('知识图谱') === 0) return;
    if (t && t.indexOf('加载中') === 0) continue; // 骨架屏中，继续等待
    await page.click('.act-btn[data-act="section"][data-val="knowledge"]').catch(() => {});
  }
  throw new Error('未能进入知识图谱页');
}

(async () => {
  let browser;
  for (const ch of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {}
  }
  if (!browser) throw new Error('无可用系统浏览器');
  process.on('exit', () => { try { browser.close(); } catch (e) {} });

  const page = await (await browser.newContext({ viewport: { width: 1366, height: 850 } })).newPage();
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push('http ' + r.status() + ': ' + r.url().slice(-70)); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await teacherLogin(page);
  await page.waitForSelector('.kg-canvas', { timeout: 20000 });
  console.log('[1] 教师登录并进入知识图谱页');

  // [2] 工具栏：导出图片 + 重置
  const exportBtn = await page.locator('.kg-toolbar .kg-export[data-act="kgExport"]').count();
  const resetBtn = await page.locator('.kg-toolbar .kg-export[data-act="kgResetModal"]').count();
  ok('工具栏：导出图片右侧有「重置」按钮', exportBtn === 1 && resetBtn === 1, '导出 x' + exportBtn + ' 重置 x' + resetBtn);

  // [3] 进入模块视图 + 点击节点 → 节点操作菜单
  await page.click('.kg-nav-item[data-act="kgModule"] >> nth=1'); // 第二个模块
  await page.waitForTimeout(500);
  const node = page.locator('.kg-node').nth(3);
  await node.click();
  await page.waitForTimeout(500);
  const menu = await page.locator('.kg-node-menu').count();
  const menuName = menu ? (await page.locator('.kg-node-menu .kg-nm-name').textContent()).trim() : '';
  ok('点击节点后出现操作菜单（名称+添加+删除）', menu === 1
    && (await page.locator('.kg-node-menu [data-act="kgAddNodeModal"]').count()) === 1
    && (await page.locator('.kg-node-menu [data-act="kgDelNodeModal"]').count()) === 1, '选中: ' + menuName.slice(0, 20));

  // [4] 添加子知识点：空名拦截 → 创建成功 → 图谱刷新可见
  await page.click('.kg-node-menu [data-act="kgAddNodeModal"]');
  await page.waitForSelector('.modal input[data-key="name"]');
  await page.click('.modal button[data-act="doKgAddNode"]');
  const t1 = await page.waitForSelector('.toast, .toast-box', { timeout: 3000 }).catch(() => null);
  ok('空名称添加被拦截（toast）', !!t1, t1 ? (await t1.textContent()).trim().slice(0, 16) : '');
  const fname = 'UI维护节点-' + Date.now();
  await page.fill('.modal input[data-key="name"]', fname);
  await page.click('.modal button[data-act="doKgAddNode"]');
  await page.waitForTimeout(1200);
  const inGraph = await page.locator('.kg-node', { hasText: fname }).count();
  const inMenu = await page.locator('.kg-node-menu .kg-nm-name', { hasText: fname }).count();
  ok('添加后图谱即时出现新节点', inGraph >= 1, '「' + fname + '」');
  ok('选中态切换到新节点（菜单跟随）', inMenu >= 1);

  // [5] 删除：二次确认弹窗（含子树数）→ 确认 → 节点消失
  await page.click('.kg-node-menu [data-act="kgDelNodeModal"]');
  await page.waitForSelector('.modal button[data-act="doKgDelNode"]');
  const delText = await page.locator('.modal .note').textContent();
  ok('删除二次确认弹窗（含子节点提示）', /确定要删除/.test(delText), delText.trim().slice(0, 40));
  await page.click('.modal button[data-act="doKgDelNode"]');
  await page.waitForTimeout(1200);
  const gone = await page.locator('.kg-node', { hasText: fname }).count();
  ok('删除后节点从图谱消失', gone === 0);

  // [6] 重置：确认弹窗（修改丢失提示）→ 确认 → 恢复默认
  await page.click('.kg-toolbar [data-act="kgResetModal"]');
  await page.waitForSelector('.modal button[data-act="doKgReset"]');
  const rstText = await page.locator('.modal .note').textContent();
  ok('重置确认弹窗（明确提示修改将丢失）', /撤销所有自定义修改|不可撤销/.test(rstText), rstText.trim().slice(0, 40));
  await page.click('.modal button[data-act="doKgReset"]');
  await page.waitForTimeout(1500);
  const homeView = await page.locator('.kg-bubble').count();
  ok('重置后回到默认首页视图（五大模块气泡）', homeView >= 5, 'x' + homeView);

  // [7] 兼容性回归：模块切换 / 缩放 / 搜索
  await page.click('.kg-bubble >> nth=0');
  await page.waitForTimeout(500);
  const moduleNodes = await page.locator('.kg-node').count();
  ok('模块切换正常（气泡点击进入模块视图）', moduleNodes > 0, 'x' + moduleNodes);
  await page.click('.kg-zoom-btn[data-act="kgZoomIn"]');
  const pct = await page.locator('#kgZoomPct').textContent();
  ok('缩放按钮正常', /1[1-2]5%/.test(pct), pct);
  await page.fill('#kgSearchInput', '泛型');
  await page.waitForTimeout(600);
  const hits = await page.locator('#kgSearchList .kg-hit').count();
  ok('搜索定位正常', hits >= 1, '命中 x' + hits);

  // [8] 学生端同步：教师添加节点 → 学生刷新可见
  await page.click('.kg-nav-item[data-act="kgHome"]');
  await page.waitForTimeout(300);
  await page.click('.kg-bubble >> nth=1');
  await page.waitForTimeout(400);
  await page.locator('.kg-node').first().click();
  await page.waitForTimeout(400);
  const sname = '同步验证节点-' + Date.now();
  await page.click('.kg-node-menu [data-act="kgAddNodeModal"]');
  await page.fill('.modal input[data-key="name"]', sname);
  await page.click('.modal button[data-act="doKgAddNode"]');
  await page.waitForTimeout(1200);

  const sctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const spage = await sctx.newPage();
  spage.on('pageerror', e => errors.push('student pageerror: ' + e.message));
  await spage.goto(BASE + '/login.html');
  await spage.fill('#lgUser', 'student');
  await spage.fill('#lgPass', '123456');
  await spage.click('#lgBtn');
  await spage.waitForURL(/index/, { timeout: 15000 });
  await spage.waitForSelector('.mh-title', { timeout: 20000 });
  for (let i = 0; i < 10; i++) {
    await spage.click('.act-btn[data-act="section"][data-val="knowledge"]').catch(() => {});
    await spage.waitForTimeout(400);
    const t = await spage.locator('.mh-title').first().textContent().catch(() => '');
    if (t && t.indexOf('知识图谱') === 0) break;
  }
  await spage.waitForSelector('.kg-canvas', { timeout: 20000 });
  // 学生端无维护菜单/重置按钮
  const sMenu = await spage.locator('.kg-node-menu, .kg-toolbar [data-act="kgResetModal"]').count();
  ok('学生端无维护入口（菜单与重置均不显示）', sMenu === 0);
  // 学生搜索新节点验证同步
  await spage.fill('#kgSearchInput', sname);
  await spage.waitForTimeout(600);
  const sHits = await spage.locator('#kgSearchList .kg-hit', { hasText: sname }).count();
  ok('学生端搜索到教师新增节点（同步）', sHits >= 1, '「' + sname + '」');
  await sctx.close();

  // [9] 教师重置清理现场
  await page.click('.kg-toolbar [data-act="kgResetModal"]').catch(() => {});
  await page.waitForSelector('.modal button[data-act="doKgReset"]', { timeout: 5000 }).catch(() => {});
  await page.click('.modal button[data-act="doKgReset"]').catch(() => {});
  await page.waitForTimeout(1200);

  ok('全程无 JS 报错/异常请求', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log('\n=== 图谱维护 UI 测试: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); if (errors.length) console.error(errors.join('\n')); process.exit(1); });
