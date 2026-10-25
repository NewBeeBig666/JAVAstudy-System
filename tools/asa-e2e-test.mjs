/* 教师端智能助手端到端测试：
 * ① 学教角色隔离（学生 token 调 /teacher/assistant 必须 401/403）
 * ② 教师：空消息校验 → 单轮对话（学情上下文命中）→ 多轮追问（历史连贯）
 */
const BASE = 'http://localhost:8080/api';

async function api(method, p, { token, body, raw } = {}) {
  const opt = { method, headers: {} };
  if (token) opt.headers['Authorization'] = 'Bearer ' + token;
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json;charset=utf-8';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, opt);
  if (raw) return res;
  let data = null;
  try { data = await res.json(); } catch (e) { }
  if (!res.ok || !data || data.code !== 0) {
    throw new Error('HTTP ' + res.status + ' ' + p + ' → ' + ((data && data.msg) || ''));
  }
  return data.data;
}

(async () => {
  const tToken = (await api('POST', '/auth/login', { body: { username: 'teacher', password: '123456' } })).token;
  const sToken = (await api('POST', '/auth/login', { body: { username: 'student', password: '123456' } })).token;
  console.log('[1] 教师登录 OK');

  // 学生越权访问必须被拒（教师专属接口）
  const deny = await api('POST', '/teacher/assistant', { token: sToken, body: { messages: [] }, raw: true });
  if (deny.status !== 401 && deny.status !== 403) throw new Error('学生未鉴权拒绝，HTTP=' + deny.status);
  console.log('[2] 学生越权拦截 OK（HTTP ' + deny.status + '）');

  // 教师空消息校验
  let emptyErr = '';
  try { await api('POST', '/teacher/assistant', { token: tToken, body: { messages: [] } }); }
  catch (e) { emptyErr = e.message; }
  if (!emptyErr) throw new Error('空消息未拦截');
  console.log('[3] 空消息校验 OK: ' + emptyErr.slice(0, 60));

  // 第一轮：学情问题（应引用班级数据）
  console.log('[4] 第 1 轮提问（分析班级学情）中，真实 DeepSeek…');
  const msgs = [{ role: 'user', content: '结合我的班级学情，最需要优先解决的教学问题是什么？给出两条建议。' }];
  const r1 = await api('POST', '/teacher/assistant', { token: tToken, body: { messages: msgs } });
  if (!r1.reply || r1.reply.length < 30) throw new Error('回复异常: ' + JSON.stringify(r1).slice(0, 100));
  msgs.push({ role: 'assistant', content: r1.reply });
  console.log('[5] 第 1 轮回答 OK（' + r1.reply.length + ' 字）: ' + r1.reply.replace(/\s/g, '').slice(0, 80) + '…');

  // 第二轮：多轮历史追问（验证上下文连贯）
  console.log('[6] 第 2 轮追问（多轮历史）中…');
  msgs.push({ role: 'user', content: '针对你提到的第一个问题，具体怎么安排下周的教学？' });
  const r2 = await api('POST', '/teacher/assistant', { token: tToken, body: { messages: msgs } });
  if (!r2.reply || r2.reply.length < 30) throw new Error('多轮回复异常');
  console.log('[7] 多轮追问 OK（' + r2.reply.length + ' 字）: ' + r2.reply.replace(/\s/g, '').slice(0, 80) + '…');

  console.log('\n=== 智能助手端到端通过 ===');
})().catch(e => { console.error('\n=== FAILED ===\n' + e.message); process.exit(1); });
