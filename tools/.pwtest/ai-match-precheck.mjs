/* API 预检：导入解析格式 + AI 匹配知识点效果（含本地降级路径） */
const BASE = 'http://localhost:8080';
const API = BASE + '/api';
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { code: -999, msg: t.slice(0, 200) }; } };

const TEXT = `一、单选题
1. 下列关于 Java 继承的说法，正确的是（  ）
A. Java 支持类的多重继承
B. 子类可以直接访问父类的 private 成员
C. 子类可以通过 super 关键字调用父类的构造方法
D. 被 final 修饰的类可以被继承
答案：C

二、判断题
2. Java 中所有的类都直接或间接继承自 Object 类。
答案：正确

三、编程题
3. 使用 HashMap 实现图书价格快速查询：创建 HashMap<String, Double> 存储至少 4 本图书的价格，编写方法 price(String bookName) 根据书名返回价格（使用 get 方法实现 O(1) 查询），书名不存在时返回 -1，并在 main 方法中测试。`;

(async () => {
  const lr = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'teacher', password: '123456' })
  });
  const tok = (await j(lr)).data.token;
  const H = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json;charset=utf-8' };

  const p = await j(await fetch(API + '/teacher/compose/import-parse', { method: 'POST', headers: H, body: JSON.stringify({ text: TEXT }) }));
  console.log('parse code=' + p.code + ' questions=' + (p.data ? p.data.length : 0));
  (p.data || []).forEach((q, i) => console.log('  #' + i, q.type, '|', String(q.title).slice(0, 40).replace(/\n/g, ' '), '| ans=' + JSON.stringify(q.answer)));

  const m = await j(await fetch(API + '/teacher/compose/ai-match-kps', {
    method: 'POST', headers: H,
    body: JSON.stringify({ questions: (p.data || []).map(q => ({ type: q.type, title: q.title })) })
  }));
  console.log('match code=' + m.code);
  (m.data || []).forEach((codes, i) => console.log('  #' + i, JSON.stringify(codes)));

  // 空题目拒绝
  const e1 = await fetch(API + '/teacher/compose/ai-match-kps', { method: 'POST', headers: H, body: JSON.stringify({ questions: [] }) });
  console.log('empty questions → HTTP ' + e1.status + ' ' + JSON.stringify(await j(e1)).msg);
  // 学生 403
  const sr = await fetch(API + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'student', password: '123456' }) });
  const stok = (await j(sr)).data.token;
  const f403 = await fetch(API + '/teacher/compose/ai-match-kps', { method: 'POST', headers: { Authorization: 'Bearer ' + stok, 'Content-Type': 'application/json' }, body: JSON.stringify({ questions: [{ type: 'SINGLE', title: 'x' }] }) });
  console.log('student → HTTP ' + f403.status);
})().catch(e => console.error('FAILED: ' + e.message));
