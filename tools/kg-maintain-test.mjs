/* 知识图谱维护功能端到端测试：
 * 添加子节点 → 学生端同步可见 / 删除（级联子树）→ 学生端同步消失 / 重置还原默认 / 校验与鉴权 */
const BASE = 'http://localhost:8080/api';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '（' + detail + '）' : '')); }
};
const login = async u => (await (await fetch(BASE + '/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: u, password: '123456' })
})).json()).data.token;
const H = t => ({ 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json;charset=utf-8' });
const countKp = g => (g.nodes || []).length;

(async () => {
  const tt = await login('teacher');
  const st = await login('student');
  console.log('[1] 教师与学生登录 OK');

  // 基线（学生视角，两端同源）
  const g0 = await (await fetch(BASE + '/knowledge/graph', { headers: H(st) })).json();
  const N0 = countKp(g0.data);
  ok('图谱基线', N0 > 100, N0 + ' 个节点');

  // [2] 添加子节点：找一个 L3 叶子节点做父
  const parent = g0.data.nodes.find(n => n.level === 3);
  const fname = 'E2E测试节点-' + Date.now();
  const add = await (await fetch(BASE + '/teacher/graph/nodes', {
    method: 'POST', headers: H(tt), body: JSON.stringify({ parentCode: parent.code, name: fname })
  })).json();
  ok('添加子节点', add.code === 0 && countKp(add.data) === N0 + 1, '+' + fname + ' → ' + parent.name);
  const newNode = add.data.nodes.find(n => n.name === fname);
  ok('新节点继承父节点层级与模块', newNode && newNode.level === parent.level + 1
    && newNode.moduleCode === parent.moduleCode, 'L' + (newNode && newNode.level));

  // [3] 学生端同步：新节点对学生可见
  const gs1 = await (await fetch(BASE + '/knowledge/graph', { headers: H(st) })).json();
  ok('学生端同步可见新节点', gs1.data.nodes.some(n => n.name === fname), '学生视角节点数 ' + countKp(gs1.data));

  // [4] 校验：空名 / 重名
  const e1 = await (await fetch(BASE + '/teacher/graph/nodes', {
    method: 'POST', headers: H(tt), body: JSON.stringify({ parentCode: parent.code, name: ' ' })
  })).json();
  ok('空名称被拒绝', e1.code !== 0, e1.msg);
  const e2 = await (await fetch(BASE + '/teacher/graph/nodes', {
    method: 'POST', headers: H(tt), body: JSON.stringify({ parentCode: parent.code, name: fname })
  })).json();
  ok('同名兄弟被拒绝', e2.code !== 0, e2.msg);

  // [5] 删除带子树的知识点：找一个有子节点的 L2 节点
  const byParent = {};
  g0.data.nodes.forEach(n => { if (n.parentCode) (byParent[n.parentCode] = byParent[n.parentCode] || []).push(n); });
  const l2WithKids = g0.data.nodes.find(n => n.level === 2 && (byParent[n.code] || []).length >= 2);
  const kids = (byParent[l2WithKids.code] || []).length;
  const size = await (await fetch(BASE + '/teacher/graph/nodes/' + encodeURIComponent(l2WithKids.code) + '/subtree-size', { headers: H(tt) })).json();
  ok('子树规模统计', size.code === 0 && size.data.children >= kids, '子节点 ' + size.data.children + ' 个');
  const del = await (await fetch(BASE + '/teacher/graph/nodes/' + encodeURIComponent(l2WithKids.code), {
    method: 'DELETE', headers: H(tt)
  })).json();
  const expect = N0 + 1 - 1 - size.data.children; // 基线 + 自定义 - 自定义已删 - 子树
  ok('删除知识点（级联子树）', del.code === 0 && countKp(del.data) === expect,
    '「' + l2WithKids.name + '」+' + size.data.children + ' 子节点，剩余 ' + countKp(del.data) + '/' + expect);

  // [6] 学生端同步：被删节点对学生不可见
  const gs2 = await (await fetch(BASE + '/knowledge/graph', { headers: H(st) })).json();
  ok('学生端同步消失被删节点', !gs2.data.nodes.some(n => n.code === l2WithKids.code || n.name === fname), '学生视角节点数 ' + countKp(gs2.data));

  // [7] 一级模块删除被拒绝（后端兜底）
  const mod = g0.data.nodes.find(n => n.level === 1);
  const e3 = await (await fetch(BASE + '/teacher/graph/nodes/' + encodeURIComponent(mod.code), {
    method: 'DELETE', headers: H(tt)
  })).json();
  ok('一级模块删除被拒绝', e3.code !== 0, e3.msg);

  // [8] 重置：恢复默认状态（删的回来、加的清除）
  const rst = await (await fetch(BASE + '/teacher/graph/reset', { method: 'POST', headers: H(tt) })).json();
  ok('重置还原默认状态', rst.code === 0 && countKp(rst.data) === N0
    && !rst.data.nodes.some(n => n.name === fname)
    && rst.data.nodes.some(n => n.code === l2WithKids.code), N0 + ' 个节点，与基线一致');

  // [9] 鉴权：学生调维护接口 → 403
  const s403 = await fetch(BASE + '/teacher/graph/nodes', {
    method: 'POST', headers: H(st), body: JSON.stringify({ parentCode: parent.code, name: 'x' })
  });
  ok('学生无权调维护接口', s403.status === 403, 'HTTP ' + s403.status);

  console.log('\n=== 图谱维护 E2E: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
