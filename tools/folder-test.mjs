/* 作业文件夹功能 API 测试：创建/校验/列表 + 作业归类（历史归其他、新作业按 folderId 存储） */
const BASE = 'http://localhost:8080/api';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '（' + detail + '）' : '')); }
};

(async () => {
  const lr = await fetch(BASE + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'teacher', password: '123456' })
  });
  const token = (await lr.json()).data.token;
  const H = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json;charset=utf-8' };
  console.log('[1] 教师登录 OK');

  // [2] 创建文件夹（含非法用例）
  const fname = '单元测验-' + Date.now();
  const c1 = await (await fetch(BASE + '/teacher/folders', { method: 'POST', headers: H, body: JSON.stringify({ name: fname }) })).json();
  ok('创建文件夹', c1.code === 0 && c1.data.id, 'id=' + c1.data.id + ' name=' + c1.data.name);
  const fid = c1.data.id;

  const c2 = await fetch(BASE + '/teacher/folders', { method: 'POST', headers: H, body: JSON.stringify({ name: '  ' }) });
  const c2j = await c2.json();
  ok('空名称创建被拒绝', c2.status === 400 && c2j.code !== 0, c2j.msg);

  const c3 = await fetch(BASE + '/teacher/folders', { method: 'POST', headers: H, body: JSON.stringify({ name: fname }) });
  const c3j = await c3.json();
  ok('重名创建被拒绝', c3.status === 400 && c3j.code !== 0, c3j.msg);

  const c4 = await fetch(BASE + '/teacher/folders', { method: 'POST', headers: H, body: JSON.stringify({ name: '其他' }) });
  const c4j = await c4.json();
  ok('「其他」保留名被拒绝', c4.status === 400 && c4j.code !== 0, c4j.msg);

  // [3] 文件夹列表
  const fl = await (await fetch(BASE + '/teacher/folders', { headers: H })).json();
  ok('文件夹列表', fl.code === 0 && fl.data.some(f => String(f.id) === String(fid)), fl.data.map(f => f.name).join(', '));

  // [4] 历史作业全部归「其他」（folderId=null）
  const asgBefore = await (await fetch(BASE + '/teacher/assignments', { headers: H })).json();
  const hist = asgBefore.data.filter(a => a.folderId != null);
  ok('历史作业均归「其他」(folderId=null)', hist.length === 0, '共 ' + asgBefore.data.length + ' 份历史作业');

  // [5] 发布作业到指定文件夹
  const pad = n => String(n).padStart(2, '0');
  const f = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const start = new Date(Date.now() - 3600e3), end = new Date(Date.now() + 7 * 24 * 3600e3);
  const q = { type: 'SINGLE', title: '1+1=?', options: [{ key: 'A', text: '2' }, { key: 'B', text: '3' }], answer: ['A'], analysis: null, difficulty: 0.5, kpCode: null, score: null };
  const p1 = await (await fetch(BASE + '/teacher/compose', {
    method: 'POST', headers: H,
    body: JSON.stringify({ title: '文件夹归类测试A-' + Date.now(), scoreMode: 'AVERAGE', status: 'ONGOING', startAt: f(start), endAt: f(end), folderId: Number(fid), kps: [], questions: [q] })
  })).json();
  ok('发布作业到指定文件夹', p1.code === 0 && String(p1.data.folderId) === String(fid) && p1.data.folderName === fname,
    'folderId=' + p1.data.folderId + ' folderName=' + p1.data.folderName);

  const p2 = await (await fetch(BASE + '/teacher/compose', {
    method: 'POST', headers: H,
    body: JSON.stringify({ title: '文件夹归类测试B-' + Date.now(), scoreMode: 'AVERAGE', status: 'ONGOING', startAt: f(start), endAt: f(end), kps: [], questions: [q] })
  })).json();
  ok('未选文件夹发布 → 归「其他」', p2.code === 0 && p2.data.folderId == null, 'folderId=' + p2.data.folderId);

  // [6] 作业列表回流验证
  const asgAfter = await (await fetch(BASE + '/teacher/assignments', { headers: H })).json();
  const inFolder = asgAfter.data.filter(a => String(a.folderId) === String(fid));
  ok('列表回流：指定文件夹作业归类正确', inFolder.length >= 1 && inFolder.every(a => a.folderName === fname), 'x' + inFolder.length);

  // 清理测试作业与文件夹数据（作业删除走教师接口）
  for (const p of [p1, p2]) {
    await fetch(BASE + '/teacher/assignments/' + p.data.id, { method: 'DELETE', headers: H });
  }
  console.log('    （测试作业已清理）');

  console.log('\n=== 文件夹功能 API 测试: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
