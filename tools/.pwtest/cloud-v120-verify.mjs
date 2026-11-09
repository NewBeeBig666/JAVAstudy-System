/* 云端 v1.20 分组实验部署验证
 * 只读项：前端代码标记 / v1.19 标记回退检查 / 新端点部署与鉴权 / v1.18 安全项复检
 * 写入项（全部清场）：上传测试 Word 模板 → 发布自行组队+随机分组测试作业 →
 *   组队全链路（首邀建队/接受/拒绝/教师全景/配置不可变/边界）→ 删除作业级联清理 → 删除测试模板
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures') + path.sep;
const BASE = 'http://47.119.150.2';
const API = BASE + '/api';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else { fail++; console.log('  ✗ ' + name + '（' + (detail || '') + '）'); }
};
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { code: -999, msg: t.slice(0, 100) }; } };

(async () => {
  /* 1) 新前端已发布（v1.20 分组实验标记）+ v1.19 标记未回退 */
  const js = await (await fetch(BASE + '/assets/js/app.js')).text();
  const m20 = ['composeGroupCfgHtml', 'toggleGroup', 'labGroupsBodyHtml', 'viewGroups', 'labInviteAccept', 'my-group'];
  ok('[前端] v1.20 分组实验代码已发布', m20.every(m => js.includes(m)),
    m20.map(m => (js.includes(m) ? '+' : '-') + m).join(' '));
  const m19 = ['resDocHtml', 'resSlidesHtml'];
  ok('[前端] v1.19 预览代码未回退', m19.every(m => js.includes(m)), '');

  /* 2) 登录 */
  const login = async (u) => j(await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ username: u, password: '123456' })
  }));
  const lg = await login('teacher');
  ok('[基础] 教师登录', lg.code === 0, '');
  const tt = lg.data.token;
  const H = { Authorization: 'Bearer ' + tt, 'Content-Type': 'application/json;charset=utf-8' };
  const stu = await login('student');
  const s02 = await login('s02');
  const s03 = await login('s03');
  ok('[基础] 学生账号登录（student/s02/s03）', stu.code === 0 && s02.code === 0 && s03.code === 0, '');

  const cls = await j(await fetch(API + '/teacher/classes', { headers: H }));
  const cid = (cls.data || [])[0] ? cls.data[0].id : 1;
  const stList = await j(await fetch(API + '/teacher/students?classId=' + cid, { headers: H }));
  const N = (stList.data || []).length;
  ok('[基础] 班级与学生名单', N >= 3, 'classId=' + cid + ' students=' + N);

  const stamp = Date.now().toString(36);
  const created = [];
  const fmt = (ts) => {
    const d = new Date(ts), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };
  const startAt = fmt(Date.now()), endAt = fmt(Date.now() + 7 * 864e5);
  const compose = async (body) => j(await fetch(API + '/teacher/compose', { method: 'POST', headers: H, body: JSON.stringify(body) }));
  const groups = async (id) => j(await fetch(API + '/teacher/assignments/' + id + '/groups', { headers: H }));
  const myGroup = async (id, tok) => j(await fetch(API + '/assignments/' + id + '/my-group', { headers: { Authorization: 'Bearer ' + tok } }));
  const invite = async (id, tok, toId) => j(await fetch(API + '/assignments/' + id + '/group/invite', {
    method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ toStudentId: Number(toId) })
  }));
  const accept = async (id, tok, invId) => j(await fetch(API + '/assignments/' + id + '/group/invites/' + invId + '/accept', {
    method: 'POST', headers: { Authorization: 'Bearer ' + tok } }));
  const reject = async (id, tok, invId) => j(await fetch(API + '/assignments/' + id + '/group/invites/' + invId + '/reject', {
    method: 'POST', headers: { Authorization: 'Bearer ' + tok } }));

  // 学生 id：张明(student)/李思远(s02)/王雨欣(s03)
  const uidOf = (list, name) => { const s = (list.data || []).find(x => x.name === name || x.realName === name); return s && (s.id || s.userId || s.studentId); };
  const zhang = uidOf(stList, '张明'), li = uidOf(stList, '李思远'), wang = uidOf(stList, '王雨欣');
  ok('[基础] 学生身份解析', !!zhang && !!li && !!wang, '张明=' + zhang + ' 李思远=' + li + ' 王雨欣=' + wang);

  /* 3) 上传测试 Word 模板 */
  const fd = new FormData();
  fd.append('title', 'E2E-CLD-GRP-TPL-' + stamp);
  fd.append('file', new Blob([readFileSync(FIX + 'test-doc.docx')],
    { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'test-doc.docx');
  const up = await j(await fetch(API + '/teacher/resources', {
    method: 'POST', headers: { Authorization: 'Bearer ' + tt }, body: fd
  }));
  ok('[模板] Word 测试模板上传', up.code === 0 && !!up.data.id, 'id=' + (up.data && up.data.id));
  const tplId = up.data.id;

  /* 4) 新端点部署 + 鉴权：未开分组的 LAB 作业 → groups/my-group 明确 400 */
  const plain = await compose({
    title: 'E2E-CLD-GRP-PLAIN-' + stamp, scoreMode: 'LAB', status: 'ONGOING', classId: cid,
    startAt, endAt, labTemplateId: tplId, labTemplateTitle: 'E2E-CLD-GRP-TPL-' + stamp, kps: [], questions: []
  });
  created.push(plain.data.id);
  const p1 = await groups(plain.data.id);
  ok('[端点] 未开分组作业查询分组 → 400 明确提示', p1.code !== 0 && /未开启分组/.test(p1.msg), p1.msg);
  const p403 = await fetch(API + '/assignments/' + plain.data.id + '/my-group', { headers: { Authorization: 'Bearer ' + tt } });
  const p403j = await j(p403);
  ok('[端点] 教师调学生分组接口被拦截（无班级/业务校验）', p403.status === 403 || p403j.code !== 0,
    'HTTP ' + p403.status + ' ' + (p403j.msg || ''));

  /* 5) 自行组队：发布 → 首邀建队 → 多邀请 → 接受/拒绝 → 教师全景 */
  const selfCount = Math.ceil(N / 2);   // cap=2
  const c1 = await compose({
    title: 'E2E-CLD-GRP-SELF-' + stamp, scoreMode: 'LAB', status: 'ONGOING', classId: cid,
    startAt, endAt, labTemplateId: tplId, labTemplateTitle: 'E2E-CLD-GRP-TPL-' + stamp,
    groupEnabled: true, groupMode: 'SELF', groupCount: selfCount, kps: [], questions: []
  });
  ok('[自行组队] 作业发布 + 配置回读', c1.code === 0 && c1.data.lab.group
    && c1.data.lab.group.mode === 'self' && c1.data.lab.group.count === selfCount,
    JSON.stringify(c1.data && c1.data.lab && c1.data.lab.group));
  const selfAs = c1.data.id;
  created.push(selfAs);

  const r1 = await invite(selfAs, stu.data.token, li);
  ok('[自行组队] 张明首邀自动建队成为队长', r1.code === 0 && r1.data && r1.data.myGroup
    && r1.data.isLeader === true && r1.data.myGroup.members.length === 1,
    r1.data && r1.data.myGroup ? r1.data.myGroup.name + ' 成员=' + r1.data.myGroup.members.map(m => m.name + (m.leader ? '*' : '')).join(',') : r1.msg);
  const r2 = await invite(selfAs, s03.data.token, li);
  ok('[自行组队] 王雨欣同时邀请李思远（多邀请并存）', r2.code === 0, r2.msg || '');
  const mL = await myGroup(selfAs, s02.data.token);
  const invs = (mL.data && mL.data.invites) || [];
  ok('[自行组队] 李思远可同时收到 2 条邀请', invs.length === 2, invs.map(i => i.fromName).join(','));
  const invZ = invs.find(i => i.fromName === '张明'), invW = invs.find(i => i.fromName === '王雨欣');

  // 先拒绝王雨欣（接受张明后其余邀请会自动失效，拒绝须在其前）→ REJECTED 回写发起者
  const rj = await reject(selfAs, s02.data.token, invW.id);
  ok('[自行组队] 拒绝王雨欣邀请', rj.code === 0, rj.msg || '');
  const mW = await myGroup(selfAs, s03.data.token);
  const sW = ((mW.data && mW.data.sentInvites) || []).find(x => x.toName === '李思远');
  ok('[自行组队] REJECTED 状态回写发起者', sW && sW.status === 'rejected', sW && sW.status);

  const a1 = await accept(selfAs, s02.data.token, invZ.id);
  ok('[自行组队] 接受张明邀请入组（成员身份）', a1.code === 0 && a1.data && a1.data.myGroup
    && a1.data.isLeader === false && a1.data.myGroup.members.length === 2,
    a1.data && a1.data.myGroup ? a1.data.myGroup.members.map(m => m.name + (m.leader ? '*' : '')).join(',') : a1.msg);

  const tg1 = await groups(selfAs);
  const grouped1 = ((tg1.data && tg1.data.groups) || []).reduce((s, g) => s + g.members.length, 0);
  ok('[教师全景] 自行组队：小组/成员/组长标注/未分组',
    tg1.code === 0 && tg1.data.groups.length === 2
    && tg1.data.groups[0].members.length === 2
    && tg1.data.groups.every(g => g.members.filter(m => m.leader).length === 1)
    && grouped1 === tg1.data.groupedCount && tg1.data.ungrouped.length === N - grouped1,
    'groups=' + tg1.data.groups.length + ' grouped=' + tg1.data.groupedCount + '/' + N);

  /* 6) 配置不可变 + 边界 */
  const e1 = await compose({
    id: Number(selfAs), title: 'E2E-CLD-GRP-SELF-' + stamp, scoreMode: 'LAB', status: 'ONGOING', classId: cid,
    startAt, endAt, labTemplateId: tplId, labTemplateTitle: 'E2E-CLD-GRP-TPL-' + stamp,
    groupEnabled: true, groupMode: 'SELF', groupCount: selfCount + 1, kps: [], questions: []
  });
  ok('[不可变] 已分组作业改分组数量被拒', e1.code !== 0 && /已生成分组数据/.test(e1.msg), e1.msg);
  const b1 = await compose({
    title: 'E2E-CLD-GRP-B1-' + stamp, scoreMode: 'LAB', status: 'ONGOING', classId: cid,
    startAt, endAt, labTemplateId: tplId, labTemplateTitle: 'E2E-CLD-GRP-TPL-' + stamp,
    groupEnabled: true, groupMode: 'SELF', groupCount: 0, kps: [], questions: []
  });
  ok('[边界] 分组数量 0 被拒', b1.code !== 0, b1.msg);

  /* 7) 随机分组：均衡 + 组长 + 全员入组 */
  const RC = 5;
  const c2 = await compose({
    title: 'E2E-CLD-GRP-RND-' + stamp, scoreMode: 'LAB', status: 'ONGOING', classId: cid,
    startAt, endAt, labTemplateId: tplId, labTemplateTitle: 'E2E-CLD-GRP-TPL-' + stamp,
    groupEnabled: true, groupMode: 'RANDOM', groupCount: RC, kps: [], questions: []
  });
  created.push(c2.data.id);
  const tg2 = await groups(c2.data.id);
  const gs = (tg2.data && tg2.data.groups) || [];
  const sizes = gs.map(g => g.members.length).sort((a, b) => b - a);
  const base = Math.floor(N / RC), rem = N % RC;
  const expect = Array.from({ length: RC }, (_, i) => i < rem ? base + 1 : base).sort((a, b) => b - a);
  ok('[随机分组] 组数与均衡分配（人数差≤1）', gs.length === RC && JSON.stringify(sizes) === JSON.stringify(expect),
    sizes.join(','));
  ok('[随机分组] 全员入组 + 每组恰 1 名组长',
    tg2.data.groupedCount === N && gs.every(g => g.members.filter(m => m.leader).length === 1),
    'grouped=' + tg2.data.groupedCount + '/' + N);
  const b2 = await compose({
    title: 'E2E-CLD-GRP-B2-' + stamp, scoreMode: 'LAB', status: 'ONGOING', classId: cid,
    startAt, endAt, labTemplateId: tplId, labTemplateTitle: 'E2E-CLD-GRP-TPL-' + stamp,
    groupEnabled: true, groupMode: 'RANDOM', groupCount: N + 5, kps: [], questions: []
  });
  ok('[边界] 随机组数超过班级人数被拒', b2.code !== 0 && /人数/.test(b2.msg), b2.msg);

  /* 8) v1.18 安全项复检（本轮部署未回退） */
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
    const page = await fetch(BASE + '/login.html');
    ok('[安全复检] 登录页正常', page.status === 200, 'HTTP ' + page.status);
  }

  /* 9) 清场：删除测试作业 → 级联清理验证；删除测试模板资源 */
  let delOk = true, delDetail = [];
  for (const id of created) {
    const dr = await fetch(API + '/teacher/assignments/' + id, { method: 'DELETE', headers: H });
    if (dr.status !== 200) { delOk = false; delDetail.push(id + ':' + dr.status); }
  }
  ok('[清场] 测试作业全部删除', delOk, delDetail.join(','));
  const after = await fetch(API + '/teacher/assignments/' + selfAs + '/groups', { headers: H });
  const afterJ = await j(after);
  ok('[清场] 删除后分组接口不可再查（作业不存在）', afterJ.code !== 0 && /不存在/.test(afterJ.msg || ''), afterJ.msg || after.status);
  const dr2 = await fetch(API + '/teacher/resources/' + tplId, { method: 'DELETE', headers: { Authorization: 'Bearer ' + tt } });
  ok('[清场] 测试模板资源已删除', dr2.status === 200, 'HTTP ' + dr2.status);

  console.log('\n=== 云端 v1.20 分组实验验证: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
