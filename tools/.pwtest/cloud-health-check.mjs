/* 生产环境（阿里云 47.119.150.2）系统性健康检查 · API 层（只读，零副作用）
 * 覆盖：基础可用性/静态资源/鉴权矩阵/教师端全模块/学生端全模块/边缘与异常场景/性能采样
 * 原则：仅 GET 与无副作用验证（幂等删除不存在资源、非法参数拒绝），不向生产库写入任何数据
 */
const BASE = 'http://47.119.150.2';
const API = BASE + '/api';
const records = [];
let pass = 0, fail = 0;
const ok = (sec, name, cond, detail, ms) => {
  const r = { sec, name, pass: !!cond, detail: detail || '', ms: ms == null ? '' : Math.round(ms) };
  records.push(r);
  if (r.pass) { pass++; console.log('  ✓ [' + sec + '] ' + name + (detail ? '（' + detail + '）' : '') + (ms != null ? ' ' + Math.round(ms) + 'ms' : '')); }
  else { fail++; console.log('  ✗ [' + sec + '] ' + name + '（' + detail + '）' + (ms != null ? ' ' + Math.round(ms) + 'ms' : '')); }
};
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { code: -999, msg: t.slice(0, 120) }; } };

async function req(method, path, token, body) {
  const t0 = Date.now();
  const opt = { method, headers: {} };
  if (token) opt.headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json;charset=utf-8'; opt.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(API + path, opt); } catch (e) { return { res: null, status: 0, ms: Date.now() - t0, err: e.message }; }
  return { res, status: res.status, ms: Date.now() - t0 };
}

async function login(u, p) {
  const t0 = Date.now();
  const r = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ username: u, password: p })
  });
  const d = await j(r);
  return { d, ms: Date.now() - t0 };
}

(async () => {
  console.log('=== 生产系统 API 健康检查（' + new Date().toLocaleString('zh-CN') + '）===\n');

  /* ---------- [AVAIL] 基础可用性与静态资源 ---------- */
  for (const [path, name] of [
    ['/login.html', '登录页可用'], ['/index.html', '主应用页可用'],
    ['/assets/js/app.js', '前端主脚本'], ['/assets/css/styles.css', '样式表可用']
  ]) {
    const t0 = Date.now();
    try {
      const r = await fetch(BASE + path, { redirect: 'manual' });
      const enc = r.headers.get('content-encoding') || '';
      ok('AVAIL', name, r.status === 200, 'HTTP ' + r.status + (enc ? ' · ' + enc : ''), Date.now() - t0);
    } catch (e) { ok('AVAIL', name, false, e.message, Date.now() - t0); }
  }
  {
    const t0 = Date.now();
    const r = await fetch(BASE + '/assets/js/app.js');
    const txt = await r.text();
    const feats = ['coTeacherAccount', 'classDelModal', 'asFolderDelModal', 'lock:'];
    const all = feats.every(f => txt.includes(f));
    ok('AVAIL', '前端为新版本（含 v1.17 四项功能标记）', all, feats.map(f => (txt.includes(f) ? '+' : '-') + f).join(' '), Date.now() - t0);
  }

  /* ---------- [AUTH] 鉴权矩阵 ---------- */
  const tch = await login('teacher', '123456');
  ok('AUTH', '教师登录', tch.d.code === 0, tch.d.code === 0 ? 'ok' : tch.d.msg, tch.ms);
  const stu = await login('student', '123456');
  ok('AUTH', '学生登录', stu.d.code === 0, stu.d.code === 0 ? 'ok' : stu.d.msg, stu.ms);
  const bad = await login('teacher', 'wrong-password-xyz');
  ok('AUTH', '错误密码被拒', bad.d.code !== 0, bad.d.msg || 'code=' + bad.d.code);
  const noTok = await req('GET', '/teacher/classes', null);
  ok('AUTH', '无 Token 访问被拒（401）', noTok.status === 401, 'HTTP ' + noTok.status);
  const badTok = await req('GET', '/teacher/classes', 'fake.token.value');
  ok('AUTH', '伪造 Token 被拒（401）', badTok.status === 401, 'HTTP ' + badTok.status);
  const stuX = await req('GET', '/teacher/classes', stu.d && stu.d.data && stu.d.data.token);
  ok('AUTH', '学生访问教师接口被拒（403）', stuX.status === 403, 'HTTP ' + stuX.status);
  const tt = tch.d.data && tch.d.data.token, st = stu.d.data && stu.d.data.token;
  const me = await req('GET', '/auth/me', tt);
  const meD = me.res ? await j(me.res) : {};
  ok('AUTH', '/auth/me 返回当前用户', me.status === 200 && meD.code === 0
    && meD.data && meD.data.user && meD.data.user.role === 'TEACHER',
    meD.data && meD.data.user ? meD.data.user.role : me.status);

  /* ---------- [TEACHER] 教师端全模块 ---------- */
  const TT = { t: tt };
  const gjson = async (name, path, shape, times) => {
    let best = null;
    for (let i = 0; i < (times || 1); i++) {
      const r = await req('GET', path, TT.t);
      if (i === 0) {
        const d = r.res ? await j(r.res) : {};
        const okc = r.status === 200 && d.code === 0 && (!shape || shape(d.data));
        best = { r, d, okc };
      } else if (best) { await req('GET', path, TT.t); }
    }
    if (best) ok('TEACHER', name, best.okc, best.okc ? 'HTTP 200 · code 0' : ('HTTP ' + best.r.status + ' · ' + (best.d.msg || 'shape 校验失败')), best.r.ms);
  };

  let classes = [];
  {
    const r = await req('GET', '/teacher/classes', tt);
    const d = r.res ? await j(r.res) : {};
    classes = (d.data || []).filter(c => c.owned);
    ok('TEACHER', '班级列表（含 owned/studentCount 字段）', r.status === 200 && d.code === 0
      && d.data.length > 0 && d.data[0].owned !== undefined && d.data[0].studentCount !== undefined,
      d.data ? d.data.length + ' 个班级' : r.status, r.ms);
  }
  const c1 = classes[0] && classes[0].id;
  const c2 = classes[1] ? classes[1].id : c1;

  await gjson('学情看板（KPI/卡点/重点关注）', '/teacher/dashboard?classId=' + c1,
    d => d && d.kpi && Array.isArray(d.stuckPoints));
  await gjson('学生列表（掌握度/提交率）', '/teacher/students?classId=' + c1, d => Array.isArray(d) && d.length >= 0);
  await gjson('作业列表', '/teacher/assignments?classId=' + c1, d => Array.isArray(d));
  await gjson('文件夹列表（V16 班级维度）', '/teacher/folders?classId=' + c1,
    d => Array.isArray(d) && d.every(f => f.classId !== undefined));
  await gjson('预警中心', '/teacher/warnings?classId=' + c1, d => Array.isArray(d));
  await gjson('学习资源（教师端）', '/teacher/resources?classId=' + c1, d => Array.isArray(d));
  await gjson('共同管理教师面板（manageable/候选）', '/teacher/co-teachers?classId=' + c1,
    d => d && d.manageable === true && Array.isArray(d.coTeachers) && Array.isArray(d.candidates));
  await gjson('学生反馈列表', '/teacher/feedback', d => Array.isArray(d));
  await gjson('通知列表', '/notifications', d => Array.isArray(d), 3);
  await gjson('知识点树（对象结构）', '/knowledge/tree', d => d && !Array.isArray(d) && Object.keys(d).length > 0);
  await gjson('知识图谱', '/knowledge/graph', d => d && Array.isArray(d.nodes) && d.nodes.length > 0, 3);

  {
    // 从知识点树取一个二级知识点编码（detail 按设计只检索二级；/exercises 必填 kpId）
    const tr = await req('GET', '/knowledge/tree', tt);
    const td = tr.res ? await j(tr.res) : {};
    const kp0 = (td.data && td.data.knowledgePoints || [])[0];
    const code = kp0 && kp0.id;
    if (code) {
      const re = await req('GET', '/exercises?kpId=' + encodeURIComponent(code), st);
      const de = re.res ? await j(re.res) : {};
      ok('STUDENT', '练习题库正常路径（kpId=' + code + '）', re.status === 200 && de.code === 0 && Array.isArray(de.data), 'HTTP ' + re.status, re.ms);
      const r = await req('GET', '/knowledge/' + encodeURIComponent(code), tt);
      const d = r.res ? await j(r.res) : {};
      ok('TEACHER', '知识点详情（按编码，二级）', r.status === 200 && d.code === 0, 'code=' + code, r.ms);
      const r2 = await req('GET', '/knowledge/' + encodeURIComponent(code) + '/trace-chain', tt);
      const d2 = r2.res ? await j(r2.res) : {};
      ok('TEACHER', '知识点前驱链', r2.status === 200 && d2.code === 0
        && d2.data && Array.isArray(d2.data.chain), '', r2.ms);
      // 子树规模查询面向图谱全量树编码（/teacher/graph 域），用图谱首个节点验证
      const gr2 = await req('GET', '/knowledge/graph', tt);
      const gd2 = gr2.res ? await j(gr2.res) : {};
      const graphCode = (gd2.data && gd2.data.nodes || [])[0] && gd2.data.nodes[0].id;
      if (graphCode) {
        const r3 = await req('GET', '/teacher/graph/nodes/' + encodeURIComponent(graphCode) + '/subtree-size', tt);
        const d3 = r3.res ? await j(r3.res) : {};
        ok('TEACHER', '图谱维护·子树规模查询（一级模块）', r3.status === 200 && d3.code === 0
          && d3.data && d3.data.children >= 1, 'children=' + (d3.data && d3.data.children), r3.ms);
      }
    }
  }
  {
    const ar = await req('GET', '/teacher/assignments?classId=' + c1, tt);
    const ad = ar.res ? await j(ar.res) : {};
    const a1 = (ad.data || [])[0];
    if (a1) {
      const r = await req('GET', '/teacher/assignments/' + a1.id + '/submissions', tt);
      const d = r.res ? await j(r.res) : {};
      ok('TEACHER', '作业提交列表', r.status === 200 && d.code === 0 && Array.isArray(d.data), '作业「' + (a1.title || a1.id) + '」', r.ms);
    } else ok('TEACHER', '作业提交列表', true, '（无作业，跳过）');
  }
  {
    const t0 = Date.now();
    try {
      const r = await fetch(API + '/teacher/export/scores?classId=' + c1, { headers: { Authorization: 'Bearer ' + tt } });
      const buf = await r.arrayBuffer();
      const ct = r.headers.get('content-type') || '';
      ok('TEACHER', '成绩导出 Excel（二进制流）', r.status === 200 && buf.byteLength > 512,
        'HTTP ' + r.status + ' · ' + Math.round(buf.byteLength / 1024) + 'KB · ' + ct, Date.now() - t0);
    } catch (e) { ok('TEACHER', '成绩导出 Excel（二进制流）', false, e.message, Date.now() - t0); }
  }

  /* ---------- [STUDENT] 学生端全模块 ---------- */
  const ST = { t: st };
  const sjson = async (name, path, shape) => {
    const r = await req('GET', path, ST.t);
    const d = r.res ? await j(r.res) : {};
    const okc = r.status === 200 && d.code === 0 && (!shape || shape(d.data));
    ok('STUDENT', name, okc, okc ? 'HTTP 200 · code 0' : ('HTTP ' + r.status + ' · ' + (d.msg || 'shape 校验失败')), r.ms);
  };
  await sjson('学习会话列表', '/sessions', d => Array.isArray(d));
  await sjson('我的作业', '/assignments/my', d => Array.isArray(d));
  await sjson('学习概览报告', '/reports/overview', d => d && typeof d === 'object');
  await sjson('掌握度报告', '/reports/mastery', d => d && typeof d === 'object');
  await sjson('错题本', '/wrong-book', d => Array.isArray(d));
  await sjson('练习记录', '/exercise-records', d => Array.isArray(d));
  {
    // /exercises 缺少必填参数 kpId：参数校验生效，应返回 400 明确提示（整改前为 500）
    const r = await req('GET', '/exercises', st);
    const d = r.res ? await j(r.res) : {};
    ok('EDGE', '缺少必填参数返回 400 明确提示', r.status === 400 && d.code !== 0, (d.msg || '') + ' · HTTP ' + r.status);
  }
  await sjson('复习队列·今日', '/review-queue/today', d => Array.isArray(d));
  await sjson('复习队列·全部', '/review-queue/all', d => Array.isArray(d));
  await sjson('学习资源（学生端）', '/resources', d => Array.isArray(d));
  await sjson('学生通知', '/notifications', d => Array.isArray(d));

  /* ---------- [EDGE] 边缘与异常场景（全部无副作用） ---------- */
  {
    const r = await req('GET', '/teacher/co-teachers?classId=999999', tt);
    const d = r.res ? await j(r.res) : {};
    ok('EDGE', '不存在班级的共同管理面板被拒', r.status === 400 && d.code !== 0, d.msg || 'HTTP ' + r.status);
  }
  {
    const r = await req('DELETE', '/teacher/folders/999999', tt);
    const d = r.res ? await j(r.res) : {};
    ok('EDGE', '删除不存在文件夹幂等返回成功', r.status === 200 && d.code === 0, 'HTTP ' + r.status + ' · code ' + d.code);
  }
  {
    const r = await req('DELETE', '/teacher/classes/999999', tt);
    const d = r.res ? await j(r.res) : {};
    ok('EDGE', '删除不存在班级幂等返回成功', r.status === 200 && d.code === 0, 'HTTP ' + r.status + ' · code ' + d.code);
  }
  {
    const r = await req('DELETE', '/teacher/co-teachers/999?classId=' + c1, tt);
    ok('EDGE', '已下线移除接口返回 404', r.status === 404, 'HTTP ' + r.status);
  }
  {
    const r = await req('GET', '/knowledge/__not_exist__', tt);
    const d = r.res ? await j(r.res) : {};
    ok('EDGE', '不存在知识点编码被拒', r.status === 400 && d.code !== 0, d.msg || 'HTTP ' + r.status);
  }
  {
    const t0 = Date.now();
    const r = await fetch(API + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json' });
    ok('EDGE', '畸形 JSON 请求返回 400（非 500）', r.status === 400, 'HTTP ' + r.status, Date.now() - t0);
  }
  {
    const t0 = Date.now();
    const r = await fetch(BASE + '/application-secret.yml');
    ok('SEC', '机密配置文件不可访问', r.status === 404 || r.status === 403, 'HTTP ' + r.status, Date.now() - t0);
  }
  {
    const t0 = Date.now();
    const r = await fetch(BASE + '/uploads/resource/../../application-secret.yml', { redirect: 'manual' });
    ok('SEC', '上传目录路径穿越不可达', r.status === 404 || r.status === 400, 'HTTP ' + r.status, Date.now() - t0);
  }
  {
    const t0 = Date.now();
    const r = await fetch(BASE + '/swagger-ui.html', { redirect: 'manual' });
    const r2 = await fetch(BASE + '/v3/api-docs', { redirect: 'manual' });
    const exposed = (r.status === 200) || (r2.status === 200);
    ok('SEC', 'Swagger API 文档未对外暴露', !exposed, 'swagger=' + r.status + ' api-docs=' + r2.status, Date.now() - t0);
  }
  {
    // 仓库旧默认 JWT 密钥伪造的 token 必须被拒（整改前生产端实测放行 HTTP 200）
    const crypto = await import('node:crypto');
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const hdr = b64({ alg: 'HS256' });
    const pld = b64({ sub: '1', role: 'TEACHER', iat: now, exp: now + 3600 });
    const sig = crypto.createHmac('sha256', 'la-dev-secret-key-must-be-at-least-32-bytes!!')
      .update(hdr + '.' + pld).digest('base64url');
    const t0 = Date.now();
    const r = await fetch(API + '/teacher/classes', { headers: { Authorization: 'Bearer ' + hdr + '.' + pld + '.' + sig } });
    ok('SEC', '旧默认密钥伪造 Token 被拒（401）', r.status === 401, 'HTTP ' + r.status, Date.now() - t0);
  }

  /* ---------- [PERF] 关键接口性能采样（3 次取均值） ---------- */
  console.log('\n  --- 性能采样（3 次均值 / 最大）---');
  const perf = async (name, path, token) => {
    const ts = [];
    for (let i = 0; i < 3; i++) {
      const r = await req('GET', path, token);
      ts.push(r.ms);
    }
    const avg = ts.reduce((a, b) => a + b, 0) / ts.length;
    const mx = Math.max(...ts);
    const grade = avg < 500 ? '良好' : avg < 1500 ? '可接受' : '偏慢';
    ok('PERF', name + ' 响应', true, '均值 ' + Math.round(avg) + 'ms · 最大 ' + Math.round(mx) + 'ms · ' + grade);
  };
  await perf('学情看板', '/teacher/dashboard?classId=' + c1, tt);
  await perf('学生列表', '/teacher/students?classId=' + c1, tt);
  await perf('作业列表', '/teacher/assignments?classId=' + c1, tt);
  await perf('知识图谱', '/knowledge/graph', tt);
  await perf('班级列表', '/teacher/classes', tt);
  await perf('预警中心', '/teacher/warnings?classId=' + c1, tt);
  await perf('我的作业（学生）', '/assignments/my', st);
  await perf('学习概览（学生）', '/reports/overview', st);

  /* ---------- 汇总 ---------- */
  const bySec = {};
  records.forEach(r => { bySec[r.sec] = bySec[r.sec] || { p: 0, f: 0 }; bySec[r.sec][r.pass ? 'p' : 'f']++; });
  console.log('\n=== API 健康检查汇总: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  Object.keys(bySec).forEach(s => console.log('  [' + s + '] ' + bySec[s].p + ' 通过 / ' + bySec[s].f + ' 失败'));
  const fs = await import('node:fs');
  fs.writeFileSync(new URL('./cloud-health-result.json', import.meta.url),
    JSON.stringify({ time: new Date().toISOString(), base: BASE, pass, fail, bySec, records }, null, 2));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
