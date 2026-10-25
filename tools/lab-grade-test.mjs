/* 补充验证：教师批改发布 LAB 作业 → 学生端看到最终成绩 */
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
  const sToken = await api('POST', '/auth/login', { body: { username: 'student', password: '123456' } }).then(r => r.token);

  const subs = await api('GET', '/teacher/assignments/35/submissions', { token: tToken });
  const target = subs.find(s => s.status === 'ai_reviewed');
  if (!target) throw new Error('未找到 ai_reviewed 提交（先跑 lab-e2e-test.mjs 生成 AI 初评）');
  console.log('[1] 提交状态 ai_reviewed, aiScore=' + target.aiScore);

  // 教师复核后发布：总分 85 + 评语
  await api('POST', '/teacher/submissions/' + target.id + '/grade', {
    token: tToken,
    body: { rubricScores: {}, comment: '报告完成度较好，代码基本正确，补齐 getter 与 main 方法完整代码更好。', totalScore: 85 }
  });
  console.log('[2] 教师批改发布 OK: 85 分');

  // 学生端确认
  const my = await api('GET', '/assignments/my', { token: sToken });
  const a = my.find(x => x.id === '35');
  const sub = a && a.mySubmission;
  if (!sub || sub.status !== 'graded') throw new Error('学生端状态异常: ' + JSON.stringify(sub && sub.status));
  if (sub.score !== 85) throw new Error('学生端分数异常: ' + sub.score);
  console.log('[3] 学生端已收到批改: status=graded score=' + sub.score + ' 评语=' + (sub.teacherComment || '').slice(0, 40));
  console.log('AI 初评回显: ' + sub.aiScore + ' 分（教师复核参考）');

  // 掌握度回写确认：LAB 作业 kps 为空 → 不回写（无知识点），无报错即通过
  console.log('\n=== 批改发布链路通过 ===');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
