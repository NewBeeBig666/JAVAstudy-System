/**
 * 布局防重叠全量校验：登录 → 拉取 /knowledge/graph 真实 216 节点 →
 * 提取服务端真实 kgLayoutModule 函数 → 逐模块执行 → 两两间距断言无重叠。
 * 覆盖「编程基础」密集子树（数据类型→基本数据类型→整数类型→六种范围）等末端细分节点。
 * 用法：node kg-layout-overlap-test.js
 */
var fs = require('fs');
var path = require('path');
var http = require('http');

function req(method, p, body, token) {
  return new Promise(function (resolve, reject) {
    var data = body ? JSON.stringify(body) : null;
    var opt = { host: 'localhost', port: 8080, path: p, method: method,
      headers: { 'Content-Type': 'application/json' } };
    if (token) opt.headers['Authorization'] = 'Bearer ' + token;
    if (data) opt.headers['Content-Length'] = Buffer.byteLength(data);
    var r = http.request(opt, function (res) {
      var buf = '';
      res.on('data', function (c) { buf += c; });
      res.on('end', function () { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async function () {
  var appJs = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'app.js'), 'utf8');
  var m = appJs.match(/function kgLayoutModule\(mcode\) \{[\s\S]*?\n  \}/);
  if (!m) { console.error('FAIL: 未找到 kgLayoutModule'); process.exit(1); }
  if (appJs.indexOf('每环防重叠消解') < 0) { console.error('FAIL: 函数不含防重叠消解逻辑'); process.exit(1); }
  var makeLayout = new Function('DB', 'return ' + m[0]);

  var login = await req('POST', '/api/auth/login', { username: 'student', password: '123456' });
  var token = login.data.token;
  var graph = (await req('GET', '/api/knowledge/graph', null, token)).data;

  // 复刻 applyKnowledgeGraph 的数据映射
  var DB = { modules: graph.modules.map(function (x) { return { id: x.code, name: x.name, color: x.color }; }),
    knowledgePoints: graph.nodes.map(function (n) { return { id: n.code, name: n.name, module: n.moduleCode,
      level: n.level, parent: n.parentCode, mastery: n.mastery || 0, hasData: n.mastery != null, deps: [] }; }) };

  // 节点半径（与 kgSvg 渲染一致）
  function nodeR(k) { var lv = k.level || 3; return lv === 1 ? 46 : lv === 2 ? 24 : lv === 3 ? 15 : 11; }
  var layout = makeLayout(DB);

  var allOk = true;
  graph.modules.forEach(function (mo) {
    var L;
    try { L = layout(mo.code); } catch (e) {
      console.error('FAIL [' + mo.name + '] 布局异常: ' + e.message); allOk = false; return;
    }
    var ks = L.nodes.filter(function (k) { return L.pos[k.id]; });
    var placed = ks.length, total = L.nodes.length;
    // 两两间距断言（O(n²) 可接受，单模块 ≤ 96 节点）
    var worst = null, minRatio = 1e9, overlaps = 0;
    for (var i = 0; i < ks.length; i++) {
      for (var j = i + 1; j < ks.length; j++) {
        var a = L.pos[ks[i].id], b = L.pos[ks[j].id];
        var dist = Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
        // 三级及以下节点带文字标签，需要更大的净空
        var bothL3 = (ks[i].level || 3) <= 3 && (ks[j].level || 3) <= 3;
        var need = nodeR(ks[i]) + nodeR(ks[j]) + (bothL3 ? 16 : 6);
        var ratio = dist / need;
        if (ratio < minRatio) { minRatio = ratio; worst = ks[i].name + ' ⇄ ' + ks[j].name; }
        if (dist < need) overlaps++;
      }
    }
    var finite = ks.every(function (k) { var p = L.pos[k.id]; return isFinite(p.x) && isFinite(p.y); });
    var ok = placed === total && overlaps === 0 && finite;
    if (!ok) allOk = false;
    console.log((ok ? 'PASS' : 'FAIL') + ' [' + mo.name + '] 节点 ' + total + '/' + placed +
      ' 重叠对 ' + overlaps + '，最小间距比 ' + minRatio.toFixed(2) + '（' + worst + '），坐标有限=' + finite);
  });

  // 「编程基础」末端细分节点专项抽验：数据类型深链叶节点
  var L1 = layout('kp-m1-l1-001');
  var deepIds = ['kp-m1-l6-001', 'kp-m1-l6-002', 'kp-m1-l6-003', 'kp-m1-l6-004', 'kp-m1-l6-005',
    'kp-m1-l6-006', 'kp-m1-l6-007', 'kp-m1-l6-008', 'kp-m1-l6-009'];
  var deepOk = true;
  deepIds.forEach(function (id) {
    var p = L1.pos[id];
    if (!p) { deepOk = false; console.error('  末端节点未定位: ' + id); return; }
    // 与所有其他节点距离 ≥ 22+6
    var bad = L1.nodes.some(function (k) {
      if (k.id === id || !L1.pos[k.id]) return false;
      return Math.sqrt(Math.pow(p.x - L1.pos[k.id].x, 2) + Math.pow(p.y - L1.pos[k.id].y, 2)) < 28;
    });
    if (bad) { deepOk = false; console.error('  末端节点仍重叠: ' + id); }
  });
  console.log((deepOk ? 'PASS' : 'FAIL') + ' [编程基础·末端细分 L6 节点×9] 无重叠');
  allOk = allOk && deepOk;

  console.log('\n' + (allOk ? '全量校验 PASS：五模块 216 节点布局无重叠、无错位' : '存在 FAIL 项'));
  process.exit(allOk ? 0 : 1);
})().catch(function (e) { console.error('FAIL ' + e.message); process.exit(1); });
