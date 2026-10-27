/* 云端 v1.12 部署验证 */
const HOST = 'http://47.119.150.2';
(async () => {
  const get = async p => { const r = await fetch(HOST + p); return { code: r.status, text: await r.text() }; };
  const js = await get('/assets/js/app.js');
  const css = await get('/assets/css/styles.css');
  console.log('app.js: HTTP ' + js.code +
    ' | 智能助手: ' + (js.text.includes('renderAssistantCtx') ? 'YES' : 'NO') +
    ' | 双角色配置: ' + (js.text.includes('ASA_CFG') ? 'YES' : 'NO') +
    ' | 徽章默认隐藏: ' + (js.text.includes('const ASA_SHOW_BRAND = false;') ? 'YES' : 'NO') +
    ' | 学生右侧栏差异化: ' + (js.text.includes("State.section !== 'chat'") ? 'YES' : 'NO') +
    ' | 废弃模块清除: ' + (js.text.includes('ctxHomework') ? 'NO!' : 'YES'));
  console.log('styles.css: HTTP ' + css.code +
    ' | 助手样式: ' + (css.text.includes('.asa-bubble-ai') ? 'YES' : 'NO') +
    ' | 知识点标题: ' + (css.text.includes('.ctx-title') ? 'YES' : 'NO'));

  // 后端接口与鉴权矩阵（真实 DeepSeek 对话）
  const login = async u => (await (await fetch(HOST + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: '123456' })
  })).json()).data.token;
  const st = await login('student'), tt = await login('teacher');
  const t1 = await fetch(HOST + '/api/teacher/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + st }, body: '{}' });
  const t2 = await fetch(HOST + '/api/student/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tt }, body: '{}' });
  console.log('鉴权矩阵: 学生→教师助手 HTTP ' + t1.status + ' / 教师→学生助手 HTTP ' + t2.status +
    (t1.status === 403 && t2.status === 403 ? ' OK' : ' !'));

  const ok1 = await fetch(HOST + '/api/teacher/assistant', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tt },
    body: JSON.stringify({ messages: [{ role: 'user', content: '用一句话介绍你能帮我做什么' }] })
  });
  const ok1j = await ok1.json();
  console.log('教师助手真实对话: HTTP ' + ok1.status + ' 回复 ' +
    (ok1j.data && ok1j.data.reply ? ok1j.data.reply.length + '字 YES → ' + ok1j.data.reply.slice(0, 60) : 'NO'));
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
