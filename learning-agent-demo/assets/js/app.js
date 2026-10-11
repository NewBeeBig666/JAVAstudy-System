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

  function md(t) {
    return h(t)
      .replace(/```(\w+)?\n?([\s\S]*?)```/g, (m, l, c) => '<pre class="code-block cb">' + c + '</pre>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/^[-·•] (.+)$/gm, '<p style="padding-left:12px">• $1</p>')
      .split('\n')
      .map(l => (l.trim() ? (l.startsWith('<p') || l.startsWith('<pre') ? l : '<p>' + l + '</p>') : ''))
      .join('');
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
    grading: null,
    insight: null,
    filters: { hw: 'all', warn: 'all', kpModule: 'all', subAs: 'as-2', exKp: 'all', classId: 'c1', report: 'overview' },
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

    } else if (sec === 'knowledge') {
      head = '<div class="side-head"><div class="side-title">知识模块</div></div>';
      body = `<button class="list-item ${State.filters.kpModule === 'all' ? 'on' : ''}" data-act="kpModule" data-val="all">
          <div class="li-main"><div class="li-title">全部知识点</div><div class="li-sub">${DB.knowledgePoints.length} 个 · 平均 ${DB.student ? DB.student.avgMastery : '-'} 分</div></div></button>` +
        DB.modules.map(m => {
          const ks = DB.knowledgePoints.filter(k => k.module === m.id);
          const avg = Math.round(ks.reduce((a, b) => a + b.mastery, 0) / ks.length);
          return `<button class="list-item ${State.filters.kpModule === m.id ? 'on' : ''}" data-act="kpModule" data-val="${m.id}">
            <div class="li-main"><div class="li-title">${m.name}</div><div class="li-sub">${ks.length} 个知识点 · 平均 ${avg} 分</div></div>
            <div class="li-extra"><span class="badge ${bcls(avg) === 'ok' ? 'ok' : bcls(avg) === 'danger' ? 'danger' : bcls(avg) === 'warn' ? 'warn' : 'brand'}">${avg}</span></div>
          </button>`;
        }).join('');

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
        ? '<button class="btn primary block" data-act="publishModal">' + icon('plus', 15) + ' 发布新作业</button>'
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
    box.innerHTML = head + '<div class="main-body"><div class="main-inner">' + body + '</div></div>';
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
    return `<div class="msg">
      <div class="avatar agent" style="background:linear-gradient(135deg,${ag.color},#8b5cf6)">${ag.name.slice(0, 2)}</div>
      <div class="msg-col">
        <div class="msg-meta"><b>${ag.name}</b>${tag}<span>${m.time || ''}</span></div>
        ${m.text ? '<div class="agent-text">' + md(m.text) + '</div>' : ''}
        ${m.card ? renderCard(m.card, m.id, s) : ''}
      </div></div>`;
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
      const answer = c.answer != null ? c.answer : (ex.answer != null ? ex.answer : -1);
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
      const hints = (c.hintTexts || []).map((x, i) =>
        `<div class="hint-box"><b>提示 ${i + 1}：</b>${h(x)}</div>`).join('');
      return `<div class="work">
        <div class="work-head">${icon('edit', 15)}<span class="wt">${ex.type === 'code' ? '代码陪练题' : '随堂练习'} · ${kpName(ex.kp)}</span>
          <div class="spacer"></div><span class="badge ${ex.difficulty === '困难' ? 'danger' : ex.difficulty === '中等' ? 'warn' : 'ok'}">${ex.difficulty}</span></div>
        <div class="work-body">
          <div style="font-size:13.5px;line-height:1.7;margin-bottom:10px">${h(ex.stem)}</div>
          ${ex.code ? '<pre class="code-block cb">' + h(ex.code) + '</pre>' : ''}
          <div style="margin-top:10px">${opts}</div>
          ${hints ? '<div style="margin-top:12px">' + hints + '</div>' : ''}
        </div>
        <div class="work-foot">
          ${graded
            ? '<span class="badge ok">' + icon('check', 12) + ' 已作答，掌握度已更新</span>'
            : `<button class="btn sm primary" data-act="submitEx" data-id="${msgId}" ${c.selected === null ? 'disabled' : ''}>提交答案</button>
               <button class="btn sm" data-act="hint" data-id="${msgId}" ${c.hintLevel >= 3 ? 'disabled' : ''}>${icon('flame', 14)} 再要一级提示 (${c.hintLevel}/3)</button>`}
          <div style="flex:1"></div>
          <span style="font-size:11.5px;color:var(--text-3)">提示使用次数教师端可见</span>
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

  /* ---------------- 学生：知识图谱 ---------------- */
  function viewKnowledge() {
    const mod = State.filters.kpModule;
    const list = DB.knowledgePoints.filter(k => mod === 'all' || k.module === mod);
    const cur = kp(State.activeKp);
    const head = mainHead('知识图谱与掌握度', '共 ' + DB.knowledgePoints.length + ' 个知识点 · 点击卡片查看依赖链溯源');

    const cells = list.map(k => `<div class="kp-cell ${mcls(k.mastery)} ${State.activeKp === k.id ? 'on' : ''}" data-act="kpCell" data-val="${k.id}">
      <div class="nm">${k.name}</div>
      <div class="mv" style="color:${k.mastery >= 80 ? 'var(--ok)' : k.mastery >= 60 ? 'var(--info)' : k.mastery >= 40 ? 'var(--warn)' : 'var(--danger)'}">${k.mastery}</div>
      <div class="bar ${bcls(k.mastery)}"><i style="width:${k.mastery}%"></i></div>
      <div style="font-size:11px;color:var(--text-3);margin-top:6px">${mtext(k.mastery)}</div>
    </div>`).join('');

    // 依赖链溯源
    const chain = traceChain(cur.id);
    const chainHtml = chain.map((c, i) =>
      (i ? '<span class="chain-arrow">' + icon('chevronR', 15) + '</span>' : '') +
      `<span class="chain-node ${c.root ? 'root' : ''}" data-act="kpCell" data-val="${c.id}">${kpName(c.id)} · ${kp(c.id).mastery} 分</span>`
    ).join('');

    const weak = DB.knowledgePoints.slice().sort((a, b) => a.mastery - b.mastery).slice(0, 3);

    const body = `
      <div class="card"><div class="card-head">${icon('target', 15)}<h3>掌握度热力图</h3><div class="spacer"></div>
        <span class="badge">${mod === 'all' ? '全部' : DB.modules.find(m => m.id === mod).name}</span></div>
        <div class="card-body"><div class="kp-grid">${cells}</div></div></div>

      <div class="split">
        <div class="card"><div class="card-head">${icon('route', 15)}<h3>依赖链溯源 · ${cur.name}</h3><div class="spacer"></div>
          <span class="badge ${bcls(cur.mastery) === 'danger' ? 'danger' : bcls(cur.mastery) === 'warn' ? 'warn' : 'ok'}">${cur.mastery} 分 · ${mtext(cur.mastery)}</span></div>
          <div class="card-body">
            <div style="font-size:13px;color:var(--text-2);line-height:1.7;margin-bottom:10px">${h(cur.desc)}</div>
            <div class="chain">${chainHtml}</div>
            <div class="note ${chain.find(c => c.root) ? 'warn' : 'ok'}">
              ${chain.find(c => c.root)
                ? '溯源结论：真正卡住你的是 <b>' + kpName(chain.find(c => c.root).id) + '</b>（' + kp(chain.find(c => c.root).id).mastery + ' 分），先补它再回到「' + cur.name + '」收益才高。'
                : '该知识点前置依赖均已达标，可以直接推进。'}
            </div>
            <div style="margin-top:12px">
              <div style="font-size:12px;font-weight:600;margin-bottom:6px">参考资源</div>
              ${(cur.resources || []).map(r => '<div style="font-size:12.5px;color:var(--text-2);padding:3px 0">· ' + h(r) + '</div>').join('') || '<div style="font-size:12.5px;color:var(--text-3)">暂无</div>'}
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
          </div></div>
      </div>`;
    return { head, body };
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
      } else if (st.key === 'pending') {
        extra = `<div class="note" style="margin-top:10px">已提交于 ${sub.submittedAt} · 教师批改中，批改完成后会在这里和会话里同步通知你。</div>`;
      }
      return `<div class="card" id="hw-${a.id}" style="${State.focusHwId === a.id ? 'border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)' : ''}">
        <div class="card-head">${icon('clipboard', 15)}<h3>${h(a.title)}</h3>
          <div class="spacer"></div><span class="badge ${st.cls}">${st.label}</span></div>
        <div class="card-body">
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
            ${a.kp.map(k => '<span class="badge brand">' + kpName(k) + '</span>').join('')}
            <span class="badge">${icon('clock', 12)} 截止 ${h(a.due)}</span>
          </div>
          <div style="font-size:13px;color:var(--text-2);line-height:1.7">${h(a.desc)}</div>
          ${st.key === 'todo' ? `<div style="margin-top:12px">
            <button class="btn primary" data-act="submitHw" data-val="${a.id}">${icon('send', 14)} 提交作业</button></div>` : ''}
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
      '<button class="btn primary sm" data-act="publishModal">' + icon('plus', 14) + ' 发布新作业</button>');
    if (!DB.assignments.length) {
      return { head, body: emptyBox('还没有作业', '点击右上角「发布新作业」，发布后学生侧会立即看到。') };
    }
    const body = DB.assignments.map(a => {
      const pct = Math.round(a.submitted / a.total * 100);
      const stBadge = a.status === 'draft' ? '<span class="badge">草稿</span>'
        : a.status === 'ongoing' ? '<span class="badge info">进行中</span>' : '<span class="badge ok">已截止</span>';
      return `<div class="card">
        <div class="card-head">${icon('clipboard', 15)}<h3>${h(a.title)}</h3><div class="spacer"></div>${stBadge}</div>
        <div class="card-body">
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
            ${a.kp.map(k => '<span class="badge brand">' + kpName(k) + '</span>').join('')}
            <span class="badge">${icon('clock', 12)} 截止 ${h(a.due)}</span>
          </div>
          <div style="font-size:13px;color:var(--text-2);line-height:1.7;margin-bottom:12px">${h(a.desc)}</div>
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
            <div class="bar" style="flex:1"><i style="width:${pct}%"></i></div>
            <span style="font-size:12.5px;font-weight:600">${a.submitted}/${a.total}</span>
          </div>
          <div style="font-size:12px;font-weight:600;margin-bottom:6px;color:var(--text-2)">Rubric（满分 100）</div>
          <div class="mini-list">
            ${a.rubric.map(r => `<div class="mini-row"><span class="nm">${h(r.name)}</span>
              <span style="flex:1;font-size:11.5px;color:var(--text-3)">${h(r.desc)}</span>
              <span class="vl">${r.max}</span></div>`).join('')}
          </div>
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
          '<button class="btn primary sm" data-act="publishModal">' + icon('plus', 14) + ' 发布新作业</button>'),
        body: emptyBox('还没有作业', '先在「作业管理」发布作业，学生提交后会实时出现在这里，支持 AI 初评 + Rubric 人工复核。')
      };
    }
    const list = DB.submissions.filter(s => s.asId === a.id);
    const pend = list.filter(s => s.status === 'pending').length;
    const head = mainHead('提交批改', h(a.title) + ' · 共 ' + list.length + ' 条记录 · ' + pend + ' 份待批改');

    if (!list.length) {
      return { head, body: emptyBox('还没有学生提交', '作业发布后学生的提交会实时出现在这里，支持 AI 初评 + Rubric 人工复核。') };
    }
    const body = `<div class="card"><div class="card-head">${icon('inbox', 15)}<h3>提交列表</h3><div class="spacer"></div>
      <span class="badge warn">${pend} 待批改</span>
      ${pend ? '<button class="btn sm primary" data-act="batchAi">AI 批量初评</button>' : ''}</div>
      <div style="overflow-x:auto"><table class="table">
        <thead><tr><th>学生</th><th>提交时间</th><th class="num">次数</th><th class="num">相似度</th><th>时段</th><th class="num">AI 初评</th><th class="num">最终分</th><th>状态</th></tr></thead>
        <tbody>${list.map(s => {
          const stb = s.status === 'graded' ? '<span class="badge ok">已批改</span>'
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
    if (State.modal) html += renderModal();
    if (State.drawer) html += renderDrawer();
    box.innerHTML = html;
  }

  function renderModal() {
    const m = State.modal, d = m.data || {};
    let title = '', body = '', foot = '';
    if (m.type === 'newSession') {
      title = '新建学习会话 · 选择知识点';
      const list = DB.knowledgePoints.filter(k => !m.q || k.name.indexOf(m.q) >= 0);
      body = `<div class="field" style="margin-bottom:12px">${icon('search', 15)}
          <input placeholder="搜索知识点，如：并发、集合、JVM" value="${h(m.q || '')}" data-bind="modal" data-key="q"></div>
        <div class="pick-list">${list.map(k => `<div class="pick ${d.kp === k.id ? 'on' : ''}" data-act="pickKp" data-val="${k.id}">
          <div class="pm"><div class="pn">${k.name}</div><div class="pd">${h(k.desc.slice(0, 34))}…</div></div>
          <div style="text-align:right">
            <div style="font-size:16px;font-weight:700;color:${k.mastery >= 60 ? 'var(--ok)' : 'var(--danger)'}">${k.mastery}</div>
            <div style="font-size:11px;color:var(--text-3)">${mtext(k.mastery)}</div></div>
        </div>`).join('') || '<div class="empty"><div class="empty-title">没有匹配的知识点</div></div>'}</div>`;
      foot = `<button class="btn" data-act="closeModal">取消</button>
        <button class="btn primary" data-act="createSession" ${d.kp ? '' : 'disabled'}>${icon('sparkles', 15)} 创建并生成学习路径</button>`;

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
          <textarea class="textarea" style="min-height:220px;font-family:var(--mono);font-size:12.5px" data-bind="modal" data-key="code">${h(d.code || '')}</textarea>
          <div class="hint">提交后可等待 AI 初评与教师复核，支持多次重新提交（次数教师端可见）。</div></div>`;
      foot = `<button class="btn" data-act="closeModal">取消</button>
        <button class="btn primary" data-act="doSubmitHw">${icon('send', 15)} 确认提交</button>`;

    } else if (m.type === 'publish') {
      title = '发布新作业';
      const tpls = {
        coding: [{ name: '功能正确性', max: 40, desc: '核心逻辑与结果正确' }, { name: '边界与异常处理', max: 20, desc: '非法入参与异常场景' }, { name: '复杂度与设计', max: 20, desc: '时间与空间复杂度合理' }, { name: '代码规范与注释', max: 20, desc: '命名、注释、结构' }],
        algo: [{ name: '算法正确性', max: 45, desc: '通过全部测试用例' }, { name: '复杂度分析', max: 25, desc: '给出并证明复杂度' }, { name: '边界处理', max: 15, desc: '空输入、极大值' }, { name: '代码可读性', max: 15, desc: '命名与注释' }],
        test: [{ name: '用例完整性', max: 40, desc: '分支覆盖充分' }, { name: 'Mock 合理性', max: 25, desc: '依赖隔离正确' }, { name: '断言质量', max: 20, desc: '断言具体可读' }, { name: '代码规范', max: 15, desc: '命名与组织' }]
      };
      const cur = tpls[d.tpl || 'coding'];
      body = `<div class="form-row"><label>作业标题</label>
          <input class="input" placeholder="例：并发编程实战：线程池参数调优" value="${h(d.title || '')}" data-bind="modal" data-key="title"></div>
        <div class="form-row"><label>关联知识点</label>
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            ${DB.knowledgePoints.map(k => `<button class="chip ${(d.kp || []).indexOf(k.id) >= 0 ? 'on' : ''}" data-act="pubKp" data-val="${k.id}">${k.name}</button>`).join('')}
          </div></div>
        <div class="row-2">
          <div class="form-row"><label>截止时间</label>
            <input class="input" placeholder="2026-10-10 23:59" value="${h(d.due || '')}" data-bind="modal" data-key="due"></div>
          <div class="form-row"><label>Rubric 模板</label>
            <select class="select" data-bind="modal" data-key="tpl">
              <option value="coding" ${d.tpl === 'coding' ? 'selected' : ''}>综合编程（默认）</option>
              <option value="algo" ${d.tpl === 'algo' ? 'selected' : ''}>算法题</option>
              <option value="test" ${d.tpl === 'test' ? 'selected' : ''}>测试题</option>
            </select></div>
        </div>
        <div class="form-row"><label>作业要求</label>
          <textarea class="textarea" placeholder="描述任务目标、交付形式与评分说明…" data-bind="modal" data-key="desc">${h(d.desc || '')}</textarea></div>
        <div class="form-row"><label>Rubric 预览（满分 100）</label>
          ${cur.map(r => `<div class="rubric-row"><div class="rn"><b>${r.name}</b><span>${r.desc}</span></div><span class="badge">${r.max} 分</span></div>`).join('')}
        </div>`;
      foot = `<button class="btn" data-act="closeModal">取消</button>
        <button class="btn primary" data-act="doPublish">${icon('send', 15)} 发布给学生</button>`;

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
    let inner = '';
    if (sub.status === 'missing') {
      inner = '<div class="empty"><div class="empty-ico">' + icon('inbox', 22) + '</div><div class="empty-title">该学生未提交</div><div class="empty-desc">可直接记 0 分或发起提醒。</div></div>';
    } else {
      const total = a.rubric.reduce((s, r) => s + (Number(g.scores[r.name]) || 0), 0);
      inner = `<div style="margin-bottom:14px">
          <div style="font-size:12px;font-weight:600;margin-bottom:6px">提交代码</div>
          <pre class="code-block">${h(sub.code)}</pre></div>
        <div class="note warn" style="margin-bottom:14px"><b>AI 初评（${sub.aiScore} 分）：</b>${h(sub.aiComment)}</div>
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
          <div style="font-size:12px;font-weight:600">相似度检测</div>
          <div class="bar ${sub.similarity > 60 ? 'danger' : sub.similarity > 30 ? 'warn' : 'ok'}" style="flex:1"><i style="width:${sub.similarity}%"></i></div>
          <span style="font-weight:700;color:${sub.similarity > 60 ? 'var(--danger)' : 'var(--text)'}">${sub.similarity}%</span>
        </div>
        <div style="font-size:12px;font-weight:600;margin-bottom:6px">Rubric 评分</div>
        ${a.rubric.map(r => `<div class="rubric-row">
          <div class="rn"><b>${h(r.name)}</b><span>${h(r.desc)}</span></div>
          <input class="input" type="number" min="0" max="${r.max}" value="${g.scores[r.name] != null ? g.scores[r.name] : ''}" placeholder="0" data-bind="rubric" data-id="${h(r.name)}">
          <span style="font-size:12px;color:var(--text-3);width:36px">/${r.max}</span>
        </div>`).join('')}
        <div style="display:flex;align-items:center;gap:10px;margin:14px 0">
          <span style="font-size:13px;font-weight:600">合计</span>
          <span class="score-big" id="scorePreview">${total}</span>
          <span style="color:var(--text-3)">/ 100</span>
          <div style="flex:1"></div>
          <button class="btn sm ghost" data-act="useAi">采用 AI 初评</button>
        </div>
        <div class="form-row"><label>教师评语（将同步给学生）</label>
          <textarea class="textarea" placeholder="肯定做得好的地方 + 一条具体改进建议…" data-bind="comment">${h(g.comment || '')}</textarea></div>`;
    }
    return `<div class="drawer-mask"></div>
      <div class="drawer">
        <div class="drawer-head">
          <span class="badge ${sub.status === 'graded' ? 'ok' : 'warn'}">${sub.status === 'graded' ? '已批改' : '待批改'}</span>
          <h3>${sub.name} · ${h(a.title)}</h3><div style="flex:1"></div>
          <span style="font-size:12px;color:var(--text-3)">${sub.submittedAt || '未提交'}</span>
          <button class="icon-btn" data-act="closeDrawer">${icon('x', 16)}</button></div>
        <div class="drawer-body">${inner}</div>
        <div class="drawer-foot">
          ${sub.status === 'graded'
            ? '<span class="badge ok">' + icon('check', 12) + ' 已发布反馈（得分 ' + sub.score + '）</span>'
            : '<button class="btn primary" data-act="doGrade">' + icon('send', 15) + ' 发布评分与反馈</button>' +
              '<button class="btn" data-act="doGradeZero">记 0 分（未提交）</button>'}
          <div style="flex:1"></div>
          <button class="btn ghost" data-act="closeDrawer">关闭</button>
        </div>
      </div>`;
  }

  /* ===========================================================
   *  交互动作
   * =========================================================== */
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
    newSession() { State.modal = { type: 'newSession', data: { kp: null, q: '' } }; renderOverlays(); },
    pickKp(v) { State.modal.data.kp = v; renderOverlays(); },
    async createSession() {
      const kid = State.modal.data.kp;
      if (!kid) return;
      State.modal = null; renderOverlays();
      toast('智能体正在诊断并规划学习路径…');
      try {
        const s = await API.post('/sessions', { kpId: kid });
        DB.sessions.unshift(s);
        State.sessionId = s.id; State.activeKp = kid; State.scrollBottom = true;
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
      if (!m || m.card.selected == null || m.card.state !== 'answering') return;
      const ex = m.card.exercise || getEx(m.card.exId);
      if (!ex) { toast('题目数据缺失，请重新获取练习'); return; }
      m.card.state = 'grading';
      render();
      try {
        const r = await API.post('/exercises/' + m.card.exId + '/attempt', {
          selected: m.card.selected,
          hintUsed: m.card.hintLevel || 0
        });
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
              hintLevel: m.card.hintLevel || 0, hintTexts: m.card.hintTexts || []
            });
          }
          ns.messages.push(resultMsg);
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
    kpModule(v) { State.filters.kpModule = v; render(); },
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
    publishModal() { State.modal = { type: 'publish', data: { kp: [], tpl: 'coding' } }; renderOverlays(); },
    pubKp(v, id, t) {
      const d = State.modal.data; d.kp = d.kp || [];
      const i = d.kp.indexOf(v);
      if (i >= 0) d.kp.splice(i, 1); else d.kp.push(v);
      // 局部切换当前 chip 的选中态：若整窗 innerHTML 重建，mask/modal 的
      // 入场动画（fade/pop）会被重放，造成点击时的闪屏；改为直接改 class。
      if (t && t.classList) t.classList.toggle('on', i < 0);
    },
    async doPublish() {
      const d = State.modal.data;
      const tpls = {
        coding: [{ name: '功能正确性', max: 40, desc: '核心逻辑与结果正确' }, { name: '边界与异常处理', max: 20, desc: '非法入参与异常场景' }, { name: '复杂度与设计', max: 20, desc: '时间与空间复杂度合理' }, { name: '代码规范与注释', max: 20, desc: '命名、注释、结构' }],
        algo: [{ name: '算法正确性', max: 45, desc: '通过全部测试用例' }, { name: '复杂度分析', max: 25, desc: '给出并证明复杂度' }, { name: '边界处理', max: 15, desc: '空输入、极大值' }, { name: '代码可读性', max: 15, desc: '命名与注释' }],
        test: [{ name: '用例完整性', max: 40, desc: '分支覆盖充分' }, { name: 'Mock 合理性', max: 25, desc: '依赖隔离正确' }, { name: '断言质量', max: 20, desc: '断言具体可读' }, { name: '代码规范', max: 15, desc: '命名与组织' }]
      };
      if (!d.title || !d.title.trim()) { toast('请填写作业标题'); return; }
      try {
        await API.post('/teacher/assignments', {
          title: d.title, desc: d.desc || '', kp: d.kp || [],
          due: d.due || '', status: 'ONGOING',
          rubric: tpls[d.tpl || 'coding']
        });
        State.modal = null; renderOverlays();
        DB.assignments = await API.get('/teacher/assignments');
        render();
        toast('作业已发布，学生侧已同步收到', 'ok');
      } catch (e) { toast(e.message); }
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
      const a = DB.assignments.find(x => x.id === sub.asId);
      const scores = {};
      a.rubric.forEach(r => {
        scores[r.name] = (sub.rubricScores && sub.rubricScores[r.name] != null)
          ? sub.rubricScores[r.name]
          : Math.round(r.max * ((sub.aiScore != null ? sub.aiScore : 70) / 100));
      });
      State.grading = { subId: v, scores, comment: sub.teacherComment || '' };
      State.drawer = { subId: v };
      renderOverlays(); renderCtx();
    },
    closeDrawer() { State.drawer = null; State.grading = null; renderOverlays(); renderCtx(); },
    useAi() {
      const sub = DB.submissions.find(x => x.id === State.drawer.subId);
      const a = DB.assignments.find(x => x.id === sub.asId);
      const g = State.grading;
      const ratio = (sub.aiScore != null ? sub.aiScore : 70) / 100;
      a.rubric.forEach(r => { g.scores[r.name] = Math.round(r.max * ratio); });
      renderOverlays();
      toast('已按 AI 初评比例填充，请人工复核后发布');
    },
    async doGrade() {
      const sub = DB.submissions.find(x => x.id === State.drawer.subId);
      const g = State.grading;
      try {
        await API.post('/teacher/submissions/' + sub.id + '/grade', {
          rubricScores: g.scores, comment: g.comment || ''
        });
        State.drawer = null; State.grading = null;
        renderOverlays(); renderCtx();
        await loadSubmissions(sub.asId);
        render();
        toast('评分已发布，学生侧已收到反馈', 'ok');
      } catch (e) { toast(e.message); }
    },
    async doGradeZero() {
      const sub = DB.submissions.find(x => x.id === State.drawer.subId);
      const a = DB.assignments.find(x => x.id === sub.asId);
      const scores = {};
      a.rubric.forEach(r => { scores[r.name] = 0; });
      try {
        await API.post('/teacher/submissions/' + sub.id + '/grade', {
          rubricScores: scores, comment: '未提交，记 0 分。请尽快补交，有困难可随时联系我。'
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
      const [tree, classes, students, dash, warnings, assignments, notifications] = await Promise.all([
        API.get('/knowledge/tree'),
        API.get('/teacher/classes'),
        API.get('/teacher/students'),
        API.get('/teacher/dashboard'),
        API.get('/teacher/warnings'),
        API.get('/teacher/assignments'),
        API.get('/notifications')
      ]);
      DB.modules = tree.modules; DB.knowledgePoints = tree.knowledgePoints;
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
      const [tree, sessions, overview, assignments, notifications, records] = await Promise.all([
        API.get('/knowledge/tree'),
        API.get('/sessions'),
        API.get('/reports/overview'),
        API.get('/assignments/my'),
        API.get('/notifications'),
        API.get('/exercise-records')
      ]);
      DB.modules = tree.modules; DB.knowledgePoints = tree.knowledgePoints;
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
    $('#side').innerHTML = renderSide();
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
    Actions[act](t.dataset.val, t.dataset.id, t);
  });

  document.addEventListener('input', e => {
    const t = e.target, b = t.dataset.bind;
    if (!b) return;
    if (b === 'draft') { State.draft = t.value; autoGrow(t); }
    else if (b === 'modal') { if (State.modal) State.modal.data[t.dataset.key] = t.value; if (t.dataset.key === 'q') renderOverlays(), focusKeep(t.dataset.key); }
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
