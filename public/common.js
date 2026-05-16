/**
 * 抽奖系统公共模块
 * ES module — 供所有页面共享
 */

export function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function showToast(el, message, type) {
  el.textContent = message;
  el.className = 'toast' + (type === 'error' ? ' error' : '');
  clearTimeout(el._toastTimer);
  el._toastTimer = setTimeout(() => {
    el.classList.add('hidden');
  }, 3000);
}

export function parseNameList(data) {
  let names, hqPool;
  if (Array.isArray(data)) {
    names = data.map(item => item.name).filter(Boolean);
    hqPool = new Set();
  } else {
    const list = data.name || [];
    names = list.map(item => item.name).filter(Boolean);
    hqPool = new Set(
      list.filter(item => item.dept === 'CN').map(item => item.name).filter(Boolean)
    );
  }
  return { names, hqPool };
}

export function loadNameList() {
  return fetch('data/list.json')
    .then(r => r.json())
    .then(data => parseNameList(data));
}

export function createWS({ onMessage, onOpen, onClose, onError, getToken }) {
  let ws = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let pendingMessages = [];
  const MAX_PENDING = 10;
  const handlers = {};

  function getTokenParam() {
    const token = getToken ? getToken() : null;
    return token ? `?token=${encodeURIComponent(token)}` : '';
  }

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}${getTokenParam()}`;
    ws = new WebSocket(url);

    ws.onopen = () => {
      reconnectAttempts = 0;
      clearReconnect();
      if (onOpen) onOpen();
      while (pendingMessages.length > 0) {
        const msg = pendingMessages.shift();
        ws.send(JSON.stringify(msg));
      }
    };

    ws.onmessage = e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (onMessage) onMessage(msg);
      if (handlers[msg.type]) handlers[msg.type](msg);
    };

    ws.onclose = () => {
      if (onClose) onClose();
      scheduleReconnect();
    };

    ws.onerror = () => {
      if (onError) onError();
    };
  }

  function scheduleReconnect() {
    clearReconnect();
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
    reconnectAttempts++;
    reconnectTimer = setTimeout(connect, delay);
  }

  function clearReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      if (pendingMessages.length >= MAX_PENDING) {
        pendingMessages.shift();
      }
      pendingMessages.push(msg);
    }
  }

  function on(type, handler) {
    handlers[type] = handler;
  }

  function close() {
    clearReconnect();
    if (ws) ws.close();
  }

  function isConnected() {
    return ws && ws.readyState === WebSocket.OPEN;
  }

  connect();

  return { send, on, close, isConnected };
}

export function exportToText(state) {
  // 提取当前会话数据
  let session = state;
  if (state.sessions && state.currentSession && state.sessions[state.currentSession]) {
    session = state.sessions[state.currentSession];
  }
  const prizes = session.prizes || [];
  const history = session.history || [];
  const hasDrawn = prizes.some(p => p.drawn.length > 0);
  if (!hasDrawn && history.length === 0) return false;

  const lines = ['抽奖结果', ''];
  prizes.filter(p => p.drawn.length > 0).forEach(p => {
    lines.push(`${p.name}: ${p.drawn.join('、')}`);
  });
  if (history.length > 0) {
    lines.push('', '--- 抽奖记录 ---');
    history.slice().reverse().forEach(h => {
      const time = new Date(h.time).toLocaleString('zh-CN');
      lines.push(`${time}  ${h.prizeName}  ${h.winners.join('、')}`);
    });
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `抽奖结果_${new Date().toLocaleDateString('zh-CN').replace(/\//g, '-')}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}
