/* 云端预警中心全面检查（只读为主，不改账号、不改业务数据）
 * 1. 朱老师登录（teacher0000001 / GZgs@1009）→ 班级列表确认其班级
 * 2. 朱老师班级预警查询（全级别/未处理/已处理）→ 确认空结果的准确性
 * 3. 全库预警分布（不带 classId 查询返回全部）→ 证明数据存在但仅覆盖特定班级
 * 4. 陈老师班级（class 1）预警查询 → 展示逻辑/字段/级别/分类正常
 * 5. 处理接口活性（不存在 id → 400 业务报错，不改动真实数据）
 * 6. 学生越权 403
 */
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
  // [1] 朱老师登录（云端密码 GZgs@1009）
  const zt = await login('teacher0000001', 'GZgs@1009');
  ok('朱老师登录（云端账号信息未改动）', true, '');
  const zcls = (await j(await fetch(API + '/teacher/classes', { headers: { Authorization: 'Bearer ' + zt } }))).data;
  ok('朱老师班级列表', zcls.length >= 1, zcls.map(c => c.name + '(id=' + c.id + ',' + c.studentCount + '人)').join(' | '));
  const zc = zcls[0];

  // [2] 朱老师班级预警：全级别 / 未处理 / 已处理 三种口径
  const wAll = await j(await fetch(API + '/teacher/warnings?classId=' + zc.id, { headers: { Authorization: 'Bearer ' + zt } }));
  ok('预警接口（朱老师班级·全级别）', wAll.code === 0 && Array.isArray(wAll.data), '返回 ' + wAll.data.length + ' 条');
  const wOpen = await j(await fetch(API + '/teacher/warnings?classId=' + zc.id + '&handled=false', { headers: { Authorization: 'Bearer ' + zt } }));
  const wDone = await j(await fetch(API + '/teacher/warnings?classId=' + zc.id + '&handled=true', { headers: { Authorization: 'Bearer ' + zt } }));
  ok('待处理口径为 0', wOpen.code === 0 && wOpen.data.length === 0, wOpen.data.length + ' 条');
  ok('已处理口径为 0', wDone.code === 0 && wDone.data.length === 0, wDone.data.length + ' 条');
  ok('「无待处理预警」显示结果准确（接口三口径均为空）', wAll.data.length === 0 && wOpen.data.length === 0 && wDone.data.length === 0, '');

  // [3] 全库预警分布：不带 classId 会落到 defaultClassId，改用陈老师班级对照
  const tt = await login('teacher', '123456');
  const tcls = (await j(await fetch(API + '/teacher/classes', { headers: { Authorization: 'Bearer ' + tt } }))).data;
  const class1 = tcls.find(c => c.name.includes('2 班')) || tcls[0];
  const w1 = await j(await fetch(API + '/teacher/warnings?classId=' + class1.id, { headers: { Authorization: 'Bearer ' + tt } }));
  ok('对照班级（' + class1.name + '）预警数据存在', w1.code === 0 && w1.data.length > 0, w1.data.length + ' 条');
  const types = {};
  w1.data.forEach(w => { types[w.type] = (types[w.type] || 0) + 1; });
  ok('预警字段完整（级别/类型/学生/描述/时间/处理态）',
    w1.data.every(w => w.level && w.type && w.name && w.desc && w.time && typeof w.handled === 'boolean'),
    Object.keys(types).map(t => t + ':' + types[t]).join(' | '));
  const lvFilter = await j(await fetch(API + '/teacher/warnings?classId=' + class1.id + '&level=high', { headers: { Authorization: 'Bearer ' + tt } }));
  ok('级别筛选（高危）生效', lvFilter.code === 0 && lvFilter.data.length > 0 && lvFilter.data.every(w => w.level === 'high'),
    lvFilter.data.length + ' 条 HIGH');
  const open1 = await j(await fetch(API + '/teacher/warnings?classId=' + class1.id + '&handled=false', { headers: { Authorization: 'Bearer ' + tt } }));
  ok('未处理筛选生效', open1.code === 0 && open1.data.every(w => !w.handled), '待处理 ' + open1.data.length + ' 条');

  // [4] 处理/推送接口活性：不存在 id → 明确业务报错（不触碰真实预警数据）
  const h404 = await fetch(API + '/teacher/warnings/999999/handle', { method: 'PUT', headers: { Authorization: 'Bearer ' + tt } });
  const h404j = await j(h404);
  ok('处理接口在线（不存在 id 报业务错）', h404.status === 400 && h404j.code !== 0, h404j.msg);
  const n404 = await fetch(API + '/teacher/warnings/999999/notify', { method: 'POST', headers: { Authorization: 'Bearer ' + tt } });
  const n404j = await j(n404);
  ok('推送提醒接口在线（不存在 id 报业务错）', n404.status === 400 && n404j.code !== 0, n404j.msg);

  // [5] 朱老师对照查询陈老师班级（接口层无班级归属校验——记录为发现项）
  const cross = await fetch(API + '/teacher/warnings?classId=' + class1.id, { headers: { Authorization: 'Bearer ' + zt } });
  const crossj = await j(cross);
  console.log('  [发现] 朱老师 token 查询他班预警：HTTP ' + cross.status + '，返回 ' + (crossj.data ? crossj.data.length : '?') + ' 条（接口未做班级归属校验，前端仅查本班故页面无越权表现）');

  // [6] 学生越权
  const st = await login('student', '123456');
  const s403 = await fetch(API + '/teacher/warnings?classId=' + zc.id, { headers: { Authorization: 'Bearer ' + st } });
  ok('学生调用预警接口被拒（403）', s403.status === 403, 'HTTP ' + s403.status);

  console.log('\n=== 云端预警中心检查: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
