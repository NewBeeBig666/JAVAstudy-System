/* ===========================================================
 * 代码工作台（IDE 页面）· IntelliJ IDEA 风格独立代码编写页
 * 学生端「项目代码」点击编写 → 跳转本页（ide.html?sp=学生项目ID）
 * 布局：顶部工具栏 / 左侧文件树 / 中间编辑区（标签页+行号+高亮+补全）
 *       / 底部输出面板（输出 | 版本记录）/ 状态栏；分栏可拖拽调整
 * =========================================================== */
(function () {
  'use strict';
  if (!window.Auth || !window.Auth.requireLogin()) return;
  const API = window.API;

  const $ = (s, r) => (r || document).querySelector(s);
  const h = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /* ---------------- 图标 ---------------- */
  const ICONS = {
    chevronL: '<path d="m15 18-6-6 6-6"/>',
    chevronR: '<path d="m9 18 6-6-6-6"/>',
    chevronD: '<path d="m6 9 6 6 6-6"/>',
    sparkles: '<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/>',
    send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
    play: '<path d="m5 3 14 9-14 9z"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    checkcircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/>',
    refresh: '<path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    layers: '<path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>'
  };
  const icon = (n, s) => `<svg class="ico" width="${s || 14}" height="${s || 14}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[n] || ''}</svg>`;

  /* ---------------- 状态 ---------------- */
  const params = new URLSearchParams(location.search);
  const LAYOUT_KEY = 'la-ide-layout';
  const S = {
    spId: params.get('sp'),
    project: null, mine: null, versions: [],
    files: [],        // [{path, content}]（活动文件以编辑器 DOM 为准，切换前回写）
    active: null,     // 当前编辑文件 path
    tabs: [],         // 已打开标签 [path]
    dirty: false,
    bottomTab: 'output',
    running: false, saving: false,
    output: [],       // [{text, cls}]
    lastErrors: null, lastRunExit: null,   // 智能助手上下文捕获：最近编译诊断 / 运行结果
    asa: { messages: [], input: '', busy: false },  // 智能助手对话（结构同 index 页 State.assistant）
    stdin: '',       // 程序预置标准输入（运行时传给 Scanner 等输入型程序）
    layout: { treeW: 224, bottomH: 220, treeOn: true, bottomOn: true, asaOn: true, stdinOn: false }
  };
  try { Object.assign(S.layout, JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {}); } catch (e) { /* 忽略 */ }
  if (window.innerWidth < 900) S.layout.treeOn = false;
  // 智能助手默认展开/收起：窄屏默认收起，避免挤压核心编辑区（用户可手动展开，偏好持久化）
  if (window.innerWidth < 1280) S.layout.asaOn = false;

  const fileOf = p => S.files.find(f => f.path === p);
  const activeIdx = () => S.files.findIndex(f => f.path === S.active);

  function persistLayout() {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(S.layout)); } catch (e) { /* 忽略 */ }
  }
  function toast(msg, type) {
    const box = $('.ide-toasts');
    if (!box) return;
    const d = document.createElement('div');
    d.className = 'ide-toast ' + (type || '');
    d.innerHTML = icon(type === 'ok' ? 'checkcircle' : 'layers', 15) + '<span>' + h(msg) + '</span>';
    box.appendChild(d);
    setTimeout(() => d.classList.add('hide'), 2400);
    setTimeout(() => d.remove(), 2800);
  }

  /* ---------------- Markdown 渲染（与 index 页 md() 同构：代码块/标题/列表/表格/行内样式） ---------------- */
  function hlJava(code) {
    const slots = [];
    let src = code
      .replace(/(\/\/[^\n]*)/g, (m) => { slots.push('<span class="md-com">' + m + '</span>'); return '\u0001' + (slots.length - 1) + '\u0001'; })
      .replace(/(&quot;[^&\n]*?&quot;|&#39;[^&\n]*?&#39;)/g, (m) => { slots.push('<span class="md-str">' + m + '</span>'); return '\u0001' + (slots.length - 1) + '\u0001'; });
    const KW = 'abstract|assert|boolean|break|byte|case|catch|char|class|const|continue|default|do|double|else|enum|extends|final|finally|float|for|if|implements|import|instanceof|int|interface|long|native|new|package|private|protected|public|return|short|static|strictfp|super|switch|synchronized|this|throw|throws|transient|try|void|volatile|while|true|false|null|String|System|var';
    const kwRe = new RegExp('\\b(' + KW + ')\\b', 'g');
    const numRe = /\b(\d+(?:\.\d+)?[LlDdFf]?)\b/g;
    src = src.split(/(\u0001\d+\u0001)/).map(seg =>
      /^\u0001\d+\u0001$/.test(seg) ? seg
        : seg.replace(kwRe, '<span class="md-kw">$1</span>').replace(numRe, '<span class="md-num">$1</span>')
    ).join('');
    return src.replace(/\u0001(\d+)\u0001/g, (m, i) => slots[Number(i)]);
  }
  function md(t) {
    const blocks = [];
    let src = h(t).replace(/```(\w+)?\n?([\s\S]*?)```/g, (m, lang, code) => {
      blocks.push('<pre class="code-block md-code"' + (lang ? ' data-lang="' + h(lang) + '"' : '') + '>' +
        hlJava(code.replace(/\n$/, '')) + '</pre>');
      return '\u0002B' + (blocks.length - 1) + '\u0002';
    });
    src = src
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s（(【])\*([^*\n]+)\*(?=[\s，。；)）】，、]|$)/g, '$1<em>$2</em>');
    const lines = src.split('\n');
    const out = [];
    let listTag = null, tableRows = null;
    const closeList = () => { if (listTag) { out.push('</' + listTag + '>'); listTag = null; } };
    const closeTable = () => {
      if (!tableRows) return;
      const rows = tableRows.filter(r => !/^\s*\|?[\s:|-]+\|?\s*$/.test(r));
      const html = [];
      if (rows.length) {
        html.push('<table class="md-table">');
        rows.forEach((r, idx) => {
          const cells = r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
          const tag = idx === 0 ? 'th' : 'td';
          html.push('<tr>' + cells.map(c => '<' + tag + '>' + c + '</' + tag + '>').join('') + '</tr>');
        });
        html.push('</table>');
      }
      out.push(html.join(''));
      tableRows = null;
    };
    for (const raw of lines) {
      const l = raw.replace(/\s+$/, '');
      let m;
      if ((m = l.match(/^\u0002B(\d+)\u0002$/))) { closeList(); closeTable(); out.push(blocks[Number(m[1])]); continue; }
      if (!l.trim()) { closeList(); closeTable(); continue; }
      if ((m = l.match(/^(#{1,4})\s+(.+)$/))) { closeList(); closeTable(); out.push('<div class="md-h md-h' + m[1].length + '">' + m[2] + '</div>'); continue; }
      if (/^\s*\|.*\|\s*$/.test(l)) { closeList(); tableRows = tableRows || []; tableRows.push(l); continue; }
      closeTable();
      if ((m = l.match(/^(\s*)([-*·•])\s+(.+)$/))) {
        const lv2 = m[1].length >= 2 ? ' class="md-lv2"' : '';
        if (listTag !== 'ul') { closeList(); out.push('<ul class="md-ul">'); listTag = 'ul'; }
        out.push('<li' + lv2 + '>' + m[3] + '</li>');
        continue;
      }
      if ((m = l.match(/^\s*\d+[.、)）]\s+(.+)$/))) {
        if (listTag !== 'ol') { closeList(); out.push('<ol class="md-ol">'); listTag = 'ol'; }
        out.push('<li>' + m[1] + '</li>');
        continue;
      }
      closeList();
      out.push('<p>' + l + '</p>');
    }
    closeList(); closeTable();
    return out.join('');
  }
  // 输入框随内容增高（与 index 页 autoGrow 一致）
  function autoGrow(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 108) + 'px'; }
  const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…（过长已截断）' : s; };

  /* ===========================================================
   * 代码编辑器组件（自 app.js 移植，配色适配深色 IDE 主题）
   * 能力：实时语法高亮 / 行号 / 自动缩进 / 括号引号闭合跨越 / 智能补全
   * =========================================================== */
  const CE_INDENT = '    ';
  const CE_PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
  const CE_TOP = [
    ['public', '访问修饰符 · 公有', 'K'], ['private', '访问修饰符 · 私有', 'K'], ['protected', '访问修饰符 · 受保护', 'K'],
    ['static', '关键字 · 静态成员', 'K'], ['final', '关键字 · 不可变 / 终态', 'K'], ['void', '关键字 · 无返回值', 'K'],
    ['class', '关键字 · 定义类', 'K'], ['interface', '关键字 · 定义接口', 'K'], ['abstract', '关键字 · 抽象', 'K'],
    ['enum', '关键字 · 定义枚举', 'K'], ['extends', '关键字 · 继承父类', 'K'], ['implements', '关键字 · 实现接口', 'K'],
    ['import', '关键字 · 导入类 / 包', 'K'], ['package', '关键字 · 包声明', 'K'],
    ['new', '关键字 · 创建对象', 'K'], ['this', '关键字 · 当前实例', 'K'], ['super', '关键字 · 父类引用', 'K'],
    ['int', '基本类型 · 整型', 'K'], ['long', '基本类型 · 长整型', 'K'], ['double', '基本类型 · 双精度浮点', 'K'],
    ['float', '基本类型 · 单精度浮点', 'K'], ['char', '基本类型 · 字符型', 'K'], ['boolean', '基本类型 · 布尔型', 'K'],
    ['byte', '基本类型 · 字节型', 'K'], ['short', '基本类型 · 短整型', 'K'], ['var', '关键字 · 局部变量类型推断', 'K'],
    ['if', '流程控制 · 条件分支', 'K'], ['else', '流程控制 · 否则分支', 'K'],
    ['for', '流程控制 · 循环', 'K'], ['while', '流程控制 · while 循环', 'K'], ['do', '流程控制 · do-while', 'K'],
    ['switch', '流程控制 · 多分支', 'K'], ['case', '流程控制 · 分支标签', 'K'], ['default', '流程控制 · 默认分支', 'K'],
    ['break', '流程控制 · 跳出循环', 'K'], ['continue', '流程控制 · 下一轮循环', 'K'], ['return', '流程控制 · 返回', 'K'],
    ['try', '异常处理 · 监视块', 'K'], ['catch', '异常处理 · 捕获', 'K'], ['finally', '异常处理 · 收尾块', 'K'],
    ['throw', '异常处理 · 抛出异常', 'K'], ['throws', '异常处理 · 声明异常', 'K'],
    ['String', '常用类 · 字符串', 'T'], ['System', '系统类 · 标准流与工具', 'T'],
    ['ArrayList', '集合类 · 动态数组', 'T'], ['HashMap', '集合类 · 哈希表', 'T'],
    ['List', '集合接口 · 列表', 'T'], ['Map', '集合接口 · 键值对', 'T'],
    ['Scanner', '输入类 · 读取控制台输入', 'T'], ['Math', '工具类 · 数学运算', 'T'],
    ['Integer', '包装类 · 整型', 'T'], ['Double', '包装类 · 双精度', 'T'], ['Boolean', '包装类 · 布尔', 'T'],
    ['Exception', '异常类 · 所有异常基类', 'T'], ['Runnable', '接口 · 线程任务', 'T'],
    ['sout', '片段 · System.out.println()', 'S'], ['sysout', '片段 · System.out.println()', 'S'],
    ['psvm', '片段 · main 方法骨架', 'S'], ['main', '片段 · main 方法骨架', 'S'],
    ['fori', '片段 · for 循环骨架', 'S'], ['foreach', '片段 · 增强 for 循环', 'S'], ['tryc', '片段 · try-catch 骨架', 'S']
  ];
  const CE_SNIPPETS = {
    sout: 'System.out.println();', sysout: 'System.out.println();',
    psvm: 'public static void main(String[] args) {\n' + CE_INDENT + '|\n' + CE_INDENT + '}',
    main: 'public static void main(String[] args) {\n' + CE_INDENT + '|\n' + CE_INDENT + '}',
    fori: 'for (int i = 0; i < |; i++) {\n' + CE_INDENT + '\n}',
    foreach: 'for (var item : list) {\n' + CE_INDENT + '|\n}',
    tryc: 'try {\n' + CE_INDENT + '|\n} catch (Exception e) {\n' + CE_INDENT + 'e.printStackTrace();\n}'
  };
  const CE_MEMBERS = {
    'System.out': [['println', '打印并换行', 'M'], ['print', '打印不换行', 'M'], ['printf', '格式化打印', 'M'], ['flush', '刷新缓冲区', 'M']],
    'System.err': [['println', '打印到错误流', 'M'], ['print', '打印到错误流', 'M']],
    'System': [['out', '标准输出流', 'T'], ['err', '标准错误流', 'T'], ['currentTimeMillis', '当前毫秒时间戳', 'M'],
      ['arraycopy', '数组复制', 'M'], ['exit', '退出 JVM', 'M'], ['lineSeparator', '系统换行符', 'M']],
    'Math': [['max', '两者较大值', 'M'], ['min', '两者较小值', 'M'], ['abs', '绝对值', 'M'], ['sqrt', '平方根', 'M'],
      ['pow', 'x 的 y 次幂', 'M'], ['random', '[0,1) 随机小数', 'M'], ['round', '四舍五入', 'M'], ['floor', '向下取整', 'M']],
    'Integer': [['parseInt', '字符串 → int', 'M'], ['valueOf', '包装为 Integer', 'M'], ['toString', '转字符串', 'M'],
      ['MAX_VALUE', 'int 最大值', 'T'], ['MIN_VALUE', 'int 最小值', 'T']],
    'Double': [['parseDouble', '字符串 → double', 'M'], ['valueOf', '包装为 Double', 'M'], ['MAX_VALUE', 'double 最大值', 'T']],
    'String': [['valueOf', '转换为字符串', 'M'], ['format', '格式化字符串', 'M'], ['join', '拼接字符串', 'M'], ['copyValueOf', '字符数组 → 字符串', 'M']],
    'Scanner': [['nextInt', '读取整数', 'M'], ['nextLine', '读取一行', 'M'], ['next', '读取一个词', 'M'],
      ['hasNext', '是否还有输入', 'M'], ['hasNextInt', '是否还有整数', 'M'], ['close', '关闭输入流', 'M']],
    'ArrayList': [['add', '追加元素', 'M'], ['get', '按下标取值', 'M'], ['size', '元素个数', 'M'], ['remove', '移除元素', 'M'],
      ['isEmpty', '是否为空', 'M'], ['contains', '是否包含', 'M'], ['clear', '清空', 'M'], ['set', '替换元素', 'M']],
    'List': [['add', '追加元素', 'M'], ['get', '按下标取值', 'M'], ['size', '元素个数', 'M'], ['remove', '移除元素', 'M'], ['isEmpty', '是否为空', 'M']],
    'HashMap': [['put', '写入键值对', 'M'], ['get', '按键取值', 'M'], ['containsKey', '是否包含键', 'M'],
      ['keySet', '键集合', 'M'], ['values', '值集合', 'M'], ['size', '元素个数', 'M'], ['getOrDefault', '取值或默认', 'M'], ['remove', '按键移除', 'M']],
    'Map': [['put', '写入键值对', 'M'], ['get', '按键取值', 'M'], ['containsKey', '是否包含键', 'M'], ['keySet', '键集合', 'M'], ['getOrDefault', '取值或默认', 'M']],
    'str': [['length', '字符串长度', 'M'], ['charAt', '取指定字符', 'M'], ['substring', '截取子串', 'M'],
      ['indexOf', '查找位置', 'M'], ['equals', '内容比较', 'M'], ['equalsIgnoreCase', '忽略大小写比较', 'M'],
      ['toUpperCase', '转大写', 'M'], ['toLowerCase', '转小写', 'M'], ['split', '按分隔符拆分', 'M'], ['trim', '去除首尾空白', 'M'], ['isEmpty', '是否为空', 'M']]
  };
  const CE_GENERIC_MEMBERS = [
    ['toString', '转字符串', 'M'], ['equals', '内容相等比较', 'M'], ['hashCode', '哈希码', 'M'],
    ['size', '元素个数', 'M'], ['length', '长度（数组/字符串）', 'T'], ['isEmpty', '是否为空', 'M'],
    ['get', '取值', 'M'], ['add', '追加', 'M'], ['close', '关闭资源', 'M'], ['next', '下一个元素', 'M']
  ];
  const CE_KW_SET = new Set(CE_TOP.map(x => x[0]));
  const ceOkItem = x => Array.isArray(x) && typeof x[0] === 'string';

  function ceHighlight(code) {
    const CTL = new Set('if else for while do switch case default break continue return try catch finally throw throws new'.split(' '));
    const KW = new Set('abstract assert boolean byte char class const double enum extends final float implements import instanceof int interface long native package private protected public short static strictfp super synchronized this transient volatile void true false null var'.split(' '));
    const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|\b(\d+(?:\.\d+)?[LlDdFf]?)\b|\b([A-Za-z_$][\w$]*)\b/g;
    const out = [];
    let last = 0, m;
    while ((m = re.exec(code))) {
      if (m.index > last) out.push(h(code.slice(last, m.index)));
      const s = m[0];
      if (m[1]) out.push('<span class="ce-com">' + h(s) + '</span>');
      else if (m[2]) out.push('<span class="ce-str">' + h(s) + '</span>');
      else if (m[3]) out.push('<span class="ce-num">' + h(s) + '</span>');
      else if (CTL.has(s)) out.push('<span class="ce-ctl">' + h(s) + '</span>');
      else if (KW.has(s)) out.push('<span class="ce-kw">' + h(s) + '</span>');
      else if (/^\s*\(/.test(code.slice(m.index + s.length))) out.push('<span class="ce-fn">' + h(s) + '</span>');
      else if (/^[A-Z]/.test(s)) out.push('<span class="ce-type">' + h(s) + '</span>');
      else out.push(h(s));
      last = m.index + s.length;
    }
    out.push(h(code.slice(last)));
    return out.join('');
  }

  /* ---------------- 页面骨架 ---------------- */
  function renderShell() {
    $('#ide').innerHTML = `
    <div class="ide-app">
      <div class="ide-toolbar">
        <button class="ide-tb-btn" id="btnBack" title="返回项目列表">${icon('chevronL', 15)} 返回项目</button>
        <div class="ide-proj">${icon('code', 15)}<span class="ide-proj-name" id="projName"></span><span id="projBadge"></span></div>
        <div class="ide-spacer"></div>
        <button class="ide-tb-btn run" id="btnRun" title="编译并运行入口类（Shift+F10）">${icon('play', 14)} 运行</button>
        <input class="ide-note-input" id="noteInput" placeholder="版本说明，如：完成主菜单（保存时填写）" maxlength="200">
        <button class="ide-tb-btn" id="btnSave" title="保存为新版本（Ctrl+S）">${icon('check', 14)} 保存新版本</button>
        <button class="ide-tb-btn primary" id="btnSubmit" title="保存并提交给教师">${icon('checkcircle', 14)} 保存并提交</button>
      </div>
      <div class="ide-main">
        <div class="ide-tree" id="treePanel">
          <div class="ide-tree-head">
            ${icon('layers', 13)} <span>项目文件</span>
            <div class="ide-spacer"></div>
            <button class="ide-tb-btn" id="btnTreeFold" style="height:24px;padding:0 6px" title="折叠/展开目录">${icon('chevronD', 13)}</button>
          </div>
          <div class="ide-tree-body" id="treeBody"></div>
          <div class="ide-tree-foot">
            <input class="ide-new-file" id="newFileInput" placeholder="新文件名，如 Book.java" autocomplete="off">
            <button class="ide-tb-btn" id="btnNewFile">${icon('plus', 13)} 新增文件</button>
          </div>
        </div>
        <div class="ide-vsplit" id="vsplit"></div>
        <div class="ide-col">
          <div class="ide-tabs" id="tabBar"></div>
          <div class="ide-editor" id="editorRoot">
            <div class="ce-gutter"><div class="ce-gutter-inner"></div></div>
            <div class="ce-area">
              <pre class="ce-hl"><code></code></pre>
              <textarea class="ce-input" id="ceTa" spellcheck="false" autocomplete="off" autocapitalize="off" wrap="off"></textarea>
            </div>
          </div>
          <div class="ide-hsplit" id="hsplit"></div>
          <div class="ide-bottom" id="bottomPanel">
            <div class="ide-bottom-head">
              <button class="ide-btab" data-btab="output">输出</button>
              <button class="ide-btab" data-btab="versions">版本记录</button>
              <div class="ide-spacer"></div>
              <button class="ide-tb-btn" id="btnStdin" style="height:24px;padding:0 8px" title="展开/收起程序输入（运行时作为标准输入传给程序）">输入</button>
              <button class="ide-tb-btn" id="btnClearOut" style="height:24px;padding:0 8px" title="清空输出">清空</button>
              <button class="ide-tb-btn" id="btnBottomFold" style="height:24px;padding:0 6px" title="折叠/展开面板">${icon('chevronD', 13)}</button>
            </div>
            <div class="ide-bottom-body" id="bottomBody"></div>
          </div>
        </div>
        <div class="ide-asa" id="asaPanel"></div>
      </div>
      <div class="ide-status">
        <span class="ide-status-item"><span class="st-dot" id="stDot"></span><span id="stText">就绪</span></span>
        <span class="ide-status-item" id="stCursor">Ln 1, Col 1</span>
        <span class="ide-status-item" id="stFiles"></span>
        <div class="ide-spacer"></div>
        <span class="ide-status-item" id="stVersion"></span>
        <span class="ide-status-item">UTF-8 · Java</span>
      </div>
    </div>
    <div class="ide-toasts"></div>`;
  }

  /* ---------------- 子区域渲染 ---------------- */
  function renderToolbar() {
    const on = S.mine && S.mine.status === 'SUBMITTED';
    $('#projName').textContent = S.project ? S.project.title : '';
    $('#projBadge').innerHTML = on
      ? '<span style="font-size:11px;color:#7ee08a;background:rgba(73,156,84,.16);border-radius:999px;padding:2px 9px">已提交</span>'
      : '<span style="font-size:11px;color:#9da0a8;background:#323538;border-radius:999px;padding:2px 9px">开发中</span>';
    $('#btnRun').disabled = S.running;
    $('#btnRun').innerHTML = S.running ? icon('refresh', 14) + ' 运行中…' : icon('play', 14) + ' 运行';
    $('#btnRun').classList.toggle('running', S.running);
    $('#btnSave').disabled = S.running || S.saving;
    $('#btnSubmit').disabled = S.running || S.saving;
  }

  function renderTree() {
    const items = S.files.map(f => `<button class="tree-item ${f.path === S.active ? 'on' : ''}" data-file="${h(f.path)}" title="${h(f.path)}">
        ${icon('file', 13)}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h(f.path)}</span>
        ${S.files.length > 1 ? `<span class="tree-del" data-del="${h(f.path)}" title="删除文件">${icon('x', 11)}</span>` : ''}
      </button>`).join('');
    $('#treeBody').innerHTML = `<div class="ide-tree-root">${icon('code', 14)} ${h(S.project ? S.project.title : '项目')}</div>`
      + (items || '<div class="tree-empty">（暂无文件）</div>');
  }

  function renderTabs() {
    const bar = $('#tabBar');
    bar.innerHTML = S.tabs.map(p => {
      const f = fileOf(p);
      const dirty = f && f.path === S.active ? S.dirty : (f ? !!f._dirty : false);
      return `<button class="ide-tab ${p === S.active ? 'on' : ''}" data-tab="${h(p)}" title="${h(p)}">
        ${icon('file', 12)}<span>${h(p)}</span>
        ${dirty ? '<span class="tab-dirty"></span>' : ''}
        <span class="tab-close" data-tabclose="${h(p)}" title="关闭标签">${icon('x', 11)}</span>
      </button>`;
    }).join('');
  }

  function renderStatus() {
    $('#stText').textContent = S.dirty ? '未保存的修改' : '已保存';
    $('#stDot').classList.toggle('dirty', S.dirty);
    $('#stFiles').textContent = S.files.length + ' 个文件';
    $('#stVersion').textContent = '已留存 ' + (S.mine ? S.mine.versionCount || 0 : 0) + ' 个版本'
      + (S.mine && S.mine.status === 'SUBMITTED' ? ' · 已提交' : '');
  }

  function renderCursor() {
    const ta = $('#ceTa');
    const upto = ta.value.slice(0, ta.selectionStart).split('\n');
    $('#stCursor').textContent = 'Ln ' + upto.length + ', Col ' + (upto[upto.length - 1].length + 1);
  }

  function renderBottom() {
    document.querySelectorAll('.ide-btab').forEach(b => b.classList.toggle('on', b.dataset.btab === S.bottomTab));
    const body = $('#bottomBody');
    const stdinBtn = $('#btnStdin');
    if (stdinBtn) stdinBtn.style.display = S.bottomTab === 'output' ? '' : 'none';
    if (S.bottomTab === 'output') {
      // 程序输入区（可选）：运行时作为标准输入传给 Scanner 等输入型程序
      const stdinBox = S.layout.stdinOn ? `<div class="stdin-box">
          <div class="stdin-head">程序输入 <span class="hint">（运行时作为标准输入传给程序，每行一个值，≤4KB）</span></div>
          <textarea id="stdinTa" placeholder="例如程序用 Scanner 读取两个整数，在此填写：&#10;3&#10;4" spellcheck="false">${h(S.stdin || '')}</textarea>
        </div>` : '';
      body.innerHTML = stdinBox + (S.output.length
        ? S.output.map(l => `<div class="out-line ${l.cls || ''}">${h(l.text)}</div>`).join('')
        : '<div class="out-line out-hint">运行结果将显示在这里 · 点击工具栏「▶ 运行」或按 Shift+F10</div>');
      body.scrollTop = body.scrollHeight;
    } else {
      const vs = S.versions || [];
      body.innerHTML = vs.length
        ? vs.map(v => `<div class="ver-item"><span class="ver-no">v${v.versionNo}</span>
            <span class="ver-summary">${h(v.summary || '—')}</span>
            <span class="ver-meta">${v.codeSize >= 1024 ? (v.codeSize / 1024).toFixed(1) + ' KB' : v.codeSize + ' B'} · ${h(v.createdAt || '')}</span></div>`).join('')
        : '<div class="out-line out-hint">暂无版本 · 每次保存自动生成新版本并记录在这里</div>';
    }
    $('#btnClearOut').style.display = S.bottomTab === 'output' ? '' : 'none';
  }

  function out(text, cls) {
    S.output.push({ text: String(text), cls: cls || '' });
    if (S.output.length > 2000) S.output.splice(0, S.output.length - 2000);
    if (S.bottomTab === 'output') renderBottom();
  }

  /* ---------------- 布局：折叠 + 拖拽 ---------------- */
  function applyLayout() {
    // 折叠保留标题栏（mini 态）：切换按钮始终可点，便于再展开
    $('#treePanel').classList.toggle('mini', !S.layout.treeOn);
    $('#vsplit').style.display = S.layout.treeOn ? '' : 'none';
    if (S.layout.treeOn) $('#treePanel').style.width = S.layout.treeW + 'px';
    $('#bottomPanel').classList.toggle('mini', !S.layout.bottomOn);
    $('#hsplit').style.display = S.layout.bottomOn ? '' : 'none';
    if (S.layout.bottomOn) $('#bottomPanel').style.height = S.layout.bottomH + 'px';
    $('#btnTreeFold').title = S.layout.treeOn ? '折叠目录' : '展开目录';
    $('#btnBottomFold').title = S.layout.bottomOn ? '折叠面板' : '展开面板';
  }
  function dragify(handle, onMove) {
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('drag');
      // 基准值快照：增量始终相对拖拽起点计算（move 多次触发不会累积叠加）
      const start = { x: e.clientX, y: e.clientY, v: null };
      const move = ev => onMove(ev.clientX - start.x, ev.clientY - start.y, start);
      const up = () => {
        handle.classList.remove('drag');
        handle.removeEventListener('pointermove', move);
        persistLayout();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up, { once: true });
    });
  }

  /* ---------------- 编辑器挂载（移植自 app.js ceAttach） ---------------- */
  function attachEditor() {
    const root = $('#editorRoot');
    const gutter = root.querySelector('.ce-gutter-inner');
    const hl = root.querySelector('.ce-hl');
    const codeEl = root.querySelector('.ce-hl code');
    const area = root.querySelector('.ce-area');
    const ta = $('#ceTa');
    const ac = document.createElement('div');
    ac.className = 'ce-ac';
    root.appendChild(ac);
    const ACS = { items: [], active: -1, start: 0 };
    let ime = false;

    const ceSync = () => {
      codeEl.innerHTML = ceHighlight(ta.value || '');
      const n = (ta.value || '').split('\n').length;
      let g = '';
      for (let i = 1; i <= Math.max(n, 1); i++) g += '<div>' + i + '</div>';
      gutter.innerHTML = g;
      hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft;
      gutter.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
    };
    const ceSet = (text, caret) => {
      ta.value = text;
      ta.selectionStart = ta.selectionEnd = caret == null ? text.length : caret;
      syncActiveFile();
      ceSync();
    };
    const caretXY = () => {
      const cs = getComputedStyle(ta);
      const div = document.createElement('div');
      div.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;box-sizing:border-box;';
      div.style.font = cs.font; div.style.lineHeight = cs.lineHeight;
      div.style.padding = cs.padding; div.style.width = cs.width;
      div.style.letterSpacing = cs.letterSpacing;
      div.textContent = (ta.value || '').slice(0, ta.selectionStart);
      const sp = document.createElement('span');
      sp.textContent = '\u200b';
      div.appendChild(sp);
      root.appendChild(div);
      const x = sp.offsetLeft - ta.scrollLeft, y = sp.offsetTop - ta.scrollTop;
      root.removeChild(div);
      return { x, y };
    };
    const acClose = () => { ac.style.display = 'none'; ACS.items = []; ACS.active = -1; };
    const acRender = () => {
      if (!ACS.items.length) { acClose(); return; }
      ac.innerHTML = ACS.items.map((it, i) => `<div class="ce-ac-item${i === ACS.active ? ' on' : ''}" data-i="${i}">
          <span class="ce-ac-ico k${it.k}">${it.k}</span>
          <span class="ce-ac-name">${h(it.t)}</span>
          <span class="ce-ac-desc">${h(it.d || '')}</span>
        </div>`).join('');
      ac.style.display = 'block';
      try {
        const p = caretXY();
        const areaX = area.offsetLeft;
        const lh = 20; // 行高 12.5px * 1.6
        ac.style.left = Math.max(4, Math.min(areaX + p.x + 2, root.clientWidth - ac.offsetWidth - 4)) + 'px';
        ac.style.top = (p.y + lh + 4) + 'px';
        ac.style.bottom = '';
      } catch (err) { ac.style.left = '4px'; ac.style.bottom = '4px'; }
      const on = ac.querySelector('.ce-ac-item.on');
      if (on) on.scrollIntoView({ block: 'nearest' });
    };
    const acAccept = idx => {
      const it = ACS.items[idx];
      if (!it) { acClose(); return; }
      const end = ta.selectionStart, start = ACS.start;
      let text = it.t, caret = null;
      if (it.k === 'S') {
        const snip = CE_SNIPPETS[it.t] || '';
        const ci = snip.indexOf('|');
        text = snip.replace(/\|/g, '');
        caret = start + (ci >= 0 ? ci : text.length);
      } else if (it.k === 'M') {
        text = it.t + '()';
        caret = start + it.t.length + 1;
      } else {
        caret = start + text.length;
      }
      acClose();
      ceSet(ta.value.slice(0, start) + text + ta.value.slice(end), caret);
      ta.focus();
    };
    const acUpdate = () => {
      const pos = ta.selectionStart;
      const before = ta.value.slice(0, pos);
      const wm = /([A-Za-z_$][\w$]*)$/.exec(before);
      if (!wm) { acClose(); return; }
      const prefix = wm[0];
      const ctx = before.slice(0, before.length - prefix.length);
      const isMember = ctx.endsWith('.');
      if (!isMember && prefix.length < 2) { acClose(); return; }
      let items = [];
      if (isMember) {
        let list = CE_GENERIC_MEMBERS;
        if (/System\s*\.\s*out\s*\.\s*$/.test(ctx)) list = CE_MEMBERS['System.out'];
        else if (/System\s*\.\s*err\s*\.\s*$/.test(ctx)) list = CE_MEMBERS['System.err'];
        else {
          const rm = /([A-Za-z_$][\w$]*)\s*\.\s*$/.exec(ctx);
          if (rm && CE_MEMBERS[rm[1]]) list = CE_MEMBERS[rm[1]];
          else if (rm && /^(s|str)\d*$/i.test(rm[1])) list = CE_MEMBERS['str'];
        }
        items = list.filter(x => ceOkItem(x) && x[0].toLowerCase().startsWith(prefix.toLowerCase()))
          .map(x => ({ t: x[0], d: x[1], k: x[2] }));
      } else {
        const low = prefix.toLowerCase();
        items = CE_TOP.filter(x => ceOkItem(x) && x[0].toLowerCase().startsWith(low)).map(x => ({ t: x[0], d: x[1], k: x[2] }));
        const seen = new Set(items.map(x => x.t.toLowerCase()));
        const docRe = /[A-Za-z_$][\w$]*/g;
        let dm, count = 0;
        while ((dm = docRe.exec(ta.value)) && count < 6) {
          const w = dm[0];
          if (w !== prefix && w.toLowerCase().startsWith(low) && w.length > 2
            && !CE_KW_SET.has(w) && !seen.has(w.toLowerCase())) {
            seen.add(w.toLowerCase());
            items.push({ t: w, d: '当前代码中的标识符', k: 'V' });
            count++;
          }
        }
        items.sort((a, b) => (a.k === 'S' ? 1 : 0) - (b.k === 'S' ? 1 : 0) || a.t.length - b.t.length);
      }
      if (!items.length) { acClose(); return; }
      ACS.items = items.slice(0, 9);
      ACS.active = 0;
      ACS.start = pos - prefix.length;
      acRender();
    };

    ta.addEventListener('input', () => {
      ceSync();
      syncActiveFile();
      markDirty();
      if (!ta.disabled) acUpdate();
      renderCursor();
    });
    ta.addEventListener('scroll', () => {
      hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft;
      gutter.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
      if (ac.style.display !== 'none') acRender();
    });
    ta.addEventListener('click', () => { renderCursor(); });
    ta.addEventListener('keyup', () => { renderCursor(); });
    ta.addEventListener('compositionstart', () => { ime = true; acClose(); });
    ta.addEventListener('compositionend', () => { ime = false; ceSync(); });
    ta.addEventListener('blur', () => setTimeout(acClose, 120));
    ac.addEventListener('mousedown', e => {
      const item = e.target.closest('.ce-ac-item');
      e.preventDefault();
      if (item) acAccept(Number(item.dataset.i));
    });
    ta.addEventListener('keydown', e => {
      const open = ac.style.display !== 'none' && ACS.items.length;
      if (open && !ime) {
        if (e.key === 'ArrowDown') { e.preventDefault(); ACS.active = (ACS.active + 1) % ACS.items.length; acRender(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); ACS.active = (ACS.active - 1 + ACS.items.length) % ACS.items.length; acRender(); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acAccept(ACS.active); return; }
        if (e.key === 'Escape') { e.preventDefault(); acClose(); return; }
      }
      if (ime) return;
      const pos = ta.selectionStart, s0 = ta.selectionEnd;
      const val = ta.value;
      const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
      const indent = (val.slice(lineStart, pos).match(/^[ \t]*/) || [''])[0];
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const lineEnd = val.slice(lineStart, pos).trimEnd();
        const after = val.slice(s0);
        if (lineEnd.endsWith('{') && after.startsWith('}')) {
          ceSet(val.slice(0, pos) + '\n' + indent + CE_INDENT + '\n' + indent + after, pos + 1 + indent.length + CE_INDENT.length);
          return;
        }
        const add = (lineEnd.endsWith('{') || lineEnd.endsWith('(')) ? CE_INDENT : '';
        ceSet(val.slice(0, pos) + '\n' + indent + add + after, pos + 1 + indent.length + add.length);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        ceSet(val.slice(0, pos) + CE_INDENT + val.slice(s0), pos + CE_INDENT.length);
        return;
      }
      if (e.key === ' ' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        acUpdate();
        if (!ACS.items.length && !/([A-Za-z_$][\w$]*)$/.test(ta.value.slice(0, pos))) {
          ACS.items = CE_TOP.slice(0, 9).map(x => ({ t: x[0], d: x[1], k: x[2] }));
          ACS.active = 0; ACS.start = pos; acRender();
        }
        return;
      }
      if (CE_PAIRS[e.key]) {
        const next = val.slice(s0, s0 + 1);
        if (pos !== s0) { e.preventDefault(); ceSet(val.slice(0, pos) + e.key + CE_PAIRS[e.key] + val.slice(s0), pos + 1); return; }
        if (next === '' || /[\s)\]}:;"'@.,]/.test(next)) { e.preventDefault(); ceSet(val.slice(0, pos) + e.key + CE_PAIRS[e.key] + val.slice(s0), pos + 1); return; }
      }
      if (e.key === ')' || e.key === ']' || e.key === '}' || e.key === '"' || e.key === "'") {
        if (val.slice(s0, s0 + 1) === e.key && pos === s0) { e.preventDefault(); ta.selectionStart = ta.selectionEnd = pos + 1; return; }
      }
      if (e.key === 'Backspace' && pos === s0 && pos > 0) {
        const prev = val.slice(pos - 1, pos), next = val.slice(pos, pos + 1);
        if (CE_PAIRS[prev] && CE_PAIRS[prev] === next) { e.preventDefault(); ceSet(val.slice(0, pos - 1) + val.slice(pos + 1), pos - 1); return; }
      }
    });
    ceSync();
    return ceSync;
  }

  /* ---------------- 文件/标签操作 ---------------- */
  function syncActiveFile() {
    const i = activeIdx();
    if (i >= 0) S.files[i].content = $('#ceTa').value;
  }
  function markDirty() {
    if (!S.dirty) { S.dirty = true; renderTabs(); renderStatus(); }
  }
  function openFile(path) {
    if (S.active) syncActiveFile();
    const f = fileOf(path);
    if (!f) return;
    S.active = path;
    if (!S.tabs.includes(path)) S.tabs.push(path);
    const ta = $('#ceTa');
    ta.value = f.content || '';
    ta.placeholder = '在此编写 ' + path + ' …';
    ta.focus();
    CE_SYNC();
    renderTree(); renderTabs(); renderStatus(); renderCursor();
  }
  function closeTab(path) {
    // 关闭的是活动标签：内容已实时同步，直接切到相邻标签
    const i = S.tabs.indexOf(path);
    if (i < 0) return;
    if (S.tabs.length === 1) return; // 最后一个标签不可关闭
    S.tabs.splice(i, 1);
    if (S.active === path) openFile(S.tabs[Math.min(i, S.tabs.length - 1)]);
    else renderTabs();
  }
  function addFile() {
    const input = $('#newFileInput');
    const name = (input.value || '').trim();
    if (!name) { toast('请输入新文件名', 'warn'); return; }
    if (!/^[\w$.-]+\.java$/.test(name)) { toast('文件名不合法：需以 .java 结尾且不含路径分隔符', 'warn'); return; }
    if (fileOf(name)) { toast('文件已存在：' + name, 'warn'); return; }
    S.files.push({ path: name, content: '' });
    input.value = '';
    openFile(name);
    markDirty();
    renderStatus();
    toast('已新增文件 ' + name, 'ok');
  }
  function delFile(path) {
    if (S.files.length <= 1) { toast('至少保留一个代码文件', 'warn'); return; }
    S.files = S.files.filter(f => f.path !== path);
    S.tabs = S.tabs.filter(p => p !== path);
    if (S.active === path) openFile(S.tabs[0] || S.files[0].path);
    else { renderTree(); renderTabs(); }
    markDirty(); renderStatus();
    toast('已删除文件 ' + path, 'ok');
  }

  /* ===========================================================
   * 右侧智能助手（与平台其余页面同构：复用 /api/student/assistant 与既有交互）
   * 差异点：发送时自动拼接 IDE 上下文（当前文件/选中代码/光标位置/最近编译报错），
   * 对话气泡仍显示用户原始问题；上下文仅注入本次请求，不进入展示历史
   * =========================================================== */
  const ASA_CFG = {
    url: '/student/assistant',
    welcome: '你的 Java 编码助手：结合你在 IDE 中的当前文件、选中代码与编译报错，提供代码解释、错误排查、编码建议、代码生成与问题答疑。',
    tip: 'Enter 发送 · Shift+Enter 换行 · 自动携带 IDE 代码上下文',
    placeholder: '输入问题，Enter 发送…',
    quicks: [
      '解释当前文件的代码逻辑',
      '我的代码编译报错了，帮我排查',
      '帮我优化当前代码的写法',
      '这段代码涉及哪些知识点？给我讲讲'
    ]
  };
  // 捕获当前 IDE 上下文：项目/当前文件/文件列表/选中代码（无选中取光标行）/光标位置/最近编译报错与运行结果
  function buildIdeContext(question) {
    const ta = $('#ceTa');
    const f = fileOf(S.active);
    const lines = ((ta && ta.value) || '').split('\n');
    const upto = (ta ? ta.value.slice(0, ta.selectionStart) : '').split('\n');
    const ln = upto.length, col = upto[upto.length - 1].length + 1;
    const ctx = ['【IDE 代码上下文】'];
    ctx.push('项目：' + (S.project ? S.project.title : '未命名项目'));
    ctx.push('当前文件：' + S.active + '（共 ' + lines.length + ' 行，光标 Ln ' + ln + ', Col ' + col + '）');
    ctx.push('项目文件：' + S.files.map(x => x.path).join(', '));
    const sel = ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : '';
    if (sel) ctx.push('选中代码：\n```\n' + clip(sel, 1500) + '\n```');
    else if ((lines[ln - 1] || '').trim()) ctx.push('光标所在行：`' + clip(lines[ln - 1].trim(), 300) + '`');
    if (f && (f.content || '').trim()) ctx.push('当前文件内容：\n```\n' + clip(f.content, 3000) + '\n```');
    if (S.lastErrors) ctx.push('最近编译报错：\n' + clip(S.lastErrors, 1200));
    if (S.lastRunExit != null) ctx.push('最近运行退出代码：' + S.lastRunExit);
    ctx.push('【我的问题】');
    ctx.push(question);
    return ctx.join('\n');
  }
  function renderAsa() {
    const box = $('#asaPanel');
    if (!box) return;
    const a = S.asa;
    if (!S.layout.asaOn) {
      box.className = 'ide-asa mini';
      box.innerHTML = `<div class="ide-asa-rail">
          <button class="ide-tb-btn" id="btnAsaToggle" title="展开智能助手">${icon('sparkles', 16)}</button>
        </div>`;
      return;
    }
    box.className = 'ide-asa';
    const msgs = a.messages;
    let flow = '';
    if (!msgs.length) {
      flow = `<div class="asa-welcome">
          <div class="asa-welcome-ico">${icon('sparkles', 22)}</div>
          <div class="asa-welcome-title">智能助手</div>
          <div class="asa-welcome-desc">${ASA_CFG.welcome}</div>
          <div class="asa-chips">${ASA_CFG.quicks.map(q => `<button class="asa-chip" data-asaquick="${h(q)}">${icon('sparkles', 12)} ${h(q)}</button>`).join('')}</div>
        </div>`;
    } else {
      flow = msgs.map(m => m.role === 'user'
        ? `<div class="asa-msg user"><div class="asa-bubble-user">${h(m.content)}</div></div>`
        : `<div class="asa-msg ai"><div class="asa-bubble-ai">${md(m.content)}</div></div>`
      ).join('');
      if (a.busy) flow += `<div class="asa-msg ai"><div class="asa-bubble-ai"><span class="typing"><i></i><i></i><i></i></span></div></div>`;
    }
    box.innerHTML = `<div class="asa-head-bar">
        <span class="asa-title">${icon('sparkles', 15)} 智能助手</span>
        <div class="ide-spacer"></div>
        <button class="ide-tb-btn" id="btnAsaNew" style="height:26px;padding:0 6px" title="开始新对话">${icon('refresh', 14)}</button>
        <button class="ide-tb-btn" id="btnAsaToggle" style="height:26px;padding:0 6px" title="折叠智能助手">${icon('chevronR', 15)}</button>
      </div>
      <div class="asa-body" id="asaMsgs">${flow}</div>
      <div class="asa-input-wrap">
        <div class="asa-composer">
          <textarea id="asaInput" placeholder="${h(ASA_CFG.placeholder)}">${h(a.input || '')}</textarea>
          <button class="asa-send" id="btnAsaSend" ${a.busy ? 'disabled' : ''} title="发送">${icon('send', 14)}</button>
        </div>
        <div class="asa-tip">${ASA_CFG.tip}</div>
      </div>`;
    const body = $('#asaMsgs');
    if (body) body.scrollTop = body.scrollHeight;
    const ta = $('#asaInput');
    if (ta) { ta.disabled = a.busy; autoGrow(ta); }
  }
  async function asaSend() {
    const a = S.asa;
    if (a.busy) return;
    const q = (a.input || '').trim();
    if (!q) { toast('请输入你的问题', 'warn'); return; }
    a.messages.push({ role: 'user', content: q });
    a.input = '';
    a.busy = true;
    renderAsa();
    try {
      // 上下文仅注入本次请求的末条 user 消息（服务端按末条 user 作为提问），
      // 展示历史保持原始问题，避免气泡臃肿；历史多轮照常透传
      const payload = a.messages.slice(0, -1).concat([{ role: 'user', content: buildIdeContext(q) }]);
      const r = await API.post(ASA_CFG.url, { messages: payload });
      a.messages.push({ role: 'assistant', content: (r && r.reply) || '（未返回内容）' });
    } catch (e) {
      a.messages.pop();
      toast('智能助手回答失败：' + e.message, 'warn');
    }
    a.busy = false;
    renderAsa();
  }

  /* ---------------- 运行 ---------------- */
  function currentFiles() {
    syncActiveFile();
    return S.files.map(f => ({ path: f.path, content: f.content || '' }));
  }
  async function runCode() {
    if (S.running) return;
    const files = currentFiles();
    // 输入型程序引导：代码读取 System.in 且输入区未展开时，先展开输入框让用户预置输入，
    // 避免直接运行导致程序阻塞在 Scanner 上直至 10 秒超时强杀
    const joined = files.map(f => f.content || '').join('\n');
    if (/System\s*\.\s*in|new\s+Scanner/.test(joined) && !S.layout.stdinOn) {
      S.layout.stdinOn = true;
      S.bottomTab = 'output';
      S.layout.bottomOn = true;
      applyLayout(); renderBottom();
      toast('检测到程序读取标准输入：请在「程序输入」框预置数据后再次运行', 'warn');
      return;
    }
    S.running = true;
    renderToolbar();
    S.bottomTab = 'output';
    S.layout.bottomOn = true;
    applyLayout(); renderBottom();
    const stdinLines = (S.stdin || '').trim() ? String(S.stdin).split('\n').length : 0;
    out('> javac -encoding UTF-8 ' + files.map(f => f.path).join(' '), 'out-cmd');
    const t0 = performance.now();
    try {
      const r = await API.post('/projects/mine/' + S.spId + '/run',
        { files: files, stdin: (S.stdin || '').trim() ? S.stdin : null }, 60000);
      const ms = Math.round(performance.now() - t0);
      // 捕获运行结果供智能助手上下文使用（最近编译诊断 / 运行退出码）
      if (r.stage === 'COMPILE') {
        S.lastErrors = r.output || '';
        S.lastRunExit = null;
      } else if (r.stage === 'RUN') {
        S.lastRunExit = r.exitCode;
        S.lastErrors = r.ok ? null : (r.output || '');
      }
      if (r.stage === 'ENTRY') {
        out(r.output, 'out-err');
      } else if (r.stage === 'COMPILE') {
        String(r.output || '').split('\n').forEach(l => out(l, 'out-err'));
        out('编译未通过（语法校验失败）· 请根据上方诊断修复代码', 'out-err');
      } else {
        out('编译通过 · 入口类 ' + r.mainClass, 'out-ok');
        out('> java -Dfile.encoding=UTF-8 ' + r.mainClass + (stdinLines ? ' （已附带 ' + stdinLines + ' 行预置输入）' : ''), 'out-cmd');
        if (r.output) String(r.output).split('\n').forEach(l => out(l, r.ok ? 'out-run' : 'out-err'));
        out(r.timeout ? '进程已强制终止 · 耗时 ' + ms + 'ms'
          : '进程已结束，退出代码 ' + r.exitCode + ' · 耗时 ' + ms + 'ms', 'out-hint');
      }
    } catch (e) {
      out('运行失败：' + e.message, 'out-err');
    } finally {
      S.running = false;
      renderToolbar();
    }
  }

  /* ---------------- 保存 / 提交 ---------------- */
  async function save(submit) {
    if (S.saving || S.running) return;
    const summary = ($('#noteInput').value || '').trim();
    S.saving = true;
    renderToolbar();
    try {
      const r = await API.post('/projects/mine/' + S.spId + '/save',
        { files: currentFiles(), summary: summary, submit: submit });
      S.dirty = false;
      $('#noteInput').value = '';
      // 刷新版本记录与状态徽章
      const fresh = await API.get('/projects/mine/' + S.spId);
      S.mine = fresh.mine; S.versions = fresh.versions || [];
      renderToolbar(); renderTabs(); renderStatus();
      if (S.bottomTab === 'versions') renderBottom();
      toast(submit ? '已提交（v' + r.versionCount + '），教师可实时查看'
        : '已保存并自动生成新版本 v' + r.versionCount, 'ok');
    } catch (e) {
      toast(e.message, 'warn');
    } finally {
      S.saving = false;
      renderToolbar();
    }
  }

  /* ---------------- 事件绑定 ---------------- */
  function bindEvents() {
    $('#btnBack').addEventListener('click', () => {
      if (S.dirty && !confirm('代码尚未保存，返回将丢失未保存的修改，确定返回吗？')) return;
      // 直达「项目代码」板块并定位到当前项目：#projects 锚点 + ?p= 项目 ID
      // （index 启动时读取锚点设置板块、读取 p 预选项目，不再落回默认的「学习会话」）
      const p = S.project ? '?p=' + S.project.id + '#projects' : '#projects';
      location.href = 'index.html' + p;
    });
    $('#btnRun').addEventListener('click', runCode);
    $('#btnSave').addEventListener('click', () => save(false));
    $('#btnSubmit').addEventListener('click', () => save(true));
    $('#btnNewFile').addEventListener('click', addFile);
    $('#newFileInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addFile(); } });
    $('#btnTreeFold').addEventListener('click', () => { S.layout.treeOn = !S.layout.treeOn; applyLayout(); persistLayout(); });
    $('#btnBottomFold').addEventListener('click', () => { S.layout.bottomOn = !S.layout.bottomOn; applyLayout(); persistLayout(); });
    $('#btnClearOut').addEventListener('click', () => { S.output = []; renderBottom(); });
    // 程序输入：展开/收起 + 内容暂存（运行时随请求提交）
    $('#btnStdin').addEventListener('click', () => {
      S.layout.stdinOn = !S.layout.stdinOn;
      applyLayout(); renderBottom(); persistLayout();
    });
    $('#bottomBody').addEventListener('input', e => {
      if (e.target.id === 'stdinTa') S.stdin = e.target.value;
    });
    document.querySelectorAll('.ide-btab').forEach(b => b.addEventListener('click', () => {
      S.bottomTab = b.dataset.btab;
      if (!S.layout.bottomOn) { S.layout.bottomOn = true; applyLayout(); persistLayout(); }
      renderBottom();
    }));
    // 文件树：项目项打开 / 删除（事件委托，删除优先于切换）
    $('#treeBody').addEventListener('click', e => {
      const del = e.target.closest('[data-del]');
      if (del) { e.stopPropagation(); delFile(del.dataset.del); return; }
      const item = e.target.closest('[data-file]');
      if (item) openFile(item.dataset.file);
    });
    // 标签页：关闭与切换
    $('#tabBar').addEventListener('click', e => {
      const close = e.target.closest('[data-tabclose]');
      if (close) { e.stopPropagation(); closeTab(close.dataset.tabclose); return; }
      const tab = e.target.closest('[data-tab]');
      if (tab) openFile(tab.dataset.tab);
    });
    // 分栏拖拽：基准值在拖拽开始时快照（onMove 第三个参数），增量不累积
    dragify($('#vsplit'), (dx, dy, start) => {
      if (start.v == null) start.v = S.layout.treeW;
      S.layout.treeW = Math.max(160, Math.min(460, start.v + dx));
      $('#treePanel').style.width = S.layout.treeW + 'px';
    });
    dragify($('#hsplit'), (dx, dy, start) => {
      if (start.v == null) start.v = S.layout.bottomH;
      const max = Math.max(140, Math.floor(window.innerHeight * 0.6));
      S.layout.bottomH = Math.max(120, Math.min(max, start.v - dy));
      $('#bottomPanel').style.height = S.layout.bottomH + 'px';
    });
    // 快捷键：Ctrl+S 保存 / Shift+F10 运行
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        save(false);
      }
      if (e.shiftKey && e.key === 'F10') {
        e.preventDefault();
        runCode();
      }
    });
    // 智能助手：折叠/展开、新对话、快捷建议、发送（委托到面板，收起态 rail 同样可点）
    $('#asaPanel').addEventListener('click', e => {
      if (e.target.closest('#btnAsaToggle')) {
        S.layout.asaOn = !S.layout.asaOn;
        renderAsa();
        persistLayout();
        return;
      }
      if (e.target.closest('#btnAsaNew')) {
        if (S.asa.busy) { toast('正在回答中，请稍候', 'warn'); return; }
        S.asa.messages = [];
        S.asa.input = '';
        renderAsa();
        return;
      }
      if (e.target.closest('#btnAsaSend')) { asaSend(); return; }
      const chip = e.target.closest('[data-asaquick]');
      if (chip) {
        if (S.asa.busy) return;
        S.asa.input = chip.dataset.asaquick || '';
        renderAsa();
        const t = $('#asaInput');
        if (t) { t.focus(); t.selectionStart = t.value.length; }
      }
    });
    $('#asaPanel').addEventListener('input', e => {
      if (e.target.id === 'asaInput') { S.asa.input = e.target.value; autoGrow(e.target); }
    });
    // Enter 发送 / Shift+Enter 换行（与 index 页一致）
    $('#asaPanel').addEventListener('keydown', e => {
      if (e.target.id === 'asaInput' && e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        asaSend();
      }
    });
    // 未保存离开提醒（含刷新/关闭标签页）
    window.addEventListener('beforeunload', e => {
      if (S.dirty) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  /* ---------------- 初始化 ---------------- */
  let CE_SYNC = null;
  async function init() {
    if (!S.spId) { location.href = 'index.html'; return; }
    renderShell();
    bindEvents();
    applyLayout();
    renderBottom();
    try {
      const r = await API.get('/projects/mine/' + S.spId);
      S.project = r.project;
      S.mine = r.mine;
      S.versions = r.versions || [];
      S.files = (S.mine.lastFiles && S.mine.lastFiles.length)
        ? S.mine.lastFiles.map(f => ({ path: f.path, content: f.content || '' }))
        : [{ path: 'Main.java', content: '' }];
      CE_SYNC = attachEditor();
      S.tabs = [S.files[0].path];
      openFile(S.files[0].path);
      renderToolbar();
      renderAsa();
    } catch (e) {
      $('#ide').innerHTML = '<div class="ide-splash">' + h(e.message) + '<br><br><button class="ide-tb-btn primary" style="height:32px;padding:0 18px" onclick="location.href=\'index.html\'">返回项目列表</button></div>';
    }
  }
  init();
})();
