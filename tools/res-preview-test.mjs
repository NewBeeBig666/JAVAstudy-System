/* 学生端学习资源在线预览 + 学习达标 E2E 测试
 * 链路：学生资源列表 → 文本预览接口（Word/PPT/PDF）→ 记录查看 → 标记学完 → 完成状态回流
 * 用法: node tools/res-preview-test.mjs
 */
const BASE = (process.env.BASE || 'http://localhost:8080') + '/api';

async function api(method, p, { token, raw } = {}) {
  const opt = { method, headers: {} };
  if (token) opt.headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + p, opt);
  if (raw) return res;
  let data = null;
  try { data = await res.json(); } catch (e) { /* 非 JSON */ }
  if (!res.ok || !data || data.code !== 0) {
    throw new Error((data && data.msg) || ('HTTP ' + res.status + ' ' + p));
  }
  return data.data;
}

(async () => {
  // [1] 学生登录
  const lr = await fetch(BASE + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ username: 'student', password: '123456' })
  });
  const ld = await lr.json();
  if (ld.code !== 0) throw new Error('学生登录失败: ' + ld.msg);
  const token = ld.data.token;
  console.log('[1] 学生登录 OK');

  // [2] 学生资源列表
  const list = await api('GET', '/resources', { token });
  if (!list.length) throw new Error('学生资源列表为空（教师需先上传资源）');
  const word = list.find(r => r.fileType === 'word');
  const others = list.filter(r => r.fileType !== 'word');
  console.log('[2] 资源列表 OK: 共 ' + list.length + ' 个（word=' + (word ? '有' : '无')
    + ', 其他类型 ' + others.map(r => r.fileType).join('/') + '）');

  // [3] Word 文本预览接口
  if (word) {
    const t = await api('GET', '/resources/' + word.id + '/text', { token });
    if (typeof t.text !== 'string') throw new Error('text 接口返回结构异常: ' + JSON.stringify(t).slice(0, 100));
    if (t.fileType !== 'word') throw new Error('text 接口 fileType 不符');
    console.log('[3] Word 文本预览 OK: 提取 ' + t.text.length + ' 字（前 60 字：' + t.text.slice(0, 60).replace(/\n/g, ' ') + '…）');
    if (!t.text.trim()) console.log('    注意：该 Word 文本为空（可能为纯图片型文档），前端会提示使用下载');
  } else {
    console.log('[3] 跳过 Word 文本预览（无 word 资源）');
  }

  // [4] 文件流接口（在线预览数据源）
  const target = word || list[0];
  const f = await api('GET', '/resources/' + target.id + '/file', { token, raw: true });
  if (!f.ok) throw new Error('文件流获取失败 HTTP ' + f.status);
  const buf = await f.arrayBuffer();
  console.log('[4] 文件流 OK: ' + buf.byteLength + 'B, content-type=' + (f.headers.get('content-type') || '').slice(0, 50));

  // [5] 记录查看 → viewCount 递增
  const before = target.myProgress ? (target.myProgress.viewCount || 0) : 0;
  const viewed = await api('POST', '/resources/' + target.id + '/view', { token });
  const after = viewed && viewed.myProgress ? (viewed.myProgress.viewCount || 0) : -1;
  if (after !== before + 1) throw new Error('查看记录异常: before=' + before + ' after=' + after);
  console.log('[5] 记录查看 OK: viewCount ' + before + ' → ' + after);

  // [6] 标记学完 → 完成状态回流列表（同步学习档案）；complete 接口无返回体，以列表回流为准
  await api('POST', '/resources/' + target.id + '/complete', { token });
  const reList = await api('GET', '/resources', { token });
  const re = reList.find(x => String(x.id) === String(target.id));
  if (!re || !(re.myProgress && re.myProgress.completed)) {
    throw new Error('重新拉取列表后完成状态丢失');
  }
  console.log('[6] 标记学完 OK: completed=true 已同步至学习档案（列表回流验证通过）');

  // [7] 鉴权：教师资源接口 / 学生访问文件流需登录
  const noAuth = await fetch(BASE + '/resources/' + target.id + '/text');
  if (noAuth.status !== 401) throw new Error('未登录访问 text 接口应 401，实际 ' + noAuth.status);
  console.log('[7] 鉴权 OK: 未登录访问 text 接口 → 401');

  console.log('\n=== 学习资源预览 E2E 全部通过 ===');
})().catch(e => { console.error('\n=== E2E FAILED ==='); console.error(e.message); process.exit(1); });
