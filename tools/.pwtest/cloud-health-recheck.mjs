/* API 健康检查 · 复核修正项（修正首轮形状假设错误的 3 项 + 验证 /exercises 正常路径与类型不匹配） */
const BASE = 'http://47.119.150.2';
const API = BASE + '/api';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else { fail++; console.log('  ✗ ' + name + '（' + detail + '）'); }
};
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { code: -999, msg: t.slice(0, 80) }; } };

(async () => {
  // CSS 实际路径
  {
    const r = await fetch(BASE + '/assets/css/styles.css');
    ok('[复核] 样式表 styles.css 可用', r.status === 200, 'HTTP ' + r.status);
  }
  const lg = await j(await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ username: 'teacher', password: '123456' })
  }));
  const tt = lg.data.token;
  const lgS = await j(await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ username: 'student', password: '123456' })
  }));
  const st = lgS.data.token;

  // /auth/me 实际返回结构
  {
    const r = await fetch(API + '/auth/me', { headers: { Authorization: 'Bearer ' + tt } });
    const d = await j(r);
    const u = d.data || {};
    const role = u.role || (u.user && u.user.role);
    ok('[复核] /auth/me 返回当前用户（role=' + (role || '?') + '）', r.status === 200 && d.code === 0 && !!role,
      JSON.stringify(u).slice(0, 100));
  }
  // /knowledge/tree 实际结构（对象含树节点）
  {
    const r = await fetch(API + '/knowledge/tree', { headers: { Authorization: 'Bearer ' + st } });
    const d = await j(r);
    const data = d.data || {};
    const hasTree = !Array.isArray(d.data) && (data.children || data.nodes || data.modules || Object.keys(data).length > 0);
    ok('[复核] 知识点树返回结构（对象）', r.status === 200 && d.code === 0 && !Array.isArray(d.data),
      'keys=' + Object.keys(data).slice(0, 6).join(','));
  }
  // /exercises 正常路径：取一个有效知识点编码
  {
    const tr = await fetch(API + '/knowledge/tree', { headers: { Authorization: 'Bearer ' + st } });
    const td = await j(tr);
    let code = null;
    const walk = n => { if (code) return; if (n && n.kp_code) { code = n.kp_code; return; } (n.children || n.nodes || []).forEach(walk); };
    const root = Array.isArray(td.data) ? td.data[0] : (td.data.children || td.data.nodes || [td.data])[0];
    walk(root || td.data);
    if (!code) {
      // 从图谱接口取编码兜底
      const gr = await fetch(API + '/knowledge/graph', { headers: { Authorization: 'Bearer ' + st } });
      const gd = await j(gr);
      code = gd.data && gd.data.nodes && gd.data.nodes[0] && (gd.data.nodes[0].kp_code || gd.data.nodes[0].code || gd.data.nodes[0].id);
    }
    if (code) {
      const r = await fetch(API + '/exercises?kpId=' + encodeURIComponent(code), { headers: { Authorization: 'Bearer ' + st } });
      const d = await j(r);
      ok('[复核] 练习题库正常路径（kpId=' + code + '）', r.status === 200 && d.code === 0 && Array.isArray(d.data),
        Array.isArray(d.data) ? d.data.length + ' 题' : d.msg);
    } else ok('[复核] 练习题库正常路径', false, '未取得有效知识点编码');
  }
  // /exercises/{id} 类型不匹配（abc）→ 预期 400，实际是否 500（同一根因验证）
  {
    const r = await fetch(API + '/exercises/abc', { headers: { Authorization: 'Bearer ' + st } });
    ok('[验证] 路径参数类型不匹配返回 400（实际 HTTP ' + r.status + '）', r.status === 400, 'HTTP ' + r.status);
  }
  // 缺少必填参数 kpId → 预期 400，实际 500（根因已定位）
  {
    const r = await fetch(API + '/exercises', { headers: { Authorization: 'Bearer ' + st } });
    ok('[验证] 缺少必填参数返回 400（实际 HTTP ' + r.status + '）', r.status === 400, 'HTTP ' + r.status);
  }
  // Swagger 暴露详情复核
  {
    const r2 = await fetch(BASE + '/v3/api-docs');
    let cnt = 0, servers = '';
    if (r2.status === 200) {
      const d = await j(r2);
      const paths = (d.data && d.data.paths) || d.paths || {};
      cnt = Object.keys(paths).length;
    }
    ok('[SEC] Swagger /v3/api-docs 暴露（' + cnt + ' 个接口文档化，未鉴权）', false, 'HTTP ' + r2.status + ' · ' + cnt + ' paths');
  }
  console.log('\n=== 复核: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
