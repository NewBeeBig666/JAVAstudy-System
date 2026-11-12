/* 项目代码模块 API 冒烟：教师发布→学生创建/多版本保存→教师查看进度/版本/代码→编辑/上下架/删除 */
const BASE = 'http://localhost:8080/api';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + JSON.stringify(extra).slice(0, 300) : '')); } };

async function req(method, path, body, token) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (token) opt.headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) opt.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opt);
  const data = await res.json().catch(() => null);
  return { status: res.status, body: data };
}

const login = async (u) => (await req('POST', '/auth/login', { username: u, password: '123456' })).body.data.token;

const T = await login('teacher');
const S = await login('student');

/* 1. 教师发布项目 */
let r = await req('POST', '/teacher/projects', { classId: 1, title: '冒烟测试项目-成绩管理系统', description: '实现学生成绩的增删改查与统计排序，控制台交互。' }, T);
ok('教师发布项目', r.body.code === 0 && r.body.data.id, r.body);
const pid = r.body.data.id;

/* 2. 教师列表可见 */
r = await req('GET', '/teacher/projects?classId=1', undefined, T);
ok('教师项目列表含新项目', r.body.code === 0 && r.body.data.some(p => p.id === pid && p.studentCount === 0), r.body);

/* 3. 学生实时接收（上架项目列表） */
r = await req('GET', '/projects/my', undefined, S);
ok('学生收到上架项目', r.body.code === 0 && r.body.data.some(p => p.id === pid), r.body);

/* 4. 学生创建项目 */
r = await req('POST', '/projects/' + pid + '/start', {}, S);
ok('学生创建项目', r.body.code === 0 && r.body.data.id && r.body.data.status === 'IN_PROGRESS', r.body);
const spId = r.body.data.id;

/* 5. 幂等重复创建 */
r = await req('POST', '/projects/' + pid + '/start', {}, S);
ok('重复创建幂等返回同一项目', r.body.code === 0 && r.body.data.id === spId, r.body);

/* 6. 保存 v1 */
r = await req('POST', '/projects/mine/' + spId + '/save', { files: [{ path: 'Main.java', content: 'public class Main {\n  public static void main(String[] a) {\n    System.out.println("v1");\n  }\n}' }], summary: '首个版本：hello world', submit: false }, S);
ok('学生保存 v1', r.body.code === 0 && r.body.data.versionCount === 1, r.body);

/* 7. 保存 v2（新增文件 Utils.java） */
r = await req('POST', '/projects/mine/' + spId + '/save', { files: [{ path: 'Main.java', content: 'public class Main {\n  public static void main(String[] a) {\n    System.out.println(Tool.add(1, 2));\n  }\n}' }, { path: 'Tool.java', content: 'public class Tool {\n  static int add(int a, int b) { return a + b; }\n}' }], summary: '重构：抽取工具类', submit: true }, S);
ok('学生保存 v2 并提交', r.body.code === 0 && r.body.data.versionCount === 2 && r.body.data.status === 'SUBMITTED', r.body);

/* 8. 空 files 校验 */
r = await req('POST', '/projects/mine/' + spId + '/save', { files: [], summary: '' }, S);
ok('空文件保存被拒', r.body.code !== 0, r.body);

/* 9. 学生打开我的项目（最新代码+版本列表） */
r = await req('GET', '/projects/mine/' + spId, undefined, S);
ok('学生我的项目：最新代码与版本列表', r.body.code === 0 && r.body.data.mine.versionCount === 2 && r.body.data.versions.length === 2 && r.body.data.mine.lastFiles.length === 2, r.body);

/* 10. 教师进度（实时） */
r = await req('GET', '/teacher/projects/' + pid + '/progress', undefined, T);
const row = r.body.code === 0 && r.body.data.students.find(s => s.studentProjectId === spId);
ok('教师查看学生进度', !!row && row.status === 'SUBMITTED' && row.versionCount === 2 && Number(row.codeSize) > 0 && row.studentNo, r.body);

/* 11. 教师版本列表 */
r = await req('GET', '/teacher/student-projects/' + spId + '/versions', undefined, T);
ok('教师版本迭代记录', r.body.code === 0 && r.body.data.length === 2 && r.body.data[0].versionNo === 2 && r.body.data[0].fileCount === 2, r.body);
const v1 = r.body.data.find(v => v.versionNo === 1);

/* 12. 教师查看 v1 完整代码 */
r = await req('GET', '/teacher/project-versions/' + v1.id, undefined, T);
ok('教师在线查看 v1 代码', r.body.code === 0 && r.body.data.files.length === 1 && r.body.data.files[0].path === 'Main.java' && r.body.data.files[0].content.includes('v1'), r.body);

/* 13. 学生 s02 无权查看他人 spId */
const S2 = await login('s02');
r = await req('GET', '/projects/mine/' + spId, undefined, S2);
ok('其他学生无权查看他人项目', r.body.code !== 0, r.body);

/* 14. 无班级权限教师不可发布（teacher0000001 无班 → 回退演示允许，跳过）；编辑项目 */
r = await req('PUT', '/teacher/projects/' + pid, { title: '冒烟测试项目-成绩管理系统V2', description: '新增：按成绩排序与平均分统计。' }, T);
ok('教师编辑项目', r.body.code === 0 && r.body.data.title.includes('V2'), r.body);

/* 15. 学生项目已提交，下架后不可再保存 */
r = await req('PUT', '/teacher/projects/' + pid + '/status', { status: 'OFFLINE' }, T);
ok('教师下架项目', r.body.code === 0 && r.body.data.status === 'OFFLINE', r.body);
r = await req('GET', '/projects/my', undefined, S);
ok('下架后学生列表不再展示', r.body.code === 0 && !r.body.data.some(p => p.id === pid), r.body);
r = await req('POST', '/projects/mine/' + spId + '/save', { files: [{ path: 'Main.java', content: 'x' }], summary: '' }, S);
ok('下架后学生保存被拒', r.body.code !== 0, r.body);

/* 16. 重新上架 */
r = await req('PUT', '/teacher/projects/' + pid + '/status', { status: 'PUBLISHED' }, T);
ok('教师重新上架', r.body.code === 0 && r.body.data.status === 'PUBLISHED', r.body);

/* 17. 非法状态值 */
r = await req('PUT', '/teacher/projects/' + pid + '/status', { status: 'DELETED' }, T);
ok('非法状态被拒', r.body.code !== 0, r.body);

/* 18. 删除项目（级联） */
r = await req('DELETE', '/teacher/projects/' + pid, undefined, T);
ok('教师删除项目', r.body.code === 0, r.body);
r = await req('GET', '/teacher/projects?classId=1', undefined, T);
ok('删除后列表无该项目', !r.body.data.some(p => p.id === pid), r.body);
r = await req('GET', '/teacher/student-projects/' + spId + '/versions', undefined, T);
ok('删除后版本记录不可访问', r.body.code !== 0, r.body);

console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
