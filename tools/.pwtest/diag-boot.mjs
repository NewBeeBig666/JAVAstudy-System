/* 排查学生端 boot 各接口状态 */
const BASE = 'http://localhost:8080/api';
const lr = await fetch(BASE + '/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'student', password: '123456' })
});
const token = (await lr.json()).data.token;
const eps = ['/status', '/knowledge/graph', '/sessions', '/reports/overview', '/assignments/my', '/notifications', '/exercise-records'];
for (const p of eps) {
  const r = await fetch(BASE + p, { headers: { 'Authorization': 'Bearer ' + token } });
  let extra = '';
  if (p === '/sessions') { const j = await r.json(); extra = ' ' + (j.data || []).length + ' 个会话'; }
  if (p === '/exercise-records') { const j = await r.json(); extra = ' ' + (j.data || []).length + ' 条'; }
  console.log(r.status + ' ' + p + extra);
}
