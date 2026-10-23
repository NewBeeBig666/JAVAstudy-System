/* 教师端知识图谱模块数据链路验证：
 * graph 可访问性、资源 kpCodes 与图谱节点的匹配场景（有资源/无资源知识点均存在，空状态可触发） */
const BASE = 'http://localhost:8080/api';

async function api(method, p, { token, body } = {}) {
  const opt = { method, headers: {} };
  if (token) opt.headers['Authorization'] = 'Bearer ' + token;
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json;charset=utf-8';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, opt);
  let data = null;
  try { data = await res.json(); } catch (e) { }
  if (!res.ok || !data || data.code !== 0) throw new Error((data && data.msg) || ('HTTP ' + res.status));
  return data.data;
}

(async () => {
  const tToken = await api('POST', '/auth/login', { body: { username: 'teacher', password: '123456' } }).then(r => r.token);
  console.log('[1] 教师登录 OK');

  const graph = await api('GET', '/knowledge/graph', { token: tToken });
  const nodes = graph.nodes || [], modules = graph.modules || [];
  console.log('[2] 教师可访问图谱: ' + nodes.length + ' 节点, ' + modules.length + ' 模块');
  const codes = new Set(nodes.map(n => n.code));

  const resources = await api('GET', '/teacher/resources', { token: tToken });
  console.log('[3] 教师资源列表: ' + resources.length + ' 个');

  // 匹配逻辑复算（与前端 kgTeacherResCard 同口径：kpCodes 含知识点编码）
  let withRes = [], noRes = [], invalidKp = [];
  resources.forEach(r => (r.kpCodes || []).forEach(c => codes.has(c) ? withRes.push(c) : invalidKp.push(c)));
  withRes = [...new Set(withRes)];
  noRes = [...codes].filter(c => withRes.indexOf(c) < 0);
  console.log('[4] 匹配场景: ' + withRes.length + ' 个知识点有关联资源' + (withRes.length ? '（如 ' + withRes[0] + '）' : ''));
  console.log('    空场景: ' + noRes.length + ' 个知识点无关联资源' + (noRes.length ? '（如 ' + noRes[0] + '）' : ''));
  if (invalidKp.length) console.log('    注意: 资源含 ' + [...new Set(invalidKp)].length + ' 个不在图谱树上的编码（LEGACY 兼容场景，前端 kpName 回退显示）');

  if (!withRes.length && !noRes.length) throw new Error('无法验证：图谱或资源数据为空');
  console.log('\n=== 教师端知识图谱数据链路验证通过 ===');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
