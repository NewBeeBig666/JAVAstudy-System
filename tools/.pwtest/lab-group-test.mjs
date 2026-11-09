/* 实验报告作业「分组实验」E2E
 * [发布配置] 教师发布 LAB 作业可开启分组：模式（随机/自行组队）+ 分组数量；数量边界 0/100/超班级人数拒绝
 * [随机分组] 人数÷组数均衡（差值≤1）+ 组员随机 + 每组恰 1 名组长 + 全员入组无遗漏；发布时生成、配置不可变
 * [自行组队] 发起者自动成为队长；已被邀请人可同时收多个邀请；接受即入组（其余邀请自动失效）；
 *            已入组/已发起组队者不可再被邀请；重复邀请拒绝；成员不可邀请；满员约束（cap=⌈人数/组数⌉）；
 *            拒绝后仍可接受其他邀请；并发接受唯一成功；截止/未发布/随机模式下组队被拒绝
 * [教师实时] 分组全景接口：小组/成员构成（组长标注）/未分组/待响应邀请
 * [UI] 教师端作业卡徽章 + 查看分组弹窗（轮询实时捕获新邀请）+ 发布编辑器配置回填/不可变拦截；
 *      学生端作业卡徽章 + 实验报告视图「我的小组」卡（成员/组长/发出邀请状态）+ 未入组视角接受邀请流程
 * [清场] SQL 直连清理历史 E2E 数据；结束后经 API 删除作业并校验分组数据级联清理
 */
import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures') + path.sep;
const BASE = 'http://localhost:8080';
const API = BASE + '/api';
const errors = [];
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '（' + detail + '）' : '')); }
};
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { code: -999, msg: t.slice(0, 120) }; } };

async function login(u) {
  const r = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ username: u, password: '123456' })
  });
  const d = await j(r);
  if (d.code !== 0) throw new Error('登录失败(' + u + '): ' + d.msg);
  return d.data.token;
}
/* mysql 直连（本地 root/root）：换行/中文都会破坏 cmd 传参，SQL 须单行 ASCII */
function sql(q) {
  try {
    const s = String(q).replace(/[\r\n]+/g, ' ');
    return execSync(`mysql -uroot -proot learning_agent -e ${JSON.stringify(s)}`, { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  } catch (e) { return null; }
}
const fmt = (ts) => {
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
};

(async () => {
  const tt = await login('teacher');
  const tok = {};
  for (const u of ['student', 's02', 's03', 's04', 's05', 's06', 's07', 's08', 's09', 's10', 's11', 's12']) tok[u] = await login(u);
  const H = (t) => ({ Authorization: 'Bearer ' + t, 'Content-Type': 'application/json;charset=utf-8' });
  const HM = (t) => ({ Authorization: 'Bearer ' + t });

  // 班级 1 学生名单（动态：导入类测试可能已加学生）
  // 注意：Windows mysql 客户端行尾为 \r\n，须先剔除 \r，否则 username 尾随 \r 导致取值 undefined
  const rows = (sql("SELECT id, username FROM user WHERE class_id = 1 AND role = 'STUDENT' ORDER BY id") || '')
    .replace(/\r/g, '').trim().split('\n').slice(1).map(l => l.split('\t')).filter(p => p.length >= 2);
  const uid = {};
  rows.forEach(p => { uid[p[1]] = p[0]; });
  const N = rows.length;
  ok('班级学生名单加载', N >= 12, 'classSize=' + N);

  // 清场：历史 E2E 数据（子表先于主表）
  const cleanupSql = [
    "DELETE FROM lab_group_invite WHERE assignment_id IN (SELECT id FROM assignment WHERE title LIKE 'E2E-GRP-%')",
    "DELETE FROM lab_group_member WHERE assignment_id IN (SELECT id FROM assignment WHERE title LIKE 'E2E-GRP-%')",
    "DELETE FROM lab_group WHERE assignment_id IN (SELECT id FROM assignment WHERE title LIKE 'E2E-GRP-%')",
    "DELETE FROM submission WHERE assignment_id IN (SELECT id FROM assignment WHERE title LIKE 'E2E-GRP-%')",
    "DELETE FROM question WHERE assignment_id IN (SELECT id FROM assignment WHERE title LIKE 'E2E-GRP-%')",
    "DELETE FROM rubric WHERE assignment_id IN (SELECT id FROM assignment WHERE title LIKE 'E2E-GRP-%')",
    "DELETE FROM assignment WHERE title LIKE 'E2E-GRP-%'",
    "DELETE FROM learning_resource WHERE title LIKE 'E2E-GRP-%'"
  ];
  let clean = true;
  cleanupSql.forEach(q => { if (sql(q) === null) clean = false; });
  ok('历史测试数据清场', clean, '');

  const stamp = Date.now().toString(36);
  const startAt = fmt(Date.now());
  const endAt = fmt(Date.now() + 7 * 864e5);
  const created = [];   // 待删除作业 id
  const TPL_TITLE = 'E2E-GRP-TPL-' + stamp;

  const compose = async (body) => j(await fetch(API + '/teacher/compose', {
    method: 'POST', headers: H(tt), body: JSON.stringify(body)
  }));
  const myGroup = async (asId, user) => j(await fetch(API + '/assignments/' + asId + '/my-group', { headers: H(tok[user]) }));
  const invite = async (asId, from, toId) => j(await fetch(API + '/assignments/' + asId + '/group/invite', {
    method: 'POST', headers: H(tok[from]), body: JSON.stringify({ toStudentId: Number(toId) })
  }));
  const accept = async (asId, user, invId) => j(await fetch(API + '/assignments/' + asId + '/group/invites/' + invId + '/accept', {
    method: 'POST', headers: H(tok[user]) }));
  const reject = async (asId, user, invId) => j(await fetch(API + '/assignments/' + asId + '/group/invites/' + invId + '/reject', {
    method: 'POST', headers: H(tok[user]) }));
  const teacherGroups = async (asId) => j(await fetch(API + '/teacher/assignments/' + asId + '/groups', { headers: H(tt) }));

  /* ============ 1. 模板资源上传（Word） ============ */
  const fd = new FormData();
  fd.append('title', TPL_TITLE);
  fd.append('file', new Blob([readFileSync(FIX + 'test-doc.docx')],
    { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'test-doc.docx');
  const up = await j(await fetch(API + '/teacher/resources', { method: 'POST', headers: HM(tt), body: fd }));
  ok('[发布] Word 模板资源上传', up.code === 0 && !!up.data.id, 'id=' + (up.data && up.data.id));
  const tplId = up.data.id;

  /* ============ 2. 自行组队作业发布 ============ */
  const selfCount = Math.ceil(N / 2);            // cap = 2，便于满员边界测试
  const c1 = await compose({
    title: 'E2E-GRP-SELF-' + stamp, scoreMode: 'LAB', status: 'ONGOING',
    startAt, endAt, labTemplateId: tplId, labTemplateTitle: TPL_TITLE,
    groupEnabled: true, groupMode: 'SELF', groupCount: selfCount, kps: [], questions: []
  });
  ok('[发布] 自行组队作业发布成功', c1.code === 0 && c1.data.lab && c1.data.lab.group
    && c1.data.lab.group.mode === 'self' && c1.data.lab.group.count === selfCount,
    'lab.group=' + JSON.stringify(c1.data && c1.data.lab && c1.data.lab.group));
  const selfAs = c1.data.id;
  created.push(selfAs);

  const m0 = await myGroup(selfAs, 'student');
  ok('[学生] 初始 my-group：未入组 + 可邀请名单', m0.code === 0 && m0.data && m0.data.myGroup == null
    && m0.data.cap === 2 && (m0.data.invitable || []).length === N - 1,
    m0.data ? 'cap=' + m0.data.cap + ' invitable=' + (m0.data.invitable || []).length : m0.msg);

  /* ============ 3. 组队邀请规则全链路 ============ */
  const notifBefore = parseInt((sql('SELECT COUNT(*) FROM notification WHERE user_id = ' + uid.s02) || '0').trim().split('\n')[1] || '0', 10);
  const r1 = await invite(selfAs, 'student', uid.s02);
  ok('[组队] 张明邀请李思远 → 自动建队成为队长', r1.code === 0 && r1.data && r1.data.myGroup && r1.data.isLeader === true
    && r1.data.myGroup.members.length === 1 && r1.data.myGroup.members[0].leader === true,
    r1.data && r1.data.myGroup ? r1.data.myGroup.name + ' 成员=' + r1.data.myGroup.members.map(m => m.name).join(',') : r1.msg);
  const notifAfter = parseInt((sql('SELECT COUNT(*) FROM notification WHERE user_id = ' + uid.s02) || '0').trim().split('\n')[1] || '0', 10);
  ok('[组队] 被邀请人收到站内通知', notifAfter === notifBefore + 1, notifBefore + ' -> ' + notifAfter);

  const r2 = await invite(selfAs, 's03', uid.s02);
  ok('[组队] 王雨欣也邀请李思远（可同时收多个邀请）', r2.code === 0 && r2.data.myGroup.members.length === 1, '');
  const r3 = await invite(selfAs, 's04', uid.s02);
  ok('[组队] 陈子豪也邀请李思远', r3.code === 0, '');

  const r4 = await invite(selfAs, 'student', uid.s02);
  ok('[组队] 重复邀请同一人被拒绝', r4.code !== 0, r4.msg);
  const r5 = await invite(selfAs, 's03', uid.student);
  ok('[组队] 已入组者（组长）不可被邀请', r5.code !== 0, r5.msg);

  // 李思远：3 条待响应邀请
  const m1 = await myGroup(selfAs, 's02');
  const invs = (m1.data && m1.data.invites) || [];
  ok('[组队] 被邀请人可同时收到 3 条邀请', invs.length === 3, invs.map(i => i.fromName).join(','));
  const invA = invs.find(i => i.fromName === '张明');
  const invB = invs.find(i => i.fromName === '王雨欣');
  const invC = invs.find(i => i.fromName === '陈子豪');
  ok('[组队] 邀请列表含发起人姓名', !!invA && !!invB && !!invC, '');

  // 队长继续邀请（未满员）
  const r6 = await invite(selfAs, 'student', uid.s05);
  ok('[组队] 队长继续邀人（组未满）', r6.code === 0, r6.msg || '');
  const invLiu = (((r6.data && r6.data.sentInvites) || []).find(x => x.toName === '刘佳怡') || {}).id;

  // 接受张明邀请 → 入组；其余两条邀请自动失效
  const a1 = await accept(selfAs, 's02', invA.id);
  ok('[组队] 接受邀请入组（成员身份）', a1.code === 0 && a1.data && a1.data.myGroup && a1.data.isLeader === false
    && a1.data.myGroup.members.length === 2
    && a1.data.myGroup.members.filter(m => m.leader).length === 1,
    a1.data && a1.data.myGroup ? a1.data.myGroup.members.map(m => m.name + (m.leader ? '*' : '')).join(',') : a1.msg);

  const m2 = await myGroup(selfAs, 's03');
  const sB = ((m2.data && m2.data.sentInvites) || []).find(x => x.toName === '李思远');
  ok('[组队] 接受后其余邀请自动失效（EXPIRED）', sB && sB.status === 'expired', sB && sB.status);
  const a2 = await accept(selfAs, 's02', invB.id);
  ok('[组队] 已失效邀请不可再接受', a2.code !== 0, a2.msg);

  const r7 = await invite(selfAs, 's02', uid.s08);
  ok('[组队] 普通成员不可发起邀请', r7.code !== 0, r7.msg);

  const a3 = await accept(selfAs, 's05', invLiu);
  ok('[组队] 队伍满员后接受邀请被拒', a3.code !== 0 && /满/.test(a3.msg), a3.msg);
  const r8 = await invite(selfAs, 'student', uid.s08);
  ok('[组队] 队长满员后再邀人被拒', r8.code !== 0 && /满/.test(r8.msg), r8.msg);

  // 拒绝后仍可接受其他邀请
  const r9 = await invite(selfAs, 's10', uid.s05);
  ok('[组队] 郑浩邀请刘佳怡', r9.code === 0, r9.msg || '');
  const inv9 = (((r9.data && r9.data.sentInvites) || []).find(x => x.toName === '刘佳怡') || {}).id;
  const rj = await reject(selfAs, 's05', inv9);
  ok('[组队] 拒绝邀请成功', rj.code === 0, rj.msg || '');
  const r10 = await invite(selfAs, 's08', uid.s05);
  ok('[组队] 被拒绝后仍可被其他人邀请', r10.code === 0, r10.msg || '');
  const inv10 = (((r10.data && r10.data.sentInvites) || []).find(x => x.toName === '刘佳怡') || {}).id;
  const a4 = await accept(selfAs, 's05', inv10);
  ok('[组队] 拒绝后可接受其他邀请入组', a4.code === 0 && a4.data && a4.data.myGroup && a4.data.myGroup.members.length === 2, a4.msg || '');
  const m3 = await myGroup(selfAs, 's10');
  const s10inv = ((m3.data && m3.data.sentInvites) || []).find(x => x.toName === '刘佳怡');
  ok('[组队] 拒绝状态回写发起者（REJECTED）', s10inv && s10inv.status === 'rejected', s10inv && s10inv.status);

  // 并发接受：孙悦同时接受两个不同队伍的邀请 → 恰一次成功
  await invite(selfAs, 's06', uid.s07);
  await invite(selfAs, 's09', uid.s07);
  const m4 = await myGroup(selfAs, 's07');
  const sInv = (m4.data && m4.data.invites) || [];
  ok('[组队] 并发前孙悦收到 2 条邀请', sInv.length === 2, sInv.map(i => i.fromName).join(',') || m4.msg);
  const [ca1, ca2] = sInv.length === 2
    ? await Promise.all([accept(selfAs, 's07', sInv[0].id), accept(selfAs, 's07', sInv[1].id)])
    : [{ code: -1, msg: '前置失败' }, { code: -1, msg: '前置失败' }];
  const wins = [ca1, ca2].filter(x => x.code === 0).length;
  ok('[组队] 并发接受恰一次成功', wins === 1, '成功=' + wins + '；失败原因=' + [ca1, ca2].filter(x => x.code !== 0).map(x => x.msg).join('/'));
  const m5 = await myGroup(selfAs, 's07');
  ok('[组队] 并发后恰在 1 个队伍', m5.code === 0 && m5.data && m5.data.myGroup && m5.data.myGroup.members.length === 2, m5.msg || '');

  // 教师实时分组全景
  const tg1 = await teacherGroups(selfAs);
  const groupedCount = ((tg1.data && tg1.data.groups) || []).reduce((s, g) => s + g.members.length, 0);
  ok('[教师] 分组全景：小组数与成员构成', tg1.code === 0 && !!tg1.data && tg1.data.mode === 'self' && tg1.data.cap === 2
    && groupedCount === tg1.data.groupedCount
    && (tg1.data.groups || []).every(g => g.members.filter(m => m.leader).length === 1),
    'groups=' + ((tg1.data && tg1.data.groups) || []).length + ' grouped=' + (tg1.data && tg1.data.groupedCount) + '/' + (tg1.data && tg1.data.classSize));
  ok('[教师] 分组全景：未分组名单正确', !!tg1.data
    && (tg1.data.ungrouped || []).length === tg1.data.classSize - tg1.data.groupedCount,
    'ungrouped=' + ((tg1.data && tg1.data.ungrouped) || []).length);
  ok('[教师] 分组全景：无遗留待响应邀请', ((tg1.data && tg1.data.invites) || []).length === 0,
    'pending=' + ((tg1.data && tg1.data.invites) || []).length);

  /* ============ 4. 配置不可变 ============ */
  const e1 = await compose({
    id: Number(selfAs), title: 'E2E-GRP-SELF-' + stamp, scoreMode: 'LAB', status: 'ONGOING',
    startAt, endAt, labTemplateId: tplId, labTemplateTitle: TPL_TITLE,
    groupEnabled: true, groupMode: 'SELF', groupCount: selfCount, kps: [], questions: []
  });
  ok('[不可变] 同配置编辑放行', e1.code === 0, e1.msg || '');
  const e2 = await compose({
    id: Number(selfAs), title: 'E2E-GRP-SELF-' + stamp, scoreMode: 'LAB', status: 'ONGOING',
    startAt, endAt, labTemplateId: tplId, labTemplateTitle: TPL_TITLE,
    groupEnabled: true, groupMode: 'SELF', groupCount: selfCount + 1, kps: [], questions: []
  });
  ok('[不可变] 改分组数量被拒', e2.code !== 0, e2.msg);
  const e3 = await compose({
    id: Number(selfAs), title: 'E2E-GRP-SELF-' + stamp, scoreMode: 'LAB', status: 'ONGOING',
    startAt, endAt, labTemplateId: tplId, labTemplateTitle: TPL_TITLE,
    groupEnabled: false, kps: [], questions: []
  });
  ok('[不可变] 关闭分组被拒', e3.code !== 0, e3.msg);

  /* ============ 5. 随机分组 ============ */
  const RC = 5;
  const c2 = await compose({
    title: 'E2E-GRP-RND-' + stamp, scoreMode: 'LAB', status: 'ONGOING',
    startAt, endAt, labTemplateId: tplId, labTemplateTitle: TPL_TITLE,
    groupEnabled: true, groupMode: 'RANDOM', groupCount: RC, kps: [], questions: []
  });
  ok('[随机] 随机分组作业发布成功', c2.code === 0, c2.msg || '');
  const rndAs = c2.data.id;
  created.push(rndAs);

  const tg2 = await teacherGroups(rndAs);
  const gs = (tg2.data && tg2.data.groups) || [];
  const sizes = gs.map(g => g.members.length).sort((a, b) => b - a);
  const base = Math.floor(N / RC), rem = N % RC;
  const expect = Array.from({ length: RC }, (_, i) => i < rem ? base + 1 : base).sort((a, b) => b - a);
  ok('[随机] 组数正确', gs.length === RC, 'groups=' + gs.length);
  ok('[随机] 均衡分配（人数差≤1）', JSON.stringify(sizes) === JSON.stringify(expect), sizes.join(','));
  ok('[随机] 全员入组无遗漏', !!tg2.data && tg2.data.groupedCount === N && (tg2.data.ungrouped || []).length === 0,
    'grouped=' + (tg2.data && tg2.data.groupedCount) + '/' + N);
  ok('[随机] 每组恰 1 名组长且在组内', gs.every(g => g.members.filter(m => m.leader).length === 1
    && g.members.some(m => m.leader && m.id === g.leaderId)), '');
  const allRandom = gs.flatMap(g => g.members.map(m => m.id));
  ok('[随机] 无重复入组（人数守恒）', allRandom.length === N && new Set(allRandom).size === N, '');

  const mgR = await myGroup(rndAs, 'student');
  ok('[随机] 学生 my-group 可见本组成员与组长', mgR.code === 0 && mgR.data && mgR.data.mode === 'random'
    && mgR.data.myGroup && mgR.data.myGroup.members.length >= base && mgR.data.myGroup.members.some(m => m.leader),
    mgR.data && mgR.data.myGroup ? mgR.data.myGroup.members.map(m => m.name + (m.leader ? '*' : '')).join(',') : mgR.msg);
  const rRND = await invite(rndAs, 'student', uid.s06);
  ok('[随机] 随机模式下学生组队被拒', rRND.code !== 0, rRND.msg);

  // 随机配置不可变（换班级 / 改组数）
  const e4 = await compose({
    id: Number(rndAs), title: 'E2E-GRP-RND-' + stamp, scoreMode: 'LAB', status: 'ONGOING',
    startAt, endAt, labTemplateId: tplId, labTemplateTitle: TPL_TITLE,
    groupEnabled: true, groupMode: 'RANDOM', groupCount: RC, kps: [], questions: []
  });
  const tgAfter = await teacherGroups(rndAs);
  ok('[随机] 同配置编辑放行且分组保持不变', e4.code === 0
    && JSON.stringify(((tgAfter.data && tgAfter.data.groups) || []).map(g => g.members.map(m => m.id)))
      === JSON.stringify(gs.map(g => g.members.map(m => m.id))), '');
  const e5 = await compose({
    id: Number(rndAs), title: 'E2E-GRP-RND-' + stamp, scoreMode: 'LAB', status: 'ONGOING',
    classId: 2, startAt, endAt, labTemplateId: tplId, labTemplateTitle: TPL_TITLE,
    groupEnabled: true, groupMode: 'RANDOM', groupCount: RC, kps: [], questions: []
  });
  ok('[随机] 已分组后换班级被拒', e5.code !== 0, e5.msg);

  /* ============ 6. 边界 ============ */
  const b1 = await compose({
    title: 'E2E-GRP-B1-' + stamp, scoreMode: 'LAB', status: 'ONGOING',
    startAt, endAt, labTemplateId: tplId, labTemplateTitle: TPL_TITLE,
    groupEnabled: true, groupMode: 'RANDOM', groupCount: N + 3, kps: [], questions: []
  });
  ok('[边界] 组数超过班级人数被拒', b1.code !== 0 && /人数/.test(b1.msg), b1.msg);
  const b2 = await compose({
    title: 'E2E-GRP-B2-' + stamp, scoreMode: 'LAB', status: 'ONGOING',
    startAt, endAt, labTemplateId: tplId, labTemplateTitle: TPL_TITLE,
    groupEnabled: true, groupMode: 'RANDOM', groupCount: 0, kps: [], questions: []
  });
  ok('[边界] 组数 0 被拒', b2.code !== 0, b2.msg);
  const b3 = await compose({
    title: 'E2E-GRP-B3-' + stamp, scoreMode: 'LAB', status: 'ONGOING',
    startAt, endAt, labTemplateId: tplId, labTemplateTitle: TPL_TITLE,
    groupEnabled: true, groupMode: 'RANDOM', groupCount: 100, kps: [], questions: []
  });
  ok('[边界] 组数 100 被拒', b3.code !== 0, b3.msg);
  const b4 = await compose({
    title: 'E2E-GRP-B4-' + stamp, scoreMode: 'LAB', status: 'ONGOING',
    startAt, endAt, labTemplateId: tplId, labTemplateTitle: TPL_TITLE,
    groupEnabled: true, groupMode: 'RANDOM', groupCount: 1, kps: [], questions: []
  });
  ok('[边界] 组数 1：全班一组', b4.code === 0, b4.msg || '');
  if (b4.code === 0) {
    created.push(b4.data.id);
    const tgB = await teacherGroups(b4.data.id);
    ok('[边界] 组数 1 分组结果', tgB.code === 0 && tgB.data && tgB.data.groups.length === 1
      && tgB.data.groups[0].members.length === N, tgB.msg || '');
  }

  // 未分组配置的 LAB 作业 → 编辑补开分组（无分组数据时允许）
  const c3 = await compose({
    title: 'E2E-GRP-NOGRP-' + stamp, scoreMode: 'LAB', status: 'ONGOING',
    startAt, endAt, labTemplateId: tplId, labTemplateTitle: TPL_TITLE, kps: [], questions: []
  });
  ok('[无分组] 普通 LAB 作业发布（无分组字段）', c3.code === 0 && !(c3.data.lab && c3.data.lab.group), '');
  created.push(c3.data.id);
  const e6 = await compose({
    id: Number(c3.data.id), title: 'E2E-GRP-NOGRP-' + stamp, scoreMode: 'LAB', status: 'ONGOING',
    startAt, endAt, labTemplateId: tplId, labTemplateTitle: TPL_TITLE,
    groupEnabled: true, groupMode: 'SELF', groupCount: 4, kps: [], questions: []
  });
  ok('[无分组] 无分组数据时可开启分组配置', e6.code === 0 && e6.data.lab.group.mode === 'self', '');

  // 草稿不生成分组：DRAFT(SELF) 邀请被拒 → 发布为 RANDOM 时才生成
  const c4 = await compose({
    title: 'E2E-GRP-DRAFT-' + stamp, scoreMode: 'LAB', status: 'DRAFT',
    startAt, endAt, labTemplateId: tplId, labTemplateTitle: TPL_TITLE,
    groupEnabled: true, groupMode: 'SELF', groupCount: selfCount, kps: [], questions: []
  });
  created.push(c4.data.id);
  const d1 = await invite(c4.data.id, 'student', uid.s02);
  ok('[草稿] 未发布作业组队被拒', d1.code !== 0, d1.msg);
  const e7 = await compose({
    id: Number(c4.data.id), title: 'E2E-GRP-DRAFT-' + stamp, scoreMode: 'LAB', status: 'ONGOING',
    startAt, endAt, labTemplateId: tplId, labTemplateTitle: TPL_TITLE,
    groupEnabled: true, groupMode: 'RANDOM', groupCount: 3, kps: [], questions: []
  });
  ok('[草稿] 发布时才生成分组（配置可从 SELF 改 RANDOM）', e7.code === 0, e7.msg || '');
  const tgD = await teacherGroups(c4.data.id);
  ok('[草稿] 发布后 3 组全员入组', tgD.code === 0 && tgD.data && tgD.data.groups.length === 3 && tgD.data.groupedCount === N,
    tgD.data ? 'groups=' + tgD.data.groups.length : tgD.msg);

  // 截止边界：过期作业拒绝组队；allowLate 例外放行
  const past = fmt(Date.now() - 864e5);
  const pastEnd = fmt(Date.now() - 3600e3);
  const c5 = await compose({
    title: 'E2E-GRP-DUE-' + stamp, scoreMode: 'LAB', status: 'ONGOING',
    startAt: past, endAt: pastEnd, labTemplateId: tplId, labTemplateTitle: TPL_TITLE,
    groupEnabled: true, groupMode: 'SELF', groupCount: selfCount, kps: [], questions: []
  });
  created.push(c5.data.id);
  const d2 = await invite(c5.data.id, 'student', uid.s02);
  ok('[截止] 过期作业组队被拒', d2.code !== 0 && /截止/.test(d2.msg), d2.msg);
  const c6 = await compose({
    title: 'E2E-GRP-LATE-' + stamp, scoreMode: 'LAB', status: 'ONGOING',
    startAt: past, endAt: pastEnd, allowLate: true, labTemplateId: tplId, labTemplateTitle: TPL_TITLE,
    groupEnabled: true, groupMode: 'SELF', groupCount: selfCount, kps: [], questions: []
  });
  created.push(c6.data.id);
  const d3 = await invite(c6.data.id, 'student', uid.s02);
  ok('[截止] 允许补交的过期作业可组队', d3.code === 0, d3.msg || '');

  /* ============ 7. UI：教师端 ============ */
  let browser;
  for (const ch of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {}
  }
  if (!browser) throw new Error('无可用系统浏览器');
  process.on('exit', () => { try { browser.close(); } catch (e) {} });

  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  // 排除预期业务 400：编辑器「改配置被拦截」断言会故意触发 /teacher/compose 的 400
  page.on('response', r => {
    if (r.status() >= 400 && !/favicon/.test(r.url())
      && !(r.status() === 400 && /\/api\/teacher\/compose/.test(r.url()))) {
      errors.push('http ' + r.status() + ': ' + r.url().slice(-70));
    }
  });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  const waitView = async (pg) => {
    for (let i = 0; i < 30; i++) {
      const t = await pg.textContent('.mh-title').catch(() => '');
      if (t && !t.includes('加载中')) break;
      await pg.waitForTimeout(300);
    }
  };
  const teacherLogin = async (pg) => {
    await pg.goto(BASE + '/login.html');
    await pg.fill('#lgUser', 'teacher');
    await pg.fill('#lgPass', '123456');
    await pg.click('button[type="submit"]');
    await pg.waitForSelector('.brand-sub', { timeout: 15000 });
    await waitView(pg);
  };
  const stuLogin = async (pg, user) => {
    await pg.goto(BASE + '/login.html');
    await pg.fill('#lgUser', user);
    await pg.fill('#lgPass', '123456');
    await pg.click('button[type="submit"]');
    await pg.waitForSelector('.brand-sub', { timeout: 15000 });
    await waitView(pg);
  };

  await teacherLogin(page);
  await page.click('[data-act="section"][data-val="assignments"]');
  await page.waitForSelector('#asCard-' + selfAs, { timeout: 20000 });

  const cardTxt = await page.textContent('#asCard-' + selfAs);
  ok('[UI 教师] 作业卡展示分组徽章', cardTxt.includes('分组实验') && cardTxt.includes('学生自行组队'), '');
  const viewBtn = await page.$('#asCard-' + selfAs + ' [data-act="viewGroups"]');
  ok('[UI 教师] 「查看分组」入口存在', !!viewBtn, '');

  // 实时轮询素材：两名未入组种子学生（蒋楠/冯晓等）由 API 产生一条新邀请
  const seedUser = { '蒋楠': 's12', '冯晓': 's11', '吴静': 's09', '赵启明': 's06', '孙悦': 's07' };
  const tgNow = await teacherGroups(selfAs);
  const uFree = [];
  for (const nm of Object.keys(seedUser)) {
    const hit = ((tgNow.data && tgNow.data.ungrouped) || []).find(u => u.name === nm);
    if (hit) uFree.push({ name: nm, id: hit.id, user: seedUser[nm] });
  }
  let pollInvite = null;
  if (viewBtn && uFree.length >= 2) {
    await viewBtn.click();
    await page.waitForSelector('.modal #labGroupsBody', { timeout: 10000 });
    await page.waitForTimeout(600);
    const mgTxt = await page.textContent('.modal #labGroupsBody');
    ok('[UI 教师] 分组弹窗：模式/上限说明', mgTxt.includes('学生自行组队') && mgTxt.includes('每组上限 2 人'), '');
    ok('[UI 教师] 分组弹窗：小组与组长标注', mgTxt.includes('第1组') && mgTxt.includes('张明 · 组长') && mgTxt.includes('李思远'), '');
    ok('[UI 教师] 分组弹窗：未分组名单', mgTxt.includes('未分组学生'), '');

    // 实时同步：弹窗轮询期间用 API 产生一条新邀请，4 秒轮询应自动呈现
    const [inviter, invitee] = uFree;
    const rt = await invite(selfAs, inviter.user, invitee.id);
    if (rt.code === 0) {
      pollInvite = { inviter, invitee };
      await page.waitForTimeout(5200);
      const mgTxt2 = await page.textContent('.modal #labGroupsBody');
      ok('[UI 教师] 分组弹窗轮询实时捕获新邀请', mgTxt2.includes(inviter.name + ' → ' + invitee.name),
        inviter.name + ' → ' + invitee.name);
    } else {
      ok('[UI 教师] 分组弹窗轮询实时捕获新邀请', false, '实时邀请 API 失败: ' + rt.msg);
    }
    await page.click('.modal [data-act="closeModal"]');
    await page.waitForTimeout(300);
  } else {
    console.log('    （查看分组入口缺失或余量学生不足，跳过弹窗 UI 断言）');
  }

  // 发布编辑器：编辑已发布的分组作业 → 配置回填 + 修改配置被后端拦截
  await page.click('#asCard-' + selfAs + ' [data-act="asMore"]');
  await page.waitForSelector('.as-menu', { timeout: 5000 });
  await page.click('.as-menu [data-act="editAs"]');
  await page.waitForSelector('.compose-mask input[data-key="groupCount"]', { timeout: 10000 });
  ok('[UI 教师] 编辑器回填分组配置（开关开）', await page.$eval('.compose-mask [data-act="toggleGroup"]', e => e.classList.contains('on')), '');
  ok('[UI 教师] 编辑器回填模式（自行组队）', await page.$eval('.compose-mask input[data-ans="groupMode"][data-val="SELF"]', e => e.checked), '');
  ok('[UI 教师] 编辑器回填分组数量', (await page.inputValue('.compose-mask input[data-key="groupCount"]')) === String(selfCount),
    await page.inputValue('.compose-mask input[data-key="groupCount"]'));
  await page.fill('.compose-mask input[data-key="groupCount"]', String(selfCount + 2));
  await page.click('.compose-mask [data-act="composeSave"]');
  await page.waitForTimeout(1000);
  const t1 = (await page.textContent('.toast:last-child').catch(() => '')).trim();
  ok('[UI 教师] 已分组作业改配置被拦截提示', t1.includes('已生成分组数据'), t1);
  await page.click('.compose-mask [data-act="closeCompose"]');
  await page.waitForTimeout(300);

  // 新建作业：未上传模板前无分组配置区；实验报告模板弹窗可打开
  await page.click('[data-act="openCompose"]');
  await page.waitForSelector('.compose-mask', { timeout: 10000 });
  ok('[UI 教师] 未上传模板前无分组配置区', !(await page.$('.compose-mask [data-act="toggleGroup"]')), '');
  await page.click('.compose-mask [data-act="composeLab"]');
  await page.waitForSelector('.modal', { timeout: 5000 });
  const labModal = await page.$('.modal [data-act="doLabUpload"]');
  ok('[UI 教师] 「上传实验报告模板」弹窗可打开', !!labModal, '');
  if (labModal) { await page.click('.modal [data-act="closeModal"]'); await page.waitForTimeout(200); }
  await page.click('.compose-mask [data-act="closeCompose"]');
  await page.waitForTimeout(300);

  /* ============ 8. UI：学生端（张明 = 队长视角） ============ */
  await stuLogin(page, 'student');
  await page.click('[data-act="section"][data-val="homework"]');
  await page.waitForSelector('#hw-' + selfAs, { timeout: 20000 });
  const hwTxt = await page.textContent('#hw-' + selfAs);
  ok('[UI 学生] 作业卡展示「实验报告 + 分组实验」徽章', hwTxt.includes('实验报告') && hwTxt.includes('分组实验'), '');
  await page.click('#hw-' + selfAs + ' [data-act="openLab"]');
  await page.waitForSelector('.ans-main .card-head', { timeout: 10000 });
  for (let i = 0; i < 20; i++) {
    const t = await page.textContent('.ans-main').catch(() => '');
    if (t.includes('我的小组') && !t.includes('分组信息加载中')) break;
    await page.waitForTimeout(400);
  }
  const labTxt = await page.textContent('.ans-main');
  ok('[UI 学生] 实验报告视图展示「我的小组」卡', labTxt.includes('我的小组'), '');
  ok('[UI 学生] 小组成员与组长标注', labTxt.includes('第1组') && labTxt.includes('张明 · 组长') && labTxt.includes('李思远') && labTxt.includes('你是组长'), '');
  ok('[UI 学生] 组长视角展示发出邀请状态', labTxt.includes('我发出的邀请') && labTxt.includes('已加入') && labTxt.includes('已失效'), '');

  /* ============ 9. UI：学生端（未入组视角：收到邀请 → 接受） ============ */
  if (pollInvite) {
    const { inviter, invitee } = pollInvite;
    await stuLogin(page, invitee.user);
    await page.click('[data-act="section"][data-val="homework"]');
    await page.waitForSelector('#hw-' + selfAs, { timeout: 20000 });
    await page.click('#hw-' + selfAs + ' [data-act="openLab"]');
    for (let i = 0; i < 20; i++) {
      const t = await page.textContent('.ans-main').catch(() => '');
      if (t.includes('收到的组队邀请') || t.includes('分组信息加载失败')) break;
      await page.waitForTimeout(400);
    }
    const invTxt = await page.textContent('.ans-main');
    ok('[UI 学生] 未入组视角展示收到的邀请', invTxt.includes('收到的组队邀请') && invTxt.includes(inviter.name + ' 邀请您加入'), inviter.name);
    const accBtn = await page.$('.ans-main [data-act="labInviteAccept"]');
    ok('[UI 学生] 接受/婉拒按钮存在', !!(accBtn && await page.$('.ans-main [data-act="labInviteReject"]')), '');
    if (accBtn) {
      await accBtn.click();
      await page.waitForTimeout(1500);
      const afterTxt = await page.textContent('.ans-main');
      const t2 = (await page.textContent('.toast:last-child').catch(() => '')).trim();
      ok('[UI 学生] 接受邀请后入组展示', (afterTxt.includes('名成员') && !afterTxt.includes('收到的组队邀请')) || t2.includes('已加入'),
        t2 || '成员卡已切换');
      const finalGroup = await myGroup(selfAs, invitee.user);
      ok('[UI 学生] 接受后接口侧已入组', finalGroup.data && finalGroup.data.myGroup && finalGroup.data.myGroup.members.length === 2
        && finalGroup.data.myGroup.members.some(m => m.name === inviter.name && m.leader),
        finalGroup.msg || (finalGroup.data && finalGroup.data.myGroup && finalGroup.data.myGroup.name));
    }
  } else {
    console.log('    （无待接受邀请，跳过未入组视角 UI 断言）');
  }

  ok('无 JS 报错 / 无意外 4xx 5xx', errors.length === 0, errors.slice(0, 3).join(' ; '));

  /* ============ 10. 清场：删除作业 → 分组数据级联清理 ============ */
  let delOk = true, delDetail = [];
  for (const id of created) {
    const dr = await fetch(API + '/teacher/assignments/' + id, { method: 'DELETE', headers: H(tt) });
    if (dr.status !== 200) { delOk = false; delDetail.push(id + ':' + dr.status); }
  }
  ok('[清场] 测试作业全部删除', delOk, delDetail.join(','));
  const idList = created.length ? created.join(',') : '0';
  const orphan = sql('SELECT COUNT(*) FROM lab_group WHERE assignment_id IN (' + idList + ')');
  const orphanCnt = orphan ? orphan.trim().split('\n')[1] : '?';
  ok('[清场] 分组数据级联清理无残留', orphanCnt === '0', 'lab_group 残留=' + orphanCnt);

  console.log('\n=== 实验报告分组实验 E2E: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
