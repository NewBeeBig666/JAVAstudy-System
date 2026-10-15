/* ===========================================================
 * Java 学习智能体 · 单页 Demo 主逻辑
 * 纯前端：所有状态保存在运行时副本 DB 中，刷新即还原
 * =========================================================== */
(function () {
  'use strict';

  /* ---------------- 基础工具 ---------------- */
  const MOCK = window.MOCK;
  let DB;

  /* 初始化空 DB：静态展示数据（agents/快捷指令/片段）仍来自 mock-data.js */
  function initDB(me) {
    DB = {
      me: me || {},
      agents: MOCK.agents,
      quickPrompts: MOCK.quickPrompts,
      snippets: MOCK.snippets,
      modules: [],
      knowledgePoints: [],
      sessions: [],
      student: null,
      exerciseRecords: [],
      assignments: [],
      submissions: [],
      classes: [],
      students: [],
      warnings: [],
      classStuckPoints: [],
      teacherDash: null,
      notifications: [],
      llmMock: null
    };
  }
  // 脚本加载即初始化（boot 首次渲染前 DB 必须存在）
  initDB(window.Auth ? Auth.user() : null);

  const $ = (s, r) => (r || document).querySelector(s);
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const uid = () => Math.random().toString(36).slice(2, 9);
  const h = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function now() {
    const d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function today() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /* ---------------- Markdown 渲染（Agent 回复）：标题层级 / 有序无序列表 / 表格 / 代码块高亮 / 行内样式 ---------------- */
  // 简易 Java 语法高亮：注释 / 字符串 / 关键字 / 数字（输入须已 HTML 转义）
  function hlJava(code) {
    const slots = [];
    let src = code
      .replace(/(\/\/[^\n]*)/g, (m) => { slots.push('<span class="md-com">' + m + '</span>'); return '\u0001' + (slots.length - 1) + '\u0001'; })
      .replace(/(&quot;[^&\n]*?&quot;|&#39;[^&\n]*?&#39;)/g, (m) => { slots.push('<span class="md-str">' + m + '</span>'); return '\u0001' + (slots.length - 1) + '\u0001'; });
    const KW = 'abstract|assert|boolean|break|byte|case|catch|char|class|const|continue|default|do|double|else|enum|extends|final|finally|float|for|if|implements|import|instanceof|int|interface|long|native|new|package|private|protected|public|return|short|static|strictfp|super|switch|synchronized|this|throw|throws|transient|try|void|volatile|while|true|false|null|String|System|var';
    // 按占位符分段，只对非占位符片段做关键字/数字高亮：
    // 否则数字高亮会把占位符里的序号（\u0001N\u0001）也包上 span，导致还原正则匹配失败、注释/字符串高亮泄漏
    const kwRe = new RegExp('\\b(' + KW + ')\\b', 'g');
    const numRe = /\b(\d+(?:\.\d+)?[LlDdFf]?)\b/g;
    src = src.split(/(\u0001\d+\u0001)/).map(seg =>
      /^\u0001\d+\u0001$/.test(seg) ? seg
        : seg.replace(kwRe, '<span class="md-kw">$1</span>').replace(numRe, '<span class="md-num">$1</span>')
    ).join('');
    return src.replace(/\u0001(\d+)\u0001/g, (m, i) => slots[Number(i)]);
  }

  function md(t) {
    // 1) 先提取代码块（内容已随 h(t) 整体转义），避免被行内/列表规则污染
    const blocks = [];
    let src = h(t).replace(/```(\w+)?\n?([\s\S]*?)```/g, (m, lang, code) => {
      blocks.push('<pre class="code-block cb md-code"' + (lang ? ' data-lang="' + h(lang) + '"' : '') + '>' +
        hlJava(code.replace(/\n$/, '')) + '</pre>');
      return '\u0002B' + (blocks.length - 1) + '\u0002';
    });
    // 2) 行内样式
    src = src
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s（(【])\*([^*\n]+)\*(?=[\s，。；)）】，、]|$)/g, '$1<em>$2</em>');
    // 3) 逐行解析：标题 / 列表（两级缩进）/ 表格 / 段落
    const lines = src.split('\n');
    const out = [];
    let listTag = null;          // 'ul' | 'ol'
    let tableRows = null;        // 连续表格行累积
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
      if ((m = l.match(/^(#{1,4})\s+(.+)$/))) {
        closeList(); closeTable();
        out.push('<div class="md-h md-h' + m[1].length + '">' + m[2] + '</div>');
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(l)) {
        closeList();
        tableRows = tableRows || [];
        tableRows.push(l);
        continue;
      }
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
      out.push('<p class="md-p">' + l + '</p>');
    }
    closeList(); closeTable();
    return out.join('');
  }

  /* ---------------- 图标 ---------------- */
  const ICONS = {
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    chart: '<path d="M3 3v18h18"/><rect x="7" y="11" width="3" height="6"/><rect x="12" y="7" width="3" height="10"/><rect x="17" y="13" width="3" height="4"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    checkcircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/>',
    alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    play: '<path d="m5 3 14 9-14 9z"/>',
    send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
    refresh: '<path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    chevronR: '<path d="m9 18 6-6-6-6"/>',
    chevronL: '<path d="m15 18-6-6 6-6"/>',
    chevronD: '<path d="m6 9 6 6 6-6"/>',
    flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
    sparkles: '<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    layers: '<path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
    panel: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>',
    menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    route: '<circle cx="6" cy="19" r="3"/><circle cx="6" cy="5" r="3"/><circle cx="18" cy="19" r="3"/><path d="M9 19h5a2 2 0 0 0 2-2V7"/><path d="M9 5h3a2 2 0 0 1 2 2v3"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
    dots: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>'
  };
  const icon = (n, s, c) => '<svg class="ico ' + (c || '') + '" width="' + (s || 18) + '" height="' + (s || 18) +
    '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    (ICONS[n] || '') + '</svg>';

  /* ---------------- 全局状态 ---------------- */
  const State = {
    role: 'student',
    section: 'chat',
    sessionId: 'se-1',
    rightOpen: true,
    rightTab: 'knowledge',
    loading: false,
    booting: true,
    draft: '',
    focusComposer: false,
    scrollBottom: false,
    chatScrollTop: 0,
    activeKp: 'concurrent',
    activeStudent: null,
    modal: null,
    drawer: null,
    compose: null,
    answer: null,
    grading: null,
    gradingDrafts: {},
    quizReply: {},
    quizDone: {},
    insight: null,
    filters: { hw: 'all', warn: 'all', subAs: 'as-2', exKp: 'all', classId: 'c1', report: 'overview' },
    search: ''
  };

  const NAV = {
    student: [
      { key: 'chat', label: '学习会话', icon: 'chat' },
      { key: 'knowledge', label: '知识图谱', icon: 'target' },
      { key: 'homework', label: '我的作业', icon: 'clipboard' },
      { key: 'exercise', label: '练习记录', icon: 'book' },
      { key: 'report', label: '画像与报告', icon: 'chart' }
    ],
    teacher: [
      { key: 'dashboard', label: '学情看板', icon: 'grid' },
      { key: 'assignments', label: '作业管理', icon: 'clipboard' },
      { key: 'submissions', label: '提交批改', icon: 'check' },
      { key: 'warnings', label: '预警中心', icon: 'alert' },
      { key: 'students', label: '班级学生', icon: 'users' }
    ]
  };

  /* ---------------- 数据访问 ---------------- */
  const kp = id => DB.knowledgePoints.find(k => k.id === id) || { id, name: id, mastery: 0, deps: [], desc: '' };
  const kpName = id => kp(id).name;
  const getEx = id => (DB.exercises || []).find(e => String(e.id) === String(id));
  const session = () => DB.sessions.find(s => s.id === State.sessionId) || null;
  const mcls = v => (v >= 80 ? 'm3' : v >= 60 ? 'm2' : v >= 40 ? 'm1' : 'm0');
  const bcls = v => (v >= 80 ? 'ok' : v >= 60 ? '' : v >= 40 ? 'warn' : 'danger');
  const mtext = v => (v >= 80 ? '掌握良好' : v >= 60 ? '基本掌握' : v >= 40 ? '薄弱' : '严重薄弱');

  function setMastery(id, value) {
    const k = DB.knowledgePoints.find(x => x.id === id);
    if (k) k.mastery = value;
    if (DB.student && DB.knowledgePoints.length) {
      DB.student.avgMastery = Math.round(DB.knowledgePoints.reduce((a, b) => a + b.mastery, 0) / DB.knowledgePoints.length);
    }
  }

  function homeworkStatusOf(asId) {
    const a = DB.assignments.find(x => x.id === asId);
    const sub = a ? a.mySubmission : null;
    if (!sub || sub.status === 'missing') return { key: 'todo', label: '待提交', cls: 'warn' };
    if (sub.status === 'graded') return { key: 'graded', label: '已批改', cls: 'ok' };
    return { key: 'pending', label: '待批改', cls: 'info' };
  }
  const subOf = asId => { const a = DB.assignments.find(x => x.id === asId); return a ? a.mySubmission : null; };
  const unread = () => DB.notifications.filter(n => !n.readFlag).length;

  function toast(msg, type) {
    const box = $('#toasts');
    if (!box) return;
    const d = document.createElement('div');
    d.className = 'toast' + (type === 'ok' ? ' ok' : '');
    d.innerHTML = icon(type === 'ok' ? 'checkcircle' : 'bell', 16) + '<span>' + h(msg) + '</span>';
    box.appendChild(d);
    setTimeout(() => { d.style.opacity = '0'; d.style.transition = '.25s'; }, 2400);
    setTimeout(() => d.remove(), 2700);
  }

  /* ===========================================================
   *  渲染：顶栏 / Activity Bar / 左侧面板
   * =========================================================== */
  function renderTopbar() {
    const st = State.role === 'student';
    return `
      ${State.role === 'student' && State.section === 'knowledge' ? '' : `<button class="icon-btn mobile-only" data-act="toggleSide" title="功能面板">${icon('menu', 18)}</button>`}
      <div class="brand">
        <div class="brand-mark">${icon('sparkles', 17)}</div>
        <div>
          <div class="brand-name">Java 学习智能体</div>
          <div class="brand-sub">${st ? h(DB.me.className || '软件工程') : '教师工作台'}</div>
        </div>
      </div>
      <div class="role-switch">
        <span class="user-chip">${icon('user', 15)} ${h(DB.me.realName || '')} · ${st ? '学生' : '教师'}</span>
      </div>
      <div class="topbar-spacer"></div>
      <div class="top-meta">
        <button class="fb-chip" data-act="${st ? 'openFeedback' : 'openFeedbackList'}" title="${st ? '提交你的建议或问题反馈' : '查看学生提交的建议反馈'}">${icon(st ? 'edit' : 'inbox', 13)} <span class="fb-txt">${st ? '建议反馈' : '查看反馈'}</span></button>
        ${DB.llmMock != null ? `<span class="env-chip">${icon('layers', 12)} ${DB.llmMock ? '离线演示模式' : 'DeepSeek 已接入'}</span>` : ''}
        ${st && unread() ? `<button class="icon-btn" style="position:relative" data-act="gotoHw">${icon('bell', 17)}<span class="act-dot"></span></button>` : ''}
        <button class="icon-btn" data-act="toggleCtx" title="上下文面板">${icon('panel', 17)}</button>
        <button class="icon-btn" data-act="logout" title="退出登录">${icon('x', 17)}</button>
        <button class="icon-btn" data-act="settings" title="设置">${icon('gear', 17)}</button>
      </div>`;
  }

  function renderActivity() {
    const list = NAV[State.role];
    let dot = '';
    if (State.role === 'student' && State.section === 'homework' && unread()) dot = '<span class="act-dot"></span>';
    if (State.role === 'teacher' && State.section === 'warnings') {
      const n = DB.warnings.filter(w => !w.handled).length;
      if (n) dot = '<span class="act-dot"></span>';
    }
    return list.map(n => `
      <button class="act-btn ${State.section === n.key ? 'on' : ''}" data-act="section" data-val="${n.key}" title="${n.label}">
        ${icon(n.icon, 19)}<span class="act-label">${h(n.label)}</span>${State.section === n.key ? dot : ''}
      </button>`).join('') +
      '<div class="act-sep"></div>' +
      `<button class="act-btn ${State.section === 'settings' ? 'on' : ''}" data-act="settings" title="系统设置">${icon('gear', 19)}<span class="act-label">设置</span></button>`;
  }

  function renderSide() {
    const sec = State.section;
    let head = '', body = '', foot = '';

    if (sec === 'chat') {
      head = `<div class="side-head"><div class="side-title">学习会话</div>
        <div class="side-tools">
          <button class="icon-btn" data-act="newSession" title="新建会话">${icon('plus', 16)}</button>
          <button class="icon-btn" data-act="clearSessions" title="清空全部对话">${icon('trash', 16)}</button>
        </div></div>`;
      foot = `<button class="btn primary block" data-act="newSession">${icon('plus', 15)} 新建学习会话</button>`;
      const act = DB.sessions.filter(s => s.status === 'active');
      const done = DB.sessions.filter(s => s.status === 'done');
      body =
        (act.length ? '<div class="side-group">进行中 · ' + act.length + '</div>' + act.map(sItem).join('') : '') +
        (done.length ? '<div class="side-group">已完成 · ' + done.length + '</div>' + done.map(sItem).join('') : '') +
        (!DB.sessions.length ? '<div class="empty" style="padding:28px 12px"><div class="empty-ico">' + icon('chat', 22) + '</div><div class="empty-title">还没有会话</div><div class="empty-desc">点击左下角「新建学习会话」，选一个 Java 知识点开始。</div></div>' : '');

    } else if (sec === 'homework') {
      head = '<div class="side-head"><div class="side-title">我的作业</div></div>';
      const f = [['all', '全部'], ['todo', '待提交'], ['pending', '待批改'], ['graded', '已批改']];
      body = '<div style="display:flex;flex-wrap:wrap;gap:6px;padding:2px 6px 10px">' +
        f.map(x => `<button class="chip ${State.filters.hw === x[0] ? 'on' : ''}" data-act="hwFilter" data-val="${x[0]}">${x[1]}</button>`).join('') +
        '</div>' + DB.assignments.filter(a => a.status !== 'draft').map(a => {
          const st = homeworkStatusOf(a.id);
          return `<button class="list-item ${State.focusHwId === a.id ? 'on' : ''}" data-act="focusHw" data-val="${a.id}">
            <div class="li-main"><div class="li-title">${h(a.title)}</div>
            <div class="li-sub">截止 ${h(a.due)}</div></div>
            <div class="li-extra"><span class="badge ${st.cls}">${st.label}</span></div></button>`;
        }).join('');

    } else if (sec === 'exercise') {
      head = '<div class="side-head"><div class="side-title">练习记录 · 按知识点</div></div>';
      body = `<button class="list-item ${State.filters.exKp === 'all' ? 'on' : ''}" data-act="exFilter" data-val="all">
          <div class="li-main"><div class="li-title">全部记录</div><div class="li-sub">${DB.exerciseRecords.length} 条</div></div></button>` +
        DB.knowledgePoints.map(k => {
          const n = DB.exerciseRecords.filter(r => r.kp === k.id).length;
          return `<button class="list-item ${State.filters.exKp === k.id ? 'on' : ''}" data-act="exFilter" data-val="${k.id}">
            <div class="li-main"><div class="li-title">${k.name}</div><div class="li-sub">${n} 条记录 · 掌握度 ${k.mastery}</div></div></button>`;
        }).join('');

    } else if (sec === 'report') {
      head = '<div class="side-head"><div class="side-title">画像与报告</div></div>';
      const items = [['overview', '学习概览', 'flame'], ['mastery', '掌握度报告', 'chart'], ['wrong', '错题本', 'file'], ['review', '复习队列', 'clock']];
      body = items.map(i => `<button class="list-item ${State.filters.report === i[0] ? 'on' : ''}" data-act="reportTab" data-val="${i[0]}">
        <div class="li-main"><div class="li-title">${i[1]}</div></div></button>`).join('');

    } else if (sec === 'dashboard') {
      head = '<div class="side-head"><div class="side-title">授课班级</div></div>';
      foot = '<button class="btn primary block" data-act="importClassModal">' + icon('plus', 15) + ' 添加班级</button>';
      body = DB.classes.map(c => `<button class="list-item ${State.filters.classId === c.id ? 'on' : ''}" data-act="classPick" data-val="${c.id}">
        <div class="li-main"><div class="li-title">${c.name}</div><div class="li-sub">${DB.students.length} 名在读学生</div></div>
      </button>`).join('');

    } else if (sec === 'assignments' || sec === 'submissions') {
      head = '<div class="side-head"><div class="side-title">' + (sec === 'assignments' ? '作业管理' : '选择作业') + '</div></div>';
      foot = sec === 'assignments'
        ? '<button class="btn primary block" data-act="openCompose">' + icon('plus', 15) + ' 发布新作业</button>'
        : '';
      body = DB.assignments.map(a => {
        const pend = DB.submissions.filter(s => s.asId === a.id && s.status === 'pending').length;
        return `<button class="list-item ${State.filters.subAs === a.id && sec === 'submissions' ? 'on' : ''}" data-act="subAsPick" data-val="${a.id}">
          <div class="li-main"><div class="li-title">${h(a.title)}</div>
          <div class="li-sub">${a.status === 'draft' ? '草稿' : '截止 ' + h(a.due)} · 已交 ${a.submitted}/${a.total}</div></div>
          ${pend ? '<div class="li-extra"><span class="badge warn">' + pend + ' 待批</span></div>' : ''}
        </button>`;
      }).join('');

    } else if (sec === 'warnings') {
      head = '<div class="side-head"><div class="side-title">预警类型</div></div>';
      const f = [['all', '全部'], ['high', '高危'], ['mid', '中风险'], ['handled', '已处理']];
      body = '<div style="display:flex;flex-wrap:wrap;gap:6px;padding:2px 6px 10px">' +
        f.map(x => `<button class="chip ${State.filters.warn === x[0] ? 'on' : ''}" data-act="warnFilter" data-val="${x[0]}">${x[1]}</button>`).join('') +
        '</div>';
      const types = ['连续未登录', '提交次数骤降', '卡点知识点', '非正常时段提交', '代码相似度异常', '班级共性卡点'];
      body += types.map(t => {
        const n = DB.warnings.filter(w => w.type === t && !w.handled).length;
        return `<button class="list-item"><div class="li-main"><div class="li-title">${t}</div><div class="li-sub">${n} 条待处理</div></div>
          ${n ? '<div class="li-extra"><span class="badge ' + (n > 1 ? 'danger' : 'warn') + '">' + n + '</span></div>' : ''}</button>`;
      }).join('');

    } else if (sec === 'students') {
      head = '<div class="side-head"><div class="side-title">班级学生</div></div>';
      body = DB.students.map(s => `<button class="list-item ${State.activeStudent === s.id ? 'on' : ''}" data-act="studentPick" data-val="${s.id}">
        <div class="li-main"><div class="li-title">${s.name}${s.id === 's01' ? ' · 我' : ''}</div>
        <div class="li-sub">掌握度 ${s.mastery} · 提交率 ${s.submitRate}%</div></div>
        <div class="li-extra"><span class="badge ${s.risk === 'high' ? 'danger' : s.risk === 'mid' ? 'warn' : 'ok'}">${s.risk === 'high' ? '高危' : s.risk === 'mid' ? '关注' : '正常'}</span></div>
      </button>`).join('');
    }

    // 列表内容包进 .side-body（flex:1 + overflow-y:auto），使会话/学生等长列表可垂直滚动
    return head + '<div class="side-body">' + body + '</div>' + (foot ? '<div class="side-foot">' + foot + '</div>' : '');
  }

  function sItem(s) {
    const doneN = s.steps.filter(x => x.status === 'done').length;
    return `<button class="list-item ${State.sessionId === s.id ? 'on' : ''}" data-act="session" data-val="${s.id}">
      <div class="li-main">
        <div class="li-title">${h(s.title)}</div>
        <div class="li-sub">${kpName(s.kp)} · 步骤 ${doneN}/${s.steps.length}</div>
      </div>
      <div class="li-extra"><span class="badge ${s.status === 'done' ? 'ok' : 'brand'}">${s.status === 'done' ? '已完成' : '进行中'}</span></div>
    </button>`;
  }

  /* ===========================================================
   *  渲染：主区
   * =========================================================== */
  function renderMain() {
    const box = $('#main');
    const sec = State.section;
    if (State.loading) { box.innerHTML = mainHead('加载中…', '') + '<div class="main-body"><div class="main-inner">' + skeleton() + '</div></div>'; return; }
    if (State.booting) { box.innerHTML = '<div class="main-body"><div class="main-inner">' + skeleton() + '</div></div>'; return; }

    let head = '', body = '';
    if (State.role === 'student') {
      if (sec === 'chat') { const r = viewChat(); head = r.head; body = r.body; }
      else if (sec === 'knowledge') { const r = viewKnowledge(); head = r.head; body = r.body; }
      else if (sec === 'homework') { const r = viewHomework(); head = r.head; body = r.body; }
      else if (sec === 'exercise') { const r = viewExercise(); head = r.head; body = r.body; }
      else if (sec === 'report') { const r = viewReport(); head = r.head; body = r.body; }
    } else {
      if (sec === 'dashboard') { const r = viewDashboard(); head = r.head; body = r.body; }
      else if (sec === 'assignments') { const r = viewAssignments(); head = r.head; body = r.body; }
      else if (sec === 'submissions') { const r = viewSubmissions(); head = r.head; body = r.body; }
      else if (sec === 'warnings') { const r = viewWarnings(); head = r.head; body = r.body; }
      else if (sec === 'students') { const r = viewStudents(); head = r.head; body = r.body; }
    }
    // 知识图谱视图使用加宽容器（kg-inner-wide 解除 980px 上限），配合左侧面板移除后的全宽布局
    const innerCls = (State.role === 'student' && sec === 'knowledge') ? ' class="main-inner kg-inner-wide"' : ' class="main-inner"';
    box.innerHTML = head + '<div class="main-body"><div' + innerCls + '>' + body + '</div></div>';
    afterRender();
  }

  function mainHead(title, sub, actions) {
    return `<div class="main-head">
      <div><div class="mh-title">${title}</div>${sub ? '<div class="mh-sub">' + sub + '</div>' : ''}</div>
      <div class="mh-spacer"></div>
      <div class="mh-actions">${actions || ''}</div>
    </div>`;
  }

  function skeleton() {
    return `<div class="card"><div class="card-body">
      <div class="skel skel-line" style="width:38%"></div>
      <div class="skel skel-line" style="width:82%"></div>
      <div class="skel skel-line" style="width:66%"></div>
      <div class="skel skel-block" style="margin-top:14px"></div>
      <div class="skel skel-block"></div>
    </div></div>`;
  }

  function emptyBox(title, desc, btn) {
    return `<div class="card"><div class="empty">
      <div class="empty-ico">${icon('inbox', 24)}</div>
      <div class="empty-title">${title}</div>
      <div class="empty-desc">${desc}</div>
      ${btn || ''}
    </div></div>`;
  }

  /* ---------------- 学生：对话主面板 ---------------- */
  function viewChat() {
    if (!DB.sessions.length) {
      return {
        head: mainHead('学习会话', '0 个会话'),
        body: emptyBox('还没有学习会话', '新建一个会话，选择你想攻克的 Java 知识点，智能体会先诊断、再规划路径，然后陪你刷题到掌握。',
          '<button class="btn primary" data-act="newSession">' + icon('plus', 15) + ' 新建学习会话</button>')
      };
    }
    const s = session();
    if (!s) {
      return {
        head: mainHead('学习会话', ''),
        body: emptyBox('未选择会话', '在左侧列表中选择一个会话，或新建一个新的学习会话。')
      };
    }
    const doneN = s.steps.filter(x => x.status === 'done').length;
    const head = mainHead(
      h(s.title) + ' ' + (s.status === 'done'
        ? '<span class="badge ok" style="margin-left:6px">' + icon('checkcircle', 12) + ' 已完成</span>'
        : '<span class="badge brand" style="margin-left:6px">进行中</span>'),
      kpName(s.kp) + ' · 步骤 ' + doneN + '/' + s.steps.length + ' · 更新于 ' + s.updatedAt,
      `<button class="btn sm" data-act="replan">${icon('route', 14)} 重新规划</button>
       <button class="btn sm primary" data-act="newSession">${icon('plus', 14)} 新建会话</button>`
    );

    const msgs = s.messages.map(m => { try { return renderMsg(m, s); } catch (e) { return ''; } }).join('');
    const chips = DB.quickPrompts.map(q => `<button class="chip" data-act="quick" data-val="${h(q.text)}">${icon('sparkles', 13)} ${q.label}</button>`).join('');

    const body = `<div class="chat-wrap">
      <div class="chat-scroll" id="chatScroll"><div class="chat-inner">${msgs}</div></div>
      <div class="composer-wrap"><div class="composer-inner">
        <div class="quick-chips">${chips}</div>
        <div class="composer">
          <textarea id="composerInput" rows="1" placeholder="描述你的问题，或让智能体出一道变式题…" data-bind="draft">${h(State.draft)}</textarea>
          <button class="send" data-act="send" title="发送">${icon('send', 16)}</button>
        </div>
        <div class="composer-tip">${icon('flag', 12)} 演示环境：不会直接给出完整作业代码，仅提供三级渐进提示</div>
      </div></div>
    </div>`;
    return { head, body };
  }

  function renderMsg(m, s) {
    if (m.from === 'sys') return `<div class="sys-line"><span class="sys-msg">${h(m.text)}</span></div>`;
    if (m.from === 'user') {
      return `<div class="msg user">
        <div class="avatar student">我</div>
        <div class="msg-col">
          <div class="msg-meta"><b>我</b><span>${m.time || ''}</span></div>
          <div class="bubble">${h(m.text)}</div>
        </div></div>`;
    }
    const ag = DB.agents[m.agent] || { name: '智能体', color: '#4f46e5' };
    const tag = '<span class="agent-tag" style="color:' + ag.color + ';background:' + ag.color + '14">' + ag.name + '</span>';
    if (m.typing) {
      return `<div class="msg">
        <div class="avatar agent" style="background:linear-gradient(135deg,${ag.color},#8b5cf6)">AI</div>
        <div class="msg-col"><div class="msg-meta"><b>${ag.name}</b>${tag}</div>
        <div class="agent-text"><span class="typing"><i></i><i></i><i></i></span></div></div></div>`;
    }
    return `<div class="msg${String(m.id) === String(State.pathPopId || '') ? ' path-pop' : ''}">
      <div class="avatar agent" style="background:linear-gradient(135deg,${ag.color},#8b5cf6)">${ag.name.slice(0, 2)}</div>
      <div class="msg-col">
        <div class="msg-meta"><b>${ag.name}</b>${tag}<span>${m.time || ''}</span></div>
        ${m.text ? '<div class="agent-text">' + md(m.text) + '</div>' : ''}
        ${m.card ? renderCard(m.card, m.id, s) : ''}
        ${(!m.card && m.text && !m.quizHidden) ? quizAnswerBox(m) : ''}
      </div></div>`;
  }

  /* ===========================================================
   * 代码编辑器组件（编程题作答，专业编辑体验，无外部依赖）
   * 结构：透明 textarea（保留 data-bind 原生输入绑定，草稿/状态联动零改动）
   * 叠加在着色层上；外挂行号栏与自动补全弹窗。
   * 能力：实时语法高亮 / 行号 / 自动缩进对齐 / 括号引号自动闭合与跨越 /
   *       智能补全（关键字·类型·方法·代码片段·文档词，含说明与键盘导航）
   * 挂载：页面渲染后由 mountCodeEditors() 统一装饰 textarea[data-code-editor]
   * =========================================================== */
  const CE_INDENT = '    ';
  const CE_PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
  // 顶层候选：关键字 K / 类型 T / 片段 S（t 文本, d 说明, k 类别）
  const CE_TOP = [
    ['public', '访问修饰符 · 公有', 'K'], ['private', '访问修饰符 · 私有', 'K'], ['protected', '访问修饰符 · 受保护', 'K'],
    ['static', '关键字 · 静态成员', 'K'], ['final', '关键字 · 不可变 / 终态', 'K'], ['void', '关键字 · 无返回值', 'K'],
    ['class', '关键字 · 定义类', 'K'], ['interface', '关键字 · 定义接口', 'K'], ['abstract', '关键字 · 抽象', 'K'],
    ['enum', '关键字 · 定义枚举', 'K'], ['extends', '关键字 · 继承父类', 'K'], ['implements', '关键字 · 实现接口', 'K'],
    ['import', '关键字 · 导入类 / 包', 'K'], ['package', '关键字 · 包声明', 'K'],
    ['new', '关键字 · 创建对象', 'K'], ['this', '关键字 · 当前实例', 'K'], ['super', '关键字 · 父类引用', 'K'],
    ['int', '基本类型 · 整型', 'K'], ['long', '基本类型 · 长整型', 'K'], ['double', '基本类型 · 双精度浮点', 'K'],
    ['float', '基本类型 · 单精度浮点', 'K'], ['char', '基本类型 · 字符型', 'K'], ['boolean', '基本类型 · 布尔', 'K'],
    ['byte', '基本类型 · 字节', 'K'], ['short', '基本类型 · 短整型', 'K'], ['var', '关键字 · 局部变量类型推断', 'K'],
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
  // 代码片段模板：| 为补全后光标落点
  const CE_SNIPPETS = {
    sout: 'System.out.println();', sysout: 'System.out.println();',
    psvm: 'public static void main(String[] args) {\n' + CE_INDENT + '|\n' + CE_INDENT + '}',
    main: 'public static void main(String[] args) {\n' + CE_INDENT + '|\n' + CE_INDENT + '}',
    fori: 'for (int i = 0; i < |; i++) {\n' + CE_INDENT + '\n}',
    foreach: 'for (var item : list) {\n' + CE_INDENT + '|\n}',
    tryc: 'try {\n' + CE_INDENT + '|\n} catch (Exception e) {\n' + CE_INDENT + 'e.printStackTrace();\n}'
  };
  // 成员补全：receiver → [名称, 说明]（M 方法补 '()'，T 常量/字段原样）
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
  // 任意 receiver. 之后的通用成员建议
  const CE_GENERIC_MEMBERS = [
    ['toString', '转字符串', 'M'], ['equals', '内容相等比较', 'M'], ['hashCode', '哈希码', 'M'],
    ['size', '元素个数', 'M'], ['length', '长度（数组/字符串）', 'T'], ['isEmpty', '是否为空', 'M'],
    ['get', '取值', 'M'], ['add', '追加', 'M'], ['close', '关闭资源', 'M'], ['next', '下一个元素', 'M']
  ];
  const CE_KW_SET = new Set(CE_TOP.map(x => x[0]));
  // 候选条目防御：条目意外损坏（非数组/首项非字符串）时跳过该条，
  // 避免一条坏数据让整个补全过滤抛错、功能失效
  const ceOkItem = x => Array.isArray(x) && typeof x[0] === 'string';

  // Java 语法高亮（亮色主题 · VS Code Light 配色）：注释 / 字符串 / 数字 / 控制关键字 / 关键字 / 方法调用 / 类型
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

  // 生成代码编辑器 HTML：textarea 保留调用方传入的 data-bind 等属性，原输入联动机制不变
  function codeEditorHtml(attrs, value, opts) {
    opts = opts || {};
    return `<div class="code-editor${opts.ro ? ' ro' : ''}" style="min-height:${opts.minHeight || 140}px">
      <div class="ce-frame">
        <div class="ce-gutter"><div class="ce-gutter-inner"></div></div>
        <div class="ce-area">
          <pre class="ce-hl"><code></code></pre>
          <textarea class="ce-input" data-code-editor="1" spellcheck="false" autocomplete="off" autocapitalize="off" wrap="off"
            placeholder="${h(opts.placeholder || '在此编写代码…')}" ${attrs}${opts.ro ? ' disabled' : ''}>${h(value == null ? '' : String(value))}</textarea>
        </div>
      </div>
    </div>`;
  }

  // 渲染后统一装饰：为尚未挂载的代码 textarea 附加高亮 / 行号 / 补全行为
  function mountCodeEditors() {
    document.querySelectorAll('textarea[data-code-editor]:not([data-ce-mounted])').forEach(ta => {
      ta.dataset.ceMounted = '1';
      ceAttach(ta);
    });
  }

  function ceAttach(ta) {
    const root = ta.closest('.code-editor');
    if (!root) return;
    const frame = root.querySelector('.ce-frame');
    const gutter = root.querySelector('.ce-gutter-inner');
    const hl = root.querySelector('.ce-hl');
    const codeEl = root.querySelector('.ce-hl code');
    const ac = document.createElement('div');
    ac.className = 'ce-ac';
    ac.style.display = 'none';
    root.appendChild(ac);
    const ACS = { items: [], active: -1, start: 0 };
    let ime = false;

    const ceSync = () => {
      const v = ta.value || '';
      codeEl.innerHTML = ceHighlight(v);
      const n = v.split('\n').length;
      let g = '';
      for (let i = 1; i <= Math.max(n, 1); i++) g += '<div>' + i + '</div>';
      gutter.innerHTML = g;
      hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft;
      gutter.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
    };

    const ceDispatch = () => ta.dispatchEvent(new Event('input', { bubbles: true }));
    const ceSet = (text, caret) => {
      ta.value = text;
      ta.selectionStart = ta.selectionEnd = caret == null ? text.length : caret;
      ceSync(); ceDispatch();
    };
    // 光标像素位置（镜像测量，用于定位补全弹窗）
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
      // 显式写 'block'：CSS 中 .ce-ac 默认 display:none，若用 style.display='' 清除内联样式
      // 会回落到样式表的 none，导致弹窗永远不显示
      ac.style.display = 'block';
      // 定位兜底：光标测量异常时弹窗仍显示在编辑器左下角，不因定位失败而整体不可见
      try {
        const p = caretXY();
        const areaX = frame.querySelector('.ce-area').offsetLeft;
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
    // 计算当前输入前缀的候选列表
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
        // ctx 以 '.' 结尾：receiver 检测正则必须包含结尾的点，否则词典永远选不中
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
        // 文档词：当前代码中已出现的标识符（变量 / 自定义方法）
        // 注意：items 元素已被映射为对象 {t,d,k}，判重须取 x.t（此前误取 x[0] 导致 toLowerCase 抛错、补全整体失效）
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

    ta.addEventListener('input', () => { ceSync(); if (!ta.disabled) acUpdate(); });
    ta.addEventListener('scroll', () => {
      hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft;
      gutter.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
      if (ac.style.display !== 'none') acRender();
    });
    ta.addEventListener('compositionstart', () => { ime = true; acClose(); });
    ta.addEventListener('compositionend', () => { ime = false; ceSync(); });
    ta.addEventListener('blur', () => setTimeout(acClose, 120));
    ac.addEventListener('mousedown', e => {
      const item = e.target.closest('.ce-ac-item');
      e.preventDefault();
      if (item) acAccept(Number(item.dataset.i));
    });
    ta.addEventListener('keydown', e => {
      if (ta.disabled) return;
      const open = ac.style.display !== 'none' && ACS.items.length;
      // 补全弹窗打开时的键盘导航：上下选择 / 回车与 Tab 补全 / Esc 关闭
      if (open && !ime) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          ACS.active = (ACS.active + 1) % ACS.items.length;
          acRender(); return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          ACS.active = (ACS.active - 1 + ACS.items.length) % ACS.items.length;
          acRender(); return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          acAccept(ACS.active); return;
        }
        if (e.key === 'Escape') { e.preventDefault(); acClose(); return; }
      }
      if (ime) return;
      const pos = ta.selectionStart, s0 = ta.selectionEnd;
      const val = ta.value;
      const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
      const indent = (val.slice(lineStart, pos).match(/^[ \t]*/) || [''])[0];
      // 回车：自动缩进对齐；行尾为 { 且下一字符为 } 时展开代码块
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
      // Tab：补全确认（上方已处理）/ 插入缩进
      if (e.key === 'Tab') {
        e.preventDefault();
        ceSet(val.slice(0, pos) + CE_INDENT + val.slice(s0), pos + CE_INDENT.length);
        return;
      }
      // Ctrl+Space：手动唤起补全
      if (e.key === ' ' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        acUpdate();
        if (!ACS.items.length && !/([A-Za-z_$][\w$]*)$/.test(ta.value.slice(0, pos))) {
          ACS.items = CE_TOP.slice(0, 9).map(x => ({ t: x[0], d: x[1], k: x[2] }));
          ACS.active = 0; ACS.start = pos; acRender();
        }
        return;
      }
      // 括号 / 引号自动闭合（选中文本时包裹）
      if (CE_PAIRS[e.key]) {
        const next = val.slice(s0, s0 + 1);
        if (pos !== s0) {
          e.preventDefault();
          ceSet(val.slice(0, pos) + e.key + CE_PAIRS[e.key] + val.slice(s0), pos + 1);
          return;
        }
        if (next === '' || /[\s)\]}:;"'@.,]/.test(next)) {
          e.preventDefault();
          ceSet(val.slice(0, pos) + e.key + CE_PAIRS[e.key] + val.slice(s0), pos + 1);
          return;
        }
      }
      // 闭合符跨越：已存在同名闭合符时仅移动光标
      if (e.key === ')' || e.key === ']' || e.key === '}' || e.key === '"' || e.key === "'") {
        if (val.slice(s0, s0 + 1) === e.key && pos === s0) {
          e.preventDefault();
          ta.selectionStart = ta.selectionEnd = pos + 1;
          return;
        }
      }
      // Backspace：空括号对整体删除
      if (e.key === 'Backspace' && pos === s0 && pos > 0) {
        const prev = val.slice(pos - 1, pos), next = val.slice(pos, pos + 1);
        if (CE_PAIRS[prev] && CE_PAIRS[prev] === next) {
          e.preventDefault();
          ceSet(val.slice(0, pos - 1) + val.slice(pos + 1), pos - 1);
          return;
        }
      }
    });
    ceSync();
  }

  /* Agent Markdown 生成题目的作答框：按题目关键词适配题型（编程/填空/判断/简答），
     提交后作为用户消息发送，由 Agent 在对话中点评。仅识别非选择题（选择题已有卡片交互）。 */
  // 该题是否已在对话中提交过作答（从服务端消息推导：题面消息之后出现「我的作答」用户消息），
  // 刷新页面后仍能保持隐藏，避免重复作答
  function quizAnswered(m) {
    const s = session();
    if (!s || !s.messages) return false;
    const i = s.messages.findIndex(x => String(x.id) === String(m.id));
    return i >= 0 && s.messages.slice(i + 1).some(x => x.from === 'user' && /^我的作答/.test((x.text || '').trim()));
  }
  function quizAnswerBox(m) {
    const text = m.text || '';
    const hasChoice = /单选|多选|以下(哪|正确)?:?\s*[（(]/.test(text) && /A[.、]\s/.test(text);
    // 门控：只对「题目」类消息挂作答框；题目特征须出现在开头 150 字内，
    // 且排除点评/解析类反馈消息（点评里常复述题型词，会误判）
    const head = (text || '').trim().slice(0, 150);
    const isQuestion = (/题目[：:]|出一道|来一道|练一道|练习题|作答要求|编程题|填空题|判断题|简答题|问答题|请完成|请实现|请编写|请回答/.test(head))
      && !/✅|⚠️/.test(head) && !/^(点评|解析|批改|答案)/.test(head);
    if (!isQuestion || hasChoice) return '';
    const isCode = /编程题|代码题|实现(一个|以下|这个|上述|如上)|编写(一个|代码|方法|类)|写出(代码|一个)|补全|void\s+\w+\s*\(|public\s+class|@Override|static\s+(void|int)\s+main/.test(text);
    const isFill = /填空题|填空|____/.test(text);
    const isJudge = /判断题|判断.{0,6}(正确|对错|是否)/.test(text);
    const isShort = /简答题|简答|简述|请说明|请解释|谈谈/.test(text);
    // 显式题型字样优先（判断/填空/简答题面常含代码片段，不能让代码特征抢先），
    // 无显式题型词时再按内容特征回退
    const explicit = /编程题/.test(text) ? 'code' : /填空题/.test(text) ? 'fill'
      : /判断题/.test(text) ? 'judge' : /简答题|问答题/.test(text) ? 'short' : null;
    const kind = explicit || (isCode ? 'code' : isFill ? 'fill' : isJudge ? 'judge' : isShort ? 'short' : null);
    if (!kind) return '';
    if ((State.quizDone || {})[m.id] || quizAnswered(m)) return '';
    State.quizReply = State.quizReply || {};
    const saved = State.quizReply[m.id] || '';
    let input = '';
    if (kind === 'judge') {
      input = `<div style="display:flex;gap:10px">
        ${['正确', '错误'].map((x, i) => `<button class="btn ${saved === x ? 'primary' : ''}" data-act="quizPick" data-id="${m.id}" data-val="${x}">${x}</button>`).join('')}
      </div>`;
    } else if (kind === 'fill') {
      input = `<input class="input" placeholder="填写你的答案" value="${h(saved)}" data-bind="quizReply" data-id="${m.id}">`;
    } else if (kind === 'code') {
      input = codeEditorHtml(`data-bind="quizReply" data-id="${m.id}"`, saved, { minHeight: 140, placeholder: '在此编写你的代码…' });
    } else {
      input = `<textarea class="textarea" style="min-height:90px" placeholder="在此输入你的答案…" data-bind="quizReply" data-id="${m.id}">${h(saved)}</textarea>`;
    }
    return `<div class="quiz-ans">
      <div style="font-size:12px;font-weight:600;margin-bottom:8px">${icon('edit', 13)} 在此作答${kind === 'code' ? '（支持直接编写代码）' : ''}，提交后智能体会点评你的答案</div>
      ${input}
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn sm primary" data-act="quizSubmit" data-id="${m.id}" ${kind === 'judge' ? (saved ? '' : 'disabled') : (saved.trim ? saved.trim() : saved) ? '' : 'disabled'}>提交作答</button>
      </div>
    </div>`;
  }

  function renderCard(c, msgId, s) {
    if (c.type === 'diagnosis') {
      const rows = c.items.map(i => `<div class="mini-row">
        <span class="nm">${kpName(i.kp)}</span>
        <div class="bar ${bcls(i.mastery)}"><i style="width:${i.mastery}%"></i></div>
        <span class="vl">${i.mastery}</span></div>
        <div style="font-size:11.5px;color:var(--text-3);margin:-2px 0 6px 118px">${h(i.note)}</div>`).join('');
      return `<div class="work">
        <div class="work-head">${icon('target', 15)}<span class="wt">诊断结果 · 依赖链溯源</span><div class="spacer"></div><span class="badge purple">诊断Agent</span></div>
        <div class="work-body"><div class="mini-list">${rows}</div>
          <div class="note" style="margin-top:10px">${h(c.conclusion)}</div></div>
      </div>`;
    }
    if (c.type === 'path') {
      const st = s || session();
      const done = st.steps.filter(x => x.status === 'done').length;
      const pct = Math.round(done / st.steps.length * 100);
      const steps = st.steps.map((x, i) => `<div class="step ${x.status}" data-act="stepClick" data-val="${i}">
        <div class="step-idx">${x.status === 'done' ? icon('check', 13) : i + 1}</div>
        <div class="step-main"><div class="step-title">${h(x.title)}</div><div class="step-desc">${h(x.desc)}</div></div>
        <div class="step-side"><span>${x.dur}</span><span class="badge ${x.status === 'done' ? 'ok' : x.status === 'active' ? 'brand' : ''}">${x.status === 'done' ? '已完成' : x.status === 'active' ? '进行中' : '待开始'}</span></div>
      </div>`).join('');
      return `<div class="work">
        <div class="work-head">${icon('route', 15)}<span class="wt">个性化学习路径 · ${kpName(st.kp)}</span><div class="spacer"></div><span class="badge brand">规划Agent</span></div>
        <div class="work-body">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
            <div class="bar ${bcls(pct * 1.0)}" style="flex:1"><i style="width:${pct}%"></i></div>
            <span style="font-size:12.5px;font-weight:600">${done}/${st.steps.length}</span></div>
          <div class="step-list">${steps}</div>
        </div>
        <div class="work-foot">
          <button class="btn sm primary" data-act="doStep">${icon('play', 14)} 继续当前步骤</button>
          <button class="btn sm" data-act="askExercise">${icon('edit', 14)} 直接来一道练习</button>
          <div style="flex:1"></div>
          <span style="font-size:11.5px;color:var(--text-3)">点击步骤可在右侧查看上下文</span>
        </div>
      </div>`;
    }
    if (c.type === 'exercise') {
      const ex = c.exercise || getEx(c.exId);
      if (!ex) return '';
      const graded = c.state === 'graded';
      const grading = c.state === 'grading';
      const locked = graded || grading;
      const qType = String(ex.type || 'CHOICE').toUpperCase();
      const answer = c.answer != null ? c.answer : (ex.answer != null ? ex.answer : -1);
      const hints = (c.hintTexts || []).map((x, i) =>
        `<div class="hint-box"><b>提示 ${i + 1}：</b>${h(x)}</div>`).join('');
      let ansArea = '';
      if (qType === 'CHOICE') {
        const opts = ex.options.map((o, i) => {
          let cls = '';
          if (c.selected === i) cls = 'sel';
          if (graded) {
            if (i === answer) cls = 'correct';
            else if (c.selected === i) cls = 'wrong';
          }
          return `<div class="opt ${cls}" ${graded ? '' : 'data-act="opt" data-id="' + msgId + '" data-val="' + i + '"'}>
            <div class="opt-key">${'ABCD'[i]}</div><div>${h(o)}</div></div>`;
        }).join('');
        ansArea = `<div style="margin-top:10px">${opts}</div>`;
      } else if (qType === 'JUDGE') {
        ansArea = `<div style="display:flex;gap:10px;margin-top:10px">
          ${[0, 1].map(i => `<div class="opt judge ${c.selected === i ? 'sel' : ''}" style="flex:1;justify-content:center;cursor:${locked ? 'default' : 'pointer'}" ${locked ? '' : 'data-act="opt" data-id="' + msgId + '" data-val="' + i + '"'}>
            <div class="opt-key">${'AB'[i]}</div><div>${i === 0 ? '正确' : '错误'}</div></div>`).join('')}
        </div>`;
      } else if (qType === 'FILL') {
        ansArea = `<input class="input ex-ans" style="margin-top:10px" placeholder="填写答案" value="${h(c.textAnswer || '')}" data-bind="exAns" data-id="${msgId}" ${locked ? 'disabled' : ''}>`;
      } else if (qType === 'SHORT') {
        ansArea = `<textarea class="textarea ex-ans" style="min-height:100px;margin-top:10px" placeholder="在此输入你的答案…" data-bind="exAns" data-id="${msgId}" ${locked ? 'disabled' : ''}>${h(c.textAnswer || '')}</textarea>`;
      } else if (qType === 'CODE') {
        // CODE：内置代码编辑器（语法高亮 / 行号 / 自动补全），预填题目模板供补全
        ansArea = codeEditorHtml(`data-bind="exAns" data-id="${msgId}"`,
          c.textAnswer != null ? c.textAnswer : (ex.code || ''), { ro: locked, minHeight: 180, placeholder: '在此编写代码…' });
      }
      const submitReady = qType === 'CHOICE' || qType === 'JUDGE' ? c.selected != null : !!(c.textAnswer || '').trim();
      return `<div class="work">
        <div class="work-head">${icon('edit', 15)}<span class="wt">${qType === 'CODE' ? '代码陪练题' : qType === 'JUDGE' ? '判断题' : qType === 'FILL' ? '填空题' : qType === 'SHORT' ? '简答题' : '随堂练习'} · ${kpName(ex.kp)}</span>
          <div class="spacer"></div><span class="badge ${ex.difficulty === '困难' ? 'danger' : ex.difficulty === '中等' ? 'warn' : 'ok'}">${ex.difficulty}</span></div>
        <div class="work-body">
          <div style="font-size:13.5px;line-height:1.7;margin-bottom:10px">${h(ex.stem)}</div>
          ${ex.code ? '<pre class="code-block cb">' + h(ex.code) + '</pre>' : ''}
          ${ansArea}
          ${hints ? '<div style="margin-top:12px">' + hints + '</div>' : ''}
        </div>
        <div class="work-foot">
          ${graded
            ? '<span class="badge ok">' + icon('check', 12) + ' 已作答，掌握度已更新</span>'
            : grading
              ? '<span class="badge brand">' + icon('sparkles', 12) + ' 智能体正在点评你的作答…</span>'
              : `<button class="btn sm primary" data-act="submitEx" data-id="${msgId}" ${submitReady ? '' : 'disabled'}>提交答案</button>
                 <button class="btn sm" data-act="hint" data-id="${msgId}" ${c.hintLevel >= 3 ? 'disabled' : ''}>${icon('flame', 14)} 再要一级提示 (${c.hintLevel}/3)</button>`}
          <div style="flex:1"></div>
          <span style="font-size:11.5px;color:var(--text-3)">${qType === 'CODE' || qType === 'SHORT' ? '提交后智能体将按题干点评你的作答' : '提示使用次数教师端可见'}</span>
        </div>
      </div>`;
    }
    if (c.type === 'result') {
      const ex = c.exercise || getEx(c.exId);
      return `<div class="work">
        <div class="work-head">${icon(c.ok ? 'checkcircle' : 'alert', 15)}<span class="wt">即时评测</span><div class="spacer"></div>
          <span class="badge ${c.ok ? 'ok' : 'danger'}">${c.ok ? '正确' : '需巩固'}</span></div>
        <div class="work-body">
          <div class="result-box ${c.ok ? 'ok' : 'bad'}">
            <h5>${c.ok ? '回答正确，掌握度 +' + c.delta : '这题没过，掌握度 ' + c.delta}</h5>
            <div>${h(c.analysis || (ex ? ex.analysis : ''))}</div>
          </div>
        </div>
      </div>`;
    }
    if (c.type === 'code') {
      return `<div class="work">
        <div class="work-head">${icon('code', 15)}<span class="wt">${h(c.title || '代码片段')}</span><div class="spacer"></div><span class="badge info">${c.lang}</span></div>
        <div class="work-body"><pre class="code-block cb">${h(c.code)}</pre>
          <div class="note" style="margin-top:10px">${h(c.explain)}</div></div>
      </div>`;
    }
    if (c.type === 'codeCoach') {
      const hints = c.hints.slice(0, c.revealed).map((x, i) => `<div class="hint-box"><b>提示 ${i + 1}：</b>${h(x)}</div>`).join('');
      return `<div class="work">
        <div class="work-head">${icon('code', 15)}<span class="wt">代码陪练 · ${h(c.title || '')}</span><div class="spacer"></div><span class="badge warn">不直接给完整实现</span></div>
        <div class="work-body">
          <pre class="code-block cb">${h(c.code)}</pre>
          <div class="note warn" style="margin-top:10px">${h(c.note || '')}</div>
          ${hints ? '<div style="margin-top:12px">' + hints + '</div>' : ''}
        </div>
        <div class="work-foot">
          <button class="btn sm" data-act="coachHint" data-id="${msgId}" ${c.revealed >= 3 ? 'disabled' : ''}>${icon('flame', 14)} 再要一级提示 (${c.revealed}/3)</button>
          <div style="flex:1"></div>
          <span style="font-size:11.5px;color:var(--text-3)">三级渐进提示：思路 → 定位 → 关键结论</span>
        </div>
      </div>`;
    }
    if (c.type === 'report') {
      return `<div class="work">
        <div class="work-head">${icon('chart', 15)}<span class="wt">${h(c.title)}</span><div class="spacer"></div><span class="badge ok">${icon('check', 12)} 已完成</span></div>
        <div class="work-body">
          <div class="grid grid-4" style="margin-bottom:12px">
            ${c.metrics.map(m => `<div style="background:var(--panel-2);border:1px solid var(--border);border-radius:8px;padding:10px">
              <div style="font-size:11.5px;color:var(--text-3)">${h(m.label)}</div>
              <div style="font-size:17px;font-weight:680;margin-top:3px">${h(m.value)}</div></div>`).join('')}
          </div>
          <div class="note ok">${h(c.summary)}</div>
        </div></div>`;
    }
    if (c.type === 'feedback') {
      const total = c.total || 100;
      const title = c.assignmentTitle || c.title || '作业';
      const score = c.score != null ? c.score : 0;
      const pct = Math.round(score / total * 100);
      return `<div class="work">
        <div class="work-head">${icon('checkcircle', 15)}<span class="wt">教师反馈 · ${h(title)}</span><div class="spacer"></div><span class="badge ok">批改Agent</span></div>
        <div class="work-body">
          <div style="display:flex;align-items:center;gap:14px;margin-bottom:12px">
            <div style="font-size:30px;font-weight:700;color:var(--brand)">${score}<span style="font-size:14px;color:var(--text-3)">/${total}</span></div>
            <div style="flex:1"><div class="bar ${bcls(pct)}"><i style="width:${pct}%"></i></div>
              <div style="font-size:11.5px;color:var(--text-3);margin-top:5px">${h(c.teacher || '任课教师')} · 已同步至你的学习画像</div></div>
          </div>
          ${(c.rubric && c.rubric.length) ? `<div class="mini-list">${c.rubric.map(r => `<div class="mini-row">
            <span class="nm">${h(r.name)}</span>
            <div class="bar ${bcls(r.score / r.max * 100)}"><i style="width:${r.score / r.max * 100}%"></i></div>
            <span class="vl">${r.score}/${r.max}</span></div>`).join('')}</div>` : ''}
          <div class="note" style="margin-top:12px"><b>教师评语：</b>${h(c.comment || '（教师未填写评语）')}</div>
        </div></div>`;
    }
    return '';
  }

  /* ---------------- 学生：知识图谱（超星风格 · 课程知识点 Excel 全量树） ---------------- */
  // graph 接口数据 → 前端兼容结构（id/module/mastery/deps 等），新旧功能共用
  function applyKnowledgeGraph(graph) {
    DB.modules = (graph.modules || []).map(m => ({ id: m.code, name: m.name, color: m.color || '#a78bfa' }));
    const edgeByFrom = {};
    (graph.edges || []).forEach(e => { (edgeByFrom[e.from] = edgeByFrom[e.from] || []).push(e.to); });
    DB.knowledgePoints = (graph.nodes || []).map(n => ({
      id: n.code, name: n.name, module: n.moduleCode || null, level: n.level || 2,
      parent: n.parentCode || null, sortOrder: n.sortOrder || 0,
      mastery: n.mastery != null ? n.mastery : 0, hasData: n.mastery != null,
      deps: edgeByFrom[n.code] || [], desc: n.desc || '', resources: []
    }));
  }

  // 掌握度配色（图谱节点描边/发光）
  function kgMasteryColor(k) {
    if (!k.hasData) return 'rgba(148,163,184,.9)';
    return k.mastery >= 80 ? '#34d399' : k.mastery >= 60 ? '#fbbf24' : '#f87171';
  }

  // 模块视图太阳图布局：二级均匀分环，子树按节点数占扇区向外辐射（椭圆坐标适配画布比例）。
  // 防重叠（V2）：① 逐环加大径向间距，为深环小节点留足空间；
  // ② 每环节点按角度排序后做"向前推进"消解，保证相邻节点弧长间距 ≥ 节点直径+间隙，
  //    彻底解决密集子树（如 数据类型→基本数据类型→整数类型→六种范围）末端节点堆叠遮挡。
  function kgLayoutModule(mcode) {
    const nodes = DB.knowledgePoints.filter(k => k.module === mcode);
    // 父子索引：仅挂"真实子节点"（parent 为空的模块根不进索引）——
    // 否则根会作为自己的子节点参与递归布局，造成无限递归栈溢出，
    // render() 异常中断后表现为"点击模块/气泡切换无响应"。
    const children = {};
    nodes.forEach(k => { if (k.parent && k.parent !== k.id) (children[k.parent] = children[k.parent] || []).push(k); });
    const root = nodes.find(k => k.level === 1) || nodes[0];
    if (!root) return { pos: {}, nodes: [], lines: [] };
    const size = {};
    const subSize = k => { let n = 1; (children[k.id] || []).forEach(c => n += subSize(c)); return size[k.id] = n; };
    const pos = {};
    pos[root.id] = { x: 0, y: 0, a: 0 };
    // 环半径（X/Y 半轴）：由内向外逐环扩张；半径体系满足两类约束——
    // ① 相邻环径向间距 ≥ 两环节点半径之和+6（环间不挤压）；
    // ② 环弧长容量足够容纳该环全部节点（含文字标签净空），弧长需求按弦长精确换算。
    const RX = [0, 320, 470, 580, 665, 730, 775, 810];
    const RY = [0, 180, 295, 345, 375, 405, 435, 465];
    const l2 = children[root.id] || [];
    l2.forEach(c => subSize(c));
    const ringOf = {};
    const place = (k, a0, a1, ring, depth) => {
      if (depth > 9) return; // 防环兜底
      const r = Math.min(ring, RX.length - 1);
      ringOf[k.id] = r;
      const mid = (a0 + a1) / 2;
      pos[k.id] = { x: RX[r] * Math.cos(mid), y: RY[r] * Math.sin(mid), a: mid };
      const kids = children[k.id] || [];
      if (!kids.length) return;
      const total = kids.reduce((s, c) => s + (size[c.id] || 1), 0);
      const pad = (a1 - a0) * 0.1;
      let acc = a0 + pad;
      const span = (a1 - a0) - pad * 2;
      kids.forEach(c => {
        const share = span * (size[c.id] || 1) / total;
        place(c, acc, acc + share, ring + 1, depth + 1);
        acc += share;
      });
    };
    l2.forEach((k, i) => place(k, (i / l2.length) * Math.PI * 2, ((i + 1) / l2.length) * Math.PI * 2, 1, 0));
    // ---- 每环防重叠消解：同环节点按角度排序，向前推进保证最小弧长间距 ----
    const nodeR = k => { const lv = k.level || 3; return lv === 1 ? 46 : lv === 2 ? 24 : lv === 3 ? 15 : 11; };
    const byRing = {};
    nodes.forEach(k => { const r = ringOf[k.id]; if (r > 0) (byRing[r] = byRing[r] || []).push(k); });
    Object.keys(byRing).map(Number).forEach(r => {
      const list = byRing[r].sort((a, b) => pos[a.id].a - pos[b.id].a);
      if (list.length < 2) { finalize(); return; }
      // 末端细分环（含 lv4+ 小节点，现已全部渲染名称标签）：按「节点直径 / 标签宽度」较大者
      // 留净空，避免相邻名称文字互叠（标签宽 ≈ 字数 × 10.5px）；
      // 三级及以下的密集环保持原有净空（直径+20），防止超容量触发环绕压缩回挤
      //（如编程基础 44 个 L3 节点同环已近容量极限）。
      const hasLeaf = list.some(k => (k.level || 3) >= 4);
      const gap = hasLeaf
        ? Math.max(Math.max.apply(null, list.map(nodeR)) * 2, Math.max.apply(null, list.map(k => String(k.name || '').length * 10.5))) + 14
        : Math.max.apply(null, list.map(nodeR)) * 2 + 20;
      // 椭圆在角度 a 处的弧长变化率（局部半径）；按弦长精确反推所需最小角间距
      const rho = a => Math.sqrt(Math.pow(RX[r] * Math.sin(a), 2) + Math.pow(RY[r] * Math.cos(a), 2));
      const needAt = a => 2 * Math.asin(Math.min(0.99, gap / (2 * Math.max(60, rho(a)))));
      // 两轮"推进 + 环绕闭合校验"，保证环上任意相邻节点（含首尾环绕）间距达标
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 1; i < list.length; i++) {
          const need = needAt((pos[list[i - 1].id].a + pos[list[i].id].a) / 2);
          if (pos[list[i].id].a - pos[list[i - 1].id].a < need) {
            pos[list[i].id].a = pos[list[i - 1].id].a + need;
          }
        }
        // 环绕闭合：末节点与首节点(+2π)间距不足时等比压缩整环角跨度
        const fa = pos[list[0].id].a, la = pos[list[list.length - 1].id].a;
        const avail = Math.PI * 2 - needAt((fa + la) / 2);
        if (la - fa > avail && la - fa > 0) {
          const scale = avail / (la - fa);
          for (let i = 1; i < list.length; i++) {
            pos[list[i].id].a = fa + (pos[list[i].id].a - fa) * scale;
          }
        }
      }
      finalize();
      function finalize() {
        (list.length ? list : byRing[r]).forEach(k => {
          const a = pos[k.id].a;
          pos[k.id] = { x: RX[r] * Math.cos(a), y: RY[r] * Math.sin(a) };
        });
      }
    });
    // 连线：父子边
    const lines = [];
    nodes.forEach(k => { if (pos[k.id] && pos[k.parent] && k.parent !== k.id) lines.push([k.parent, k.id]); });
    return { pos, nodes, lines, root };
  }

  // SVG 图谱渲染：首页气泡视图 / 模块太阳图视图
  // 注意：viewBox 已以画布中心为原点（-W/2,-H/2 起），内容坐标直接以 (0,0) 为中心，
  // 不得再叠加 translate(W/2,H/2)——否则图形被推出可视区（板块切换"看似无响应"的根因）。
  // 内层 #kgViewport 承载缩放变换（滚轮 / 按钮），切换视图时重置为 1。
  function kgSvg(view) {
    // 画布 1660×1000（V2 扩容）：为七级深环留足径向空间，杜绝密集子树末端节点挤压
    const W = 1660, H = 1000;
    const zoom = State.kgZoom || 1;
    let inner = '';
    if (!view || view.mode === 'home') {
      // 首页：五大模块发光气泡 + 模块间递进箭头（编号顺序 1→5）
      const mods = DB.modules;
      const pts = mods.map((m, i) => {
        const a = (-Math.PI / 2) + (i / mods.length) * Math.PI * 2;
        return { m, x: 500 * Math.cos(a), y: 320 * Math.sin(a) };
      });
      for (let i = 0; i + 1 < pts.length; i++) {
        inner += `<line x1="${pts[i].x}" y1="${pts[i].y}" x2="${pts[i + 1].x}" y2="${pts[i + 1].y}" class="kg-link"/>`;
      }
      pts.forEach((p, i) => {
        const cnt = DB.knowledgePoints.filter(k => k.module === p.m.id).length;
        const avg = (() => { const arr = DB.knowledgePoints.filter(k => k.module === p.m.id && k.hasData); return arr.length ? Math.round(arr.reduce((s, k) => s + k.mastery, 0) / arr.length) : null; })();
        const color = avg != null ? (avg >= 80 ? '#34d399' : avg >= 60 ? '#fbbf24' : '#f87171') : p.m.color;
        inner += `<g class="kg-bubble" data-act="kgModule" data-val="${p.m.id}">
          <circle cx="${p.x}" cy="${p.y}" r="86" fill="${p.m.color}22" stroke="${p.m.color}" stroke-width="1.5" class="kg-glow"/>
          <circle cx="${p.x}" cy="${p.y}" r="60" fill="${p.m.color}55" stroke="${color}" stroke-width="2"/>
          <text x="${p.x}" y="${p.y - 26}" class="kg-bubble-no">${i + 1}</text>
          <text x="${p.x}" y="${p.y + 4}" class="kg-bubble-name">${h(p.m.name)}</text>
          <text x="${p.x}" y="${p.y + 26}" class="kg-bubble-sub">${cnt} 个知识点${avg != null ? ' · 均分 ' + avg : ''}</text>
        </g>`;
      });
      inner = `<g>${inner}</g>`;
    } else {
      const L = kgLayoutModule(view.module);
      const mcolor = (DB.modules.find(m => m.id === view.module) || {}).color || '#a78bfa';
      let links = '';
      L.lines.forEach(([a, b]) => {
        links += `<line x1="${L.pos[a].x}" y1="${L.pos[a].y}" x2="${L.pos[b].x}" y2="${L.pos[b].y}" class="kg-link"/>`;
      });
      let shapes = '';
      L.nodes.forEach(k => {
        const p = L.pos[k.id];
        if (!p) return;
        const lv = k.level || 3;
        const focus = view.focus === k.id;
        const active = State.activeKp === k.id;
        const r = lv === 1 ? 46 : lv === 2 ? 24 : lv === 3 ? 15 : 11;
        const stroke = focus ? '#ffffff' : active ? '#c7d2fe' : kgMasteryColor(k);
        const sw = focus ? 3.5 : active ? 3 : 2;
        const glow = lv <= 2 || focus ? 'kg-glow' : '';
        const shape = lv <= 2
          ? `<rect x="${-r}" y="${-r}" width="${r * 2}" height="${r * 2}" rx="6" transform="rotate(45)" fill="${lv === 1 ? mcolor + '66' : mcolor + '33'}" stroke="${stroke}" stroke-width="${sw}" class="${glow}"/>`
          : `<circle r="${r}" fill="${mcolor}26" stroke="${stroke}" stroke-width="${sw}" class="${glow}"/>`;
        // 末端细分节点（lv≥4）同样渲染名称标签：所有节点文字说明完整可见，杜绝"无字圆圈"
        const label = `<text y="${lv <= 2 ? (lv === 1 ? 34 : 6 + r) : r + 11}" class="kg-node-label ${lv <= 2 ? 'big' : ''}">${h(k.name)}</text>`;
        shapes += `<g class="kg-node" transform="translate(${p.x},${p.y})" data-act="kpCell" data-val="${k.id}">
          <title>${h(k.name)}${k.hasData ? ' · 掌握度 ' + k.mastery : ''}</title>
          ${shape}
          ${lv === 1 ? `<text y="6" class="kg-node-level1">${h(k.name)}</text>` : ''}
          ${lv === 1 ? '' : label}
        </g>`;
      });
      // 模块内 PRE 依赖边（虚线橙）
      let deps = '';
      DB.knowledgePoints.filter(k => k.module === view.module && k.deps && k.deps.length).forEach(k => {
        k.deps.forEach(d => {
          const t = DB.knowledgePoints.find(x => x.id === d);
          if (t && t.module === view.module && L.pos[k.id] && L.pos[t.id]) {
            deps += `<line x1="${L.pos[k.id].x}" y1="${L.pos[k.id].y}" x2="${L.pos[t.id].x}" y2="${L.pos[t.id].y}" class="kg-dep"/>`;
          }
        });
      });
      inner = `<g>${links}${deps}${shapes}</g>`;
    }
    const pan = State.kgPan || { x: 0, y: 0 };
    return `<svg id="kgSvg" viewBox="${-W / 2} ${-H / 2} ${W} ${H}" preserveAspectRatio="xMidYMid meet" class="kg-svg"><g id="kgViewport" transform="translate(${pan.x} ${pan.y}) scale(${zoom})">${inner}</g></svg>`;
  }

  // 拖拽平移边界：内容安全范围（最大环半径 + 标签余量）经缩放后必须与画布保持至少
  // 160 viewBox 单位重叠，防止拖动把图谱整体移出可视区；图谱完全可见时锁定居中。
  // V2 画布扩容为 1660×1000、最大环 RX=810/RY=465，边界同步调整。
  function kgClampPan(x, y, zoom) {
    const W = 1660, H = 1000, EX = 860, EY = 540;
    const mx = Math.max(0, EX * zoom - W / 2 + 160);
    const my = Math.max(0, EY * zoom - H / 2 + 160);
    return { x: Math.max(-mx, Math.min(mx, x)), y: Math.max(-my, Math.min(my, y)) };
  }

  // 局部更新平移+缩放变换（不整页重渲染）
  function kgApplyPan() {
    const vp = document.getElementById('kgViewport');
    if (!vp) return;
    const pan = State.kgPan || { x: 0, y: 0 };
    vp.setAttribute('transform', 'translate(' + pan.x + ' ' + pan.y + ') scale(' + (State.kgZoom || 1) + ')');
  }

  // 搜索结果（局部刷新，不重渲染）
  function kgSearchResults(q) {
    q = (q || '').trim().toLowerCase();
    if (!q) return '';
    const hits = DB.knowledgePoints.filter(k => k.name.toLowerCase().indexOf(q) >= 0).slice(0, 12);
    return hits.map(k => {
      const m = DB.modules.find(x => x.id === k.module);
      return `<button class="kg-hit" data-act="kgFocus" data-val="${k.id}">
        <span class="kg-hit-name">${h(k.name)}</span>
        <span class="kg-hit-mod">${m ? h(m.name) : ''} · L${k.level}${k.hasData ? ' · ' + k.mastery + '分' : ''}</span>
      </button>`;
    }).join('');
  }

  function viewKnowledge() {
    const cur = kp(State.activeKp);
    const kg = State.kgView || { mode: 'home' };
    const head = mainHead('知识图谱', '课程知识点全景 · 共 ' + DB.knowledgePoints.length + ' 个节点 · 点击节点查看掌握情况与依赖链');

    const side = `<div class="kg-search">${icon('search', 14)}
        <input id="kgSearchInput" placeholder="搜索知识点…" value="${h(State.kgQ || '')}" data-bind="kgq"></div>
      <div class="kg-side-hint">点击选项定位到对应的知识单元</div>
      <button class="kg-nav-item ${kg.mode === 'home' ? 'on' : ''}" data-act="kgHome">${icon('home', 14)}<span>首页</span></button>
      ${DB.modules.map((m, i) => `<button class="kg-nav-item ${kg.mode === 'module' && kg.module === m.id ? 'on' : ''}" data-act="kgModule" data-val="${m.id}">
        <span class="kg-nav-no" style="background:${m.color}">${i + 1}</span><span>${h(m.name)}</span></button>`).join('')}
      <div style="flex:1"></div>
      <button class="kg-nav-item" data-act="kgHome">${icon('grid', 14)}<span>全部显示</span></button>
      <div id="kgSearchList" class="kg-search-list"></div>`;

    const body = `
      <div class="kg-wrap">
        <aside class="kg-side">${side}</aside>
        <div class="kg-canvas">
          <button class="kg-export" data-act="kgExport">${icon('download', 13)} 导出图片</button>
          <div class="kg-zoom-bar">
            <button class="kg-zoom-btn" data-act="kgZoomIn" title="放大">＋</button>
            <span id="kgZoomPct" class="kg-zoom-pct">${Math.round((State.kgZoom || 1) * 100)}%</span>
            <button class="kg-zoom-btn" data-act="kgZoomOut" title="缩小">－</button>
            <button class="kg-zoom-btn" data-act="kgZoomReset" title="重置">⟲</button>
          </div>
          ${(() => { try { return kgSvg(kg); } catch (e) { return '<div style="padding:40px;color:#f87171;font-size:13px">图谱渲染异常：' + h(e.message) + '</div>'; } })()}
        </div>
      </div>
      <div class="split" style="margin-top:12px">
      ${kgChainCard(cur)}
      </div>`;
    return { head, body };
  }

  // 图7原有功能（完整保留）：依赖链溯源卡 + 最薄弱 TOP3 卡
  function kgChainCard(cur) {
    const chain = traceChain(cur.id);
    const chainHtml = chain.map((c, i) =>
      (i ? '<span class="chain-arrow">' + icon('chevronR', 15) + '</span>' : '') +
      `<span class="chain-node ${c.root ? 'root' : ''}" data-act="kpCell" data-val="${c.id}">${kpName(c.id)} · ${kp(c.id).mastery} 分</span>`
    ).join('');
    const weak = DB.knowledgePoints.filter(k => k.hasData).slice().sort((a, b) => a.mastery - b.mastery).slice(0, 3);
    return `
      <div class="card"><div class="card-head">${icon('route', 15)}<h3>依赖链溯源 · ${cur.name}</h3><div class="spacer"></div>
          <span class="badge ${cur.hasData ? (cur.mastery >= 80 ? 'ok' : cur.mastery >= 60 ? '' : 'danger') : ''}">${cur.hasData ? cur.mastery + ' 分 · ' + mtext(cur.mastery) : '暂无掌握数据'}</span></div>
        <div class="card-body">
          <div style="font-size:13px;color:var(--text-2);line-height:1.7;margin-bottom:10px">${h(cur.desc)}</div>
          <div class="chain">${chainHtml}</div>
          <div class="note ${chain.find(c => c.root) ? 'warn' : 'ok'}">
            ${chain.find(c => c.root)
              ? '溯源结论：真正卡住你的是 <b>' + kpName(chain.find(c => c.root).id) + '</b>（' + kp(chain.find(c => c.root).id).mastery + ' 分），先补它再回到「' + cur.name + '」收益才高。'
              : '该知识点前置依赖均已达标，可以直接推进。'}
          </div>
        </div></div>

      <div class="card"><div class="card-head">${icon('flame', 15)}<h3>最薄弱 TOP 3</h3></div>
        <div class="card-body"><div class="mini-list">
          ${weak.map(k => `<div class="mini-row" data-act="kpCell" data-val="${k.id}" style="cursor:pointer">
            <span class="nm">${k.name}</span>
            <div class="bar ${bcls(k.mastery)}"><i style="width:${k.mastery}%"></i></div>
            <span class="vl">${k.mastery}</span></div>`).join('')}
        </div>
        <div class="note warn" style="margin-top:12px">薄弱点会自动进入每日复习队列，并按 SM-2 间隔重复推送。</div>
        </div></div>`;
  }

  function traceChain(id, seen) {
    seen = seen || [];
    const k = kp(id);
    const out = [{ id: k.id, root: false }];
    const deps = (k.deps || []).filter(d => seen.indexOf(d) < 0);
    if (!deps.length) { out[0].root = kp(id).mastery < 60; return out; }
    // 取最弱的前置继续往下追
    let weakest = deps[0];
    deps.forEach(d => { if (kp(d).mastery < kp(weakest).mastery) weakest = d; });
    const rest = traceChain(weakest, seen.concat([id]));
    // 标记链条上最弱的节点为 root
    const all = rest.concat(out);
    let min = all[0];
    all.forEach(a => { if (kp(a.id).mastery < kp(min.id).mastery) min = a; });
    if (kp(min.id).mastery < 60) min.root = true;
    return all;
  }

  /* ---------------- 学生：作业 ---------------- */
  function viewHomework() {
    const list = DB.assignments.filter(a => a.status !== 'draft');
    const f = State.filters.hw;
    const shown = list.filter(a => f === 'all' || homeworkStatusOf(a.id).key === f);
    const head = mainHead('我的作业', '教师发布的作业与批改反馈会实时同步到这里');

    if (!shown.length) {
      return { head, body: emptyBox('没有符合条件的作业', '换个筛选条件看看，或等待教师发布新作业。') };
    }

    const body = shown.map(a => {
      const st = homeworkStatusOf(a.id);
      const sub = subOf(a.id);
      let extra = '';
      if (st.key === 'graded' && sub) {
        extra = renderCard({
          type: 'feedback', assignmentTitle: a.title, score: sub.score, total: 100,
          teacher: '任课教师',
          rubric: a.rubric.map(r => ({ name: r.name, score: (sub.rubricScores && sub.rubricScores[r.name]) || 0, max: r.max })),
          comment: sub.teacherComment || '（教师未填写评语）'
        });
      } else if (st.key === 'pending' && sub) {
        // 自动评分临时分数（客观题标准答案匹配，不落库不计成绩），明确标注仅供参考
        const autoBadge = sub.autoScore != null
          ? `<span class="badge brand" style="margin-left:0">${icon('sparkles', 12)} 自动评分临时分数 ${sub.autoScore} 分</span>` : '';
        extra = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">${autoBadge}</div>
          <div class="note" style="margin-top:10px">已提交于 ${sub.submittedAt} · 教师批改中，批改完成后会在这里和会话里同步通知你。${sub.autoScore != null ? ' 上方「自动评分临时分数」由系统按标准答案即时匹配（仅客观题），仅供参考，最终成绩以教师批改为准。' : ''}</div>`;
      }
      return `<div class="card" id="hw-${a.id}" style="${State.focusHwId === a.id ? 'border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)' : ''}">
        <div class="card-head">${icon('clipboard', 15)}<h3>${h(a.title)}</h3>
          <div class="spacer"></div><span class="badge ${st.cls}">${st.label}</span></div>
        <div class="card-body">
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${a.kp.map(k => '<span class="badge brand">' + kpName(k) + '</span>').join('')}
            <span class="badge">${icon('clock', 12)} 截止 ${h(a.due)}</span>
          </div>
          ${st.key === 'todo' ? `<div style="margin-top:12px">
            <button class="btn primary" data-act="${a.questionCount ? 'openAnswer' : 'submitHw'}" data-val="${a.id}">${icon('send', 14)} ${a.questionCount ? '进入作业详情作答' : '提交作业'}</button></div>`
          : a.questionCount ? `<div style="margin-top:12px">
            <button class="btn ${st.key === 'graded' ? '' : 'primary'}" data-act="openAnswer" data-val="${a.id}">${icon(st.key === 'graded' ? 'eye' : 'edit', 14)} ${st.key === 'graded' ? '查看作业详情' : '查看 / 修改作答'}</button></div>` : ''}
          ${extra ? '<div style="margin-top:12px">' + extra + '</div>' : ''}
        </div></div>`;
    }).join('');
    return { head, body };
  }

  /* ---------------- 学生：练习记录 ---------------- */
  function viewExercise() {
    const f = State.filters.exKp;
    const recs = DB.exerciseRecords.filter(r => f === 'all' || r.kp === f);
    const head = mainHead('练习记录', '共 ' + DB.exerciseRecords.length + ' 条 · 掌握度变化全部来自即时评测回流');
    if (!recs.length) {
      return {
        head,
        body: emptyBox('还没有练习记录', '回到「学习会话」完成一道练习，评测结果会自动记录到这里，并同步更新知识图谱掌握度。',
          '<button class="btn primary" data-act="gotoChat">' + icon('chat', 15) + ' 去学习会话</button>')
      };
    }
    const body = `<div class="card"><div class="card-head">${icon('book', 15)}<h3>历史练习</h3></div>
      <div style="overflow-x:auto"><table class="table">
        <thead><tr><th>时间</th><th>知识点</th><th>题目</th><th class="num">结果</th><th class="num">掌握度</th></tr></thead>
        <tbody>${recs.map(r => `<tr>
          <td style="color:var(--text-3)">${r.time}</td>
          <td><span class="badge">${kpName(r.kp)}</span></td>
          <td>${h(r.title)}</td>
          <td class="num"><span class="badge ${r.ok ? 'ok' : 'danger'}">${r.ok ? '通过' : '未通过'}</span></td>
          <td class="num" style="font-weight:600;color:${r.delta > 0 ? 'var(--ok)' : 'var(--danger)'}">${r.delta > 0 ? '+' : ''}${r.delta}</td>
        </tr>`).join('')}</tbody>
      </table></div></div>`;
    return { head, body };
  }

  /* ---------------- 学生：画像与报告 ---------------- */
  function overviewNote() {
    const weak = DB.knowledgePoints.slice().sort((a, b) => a.mastery - b.mastery)[0];
    if (!weak) return '暂无数据';
    if (weak.mastery >= 60) return '整体掌握情况良好，保持当前学习节奏即可。';
    const dep = (weak.deps || []).map(kp).sort((a, b) => a.mastery - b.mastery)[0];
    return dep && dep.mastery < 60
      ? '「' + weak.name + '」仍是主要拖累项，其前置「' + dep.name + '」（' + dep.mastery + ' 分）也偏弱，建议先补前置再回到主线。'
      : '「' + weak.name + '」（' + weak.mastery + ' 分）是目前最薄弱的知识点，优先攻克它收益最大。';
  }

  function viewReport() {
    const s = DB.student;
    const tab = State.filters.report;
    const head = mainHead('学习画像与报告', s.name + ' · ' + s.sid);
    let body = '';

    if (tab === 'overview') {
      const maxA = Math.max.apply(null, s.weekActivity);
      body = `<div class="grid grid-4">
        <div class="card kpi"><div class="kpi-label">${icon('flame', 13)} 连续学习</div><div class="kpi-value">${s.streakDays} 天</div><div class="kpi-delta up">保持得不错</div></div>
        <div class="card kpi"><div class="kpi-label">${icon('clock', 13)} 本周时长</div><div class="kpi-value">${s.weekHours} h</div><div class="kpi-delta">目标 8 h</div></div>
        <div class="card kpi"><div class="kpi-label">${icon('edit', 13)} 累计练习</div><div class="kpi-value">${s.doneExercises} 题</div><div class="kpi-delta up">本周 +12</div></div>
        <div class="card kpi"><div class="kpi-label">${icon('target', 13)} 平均掌握度</div><div class="kpi-value">${s.avgMastery}</div><div class="kpi-delta up">较上周 +3</div></div>
      </div>
      <div class="card"><div class="card-head">${icon('chart', 15)}<h3>本周学习时长（小时）</h3></div>
        <div class="card-body">
          <div style="display:flex;align-items:flex-end;gap:10px;height:110px">
            ${s.weekActivity.map((v, i) => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px">
              <div style="font-size:11.5px;color:var(--text-3)">${v}</div>
              <div style="width:100%;height:${Math.round(v / maxA * 78)}px;background:var(--brand-2);border-radius:5px 5px 0 0"></div>
              <div style="font-size:11.5px;color:var(--text-3)">${['一', '二', '三', '四', '五', '六', '日'][i]}</div></div>`).join('')}
          </div></div></div>
      <div class="card"><div class="card-head">${icon('route', 15)}<h3>掌握度趋势（近 7 天）</h3><div class="spacer"></div>
        <span class="badge ok">${s.masteryTrend[0]} → ${s.masteryTrend[6]}</span></div>
        <div class="card-body"><div class="spark" style="height:44px;gap:8px">
          ${s.masteryTrend.map(v => '<i style="height:' + Math.round(v / 70 * 44) + 'px;width:22px"></i>').join('')}
        </div>
        <div class="note ok" style="margin-top:12px">${h(overviewNote())}</div>
        </div></div>`;
    } else if (tab === 'mastery') {
      body = `<div class="card"><div class="card-head">${icon('target', 15)}<h3>知识点掌握度明细</h3></div>
        <div class="card-body"><div class="mini-list">
          ${DB.knowledgePoints.slice().sort((a, b) => a.mastery - b.mastery).map(k => `<div class="mini-row">
            <span class="nm">${k.name}</span>
            <div class="bar ${bcls(k.mastery)}"><i style="width:${k.mastery}%"></i></div>
            <span class="vl">${k.mastery}</span></div>`).join('')}
        </div></div></div>`;
    } else if (tab === 'wrong') {
      body = DB.student.wrongBook.length ? `<div class="card"><div class="card-head">${icon('file', 15)}<h3>错题本</h3><div class="spacer"></div>
        <span class="badge warn">${DB.student.wrongBook.length} 题待复习</span></div>
        <div style="overflow-x:auto"><table class="table">
          <thead><tr><th>题目</th><th>知识点</th><th class="num">错误次数</th><th class="num">最近</th></tr></thead>
          <tbody>${DB.student.wrongBook.map(w => `<tr>
            <td>${h(w.title)}</td><td><span class="badge">${kpName(w.kp)}</span></td>
            <td class="num">${w.wrongCount}</td><td class="num" style="color:var(--text-3)">${w.lastAt}</td></tr>`).join('')}
          </tbody></table></div></div>` : emptyBox('错题本是空的', '做错的题会自动进入错题本，并按间隔重复安排复习。');
    } else {
      body = DB.student.reviewQueue.length ? `<div class="card"><div class="card-head">${icon('clock', 15)}<h3>今日复习队列</h3><div class="spacer"></div>
        <span class="badge brand">SM-2 间隔重复</span></div>
        <div class="card-body"><div class="step-list">
          ${DB.student.reviewQueue.map(r => `<div class="step" data-act="kpCell" data-val="${r.kp}">
            <div class="step-idx">${icon('clock', 13)}</div>
            <div class="step-main"><div class="step-title">${h(r.title)}</div>
            <div class="step-desc">${kpName(r.kp)} · ${h(r.reason)}</div></div>
            <div class="step-side"><span class="badge ${r.due === '今天' ? 'warn' : ''}">${r.due}</span></div></div>`).join('')}
        </div></div></div>` : emptyBox('今天没有复习任务', '复习队列会根据错题与掌握度自动排入，保持连续学习即可。');
    }
    return { head, body };
  }

  /* ===========================================================
   *  教师视图
   * =========================================================== */
  function viewDashboard() {
    const d = DB.teacherDash || { kpi: {}, stuckPoints: [], watchList: [] };
    const k = d.kpi || {};
    const head = mainHead('班级学情看板', '数据实时聚合自学生练习与提交 · 截止 ' + today());

    const insightCard = State.insight ? renderInsight() : `<div class="card">
      <div class="card-head">${icon('sparkles', 15)}<h3>学情Agent · 任务执行</h3><div class="spacer"></div>
        <button class="btn sm primary" data-act="runInsight">${icon('play', 14)} 一键生成班级薄弱点报告</button></div>
      <div class="card-body"><div class="note">学情Agent 会聚合全班练习、提交与登录行为，自动识别共性卡点并给出教学调整建议。点击下方按钮开始执行。</div></div>
    </div>`;

    const risk = (d.watchList || []).slice(0, 5);
    const sp = d.stuckPoints || [];

    const body = `
      <div class="grid grid-4">
        <div class="card kpi"><div class="kpi-label">${icon('users', 13)} 班级人数</div><div class="kpi-value">${k.studentCount != null ? k.studentCount : '—'}</div><div class="kpi-delta">在读学生</div></div>
        <div class="card kpi"><div class="kpi-label">${icon('target', 13)} 平均掌握度</div><div class="kpi-value">${k.avgMastery != null ? k.avgMastery : '—'}</div><div class="kpi-delta">全知识点均值</div></div>
        <div class="card kpi"><div class="kpi-label">${icon('checkcircle', 13)} 作业提交率</div><div class="kpi-value">${k.submitRate != null ? k.submitRate + '%' : '—'}</div><div class="kpi-delta">全部非草稿作业</div></div>
        <div class="card kpi"><div class="kpi-label">${icon('alert', 13)} 待处理预警</div><div class="kpi-value" style="color:var(--danger)">${k.riskCount != null ? k.riskCount : '—'}</div><div class="kpi-delta">学情Agent 生成</div></div>
      </div>

      <div class="split">
        <div class="card"><div class="card-head">${icon('flame', 15)}<h3>班级卡点知识点 TOP 6</h3><div class="spacer"></div>
          ${sp.length ? `<span class="badge danger">${sp[0].stuckRate}% 卡在「${sp[0].name}」</span>` : ''}</div>
          <div class="card-body"><div class="mini-list">
            ${sp.map(p => `<div class="mini-row">
              <span class="nm">${h(p.name)}</span>
              <div class="bar ${bcls(p.avg)}"><i style="width:${p.avg}%"></i></div>
              <span class="vl">${p.avg}</span>
              <span class="badge ${p.stuckRate > 50 ? 'danger' : p.stuckRate > 35 ? 'warn' : ''}">${p.stuckRate}%</span>
            </div>`).join('') || '<div style="font-size:12.5px;color:var(--text-3)">暂无数据</div>'}
          </div>
          <div class="note warn" style="margin-top:12px">卡点率 = 该知识点掌握度低于 60 分的学生人数占比。</div>
          </div></div>

        <div class="card"><div class="card-head">${icon('alert', 15)}<h3>重点关注学生</h3><div class="spacer"></div>
          <button class="btn sm ghost" data-act="section" data-val="warnings">查看全部 ${icon('chevronR', 13)}</button></div>
          <div class="card-body">
            ${risk.map(s => `<div class="mini-row" style="padding:7px 0;cursor:pointer" data-act="studentPick" data-val="${s.id}">
              <span class="nm">${h(s.name)}</span>
              <div class="bar ${bcls(s.mastery)}"><i style="width:${s.mastery}%"></i></div>
              <span class="vl">${s.mastery}</span>
              <span class="badge ${s.risk === 'high' ? 'danger' : 'warn'}">${s.absDays} 天未登录</span>
            </div>`).join('') || '<div style="font-size:12.5px;color:var(--text-3)">暂无需要重点关注的学生</div>'}
          </div></div>
      </div>

      ${insightCard}`;
    return { head, body };
  }

  function renderInsight() {
    const ins = State.insight;
    const steps = ['聚合全班学生的练习与提交数据', '计算知识点卡点分布与变化趋势', '比对历史识别异常行为', '调用学情Agent 生成报告'];
    if (!ins.done) {
      return `<div class="card"><div class="card-head">${icon('sparkles', 15)}<h3>学情Agent · 任务执行中</h3><div class="spacer"></div>
        <span class="badge brand">${icon('refresh', 12)} 运行中 ${ins.stage}/${steps.length}</span></div>
        <div class="card-body"><div class="timeline">
          ${steps.map((s, i) => `<div class="tl-item">
            <div class="tl-dot ${i < ins.stage ? 'ok' : ''}">${i < ins.stage ? icon('check', 12) : i === ins.stage ? '<span class="typing"><i></i><i></i><i></i></span>' : i + 1}</div>
            <div class="tl-body"><b>${s}</b><p style="color:${i < ins.stage ? 'var(--ok)' : 'var(--text-3)'}">${i < ins.stage ? '已完成' : i === ins.stage ? '执行中…' : '排队中'}</p></div>
          </div>`).join('')}
        </div></div></div>`;
    }
    return `<div class="card"><div class="card-head">${icon('sparkles', 15)}<h3>学情Agent · 班级薄弱点报告</h3><div class="spacer"></div>
      <span class="badge ok">${icon('check', 12)} 已完成</span>
      <button class="btn sm ghost" data-act="runInsight">${icon('refresh', 14)} 重新生成</button></div>
      <div class="card-body">
        ${ins.mock ? '<div class="note warn" style="margin-bottom:10px">当前为离线演示模式，报告由规则引擎生成；配置 DEEPSEEK_API_KEY 后由学情Agent 智能生成。</div>' : ''}
        <div class="agent-text" style="font-size:13px;line-height:1.8">${md(ins.report || '')}</div>
      </div></div>`;
  }

  function viewAssignments() {
    const head = mainHead('作业管理', '结构化发布 + Rubric 驱动评分',
      '<button class="btn sm" data-act="openCompose" title="发布新作业：支持单选/多选/填空/判断/简答/编程题组卷">' + icon('edit', 14) + ' 发布新作业</button>');
    if (!DB.assignments.length) {
      return { head, body: emptyBox('还没有作业', '点击右上角「发布新作业」开始组卷，发布后学生侧会立即看到。') };
    }
    const body = DB.assignments.map(a => {
      const pct = Math.round(a.submitted / a.total * 100);
      const stBadge = a.status === 'draft' ? '<span class="badge">草稿</span>'
        : a.status === 'ongoing' ? '<span class="badge info">进行中</span>' : '<span class="badge ok">已截止</span>';
      const isQ = a.questionCount > 0;
      // 题目型作业展示题型分布与题量/总分；Rubric 型作业展示原评分标准
      const detail = isQ
        ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
            ${(a.questions || []).reduce((acc, q) => { const g = acc.find(x => x[0] === q.type); g ? g[1]++ : acc.push([q.type, 1]); return acc; }, [])
              .map(g => '<span class="badge">' + (QTYPES[g[0]] ? QTYPES[g[0]].label : g[0]) + ' × ' + g[1] + '</span>').join('')}
            <span class="badge brand">共 ${a.questionCount} 题 · 总分 ${a.totalScore}</span>
            ${a.allowLate ? '<span class="badge warn">允许补交</span>' : ''}
          </div>`
        : `<div style="font-size:12px;font-weight:600;margin-bottom:6px;color:var(--text-2)">Rubric（满分 100）</div>
          <div class="mini-list">
            ${a.rubric.map(r => `<div class="mini-row"><span class="nm">${h(r.name)}</span>
              <span style="flex:1;font-size:11.5px;color:var(--text-3)">${h(r.desc)}</span>
              <span class="vl">${r.max}</span></div>`).join('')}
          </div>`;
      return `<div class="card">
        <div class="card-head">${icon('clipboard', 15)}<h3>${h(a.title)}</h3><div class="spacer"></div>
          <button class="btn sm ghost" data-act="asMore" data-val="${a.id}" title="更多操作">${icon('dots', 14)} 更多</button>${stBadge}</div>
        <div class="card-body">
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
            ${a.kp.map(k => '<span class="badge brand">' + kpName(k) + '</span>').join('')}
            <span class="badge">${icon('clock', 12)} ${isQ ? (a.startAt ? h(a.startAt) + ' ~ ' : '') : '截止 '}${h(a.due)}</span>
          </div>
          ${a.desc ? `<div style="font-size:13px;color:var(--text-2);line-height:1.7;margin-bottom:12px">${h(a.desc)}</div>` : ''}
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
            <div class="bar" style="flex:1"><i style="width:${pct}%"></i></div>
            <span style="font-size:12.5px;font-weight:600">${a.submitted}/${a.total}</span>
          </div>
          ${detail}
          <div style="margin-top:12px;display:flex;gap:8px">
            ${a.status === 'draft'
              ? '<button class="btn primary sm" data-act="publishDraft" data-val="' + a.id + '">' + icon('send', 14) + ' 正式发布给学生</button>'
              : '<button class="btn sm" data-act="gotoSubs" data-val="' + a.id + '">' + icon('eye', 14) + ' 查看提交与批改</button>'}
            <button class="btn sm ghost" data-act="subAsPick" data-val="${a.id}">在左侧选中</button>
          </div>
        </div></div>`;
    }).join('');
    return { head, body };
  }

  function viewSubmissions() {
    const a = DB.assignments.find(x => x.id === State.filters.subAs) || DB.assignments[0];
    if (!a) {
      return {
        head: mainHead('提交批改', '按作业查看学生提交与批改',
          '<button class="btn primary sm" data-act="openCompose">' + icon('plus', 14) + ' 发布新作业</button>'),
        body: emptyBox('还没有作业', '先在「作业管理」发布作业，学生提交后会实时出现在这里，支持 AI 初评 + Rubric 人工复核。')
      };
    }
    const list = DB.submissions.filter(s => s.asId === a.id);
    const pend = list.filter(s => s.status === 'pending').length;
    // AI 批量初评完成后进入 ai_reviewed（待教师复核）——单列计数，与待批改区分
    const reviewed = list.filter(s => s.status === 'ai_reviewed').length;
    const head = mainHead('提交批改', h(a.title) + ' · 共 ' + list.length + ' 条记录 · ' + pend + ' 份待批改');

    if (!list.length) {
      return { head, body: emptyBox('还没有学生提交', '作业发布后学生的提交会实时出现在这里，支持 AI 初评 + Rubric 人工复核。') };
    }
    const body = `<div class="card"><div class="card-head">${icon('inbox', 15)}<h3>提交列表</h3><div class="spacer"></div>
      <span class="badge warn">${pend} 待批改</span>
      ${reviewed ? `<span class="badge brand">${reviewed} AI初评待复核</span>` : ''}
      ${pend ? '<button class="btn sm primary" data-act="batchAi">AI 批量初评</button>' : ''}</div>
      <div style="overflow-x:auto"><table class="table">
        <thead><tr><th>学生</th><th>提交时间</th><th class="num">次数</th><th class="num">相似度</th><th>时段</th><th class="num">AI 初评</th><th class="num">最终分</th><th>状态</th></tr></thead>
        <tbody>${list.map(s => {
          const stb = s.status === 'graded' ? '<span class="badge ok">已批改</span>'
            : s.status === 'ai_reviewed' ? '<span class="badge brand">AI初评完成 · 待复核</span>'
            : s.status === 'pending' ? '<span class="badge warn">待批改</span>' : '<span class="badge danger">未提交</span>';
          return `<tr data-act="openSub" data-val="${s.id}">
            <td><b>${s.name}</b>${s.sid === String(DB.me.id) ? ' <span class="badge brand">示例学生</span>' : ''}</td>
            <td style="color:var(--text-3)">${s.submittedAt || '—'}</td>
            <td class="num">${s.attempts}</td>
            <td class="num" style="color:${s.similarity > 60 ? 'var(--danger)' : s.similarity > 30 ? 'var(--warn)' : 'var(--text-2)'};font-weight:${s.similarity > 60 ? 700 : 400}">${s.similarity}%</td>
            <td style="color:${s.timeSlot === '凌晨时段' || s.timeSlot === '深夜时段' ? 'var(--danger)' : 'var(--text-2)'}">${s.timeSlot}</td>
            <td class="num">${s.aiScore != null ? s.aiScore : '—'}</td>
            <td class="num" style="font-weight:700">${s.score != null ? s.score : '—'}</td>
            <td>${stb}</td></tr>`;
        }).join('')}</tbody>
      </table></div>
      <div class="card-body"><div class="note">点击任意一行打开批改抽屉：查看代码 → 参考 AI 初评 → 按 Rubric 打分 → 填写评语 → 发布反馈（学生侧实时可见）。</div></div>
    </div>`;
    return { head, body };
  }

  function viewWarnings() {
    const f = State.filters.warn;
    let list = DB.warnings.slice();
    if (f === 'high') list = list.filter(w => w.level === 'high' && !w.handled);
    else if (f === 'mid') list = list.filter(w => w.level === 'mid' && !w.handled);
    else if (f === 'handled') list = list.filter(w => w.handled);
    else list = DB.warnings.slice();   // 全部：含已处理，便于回看处理结果

    const head = mainHead('预警中心', '学情Agent 自动生成 · 每日 08:00 刷新',
      '<button class="btn sm" data-act="pushAll">' + icon('bell', 14) + ' 一键推送提醒</button>');

    if (!list.length) {
      return { head, body: emptyBox('没有待处理的预警', '当前筛选条件下没有预警记录。学情Agent 会持续监测登录、提交与相似度的异常变化。') };
    }
    const body = list.map(w => `<div class="card">
      <div class="card-head">
        <span class="badge ${w.level === 'high' ? 'danger' : 'warn'}">${icon('alert', 12)} ${w.level === 'high' ? '高危' : '关注'}</span>
        <h3>${h(w.type)} · ${h(w.name)}</h3><div class="spacer"></div>
        <span class="badge">${w.time}</span>
      </div>
      <div class="card-body">
        <div style="font-size:13px;color:var(--text-2);line-height:1.7">${h(w.desc)}</div>
        <div style="margin-top:12px;display:flex;gap:8px">
          ${w.handled
            ? '<span class="badge ok">' + icon('check', 12) + ' 已处理</span>'
            : `<button class="btn sm primary" data-act="warnHandle" data-val="${w.id}">${icon('check', 14)} 标记已处理</button>
               <button class="btn sm" data-act="warnNotify" data-val="${w.id}">${icon('bell', 14)} 推送提醒给学生</button>
               ${w.sid ? '<button class="btn sm ghost" data-act="studentPick" data-val="' + w.sid + '">查看该生档案</button>' : ''}`}
        </div>
      </div></div>`).join('');
    return { head, body };
  }

  function viewStudents() {
    const head = mainHead('班级学生', '点击任意学生查看档案与知识点明细');
    const sel = DB.students.find(s => s.id === State.activeStudent);
    const body = `<div class="card"><div class="card-head">${icon('users', 15)}<h3>学生列表</h3><div class="spacer"></div>
      <span class="badge">${DB.students.length} 人（示例数据）</span></div>
      <div style="overflow-x:auto"><table class="table">
        <thead><tr><th>学生</th><th>掌握度</th><th class="num">提交率</th><th class="num">连续未登录</th><th>近 7 日活跃</th><th>薄弱知识点</th><th>风险</th></tr></thead>
        <tbody>${DB.students.map(s => `<tr data-act="studentPick" data-val="${s.id}" class="${State.activeStudent === s.id ? 'on' : ''}">
          <td><b>${s.name}</b>${s.id === 's01' ? ' <span class="badge brand">我</span>' : ''}</td>
          <td style="width:150px"><div style="display:flex;align-items:center;gap:8px">
            <div class="bar ${bcls(s.mastery)}" style="flex:1"><i style="width:${s.mastery}%"></i></div><span style="font-weight:600">${s.mastery}</span></div></td>
          <td class="num">${s.submitRate}%</td>
          <td class="num" style="color:${s.absDays >= 3 ? 'var(--danger)' : s.absDays >= 1 ? 'var(--warn)' : 'var(--text-2)'}">${s.absDays} 天</td>
          <td><div class="spark">${s.trend.map(v => '<i style="height:' + Math.max(4, v * 6) + 'px"></i>').join('')}</div></td>
          <td>${s.weak.length ? s.weak.map(k => '<span class="badge" style="margin-right:4px">' + kpName(k) + '</span>').join('') : '<span style="color:var(--text-3)">—</span>'}</td>
          <td><span class="badge ${s.risk === 'high' ? 'danger' : s.risk === 'mid' ? 'warn' : 'ok'}">${s.risk === 'high' ? '高危' : s.risk === 'mid' ? '关注' : '正常'}</span></td>
        </tr>`).join('')}</tbody>
      </table></div></div>
      ${sel ? `<div class="card"><div class="card-head">${icon('user', 15)}<h3>${sel.name} · 学生档案</h3>
        <button class="btn sm ghost" data-act="resetPwdModal" ${sel ? '' : 'disabled'} title="更多操作">${icon('dots', 14)} 更多</button><div class="spacer"></div>
        <span class="badge ${sel.risk === 'high' ? 'danger' : sel.risk === 'mid' ? 'warn' : 'ok'}">${sel.risk === 'high' ? '高危' : sel.risk === 'mid' ? '关注' : '正常'}</span></div>
        <div class="card-body">
          <div class="stat-row" style="margin-bottom:14px">
            <div class="stat-item"><div class="sv">${sel.mastery}</div><div class="sl">平均掌握度</div></div>
            <div class="stat-item"><div class="sv">${sel.submitRate}%</div><div class="sl">作业提交率</div></div>
            <div class="stat-item"><div class="sv">${sel.attempts}</div><div class="sl">练习提交次数</div></div>
            <div class="stat-item"><div class="sv" style="color:${sel.absDays >= 3 ? 'var(--danger)' : 'var(--text)'}">${sel.absDays}</div><div class="sl">连续未登录（天）</div></div>
          </div>
          <div style="font-size:12px;font-weight:600;margin-bottom:6px">知识点掌握情况（按班级均值估算）</div>
          <div class="mini-list">
            ${DB.knowledgePoints.slice(0, 8).map(k => {
              const base = sel.mastery + ((k.id.length * 7 + sel.name.charCodeAt(0)) % 13) - 6;
              const v = Math.max(5, Math.min(98, base));
              return `<div class="mini-row"><span class="nm">${k.name}</span>
                <div class="bar ${bcls(v)}"><i style="width:${v}%"></i></div><span class="vl">${v}</span></div>`;
            }).join('')}
          </div>
          <div class="note ${sel.risk === 'low' ? 'ok' : 'warn'}" style="margin-top:12px">
            ${sel.risk === 'low' ? '该生状态良好，无需干预。' : '建议：课后单独沟通 + 推送 1 次针对性复习包，3 天后复查活跃度是否回升。'}
          </div>
        </div></div>` : ''}`;
    return { head, body };
  }

  /* ===========================================================
   *  渲染：右侧上下文面板
   * =========================================================== */
  function renderCtx() {
    const box = $('#ctx');
    if (!State.rightOpen) {
      box.className = 'ctx collapsed';
      box.innerHTML = '<div class="ctx-rail">' +
        [['knowledge', 'target'], ['homework', 'clipboard'], ['code', 'code']].map(t =>
          `<button class="icon-btn ${State.rightTab === t[0] ? 'active' : ''}" data-act="ctxTab" data-val="${t[0]}" title="${t[0]}">${icon(t[1], 17)}</button>`
        ).join('') + '</div>';
      return;
    }
    box.className = 'ctx';
    const tabs = [
      ['knowledge', '知识点', 'target'],
      ['homework', '作业', 'clipboard'],
      ['code', '代码片段', 'code']
    ];
    let inner = '';
    if (State.rightTab === 'knowledge') inner = ctxKnowledge();
    else if (State.rightTab === 'homework') inner = ctxHomework();
    else inner = ctxCode();

    box.innerHTML = `<div class="ctx-head">
        <div class="ctx-tabs">${tabs.map(t => `<button class="ctx-tab ${State.rightTab === t[0] ? 'on' : ''}" data-act="ctxTab" data-val="${t[0]}">${icon(t[2], 14)}${t[1]}</button>`).join('')}</div>
        <button class="icon-btn" data-act="toggleCtx" title="折叠">${icon('chevronR', 16)}</button>
      </div>
      <div class="ctx-body">${inner}</div>`;
  }

  function ctxKnowledge() {
    if (State.role === 'teacher') {
      const sel = DB.students.find(s => s.id === State.activeStudent);
      return `<div class="ctx-card"><h4>班级卡点知识点</h4>
        ${DB.classStuckPoints.slice(0, 5).map(p => `<div class="mini-row" style="padding:4px 0">
          <span class="nm">${p.name}</span>
          <div class="bar ${bcls(p.avg)}"><i style="width:${p.avg}%"></i></div>
          <span class="vl">${p.avg}</span></div>`).join('')}
      </div>
      ${sel ? `<div class="ctx-card"><h4>当前学生</h4>
        <div class="ctx-kv"><span>姓名</span><span>${sel.name}</span></div>
        <div class="ctx-kv"><span>平均掌握度</span><span>${sel.mastery}</span></div>
        <div class="ctx-kv"><span>提交率</span><span>${sel.submitRate}%</span></div>
        <div class="ctx-kv"><span>连续未登录</span><span>${sel.absDays} 天</span></div>
        <div class="ctx-kv"><span>薄弱点</span><span>${sel.weak.map(kpName).join('、') || '—'}</span></div>
      </div>` : '<div class="ctx-card"><h4>当前学生</h4><div style="font-size:12.5px;color:var(--text-3)">在「班级学生」或「预警中心」中选择一名学生查看档案。</div></div>'}`;
    }
    const s = session();
    const id = s ? s.kp : State.activeKp;
    const k = kp(id);
    return `<div class="ctx-card"><h4>当前知识点</h4>
      <div style="font-size:14px;font-weight:650;margin-bottom:4px">${k.name}</div>
      <div style="display:flex;align-items:center;gap:8px;margin:8px 0">
        <div class="bar ${bcls(k.mastery)}" style="flex:1"><i style="width:${k.mastery}%"></i></div>
        <span style="font-weight:700">${k.mastery}</span></div>
      <div style="font-size:12px;color:var(--text-3);margin-bottom:10px">${mtext(k.mastery)}</div>
      <div style="font-size:12.5px;color:var(--text-2);line-height:1.65">${h(k.desc)}</div>
    </div>
    <div class="ctx-card"><h4>前置依赖</h4>
      ${(k.deps || []).length ? k.deps.map(d => `<div class="ctx-kv"><span>${kpName(d)}</span>
        <span style="color:${kp(d).mastery >= 60 ? 'var(--ok)' : 'var(--danger)'}">${kp(d).mastery} 分</span></div>`).join('')
        : '<div style="font-size:12.5px;color:var(--text-3)">无前置依赖（根节点）</div>'}
    </div>
    ${s ? `<div class="ctx-card"><h4>当前会话进度</h4>
      ${s.steps.map((x, i) => `<div class="mini-row" style="padding:4px 0">
        <span class="nm" style="width:132px">${h(x.title.slice(0, 11))}${x.title.length > 11 ? '…' : ''}</span>
        <span class="badge ${x.status === 'done' ? 'ok' : x.status === 'active' ? 'brand' : ''}">${x.status === 'done' ? '完成' : x.status === 'active' ? '进行中' : '待开始'}</span></div>`).join('')}
      <div class="ctx-kv" style="margin-top:8px"><span>会话状态</span><span>${s.status === 'done' ? '已完成' : '进行中'}</span></div>
    </div>` : ''}
    <div class="ctx-card"><h4>参考资源</h4>
      ${(k.resources || []).map(r => '<div style="font-size:12.5px;padding:3px 0;color:var(--info)">· ' + h(r) + '</div>').join('') || '<div style="font-size:12.5px;color:var(--text-3)">暂无</div>'}
    </div>`;
  }

  function ctxHomework() {
    if (State.role === 'teacher') {
      const a = DB.assignments.find(x => x.id === State.filters.subAs) || DB.assignments[0];
      if (!a) {
        return '<div class="ctx-card"><h4>当前作业</h4><div style="font-size:12.5px;color:var(--text-3)">还没有作业，发布后这里会显示作业详情与 Rubric 评分标准。</div></div>';
      }
      return `<div class="ctx-card"><h4>当前作业</h4>
        <div style="font-size:13.5px;font-weight:650;margin-bottom:6px">${h(a.title)}</div>
        <div class="ctx-kv"><span>状态</span><span>${a.status === 'draft' ? '草稿' : a.status === 'ongoing' ? '进行中' : '已截止'}</span></div>
        <div class="ctx-kv"><span>截止</span><span>${h(a.due)}</span></div>
        <div class="ctx-kv"><span>提交</span><span>${a.submitted}/${a.total}</span></div>
      </div>
      <div class="ctx-card"><h4>Rubric 评分标准</h4>
        ${a.rubric.map(r => `<div class="ctx-kv"><span>${h(r.name)}</span><span>${r.max} 分</span></div>`).join('')}
        <div class="note" style="margin-top:10px">评分任务锁定固定模型版本、Temperature=0，Prompt 模板快照可回溯审计。</div>
      </div>`;
    }
    const list = DB.assignments.filter(a => a.status !== 'draft');
    const a = list.find(x => homeworkStatusOf(x.id).key !== 'graded') || list[0];
    if (!a) return '<div class="ctx-card"><h4>作业</h4><div style="font-size:12.5px;color:var(--text-3)">教师还没有发布作业。</div></div>';
    const st = homeworkStatusOf(a.id);
    const sub = subOf(a.id);
    return `<div class="ctx-card"><h4>当前作业</h4>
      <div style="font-size:13.5px;font-weight:650;margin-bottom:6px">${h(a.title)}</div>
      <div class="ctx-kv"><span>状态</span><span class="badge ${st.cls}">${st.label}</span></div>
      <div class="ctx-kv"><span>截止</span><span>${h(a.due)}</span></div>
      <div class="ctx-kv"><span>知识点</span><span style="text-align:right">${a.kp.map(kpName).join('、')}</span></div>
      ${st.key === 'graded' && sub ? `<div class="ctx-kv"><span>得分</span><span style="font-weight:700;color:var(--brand)">${sub.score}/100</span></div>
        <div class="ctx-kv"><span>批改人</span><span>${DB.teacher.name}</span></div>` : ''}
    </div>
    <div class="ctx-card"><h4>Rubric 评分标准</h4>
      ${a.rubric.map(r => `<div class="ctx-kv"><span>${h(r.name)}</span>
        <span>${sub && sub.rubricScores ? (sub.rubricScores[r.name] || 0) + '/' + r.max : '—/' + r.max}</span></div>`).join('')}
    </div>
    <div class="ctx-card"><h4>提交要求</h4>
      <div style="font-size:12.5px;color:var(--text-2);line-height:1.65">${h(a.desc)}</div>
    </div>`;
  }

  function ctxCode() {
    if (State.role === 'teacher' && State.drawer) {
      const s = DB.submissions.find(x => x.id === State.drawer.subId);
      if (s) return `<div class="ctx-card"><h4>正在批改 · ${s.name}</h4>
        <div class="ctx-kv"><span>相似度</span><span style="color:${s.similarity > 60 ? 'var(--danger)' : 'var(--text)'}">${s.similarity}%</span></div>
        <div class="ctx-kv"><span>提交次数</span><span>${s.attempts}</span></div>
        <div class="ctx-kv"><span>AI 初评</span><span>${s.aiScore != null ? s.aiScore : '—'}</span></div>
        <pre class="code-block" style="margin-top:10px;font-size:11.5px;max-height:280px">${h(s.code || '（未提交）')}</pre>
      </div>`;
    }
    return `<div class="ctx-card"><h4>上下文代码片段</h4>
      <div style="font-size:12px;color:var(--text-3);margin-bottom:10px">随会话与作业自动收集，点击可展开查看</div>
      ${DB.snippets.map(sn => `<div style="margin-bottom:12px;cursor:pointer" data-act="snip" data-val="${sn.id}">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
          <span class="badge info">${sn.lang}</span>
          <span style="font-size:12.5px;font-weight:600">${h(sn.title)}</span></div>
        <div style="font-size:11.5px;color:var(--text-3);margin-bottom:6px">${h(sn.from)}</div>
        <pre class="code-block" style="font-size:11.5px">${h(sn.code)}</pre>
      </div>`).join('')}
    </div>`;
  }

  /* ===========================================================
   *  弹窗 / 抽屉
   * =========================================================== */
  function renderOverlays() {
    const box = $('#overlay');
    let html = '';
    if (State.compose) html += renderCompose();
    if (State.answer) html += renderAnswer();
    if (State.modal) html += renderModal();
    if (State.drawer) html += renderDrawer();
    box.innerHTML = html;
    // 装载代码编辑器（作业答题页 / 弹窗内的编程题输入框）
    mountCodeEditors();
  }

  // newSession 弹窗的知识点列表（按 d.q 过滤）：初始渲染与搜索输入的局部刷新共用，
  // 避免搜索时整窗 innerHTML 重建重放弹窗入场动画（闪屏）并丢失输入焦点。
  function newSessionPickList() {
    const d = (State.modal && State.modal.data) || {};
    const kps = d.kps || [];
    const list = DB.knowledgePoints.filter(k => !d.q || k.name.indexOf(d.q) >= 0);
    // 按一级模块分组展示课程知识点全集；选中态高亮，点击多选（含细化层级节点）
    const groups = DB.modules.map(m => {
      const ks = list.filter(k => k.module === m.id);
      if (!ks.length) return '';
      return `<div class="ns-group">
        <div class="ns-group-title" style="border-left:3px solid ${m.color}">${h(m.name)}<span>${ks.length}</span></div>
        ${ks.map(k => `<div class="pick ${kps.indexOf(k.id) >= 0 ? 'on' : ''}" data-act="pickKp" data-val="${k.id}">
          <div class="pm"><div class="pn">${k.name}</div><div class="pd">L${k.level} · ${h(m.name)}</div></div>
          <div style="text-align:right">
            <div style="font-size:15px;font-weight:700;color:${!k.hasData ? 'var(--text-3)' : k.mastery >= 60 ? 'var(--ok)' : 'var(--danger)'}">${k.hasData ? k.mastery : '—'}</div>
            <div style="font-size:11px;color:var(--text-3)">${k.hasData ? mtext(k.mastery) : '暂无数据'}</div></div>
        </div>`).join('')}
      </div>`;
    }).join('');
    return groups || '<div class="empty"><div class="empty-title">没有匹配的知识点</div></div>';
  }

  /* 教师端反馈浮窗内容区 HTML（列表 + AI 总结区块）。
     供 renderModal 首次渲染与后续「局部刷新」共用：局部刷新只重写 .modal-body、
     保留弹窗外壳，避免整窗 innerHTML 重建重放 pop 入场动画导致闪屏 */
  function fbListBodyHtml(d) {
    const FB = { BUG: ['系统bug', 'danger'], SUGGESTION: ['功能优化建议', 'warn'], FEATURE: ['新增功能需求', 'brand'] };
    const list = d.list;
    let body = list == null
      ? '<div style="padding:24px;text-align:center;color:var(--text-3);font-size:13px">反馈加载中…</div>'
      : list.length
        ? `<div class="fb-list">${list.map(f => {
            const [tl, bc] = FB[f.type] || [f.type, ''];
            return `<div class="fb-item">
              <div class="fb-item-head">
                <span class="fb-who">${h(f.studentName)}</span>
                <span style="font-size:11.5px;color:var(--text-3)">${h(f.studentNo)}</span>
                <span class="badge ${bc}">${tl}</span>
                <span class="fb-time">${h(f.createdAt)}</span>
              </div>
              <div class="fb-content">${h(f.content)}</div>
            </div>`;
          }).join('')}</div>`
        : '<div style="padding:24px;text-align:center;color:var(--text-3);font-size:13px">暂无学生反馈</div>';
    if (d.summary) body += `<div class="fb-summary"><h5>${icon('sparkles', 13)} AI 总结（共 ${list ? list.length : 0} 条）</h5><div class="agent-text" style="font-size:13px">${md(d.summary)}</div></div>`;
    return body;
  }

  function renderModal() {
    const m = State.modal, d = m.data || {};
    let title = '', body = '', foot = '';
    if (m.type === 'newSession') {
      const n = (d.kps || []).length;
      title = '新建学习会话 · 选择知识点（可多选 / 可不选）';
      body = `<div class="note" style="margin-bottom:10px">选择 <b>1 个</b>知识点攻克单一短板；选择 <b>多个</b>生成跨知识点路径；<b>不选</b>则由智能体按你的学习数据生成覆盖全部知识点的学习路径。${n ? '（已选 ' + n + ' 个）' : ''}</div>
        <div class="field" style="margin-bottom:12px">${icon('search', 15)}
          <input placeholder="搜索知识点，如：并发、集合、JVM" value="${h(d.q || '')}" data-bind="modal" data-key="q"></div>
        <div class="pick-list">${newSessionPickList()}</div>`;
      foot = `<button class="btn" data-act="closeModal">取消</button>
        <button class="btn primary" data-act="createSession">${icon('sparkles', 15)} 创建并生成学习路径${n ? '（' + n + ' 个知识点）' : '（全部知识点）'}</button>`;

    } else if (m.type === 'changePassword') {
      title = '账号设置 · 修改密码';
      body = `<div class="form-row"><label>原密码</label>
          <input class="input" type="password" autocomplete="current-password" placeholder="请输入当前密码" value="${h(d.oldPwd || '')}" data-bind="modal" data-key="oldPwd"></div>
        <div class="form-row"><label>新密码</label>
          <input class="input" type="password" autocomplete="new-password" placeholder="6-50 位，建议字母 + 数字 + 符号组合" value="${h(d.newPwd || '')}" data-bind="modal" data-key="newPwd">
          <div class="hint">长度 6-50 位</div></div>
        <div class="form-row"><label>确认新密码</label>
          <input class="input" type="password" autocomplete="new-password" placeholder="请再次输入新密码" value="${h(d.newPwd2 || '')}" data-bind="modal" data-key="newPwd2"></div>`;
      foot = `<button class="btn" data-act="closeModal" ${d.busy ? 'disabled' : ''}>取消</button>
        <button class="btn primary" data-act="doChangePassword" ${d.busy ? 'disabled' : ''}>${icon('check', 15)} ${d.busy ? '提交中…' : '确认修改'}</button>`;

    } else if (m.type === 'clearSessions') {
      title = '清空全部对话';
      body = `<div class="note" style="margin-bottom:12px">即将删除你的 <b>${DB.sessions.length}</b> 个学习会话及全部对话消息，<b style="color:var(--danger)">操作不可恢复</b>。你的练习记录、作业、知识掌握度等学习数据不受影响。</div>
        <div class="hint">清空后可随时新建会话，智能体会基于你的最新学习数据重新诊断规划。</div>`;
      foot = `<button class="btn" data-act="closeModal" ${d.busy ? 'disabled' : ''}>取消</button>
        <button class="btn danger" data-act="doClearSessions" ${d.busy ? 'disabled' : ''}>${icon('trash', 15)} ${d.busy ? '清空中…' : '确认清空'}</button>`;

    } else if (m.type === 'resetPwd') {
      title = '重置学生密码';
      body = `<div class="note warn" style="margin-bottom:12px">确定要将学生 <b>${h(d.name)}</b> 的登录密码重置为统一初始密码 <b>GZgs@2026</b> 吗？</div>
        <div class="hint">重置后该学生需使用学号 + 初始密码 GZgs@2026 重新登录，登录后可在账号设置中自行修改密码。</div>`;
      foot = `<button class="btn" data-act="closeModal" ${d.busy ? 'disabled' : ''}>取消</button>
        <button class="btn danger" data-act="doResetPwd" ${d.busy ? 'disabled' : ''}>${d.busy ? '重置中…' : '确认重置'}</button>`;

    } else if (m.type === 'submitHw') {
      const a = DB.assignments.find(x => x.id === m.data.asId);
      title = '提交作业 · ' + a.title;
      body = `<div class="note" style="margin-bottom:12px">提交后会进入教师侧的「提交批改」队列，批改完成将实时回流到你的作业页与会话。</div>
        <div class="form-row"><label>代码 / 答卷</label>
          ${codeEditorHtml('data-bind="modal" data-key="code"', d.code || '', { minHeight: 220, placeholder: '在此编写代码 / 答卷…' })}
          <div class="hint">提交后可等待 AI 初评与教师复核，支持多次重新提交（次数教师端可见）。</div></div>`;
      foot = `<button class="btn" data-act="closeModal">取消</button>
        <button class="btn primary" data-act="doSubmitHw">${icon('send', 15)} 确认提交</button>`;

    } else if (m.type === 'delAs') {
      title = '删除作业';
      body = `<div class="note warn" style="margin-bottom:12px">确定要删除作业 <b>${h(d.title)}</b> 吗？<b style="color:var(--danger)">操作不可恢复</b>。</div>
        <div class="hint">${d.submitted
          ? '该作业已有 <b>' + d.submitted + '</b> 份学生提交，删除后提交记录与评分将一并移除。'
          : '该作业暂无学生提交。'}</div>`;
      foot = `<button class="btn" data-act="closeModal" ${d.busy ? 'disabled' : ''}>取消</button>
        <button class="btn danger" data-act="doDelAs" ${d.busy ? 'disabled' : ''}>${icon('trash', 15)} ${d.busy ? '删除中…' : '确认删除'}</button>`;

    } else if (m.type === 'answerConfirm') {
      title = '提交作业';
      body = `<div class="note" style="margin-bottom:12px">即将提交作业 <b>${h(d.title)}</b>。</div>
        <div class="hint">已作答 <b>${d.done}</b> / ${d.total} 题${d.done < d.total ? '，未作答的题目将记为空' : ''}。提交后客观题（单选/多选/判断）将自动判分，主观题由教师批改；支持在批改完成前重新提交。</div>`;
      foot = `<button class="btn" data-act="closeModal" ${d.busy ? 'disabled' : ''}>取消，继续作答</button>
        <button class="btn primary" data-act="ansDoSubmit" ${d.busy ? 'disabled' : ''}>${icon('send', 15)} ${d.busy ? '提交中…' : '确认提交'}</button>`;
    } else if (m.type === 'importClass') {
      title = '添加班级 · 上传名单';
      const f = d.file;
      body = `<div class="note" style="margin-bottom:12px">上传包含学生名单的 Excel（.xlsx / .xls）或 Word（.docx / .doc）文档，系统将自动识别学号与姓名并创建班级。文档需包含「学号 + 姓名」列（或按行书写），可选「班级」列指定班级名称；学生账号为学号，初始密码统一为 GZgs@2026。</div>
        <div class="form-row"><label>名单文档</label>
          <div class="import-file ${f ? 'has' : ''}" id="importDrop">
            <input type="file" id="importFileInput" accept=".xlsx,.xls,.docx,.doc" style="display:none" data-import-file>
            <button class="btn sm" data-act="pickImportFile">${icon('file', 14)} 选择文件</button>
            <span class="if-name">${f ? h(f.name) + '（' + (f.size / 1024).toFixed(1) + ' KB）' : '未选择文件'}</span>
          </div>
          <div class="hint">支持 .xlsx / .xls / .docx / .doc，最大 10MB</div></div>
        <div class="progress-wrap" id="importProgress" style="display:${d.uploading ? '' : 'none'}">
          <div class="progress-track"><div class="progress-bar" id="importBar" style="width:${d.progress || 0}%"></div></div>
          <div style="font-size:12px;color:var(--text-3)">${d.progress >= 100 ? '服务器解析中…' : '上传中 ' + (d.progress || 0) + '%'}</div>
        </div>`;
      foot = `<button class="btn" data-act="closeModal">取消</button>
        <button class="btn primary" data-act="doImportClass" ${f && !d.uploading ? '' : 'disabled'}>${icon('send', 15)} ${d.uploading ? '上传中…' : '开始导入'}</button>`;

    } else if (m.type === 'feedback') {
      title = '建议反馈';
      const FB = [['BUG', '系统bug'], ['SUGGESTION', '功能优化建议'], ['FEATURE', '新增功能需求']];
      body = `<div class="note" style="margin-bottom:12px">你的反馈会直达教师端，帮助我们把平台做得更好。仅用于本系统教学改进。</div>
        <div class="form-row"><label>反馈类型</label>
          <div class="fb-types">${FB.map(([v, l]) => `<button class="fb-type ${d.type === v ? 'on' : ''}" data-act="fbPickType" data-val="${v}">${l}</button>`).join('')}</div></div>
        <div class="form-row"><label>反馈内容</label>
          <textarea class="textarea" style="min-height:120px" placeholder="请描述你遇到的问题或建议（必填）…" data-bind="modal" data-key="content">${h(d.content || '')}</textarea>
          <div class="hint">内容不能为空，最多 1000 字</div></div>`;
      foot = `<button class="btn" data-act="closeModal" ${d.busy ? 'disabled' : ''}>取消</button>
        <button class="btn primary" data-act="doSubmitFeedback" ${d.busy ? 'disabled' : ''}>${icon('send', 15)} ${d.busy ? '提交中…' : '提交反馈'}</button>`;

    } else if (m.type === 'feedbackList') {
      title = '学生反馈';
      body = fbListBodyHtml(d);
      foot = `<button class="btn" data-act="closeModal">关闭</button>
        <button class="btn primary" data-act="doFeedbackSummary" ${(!d.list || !d.list.length || d.summarizing) ? 'disabled' : ''}>${icon('sparkles', 15)} ${d.summarizing ? 'AI 总结中…' : 'AI 一键总结'}</button>`;

    } else if (m.type === 'settings') {
      title = '系统设置';
      body = `<div class="ctx-card"><h4>智能体编排</h4>
        ${Object.keys(DB.agents).map(k => `<div class="ctx-kv"><span>${DB.agents[k].name}</span><span style="font-size:11.5px">${h(DB.agents[k].desc)}</span></div>`).join('')}
      </div>
      <div class="ctx-card"><h4>模型路由</h4>
        <div class="ctx-kv"><span>意图识别</span><span>规则引擎</span></div>
        <div class="ctx-kv"><span>辅导对话</span><span>DeepSeek · 流式</span></div>
        <div class="ctx-kv"><span>评分与初评</span><span>DeepSeek · T=0</span></div>
        <div class="ctx-kv"><span>复习调度</span><span>SM-2 间隔重复</span></div>
      </div>
      <div class="ctx-card"><h4>账号</h4>
        <div class="ctx-kv"><span>当前用户</span><span>${h(DB.me.realName || '')}（${DB.me.username || ''}）</span></div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
          <button class="btn sm" data-act="accountSettings">${icon('edit', 14)} 账号设置</button>
          <button class="btn sm danger" data-act="logout">${icon('x', 14)} 退出登录</button>
        </div>
      </div>`;
      foot = '<button class="btn primary" data-act="closeModal">关闭</button>';
    }
    return `<div class="mask"><div class="modal">
      <div class="modal-head">${icon('sparkles', 16)}<h3>${h(title)}</h3><div class="spacer"></div>
        <button class="icon-btn" data-act="closeModal">${icon('x', 16)}</button></div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot">${foot}</div>
    </div></div>`;
  }

  function renderDrawer() {
    const sub = DB.submissions.find(x => x.id === State.drawer.subId);
    if (!sub) return '';
    const a = DB.assignments.find(x => x.id === sub.asId);
    const g = State.grading;
    const isQ = a.questionCount > 0;
    const graded = sub.status === 'graded';
    const all = DB.submissions;
    const idx = all.findIndex(s => s.id === sub.id);
    const prev = idx > 0 ? all[idx - 1] : null;
    const next = idx >= 0 && idx < all.length - 1 ? all[idx + 1] : null;
    const submittedN = all.filter(s => s.status !== 'missing').length;
    const pendingN = all.filter(s => s.status === 'pending').length;
    const total = a.rubric.reduce((s, r) => s + (Number(g.scores[r.name]) || 0), 0);
    const scorePreview = isQ ? (g.total != null ? g.total : 0) : total;

    /* 主内容区：题目型 = 原始题目与学生作答逐题对照；Rubric 型 = 作业要求 + 提交代码 */
    let main = '';
    if (sub.status === 'missing') {
      main = '<div class="empty" style="padding:80px 20px"><div class="empty-ico">' + icon('inbox', 24) + '</div><div class="empty-title">该学生未提交</div><div class="empty-desc">可直接记 0 分，或回到列表提醒学生补交。</div></div>';
    } else if (isQ) {
      // 学生作答映射：questionId -> value
      const ansMap = {};
      (sub.answers || []).forEach(x => { ansMap[String(x.questionId)] = x.value; });
      main = `<div class="note warn" style="margin-bottom:12px"><b>AI 初评${sub.aiScore != null ? '（' + sub.aiScore + ' 分）' : ''}：</b>${h(sub.aiComment || '尚未初评，可稍后重试')}</div>
        <div class="hw-qlist-head" style="margin-bottom:12px">${icon('file', 14)} 原始题目与学生作答对照 · 共 ${(a.questions || []).length} 题 · 总分 ${a.totalScore != null ? a.totalScore : 100}</div>
        ${(a.questions || []).map((q, i) => gradeQCompareCard(q, i, ansMap, a)).join('')}`;
    } else {
      main = `${a.desc ? `<div style="margin-bottom:14px">
          <div style="font-size:12.5px;font-weight:650;letter-spacing:.4px;margin-bottom:6px">作业要求</div>
          <div style="font-size:13.5px;color:var(--text-2);line-height:1.85;letter-spacing:.1px;white-space:pre-wrap">${h(a.desc)}</div></div>` : ''}
        <div style="margin-bottom:14px">
          <div style="font-size:12.5px;font-weight:650;letter-spacing:.4px;margin-bottom:6px">提交代码</div>
          <pre class="code-block">${h(sub.code)}</pre></div>
        <div class="note warn" style="margin-bottom:14px"><b>AI 初评${sub.aiScore != null ? '（' + sub.aiScore + ' 分）' : ''}：</b>${h(sub.aiComment || '尚未初评，可稍后重试')}</div>
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
          <div style="font-size:12.5px;font-weight:650;letter-spacing:.4px">相似度检测</div>
          <div class="bar ${sub.similarity > 60 ? 'danger' : sub.similarity > 30 ? 'warn' : 'ok'}" style="flex:1"><i style="width:${sub.similarity}%"></i></div>
          <span style="font-weight:700;color:${sub.similarity > 60 ? 'var(--danger)' : 'var(--text)'}">${sub.similarity}%</span>
        </div>`;
    }

    /* 右侧评分面板：学生信息卡 + 评分区 + 合计 + 评语 */
    const scoreArea = isQ
      ? `<div class="rubric-row" style="align-items:center">
          <div class="rn"><b>作业总分</b><span>客观题已自动判分，主观题请参考 AI 初评复核</span></div>
          <input class="input" type="number" min="0" max="100" value="${g.total != null ? g.total : ''}" placeholder="0" data-bind="rubricTotal" ${graded ? 'disabled' : ''}>
          <span style="font-size:12px;color:var(--text-3);width:36px">/100</span>
        </div>`
      : a.rubric.map(r => `<div class="rubric-row">
          <div class="rn"><b>${h(r.name)}</b><span>${h(r.desc)}</span></div>
          <input class="input" type="number" min="0" max="${r.max}" value="${g.scores[r.name] != null ? g.scores[r.name] : ''}" placeholder="0" data-bind="rubric" data-id="${h(r.name)}" ${graded ? 'disabled' : ''}>
          <span style="font-size:12px;color:var(--text-3);width:36px">/${r.max}</span>
        </div>`).join('');
    const side = `<div class="grade-student">
        <div class="grade-avatar">${h((sub.name || '学').slice(0, 1))}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:15px;letter-spacing:.2px">${h(sub.name)}</div>
          <div style="font-size:12px;line-height:1.5;color:var(--text-3);margin-top:3px">${sub.submittedAt ? '提交于 ' + h(sub.submittedAt) + '（第 ' + sub.attempts + ' 次）' : '未提交'}</div>
        </div>
        <span class="badge ${graded ? 'ok' : sub.status === 'ai_reviewed' ? 'brand' : sub.status === 'missing' ? '' : 'warn'}">${graded ? '已批改 ' + sub.score : sub.status === 'ai_reviewed' ? 'AI初评完成 · 待复核' : sub.status === 'missing' ? '未提交' : '待批改'}</span>
      </div>
      <div style="font-size:12.5px;font-weight:700;letter-spacing:.4px;margin:16px 0 10px">${isQ ? '题目评分' : 'Rubric 评分'}</div>
      ${scoreArea}
      <div style="display:flex;align-items:center;gap:10px;margin:12px 0 14px">
        <span style="font-size:13.5px;font-weight:650;letter-spacing:.4px">合计</span>
        <span class="score-big" id="scorePreview">${scorePreview}</span>
        <span style="font-size:12px;color:var(--text-3)">/ 100</span>
        <div style="flex:1"></div>
        ${graded ? '' : '<button class="btn sm ghost" data-act="useAi">采用 AI 初评</button>'}
      </div>
      <div class="form-row"><label>教师评语（将同步给学生）</label>
        <textarea class="textarea" style="min-height:88px" placeholder="肯定做得好的地方 + 一条具体改进建议…" data-bind="comment" ${graded ? 'disabled' : ''}>${h(g.comment || '')}</textarea></div>`;

    /* 二级批阅页：顶栏（返回/导航）+ 主内容区 + 右侧评分面板 + 底部操作栏 */
    return `<div class="grade-mask">
      <div class="grade-top">
        <button class="btn sm ghost" data-act="closeGradePage">${icon('chevronL', 15)} 返回列表</button>
        <span class="badge brand">${icon('clipboard', 13)} 批阅</span>
        <h3>${h(sub.name)} · ${h(a.title)}</h3>
        <div class="spacer"></div>
        <span class="badge">已交 ${submittedN} · 待批 ${pendingN}</span>
        <button class="btn sm" data-act="gradeGo" data-val="prev" ${prev ? '' : 'disabled'} title="${prev ? '上一份：' + h(prev.name) : '已是第一份'}">${icon('chevronL', 14)} 上一份</button>
        <button class="btn sm" data-act="gradeGo" data-val="next" ${next ? '' : 'disabled'} title="${next ? '下一份：' + h(next.name) : '已是最后一份'}">下一份 ${icon('chevronR', 14)}</button>
      </div>
      <div class="grade-body">
        <div class="grade-main">${main}</div>
        <aside class="grade-side">${side}</aside>
      </div>
      <div class="grade-foot">
        ${graded
          ? '<span class="badge ok">' + icon('check', 12) + ' 已发布反馈（得分 ' + sub.score + '）</span>'
          : `<button class="btn" data-act="doGradeZero">记 0 分（未提交）</button>`}
        <div style="flex:1"></div>
        <span style="font-size:13.5px;font-weight:650;letter-spacing:.4px;margin-right:12px">总分：<span class="score-big" style="font-size:20px">${graded ? sub.score : scorePreview}</span><span style="color:var(--text-3);font-size:12px"> / 100</span></span>
        ${graded
            ? '<button class="btn" data-act="closeGradePage">关闭</button>'
            : `<button class="btn" data-act="doGrade">${icon('send', 15)} 提交</button>
               <button class="btn primary" data-act="doGradeNext">提交并进入下一份</button>`}
      </div>
    </div>`;
  }

  // 批阅页：单题对照卡——原始题目（题干/选项/正确答案/解析，样式与学生端题目列表一致）+ 学生作答分区
  function gradeQCompareCard(q, i, ansMap, a) {
    const t = QTYPES[q.type] || { label: q.type };
    const per = a.scoreMode !== 'custom' && (a.questions || []).length
      ? Math.round(1000 / a.questions.length) / 10 : 0;
    const score = a.scoreMode === 'custom' && q.score != null ? q.score : per;
    const correct = Array.isArray(q.answer) ? q.answer : [];
    const val = ansMap[String(q.id)];
    const answered = val != null && !(Array.isArray(val) && !val.length) && String(val) !== '';
    // 学生作答的可读文本
    let stuText = '<span style="color:var(--text-3)">未作答</span>';
    if (answered) {
      if (q.type === 'JUDGE') {
        stuText = val === true ? '正确（A）' : '错误（B）';
      } else if (q.type === 'SINGLE' || q.type === 'MULTI') {
        const ks = Array.isArray(val) ? val : [val];
        stuText = h(ks.join('、'));
      } else {
        stuText = `<span style="white-space:pre-wrap">${h(String(val))}</span>`;
      }
    }
    // 正确答案标记（客观题在选项上 ✓；主观题展示参考答案）
    let optsHtml = '';
    if (q.type === 'SINGLE' || q.type === 'MULTI') {
      optsHtml = (q.options || []).map(o => {
        const isKey = correct.indexOf(o.key) >= 0;
        const isStu = val != null && (Array.isArray(val) ? val.indexOf(o.key) >= 0 : val === o.key);
        return `<div class="hw-q-opt">${o.key}. ${h(o.text)}
          ${isKey ? '<span class="badge ok">正确答案</span>' : ''}${isStu ? '<span class="badge brand">学生选择</span>' : ''}</div>`;
      }).join('');
    } else if (q.type === 'JUDGE') {
      optsHtml = `<div class="hw-q-opt">A. 正确 ${correct[0] === true ? '<span class="badge ok">正确答案</span>' : ''}${val === true ? '<span class="badge brand">学生选择</span>' : ''}</div>
        <div class="hw-q-opt">B. 错误 ${correct[0] === false ? '<span class="badge ok">正确答案</span>' : ''}${val === false ? '<span class="badge brand">学生选择</span>' : ''}</div>`;
    } else if (correct.length && correct[0] != null && String(correct[0]) !== '') {
      optsHtml = `<div class="hw-q-opt" style="color:var(--text-3)">参考答案：${h(String(correct[0]).slice(0, 300))}</div>`;
    }
    return `<div class="hw-q">
      <div class="hw-q-head"><span class="badge brand">${t.label}</span>
        <span class="hw-q-score">第 ${i + 1} 题 · ${score} 分</span></div>
      <div class="hw-q-title">${i + 1}. ${h(q.title || '')}</div>
      ${optsHtml}
      ${q.analysis ? `<div class="hw-q-opt" style="color:var(--text-3)">解析：${h(String(q.analysis).slice(0, 300))}</div>` : ''}
      <div class="grade-stu-ans">${icon('user', 13)} 学生作答：${stuText}</div>
    </div>`;
  }

  /* ===========================================================
   *  出题组卷（教师端全屏 overlay）：六种题型 + 评分机制 + 有效时段
   *  更新策略：输入走数据绑定（不重渲染，防丢焦点）；添加/删除题、
   *  切换评分模式等按钮操作走局部面板重建或整层重渲染（无入场动画不闪屏）。
   * =========================================================== */
  const QTYPES = {
    SINGLE: { label: '单选题', hasOptions: true },
    MULTI: { label: '多选题', hasOptions: true },
    FILL: { label: '填空题' },
    JUDGE: { label: '判断题' },
    SHORT: { label: '简答题' },
    CODE: { label: '编程题' }
  };

  function newQuestion(type) {
    const q = { type, title: '', answer: [], analysis: '', difficulty: 0.5, kpCode: '', score: null, options: [] };
    if (type === 'SINGLE' || type === 'MULTI') {
      q.options = ['A', 'B', 'C', 'D'].map(k => ({ key: k, text: '' }));
    }
    return q;
  }

  const composeNowStr = () => {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };

  // 出题页总分：百分制恒 100（有题时）；自定义 = 各题分值之和
  function composeTotal(c) {
    if (c.scoreMode !== 'CUSTOM') return c.questions.length ? 100 : 0;
    return Math.round(c.questions.reduce((s, q) => s + (Number(q.score) || 0), 0) * 10) / 10;
  }

  function openComposeEditor(a) {
    if (a) {
      // 回填编辑：题目型作业 DTO（含答案）转为编辑器结构；关联知识点由题目知识点合集推导
      const kps = [];
      (a.questions || []).forEach(q => { if (q.kpCode && kps.indexOf(q.kpCode) < 0) kps.push(q.kpCode); });
      State.compose = {
        id: a.id, title: a.title || '',
        scoreMode: (a.scoreMode || 'average').toUpperCase(),
        startAt: a.startAt || '', endAt: a.due || '',
        allowLate: !!a.allowLate,
        kps,
        questions: (a.questions || []).map(q => ({
          type: q.type, title: q.title || '',
          options: (q.options || []).map(o => ({ key: o.key, text: o.text || '' })),
          answer: Array.isArray(q.answer) ? q.answer : [],
          analysis: q.analysis || '',
          difficulty: q.difficulty != null ? q.difficulty : 0.5,
          kpCode: q.kpCode || '', score: q.score != null ? q.score : null
        })),
        busy: false, aiBusy: false, _dtp: null, _kpOpen: false, preview: false
      };
    } else {
      // 默认标题「新建作业 + 日期时间」，与产品规范一致；可直接编辑并实时同步至草稿状态
      const d = new Date(), p = n => String(n).padStart(2, '0');
      State.compose = {
        id: null,
        title: '新建作业' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()),
        scoreMode: 'AVERAGE',
        startAt: composeNowStr(), endAt: '', allowLate: false,
        kps: [], questions: [], busy: false, aiBusy: false, _dtp: null, _kpOpen: false, preview: false
      };
    }
    renderOverlays();
  }

  function renderCompose() {
    const c = State.compose;
    if (!c) return '';
    if (c.preview) return composePreviewHtml();
    if (c.import) return composeImportHtml();
    const avg = c.scoreMode !== 'CUSTOM';
    return `<div class="compose-mask">
      <div class="compose-top">
        <button class="btn sm ghost" data-act="closeCompose">${icon('chevronL', 15)} 返回</button>
        <input class="input compose-title" placeholder="请输入作业标题" value="${h(c.title)}" data-bind="compose" data-key="title">
        <span class="badge brand" id="composeStat">题量 ${c.questions.length} · 总分 ${composeTotal(c)}</span>
        <div class="spacer"></div>
        <button class="btn sm ghost" data-act="composePreview">${icon('eye', 14)} 预览</button>
        <button class="btn sm" data-act="composeSave" ${c.busy ? 'disabled' : ''}>${c.busy ? '处理中…' : '保存草稿'}</button>
        <button class="btn primary sm" data-act="composePublish" ${c.busy ? 'disabled' : ''}>${c.busy ? '提交中…' : '保存并发布'}</button>
      </div>
      <div class="compose-cfg">
        <div class="cfg-row"><span class="cfg-label">评分机制</span>
          <label class="radio"><input type="radio" name="composeScoreMode" data-ans="mode" data-val="AVERAGE" ${avg ? 'checked' : ''}><i></i>百分制（平均分配每道题的分值）</label>
          <label class="radio"><input type="radio" name="composeScoreMode" data-ans="mode" data-val="CUSTOM" ${!avg ? 'checked' : ''}><i></i>自定义（自行设置每道题的分值）</label>
        </div>
        <div class="cfg-row"><span class="cfg-label">有效时段</span>
          <div class="input dtp-input" data-act="openDtp" data-val="startAt" title="选择开始时间">${c.startAt ? h(c.startAt) : '<span style="color:var(--text-3)">开始时间</span>'}</div>
          <span style="color:var(--text-3)">—</span>
          <div class="input dtp-input" data-act="openDtp" data-val="endAt" title="选择结束时间">${c.endAt ? h(c.endAt) : '<span style="color:var(--text-3)">请选择结束时间</span>'}</div>
          <span class="cfg-sub">允许学生补交</span>
          <button class="toggle ${c.allowLate ? 'on' : ''}" data-act="toggleLate" title="开启后截止时间后学生仍可补交"><i></i></button>
        </div>
        ${c._dtp ? composeDtpHtml() : ''}
      </div>
      <div class="compose-body">
        <aside class="compose-nav" id="composeNav">${composeNavHtml()}</aside>
        <div class="compose-main">
          <div class="cp-toolbar">
            <span class="cp-tb-label">${icon('plus', 14)} 添加题目</span>
            ${Object.keys(QTYPES).map(t => `<button class="btn sm" data-act="composeAddQ" data-val="${t}">${QTYPES[t].label}</button>`).join('')}
            <div class="spacer"></div>
            <button class="btn sm ghost" id="composeKpBtn" data-act="kpPanel">${icon('target', 14)} 关联知识点${c.kps.length ? ' (' + c.kps.length + ')' : ''}</button>
            <button class="btn sm ai-gen ${aiReady(c) && !c.aiBusy ? 'ready' : ''}" id="composeAiBtn" data-act="aiGen" ${aiReady(c) && !c.aiBusy ? '' : 'disabled'} title="${aiReady(c) ? '基于关联知识点与已有题目生成新题' : '请先关联知识点并添加至少一道题目'}">${icon('sparkles', 14)} ${c.aiBusy ? '生成中…' : '一键AI生成题目'}</button>
            <button class="btn sm ghost" data-act="openImport" title="粘贴文本或上传 Word/Excel 导入题目">${icon('file', 14)} 导入作业</button>
          </div>
          ${c._kpOpen ? composeKpPanelHtml() : ''}
          <div id="composeQList">${composeQListHtml()}</div>
        </div>
      </div>
    </div>`;
  }

  function composeQListHtml() {
    const c = State.compose;
    if (!c.questions.length) {
      return `<div class="empty" style="padding:48px 12px"><div class="empty-ico">${icon('file', 24)}</div>
        <div class="empty-title">还没有题目</div><div class="empty-desc">点击上方题型按钮，添加第一道题</div></div>`;
    }
    return c.questions.map((q, i) => composeQCard(q, i)).join('');
  }

  // AI 生成按钮可用条件：已关联知识点 且 已添加至少一道题目
  function aiReady(c) {
    return !!(c && c.kps && c.kps.length && c.questions && c.questions.length);
  }

  // 知识点选择面板（图1 规范：标题 + pill 标签流式多选；支持关键词模糊搜索快速定位）
  function composeKpPanelHtml() {
    const c = State.compose;
    return `<div class="kp-panel">
      <div class="kp-panel-head">${icon('target', 14)} 关联知识点
        <span>选中的知识点将作为「一键 AI 生成题目」的依据</span>
        ${c._kpSearch ? `<input class="input kp-search-input" placeholder="输入关键词过滤知识点…" value="${h(c._kpQuery || '')}" data-bind="kpsearch">` : ''}
        <button class="btn sm" data-act="kpSearchToggle" title="搜索知识点">${icon('search', 13)} 搜索</button>
        <button class="btn sm" data-act="kpPanelClose">${icon('check', 13)} 完成</button>
      </div>
      <div class="kp-panel-body">${composeKpGroupsHtml()}</div>
    </div>`;
  }

  // 面板分组列表：按一级模块分组展示课程知识点全集（Excel 体系）；
  // 搜索态下按关键词模糊过滤（知识点名称包含匹配；命中模块名时展示该模块全部），
  // 独立拆分以便输入时仅局部刷新列表（不整窗重渲染，避免闪屏与输入丢焦点）
  function composeKpGroupsHtml() {
    const c = State.compose;
    const q = (c._kpQuery || '').trim().toLowerCase();
    const groups = DB.modules.map(m => {
      let ks = DB.knowledgePoints.filter(k => k.module === m.id);
      if (q) {
        const modHit = m.name.toLowerCase().indexOf(q) >= 0;
        ks = modHit ? ks : ks.filter(k => k.name.toLowerCase().indexOf(q) >= 0);
      }
      if (!ks.length) return '';
      return `<div class="kp-group">
        <div class="kp-group-title" style="border-left:3px solid ${m.color}">${h(m.name)}<span>${ks.length}</span></div>
        <div class="kp-group-body">
          ${ks.map(k => `<button class="chip ${c.kps.indexOf(k.id) >= 0 ? 'on' : ''}" data-act="kpToggle" data-val="${k.id}" title="L${k.level}">${h(k.name)}</button>`).join('')}
        </div>
      </div>`;
    }).join('');
    if (q && !groups) {
      return `<div class="kp-search-empty">
        <div>${icon('search', 20)}</div>
        <div>没有找到与「${h(c._kpQuery.trim())}」匹配的知识点</div>
        <button class="btn sm ghost" data-act="kpSearchClear">清除搜索</button>
      </div>`;
    }
    return groups;
  }

  // 学生视角预览：以学生端「我的作业」的呈现与交互展示当前编辑中的作业（数据实时取自草稿）
  function composePreviewHtml() {
    const c = State.compose;
    const n = c.questions.length;
    const per = n ? Math.round(1000 / n) / 10 : 0;
    const kpSet = [];
    c.questions.forEach(q => { if (q.kpCode && kpSet.indexOf(q.kpCode) < 0) kpSet.push(q.kpCode); });
    const qlist = n
      ? c.questions.map((q, i) => `<div class="hw-q">
          <div class="hw-q-head"><span class="badge brand">${QTYPES[q.type] ? QTYPES[q.type].label : q.type}</span>
            <span class="hw-q-score">${c.scoreMode === 'CUSTOM' ? (q.score != null ? q.score + ' 分' : '未设分值') : per + ' 分'}</span></div>
          <div class="hw-q-title">${i + 1}. ${h(q.title || '（未填写题干）')}</div>
          ${q.type === 'JUDGE' ? '<div class="hw-q-opt">A. 正确　B. 错误</div>' : ''}
          ${(q.options || []).map(o => `<div class="hw-q-opt">${o.key}. ${h(o.text)}</div>`).join('')}
        </div>`).join('')
      : '<div class="hw-q-title" style="color:var(--text-3)">（尚未添加题目）</div>';
    return `<div class="compose-mask">
      <div class="compose-top">
        <button class="btn sm ghost" data-act="backFromPreview">${icon('chevronL', 15)} 返回编辑</button>
        <span class="badge brand">${icon('eye', 13)} 学生视角预览</span>
        <div class="spacer"></div>
        <button class="btn primary sm" data-act="backFromPreview">退出预览，继续编辑</button>
      </div>
      <div class="compose-main" style="max-width:860px;margin:0 auto;width:100%">
        <div class="card">
          <div class="card-head">${icon('clipboard', 15)}<h3>${h(c.title || '未命名作业')}</h3>
            <div class="spacer"></div><span class="badge info">进行中</span></div>
          <div class="card-body">
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
              ${kpSet.map(k => '<span class="badge brand">' + kpName(k) + '</span>').join('')}
              <span class="badge">${icon('clock', 12)} ${c.startAt ? h(c.startAt) + ' ~ ' : ''}${h(c.endAt || '未设置截止时间')}</span>
              ${c.allowLate ? '<span class="badge warn">允许补交</span>' : ''}
            </div>
            <div style="font-size:13px;color:var(--text-2);line-height:1.7;margin-bottom:4px">
              共 ${n} 题 · 总分 ${composeTotal(c)}${c.scoreMode !== 'CUSTOM' && n ? '（每题 ' + per + ' 分）' : ''}
            </div>
            <div class="hw-qlist">
              <div class="hw-qlist-head">${icon('file', 14)} 题目 · 共 ${n} 题 · 总分 ${composeTotal(c)}</div>
              ${qlist}
            </div>
            <div style="margin-top:12px;display:flex;align-items:center;gap:10px">
              <button class="btn primary" data-act="previewSubmit">${icon('send', 14)} 提交作业</button>
              <span style="font-size:12px;color:var(--text-3)">预览模式下提交不会真正执行</span>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }

  /* ---------- 导入作业（左编辑 / 右预览分栏，粘贴与 Word/Excel 上传双通道） ---------- */
  // 导入页视图：左侧粘贴/上传自动识别，右侧实时预览识别结果
  function composeImportHtml() {
    const im = State.compose.import;
    return `<div class="compose-mask">
      <div class="compose-top">
        <button class="btn sm ghost" data-act="importBack">${icon('chevronL', 15)} 返回编辑</button>
        <span class="badge brand">${icon('file', 13)} 导入作业</span>
        <span class="badge" id="ciStat">${im.busy ? 'AI 识别中…' : '已识别 ' + im.questions.length + ' 道题目'}</span>
        ${im.err ? '<span class="badge warn">' + h(im.err) + '</span>' : ''}
        <div class="spacer"></div>
        <button class="btn primary sm" id="ciJoin" data-act="importJoin" ${im.questions.length && !im.busy ? '' : 'disabled'}>加入作业${im.questions.length ? '（' + im.questions.length + ' 题）' : ''}</button>
      </div>
      <div class="ci-body">
        <div class="ci-pane">
          <div class="ci-head">
            <span class="cfg-label">题目编辑</span>
            <div class="spacer"></div>
            <button class="btn sm" data-act="importPickFile">${icon('file', 14)} 上传 Word / Excel / 图片文件</button>
            <input type="file" id="ciFileInput" accept=".docx,.doc,.xlsx,.xls,.png,.jpg,.jpeg,.bmp,.webp,.gif" style="display:none" data-import-qfile>
          </div>
          <textarea class="textarea ci-textarea" id="ciTextArea" placeholder="在此粘贴题目内容，或点击右上角按钮上传文件。&#10;&#10;支持题型：单选题、多选题、填空题、判断题、简答题、编程题。&#10;内容变更 1 秒后自动识别，识别结果实时显示在右侧预览区。" data-bind="import" data-key="text">${h(im.text)}</textarea>
          <div class="ci-hint">① 粘贴题目文本 · ② 上传 Word（.docx/.doc）/ Excel（.xlsx/.xls）自动解析 · 图片识别暂未开放，请将图片中的题目文字粘贴到编辑区</div>
        </div>
        <div class="ci-pane">
          <div class="ci-head">
            <span class="cfg-label">题目预览</span>
            <div class="spacer"></div>
            <span class="badge" id="ciRightBadge">${im.busy ? 'AI 识别中…' : im.questions.length + ' 道题目'}</span>
          </div>
          <div class="ci-preview" id="ciPreview">${importPreviewHtml()}</div>
        </div>
      </div>
    </div>`;
  }

  // 右侧预览：识别出的结构化题目（教师校对视角，含答案与解析）
  function importPreviewHtml() {
    const im = State.compose.import;
    if (im.busy) return '<div class="ci-loading">AI 识别中，请稍候…</div>';
    if (im.err && !im.questions.length) return '<div class="ci-loading">识别失败：' + h(im.err) + '</div>';
    if (!im.questions.length) return '<div class="ci-loading">在左侧粘贴题目文本或上传文件，识别结果会实时显示在这里</div>';
    return im.questions.map((q, i) => `<div class="hw-q">
      <div class="hw-q-head"><span class="badge brand">${QTYPES[q.type] ? QTYPES[q.type].label : q.type}</span>
        <span class="hw-q-score">第 ${i + 1} 题</span></div>
      <div class="hw-q-title">${h(q.title)}</div>
      ${(q.options || []).map(o => `<div class="hw-q-opt">${o.key}. ${h(o.text)}${(q.answer || []).indexOf(o.key) >= 0 ? ' <span class="badge ok">✓ 正确答案</span>' : ''}</div>`).join('')}
      ${q.type === 'JUDGE' ? '<div class="hw-q-opt">正确答案：' + (q.answer && q.answer[0] === true ? '正确' : '错误') + '</div>' : ''}
      ${['FILL', 'SHORT', 'CODE'].indexOf(q.type) >= 0 && q.answer && q.answer[0]
        ? '<div class="hw-q-opt" style="color:var(--text-3)">参考答案：' + h(String(q.answer[0]).slice(0, 160)) + '</div>' : ''}
      ${q.analysis ? '<div class="hw-q-opt" style="color:var(--text-3)">解析：' + h(String(q.analysis).slice(0, 200)) + '</div>' : ''}
    </div>`).join('');
  }

  // 局部刷新右侧预览 / 顶部统计 / 加入按钮（左侧编辑区不动，保焦点）
  function refreshImportPanels() {
    const im = State.compose.import; if (!im) return;
    const pv = $('#ciPreview'); if (pv) pv.innerHTML = importPreviewHtml();
    const st = $('#ciStat'); if (st) st.textContent = im.busy ? 'AI 识别中…' : '已识别 ' + im.questions.length + ' 道题目';
    const rb = $('#ciRightBadge'); if (rb) rb.textContent = im.busy ? 'AI 识别中…' : im.questions.length + ' 道题目';
    const join = $('#ciJoin');
    if (join) {
      join.disabled = !(im.questions.length && !im.busy);
      join.textContent = '加入作业' + (im.questions.length ? '（' + im.questions.length + ' 题）' : '');
    }
  }

  // 粘贴文本的自动识别（1 秒防抖后触发，右侧实时联动）
  let importTimer = null;
  // 学生答题：文本输入的导航状态联动防抖
  let ansTextTimer = null;
  async function importParse() {
    const im = State.compose && State.compose.import;
    if (!im || im.busy) return;
    if (!im.text || !im.text.trim()) {
      im.questions = []; im.err = '';
      refreshImportPanels();
      return;
    }
    im.busy = true; im.err = '';
    refreshImportPanels();
    try {
      const qs = await API.post('/teacher/compose/import-parse', { text: im.text });
      im.questions = qs || [];
    } catch (e) {
      im.err = e.message;
    }
    im.busy = false;
    refreshImportPanels();
  }

  function composeNavHtml() {
    const c = State.compose;
    const groups = {};
    c.questions.forEach((q, i) => { (groups[q.type] = groups[q.type] || []).push(i); });
    let html = `<div class="cp-nav-sum">题量 <b>${c.questions.length}</b><br>总分 <b id="composeTotal">${composeTotal(c)}</b></div>`;
    Object.keys(groups).forEach(t => {
      html += `<div class="cp-nav-group">${QTYPES[t].label}</div>` +
        groups[t].map(i => `<button class="cp-nav-item" data-act="composeGotoQ" data-val="${i}" title="第 ${i + 1} 题">${i + 1}</button>`).join('');
    });
    if (!c.questions.length) html += `<div class="cp-nav-empty">添加题目后<br>这里会按题型<br>展示题号导航</div>`;
    return html;
  }

  function composeQCard(q, i) {
    const t = QTYPES[q.type] || { label: q.type };
    const c = State.compose;
    const avg = c.scoreMode !== 'CUSTOM';
    const per = c.questions.length ? Math.round(1000 / c.questions.length) / 10 : 0;
    const ans = Array.isArray(q.answer) ? q.answer : [];
    let ansHtml = '';
    if (q.type === 'SINGLE' || q.type === 'MULTI') {
      const multi = q.type === 'MULTI';
      ansHtml = q.options.map((o, oi) => `
        <div class="opt-row">
          <input type="${multi ? 'checkbox' : 'radio'}" name="ans-${i}" data-ans="${multi ? 'multi' : 'single'}" data-q="${i}" data-oi="${oi}" ${ans.indexOf(o.key) >= 0 ? 'checked' : ''} title="设为正确答案">
          <span class="opt-key">${o.key}</span>
          <input class="input" placeholder="选项 ${o.key} 内容" value="${h(o.text)}" data-bind="compose" data-q="${i}" data-oi="${oi}">
        </div>`).join('') +
        `<div class="hint">${multi ? '勾选多个选项作为正确答案' : '点选一个选项作为正确答案'}</div>`;
    } else if (q.type === 'JUDGE') {
      ansHtml = `<div class="opt-row" style="padding:2px 0">
        <label class="radio sm"><input type="radio" name="ans-${i}" data-ans="judge" data-q="${i}" data-val="true" ${ans[0] === true ? 'checked' : ''}><i></i> 正确</label>
        <label class="radio sm"><input type="radio" name="ans-${i}" data-ans="judge" data-q="${i}" data-val="false" ${ans[0] === false ? 'checked' : ''}><i></i> 错误</label>
      </div>`;
    } else if (q.type === 'FILL') {
      ansHtml = `<div class="form-row"><label>正确答案</label>
        <input class="input" placeholder="填写正确答案" value="${h(ans[0] != null ? ans[0] : '')}" data-bind="compose" data-q="${i}" data-key="answerText"></div>`;
    } else {
      ansHtml = `<div class="form-row"><label>参考答案</label>
        <textarea class="textarea" style="min-height:76px" placeholder="${q.type === 'CODE' ? '参考实现 / 评分要点' : '参考答案要点'}" data-bind="compose" data-q="${i}" data-key="answerText">${h(ans[0] != null ? ans[0] : '')}</textarea></div>`;
    }
    return `<div class="cp-qcard" id="cpq-${i}">
      <div class="cp-qhead">
        <span class="cp-qno">${i + 1}</span>
        <span class="badge brand">${t.label}</span>
        ${avg
          ? `<span class="badge">自动 ${per} 分</span>`
          : `<input class="input cp-score" type="number" min="0" step="0.5" placeholder="分值" value="${q.score != null ? q.score : ''}" data-bind="compose" data-q="${i}" data-key="score"> <span style="color:var(--text-3);font-size:12px">分</span>`}
        <div class="spacer"></div>
        <button class="btn sm ghost" data-act="composeDelQ" data-val="${i}" title="删除本题">${icon('trash', 13)} 删除</button>
      </div>
      <div class="form-row"><label>题干</label>
        <textarea class="textarea" style="min-height:60px" placeholder="请输入题干" data-bind="compose" data-q="${i}" data-key="title">${h(q.title)}</textarea></div>
      ${ansHtml}
      <div class="cp-meta">
        <div class="form-row"><label>难度</label>
          <select class="select" data-bind="compose" data-q="${i}" data-key="difficulty">
            <option value="0.8" ${q.difficulty === 0.8 ? 'selected' : ''}>0.8（易）</option>
            <option value="0.5" ${q.difficulty !== 0.8 && q.difficulty !== 0.2 ? 'selected' : ''}>0.5（中）</option>
            <option value="0.2" ${q.difficulty === 0.2 ? 'selected' : ''}>0.2（难）</option>
          </select></div>
        <div class="form-row"><label>知识点</label>
          <select class="select" data-bind="compose" data-q="${i}" data-key="kpCode">
            <option value="">不关联</option>
            ${DB.knowledgePoints.map(k => `<option value="${k.id}" ${q.kpCode === k.id ? 'selected' : ''}>${k.name}</option>`).join('')}
          </select></div>
      </div>
      <div class="form-row"><label>答案解析</label>
        <input class="input" placeholder="答案解析，学生会看到（可选）" value="${h(q.analysis || '')}" data-bind="compose" data-q="${i}" data-key="analysis"></div>
    </div>`;
  }

  /* ---------- 日期时间选择器（弹层日历 + 时:分，开始/结束共用） ---------- */
  function composeDtpHtml() {
    const d = State.compose._dtp;
    const [y, m] = d.month.split('-').map(Number);
    const firstDay = new Date(y, m - 1, 1).getDay();
    const days = new Date(y, m, 0).getDate();
    const prevDays = new Date(y, m - 1, 0).getDate();
    const now = new Date();
    let cells = '';
    for (let i = 0; i < 42; i++) {
      const n = i - firstDay + 1;
      if (n < 1) { cells += `<span class="dtp-day off">${prevDays + n}</span>`; }
      else if (n > days) { cells += `<span class="dtp-day off">${n - days}</span>`; }
      else {
        const isToday = n === now.getDate() && m === now.getMonth() + 1 && y === now.getFullYear();
        cells += `<button class="dtp-day ${n === d.day ? 'sel' : ''} ${isToday ? 'today' : ''}" data-act="dtpDay" data-val="${n}">${n}</button>`;
      }
    }
    return `<div class="dtp-pop" id="dtpPop" style="left:${d.x}px;top:${d.y}px">
      <div class="dtp-head">
        <button class="icon-btn" data-act="dtpPrev" title="上月">${icon('chevronL', 15)}</button>
        <b>${y} 年 ${m} 月</b>
        <button class="icon-btn" data-act="dtpNext" title="下月">${icon('chevronR', 15)}</button>
      </div>
      <div class="dtp-grid">${['日', '一', '二', '三', '四', '五', '六'].map(w => `<span class="dtp-wk">${w}</span>`).join('')}${cells}</div>
      <div class="dtp-time">
        <span>时间</span>
        <input class="input" type="number" min="0" max="23" value="${d.hour}" data-bind="dtp" data-key="hour"> :
        <input class="input" type="number" min="0" max="59" value="${d.minute}" data-bind="dtp" data-key="minute">
      </div>
      <div class="dtp-foot">
        <button class="btn sm ghost" data-act="dtpClear">清空</button>
        <button class="btn sm ghost" data-act="dtpToday">今天</button>
        <button class="btn primary sm" data-act="dtpOk">确定</button>
      </div>
    </div>`;
  }

  function openDtpField(field, el) {
    const c = State.compose;
    const cur = c[field] || composeNowStr();
    const parts = cur.split(/[- :]/).map(Number);
    const r = el.getBoundingClientRect();
    c._dtp = {
      field,
      month: parts[0] + '-' + String(parts[1]).padStart(2, '0'),
      day: parts[2], hour: parts[3], minute: parts[4],
      x: Math.min(r.left, window.innerWidth - 300),
      y: Math.min(r.bottom + 6, window.innerHeight - 330)
    };
    renderOverlays();
  }

  // 添加/删除题后局部重建题目列表 + 左栏 + 顶部统计（不整层重渲染，保输入焦点与滚动位置）
  function refreshComposePanels() {
    const ql = $('#composeQList'); if (ql) ql.innerHTML = composeQListHtml();
    const nv = $('#composeNav'); if (nv) nv.innerHTML = composeNavHtml();
    updateComposeStats();
    updateAiBtn();
  }

  // 局部刷新「一键AI生成题目」按钮状态（灰暗禁用 ↔ 蓝色可用 ↔ 生成中）
  function updateAiBtn() {
    const c = State.compose; if (!c) return;
    const btn = $('#composeAiBtn'); if (!btn) return;
    const ready = aiReady(c) && !c.aiBusy;
    btn.disabled = !ready;
    btn.classList.toggle('ready', ready);
    btn.title = aiReady(c) ? '基于关联知识点与已有题目生成新题' : '请先关联知识点并添加至少一道题目';
    btn.innerHTML = icon('sparkles', 14) + ' ' + (c.aiBusy ? '生成中…' : '一键AI生成题目');
  }

  // 仅刷新总分/题量两处文本（自定义分值输入时联动，不重建任何输入框）
  function updateComposeStats() {
    const c = State.compose; if (!c) return;
    const total = composeTotal(c);
    const st = $('#composeStat');
    if (st) st.textContent = '题量 ' + c.questions.length + ' · 总分 ' + total;
    const tv = $('#composeTotal');
    if (tv) tv.textContent = total;
  }

  function shiftDtpMonth(delta) {
    const d = State.compose._dtp;
    const [y, m] = d.month.split('-').map(Number);
    const cur = new Date(y, m - 1 + delta, 1);
    d.month = cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0');
    const days = new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate();
    if (d.day > days) d.day = days;
    renderOverlays();
  }

  // 出题保存/发布：前端校验 + 提交 + 刷新
  async function composeSubmit(status) {
    const c = State.compose;
    if (!c || c.busy) return;
    if (!c.title || !c.title.trim()) { toast('请填写作业标题'); return; }
    if (!c.questions.length) { toast('请至少添加一道题目'); return; }
    for (let i = 0; i < c.questions.length; i++) {
      const q = c.questions[i], no = '第 ' + (i + 1) + ' 题';
      if (!q.title.trim()) { toast(no + '缺少题干'); return; }
      if (q.type === 'SINGLE' || q.type === 'MULTI') {
        if (q.options.filter(o => o.text.trim()).length < 2) { toast(no + '至少需要 2 个非空选项'); return; }
        if (!q.answer.length) { toast(no + '请设置正确答案'); return; }
      }
      if (q.type === 'JUDGE' && q.answer.length === 0) { toast(no + '请设置正确答案'); return; }
    }
    if (c.scoreMode === 'CUSTOM') {
      const sum = c.questions.reduce((s, q) => s + (Number(q.score) || 0), 0);
      if (Math.abs(sum - 100) > 0.01) { toast('自定义评分总分须为 100 分，当前 ' + Math.round(sum * 10) / 10); return; }
    }
    if (!c.endAt) { toast('请选择结束时间'); return; }
    if (c.startAt && c.endAt <= c.startAt) { toast('结束时间必须晚于开始时间'); return; }

    c.busy = true; renderOverlays();
    try {
      const r = await API.post('/teacher/compose', {
        id: c.id != null ? Number(c.id) : null,
        title: c.title, scoreMode: c.scoreMode,
        startAt: c.startAt || null, endAt: c.endAt, allowLate: !!c.allowLate,
        status: status,
        questions: c.questions.map(q => ({
          type: q.type, title: q.title,
          options: (q.options || []).filter(o => o.text.trim()).map(o => ({ key: o.key, text: o.text })),
          answer: q.answer || [],
          analysis: q.analysis || null,
          difficulty: Number(q.difficulty) || 0.5,
          kpCode: q.kpCode || null,
          score: c.scoreMode === 'CUSTOM' ? (Number(q.score) || 0) : null
        }))
      });
      State.compose = null; renderOverlays();
      DB.assignments = await API.get('/teacher/assignments');
      render();
      toast(status === 'DRAFT' ? '草稿已保存' : '作业「' + r.title + '」已发布，学生侧已同步收到', 'ok');
    } catch (e) {
      if (State.compose) { State.compose.busy = false; renderOverlays(); }
      toast(e.message);
    }
  }

  /* ===========================================================
   *  学生答题页（作业详情 · 全屏 overlay，参考超星作业详情布局）
   *  左：题目按题型分组 + 各题型答题组件；右：题号导航（已答高亮）。
   *  支持答案编辑 / 临时保存（本地草稿）/ 最终提交（结构化作答 + 客观题自动判分）。
   * =========================================================== */
  const ansDraftKey = asId => 'la-answer-draft-' + asId;

  function openAnswerEditor(a) {
    if (!a || !a.questionCount) { toast('该作业不支持在线作答'); return; }
    const sub = a.mySubmission;
    // 已批改 → 只读查看模式；待提交 / 已提交待批改 → 作答模式（待批改支持修改后重新提交）
    const mode = sub && sub.status === 'graded' ? 'view' : 'answer';
    // 已提交：以提交内容为准回填（提交时草稿已清除）；未提交：沿用本地草稿
    let prefill = {};
    if (sub && Array.isArray(sub.answers) && sub.answers.length) {
      (a.questions || []).forEach((q, i) => {
        const hit = sub.answers.find(x => String(x.questionId) === String(q.id));
        if (hit && hit.value != null) prefill[i] = hit.value;
      });
    } else {
      try { prefill = JSON.parse(localStorage.getItem(ansDraftKey(a.id)) || '{}') || {}; } catch (e) { prefill = {}; }
    }
    State.answer = {
      asId: a.id, title: a.title || '',
      startAt: a.startAt || '', endAt: a.due || '', allowLate: !!a.allowLate,
      scoreMode: a.scoreMode, totalScore: a.totalScore, mode,
      sub: sub ? { submittedAt: sub.submittedAt, attempts: sub.attempts, score: sub.score, teacherComment: sub.teacherComment, autoScore: sub.autoScore } : null,
      questions: (a.questions || []).map(q => ({
        id: q.id, type: q.type, title: q.title || '',
        options: (q.options || []).map(o => ({ key: o.key, text: o.text || '' })),
        score: q.score != null ? q.score : null
      })),
      answers: prefill, busy: false
    };
    renderOverlays();
  }

  // 是否已作答：文本非空 / 数组非空 / 布尔有值
  function ansAnswered(qi) {
    const v = State.answer.answers[qi];
    if (v == null) return false;
    if (Array.isArray(v)) return v.length > 0;
    return String(v) !== '';
  }

  function ansAnsweredCount() {
    let n = 0;
    State.answer.questions.forEach((q, i) => { if (ansAnswered(i)) n++; });
    return n;
  }

  function renderAnswer() {
    const c = State.answer;
    if (!c) return '';
    const per = c.scoreMode !== 'custom' && c.questions.length
      ? Math.round(1000 / c.questions.length) / 10 : 0;
    // 按题型分组（保持题号顺序）
    const groups = [];
    const groupIdx = {};
    c.questions.forEach((q, i) => {
      if (groupIdx[q.type] === undefined) {
        groupIdx[q.type] = groups.length;
        groups.push({ type: q.type, idx: [] });
      }
      groups[groupIdx[q.type]].idx.push(i);
    });
    let secNo = 0;
    const body = groups.map(g => {
      secNo++;
      const score = g.idx.reduce((s, i) => s + (c.scoreMode === 'custom'
        ? (c.questions[i].score || 0) : per), 0);
      return `<div class="ans-group"><span class="ans-group-title">${'一二三四五六'[secNo - 1] || secNo}. ${QTYPES[g.type] ? QTYPES[g.type].label : g.type}（共 ${g.idx.length} 题，${Math.round(score * 10) / 10} 分）</span></div>` +
        g.idx.map(i => answerQCard(c, i, per)).join('');
    }).join('');
    const view = c.mode === 'view';
    return `<div class="compose-mask">
      <div class="compose-top">
        <button class="btn sm ghost" data-act="closeAnswer">${icon('chevronL', 15)} 返回</button>
        <span class="badge brand">${icon('clipboard', 13)} 作业详情</span>
        ${view
          ? `<span class="badge ok">${icon('checkcircle', 13)} 已批改</span>
             ${c.sub && c.sub.score != null ? `<span class="badge"><span style="font-weight:700;color:var(--brand)">${c.sub.score}</span> / ${c.totalScore != null ? c.totalScore : 100} 分</span>` : ''}`
          : `<span class="badge" id="ansStat">已作答 ${ansAnsweredCount()}/${c.questions.length}</span>
             ${c.sub ? `<span class="badge warn">已提交 · 待批改</span>` : ''}
             ${c.endAt ? `<span class="badge">${icon('clock', 12)} 截止 ${h(c.endAt)}</span>` : ''}
             ${c.allowLate ? '<span class="badge warn">允许补交</span>' : ''}`}
        <div class="spacer"></div>
        ${view ? '' : `<button class="btn sm" data-act="ansSaveDraft" ${c.busy ? 'disabled' : ''}>${icon('save', 14)} 临时保存</button>
        <button class="btn primary sm" data-act="answerSubmit" ${c.busy ? 'disabled' : ''}>${c.busy ? '提交中…' : icon('send', 14) + ' 提交作业'}</button>`}
      </div>
      <div class="ans-info">
        <h3>${h(c.title)}</h3>
        <div class="ans-info-meta">
          <span>题量：${c.questions.length}</span>
          <span>满分：${c.totalScore != null ? c.totalScore : 100}</span>
          ${c.sub ? `<span>已提交：${h(c.sub.submittedAt || '-')}（第 ${c.sub.attempts || 1} 次）</span>` : `<span>作答时段：${c.startAt ? h(c.startAt) + ' 至 ' : ''}${h(c.endAt || '不限')}</span>`}
        </div>
        ${view && c.sub && c.sub.teacherComment ? `<div class="note ok" style="margin:10px 0 4px"><b>教师评语：</b>${h(c.sub.teacherComment)}</div>` : ''}
        ${!view && c.sub ? `<div class="note" style="margin:10px 0 4px">批改完成前可修改作答并重新提交，重新提交后将以最新一次为准。</div>` : ''}
      </div>
      <div class="ans-body">
        <div class="ans-main">${body}</div>
        <aside class="ans-nav" id="ansNav">${answerNavHtml()}</aside>
      </div>
    </div>`;
  }

  // 单题答题卡：按题型渲染作答组件（答案实时写入 State.answer.answers）；
  // 只读模式（已批改查看）下输入组件统一 disabled，仅作完整展示
  function answerQCard(c, i, per) {
    const q = c.questions[i];
    const t = QTYPES[q.type] || { label: q.type };
    const score = c.scoreMode === 'custom' && q.score != null ? q.score : per;
    const v = c.answers[i];
    const ro = c.mode === 'view' ? ' disabled' : '';
    let input = '';
    if (q.type === 'SINGLE' || q.type === 'MULTI') {
      const multi = q.type === 'MULTI';
      const checked = k => Array.isArray(v) ? v.indexOf(k) >= 0 : (Array.isArray(v) ? false : v === k);
      input = (q.options || []).map(o => `
        <label class="ans-opt">
          <input type="${multi ? 'checkbox' : 'radio'}" name="ansq-${i}" data-ans="${multi ? 'answerMulti' : 'answerSingle'}" data-qi="${i}" data-val="${o.key}"${checked(o.key) ? ' checked' : ''}${ro}>
          <span class="opt-key">${o.key}.</span><span>${h(o.text)}</span>
        </label>`).join('');
    } else if (q.type === 'JUDGE') {
      input = `
        <label class="ans-opt"><input type="radio" name="ansq-${i}" data-ans="answerJudge" data-qi="${i}" data-val="true"${v === true ? ' checked' : ''}${ro}><span class="opt-key">A.</span><span>正确</span></label>
        <label class="ans-opt"><input type="radio" name="ansq-${i}" data-ans="answerJudge" data-qi="${i}" data-val="false"${v === false ? ' checked' : ''}${ro}><span class="opt-key">B.</span><span>错误</span></label>`;
    } else if (q.type === 'FILL') {
      input = `<input class="input ans-text" placeholder="填写答案" value="${v != null ? h(String(v)) : ''}" data-bind="answer" data-qi="${i}"${ro}>`;
    } else if (q.type === 'CODE') {
      // CODE：内置代码编辑器（高亮 / 行号 / 自动补全）；只读模式下带配色的完整展示
      input = codeEditorHtml(`data-bind="answer" data-qi="${i}"`, v != null ? String(v) : '',
        { ro: !!ro, minHeight: 200, placeholder: '在此编写代码…' });
    } else {
      input = `<textarea class="textarea ans-text" style="min-height:110px"
        placeholder="在此输入答案…" data-bind="answer" data-qi="${i}"${ro}>${v != null ? h(String(v)) : ''}</textarea>`;
    }
    return `<div class="cp-qcard" id="ansq-${i}">
      <div class="cp-qhead">
        <span class="cp-qno">${i + 1}</span>
        <span class="badge brand">${t.label}</span>
        <span class="badge">${score} 分</span>
      </div>
      <div class="hw-q-title" style="margin-bottom:8px">${h(q.title)}</div>
      ${input}
    </div>`;
  }

  // 右侧题号导航（按题型分组，已答高亮）
  function answerNavHtml() {
    const c = State.answer;
    const groups = [];
    const groupIdx = {};
    c.questions.forEach((q, i) => {
      if (groupIdx[q.type] === undefined) {
        groupIdx[q.type] = groups.length;
        groups.push({ type: q.type, idx: [] });
      }
      groups[groupIdx[q.type]].idx.push(i);
    });
    let html = `<div class="cp-nav-sum">已作答 <b id="ansNavCount">${ansAnsweredCount()}</b><br>/ 共 ${c.questions.length} 题</div>`;
    groups.forEach(g => {
      html += `<div class="cp-nav-group">${QTYPES[g.type] ? QTYPES[g.type].label : g.type}</div>` +
        g.idx.map(i => `<button class="cp-nav-item ${ansAnswered(i) ? 'on' : ''}" data-act="answerGotoQ" data-val="${i}" title="第 ${i + 1} 题${ansAnswered(i) ? '（已作答）' : ''}">${i + 1}</button>`).join('');
    });
    return html;
  }

  // 局部刷新：题号导航 + 顶部已答统计
  function refreshAnswerPanels() {
    const c = State.answer; if (!c) return;
    const nav = $('#ansNav'); if (nav) nav.innerHTML = answerNavHtml();
    const st = $('#ansStat');
    if (st) st.textContent = '已作答 ' + ansAnsweredCount() + '/' + c.questions.length;
  }

  function saveAnswerDraft(silent) {
    const c = State.answer; if (!c || c.mode === 'view') return; // 只读查看不落草稿
    try {
      localStorage.setItem(ansDraftKey(c.asId), JSON.stringify(c.answers));
      if (!silent) toast('草稿已临时保存，下次进入自动恢复', 'ok');
    } catch (e) {
      if (!silent) toast('草稿保存失败：' + e.message);
    }
  }

  async function doAnswerSubmit() {
    const c = State.answer;
    if (!c || c.busy) return;
    c.busy = true;
    State.modal = null;
    renderOverlays();
    try {
      const payload = c.questions.map((q, i) => ({
        questionId: q.id,
        value: c.answers[i] != null ? c.answers[i] : (Array.isArray(q.options) && (q.type === 'MULTI') ? [] : '')
      }));
      const r = await API.post('/assignments/' + c.asId + '/answer', { answers: payload });
      const auto = r && r.autoScore != null ? r.autoScore : null;
      State.answer = null;
      localStorage.removeItem(ansDraftKey(c.asId));
      renderOverlays();
      DB.assignments = await API.get('/assignments/my');
      render();
      toast(auto != null
        ? '作业已提交。自动评分临时分数：' + auto + ' 分（客观题按标准答案匹配，主观题待教师批改；临时分数仅供参考，不计入最终成绩）'
        : '作业已提交，等待教师批改', 'ok');
    } catch (e) {
      c.busy = false;
      renderOverlays();
      toast('提交失败：' + e.message);
    }
  }


  /* ===========================================================
   *  交互动作
   * =========================================================== */
  // 批改草稿缓存：返回列表 / 切换学生时保存当前评分与批注，再次进入同一学生自动恢复
  function cacheGradingDraft() {
    const g = State.grading;
    if (g && g.subId != null) {
      State.gradingDrafts = State.gradingDrafts || {};
      State.gradingDrafts[String(g.subId)] = { subId: g.subId, scores: g.scores, comment: g.comment, total: g.total };
    }
  }

  /* --- 作业卡片「更多」下拉菜单（绝对定位浮层，不触发整页重渲染） --- */
  let asMenuEl = null;
  function closeAsMenu() {
    if (asMenuEl) {
      asMenuEl.remove();
      asMenuEl = null;
      document.removeEventListener('click', asMenuOutside, true);
      window.removeEventListener('scroll', closeAsMenu, true);
    }
  }
  function asMenuOutside(e) {
    if (asMenuEl && !asMenuEl.contains(e.target)) closeAsMenu();
  }

  const Actions = {
    section(v) { State.section = v; State.drawer = null; loadWithSkeleton(); },
    async session(v) {
      State.sessionId = v; State.scrollBottom = true; render();
      const s = session();
      if (s && (!s.messages || !s.messages.length) && s.steps && s.steps.length) {
        // 列表接口不含消息，切换时按需拉取详情
        try {
          const full = await API.get('/sessions/' + v);
          const i = DB.sessions.findIndex(x => x.id === v);
          if (i >= 0) DB.sessions[i] = full;
          State.scrollBottom = true; render();
        } catch (e) { /* 忽略 */ }
      }
    },
    logout() { Auth.logout(); },
    toggleCtx() { State.rightOpen = !State.rightOpen; renderCtx(); },
    ctxTab(v) { State.rightTab = v; State.rightOpen = true; renderCtx(); },
    gotoChat() { State.section = 'chat'; loadWithSkeleton(); },
    gotoHw() {
      State.section = 'homework';
      DB.notifications.filter(n => !n.readFlag).forEach(n => {
        n.readFlag = true;
        API.put('/notifications/' + n.id + '/read').catch(() => {});
      });
      loadWithSkeleton();
    },
    gotoSubs(v) {
      State.section = 'submissions'; State.filters.subAs = v;
      loadWithSkeleton();
      loadSubmissions(v);
    },
    settings() { State.modal = { type: 'settings', data: {} }; renderOverlays(); },
    accountSettings() {
      State.modal = { type: 'changePassword', data: { oldPwd: '', newPwd: '', newPwd2: '', busy: false } };
      renderOverlays();
    },
    async doChangePassword() {
      const d = State.modal.data;
      if (d.busy) return;
      if (!d.oldPwd) { toast('请输入原密码'); return; }
      if (!d.newPwd || d.newPwd.length < 6 || d.newPwd.length > 50) { toast('新密码长度需在 6-50 位之间'); return; }
      if (d.newPwd !== d.newPwd2) { toast('两次输入的新密码不一致'); return; }
      d.busy = true; renderOverlays();
      try {
        await API.post('/auth/change-password', { oldPassword: d.oldPwd, newPassword: d.newPwd });
        State.modal = null; renderOverlays();
        toast('密码修改成功，下次登录请使用新密码', 'ok');
      } catch (e) {
        d.busy = false; renderOverlays();
        toast(e.message);
      }
    },
    closeModal() { State.modal = null; renderOverlays(); },
    maskClose(id, val, t) {
      // 只有点在遮罩本身（而非弹窗内容）上才关闭
      if (t && (t.classList.contains('mask') || t.classList.contains('drawer-mask'))) {
        State.modal = null; State.drawer = null; State.grading = null;
        renderOverlays();
      }
    },

    /* --- 学生：会话 --- */
    newSession() { State.modal = { type: 'newSession', data: { kps: [], q: '' } }; renderOverlays(); },
    pickKp(v, id, t) {
      // 多选切换：点选/取消任意知识点；不选（空）= 覆盖全部知识点的学习路径
      const d = State.modal.data;
      d.kps = d.kps || [];
      const i = d.kps.indexOf(v);
      if (i >= 0) d.kps.splice(i, 1); else d.kps.push(v);
      // 局部切换选中态：整窗 innerHTML 重建会重放 mask/modal 入场动画（闪屏），
      // 且 .pick-list 的 scrollTop 会归零（弹窗列表跳回顶部）；改为直接改 class。
      if (t && t.classList && t.closest('.pick-list')) {
        t.classList.toggle('on', i < 0);
      }
      // 同步「创建」按钮文案（原先由整窗重渲染负责，局部更新后需手动刷新）
      const btn = document.querySelector('.modal [data-act="createSession"]');
      if (btn) {
        const n = d.kps.length;
        btn.innerHTML = icon('sparkles', 15) + ' 创建并生成学习路径' + (n ? '（' + n + ' 个知识点）' : '（全部知识点）');
      }
    },
    async createSession() {
      const kps = (State.modal.data.kps || []).slice();
      const single = kps.length === 1 ? kps[0] : null;
      State.modal = null; renderOverlays();
      toast(kps.length > 1 || !kps.length
        ? '智能体正在诊断并规划' + (kps.length > 1 ? '多知识点' : '全知识点') + '学习路径…'
        : '智能体正在诊断并规划学习路径…');
      try {
        const s = await API.post('/sessions', single ? { kpId: single, kpIds: null } : { kpId: null, kpIds: kps });
        DB.sessions.unshift(s);
        State.sessionId = s.id; State.activeKp = single || (s.kps && s.kps[0]) || s.kp; State.scrollBottom = true;
        render();
        toast('会话已创建，路径已生成', 'ok');
      } catch (e) { toast(e.message); }
    },
    clearSessions() {
      if (!DB.sessions.length) { toast('当前没有可清空的对话'); return; }
      State.modal = { type: 'clearSessions', data: { busy: false } }; renderOverlays();
    },
    async doClearSessions() {
      const d = State.modal.data;
      if (d.busy) return;
      d.busy = true; renderOverlays();
      try {
        await API.del('/sessions');
        DB.sessions = [];
        State.sessionId = null;
        State.modal = null; renderOverlays(); render();
        toast('对话记录已全部清空', 'ok');
      } catch (e) {
        d.busy = false; State.modal = null; renderOverlays();
        toast(e.message);
      }
    },
    async replan() {
      const s = session(); if (!s) return;
      toast('正在重新规划…');
      try {
        const ns = await API.post('/sessions/' + s.id + '/replan');
        replaceSession(ns);
        State.scrollBottom = true; render();
        toast('路径已重新生成', 'ok');
      } catch (e) { toast(e.message); }
    },
    async doStep() {
      const s = session(); if (!s) return;
      const i = s.steps.findIndex(x => x.status === 'active');
      const stepNo = (i >= 0 ? i : s.stepIndex || 0) + 1;
      try {
        const ns = await API.post('/sessions/' + s.id + '/steps/' + stepNo + '/start');
        replaceSession(ns);
        State.scrollBottom = true; render();
      } catch (e) { toast(e.message); }
    },
    askExercise() {
      State.draft = '这个知识点再出一道变式题练练';
      Actions.send();
    },
    // Agent Markdown 生成题目：判断题选「正确 / 错误」
    quizPick(v, id, t) {
      State.quizReply = State.quizReply || {};
      State.quizReply[id] = v;
      // 局部更新两个按钮的选中态与提交按钮可用态（不重渲染）
      const box = t.closest('.quiz-ans');
      if (box) {
        box.querySelectorAll('[data-act="quizPick"]').forEach(b => {
          b.classList.toggle('primary', b.dataset.val === v);
        });
        const submit = box.querySelector('[data-act="quizSubmit"]');
        if (submit) submit.disabled = !v;
      }
    },
    // Agent Markdown 生成题目：提交作答 → 作为用户消息发送，由 Agent 在对话中点评
    quizSubmit(v, id) {
      State.quizReply = State.quizReply || {};
      const ans = (State.quizReply[id] || '').trim();
      if (!ans) { toast('请先完成作答'); return; }
      State.quizDone[id] = true;
      State.draft = '我的作答：\n' + ans + '\n请点评我的答案（对错/正确性 + 改进建议）。';
      Actions.send();
    },
    opt(v, id) {
      const s = session(); if (!s) return;
      const m = s.messages.find(x => x.id === id);
      if (!m || m.card.state !== 'answering') return;
      m.card.selected = Number(v);
      render();
    },
    async hint(v, id) {
      const s = session(); if (!s) return;
      const m = s.messages.find(x => x.id === id);
      if (!m || !m.card) return;
      const next = Math.min(3, (m.card.hintLevel || 0) + 1);
      try {
        const r = await API.post('/exercises/' + m.card.exId + '/hint', { level: next });
        m.card.hintLevel = next;
        m.card.hintTexts = m.card.hintTexts || [];
        m.card.hintTexts.push(r.hint);
        render();
      } catch (e) { toast(e.message); }
    },
    async submitEx(v, id) {
      const s = session(); if (!s) return;
      const m = s.messages.find(x => x.id === id);
      if (!m || m.card.state !== 'answering') return;
      const ex = m.card.exercise || getEx(m.card.exId);
      if (!ex) { toast('题目数据缺失，请重新获取练习'); return; }
      const qType = String(ex.type || 'CHOICE').toUpperCase();
      const isText = qType !== 'CHOICE' && qType !== 'JUDGE';
      if (isText) {
        if (!(m.card.textAnswer || '').trim()) { toast('请输入作答内容'); return; }
      } else if (m.card.selected == null) {
        toast('请先选择答案'); return;
      }
      m.card.state = 'grading';
      render();
      try {
        const r = await API.post('/exercises/' + m.card.exId + '/attempt', isText
          ? { answer: m.card.textAnswer, hintUsed: m.card.hintLevel || 0 }
          : { selected: m.card.selected, hintUsed: m.card.hintLevel || 0 });
        setMastery(ex.kp, r.newMastery);
        const resultMsg = {
          id: 'r-' + Date.now(), from: 'agent', agent: r.correct ? 'tutor' : 'code', time: now(),
          text: r.correct ? '回答正确，解析如下：' : '这题没过，我们把它拆开看：',
          card: { type: 'result', ok: r.correct, exId: m.card.exId, delta: r.delta, analysis: r.analysis }
        };
        m.card.state = 'graded';
        m.card.answer = r.answer;
        // 完成当前步骤（服务端推进步骤 + 全部完成时生成学习报告）
        const doneN = s.steps.filter(x => x.status === 'done').length + 1;
        try {
          const ns = await API.post('/sessions/' + s.id + '/steps/' + Math.min(doneN, s.steps.length) + '/complete');
          // 把本地作答状态同步到服务端会话里的练习卡消息
          const srvMsg = ns.messages.filter(x => x.card && x.card.type === 'exercise'
            && String(x.card.exId) === String(m.card.exId)).pop();
          if (srvMsg) {
            Object.assign(srvMsg.card, {
              state: 'graded', answer: r.answer, selected: m.card.selected,
              textAnswer: m.card.textAnswer || '',
              hintLevel: m.card.hintLevel || 0, hintTexts: m.card.hintTexts || []
            });
          }
          ns.messages.push(resultMsg);
          // 步骤完成后服务端会追加一条「路径更新」卡片消息（card.type === 'path'）：
          // 将其挪到评测结果之后，保证阅读顺序为 评测结果 → 最新学习路径；
          // 配合下方 scrollBottom 自动滚底，路径模块直接出现在当前可视区域，无需用户上滑查找
          const oldIds = new Set(s.messages.map(x => String(x.id)));
          const pi = ns.messages.findIndex(x => x.card && x.card.type === 'path' && !oldIds.has(String(x.id)));
          if (pi >= 0) {
            const pathMsg = ns.messages.splice(pi, 1)[0];
            ns.messages.push(pathMsg);
            State.pathPopId = pathMsg.id; // 该卡片首次渲染时播放平滑入场动画
          }
          replaceSession(ns);
        } catch (e) {
          // 步骤推进失败不影响本地评测展示
          s.messages.push(resultMsg);
        }
        State.scrollBottom = true;
        render();
        toast(r.correct
          ? '回答正确 · ' + kpName(ex.kp) + ' 掌握度 ' + (r.delta > 0 ? '+' : '') + r.delta
          : '未通过 · 已加入错题本与复习队列', r.correct ? 'ok' : '');
        refreshStudentSideData();
      } catch (e) {
        m.card.state = 'answering';
        render();
        toast(e.message);
      }
    },
    stepClick(v) {
      const s = session(); if (!s) return;
      State.rightTab = 'knowledge'; State.rightOpen = true;
      renderCtx();
    },
    quick(v) { State.draft = v; Actions.send(); },
    async send() {
      const text = (State.draft || '').trim();
      if (!text || State.chatting) return;
      const s = session(); if (!s) return;
      State.draft = ''; State.chatting = true; State.scrollBottom = true;
      s.messages.push({ id: 'u-' + Date.now(), from: 'user', text, time: now() });
      const tmp = { id: 'a-' + Date.now(), from: 'agent', agent: 'tutor', typing: true, text: '' };
      s.messages.push(tmp);
      render();
      try {
        await API.sse('/sessions/' + s.id + '/chat', { content: text }, {
          meta: p => { if (p && p.agent) tmp.agent = p.agent; if (p && p.mock != null) DB.llmMock = p.mock; renderThrottled(); },
          delta: p => { tmp.typing = false; tmp.text = (tmp.text || '') + (p.text || ''); renderThrottled(); },
          card: p => {
            s.messages.push({ id: 'c-' + Date.now(), from: 'agent', agent: tmp.agent, time: now(), text: '', card: p });
            State.scrollBottom = true; render();
          },
          replace: p => { tmp.text = p.text || tmp.text; render(); },
          error: p => { tmp.typing = false; tmp.text = (tmp.text || '') + '\n\n⚠️ ' + (p.msg || '智能体出错'); render(); }
        });
      } catch (e) {
        tmp.typing = false;
        tmp.text = (tmp.text || '') + '\n\n⚠️ ' + e.message;
        render();
      }
      State.chatting = false;
      refreshSession(s.id);
    },
    coachHint(v, id) {
      const s = session(); if (!s) return;
      const m = s.messages.find(x => x.id === id);
      if (!m) return;
      m.card.revealed = Math.min(3, (m.card.revealed || 0) + 1);
      render();
    },
    snip() { /* 展示型，无需动作 */ },

    /* --- 学生：作业 --- */
    hwFilter(v) { State.filters.hw = v; render(); },
    exFilter(v) { State.filters.exKp = v; render(); },
    reportTab(v) { State.filters.report = v; render(); },
    kpCell(v) {
      // 修复：render() 全量重建 main 区会令 .main-body 的 scrollTop 归零，
      // 表现为点击图谱卡片后内容区自动滚回顶部；渲染前记录位置、渲染后恢复。
      const keepMain = document.querySelector('.main-body');
      const keepTop = keepMain ? keepMain.scrollTop : 0;
      State.activeKp = v;
      State.rightTab = 'knowledge'; State.rightOpen = true;
      render();
      if (keepMain) {
        const nb = document.querySelector('.main-body');
        if (nb) nb.scrollTop = keepTop;
      }
    },
    /* --- 知识图谱导航（超星风格：首页气泡 / 模块视图 / 搜索定位 / 导出图片） --- */
    kgHome() {
      State.kgView = { mode: 'home', module: null, focus: null };
      State.kgZoom = 1;
      State.kgPan = { x: 0, y: 0 };
      render();
    },
    kgModule(v) {
      State.kgView = { mode: 'module', module: v, focus: null };
      State.kgZoom = 1;
      State.kgPan = { x: 0, y: 0 };
      render();
    },
    kgFocus(v) {
      const k = kp(v);
      if (!k) return;
      State.kgView = { mode: 'module', module: k.module, focus: v };
      State.kgZoom = 1;
      State.kgPan = { x: 0, y: 0 };
      State.activeKp = v;
      render();
    },
    /* 缩放：滚轮与按钮共用；只改 #kgViewport 的 transform（局部更新，不整页重渲染），
       缩放后同步钳制平移量防止内容越界 */
    kgApplyZoom() {
      const p0 = State.kgPan || { x: 0, y: 0 };
      State.kgPan = kgClampPan(p0.x, p0.y, State.kgZoom || 1);
      kgApplyPan();
      const pct = document.getElementById('kgZoomPct');
      if (pct) pct.textContent = Math.round((State.kgZoom || 1) * 100) + '%';
    },
    kgZoomIn() {
      State.kgZoom = Math.min(3, Math.round(((State.kgZoom || 1) + 0.15) * 100) / 100);
      Actions.kgApplyZoom();
    },
    kgZoomOut() {
      State.kgZoom = Math.max(0.35, Math.round(((State.kgZoom || 1) - 0.15) * 100) / 100);
      Actions.kgApplyZoom();
    },
    kgZoomReset() {
      State.kgZoom = 1;
      State.kgPan = { x: 0, y: 0 };
      Actions.kgApplyZoom();
    },
    kgExport() {
      const svg = document.getElementById('kgSvg');
      if (!svg) { toast('未找到图谱画布'); return; }
      try {
        const xml = new XMLSerializer().serializeToString(svg);
        const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = 1660; canvas.height = 1000;
          const ctx = canvas.getContext('2d');
          const grad = ctx.createLinearGradient(0, 0, 0, 1000);
          grad.addColorStop(0, '#0b1230'); grad.addColorStop(1, '#131a4a');
          ctx.fillStyle = grad; ctx.fillRect(0, 0, 1660, 1000);
          ctx.drawImage(img, 0, 0, 1660, 1000);
          const a = document.createElement('a');
          a.download = '知识图谱-' + today() + '.png';
          a.href = canvas.toDataURL('image/png');
          a.click();
          toast('图谱图片已导出', 'ok');
        };
        img.onerror = () => toast('导出失败：图片渲染异常');
        img.src = src;
      } catch (e) {
        toast('导出失败：' + e.message);
      }
    },
    focusHw(v) {
      State.filters.hw = 'all';
      State.focusHwId = v;
      State.rightTab = 'homework'; State.rightOpen = true;
      render();
      setTimeout(() => {
        const el = document.getElementById('hw-' + v);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 30);
    },
    submitHw(v) { State.modal = { type: 'submitHw', data: { asId: v, code: '' } }; renderOverlays(); },
    async doSubmitHw() {
      const d = State.modal.data;
      try {
        await API.post('/assignments/' + d.asId + '/submissions', { code: d.code || '' });
        State.modal = null; renderOverlays();
        toast('提交成功，已进入教师批改队列', 'ok');
        DB.assignments = await API.get('/assignments/my');
        render();
      } catch (e) { toast(e.message); }
    },

    /* --- 建议反馈（学生提交 / 教师查看 + AI 总结）。
       交互约定：弹窗内的选项切换、异步加载/总结等状态变化一律「局部更新」，
       禁止调用 renderOverlays 整窗重建——整窗重建会重放 pop 入场动画并重置 DOM，导致闪屏 */
    openFeedback() {
      State.modal = { type: 'feedback', data: { type: 'BUG', content: '', busy: false } };
      renderOverlays();
    },
    fbPickType(v, id, t) {
      if (State.modal) State.modal.data.type = v;
      // 局部更新选中态（与 quizPick 同法），不整窗重渲染
      const box = t && t.closest ? t.closest('.fb-types') : null;
      if (box) {
        box.querySelectorAll('.fb-type').forEach(b => { b.classList.toggle('on', b.dataset.val === v); });
      } else {
        renderOverlays();
      }
    },
    async doSubmitFeedback(v, id, t) {
      const d = State.modal && State.modal.data;
      if (!d || d.busy) return;
      const content = (d.content || '').trim();
      if (!content) { toast('请填写反馈内容'); return; }
      d.busy = true;
      // 局部更新按钮为「提交中」，不重渲染弹窗
      const btn = t || document.querySelector('[data-act="doSubmitFeedback"]');
      if (btn) { btn.disabled = true; btn.innerHTML = icon('send', 15) + ' 提交中…'; }
      try {
        await API.post('/feedback', { type: d.type, content });
        State.modal = null; renderOverlays();
        toast('反馈已提交，感谢你的建议', 'ok');
      } catch (e) {
        d.busy = false;
        if (btn) { btn.disabled = false; btn.innerHTML = icon('send', 15) + ' 提交反馈'; }
        toast(e.message);
      }
    },
    async openFeedbackList() {
      State.modal = { type: 'feedbackList', data: { list: null, summary: '', summarizing: false } };
      renderOverlays(); // 首次打开弹窗，入场动画仅此一次
      try {
        const list = await API.get('/teacher/feedback');
        if (State.modal && State.modal.type === 'feedbackList') {
          State.modal.data.list = list;
          // 局部刷新：仅重写弹窗内容区，外壳与动画状态不动
          const bodyEl = document.querySelector('.modal .modal-body');
          if (bodyEl) bodyEl.innerHTML = fbListBodyHtml(State.modal.data);
          // 同步局部解除底部「AI 一键总结」按钮的禁用态：
          // 首次渲染时列表未加载（d.list 为空）按钮按初始置灰，
          // 局部刷新内容区不会触及底部栏，须在此就地恢复，否则按钮永久不可点
          const fbtn = document.querySelector('[data-act="doFeedbackSummary"]');
          if (fbtn) fbtn.disabled = !(list && list.length);
        }
      } catch (e) {
        State.modal = null; renderOverlays();
        toast(e.message);
      }
    },
    async doFeedbackSummary(v, id, t) {
      const d = State.modal && State.modal.data;
      if (!d || d.summarizing) return;
      d.summarizing = true;
      // 局部更新按钮为「总结中」，不重渲染弹窗
      const btn = t || document.querySelector('[data-act="doFeedbackSummary"]');
      if (btn) { btn.disabled = true; btn.innerHTML = icon('sparkles', 15) + ' AI 总结中…'; }
      try {
        const r = await API.post('/teacher/feedback/summary', {});
        d.summary = (r && r.summary) || '';
        // 局部刷新内容区展示总结（fbListBodyHtml 含总结区块）
        const bodyEl = document.querySelector('.modal .modal-body');
        if (bodyEl) bodyEl.innerHTML = fbListBodyHtml(d);
      } catch (e) {
        toast(e.message);
      }
      d.summarizing = false;
      if (btn) { btn.disabled = !(d.list && d.list.length); btn.innerHTML = icon('sparkles', 15) + ' AI 一键总结'; }
    },

    /* --- 教师：班级名单导入 --- */
    importClassModal() { State.modal = { type: 'importClass', data: { file: null, uploading: false, progress: 0 } }; renderOverlays(); },
    pickImportFile() {
      const input = document.getElementById('importFileInput');
      if (input) input.click();
    },
    async doImportClass() {
      const d = State.modal.data;
      const file = d.file;
      if (!file || d.uploading) return;
      // 前端格式与大小验证
      const okExt = ['.xlsx', '.xls', '.docx', '.doc'];
      const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
      if (okExt.indexOf(ext) < 0) { toast('仅支持 ' + okExt.join(' / ') + ' 格式'); return; }
      if (file.size > 10 * 1024 * 1024) { toast('文件超过 10MB 上限'); return; }

      d.uploading = true; d.progress = 0;
      renderOverlays();
      // XHR 上传以获取进度回调
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/teacher/classes/import');
      xhr.setRequestHeader('Authorization', 'Bearer ' + API.token());
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) {
          d.progress = Math.min(100, Math.round(e.loaded / e.total * 100));
          const bar = document.getElementById('importBar');
          if (bar) bar.style.width = d.progress + '%';
        }
      };
      const finish = async (ok, msg) => {
        d.uploading = false; d.progress = 0;
        State.modal = null;
        renderOverlays();
        toast(msg, ok ? 'ok' : '');
        if (ok) {
          // 实时刷新授课班级列表与学生数据
          try {
            const [classes, students, dash] = await Promise.all([
              API.get('/teacher/classes'), API.get('/teacher/students'), API.get('/teacher/dashboard')
            ]);
            DB.classes = classes; DB.students = students; DB.teacherDash = dash;
            DB.classStuckPoints = dash.stuckPoints || [];
            render();
          } catch (e) { toast(e.message); }
        }
      };
      xhr.onload = async () => {
        try {
          let data = null;
          try { data = JSON.parse(xhr.responseText); } catch (e) { /* 非 JSON */ }
          if (xhr.status === 401) { Auth.logout(); return; }
          if (xhr.status >= 200 && xhr.status < 300 && data && data.code === 0) {
            const r = data.data;
            finish(true, '班级「' + r.className + '」已创建：新增 ' + r.studentCount + ' 名学生'
              + (r.skipped ? '，跳过已存在 ' + r.skipped + ' 人' : ''));
          } else {
            finish(false, (data && data.msg) || '导入失败（' + xhr.status + '）');
          }
        } catch (e) {
          finish(false, '导入失败：' + e.message);
        }
      };
      xhr.onerror = () => finish(false, '网络错误，上传失败');
      const fd = new FormData();
      fd.append('file', file, file.name);
      xhr.send(fd);
    },

    /* --- 教师 --- */
    async classPick(v) {
      State.filters.classId = v;
      try {
        DB.teacherDash = await API.get('/teacher/dashboard');
        render();
      } catch (e) { toast(e.message); }
    },
    studentPick(v) {
      // 修复：render() 全量重建 #side 会令左侧名单 .side-body 的 scrollTop 归零，
      // 表现为点击学生后名单自动滚回顶部。渲染前记录滚动位置、渲染后恢复。
      // 仅在已处于学生视图时保持（从看板等入口首次进入学生视图时列表为新内容，无需恢复）。
      const keepSide = State.section === 'students' ? document.querySelector('.side-body') : null;
      const keepTop = keepSide ? keepSide.scrollTop : 0;
      State.activeStudent = v;
      State.rightTab = 'knowledge'; State.rightOpen = true;
      if (State.section !== 'students') { State.section = 'students'; }
      render();
      if (keepSide) {
        const nb = document.querySelector('.side-body');
        if (nb) nb.scrollTop = keepTop;
      }
      // 点击学生（左侧列表 / 中间列表 / 看板入口）后：中间列表平滑下滑至底部，
      // 完整展示该生档案卡。rAF 确保重绘布局完成后启动原生平滑滚动（无 JS 动画开销）
      requestAnimationFrame(() => {
        const sc = document.querySelector('.main-body');
        if (sc) sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' });
      });
    },
    resetPwdModal() {
      const sel = DB.students.find(s => s.id === State.activeStudent);
      if (!sel) { toast('请先在列表中选择一名学生'); return; }
      State.modal = { type: 'resetPwd', data: { sid: sel.id, name: sel.name, busy: false } };
      renderOverlays();
    },
    async doResetPwd() {
      const d = State.modal.data;
      if (d.busy) return;
      d.busy = true; renderOverlays();
      try {
        await API.post('/teacher/students/' + d.sid + '/reset-password');
        State.modal = null; renderOverlays();
        toast('已将「' + d.name + '」的密码重置为初始密码 GZgs@2026', 'ok');
      } catch (e) {
        d.busy = false; renderOverlays();
        toast('重置失败：' + e.message);
      }
    },
    asMore(v, id, t) {
      closeAsMenu();
      if (!t) return;
      const menu = document.createElement('div');
      menu.className = 'as-menu';
      menu.innerHTML =
        `<button class="as-menu-item" data-act="editAs" data-val="${v}">${icon('edit', 14)} 修改</button>` +
        `<button class="as-menu-item danger" data-act="delAs" data-val="${v}">${icon('trash', 14)} 删除</button>`;
      const r = t.getBoundingClientRect();
      menu.style.top = (r.bottom + window.scrollY + 5) + 'px';
      menu.style.right = (document.documentElement.clientWidth - r.right) + 'px';
      document.body.appendChild(menu);
      asMenuEl = menu;
      // 注册全局关闭（点击菜单外 / 滚动页面时收起）；延迟注册避免本次点击立即触发
      setTimeout(() => {
        document.addEventListener('click', asMenuOutside, true);
        window.addEventListener('scroll', closeAsMenu, true);
      }, 0);
    },
    editAs(v) {
      closeAsMenu();
      const a = DB.assignments.find(x => String(x.id) === String(v));
      if (!a) { toast('作业不存在或已删除'); return; }
      // 题目型作业走出题组卷编辑
      if (a.scoreMode) { openComposeEditor(a); return; }
      // 旧版 Rubric 型作业不再支持在线修改（发布弹窗已下线）
      toast('该作业为旧版编程作业，暂不支持在线修改；如需调整可通过「发布新作业」重新组卷');
    },
    openCompose() { openComposeEditor(null); },
    closeCompose() { State.compose = null; renderOverlays(); },
    openAnswer(v) {
      const a = DB.assignments.find(x => String(x.id) === String(v));
      if (!a) { toast('作业不存在'); return; }
      openAnswerEditor(a);
    },
    closeAnswer() {
      const view = State.answer && State.answer.mode === 'view';
      // 返回时自动保存草稿，防止误退丢答案（只读查看模式不落草稿）
      saveAnswerDraft(true);
      State.answer = null;
      renderOverlays();
      if (!view) toast('已返回，作答内容已自动保存为草稿');
    },
    ansSaveDraft() { saveAnswerDraft(false); },
    answerSubmit() {
      const c = State.answer;
      if (!c || c.busy) return;
      const done = ansAnsweredCount();
      const total = c.questions.length;
      if (!done) { toast('请至少作答一道题目'); return; }
      State.modal = {
        type: 'answerConfirm',
        data: { asId: c.asId, title: c.title, done, total, busy: false }
      };
      renderOverlays();
    },
    ansDoSubmit() { doAnswerSubmit(); },
    answerGotoQ(v) {
      const card = $('#ansq-' + v);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
    composeAddQ(v) {
      if (!QTYPES[v]) return;
      State.compose.questions.push(newQuestion(v));
      refreshComposePanels();
      // 平滑滚动到新题卡
      requestAnimationFrame(() => {
        const list = document.querySelector('.compose-main');
        const card = $('#cpq-' + (State.compose.questions.length - 1));
        if (list && card) list.scrollTo({ top: card.offsetTop - 8, behavior: 'smooth' });
      });
    },
    composeDelQ(v) {
      State.compose.questions.splice(Number(v), 1);
      refreshComposePanels();
    },
    composeGotoQ(v) {
      const card = $('#cpq-' + v);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
    toggleLate(v, id, t) {
      State.compose.allowLate = !State.compose.allowLate;
      if (t && t.classList) t.classList.toggle('on', State.compose.allowLate);
    },
    openDtp(v, id, t) { openDtpField(v, t); },
    dtpPrev() { shiftDtpMonth(-1); },
    dtpNext() { shiftDtpMonth(1); },
    dtpDay(v) { State.compose._dtp.day = Number(v); renderOverlays(); },
    dtpToday() {
      const d = State.compose._dtp, n = new Date();
      d.month = n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0');
      d.day = n.getDate(); d.hour = n.getHours(); d.minute = n.getMinutes();
      renderOverlays();
    },
    dtpClear() { State.compose[State.compose._dtp.field] = ''; State.compose._dtp = null; renderOverlays(); },
    dtpOk() {
      const d = State.compose._dtp, p = n => String(n).padStart(2, '0');
      State.compose[d.field] = d.month + '-' + p(d.day) + ' ' + p(d.hour) + ':' + p(d.minute);
      State.compose._dtp = null;
      renderOverlays();
    },
    composeSave() { composeSubmit('DRAFT'); },
    composePublish() { composeSubmit('ONGOING'); },
    composePreview() { State.compose.preview = true; renderOverlays(); },
    backFromPreview() { State.compose.preview = false; renderOverlays(); },
    previewSubmit() { toast('预览模式：此操作不会真正提交'); },
    openImport() {
      State.compose.import = { text: '', questions: [], busy: false, err: '' };
      renderOverlays();
    },
    importBack() { State.compose.import = null; renderOverlays(); },
    importJoin() {
      const c = State.compose, im = c.import;
      if (!im || !im.questions.length || im.busy) return;
      im.questions.forEach(q => {
        c.questions.push({
          type: q.type, title: q.title || '',
          options: (q.options || []).map(o => ({ key: o.key, text: o.text || '' })),
          answer: Array.isArray(q.answer) ? q.answer : [],
          analysis: q.analysis || '',
          difficulty: q.difficulty != null ? Number(q.difficulty) : 0.5,
          kpCode: q.kpCode || '',
          score: c.scoreMode === 'CUSTOM' ? 0 : null
        });
      });
      const n = im.questions.length;
      c.import = null;
      renderOverlays();
      toast('已将 ' + n + ' 道题目加入当前作业', 'ok');
    },
    importPickFile() {
      const input = $('#ciFileInput');
      if (input) input.click();
    },
    importUploadFile(file) {
      const im = State.compose && State.compose.import;
      if (!im || im.busy) return;
      const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
      if (['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.gif'].indexOf(ext) >= 0) {
        toast('图片识别暂未开放：请将图片中的题目文字粘贴到编辑区，或上传 Word / Excel 版本');
        return;
      }
      if (['.docx', '.doc', '.xlsx', '.xls'].indexOf(ext) < 0) { toast('仅支持 Word / Excel / 图片格式'); return; }
      if (file.size > 10 * 1024 * 1024) { toast('文件超过 10MB 上限'); return; }
      im.busy = true; im.err = '';
      refreshImportPanels();
      const fd = new FormData();
      fd.append('file', file);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/teacher/compose/import-file');
      xhr.setRequestHeader('Authorization', 'Bearer ' + API.token());
      xhr.onload = () => {
        try {
          const r = JSON.parse(xhr.responseText);
          if (xhr.status === 200 && r.code === 0) {
            im.text = r.data.text || '';
            im.questions = r.data.questions || [];
            im.busy = false; im.err = '';
            const ta = $('#ciTextArea');
            if (ta) ta.value = im.text;
            refreshImportPanels();
            toast('文件已解析，识别出 ' + im.questions.length + ' 道题目', 'ok');
          } else {
            im.busy = false; im.err = r.msg || '解析失败';
            refreshImportPanels();
            toast(im.err);
          }
        } catch (err) {
          im.busy = false; refreshImportPanels();
          toast('解析失败，请重试');
        }
      };
      xhr.onerror = () => { im.busy = false; refreshImportPanels(); toast('上传失败，请重试'); };
      xhr.send(fd);
    },
    // 移动端：顶栏汉堡按钮开关左侧功能抽屉（会话列表/筛选/班级名单等入口）
    toggleSide() {
      const s = document.getElementById('side');
      if (s) s.classList.toggle('open');
    },
    kpPanel() { State.compose._kpOpen = !State.compose._kpOpen; renderOverlays(); },
    kpPanelClose() { State.compose._kpOpen = false; renderOverlays(); },
    // 知识点面板搜索：唤起/收起搜索框，唤起后自动聚焦
    kpSearchToggle() {
      const c = State.compose;
      if (!c) return;
      c._kpSearch = !c._kpSearch;
      if (!c._kpSearch) c._kpQuery = '';
      renderOverlays();
      if (c._kpSearch) {
        const inp = document.querySelector('[data-bind="kpsearch"]');
        if (inp) inp.focus();
      }
    },
    // 清除搜索词并局部恢复完整列表（不清输入框会导致过滤残留）
    kpSearchClear() {
      const c = State.compose;
      if (!c) return;
      c._kpQuery = '';
      const inp = document.querySelector('[data-bind="kpsearch"]');
      if (inp) inp.value = '';
      const body = document.querySelector('.kp-panel .kp-panel-body');
      if (body) body.innerHTML = composeKpGroupsHtml();
    },
    kpToggle(v, id, t) {
      // 局部切换选中态（chip class）+ 同步按钮计数与 AI 按钮状态，不重渲染面板
      const c = State.compose;
      const i = c.kps.indexOf(v);
      if (i >= 0) c.kps.splice(i, 1); else c.kps.push(v);
      if (t && t.classList) t.classList.toggle('on', i < 0);
      const kb = $('#composeKpBtn');
      if (kb) kb.innerHTML = icon('target', 14) + ' 关联知识点' + (c.kps.length ? ' (' + c.kps.length + ')' : '');
      updateAiBtn();
    },
    async aiGen() {
      const c = State.compose;
      if (!c || c.aiBusy) return;
      if (!aiReady(c)) { toast('请先关联知识点，并添加至少一道题目'); return; }
      // 生成数量与题型的唯一依据 = 教师添加的空白题（题型与数量即生成配置），
      // 不使用任何默认数量；无空白题时引导教师先添加
      const blanks = c.questions.filter(q => !q.title.trim());
      if (!blanks.length) { toast('请先用上方题型按钮添加空白题目（添加几道、选什么题型，就生成几道什么题）'); return; }
      c.aiBusy = true; updateAiBtn();
      try {
        const qs = await API.post('/teacher/compose/ai-generate', {
          kpCodes: c.kps,
          existing: c.questions.map(q => ({ type: q.type, title: q.title })),
          blanks: blanks.map(q => q.type),
          types: [...new Set(c.questions.map(q => q.type))]
        });
        const normalize = q => ({
          type: q.type, title: q.title || '',
          options: (q.options || []).map(o => ({ key: o.key, text: o.text || '' })),
          answer: Array.isArray(q.answer) ? q.answer : [],
          analysis: q.analysis || '',
          difficulty: q.difficulty != null ? Number(q.difficulty) : 0.5,
          kpCode: q.kpCode || '',
          score: c.scoreMode === 'CUSTOM' ? 0 : null
        });
        let filled = 0, appended = 0, bi = 0;
        (qs || []).forEach(q => {
          // 按题型匹配对位填充空白题：后端清洗可能减少题目数量，
          // 严禁把生成内容硬塞进题型不符的空白题（如单选内容塞进编程题卡）
          let b = null;
          while (bi < blanks.length) {
            if (blanks[bi].type === q.type) { b = blanks[bi]; bi++; break; }
            bi++;
          }
          if (b) {
            const n = normalize(q);
            Object.assign(b, n);
            filled++;
          } else {
            c.questions.push(normalize(q));
            appended++;
          }
        });
        c.aiBusy = false;
        refreshComposePanels();
        const total = filled + appended;
        // 后端保证生成数量 = 空白题数量，正常情况下恰好全部填充；
        // appended > 0 属于异常兜底路径（题型对位溢出），如实提示
        const msg = total
          ? '已基于「' + c.kps.map(kpName).join('、') + '」生成 ' + total + ' 道题目并填充空白题'
            + (appended ? '（另有 ' + appended + ' 道因题型对位溢出已追加为新题）' : '')
          : 'AI 未返回有效题目，请重试';
        toast(msg, total ? 'ok' : undefined);
      } catch (e) {
        c.aiBusy = false; updateAiBtn();
        toast('生成失败：' + e.message);
      }
    },
    delAs(v) {
      closeAsMenu();
      const a = DB.assignments.find(x => String(x.id) === String(v));
      if (!a) { toast('作业不存在或已删除'); return; }
      State.modal = { type: 'delAs', data: { asId: a.id, title: a.title, submitted: a.submitted, busy: false } };
      renderOverlays();
    },
    async doDelAs() {
      const d = State.modal.data;
      if (d.busy) return;
      d.busy = true; renderOverlays();
      try {
        await API.del('/teacher/assignments/' + d.asId);
        State.modal = null; renderOverlays();
        DB.assignments = await API.get('/teacher/assignments');
        render();
        toast('作业《' + d.title + '》已删除', 'ok');
      } catch (e) {
        d.busy = false; renderOverlays();
        toast('删除失败：' + e.message);
      }
    },
    async publishDraft(v) {
      const a = DB.assignments.find(x => x.id === v);
      if (!a) return;
      try {
        await API.post('/teacher/assignments', {
          id: Number(a.id), title: a.title, desc: a.desc || '', kp: a.kp || [],
          due: a.due || '', status: 'ONGOING', rubric: a.rubric
        });
        DB.assignments = await API.get('/teacher/assignments');
        render();
        toast('《' + a.title + '》已发布给学生', 'ok');
      } catch (e) { toast(e.message); }
    },
    subAsPick(v) {
      State.filters.subAs = v;
      if (State.section === 'assignments') State.section = 'submissions';
      render();
      loadSubmissions(v);
    },
    openSub(v) {
      const sub = DB.submissions.find(x => x.id === v);
      if (!sub) return;
      // 批改草稿缓存：返回列表/切换学生后再次进入同一学生，恢复已输入的评分与批注
      const cached = State.gradingDrafts && State.gradingDrafts[String(v)];
      if (cached) {
        State.grading = cached;
        State.drawer = { subId: v };
        renderOverlays(); renderCtx();
        return;
      }
      const a = DB.assignments.find(x => x.id === sub.asId);
      const scores = {};
      a.rubric.forEach(r => {
        scores[r.name] = (sub.rubricScores && sub.rubricScores[r.name] != null)
          ? sub.rubricScores[r.name]
          : Math.round(r.max * ((sub.aiScore != null ? sub.aiScore : 70) / 100));
      });
      State.grading = {
        subId: v, scores, comment: sub.teacherComment || '',
        // 题目型作业：总分默认取 AI 初评（客观题自动判分结果），教师可改
        total: a.questionCount > 0 ? (sub.aiScore != null ? sub.aiScore : null) : null
      };
      State.drawer = { subId: v };
      renderOverlays(); renderCtx();
    },
    // 返回列表：当前批改草稿写入缓存，再次点击同一学生可继续批改
    closeGradePage() {
      cacheGradingDraft();
      State.drawer = null;
      renderOverlays(); renderCtx();
    },
    // 上一份 / 下一份：当前草稿写入缓存后切换学生
    gradeGo(v) {
      const sub = DB.submissions.find(x => x.id === State.drawer.subId);
      if (!sub) return;
      const idx = DB.submissions.findIndex(s => s.id === sub.id);
      const target = v === 'prev' ? (idx > 0 ? DB.submissions[idx - 1] : null)
        : (idx >= 0 && idx < DB.submissions.length - 1 ? DB.submissions[idx + 1] : null);
      if (!target) { toast(v === 'prev' ? '已是第一份' : '已是最后一份'); return; }
      cacheGradingDraft();
      Actions.openSub(target.id);
    },
    closeDrawer() { State.drawer = null; renderOverlays(); renderCtx(); },
    useAi() {
      const sub = DB.submissions.find(x => x.id === State.drawer.subId);
      const a = DB.assignments.find(x => x.id === sub.asId);
      const g = State.grading;
      if (a.questionCount > 0) {
        if (sub.aiScore == null) { toast('暂无 AI 初评结果，请先稍候重试或人工评分'); return; }
        g.total = sub.aiScore;
        renderOverlays();
        toast('已采用 AI 初评总分（客观题自动判分 + 主观题 AI 评分），请人工复核后发布');
        return;
      }
      const ratio = (sub.aiScore != null ? sub.aiScore : 70) / 100;
      a.rubric.forEach(r => { g.scores[r.name] = Math.round(r.max * ratio); });
      renderOverlays();
      toast('已按 AI 初评比例填充，请人工复核后发布');
    },
    async doGrade() {
      const sub = DB.submissions.find(x => x.id === State.drawer.subId);
      const a = DB.assignments.find(x => x.id === sub.asId);
      const g = State.grading;
      if (a.questionCount > 0 && (g.total == null || g.total === '')) {
        toast('请先填写作业总分');
        return;
      }
      try {
        await API.post('/teacher/submissions/' + sub.id + '/grade', {
          rubricScores: g.scores, comment: g.comment || '',
          totalScore: a.questionCount > 0 ? Number(g.total) : null
        });
        // 已发布的批改不再保留草稿缓存
        if (State.gradingDrafts) delete State.gradingDrafts[String(sub.id)];
        State.drawer = null; State.grading = null;
        renderOverlays(); renderCtx();
        await loadSubmissions(sub.asId);
        render();
        toast('评分已发布，学生侧已收到反馈', 'ok');
      } catch (e) { toast(e.message); }
    },
    // 提交并进入下一份：发布当前批改后自动打开下一份待批改的提交
    async doGradeNext() {
      const sub = DB.submissions.find(x => x.id === State.drawer.subId);
      const a = DB.assignments.find(x => x.id === sub.asId);
      const g = State.grading;
      if (a.questionCount > 0 && (g.total == null || g.total === '')) {
        toast('请先填写作业总分');
        return;
      }
      try {
        await API.post('/teacher/submissions/' + sub.id + '/grade', {
          rubricScores: g.scores, comment: g.comment || '',
          totalScore: a.questionCount > 0 ? Number(g.total) : null
        });
        await loadSubmissions(sub.asId);
        // 找当前的下一位（刷新后按列表顺序），优先待批改 / AI初评完成待复核的提交
        const idx = DB.submissions.findIndex(s => s.id === sub.id);
        const after = idx >= 0 ? DB.submissions.slice(idx + 1).find(s => s.status === 'pending' || s.status === 'ai_reviewed') : null;
        const fallback = idx >= 0 ? DB.submissions.slice(idx + 1)[0] : null;
        const nextTarget = after || fallback;
        State.grading = null;
        if (nextTarget) {
          Actions.openSub(nextTarget.id);
          toast('已发布，继续批改：' + nextTarget.name, 'ok');
        } else {
          State.drawer = null;
          renderOverlays(); renderCtx();
          render();
          toast('评分已发布，全部提交批改完成', 'ok');
        }
      } catch (e) { toast(e.message); }
    },
    async doGradeZero() {
      const sub = DB.submissions.find(x => x.id === State.drawer.subId);
      const a = DB.assignments.find(x => x.id === sub.asId);
      const scores = {};
      a.rubric.forEach(r => { scores[r.name] = 0; });
      try {
        await API.post('/teacher/submissions/' + sub.id + '/grade', {
          rubricScores: scores, comment: '未提交，记 0 分。请尽快补交，有困难可随时联系我。',
          totalScore: a.questionCount > 0 ? 0 : null
        });
        State.drawer = null; State.grading = null;
        renderOverlays(); renderCtx();
        await loadSubmissions(sub.asId);
        render();
        toast('已记 0 分并通知学生', 'ok');
      } catch (e) { toast(e.message); }
    },
    async batchAi() {
      try {
        await API.post('/teacher/assignments/' + State.filters.subAs + '/ai-grade-batch');
        toast('AI 批量初评已启动，完成后将通知你');
        // 异步任务：稍后自动刷新一次
        setTimeout(async () => {
          try {
            await loadSubmissions(State.filters.subAs);
            render();
          } catch (e) { /* 忽略 */ }
        }, 6000);
      } catch (e) { toast(e.message); }
    },
    warnFilter(v) { State.filters.warn = v; render(); },
    async warnHandle(v) {
      try {
        await API.put('/teacher/warnings/' + v + '/handle');
        DB.warnings = await API.get('/teacher/warnings');
        render();
        toast('已标记为已处理', 'ok');
      } catch (e) { toast(e.message); }
    },
    async warnNotify(v) {
      try {
        await API.post('/teacher/warnings/' + v + '/notify');
        DB.warnings = await API.get('/teacher/warnings');
        render();
        toast('提醒已推送给学生', 'ok');
      } catch (e) { toast(e.message); }
    },
    async pushAll() {
      const list = DB.warnings.filter(w => !w.handled && w.sid);
      for (const w of list) {
        try { await API.post('/teacher/warnings/' + w.id + '/notify'); } catch (e) { /* 忽略 */ }
      }
      DB.warnings = await API.get('/teacher/warnings');
      render();
      toast('已向 ' + list.length + ' 位学生推送提醒', 'ok');
    },
    async runInsight() {
      State.insight = { stage: 0, done: false };
      render();
      const steps = 4;
      for (let i = 1; i <= steps; i++) { await delay(420); State.insight.stage = i; render(); }
      try {
        const r = await API.post('/teacher/insight/run');
        State.insight.done = true;
        State.insight.report = r.report;
        State.insight.mock = r.mock;
      } catch (e) {
        State.insight.done = true;
        State.insight.report = '⚠️ 报告生成失败：' + e.message;
      }
      render();
    }
  };

  /* ---------------- 数据同步辅助 ---------------- */
  function replaceSession(ns) {
    const i = DB.sessions.findIndex(x => String(x.id) === String(ns.id));
    if (i >= 0) DB.sessions[i] = ns; else DB.sessions.unshift(ns);
    State.sessionId = ns.id;
  }

  async function refreshSession(id) {
    try {
      const full = await API.get('/sessions/' + id);
      replaceSession(full);
      if (State.section === 'chat') { State.scrollBottom = true; render(); }
      else render();
    } catch (e) { /* 忽略 */ }
  }

  async function loadSubmissions(asId) {
    try {
      DB.submissions = await API.get('/teacher/assignments/' + asId + '/submissions');
      if (State.section === 'submissions') render();
    } catch (e) { /* 忽略 */ }
  }

  async function refreshStudentSideData() {
    try {
      const [overview, records] = await Promise.all([
        API.get('/reports/overview'), API.get('/exercise-records')
      ]);
      DB.student = overview;
      DB.exerciseRecords = records.map(r => Object.assign({}, r, { ok: r.correct }));
      // 掌握度热力图同步
      if (overview && DB.knowledgePoints.length) {
        DB.knowledgePoints.forEach(k => { /* mastery 已在 attempt 回填 */ });
      }
      render();
    } catch (e) { /* 静默刷新失败可接受 */ }
  }

  let renderTimer = null;
  function renderThrottled() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      State.scrollBottom = true;
      render();
    }, 80);
  }

  /* ---------------- 启动：按角色拉取数据 ---------------- */
  async function loadRemote() {
    const me = Auth.user();
    initDB(me);
    if (!me) throw new Error('未登录');

    // AI 接入状态（顶栏芯片）
    try { DB.llmMock = (await API.get('/status')).mock; } catch (e) { /* 忽略 */ }

    if (me.role === 'TEACHER') {
      State.role = 'teacher'; State.section = 'dashboard';
      const [graph, classes, students, dash, warnings, assignments, notifications] = await Promise.all([
        API.get('/knowledge/graph'),
        API.get('/teacher/classes'),
        API.get('/teacher/students'),
        API.get('/teacher/dashboard'),
        API.get('/teacher/warnings'),
        API.get('/teacher/assignments'),
        API.get('/notifications')
      ]);
      applyKnowledgeGraph(graph);
      DB.classes = classes; DB.students = students;
      DB.teacherDash = dash;
      DB.classStuckPoints = dash.stuckPoints || [];
      DB.warnings = warnings; DB.assignments = assignments;
      DB.notifications = notifications;
      if (assignments.length) {
        State.filters.subAs = assignments[0].id;
        loadSubmissions(assignments[0].id);
      }
    } else {
      State.role = 'student'; State.section = 'chat';
      const [graph, sessions, overview, assignments, notifications, records] = await Promise.all([
        API.get('/knowledge/graph'),
        API.get('/sessions'),
        API.get('/reports/overview'),
        API.get('/assignments/my'),
        API.get('/notifications'),
        API.get('/exercise-records')
      ]);
      applyKnowledgeGraph(graph);
      DB.sessions = sessions;
      DB.student = overview;
      DB.assignments = assignments;
      DB.notifications = notifications;
      DB.exerciseRecords = records.map(r => Object.assign({}, r, { ok: r.correct }));
      if (sessions.length) {
        State.sessionId = sessions[0].id;
        State.activeKp = sessions[0].kp;
        refreshSession(sessions[0].id);
      } else if (DB.knowledgePoints.length) {
        State.sessionId = null;
        State.activeKp = DB.knowledgePoints.slice().sort((a, b) => a.mastery - b.mastery)[0].id;
      }
    }
  }

  /* ===========================================================
   *  渲染调度与事件
   * =========================================================== */
  function render() {
    $('#topbar').innerHTML = renderTopbar();
    $('#activity').innerHTML = renderActivity();
    const sideEl = $('#side');
    sideEl.innerHTML = renderSide();
    // 知识图谱视图已移除左侧「知识模块」面板：隐藏边栏，让图谱主区占满左侧释放的全部横向空间
    sideEl.style.display = (State.role === 'student' && State.section === 'knowledge') ? 'none' : '';
    renderMain();
    renderCtx();
    renderOverlays();
  }

  /* ---------------- 对话区滚动控制 ----------------
   * followTail：是否跟随最新消息（默认 true）。
   * - 新消息 / 流式增量 / 卡片推送渲染后自动滚到底部；
   * - 用户主动上翻（距底部 > 60px）时暂停跟随，保留阅读位置不被拉回；
   * - 用户滚回底部附近自动恢复跟随。
   * 说明：.chat-wrap 位于 .main-inner 内，自身高度由内容撑开、不产生滚动，
   * 对话视图的真实滚动容器是 .main-body（flex:1 + overflow-y:auto），
   * 因此滚动控制必须作用于 .main-body；仅对话视图启用，其他视图保持原行为。
   */
  let followTail = true;

  function scrollToBottom(sc) {
    // 超量赋值由浏览器 clamp 到真实底部，避免布局滞后导致的 ~100px 偏差
    sc.scrollTop = 1e9;
  }

  /* ---------------- 知识图谱画布拖拽平移 ----------------
     Pointer Events 统一鼠标/触摸；生命周期：pointerdown（记录起点、取消惯性）
     → pointermove（超 6px 阈值才进入拖拽，实时钳制边界）→ pointerup/cancel（惯性衰减、
     抑制误触 click）。6px 阈值内的位移视为点击，保证节点点击/气泡跳转不受影响。 */
  function kgBindPan(svg) {
    let drag = null;    // { sx, sy, px, py, moved, lastT, lastX, lastY, vx, vy }
    let inertiaRaf = 0;

    const stopInertia = () => { if (inertiaRaf) { cancelAnimationFrame(inertiaRaf); inertiaRaf = 0; } };
    // 屏幕像素 → viewBox 单位换算（meet 模式取两轴较小缩放比，画布 1660×1000）
    const viewScale = () => {
      const r = svg.getBoundingClientRect();
      const k = Math.min((r.width || 1) / 1660, (r.height || 1) / 1000);
      return k > 0 ? k : 1;
    };

    svg.addEventListener('pointerdown', e => {
      if (e.button != null && e.button !== 0) return; // 仅主键/触摸
      stopInertia();
      const pan = State.kgPan || { x: 0, y: 0 };
      drag = { sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y, moved: false,
        lastT: performance.now(), lastX: e.clientX, lastY: e.clientY, vx: 0, vy: 0 };
      // 注意：此处不能 setPointerCapture——捕获会把后续兼容鼠标事件（含 click）
      // 重定向到 svg 根元素，导致节点点击（data-act 委托）失效、详情卡片不刷新。
      // 捕获延迟到真正进入拖拽（位移超阈值）时才设置，纯点击全程无捕获。
    });

    svg.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.moved && Math.sqrt(dx * dx + dy * dy) < 6) return; // 阈值内视为点击
      if (!drag.moved) {
        drag.moved = true;
        svg.classList.add('kg-dragging');
        // 拖拽确认后才捕获指针：即使拖出画布仍持续接收事件；此时 click 已被
        // _kgDragged 抑制，捕获重定向不再影响节点点击。
        try { svg.setPointerCapture(e.pointerId); } catch (_) {}
      }
      const now = performance.now(), dt = now - drag.lastT;
      if (dt > 0) { drag.vx = (e.clientX - drag.lastX) / dt; drag.vy = (e.clientY - drag.lastY) / dt; }
      drag.lastT = now; drag.lastX = e.clientX; drag.lastY = e.clientY;
      const k = viewScale();
      State.kgPan = kgClampPan(drag.px + dx / k, drag.py + dy / k, State.kgZoom || 1);
      kgApplyPan();
    });

    const end = e => {
      if (!drag) return;
      const moved = drag.moved, vx = drag.vx, vy = drag.vy;
      svg.classList.remove('kg-dragging');
      try { svg.releasePointerCapture(e.pointerId); } catch (_) {}
      drag = null;
      if (moved) {
        // 抑制本次拖拽紧随的 click（节点点击/气泡跳转等），仅屏蔽一次
        State._kgDragged = true;
        setTimeout(() => { State._kgDragged = false; }, 0);
        // 惯性：速度 > 0.05px/ms 时启动，每帧衰减 8%，撞边界或低于阈值即停
        if (Math.sqrt(vx * vx + vy * vy) > 0.05 && svg.isConnected) {
          const k = viewScale();
          let ivx = vx / k, ivy = vy / k; // viewBox 单位 / ms
          let x = (State.kgPan || { x: 0 }).x, y = (State.kgPan || { y: 0 }).y;
          const step = () => {
            if (!svg.isConnected) { inertiaRaf = 0; return; } // 视图已切换重渲染，终止
            ivx *= 0.92; ivy *= 0.92;
            x += ivx * 16; y += ivy * 16;
            const p = kgClampPan(x, y, State.kgZoom || 1);
            if (p.x !== x || p.y !== y) { x = p.x; y = p.y; ivx = 0; ivy = 0; } // 撞边界即停
            State.kgPan = { x, y };
            kgApplyPan();
            inertiaRaf = Math.sqrt(ivx * ivx + ivy * ivy) > 0.002 ? requestAnimationFrame(step) : 0;
          };
          inertiaRaf = requestAnimationFrame(step);
        }
      }
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
  }

  function afterRender() {
    const sc = ($('#chatScroll') && document.querySelector('.main-body')) || null;
    if (sc) {
      if (State.scrollBottom) {
        scrollToBottom(sc);
        State.scrollBottom = false;
        followTail = true;
      } else if (followTail) {
        // 跟随模式：即使非强制滚动（如流式增量渲染），也停在最新消息底部
        scrollToBottom(sc);
      } else {
        // 用户正在上翻阅读历史：恢复其位置
        sc.scrollTop = State.chatScrollTop || 0;
      }
      sc.onscroll = () => {
        State.chatScrollTop = sc.scrollTop;
        // 距底部 60px 内视为“跟随最新消息”
        followTail = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 60;
      };
    }
    const ci = $('#composerInput');
    if (ci) {
      autoGrow(ci);
      if (State.focusComposer) { ci.focus(); ci.selectionStart = ci.value.length; State.focusComposer = false; }
    }
    // 路径入场动画标记仅在本次渲染生效，避免后续重渲染重复播放
    State.pathPopId = null;
    // 装载代码编辑器（会话练习卡 / Agent 答题框等主区内的编程题输入框）
    mountCodeEditors();
    // 知识图谱：滚轮缩放（仅画布内生效，阻止页面滚动；DOM 为重建后的新元素，天然无重复绑定）
    const kgCanvas = document.getElementById('kgCanvas') || document.querySelector('.kg-canvas');
    if (kgCanvas) {
      kgCanvas.addEventListener('wheel', e => {
        e.preventDefault();
        if (e.deltaY < 0) Actions.kgZoomIn();
        else Actions.kgZoomOut();
      }, { passive: false });
    }
    // 知识图谱：拖拽平移（鼠标/触摸统一 Pointer Events，含惯性与边界钳制）
    const kgSvgEl = document.getElementById('kgSvg');
    if (kgSvgEl) kgBindPan(kgSvgEl);
  }

  function autoGrow(t) {
    t.style.height = 'auto';
    t.style.height = Math.min(132, t.scrollHeight) + 'px';
  }

  async function loadWithSkeleton() {
    State.loading = true;
    render();
    await delay(420);
    State.loading = false;
    render();
  }

  /* ---------------- 事件委托 ---------------- */
  document.addEventListener('click', e => {
    // 知识图谱拖拽刚结束（位移超阈值）：本次 click 为拖拽余波，跳过以免误触节点/气泡跳转
    if (State._kgDragged) return;
    const el = e.target;
    // 点击遮罩本身（而非弹窗/抽屉内容）时关闭
    if (el.classList && el.classList.contains('mask')) {
      State.modal = null; renderOverlays(); return;
    }
    if (el.classList && el.classList.contains('drawer-mask')) {
      State.drawer = null; State.grading = null; renderOverlays(); renderCtx(); return;
    }
    const t = el.closest ? el.closest('[data-act]') : null;
    if (!t) return;
    const act = t.dataset.act;
    if (!Actions[act]) return;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
    // 约定：第一个参数为 data-val（目标值），第二个为 data-id（记录 id）
    // 注意：inSide 必须在动作执行前捕获——render() 会重建侧栏 DOM，执行后再取
    // t.closest('#side') 会因节点已脱离而得到 null
    const inSide = !!(t.closest && t.closest('#side'));
    Actions[act](t.dataset.val, t.dataset.id, t);
    // 移动端抽屉：侧栏内操作或底部标签切换后自动收起，避免面板遮挡主内容
    if (window.innerWidth <= 640 && (inSide || act === 'section')) {
      const sd = document.getElementById('side');
      if (sd) sd.classList.remove('open');
    }
  });

  document.addEventListener('input', e => {
    const t = e.target, b = t.dataset.bind;
    if (!b) return;
    if (b === 'draft') { State.draft = t.value; autoGrow(t); }
    else if (b === 'kgq') {
      // 知识图谱搜索：仅局部刷新结果列表，不整页重渲染（避免输入丢焦点）
      State.kgQ = t.value;
      const box = document.getElementById('kgSearchList');
      if (box) box.innerHTML = kgSearchResults(t.value);
    }
    else if (b === 'kpsearch') {
      // 出题知识点面板搜索：仅局部刷新分组列表，避免整窗重渲染导致闪屏与输入丢焦点
      if (State.compose) {
        State.compose._kpQuery = t.value;
        const body = document.querySelector('.kp-panel .kp-panel-body');
        if (body) body.innerHTML = composeKpGroupsHtml();
      }
    }
    else if (b === 'modal') {
      if (State.modal) State.modal.data[t.dataset.key] = t.value;
      // newSession 搜索：仅局部刷新知识点列表，避免整窗重建重放弹窗动画（闪屏）并丢失输入焦点
      if (t.dataset.key === 'q' && State.modal && State.modal.type === 'newSession') {
        const pl = document.querySelector('.modal .pick-list');
        if (pl) pl.innerHTML = newSessionPickList();
      }
    }
    else if (b === 'compose') {
      // 出题组卷：输入只写数据、不重渲染（防丢焦点）；分值输入仅联动总分文本
      const c = State.compose;
      if (!c) return;
      const qi = t.dataset.q !== undefined ? Number(t.dataset.q) : null;
      if (qi !== null) {
        const q = c.questions[qi];
        if (!q) return;
        if (t.dataset.oi !== undefined) { (q.options[Number(t.dataset.oi)] || {}).text = t.value; }
        else if (t.dataset.key === 'answerText') { q.answer = [t.value]; }
        else if (t.dataset.key === 'score') { q.score = Number(t.value) || 0; updateComposeStats(); }
        else if (t.dataset.key === 'difficulty') { q.difficulty = Number(t.value) || 0.5; }
        else { q[t.dataset.key] = t.value; }
      } else {
        c[t.dataset.key] = t.value;
      }
    }
    else if (b === 'dtp') {
      // 时间选择器：时/分输入写回弹层状态，不重渲染
      if (State.compose && State.compose._dtp) {
        const v = Math.max(0, Math.min(Number(t.value) || 0, t.dataset.key === 'hour' ? 23 : 59));
        State.compose._dtp[t.dataset.key] = v;
      }
    }
    else if (b === 'import') {
      // 导入作业：内容变更写回 + 1 秒防抖自动识别（右侧实时联动，左侧不重渲染保焦点）
      const im = State.compose && State.compose.import;
      if (!im) return;
      im.text = t.value;
      clearTimeout(importTimer);
      importTimer = setTimeout(importParse, 1000);
    }
    else if (b === 'answer') {
      // 学生答题：填空/简答/编程文本输入写回答案（不重渲染保焦点），导航状态防抖联动
      const c = State.answer;
      if (!c) return;
      c.answers[Number(t.dataset.qi)] = t.value;
      clearTimeout(ansTextTimer);
      ansTextTimer = setTimeout(refreshAnswerPanels, 400);
    }
    else if (b === 'exAns') {
      // 会话练习卡：非选择题文本作答写回卡片（不重渲染保焦点），提交按钮可用态联动
      const sm = session();
      if (!sm) return;
      const m = sm.messages.find(x => String(x.id) === String(t.dataset.id));
      if (m && m.card) {
        m.card.textAnswer = t.value;
        const btn = document.querySelector('[data-act="submitEx"][data-id="' + t.dataset.id + '"]');
        if (btn) btn.disabled = !t.value.trim();
      }
    }
    else if (b === 'quizReply') {
      // Agent Markdown 生成题目的作答框输入（本地暂存，不重渲染）
      State.quizReply = State.quizReply || {};
      State.quizReply[t.dataset.id] = t.value;
      const btn = document.querySelector('[data-act="quizSubmit"][data-id="' + t.dataset.id + '"]');
      if (btn) btn.disabled = !t.value.trim();
    }
    else if (b === 'rubricTotal') {
      // 题目型作业：教师录入总分，仅更新合计预览（不重渲染保输入焦点）
      State.grading.total = Number(t.value) || 0;
      const pv = $('#scorePreview');
      if (pv) pv.textContent = State.grading.total;
    }
    else if (b === 'rubric') {
      State.grading.scores[t.dataset.id] = Number(t.value) || 0;
      const sub = DB.submissions.find(x => x.id === State.drawer.subId);
      const a = DB.assignments.find(x => x.id === sub.asId);
      const total = a.rubric.reduce((s, r) => s + (Number(State.grading.scores[r.name]) || 0), 0);
      const p = $('#scorePreview'); if (p) p.textContent = total;
    }
    else if (b === 'comment') { State.grading.comment = t.value; }
  });

  // 班级导入：文件选择（change 事件）
  document.addEventListener('change', e => {
    const t = e.target;
    if (t && t.dataset && t.dataset.importFile !== undefined && State.modal
        && State.modal.type === 'importClass') {
      const file = t.files && t.files[0];
      if (file) {
        State.modal.data.file = file;
        renderOverlays();
      }
    }
    // 导入作业：题目文件选择（Word / Excel / 图片）
    if (t && t.dataset && t.dataset.importQfile !== undefined && State.compose
        && State.compose.import) {
      const file = t.files && t.files[0];
      if (file) {
        Actions.importUploadFile(file);
        t.value = '';
      }
    }
    // 出题组卷：正确答案勾选（radio/checkbox 原生视觉切换，仅回写数据不重渲染）
    if (t && t.dataset && t.dataset.ans !== undefined && State.compose) {
      const c = State.compose;
      if (t.dataset.ans === 'mode') {
        // 评分机制切换：radio 原生切换 + 整层重渲染（按钮操作无焦点丢失；分值展示联动）
        c.scoreMode = t.dataset.val || 'AVERAGE';
        if (c.scoreMode !== 'CUSTOM') c.questions.forEach(q => { q.score = null; });
        renderOverlays();
        return;
      }
      const q = c.questions[Number(t.dataset.q)];
      if (!q) return;
      if (t.dataset.ans === 'single') { q.answer = t.checked ? [q.options[Number(t.dataset.oi)].key] : []; }
      else if (t.dataset.ans === 'multi') {
        const k = q.options[Number(t.dataset.oi)].key, i = q.answer.indexOf(k);
        if (t.checked && i < 0) q.answer.push(k);
        else if (!t.checked && i >= 0) q.answer.splice(i, 1);
      }
      else if (t.dataset.ans === 'judge') { q.answer = [t.dataset.val === 'true']; }
    }
    // 学生答题：单选 / 多选 / 判断（原生视觉切换，仅回写答案并联动题号导航）
    if (t && t.dataset && State.answer
        && (t.dataset.ans === 'answerSingle' || t.dataset.ans === 'answerMulti' || t.dataset.ans === 'answerJudge')) {
      const qi = Number(t.dataset.qi);
      const v = t.dataset.val;
      if (t.dataset.ans === 'answerSingle') {
        State.answer.answers[qi] = t.checked ? v : '';
      } else if (t.dataset.ans === 'answerJudge') {
        State.answer.answers[qi] = t.checked ? v === 'true' : '';
      } else {
        const arr = Array.isArray(State.answer.answers[qi]) ? State.answer.answers[qi] : [];
        const i = arr.indexOf(v);
        if (t.checked && i < 0) arr.push(v);
        else if (!t.checked && i >= 0) arr.splice(i, 1);
        State.answer.answers[qi] = arr;
      }
      refreshAnswerPanels();
    }
  });

  function focusKeep(key) {
    const el = document.querySelector('[data-bind="modal"][data-key="' + key + '"]');
    if (el) { el.focus(); el.selectionStart = el.value.length; }
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (State.modal || State.drawer) { State.modal = null; State.drawer = null; renderOverlays(); }
      return;
    }
    if (e.target.id === 'composerInput' && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      Actions.send();
    }
  });

  /* ---------------- 启动 ---------------- */
  async function boot() {
    if (!Auth.requireLogin()) return;
    render();
    try {
      await loadRemote();
    } catch (e) {
      toast(e.message || '数据加载失败');
    }
    State.booting = false;
    render();
  }
  boot();
})();
