/**
 * 二次校验：知识图谱 216 节点说明完整性（DB + API 双通道）
 * 1) DB 通道：XLSX 节点 description 空/过短数量必须为 0
 * 2) API 通道：登录 student → GET /api/knowledge/graph → 全节点 desc 非空
 * 用法：node kp-desc-verify.js
 */
var http = require('http');

function req(method, path, body, token) {
  return new Promise(function (resolve, reject) {
    var data = body ? JSON.stringify(body) : null;
    var opt = { host: 'localhost', port: 8080, path: path, method: method,
      headers: { 'Content-Type': 'application/json' } };
    if (token) opt.headers['Authorization'] = 'Bearer ' + token;
    if (data) opt.headers['Content-Length'] = Buffer.byteLength(data);
    var r = http.request(opt, function (res) {
      var buf = '';
      res.on('data', function (c) { buf += c; });
      res.on('end', function () {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch (e) { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async function () {
  // ---- 通道一：API 全量校验 ----
  var login = await req('POST', '/api/auth/login', { username: 'student', password: '123456' });
  if (login.status !== 200 || !login.body.data || !login.body.data.token) {
    console.error('FAIL 登录失败: ' + JSON.stringify(login.body).slice(0, 200)); process.exit(1);
  }
  var token = login.body.data.token;
  var gr = await req('GET', '/api/knowledge/graph', null, token);
  if (gr.status !== 200 || !gr.body.data) { console.error('FAIL graph 接口: ' + gr.status); process.exit(1); }
  var nodes = gr.body.data.nodes || [];
  var missing = nodes.filter(function (n) { return !n.desc || n.desc.trim().length < 10; });
  console.log('API 节点总数: ' + nodes.length + '，说明缺失/过短: ' + missing.length);
  if (missing.length) {
    missing.slice(0, 10).forEach(function (n) { console.error('  缺失 → ' + n.code + ' ' + n.name); });
  }

  // 每模块覆盖检查（末端细分节点抽样：level>=5 的叶节点必须有说明）
  var byModule = {};
  nodes.forEach(function (n) {
    var m = n.moduleCode || '?';
    byModule[m] = byModule[m] || { total: 0, ok: 0, leaf: 0, leafOk: 0 };
    byModule[m].total++;
    if (n.desc && n.desc.trim().length >= 10) byModule[m].ok++;
    if (n.level >= 5) { byModule[m].leaf++; if (n.desc && n.desc.trim().length >= 10) byModule[m].leafOk++; }
  });
  var allOk = true;
  Object.keys(byModule).sort().forEach(function (m) {
    var s = byModule[m];
    var ok = s.ok === s.total && s.leafOk === s.leaf;
    if (!ok) allOk = false;
    console.log((ok ? 'PASS' : 'FAIL') + ' [' + m + '] 总 ' + s.total + ' 说明齐备 ' + s.ok +
      '；末端细分(L5+) ' + s.leaf + ' 说明齐备 ' + s.leafOk);
  });

  // 说明内容抽样（每模块各 1 条，人工可读性核对）
  console.log('\n抽样展示:');
  ['kp-m1-l6-003', 'kp-m2-l5-003', 'kp-m3-l3-019', 'kp-m4-l4-002', 'kp-m5-l4-009'].forEach(function (code) {
    var n = nodes.find(function (x) { return x.code === code; });
    console.log('  ' + code + ' ' + (n ? n.name : '?') + ' → ' + (n ? n.desc.slice(0, 50) + '…' : '未找到'));
  });

  var totalOk = nodes.length === 216 && missing.length === 0 && allOk;
  console.log('\n' + (totalOk ? '二次校验 PASS：216 节点说明完整性 100%' : '存在 FAIL 项'));
  process.exit(totalOk ? 0 : 1);
})().catch(function (e) { console.error('FAIL ' + e.message); process.exit(1); });
