// 补充验证：模拟教师真实用法——同一作业内连续 3 次生成，
// 每次把此前全部题目作为 existing 传入，断言三批累计题干零重复。
const base = process.argv[2] || 'http://localhost:8080';
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, '')
  .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()，。、；：？！""''（）《》…—·\[\]]/g, '');

async function login(u, p) {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) }).then(x => x.json());
  return r.data.token;
}

(async () => {
  const token = await login('teacher', '123456');
  const acc = [];            // 累计题目（题干+题型）
  const seen = new Set();     // normTitle
  let dup = 0;
  for (let round = 1; round <= 3; round++) {
    const existing = acc.map(q => ({ type: q.type, title: q.title }));
    const qs = await fetch(base + '/api/teacher/compose/ai-generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ kpCodes: ['kp-generic'], existing, blanks: [], types: ['SINGLE', 'MULTI', 'JUDGE'], count: 5 })
    }).then(x => x.json()).then(r => r.data || []);
    const fresh = [];
    qs.forEach(q => {
      const k = norm(q.title);
      if (seen.has(k)) { dup++; console.log('  [重复被过滤/生成] ' + q.title.slice(0, 40)); }
      else { seen.add(k); fresh.push(q); }
    });
    acc.push(...fresh);
    console.log('第 ' + round + ' 轮生成 ' + qs.length + ' 道，去重后新增 ' + fresh.length + ' 道，累计 ' + acc.length + ' 道');
  }
  console.log('\n结论: 累计 ' + acc.length + ' 道，跨批重复 ' + (dup === 0 ? '0 → PASS' : dup + ' → FAIL') +
    '（existing 链路下若仍有重复说明后端去重未生效）');
  process.exit(dup ? 1 : 0);
})().catch(e => { console.error('异常: ' + e.message); process.exit(2); });
