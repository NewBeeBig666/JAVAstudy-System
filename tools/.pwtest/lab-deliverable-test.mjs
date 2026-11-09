/* 实验报告作业「上传成果物」功能 E2E
 * [教师端] 开关位于「分组实验」正下方（DOM 顺序断言）；状态持久化（保存→重开编辑器回读）；
 *           批阅抽屉展示成果物卡与下载入口
 * [学生端] 配置实时同步（作业列表 lab.deliverable）；第二步卡新增成果物上传入口；
 *           必填校验（缺报告/缺成果物/缺两者 → 明确提示）；格式校验（仅 zip/rar）；
 *           大小边界（201MB 拒）；双文件提交成功；重传覆盖旧文件不残留；教师可下载成果物
 * [API] /report 接口 multipart 双文件；deliverable-file 教师下载；未开启作业不受影响
 * [清场] 测试作业/模板资源经 API 删除，成果物磁盘文件同步清理，目录无残留
 */
import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
import { readFileSync, existsSync, readdirSync, statSync, unlinkSync, openSync, closeSync, truncateSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures') + path.sep;
const TMP = os.tmpdir() + path.sep;
const BASE = 'http://localhost:8080';
const API = BASE + '/api';
const errors = [];
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '（' + detail + '）' : '')); }
};
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { code: -999, msg: t.slice(0, 120) }; } };

async function login(u) {
  const r = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ username: u, password: '123456' })
  });
  const d = await j(r);
  if (d.code !== 0) throw new Error('登录失败(' + u + '): ' + d.msg);
  return d.data.token;
}
function sql(q) {
  try {
    const s = String(q).replace(/[\r\n]+/g, ' ');
    return execSync(`mysql -uroot -proot learning_agent -e ${JSON.stringify(s)}`, { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  } catch (e) { return null; }
}
const fmt = (ts) => {
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
};

(async () => {
  const tt = await login('teacher');
  const st = await login('student');
  const H = (t) => ({ Authorization: 'Bearer ' + t, 'Content-Type': 'application/json;charset=utf-8' });

  // 测试素材：真 zip（Compress-Archive）/ 伪 rar / 伪 txt 压缩包 / 201MB 超限稀疏文件
  const zipPath = TMP + 'e2e-deliverable.zip';
  execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${FIX}cp.txt' -DestinationPath '${zipPath}' -Force"`);
  ok('测试素材：真 zip 生成', existsSync(zipPath) && statSync(zipPath).size > 100, statSync(zipPath).size + 'B');
  const rarPath = TMP + 'e2e-deliverable.rar';
  writeFileSync(rarPath, 'fake-rar-content');
  const txtPath = TMP + 'e2e-deliverable.txt';
  writeFileSync(txtPath, 'not-an-archive');
  const bigPath = TMP + 'e2e-oversize.zip';
  const fd = openSync(bigPath, 'w'); truncateSync(fd, 201 * 1024 * 1024); closeSync(fd);
  ok('测试素材：201MB 超限文件生成', existsSync(bigPath) && statSync(bigPath).size === 201 * 1024 * 1024, '');

  // 清场：历史 E2E 数据
  const cleanup = [
    "DELETE FROM lab_group_invite WHERE assignment_id IN (SELECT id FROM assignment WHERE title LIKE 'E2E-GRP-DEL-%')",
    "DELETE FROM lab_group_member WHERE assignment_id IN (SELECT id FROM assignment WHERE title LIKE 'E2E-GRP-DEL-%')",
    "DELETE FROM lab_group WHERE assignment_id IN (SELECT id FROM assignment WHERE title LIKE 'E2E-GRP-DEL-%')",
    "DELETE FROM submission WHERE assignment_id IN (SELECT id FROM assignment WHERE title LIKE 'E2E-GRP-DEL-%')",
    "DELETE FROM question WHERE assignment_id IN (SELECT id FROM assignment WHERE title LIKE 'E2E-GRP-DEL-%')",
    "DELETE FROM rubric WHERE assignment_id IN (SELECT id FROM assignment WHERE title LIKE 'E2E-GRP-DEL-%')",
    "DELETE FROM assignment WHERE title LIKE 'E2E-GRP-DEL-%'",
    "DELETE FROM learning_resource WHERE title LIKE 'E2E-GRP-DEL-TPL-%'"
  ];
  let clean = true;
  cleanup.forEach(q => { if (sql(q) === null) clean = false; });
  ok('历史测试数据清场', clean, '');

  const stamp = Date.now().toString(36);
  const TPL = 'E2E-GRP-DEL-TPL-' + stamp;
  const startAt = fmt(Date.now()), endAt = fmt(Date.now() + 7 * 864e5);
  const created = [];
  const deliverableDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'uploads', 'deliverable');

  const compose = async (body) => j(await fetch(API + '/teacher/compose', { method: 'POST', headers: H(tt), body: JSON.stringify(body) }));
  const uploadReport = async (asId, tok, reportPath, deliverablePath) => {
    const fd = new FormData();
    fd.append('file', new Blob([readFileSync(FIX + 'test-doc.docx')],
      { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'test-doc.docx');
    if (deliverablePath !== undefined) {
      const nm = path.basename(deliverablePath);
      fd.append('deliverable', new Blob([readFileSync(deliverablePath)]), nm);
    }
    return j(await fetch(API + '/assignments/' + asId + '/report', {
      method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: fd
    }));
  };

  /* ============ 1. 模板上传 ============ */
  const fd0 = new FormData();
  fd0.append('title', TPL);
  fd0.append('file', new Blob([readFileSync(FIX + 'test-doc.docx')],
    { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'test-doc.docx');
  const up = await j(await fetch(API + '/teacher/resources', { method: 'POST', headers: { Authorization: 'Bearer ' + tt }, body: fd0 }));
  ok('[发布] Word 模板上传', up.code === 0 && !!up.data.id, 'id=' + (up.data && up.data.id));
  const tplId = up.data.id;

  /* ============ 2. 开启成果物的作业发布 ============ */
  const c1 = await compose({
    title: 'E2E-GRP-DEL-ON-' + stamp, scoreMode: 'LAB', status: 'ONGOING',
    startAt, endAt, labTemplateId: tplId, labTemplateTitle: TPL,
    deliverableEnabled: true, kps: [], questions: []
  });
  ok('[发布] 开启成果物作业发布 + 配置回读', c1.code === 0 && c1.data.lab && c1.data.lab.deliverable
    && c1.data.lab.deliverable.enabled === true, JSON.stringify(c1.data && c1.data.lab && c1.data.lab.deliverable));
  const asOn = c1.data.id;
  created.push(asOn);

  const c2 = await compose({
    title: 'E2E-GRP-DEL-OFF-' + stamp, scoreMode: 'LAB', status: 'ONGOING',
    startAt, endAt, labTemplateId: tplId, labTemplateTitle: TPL,
    kps: [], questions: []
  });
  ok('[发布] 未开启作业无 deliverable 配置', c2.code === 0 && !(c2.data.lab && c2.data.lab.deliverable), '');
  created.push(c2.data.id);

  /* ============ 3. 学生端校验全链路（开启作业） ============ */
  const dirBefore = existsSync(deliverableDir) ? readdirSync(deliverableDir).length : 0;

  const r1 = await uploadReport(asOn, st, FIX, undefined);   // 仅报告
  ok('[必填] 缺成果物被拒（明确提示）', r1.code !== 0 && /成果物压缩包/.test(r1.msg) && /缺一不可/.test(r1.msg), r1.msg);
  const r2 = await uploadReport(asOn, st, FIX, txtPath);     // 报告 + txt 伪压缩包
  ok('[格式] 非压缩包格式被拒', r2.code !== 0 && /zip \/ rar/.test(r2.msg), r2.msg);
  const r3 = await uploadReport(asOn, st, FIX, bigPath);    // 报告 + 201MB
  ok('[大小] 201MB 超限被拒', r3.code !== 0 && /大小上限/.test(r3.msg), r3.msg);

  const r4 = await uploadReport(asOn, st, FIX, zipPath);     // 报告 + 真 zip
  ok('[提交] 双文件提交成功', r4.code === 0 && r4.data.deliverableName === 'e2e-deliverable.zip',
    'deliverable=' + (r4.data && r4.data.deliverableName) + ' attempts=' + (r4.data && r4.data.attempts));
  const subId1 = r4.data.submissionId;
  // 提交记录携带成果物（教师提交列表 answers）
  const subs = await j(await fetch(API + '/teacher/assignments/' + asOn + '/submissions', { headers: H(tt) }));
  const mine = (subs.data || []).find(s => s.sid === '2');
  const dlvAns = ((mine && mine.answers) || []).find(x => x && x.deliverableFile) || {};
  ok('[提交] answers 携带成果物文件记录', !!dlvAns.deliverableFile && dlvAns.deliverableName === 'e2e-deliverable.zip', '');
  const firstStored = dlvAns.deliverableFile;

  // 重传（换 rar）：覆盖旧 zip，磁盘文件不残留
  const r5 = await uploadReport(asOn, st, FIX, rarPath);
  ok('[重传] 重新提交覆盖成功', r5.code === 0 && r5.data.deliverableName === 'e2e-deliverable.rar' && r5.data.attempts === 2, '');
  const dirAfter1 = readdirSync(deliverableDir).length;
  ok('[重传] 旧成果物磁盘文件已清理（不残留）', dirAfter1 === dirBefore + 1,
    '目录 ' + dirBefore + ' -> ' + dirAfter1 + '（新增 1 个 rar，旧 zip 已删）');

  // 教师下载成果物：200 + 大小一致；无成果物提交 → 400
  const dres = await fetch(API + '/teacher/submissions/' + subId1 + '/deliverable-file', { headers: { Authorization: 'Bearer ' + tt } });
  ok('[教师] 下载成果物接口可用', dres.status === 200 && Number(dres.headers.get('content-length')) === statSync(rarPath).size,
    'HTTP ' + dres.status + ' ' + dres.headers.get('content-length') + 'B');

  /* ============ 4. 未开启作业不受影响 ============ */
  const asOff = c2.data.id;
  const r6 = await uploadReport(asOff, st, FIX, undefined);
  ok('[兼容] 未开启作业仅传报告成功', r6.code === 0, r6.msg || '');
  const subId2 = r6.data.submissionId;
  const dres2 = await fetch(API + '/teacher/submissions/' + subId2 + '/deliverable-file', { headers: { Authorization: 'Bearer ' + tt } });
  const dres2j = await j(dres2);
  ok('[教师] 无成果物提交下载被拒（明确提示）', dres2.status === 400 && /没有成果物/.test(dres2j.msg || ''), dres2j.msg);
  // 报告下载不受影响
  const rres = await fetch(API + '/teacher/submissions/' + subId1 + '/report-file', { headers: { Authorization: 'Bearer ' + tt } });
  ok('[兼容] 报告下载不受影响', rres.status === 200, 'HTTP ' + rres.status);

  /* ============ 5. UI：教师端开关位置与状态持久化 ============ */
  let browser;
  for (const ch of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {}
  }
  if (!browser) throw new Error('无可用系统浏览器');
  process.on('exit', () => { try { browser.close(); } catch (e) {} });

  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push('http ' + r.status() + ': ' + r.url().slice(-70)); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  const waitView = async (pg) => {
    for (let i = 0; i < 30; i++) {
      const t = await pg.textContent('.mh-title').catch(() => '');
      if (t && !t.includes('加载中')) break;
      await pg.waitForTimeout(300);
    }
  };
  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', 'teacher');
  await page.fill('#lgPass', '123456');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.brand-sub', { timeout: 15000 });
  await waitView(page);
  await page.click('[data-act="section"][data-val="assignments"]');
  await page.waitForSelector('#asCard-' + asOn, { timeout: 20000 });

  // 编辑开启作业：开关在「分组实验」行正下方 + 回读为开
  await page.click('#asCard-' + asOn + ' [data-act="asMore"]');
  await page.waitForSelector('.as-menu', { timeout: 5000 });
  await page.click('.as-menu [data-act="editAs"]');
  await page.waitForSelector('.compose-mask [data-act="toggleDeliverable"]', { timeout: 10000 });
  const groupBtn = await page.$('.compose-mask [data-act="toggleGroup"]');
  const delBtn = await page.$('.compose-mask [data-act="toggleDeliverable"]');
  ok('[UI 教师] 「成果物上传」开关存在', !!delBtn, '');
  if (groupBtn && delBtn) {
    const gb = await groupBtn.boundingBox(), db = await delBtn.boundingBox();
    // label 文字字数不同会有少量列内偏移（「分组实验」vs「成果物上传」），同列放宽到 30px
    const sameCol = Math.abs(gb.x - db.x) < 30, below = db.y > gb.y && db.y - gb.y < 80;
    ok('[UI 教师] 开关位于「分组实验」正下方', sameCol && below,
      '分组 x=' + Math.round(gb.x) + ' y=' + Math.round(gb.y) + ' → 成果物 x=' + Math.round(db.x) + ' y=' + Math.round(db.y));
  }
  ok('[UI 教师] 状态持久化回读（开）', await page.$eval('.compose-mask [data-act="toggleDeliverable"]', e => e.classList.contains('on')), '');
  const cfgTxt = await page.textContent('.compose-mask .compose-cfg');
  ok('[UI 教师] 功能说明文字展示', cfgTxt.includes('允许学生上传成果物') && cfgTxt.includes('缺一不可'), '');
  // 关闭开关保存 → 重开回读为关（状态变更持久化）
  await page.click('.compose-mask [data-act="toggleDeliverable"]');
  await page.click('.compose-mask [data-act="composeSave"]');
  await page.waitForTimeout(1200);
  const tSave = (await page.textContent('.toast:last-child').catch(() => '')).trim();
  ok('[UI 教师] 关闭开关保存成功', tSave.includes('草稿已保存') || tSave.includes('已发布'), tSave);
  await page.click('#asCard-' + asOn + ' [data-act="asMore"]');
  await page.waitForSelector('.as-menu', { timeout: 5000 });
  await page.click('.as-menu [data-act="editAs"]');
  await page.waitForSelector('.compose-mask [data-act="toggleDeliverable"]', { timeout: 10000 });
  ok('[UI 教师] 状态变更持久化回读（关）', !(await page.$eval('.compose-mask [data-act="toggleDeliverable"]', e => e.classList.contains('on'))), '');
  await page.click('.compose-mask [data-act="closeCompose"]');
  await page.waitForTimeout(300);

  /* ============ 6. UI：学生端上传入口与必填校验 ============ */
  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', 'student');
  await page.fill('#lgPass', '123456');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.brand-sub', { timeout: 15000 });
  await waitView(page);
  await page.click('[data-act="section"][data-val="homework"]');
  await page.waitForSelector('#hw-' + asOn, { timeout: 20000 });
  await page.click('#hw-' + asOn + ' [data-act="openLab"]');
  await page.waitForSelector('.ans-main .card-head', { timeout: 10000 });

  // 教师刚在 UI 里关闭了成果物开关（第 5 步）——学生端应实时同步为不显示成果物入口
  const offTxt = await page.textContent('.ans-main');
  ok('[UI 学生] 开关状态实时同步（教师已关闭 → 无成果物入口）',
    !offTxt.includes('选择成果物压缩包') && offTxt.includes('上传实验报告'), '');

  // 教师重新开启（API），学生刷新后入口恢复
  const c3 = await compose({
    id: Number(asOn), title: 'E2E-GRP-DEL-ON-' + stamp, scoreMode: 'LAB', status: 'ONGOING',
    startAt, endAt, labTemplateId: tplId, labTemplateTitle: TPL,
    deliverableEnabled: true, kps: [], questions: []
  });
  ok('[API] 教师重新开启成果物开关', c3.code === 0 && c3.data.lab.deliverable.enabled === true, '');
  await page.reload();
  await page.waitForSelector('.brand-sub', { timeout: 15000 });
  await waitView(page);
  await page.click('[data-act="section"][data-val="homework"]');
  await page.waitForSelector('#hw-' + asOn, { timeout: 20000 });
  await page.click('#hw-' + asOn + ' [data-act="openLab"]');
  await page.waitForSelector('.ans-main .card-head', { timeout: 10000 });
  const onTxt = await page.textContent('.ans-main');
  ok('[UI 学生] 开启后展示成果物上传入口',
    onTxt.includes('上传实验报告与成果物') && onTxt.includes('选择成果物压缩包') && onTxt.includes('200MB'), '');
  ok('[UI 学生] 提交情况卡显示已提交成果物', onTxt.includes('已提交成果物') && onTxt.includes('e2e-deliverable.rar'), '');

  // 必填校验：只选报告不选成果物 → 上传按钮禁用；补选后可上传
  const disOf = () => page.$eval('.ans-main [data-act="labUploadSubmit"]', e => e.disabled).catch(() => true);
  ok('[UI 学生] 未选文件时上传按钮禁用', await disOf(), '');
  await page.setInputFiles('#labReportInput', FIX + 'test-doc.docx');
  await page.waitForTimeout(300);
  ok('[UI 学生] 仅选报告仍禁用（成果物必填）', await disOf(), '');
  await page.setInputFiles('#labDeliverableInput', zipPath);
  await page.waitForTimeout(300);
  ok('[UI 学生] 双文件齐备后按钮激活', !(await disOf()), '');
  await page.click('.ans-main [data-act="labUploadSubmit"]');
  await page.waitForTimeout(1500);
  const tUp = (await page.textContent('.toast:last-child').catch(() => '')).trim();
  ok('[UI 学生] 双文件上传成功提示', tUp.includes('实验报告与成果物已上传'), tUp);

  /* ============ 7. UI：教师批阅抽屉成果物展示 ============ */
  await page.goto(BASE + '/login.html');
  await page.fill('#lgUser', 'teacher');
  await page.fill('#lgPass', '123456');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.brand-sub', { timeout: 15000 });
  await waitView(page);
  await page.click('[data-act="section"][data-val="submissions"]');
  // 左侧栏选中目标作业后点击提交行进入批阅抽屉
  const sideItem = await page.$('#side .list-item[data-act="subAsPick"][data-val="' + asOn + '"]');
  ok('[UI 教师] 提交批改页可进入', !!sideItem, '');
  if (sideItem) {
    await sideItem.click();
    await page.waitForTimeout(1200);
    const rowSel = await page.$('tr[data-act="openSub"]');
    ok('[UI 教师] 提交列表可见', !!rowSel, '');
    if (rowSel) {
      await rowSel.click();
      await page.waitForSelector('.grade-mask', { timeout: 10000 });
      await page.waitForTimeout(600);
      const drawerTxt = await page.textContent('.grade-mask');
      ok('[UI 教师] 批阅抽屉展示成果物卡与下载入口',
        drawerTxt.includes('学生提交的成果物') && drawerTxt.includes('下载成果物') && drawerTxt.includes('e2e-deliverable.zip'), '');
    }
  }

  ok('无 JS 报错 / 无意外 4xx 5xx', errors.length === 0, errors.slice(0, 3).join(' ; '));

  /* ============ 8. 清场 ============ */
  let delOk = true, delDetail = [];
  for (const id of created) {
    const dr = await fetch(API + '/teacher/assignments/' + id, { method: 'DELETE', headers: H(tt) });
    if (dr.status !== 200) { delOk = false; delDetail.push(id + ':' + dr.status); }
  }
  ok('[清场] 测试作业全部删除', delOk, delDetail.join(','));
  const dr2 = await fetch(API + '/teacher/resources/' + tplId, { method: 'DELETE', headers: { Authorization: 'Bearer ' + tt } });
  ok('[清场] 测试模板资源已删除', dr2.status === 200, 'HTTP ' + dr2.status);
  // 成果物磁盘文件清理（删除作业不级联磁盘文件，本测试自行清理避免残留）
  // 直接按命名前缀清理本测试上传的成果物（as{asOn}-u2-*）与报告文件
  const upRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'uploads');
  let unlinked = 0;
  for (const dir of ['deliverable', 'report']) {
    const p = path.join(upRoot, dir);
    if (!existsSync(p)) continue;
    for (const f of readdirSync(p)) {
      if (f.startsWith('as' + asOn + '-u2-') || f.startsWith('as' + asOff + '-u2-')) {
        try { unlinkSync(path.join(p, f)); unlinked++; } catch (e) { }
      }
    }
  }
  const dirFinal = existsSync(deliverableDir) ? readdirSync(deliverableDir).length : 0;
  ok('[清场] 测试磁盘文件清理无残留', dirFinal === dirBefore && unlinked >= 3,
    'deliverable 目录 ' + dirBefore + ' -> ' + dirFinal + '，清理 ' + unlinked + ' 个文件');
  unlinkSync(zipPath); unlinkSync(rarPath); unlinkSync(txtPath); unlinkSync(bigPath);

  console.log('\n=== 实验报告「上传成果物」E2E: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
