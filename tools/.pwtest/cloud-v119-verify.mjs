/* 云端 v1.19 预览重构部署验证（只读，不向生产写入测试数据；/content 回填为产品自身行为） */
const BASE = 'http://47.119.150.2';
const API = BASE + '/api';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else { fail++; console.log('  ✗ ' + name + '（' + (detail || '') + '）'); }
};
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { code: -999, msg: t.slice(0, 100) }; } };

(async () => {
  /* 1) 新前端已发布 */
  const js = await (await fetch(BASE + '/assets/js/app.js')).text();
  const markers = ['resDocHtml', 'resSlidesHtml', "id + '/content'", '已阅读'];
  ok('[前端] v1.19 新预览代码已发布', markers.every(m => js.includes(m)),
    markers.map(m => (js.includes(m) ? '+' : '-') + m).join(' '));

  /* 2) 登录 + 资源清单 */
  const lg = await j(await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ username: 'teacher', password: '123456' })
  }));
  ok('[基础] 教师登录', lg.code === 0, '');
  const tt = lg.data.token;
  const H = { Authorization: 'Bearer ' + tt };
  const list = await j(await fetch(API + '/teacher/resources?classId=1', { headers: H }));
  ok('[基础] 资源列表可用', list.code === 0, (list.data || []).length + ' 个资源');

  /* 3) 逐资源 /content：首次（含存量回填）→ 二次（读库即时） */
  for (const r of (list.data || []).slice(0, 8)) {
    const t1 = Date.now();
    const c1 = await j(await fetch(API + '/resources/' + r.id + '/content', { headers: H }));
    const ms1 = Date.now() - t1;
    const t2 = Date.now();
    const c2 = await j(await fetch(API + '/resources/' + r.id + '/content', { headers: H }));
    const ms2 = Date.now() - t2;
    const kinds = ['doc', 'slides', 'pdf', 'media', 'empty'];
    const k = c1.data && c1.data.kind;
    ok(`[预览] #${r.id} ${r.fileType}（${(r.title || '').slice(0, 14)}）kind=${k}`,
      c1.code === 0 && kinds.includes(k) && c2.code === 0 && c2.data.kind === k,
      `首次 ${ms1}ms（${c1.data.items ? 'items=' + c1.data.items.length + ' ' : ''}回填/读库）→ 二次 ${ms2}ms`);
    if (k === 'doc' || k === 'slides') {
      ok(`[预览] #${r.id} 结构化原文即时（二次 <300ms 读库）`, ms2 < 300, ms2 + 'ms');
    }
  }

  /* 4) 文件流可用（预览数据源） */
  {
    const res = await fetch(API + '/resources/' + (list.data[0] ? list.data[0].id : 1) + '/file', { headers: H });
    ok('[预览] /file 原文件流式下发', res.status === 200, 'HTTP ' + res.status + ' · ' + (res.headers.get('content-length') || '') + 'B');
  }

  /* 5) v1.18 安全项复检（确保本轮部署未回退） */
  {
    const r = await fetch(BASE + '/v3/api-docs', { redirect: 'manual' });
    ok('[安全复检] Swagger 仍关闭（404）', r.status === 404, 'HTTP ' + r.status);
    const crypto = await import('node:crypto');
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const hdr = b64({ alg: 'HS256' });
    const pld = b64({ sub: '1', role: 'TEACHER', iat: now, exp: now + 3600 });
    const sig = crypto.createHmac('sha256', 'la-dev-secret-key-must-be-at-least-32-bytes!!').update(hdr + '.' + pld).digest('base64url');
    const fr = await fetch(API + '/teacher/classes', { headers: { Authorization: 'Bearer ' + hdr + '.' + pld + '.' + sig } });
    ok('[安全复检] 旧默认密钥伪造 Token 仍被拒（401）', fr.status === 401, 'HTTP ' + fr.status);
    const bad = await fetch(API + '/exercises', { headers: H });
    ok('[安全复检] 缺参仍返回 400 明确提示', bad.status === 400, 'HTTP ' + bad.status);
    const page = await fetch(BASE + '/login.html');
    ok('[安全复检] 登录页正常', page.status === 200, 'HTTP ' + page.status);
  }

  console.log('\n=== 云端 v1.19 验证: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
