/* v1.15 云端部署验证：顶栏班级标签 + 资源重命名/编辑分层 + 作业移动文件夹 + 班级共同管理教师
 * 注意：云端不动账号数据（不建教师不改密码）；业务数据测试后全部还原 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = 'http://47.119.150.2';
const API = HOST + '/api';
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

(async () => {
  // [1] 健康检查 + 前端 v1.15 标记
  const h = await fetch(HOST + '/actuator/health');
  ok('健康检查', h.status === 200, (await h.text()).slice(0, 40));

  const js = await (await fetch(HOST + '/assets/js/app.js')).text();
  ok('顶栏班级标签（brand-sub 动态读班级名）', js.includes("cls ? h(cls.name) : '教师工作台'"), '');
  ok('编辑知识点弹窗分层重构（resKp 复用 nsPickArea，旧平铺已移除）', js.includes('nsPickArea') && !js.includes('resKpListHtml'), '');
  ok('资源编辑功能菜单 + 重命名', js.includes('resEditMenu') && js.includes('doResRename'), '');
  ok('作业移动到文件夹（右键菜单 + asMove）', js.includes('asMoveModal') && js.includes('doAsMove'), '');
  ok('班级共同管理教师（其他教师按钮 + 面板）', js.includes('coTeacherModal') && js.includes('ot-chip'), '');

  const tt = await login('teacher');
  const st = await login('student');
  console.log('[2] 双端登录 OK');

  // [3] 资源重命名（含校验 + 还原）
  const res = await j(await fetch(API + '/teacher/resources', { headers: { Authorization: 'Bearer ' + tt } }));
  ok('资源列表加载', res.code === 0 && Array.isArray(res.data), res.data.length + ' 条');
  const r0 = res.data[0];
  const origTitle = r0.title;
  const putTitle = (title, token) => fetch(API + '/teacher/resources/' + r0.id + '/title', {
    method: 'PUT', headers: { 'Authorization': 'Bearer ' + (token || tt), 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ title })
  });
  const e1 = await j(await putTitle('  '));
  ok('[重命名] 空名称被拒绝', e1.code !== 0, e1.msg);
  const e2 = await j(await putTitle('测试<名称>'));
  ok('[重命名] 特殊字符被拒绝', e2.code !== 0, e2.msg);
  const e3 = await j(await putTitle('x'.repeat(51)));
  ok('[重命名] 超 50 字被拒绝', e3.code !== 0, e3.msg);
  const s1 = await j(await putTitle('云端验证v115-第2章 流程控制（课件）'));
  ok('[重命名] 合法名称保存成功', s1.code === 0, '');
  const back = await j(await putTitle(origTitle));
  ok('[重命名] 还原标题（数据无污染）', back.code === 0, '「' + origTitle.slice(0, 18) + '…」');
  const ren403 = await putTitle('x', st);
  ok('[重命名] 学生调用被拒（403）', ren403.status === 403, 'HTTP ' + ren403.status);

  // [4] 作业移动到文件夹（含校验 + 还原）
  const asg = await j(await fetch(API + '/teacher/assignments', { headers: { Authorization: 'Bearer ' + tt } }));
  ok('作业列表加载', asg.code === 0 && asg.data.length >= 1, asg.data.length + ' 份');
  const a0 = asg.data[0];
  const origFolder = a0.folderId == null ? null : Number(a0.folderId);
  const folders = (await j(await fetch(API + '/teacher/folders', { headers: { Authorization: 'Bearer ' + tt } }))).data || [];
  ok('文件夹列表加载（v1.14 回归）', folders.length >= 1, folders.length + ' 个');
  const folder = folders[0];
  const putFolder = (fid, token) => fetch(API + '/teacher/assignments/' + a0.id + '/folder', {
    method: 'PUT', headers: { 'Authorization': 'Bearer ' + (token || tt), 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ folderId: fid })
  });
  const m1 = await j(await putFolder(folder.id));
  ok('[移动] 移入自建文件夹', m1.code === 0 && String(m1.data.folderId) === String(folder.id), '→「' + folder.name + '」');
  const m2 = await j(await putFolder(null));
  ok('[移动] 移回根目录（MP null set 修复生效）', m2.code === 0 && m2.data.folderId == null, '');
  const m3 = await j(await putFolder(999999));
  ok('[移动] 非法文件夹被拒绝', m3.code !== 0, m3.msg);
  const m403 = await putFolder(folder.id, st);
  ok('[移动] 学生调用被拒（403）', m403.status === 403, 'HTTP ' + m403.status);
  if (origFolder != null) {
    const m4 = await j(await putFolder(origFolder));
    ok('[移动] 还原原文件夹归属', m4.code === 0 && String(m4.data.folderId) === String(origFolder), '');
  } else {
    console.log('    （原归属即「其他」，步骤 m2 已还原）');
  }

  // [5] 班级共同管理教师（云端只读 + 拒绝路径，不动账号数据）
  const cls = (await j(await fetch(API + '/teacher/classes', { headers: { Authorization: 'Bearer ' + tt } }))).data;
  ok('班级列表加载（含 studentCount 回归）', cls.length > 0 && cls.every(c => c.studentCount != null),
    cls.map(c => c.name + ':' + c.studentCount).join(' | '));
  const cid = cls[0].id;
  const panel = await j(await fetch(API + '/teacher/co-teachers?classId=' + cid, { headers: { Authorization: 'Bearer ' + tt } }));
  ok('[共同管理] 面板数据（V15 表 + 班级/所有者）', panel.code === 0 && panel.data.className === cls[0].name && panel.data.manageable === true,
    '「' + panel.data.className + '」所有者 ' + panel.data.owner + '，已关联 ' + (panel.data.coTeachers || []).length + ' 人');
  const cAdd = await j(await fetch(API + '/teacher/co-teachers', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + tt, 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ classId: cid, teacherId: 1 })
  }));
  ok('[共同管理] 添加所有者本人被拒绝', cAdd.code !== 0, cAdd.msg);
  const cAdd2 = await j(await fetch(API + '/teacher/co-teachers', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + tt, 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ classId: cid, teacherId: 99999 })
  }));
  ok('[共同管理] 不存在账号被拒绝', cAdd2.code !== 0, cAdd2.msg);
  const c403 = await fetch(API + '/teacher/co-teachers?classId=' + cid, { headers: { Authorization: 'Bearer ' + st } });
  ok('[共同管理] 学生调用被拒（403）', c403.status === 403, 'HTTP ' + c403.status);
  const candN = (panel.data.candidates || []).length;
  console.log('    （云端候选教师 ' + candN + ' 人' + (candN ? '，正例添加路径已由本地 34 项验证覆盖，云端不动账号数据' : '，云端无其他教师账号，正例路径已由本地验证覆盖') + '）');

  // [6] 知识图谱维护回归（v1.14）
  const g0 = await j(await fetch(API + '/knowledge/graph', { headers: { Authorization: 'Bearer ' + tt } }));
  const n0 = g0.data.nodes.length;
  ok('图谱接口（v1.14 回归）', g0.code === 0 && n0 >= 200, n0 + ' 节点');

  // [7] 实验报告上传回归（v1.13）
  const buf = fs.readFileSync(path.join(__dirname, 'lab-template.docx'));
  const fd = new FormData();
  fd.append('title', '云端验证-v115-' + Date.now());
  fd.append('file', new Blob([buf]), 'lab-template.docx');
  fd.append('kpCodes', '');
  const up = await fetch(API + '/teacher/resources', { method: 'POST', headers: { Authorization: 'Bearer ' + tt }, body: fd });
  const upj = await j(up);
  ok('实验报告模板上传（回归）', up.status === 200 && upj.code === 0, 'id=' + (upj.data && upj.data.id));
  if (upj.data && upj.data.id) {
    await fetch(API + '/teacher/resources/' + upj.data.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + tt } });
  }

  // [8] 404 回归
  const nf = await fetch(API + '/api/teacher/folders', { headers: { Authorization: 'Bearer ' + tt } });
  ok('404 回归（双重前缀不再 500）', nf.status === 404, 'HTTP ' + nf.status);

  console.log('\n=== v1.15 云端验证: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
