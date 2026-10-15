// 一键 AI 生成题目 专项验证（数量/题型严格匹配语义）：
// 边界场景：1 道单一题型 / 5 道 / 10 道单一题型 / 5 道混合题型 / 空白缺失报错 / 连发去重 / 选择题选项质量。
// 断言：生成数量与题型序列与教师添加的空白题完全一致（不多、不少、不越界）。
// 用法：node ai-gen-verify.js [base]
const base = process.argv[2] || 'http://localhost:8080';

async function login(u, p) {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) }).then(x => x.json());
  if (r.code !== 0) throw new Error('login failed: ' + r.msg);
  return r.data.token;
}
async function gen(token, body) {
  const r = await fetch(base + '/api/teacher/compose/ai-generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify(body)
  }).then(x => x.json());
  return r; // 原样返回（业务错误时 code!=0）
}

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, '')
  .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()，。、；：？！""''（）《》…—·\[\]]/g, '');
const sortTypes = a => [...a].sort().join(',');
let fails = 0;
function check(label, cond, detail) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail ? ' → ' + detail : ''));
  if (!cond) fails++;
}

(async () => {
  const token = await login('teacher', '123456');
  const choiceQs = [];

  // ---- 场景1：1 道单一题型（编程题）—— 复现用户报告的 bug 场景 ----
  const r1 = await gen(token, { kpCodes: ['kp-interface' === 'x' ? 'x' : 'kp-generic'], existing: [], blanks: ['CODE'], types: ['CODE'] });
  const q1 = r1.data || [];
  check('场景1 选择 1 道编程题 → 恰好 1 道 CODE', r1.code === 0 && q1.length === 1 && q1[0].type === 'CODE',
    '实际: ' + q1.length + ' 道 ' + q1.map(x => x.type).join(','));

  // ---- 场景2：5 道单一题型（单选）----
  const r2 = await gen(token, { kpCodes: ['kp-generic'], existing: [], blanks: ['SINGLE','SINGLE','SINGLE','SINGLE','SINGLE'], types: ['SINGLE'] });
  const q2 = r2.data || [];
  check('场景2 选择 5 道单选 → 恰好 5 道 SINGLE', r2.code === 0 && q2.length === 5 && q2.every(x => x.type === 'SINGLE'),
    '实际: ' + q2.length + ' 道 ' + q2.map(x => x.type).join(','));
  choiceQs.push(...q2);

  // ---- 场景3：10 道单一题型（编程）----
  const r3 = await gen(token, { kpCodes: ['kp-loop', 'kp-generic'], existing: [], blanks: Array(10).fill('CODE'), types: ['CODE'] });
  const q3 = r3.data || [];
  check('场景3 选择 10 道编程 → 恰好 10 道 CODE', r3.code === 0 && q3.length === 10 && q3.every(x => x.type === 'CODE'),
    '实际: ' + q3.length + ' 道 ' + q3.map(x => x.type).join(','));

  // ---- 场景4：5 道混合题型 ----
  const mix = ['CODE', 'SINGLE', 'JUDGE', 'MULTI', 'FILL'];
  const r4 = await gen(token, { kpCodes: ['kp-generic', 'kp-exception'], existing: [], blanks: mix, types: mix });
  const q4 = r4.data || [];
  check('场景4 混合题型 5 道 → 数量与题型序列完全一致',
    r4.code === 0 && q4.length === 5 && sortTypes(q4.map(x => x.type)) === sortTypes(mix),
    '实际: ' + q4.length + ' 道 ' + q4.map(x => x.type).join(','));
  choiceQs.push(...q4.filter(x => x.type === 'SINGLE' || x.type === 'MULTI'));

  // ---- 场景5：无空白题 → 明确报错（不得默认生成）----
  const r5 = await gen(token, { kpCodes: ['kp-generic'], existing: [], blanks: [], types: ['SINGLE'] });
  check('场景5 无空白题 → 拒绝生成并提示', r5.code !== 0, '返回: code=' + r5.code + ' msg=' + r5.msg);

  // ---- 场景6：连发去重（同作业连续 3 轮，existing 链路）----
  const acc = []; const seen = new Set(); let dup = 0;
  for (let i = 0; i < 3; i++) {
    const rr = await gen(token, {
      kpCodes: ['kp-generic'], existing: acc.map(q => ({ type: q.type, title: q.title })),
      blanks: ['SINGLE', 'MULTI', 'JUDGE'], types: ['SINGLE', 'MULTI', 'JUDGE']
    });
    (rr.data || []).forEach(q => {
      const k = norm(q.title);
      if (seen.has(k)) dup++; else { seen.add(k); acc.push(q); }
    });
  }
  check('场景6 连发 3 轮（每轮 3 道）→ 零重复', dup === 0, '重复 ' + dup + ' 道');
  choiceQs.push(...acc.filter(x => x.type === 'SINGLE' || x.type === 'MULTI'));

  // ---- 补足选择题样本至 ≥20 道做选项质量抽验 ----
  while (choiceQs.length < 20) {
    const rr = await gen(token, { kpCodes: ['kp-loop', 'kp-exception'], existing: [], blanks: ['SINGLE','MULTI','SINGLE'], types: ['SINGLE','MULTI'] });
    const qs = rr.data || [];
    if (!qs.length) break;
    choiceQs.push(...qs.filter(x => x.type === 'SINGLE' || x.type === 'MULTI'));
  }

  // ---- 选择题选项质量 ----
  let opt4 = 0, optDup = 0, ansOk = 0, lenOk = 0;
  choiceQs.forEach(q => {
    const opts = q.options || [];
    if (opts.length === 4) opt4++;
    if (new Set(opts.map(o => norm(o.text))).size === opts.length) optDup++;
    if ((q.answer || []).length > 0 && (q.answer || []).every(a => opts.some(o => o.key === a))) ansOk++;
    const lens = opts.map(o => (o.text || '').length);
    if (lens.length === 4 && Math.max(...lens) / Math.min(...lens.filter(x => x > 0)) <= 6) lenOk++;
  });
  console.log('\n选择题选项质量抽验（样本 ' + choiceQs.length + ' 道）: 4 选项 ' + opt4 + ' / 互不重复 ' + optDup +
    ' / 答案合法 ' + ansOk + ' / 长度相近 ' + lenOk);
  check('选项质量', opt4 === choiceQs.length && optDup === choiceQs.length && ansOk === choiceQs.length, '');

  console.log('\n===== 总体: ' + (fails ? fails + ' 项 FAIL' : '全部 PASS') + ' =====');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('脚本异常: ' + e.message); process.exit(2); });
