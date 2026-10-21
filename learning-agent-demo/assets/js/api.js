/* ===========================================================
 * API 客户端：RESTful 封装 + SSE 流式解析
 * 401 自动跳登录页；非 0 code 抛错（调用方 toast）
 * =========================================================== */
window.API = (function () {
  'use strict';
  const BASE = '/api';

  function token() { return localStorage.getItem('la_token') || ''; }

  async function request(method, path, body, timeoutMs) {
    const opt = { method: method, headers: { 'Authorization': 'Bearer ' + token() } };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json;charset=utf-8';
      opt.body = JSON.stringify(body);
    }
    // 超时兜底：网络僵死（切网/锁屏/连接挂起）时 fetch 永不结束，调用方的
    // busy 锁（保存/生成/提交按钮）将永久卡死，只能刷新页面——与 SSE 空闲
    // 超时是同一类问题。默认 120s：覆盖「一键AI生成题目」等长请求（后端
    // DeepSeek read-timeout 90s），到时中止并抛错，busy 锁得以释放。
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 120000);
    opt.signal = ctrl.signal;
    let res;
    try {
      res = await fetch(BASE + path, opt);
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('请求超时无响应，请检查网络后重试');
      throw new Error('网络连接失败，请检查网络后重试');
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) { window.Auth.logout(); throw new Error('登录已过期，请重新登录'); }
    let data = null;
    try { data = await res.json(); } catch (e) { /* 非 JSON 响应 */ }
    if (!res.ok || !data || data.code !== 0) {
      throw new Error((data && data.msg) || ('请求失败 (' + res.status + ')'));
    }
    return data.data;
  }

  const get = (p, timeoutMs) => request('GET', p, undefined, timeoutMs);
  const post = (p, b, timeoutMs) => request('POST', p, b === undefined ? {} : b, timeoutMs);
  const put = (p, b, timeoutMs) => request('PUT', p, b === undefined ? {} : b, timeoutMs);
  const del = (p, timeoutMs) => request('DELETE', p, undefined, timeoutMs);

  /**
   * multipart 文件上传（FormData）：不设 Content-Type（浏览器自动带 boundary），
   * 默认 300s 超时兜底（大文件 + 上传后端同步 AI 识别耗时）。
   */
  async function upload(path, formData, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 300000);
    let res;
    try {
      res = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token() },
        body: formData,
        signal: ctrl.signal
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('上传超时无响应，请检查网络后重试');
      throw new Error('网络连接失败，请检查网络后重试');
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) { window.Auth.logout(); throw new Error('登录已过期，请重新登录'); }
    let data = null;
    try { data = await res.json(); } catch (e) { /* 非 JSON 响应 */ }
    if (!res.ok || !data || data.code !== 0) {
      throw new Error((data && data.msg) || ('上传失败 (' + res.status + ')'));
    }
    return data.data;
  }

  /**
   * SSE 流式请求（POST + ReadableStream 解析）
   * handlers: { meta, delta, card, replace, done, error }
   *
   * 空闲超时保护：45 秒内未收到任何事件即中断连接并抛错。
   * 覆盖移动端切后台/锁屏/网络切换等导致的连接僵死——否则 fetch 永不结束，
   * 调用方的发送锁（如 State.chatting）将永久锁死，表现为"点了发送没反应"。
   * 正常长回答不受影响：每收到一个事件就重置计时器。
   */
  async function sse(path, body, handlers) {
    const ctrl = new AbortController();
    const IDLE_MS = 45000;
    let idleTimer = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ctrl.abort(), IDLE_MS);
    };
    resetIdle();
    let res;
    try {
      res = await fetch(BASE + path, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token(),
          'Content-Type': 'application/json;charset=utf-8',
          'Accept': 'text/event-stream'
        },
        body: JSON.stringify(body || {}),
        signal: ctrl.signal
      });
    } catch (e) {
      clearTimeout(idleTimer);
      if (e && e.name === 'AbortError') { throw new Error('连接超时无响应，请重试'); }
      throw new Error('网络连接失败，请检查网络后重试');
    }
    if (res.status === 401) { clearTimeout(idleTimer); window.Auth.logout(); throw new Error('登录已过期，请重新登录'); }
    if (!res.ok || !res.body) {
      clearTimeout(idleTimer);
      // 读取后端统一 JSON 错误结构（如"你的请求太频繁了"），给学生可见的明确提示
      let msg = '流式连接失败 (' + res.status + ')';
      try {
        const data = await res.json();
        if (data && data.msg) msg = data.msg;
      } catch (e) { /* 非 JSON 响应体，使用默认文案 */ }
      throw new Error(msg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    handlers = handlers || {};

    try {
      while (true) {
        const r = await reader.read();
        resetIdle();
        if (r.done) break;
        buf += decoder.decode(r.value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let evt = 'message', data = '';
          chunk.split('\n').forEach(line => {
            if (line.indexOf('event:') === 0) evt = line.slice(6).trim();
            else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
          });
          if (data) {
            let payload = data;
            try { payload = JSON.parse(data); } catch (e) { /* 纯文本 */ }
            const fn = handlers[evt];
            if (fn) fn(payload, evt);
          }
        }
      }
    } catch (e) {
      if (e && e.name === 'AbortError') { throw new Error('回复中断（连接超时无响应），请重试'); }
      throw e;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
    if (handlers.end) handlers.end();
  }

  return { get: get, post: post, put: put, del: del, upload: upload, sse: sse, token: token };
})();
