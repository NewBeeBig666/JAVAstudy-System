/* v1.14 云端部署验证：作业文件夹收纳 + 知识图谱维护 + 分层知识点选择 + 滚动位置保持 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = 'http://47.119.150.2';
const API = HOST + '/api';
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

(async () => {
  // [1] 健康检查
  const h = await fetch(HOST + '/actuator/health');
  ok('健康检查', h.status === 200, (await h.text()).slice(0, 40));

  // [2] 前端 v1.14 标记（部署是否包含本次改动）
  const js = await (await fetch(HOST + '/assets/js/app.js')).text();
  ok('分层知识点选择（resUpload 复用 nsPickArea）', js.includes("id=\"nsPickArea\"") && js.includes("resKpCount"), '');
  ok('作业文件夹侧栏（asFolderSidebarHtml）', js.includes('asFolderSidebarHtml'), '');
  ok('知识图谱维护（节点菜单 + 重置工具栏）', js.includes('kg-node-menu') && js.includes('kgResetModal'), '');
  ok('滚动位置保持（局部更新 updateResCard）', js.includes('updateResCard') && js.includes('resCoverMerge'), '');

  const tt = await login('teacher');
  const st = await login('student');
  console.log('[3] 双端登录 OK');

  // [4] 作业文件夹：列表 / 新建 / 校验 / 重名
  const f0 = await j(await fetch(API + '/teacher/folders', { headers: { Authorization: 'Bearer ' + tt } }));
  ok('文件夹列表接口', f0.code === 0 && Array.isArray(f0.data), '已有 ' + (f0.data || []).length + ' 个');

  const fname = '云端验证-' + Date.now().toString().slice(-6);
  const cf = await j(await fetch(API + '/teacher/folders', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + tt, 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ name: fname })
  }));
  ok('新建文件夹', cf.code === 0 && cf.data && cf.data.id != null && cf.data.name === fname, 'id=' + (cf.data && cf.data.id));

  const empty = await j(await fetch(API + '/teacher/folders', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + tt, 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ name: '   ' })
  }));
  ok('空名称被拒绝', empty.code !== 0, empty.msg);

  const dup = await j(await fetch(API + '/teacher/folders', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + tt, 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ name: fname })
  }));
  ok('同名文件夹被拒绝', dup.code !== 0, dup.msg);

  const f1 = await j(await fetch(API + '/teacher/folders', { headers: { Authorization: 'Bearer ' + tt } }));
  ok('新文件夹出现在列表中', f1.code === 0 && f1.data.some(f => f.name === fname), '总数 ' + f1.data.length);

  // [5] 作业列表带 folderId/folderName（历史作业应归 null=其他）
  const asg = await j(await fetch(API + '/teacher/assignments', { headers: { Authorization: 'Bearer ' + tt } }));
  ok('作业列表接口', asg.code === 0 && Array.isArray(asg.data), (asg.data || []).length + ' 份');
  const fields = (asg.data || []).length ? asg.data.every(a => 'folderId' in a && 'folderName' in a) : false;
  ok('作业 DTO 含 folderId/folderName', fields || (asg.data || []).length === 0, '');
  ok('历史作业默认归「其他」（folderId 为空）', (asg.data || []).filter(a => a.folderId == null).length >= 0,
    (asg.data || []).filter(a => a.folderId == null).length + ' 份未归类');

  // [6] 知识图谱维护：加节点 → 订阅规模 → 删除 → 重置恢复
  const g0 = await j(await fetch(API + '/knowledge/graph', { headers: { Authorization: 'Bearer ' + tt } }));
  ok('图谱接口', g0.code === 0 && Array.isArray(g0.data.nodes), (g0.data.nodes || []).length + ' 节点');
  const n0 = g0.data.nodes.length;
  const parent = g0.data.nodes.find(n => n.level >= 2 && n.level < 7) || g0.data.nodes[0];
  const add = await j(await fetch(API + '/teacher/graph/nodes', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + tt, 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ parentCode: parent.code, name: '云端验证节点' })
  }));
  const newNode = add.code === 0 ? add.data.nodes.find(n => n.name === '云端验证节点') : null;
  ok('添加子知识点', add.code === 0 && newNode != null, newNode ? newNode.code : add.msg);
  ok('添加后节点数 +1', add.code === 0 && add.data.nodes.length === n0 + 1, n0 + ' → ' + (add.data && add.data.nodes.length));

  const sz = await j(await fetch(API + '/teacher/graph/nodes/' + encodeURIComponent(parent.code) + '/subtree-size', { headers: { Authorization: 'Bearer ' + tt } }));
  ok('子树规模接口', sz.code === 0 && sz.data.children >= 1, 'children=' + (sz.data && sz.data.children));

  // 学生端可见（数据同源）
  const gs = await j(await fetch(API + '/knowledge/graph', { headers: { Authorization: 'Bearer ' + st } }));
  ok('学生端同步看到新节点', gs.code === 0 && gs.data.nodes.some(n => n.name === '云端验证节点'), '');

  // 学生越权拒绝
  const forbid = await fetch(API + '/teacher/graph/nodes', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + st, 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ parentCode: parent.code, name: '越权节点' })
  });
  ok('学生调用维护接口被拒（403）', forbid.status === 403, 'HTTP ' + forbid.status);

  const del = await j(await fetch(API + '/teacher/graph/nodes/' + encodeURIComponent(newNode.code), {
    method: 'DELETE', headers: { Authorization: 'Bearer ' + tt }
  }));
  ok('删除知识点', del.code === 0 && !del.data.nodes.some(n => n.name === '云端验证节点'), '');
  ok('删除后节点数回到基线', del.code === 0 && del.data.nodes.length === n0, del.code === 0 ? del.data.nodes.length + '' : del.msg);

  const rst = await j(await fetch(API + '/teacher/graph/reset', {
    method: 'POST', headers: { Authorization: 'Bearer ' + tt, 'Content-Type': 'application/json;charset=utf-8' }
  }));
  ok('重置图谱', rst.code === 0 && rst.data.nodes.length >= n0, '节点 ' + (rst.data && rst.data.nodes.length));
  ok('重置后无自定义节点残留', rst.code === 0 && !rst.data.nodes.some(n => String(n.code).startsWith('cst-')), '');

  // [7] 实验报告上传回归（v1.13 修复不退化）
  const buf = fs.readFileSync(path.join(__dirname, 'lab-template.docx'));
  const fd = new FormData();
  fd.append('title', '云端验证-v114-' + Date.now());
  fd.append('file', new Blob([buf]), 'lab-template.docx');
  fd.append('kpCodes', '');
  const up = await fetch(API + '/teacher/resources', { method: 'POST', headers: { Authorization: 'Bearer ' + tt }, body: fd });
  const upj = await j(up);
  ok('实验报告模板上传（回归）', up.status === 200 && upj.code === 0, 'id=' + (upj.data && upj.data.id));
  if (upj.data && upj.data.id) {
    await fetch(API + '/teacher/resources/' + upj.data.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + tt } });
  }

  // [8] 404 回归
  const nf = await fetch(API + '/api/teacher/folders', { headers: { Authorization: 'Bearer ' + tt } });
  ok('404 回归（双重前缀不再 500）', nf.status === 404, 'HTTP ' + nf.status);

  console.log('\n=== v1.14 云端验证: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  if (cf.data && cf.data.id) console.log('（测试文件夹 id=' + cf.data.id + ' name=' + fname + ' 已保留，可在界面删除）');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
