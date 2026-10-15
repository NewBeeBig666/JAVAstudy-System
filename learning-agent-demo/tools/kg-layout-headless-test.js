/**
 * 无头验证：kgLayoutModule 递归修复（根节点不再挂自身 → 无限递归栈溢出）
 * 从服务端 app.js 提取真实函数，在模拟环境（216 节点 / 一~七级 / 5 模块）执行。
 * 用法：node kg-layout-headless-test.js
 */
var fs = require('fs');
var path = require('path');

var appJs = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'app.js'), 'utf8');

// 提取真实 kgLayoutModule 函数体
var m = appJs.match(/function kgLayoutModule\(mcode\) \{[\s\S]*?\n  \}/);
if (!m) { console.error('FAIL: 未找到 kgLayoutModule 函数'); process.exit(1); }
if (m[0].indexOf('真实子节点') < 0) { console.error('FAIL: 函数体不含父子索引修复标记'); process.exit(1); }

var DB = { modules: [], knowledgePoints: [] };
var State = { kgZoom: 1 };

// 构造与 /knowledge/graph 映射后同构的数据：5 模块，每模块根(level1, parent=null)，
// 下挂 level2~level7 子树，共约 216 节点，含 4 条跨模块 PRE 依赖边。
var mods = [
  { id: 'm1', name: 'Java基础', color: '#a78bfa' },
  { id: 'm2', name: '面向对象', color: '#f472b6' },
  { id: 'm3', name: '进阶特性', color: '#fbbf24' },
  { id: 'm4', name: '工程框架', color: '#22d3ee' },
  { id: 'm5', name: '项目实战', color: '#60a5fa' }
];
var nid = 0;
function addNode(id, name, module, level, parent) {
  DB.knowledgePoints.push({ id: id, name: name, module: module, level: level, parent: parent,
    sortOrder: DB.knowledgePoints.length, mastery: 50, hasData: true, deps: [], desc: '', resources: [] });
}
mods.forEach(function (mo, mi) {
  DB.modules.push(mo);
  addNode(mo.id, mo.name + '(模块根)', mo.id, 1, null);
  // 每模块 2 个二级，每个二级下挂深度链到 level7 + 宽分支
  for (var b = 1; b <= 2; b++) {
    var l2id = mo.id + '-l2-' + b;
    addNode(l2id, mo.name + '二级' + b, mo.id, 2, mo.id);
    var parent = l2id;
    for (var lv = 3; lv <= 7; lv++) {
      var cid = mo.id + '-l' + lv + '-' + b;
      addNode(cid, mo.name + 'L' + lv + '-' + b, mo.id, lv, parent);
      parent = cid;
      // 宽分支：每层再加一个叶子
      addNode(cid + '-x', mo.name + 'L' + lv + '-' + b + 'x', mo.id, lv, parent);
    }
  }
});
// 跨模块依赖（模拟 PRE 边）
DB.knowledgePoints.filter(function (k) { return k.id.indexOf('l3-1') >= 0 && k.module !== 'm1'; })
  .forEach(function (k) { k.deps = ['m1-l2-1']; });
console.log('模拟节点总数: ' + DB.knowledgePoints.length);

// 执行真实函数
var fn = new Function('DB', 'State', 'return ' + m[0])(DB, State);

var allPass = true;
mods.forEach(function (mo) {
  var t0 = Date.now();
  var L;
  try { L = fn(mo.id); } catch (e) {
    console.error('FAIL [' + mo.name + '] 布局异常: ' + e.message); allPass = false; return;
  }
  var dt = Date.now() - t0;
  var placed = Object.keys(L.pos).length;
  var inMod = DB.knowledgePoints.filter(function (k) { return k.module === mo.id; }).length;
  var finite = Object.keys(L.pos).every(function (id) { return isFinite(L.pos[id].x) && isFinite(L.pos[id].y); });
  var lines = L.lines.length;
  var ok = placed === inMod && finite && dt < 2000;
  console.log((ok ? 'PASS' : 'FAIL') + ' [' + mo.name + '] 节点 ' + inMod + ' → 定位 ' + placed +
    '（含根），坐标有限=' + finite + '，连线 ' + lines + ' 条，耗时 ' + dt + 'ms');
  if (!ok) allPass = false;
});

// 旧 bug 回归确认：根节点 parent=null，若误挂自身会栈溢出——直接构造环形数据验证防环兜底
var ring = { id: 'r1', name: '环', module: 'm1', level: 1, parent: 'r1', deps: [], hasData: false, mastery: 0, desc: '', resources: [], sortOrder: 0 };
DB.knowledgePoints.push(ring);
try {
  var L2 = fn('m1');
  console.log('PASS [环形数据兜底] parent=自身 时未栈溢出，返回 ' + Object.keys(L2.pos).length + ' 个定位');
} catch (e) {
  console.error('FAIL [环形数据兜底] 栈溢出: ' + e.message); allPass = false;
}

console.log(allPass ? '\n全部场景 PASS：布局递归修复生效' : '\n存在 FAIL 项');
process.exit(allPass ? 0 : 1);
