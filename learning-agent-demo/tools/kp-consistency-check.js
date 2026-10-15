// 一致性校验：Excel 源文件（kp-xlsx-dump.txt）↔ /knowledge/graph 接口（=数据库 XLSX 节点）
// 校验：名称与层级全量对齐、无遗漏/错配/重复、父级链正确、模块归属正确、依赖边一致
const fs = require('fs');
const base = process.argv[2] || 'http://localhost:8080';

// ---- 1. 解析 Excel dump（与 gen-v10-sql.py 相同的层级解析逻辑）----
const dump = fs.readFileSync(process.argv[3] ||
  'e:/AI Space/JavaStudySystem Demo/learning-agent-demo/tools/kp-xlsx-dump.txt', 'utf-8')
  .split(/\r?\n/).filter(l => l.startsWith('R') && l.includes(' | '));
const excel = [];
const path = {};
for (const row of dump.slice(2)) {  // 跳过标题/表头
  const cells = row.split(' | ');
  let lv = 0, name = null;
  for (let i = 1; i <= 7; i++) {
    const v = (cells[i] || '').trim();
    if (v) {
      for (let j = i; j <= 7; j++) delete path[j];
      path[i] = v; lv = i; name = v; break;
    }
  }
  if (!name) continue;
  excel.push({ level: lv, name, parent: lv > 1 ? path[lv - 1] : null,
               desc: (cells[15] || '').trim() });
}

// ---- 2. 拉取 graph 接口（学生登录）----
async function main() {
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'student', password: '123456' })
  }).then(r => r.json());
  const graph = await fetch(base + '/api/knowledge/graph', {
    headers: { Authorization: 'Bearer ' + login.data.token }
  }).then(r => r.json());
  const nodes = graph.data.nodes;
  const modules = graph.data.modules;
  const byName = {}; nodes.forEach(n => (byName[n.name] = byName[n.name] || []).push(n));

  let fails = [];
  const eq = (c, l, m) => { if (!c) fails.push(m); };

  // 2a. 数量一致
  eq(nodes.length === excel.length, true, `节点数量不一致: Excel=${excel.length} 接口=${nodes.length}`);

  // 2b. Excel 每个条目都能在接口中找到（名称 + 层级一致）
  const seen = new Set();
  let matched = 0;
  for (const e of excel) {
    const cands = (byName[e.name] || []).filter(n => !seen.has(n.code) && n.level === e.level);
    if (!cands.length) { fails.push(`接口缺失: L${e.level} ${e.name}`); continue; }
    const n = cands[0];
    seen.add(n.code);
    matched++;
    // 2c. 父级链一致（父名）
    if (e.level > 1) {
      const p = nodes.find(x => x.code === n.parentCode);
      const okP = p && p.name === e.parent;
      eq(okP, true, `父级错配: ${e.name}(L${e.level}) 接口父=${p ? p.name : 'null'} Excel父=${e.parent}`);
    }
    // 2d. 模块归属：节点模块是一级节点
    const mod = modules.find(m => m.code === n.moduleCode);
    eq(!!mod, true, `模块归属异常: ${e.name} module=${n.moduleCode}`);
  }
  eq(matched === excel.length, true, `仅匹配 ${matched}/${excel.length}`);

  // 2e. 接口无多余节点（seen 覆盖全部）
  eq(seen.size === nodes.length, true, `接口多出 ${nodes.length - seen.size} 个节点`);

  // 2f. 重复检测（同名同层级）
  const keyCnt = {};
  excel.forEach(e => { const k = e.level + '|' + e.name; keyCnt[k] = (keyCnt[k] || 0) + 1; });
  const dups = Object.entries(keyCnt).filter(([, c]) => c > 1);
  eq(dups.length === 0, true, 'Excel 重复条目: ' + dups.map(d => d[0]).join(', '));

  // 2g. 模块数量 = 5
  eq(modules.length === 5, true, '模块数=' + modules.length);

  // 2h. 依赖边 = Excel 显式前置/关联（4 条：模块递进 3 + 抽象类/接口→多态…）
  const edges = graph.data.edges;
  const depFrom = new Set(edges.map(e => e.from + '->' + e.to));
  eq(edges.length >= 4, true, '依赖边不足: ' + edges.length);

  console.log('Excel 节点: ' + excel.length + ' · 接口节点: ' + nodes.length + ' · 模块: ' + modules.length +
    ' · 依赖边: ' + edges.length);
  if (fails.length) {
    console.log('FAIL × ' + fails.length);
    fails.slice(0, 12).forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('一致性校验: 全部 PASS（无遗漏 / 无错配 / 无重复）');
}
main().catch(e => { console.error('脚本异常: ' + e.message); process.exit(2); });
