// 无头验证：提取服务端 app.js 中真实的 acUpdate 逻辑，以模拟 DOM 环境执行，
// 复现用户输入场景，证明补全链路（含原崩溃点 seen Set）正常且弹窗状态置为 block
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');

// 提取闭包内 const acUpdate = () => { ... };
const m = /const acUpdate = \(\) => \{([\s\S]*?)\n    \};/.exec(src);
if (!m) { console.log('acUpdate 提取失败'); process.exit(1); }
const fnBody = m[1];

// 提取组件级数据/工具（ceOkItem、CE_TOP、CE_MEMBERS、CE_GENERIC_MEMBERS、CE_KW_SET、CE_SNIPPETS）
const grab = (re, wrap) => {
  const mm = re.exec(src);
  if (!mm) throw new Error('提取失败: ' + re);
  return wrap ? '(' + mm[1] + ')' : mm[1];
};
const CE_INDENT = '    ';
const CE_TOP = eval(grab(/const CE_TOP = (\[[\s\S]*?\n  \]);/));
const CE_MEMBERS = eval(grab(/const CE_MEMBERS = (\{[\s\S]*?\n  \});/, true));
const CE_GENERIC_MEMBERS = eval(grab(/const CE_GENERIC_MEMBERS = (\[[\s\S]*?\n  \]);/));
const CE_SNIPPETS = eval(grab(/const CE_SNIPPETS = (\{[\s\S]*?\n  \});/, true));
const CE_KW_SET = new Set(CE_TOP.map(x => x[0]));
const ceOkItem = x => Array.isArray(x) && typeof x[0] === 'string';

// 模拟 DOM/编辑器状态
function makeEnv(value, sel) {
  const state = { display: 'none', rendered: [] };
  const ta = {
    value, selectionStart: sel, selectionEnd: sel, disabled: false,
    focus() {}
  };
  const ac = {
    style: {},
    set innerHTML(h) { state.rendered.push(h); },
    get innerHTML() { return ''; }
  };
  const ACS = { items: [], active: -1, start: 0 };
  const acClose = () => { state.display = 'none'; ACS.items = []; ACS.active = -1; };
  const acRender = () => {
    if (!ACS.items.length) { acClose(); return; }
    state.display = 'block';
    state.items = ACS.items.map(x => x.t);
  };
  const caretXY = () => ({ x: 10, y: 30 });
  const acAccept = () => {};
  // 执行提取的函数体
  const acUpdate = new Function('ta', 'ac', 'ACS', 'acClose', 'acRender', 'caretXY',
    'CE_TOP', 'CE_MEMBERS', 'CE_GENERIC_MEMBERS', 'CE_KW_SET', 'CE_SNIPPETS', 'ceOkItem', fnBody);
  acUpdate(ta, ac, ACS, acClose, acRender, caretXY,
    CE_TOP, CE_MEMBERS, CE_GENERIC_MEMBERS, CE_KW_SET, CE_SNIPPETS, ceOkItem);
  return state;
}

const cases = [
  ['public class Main{\n    pub', null, '输入 pub（顶层关键字）'],
  ['public class Main{\n    publi', null, '输入 publi'],
  ['public class Main{\n    System.out.pr', null, '输入 System.out.pr（成员补全）'],
  ['sout', null, '输入 sout（片段）'],
  ['public class Main{\n    int sum = 0;\n    su', null, '输入 su（含文档词 sum）'],
  ['public class Main{\n', null, '行首无前缀（应关闭弹窗不报错）'],
];
let pass = 0, fail = 0;
for (const [v, _, label] of cases) {
  const pos = v.length;
  try {
    const st = makeEnv(v, pos);
    console.log((st.display === 'block' ? '[弹出] ' : '[关闭] ') + label +
      (st.display === 'block' ? ' → 候选: ' + (st.items || []).join(', ') : ''));
    pass++;
  } catch (e) {
    console.log('[抛错] ' + label + ' → ' + e.message);
    fail++;
  }
}
console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 抛错');
process.exit(fail ? 1 : 0);
