/* v1.16 云端部署验证：预警自动生成+归属校验 / 导入AI识别知识点 / 提交链路修复
 * 业务测试数据全部还原（测试作业级联删除）；不动账号数据 */
const HOST = 'http://47.119.150.2';
const API = HOST + '/api';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '（' + detail + '）' : '')); }
};
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { code: -999, msg: t.slice(0, 120) }; } };

async function login(u, p) {
  const r = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ username: u, password: p })
  });
  const d = await j(r);
  if (d.code !== 0) throw new Error('登录失败(' + u + '): ' + d.msg);
  return d.data.token;
}

(async () => {
  // [1] 健康检查 + 前端 v1.16 标记
  const h = await fetch(HOST + '/actuator/health');
  ok('健康检查', h.status === 200, (await h.text()).slice(0, 40));
  const js = await (await fetch(HOST + '/assets/js/app.js')).text();
  ok('前端含预警「立即检测」', js.includes('warnScan') && js.includes("data-act=\"warnScan\""), '');
  ok('前端含导入 AI 识别（自动触发+容错）', js.includes('importAiKp') && js.includes('_kpSig') && js.includes('作答内容无效'), '');
  ok('前端含题卡知识点分层下拉', js.includes('qKpDrill') && js.includes('qkpModuleCards'), '');
  ok('前端含提交 payload 题目 id', js.includes('id: q.id != null ? Number(q.id) : null'), '');

  const tt = await login('teacher', '123456');
  const st = await login('student', '123456');
  const H = (t) => ({ Authorization: 'Bearer ' + t, 'Content-Type': 'application/json;charset=utf-8' });
  console.log('[2] 双端登录 OK');

  // [3] 预警：归属校验 + 立即检测
  const cls = (await j(await fetch(API + '/teacher/classes', { headers: H(tt) }))).data;
  const c1 = cls[0];
  const w1 = await j(await fetch(API + '/teacher/warnings?classId=' + c1.id, { headers: H(tt) }));
  ok('本班预警查询正常', w1.code === 0, w1.data.length + ' 条');
  // 归属校验：云端班级 1/2 均属陈老师（查询 200 为合法）；
  // 真正的越权目标是朱老师的班（3/4）——用班级所有者面板定位
  const zt2 = await login('teacher0000001', 'GZgs@1009');
  const allCls = [1, 2, 3, 4];
  let foreign = null;
  for (const cid of allCls) {
    const p = await j(await fetch(API + '/teacher/co-teachers?classId=' + cid, { headers: H(tt) }));
    if (p.code === 0 && p.data.manageable === false) { foreign = cid; break; }
  }
  if (foreign != null) {
    const cross = await fetch(API + '/teacher/warnings?classId=' + foreign, { headers: H(tt) });
    const crossj = await j(cross);
    ok('归属校验：查询他人班级被拒', cross.status === 400 && crossj.code !== 0,
      'classId=' + foreign + ' HTTP ' + cross.status + ' ' + (crossj.msg || ''));
  } else {
    console.log('    （云端无其他教师的班级，跳过越权断言）');
  }
  // 立即检测（扫陈老师自己班，功能上线即产生真实预警——这是预期行为）
  const scan = await j(await fetch(API + '/teacher/warnings/scan', { method: 'POST', headers: H(tt) }));
  ok('立即检测接口正常', scan.code === 0 && typeof scan.data.generated === 'number',
    '班级 ' + scan.data.scanned + ' 个，新增 ' + scan.data.generated + ' 条，分布 ' + JSON.stringify(scan.data.byType));
  const s403 = await fetch(API + '/teacher/warnings/scan', { method: 'POST', headers: H(st) });
  ok('学生调用扫描被拒（403）', s403.status === 403, 'HTTP ' + s403.status);

  // [4] 导入 AI 识别知识点（真实 DeepSeek）
  const m = await j(await fetch(API + '/teacher/compose/ai-match-kps', {
    method: 'POST', headers: H(tt),
    body: JSON.stringify({ questions: [
      { type: 'SINGLE', title: '关于 Java 继承与 super 关键字的说法正确的是' },
      { type: 'CODE', title: '使用 HashMap 存储图书价格并实现 O(1) 查询' }
    ] })
  }));
  const graph = (await j(await fetch(API + '/knowledge/graph', { headers: H(tt) }))).data;
  const nodeIds = new Set(graph.nodes.map(n => n.code));
  const allCodes = (m.data || []).flat();
  ok('AI 匹配接口正常且编码全部有效', m.code === 0 && allCodes.length > 0 && allCodes.every(c => nodeIds.has(c)),
    allCodes.join(','));
  const e1 = await fetch(API + '/teacher/compose/ai-match-kps', { method: 'POST', headers: H(tt), body: JSON.stringify({ questions: [] }) });
  ok('AI 匹配空题目被拒', e1.status === 400, 'HTTP ' + e1.status);
  const m403 = await fetch(API + '/teacher/compose/ai-match-kps', { method: 'POST', headers: H(st), body: JSON.stringify({ questions: [{ type: 'SINGLE', title: 'x' }] }) });
  ok('学生调用 AI 匹配被拒（403）', m403.status === 403, 'HTTP ' + m403.status);

  // [5] 提交链路修复（测试数据，结束删除还原）
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  const start = iso(new Date(now.getTime() - 3600e3));
  const end = iso(new Date(now.getTime() + 7 * 86400e3));
  const create = await j(await fetch(API + '/teacher/compose', {
    method: 'POST', headers: H(tt),
    body: JSON.stringify({ title: '云端v116验证-' + now.getTime().toString().slice(-6), scoreMode: 'AVERAGE', startAt: start, endAt: end, status: 'ONGOING', kps: [],
      questions: [
        { type: 'SINGLE', title: '哪个关键字防止类被继承？', options: [{ key: 'A', text: 'static' }, { key: 'B', text: 'final' }], answer: ['B'], analysis: '', difficulty: 0.5 }
      ] })
  }));
  ok('[链路] 测试作业发布', create.code === 0, 'id=' + create.data.id);
  const asId = create.data.id;
  const qid = create.data.questions[0].id;
  const sub = await j(await fetch(API + '/assignments/' + asId + '/answer', {
    method: 'POST', headers: H(st),
    body: JSON.stringify({ answers: [{ questionId: qid, value: 'B' }] })
  }));
  ok('[链路] 学生提交成功', sub.code === 0, '自动评分 ' + (sub.data && sub.data.autoScore));
  // 教师编辑保存草稿 → 状态不降级 + 题目 id 稳定
  const edit = await j(await fetch(API + '/teacher/compose', {
    method: 'POST', headers: H(tt),
    body: JSON.stringify({ id: Number(asId), title: create.data.title, scoreMode: 'AVERAGE', startAt: start, endAt: end, status: 'DRAFT', kps: [],
      questions: [{ id: Number(qid), type: 'SINGLE', title: '哪个关键字防止类被继承？', options: [{ key: 'A', text: 'static' }, { key: 'B', text: 'final' }], answer: ['B'], analysis: '', difficulty: 0.5 }] })
  }));
  ok('[链路] 编辑保存草稿状态保持 ongoing', edit.code === 0 && edit.data.status === 'ongoing', 'status=' + (edit.data && edit.data.status));
  ok('[链路] 题目 id 保持稳定', edit.data.questions[0].id === qid, qid + '');
  const my = await j(await fetch(API + '/assignments/my', { headers: H(st) }));
  const a = my.data.find(x => String(x.id) === String(asId));
  ok('[链路] 学生列表条目不消失', !!a, '');
  ok('[链路] 学生作答回显正常', a && a.mySubmission && (a.mySubmission.answers || []).some(x => String(x.questionId) === String(qid) && x.value === 'B'), '');
  const subs = await j(await fetch(API + '/teacher/assignments/' + asId + '/submissions', { headers: H(tt) }));
  ok('[链路] 教师端有提交记录', subs.code === 0 && (subs.data || []).some(s => s.status === 'pending'), '');
  // 清理（级联删提交）
  const del = await fetch(API + '/teacher/assignments/' + asId, { method: 'DELETE', headers: H(tt) });
  ok('[清理] 测试作业已删除', del.status === 200, '');

  // [6] 回归
  const nf = await fetch(API + '/api/teacher/folders', { headers: H(tt) });
  ok('404 回归', nf.status === 404, 'HTTP ' + nf.status);

  console.log('\n=== v1.16 云端验证: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
