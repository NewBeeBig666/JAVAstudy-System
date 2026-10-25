/* 全面 bug 排查 · 前端静态扫描 */
import fs from 'node:fs';
const src = fs.readFileSync('e:/AI Space/JavaStudySystem Demo/learning-agent-demo/assets/js/app.js', 'utf8');

// A. Actions 重名
const m = src.match(/const Actions = \{[\s\S]*?\n  \};/);
const names = [...m[0].matchAll(/^    (?:async )?([A-Za-z_$][\w$]*)\(/gm)].map(x => x[1]);
const dup = names.filter((n, i) => names.indexOf(n) !== i);
console.log('[A] Actions 重名:', dup.length ? dup.join(',') : '无 (' + names.length + '个)');

// B. 关键渲染函数 定义/引用 一致性
['renderAssistantCtx', 'ctxKnowledge', 'kgTeacherResCard', 'kgStudentResCard', 'renderLab', 'labStateOf', 'renderInsight'].forEach(f => {
  const defCount = (src.match(new RegExp('function ' + f + '\\(', 'g')) || []).length;
  const useCount = (src.split(f + '(').length - 1) - defCount;
  console.log('[B] ' + f + ': 定义' + defCount + ' / 外部引用' + useCount + (defCount === 1 ? ' OK' : ' ⚠'));
});

// C. 已移除模块残留引用
let cDirty = false;
['ctxHomework', 'ctxCode', 'State.rightTab', 'ctxTab', 'DB.snippets', 'MOCK.snippets'].forEach(k => {
  const c = src.split(k).length - 1;
  if (c > 0) { console.log('[C] 残留引用 ⚠:', k, 'x' + c); cDirty = true; }
});
console.log('[C] 废弃引用:', cDirty ? '有残留' : '无');

// D. API.upload 调用链
console.log('[D] API.upload 调用:', (src.match(/API\.upload\(/g) || []).length, '处');

// E. busy 锁 try/catch 复位检查（async action 内 busy=true 后应有 busy=false 兜底）
const am = m[0];
const busyActions = [...am.matchAll(/async (\w+)\(\) \{[\s\S]*?\.busy = true[\s\S]*?\n    \},/g)].map(x => x[1]);
busyActions.forEach(a => {
  const seg = am.match(new RegExp('async ' + a + '\\(\\) \\{[\\s\\S]*?\\n    \\},'));
  const s = seg ? seg[0] : '';
  const hasTrue = s.includes('.busy = true');
  const reset = (s.match(/\.busy = false/g) || []).length;
  const tryCatch = s.includes('catch');
  console.log('[E] ' + a + ': busy锁=' + (hasTrue ? '有' : '无') + ' 复位x' + reset + (tryCatch ? ' 有catch' : ' 无catch') + (hasTrue && reset === 0 && tryCatch ? ' ⚠ 无复位' : ' OK'));
});

// F. fetch 直接调用是否有 Authorization 头（遗漏鉴权）
const fetches = [...src.matchAll(/fetch\((['"])([^'"]+)\1/g)].map(x => x[2]);
const noAuth = [];
src.replace(/[^\n]*fetch\([^)]*\)[^\n]*/g, (line) => { return line; });
// 简化：逐行检查 fetch( 且同函数块无 headers Authorization —— 粗查：fetch 后 3 行内无 Authorization 即列出人工核对
const lines = src.split('\n');
lines.forEach((l, i) => {
  if (l.includes('fetch(') && !l.includes('Authorization')) {
    const ctx3 = lines.slice(i, i + 4).join('\n');
    if (!ctx3.includes('Authorization')) noAuth.push('L' + (i + 1) + ': ' + l.trim().slice(0, 90));
  }
});
console.log('[F] fetch 无 Authorization（人工核对，导出类 blob 下载属正常）: ' + noAuth.length + '处');
noAuth.forEach(x => console.log('    ' + x));

// G. renderOverlays 渲染分支与 State 置空对齐
['compose', 'answer', 'lab', 'modal', 'drawer'].forEach(k => {
  const setNull = (src.match(new RegExp('State\\.' + k + ' = null', 'g')) || []).length;
  console.log('[G] State.' + k + ' 置空点:', setNull, setNull > 0 ? 'OK' : '⚠');
});

// H. addEventListener 全局监听（检查重复绑定风险——同一事件多监听器）
['change', 'input', 'keydown', 'click'].forEach(evt => {
  const c = (src.match(new RegExp("addEventListener\\('" + evt + "'", 'g')) || []).length;
  console.log('[H] document级 ' + evt + ' 监听:', c, '处', c > 1 ? '⚠ 多监听需确认非重复逻辑' : 'OK');
});
console.log('=== 静态扫描完成 ===');
