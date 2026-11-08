/* 诊断：逐个资源测 /text 与 /file 接口状态 */
const BASE = 'http://localhost:8080/api';
const lr = await fetch(BASE + '/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'student', password: '123456' })
});
const token = (await lr.json()).data.token;
const list = (await (await fetch(BASE + '/resources', {
  headers: { 'Authorization': 'Bearer ' + token }
})).json()).data;
for (const r of list) {
  const t = await fetch(BASE + '/resources/' + r.id + '/text', {
    headers: { 'Authorization': 'Bearer ' + token }
  });
  let info = '';
  if (t.ok) {
    const j = await t.json();
    info = 'text ' + ((j.data && j.data.text) || '').length + '字';
  } else {
    const j = await t.json().catch(() => ({}));
    info = 'text FAIL ' + t.status + ' ' + (j.msg || '');
  }
  const done = r.myProgress && r.myProgress.completed ? '已完成' : '未完成';
  console.log('id=' + r.id + ' [' + r.fileType + '] ' + done + ' | ' + info + ' | ' + r.title.slice(0, 30));
}
