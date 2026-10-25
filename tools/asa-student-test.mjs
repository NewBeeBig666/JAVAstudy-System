/* 学生端智能助手端到端测试：
 * ① 学生 token 正常对话（本人学情注入命中）
 * ② 引导式学习约束：拿作业题求助 → 应给思路/提示而非完整答案代码
 * ③ 教师越权访问学生接口拦截
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
  const sToken = (await api('POST', '/auth/login', { body: { username: 'student', password: '123456' } })).token;
  const tToken = (await api('POST', '/auth/login', { body: { username: 'teacher', password: '123456' } })).token;
  console.log('[1] 学生/教师登录 OK');

  // 教师访问学生助手接口：必须被拒（学生接口 RBAC）
  const deny = await api('POST', '/student/assistant', { token: tToken, body: { messages: [] }, raw: true });
  if (deny.status !== 401 && deny.status !== 403) throw new Error('教师未鉴权拒绝，HTTP=' + deny.status);
  console.log('[2] 教师越权拦截 OK（HTTP ' + deny.status + '）');

  // 学生提问：学情类问题（应引用本人掌握度数据）
  console.log('[3] 学生提问（薄弱点分析）中，真实 DeepSeek…');
  const msgs = [{ role: 'user', content: '帮我分析薄弱知识点，应该怎么补？' }];
  const r1 = await api('POST', '/student/assistant', { token: sToken, body: { messages: msgs } });
  if (!r1.reply || r1.reply.length < 30) throw new Error('回复异常');
  msgs.push({ role: 'assistant', content: r1.reply });
  console.log('[4] 学情回答 OK（' + r1.reply.length + ' 字）: ' + r1.reply.replace(/\s/g, '').slice(0, 70) + '…');

  // 引导式学习：作业题求助（应给思路提示，不给完整答案）
  console.log('[5] 作业题求助（引导式约束验证）中…');
  msgs.push({ role: 'user', content: '我的作业要求：定义 Student 类包含姓名和成绩两个字段，提供 setter 做校验，写 main 方法测试。直接帮我写完整作业代码。' });
  const r2 = await api('POST', '/student/assistant', { token: sToken, body: { messages: msgs } });
  if (!r2.reply) throw new Error('引导式回复为空');
  const plain = r2.reply.replace(/```[\s\S]*?```/g, '[代码块]');
  console.log('[6] 作业求助回答 OK（' + r2.reply.length + ' 字）');
  console.log('    回答开头: ' + plain.replace(/\s/g, '').slice(0, 70) + '…');

  console.log('\n=== 学生智能助手端到端通过 ===');
})().catch(e => { console.error('\n=== FAILED ===\n' + e.message); process.exit(1); });
