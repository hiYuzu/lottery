# 多人同步抽奖系统优化 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完整实现抽奖系统的安全性增强、代码重构、以及全部新功能（三阶段交付）。

**Architecture:** 单文件 Node.js 后端（Express + ws），前端使用 ES modules 拆分公共逻辑。鉴权采用 HMAC-SHA256 无状态 token。新增 REST API 辅助管理操作。大屏展示为独立页面。

**Tech Stack:** Node.js, Express, ws, xlsx, qrcode, 原生 ES modules, Canvas API

**Design Spec:** `docs/superpowers/specs/2026-05-16-lottery-optimization-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `server.js` | Modify | 新增鉴权、undo、名单 CRUD、导出、上传、二维码、多会话等 API |
| `public/common.js` | Create | ES module 公共工具：escapeHtml、showToast、createWS、loadNameList、parseNameList、exportToText |
| `public/script.js` | Modify | 改为 ES module，引入 common.js，新增倒计时、快捷键、在线人数、二维码等 |
| `public/admin.html` | Modify | 去掉内联 script，引入 admin.js |
| `public/admin.js` | Create | 管理页逻辑，从 admin.html 内联提取，引入 common.js，新增名单管理、登录、音效管理 |
| `public/login.html` | Create | 管理员登录页 |
| `public/display.html` | Create | 大屏展示页 HTML |
| `public/display.js` | Create | 大屏展示页逻辑，引入 common.js |
| `public/style.css` | Modify | 新增大屏、登录、倒计时、响应式等样式 |
| `public/uploads/` | Create | 奖项图片/音效上传目录 |
| `package.json` | Modify | 新增 xlsx、qrcode 依赖 |

---

## Phase 1: 安全与基础

### Task 1: 安装新依赖 + 创建 uploads 目录

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 安装 xlsx 和 qrcode**

```bash
cd /d E:\Project\TraeDemo\lottery && npm install xlsx qrcode
```

- [ ] **Step 2: 创建 uploads 目录**

```bash
mkdir public\uploads
echo. > public\uploads\.gitkeep
```

- [ ] **Step 3: 验证依赖安装成功**

```bash
node -e "require('xlsx'); require('qrcode'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json public/uploads/.gitkeep
git commit -m "chore: add xlsx and qrcode dependencies, create uploads dir"
```

---

### Task 2: 服务端 XSS 防护 + HMAC 鉴权工具函数

**Files:**
- Modify: `server.js` (在工具函数区域新增)

- [ ] **Step 1: 在 server.js 顶部 `const path = require('path');` 后添加 crypto 引入和鉴权配置**

在 `const path = require('path');` 这行之后添加：

```javascript
const crypto = require('crypto');
```

- [ ] **Step 2: 在配置区域（PORT 等常量之后）添加鉴权常量和 stripHtml 函数**

在 `const LIST_FILE = ...` 行之后添加：

```javascript
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const HMAC_SECRET_FILE = path.join(__dirname, '.secret');
const TOKEN_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

if (ADMIN_PASSWORD === 'admin123') {
  console.log('[警告] 使用默认管理员密码，请设置环境变量 ADMIN_PASSWORD');
}

let hmacSecret = null;

function getHmacSecret() {
  if (hmacSecret) return hmacSecret;
  try {
    hmacSecret = fs.readFileSync(HMAC_SECRET_FILE, 'utf-8').trim();
  } catch {
    hmacSecret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(HMAC_SECRET_FILE, hmacSecret, 'utf-8');
  }
  return hmacSecret;
}

function generateToken() {
  const payload = { ts: Date.now(), rand: crypto.randomBytes(8).toString('hex') };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64');
  const sig = crypto.createHmac('sha256', getHmacSecret()).update(data).digest('hex');
  return `${data}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const [data, sig] = token.split('.');
  if (!data || !sig) return false;
  const expected = crypto.createHmac('sha256', getHmacSecret()).update(data).digest('hex');
  if (sig !== expected) return false;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64').toString('utf-8'));
    return Date.now() - payload.ts < TOKEN_MAX_AGE;
  } catch {
    return false;
  }
}

function stripHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/<[^>]*>/g, '');
}

function sanitizeMessage(msg) {
  if (msg.prizeName && typeof msg.prizeName === 'string') msg.prizeName = stripHtml(msg.prizeName);
  if (msg.password && typeof msg.password === 'string') msg.password = stripHtml(msg.password);
  if (Array.isArray(msg.prizes)) {
    msg.prizes.forEach(p => {
      if (p.name && typeof p.name === 'string') p.name = stripHtml(p.name);
    });
  }
  return msg;
}
```

- [ ] **Step 3: 验证语法正确**

```bash
node -e "require('./server.js')" 2>&1 | findstr /C:"抽奖系统已启动"
```

如果报错，检查语法。如果成功会看到启动信息（Ctrl+C 停止）。

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(server): add HMAC auth utilities, stripHtml, sanitizeMessage"
```

---

### Task 3: 服务端 WebSocket 鉴权 + REST 登录接口

**Files:**
- Modify: `server.js` (WebSocket connection handler + REST routes)

- [ ] **Step 1: 添加 REST 登录和验证接口**

在 `app.get('/api/names', ...)` 之前添加：

```javascript
// ==================== 鉴权 REST API ====================

app.post('/api/login', express.json(), (req, res) => {
  const password = req.body && req.body.password;
  if (!password || stripHtml(password) !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: '密码错误' });
  }
  const token = generateToken();
  res.json({ success: true, token });
});

app.get('/api/verify', (req, res) => {
  const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
  res.json({ valid: verifyToken(token) });
});

function isAdmin(ws) {
  return ws._isAdmin === true;
}
```

- [ ] **Step 2: 修改 WebSocket connection handler，添加 token 验证**

替换 `wss.on('connection', ws => {` 之前，添加 `verifyClient` 或在 connection 内处理。

在 `wss.on('connection', ws => {` 这行之后，在 `console.log('[WS] 新客户端连接...` 之后添加：

```javascript
  // 解析 URL 中的 token 参数
  const url = new URL(ws.upgradeReq?.url || '/', `http://${ws.upgradeReq?.headers?.host || 'localhost'}`);
  const token = url.searchParams.get('token');
  ws._isAdmin = verifyToken(token);
```

注意：`ws` 库的 `upgradeReq` 需要在创建 WSS 时保留。修改 WSS 创建：

将 `const wss = new WebSocketServer({ server, maxPayload: 10 * 1024 });` 改为：

```javascript
const wss = new WebSocketServer({ server, maxPayload: 10 * 1024, verifyClient: (info, cb) => {
  // 不拒绝连接，只记录 token 供后续使用
  cb(true);
}});
```

- [ ] **Step 3: 在消息处理中添加 login 类型和权限检查**

在 `switch (msg.type)` 中添加 `login` case（在 `case 'draw':` 之前）：

```javascript
        case 'login': {
          const pwd = msg.password;
          if (!pwd || stripHtml(pwd) !== ADMIN_PASSWORD) {
            ws.send(JSON.stringify({ type: 'loginResult', success: false }));
            return;
          }
          ws._isAdmin = true;
          const token = generateToken();
          ws.send(JSON.stringify({ type: 'loginResult', success: true, token }));
          break;
        }
```

在 `case 'updatePrizes':`、`case 'reset':` 处理前添加权限检查：

```javascript
        case 'updatePrizes': {
          if (!isAdmin(ws)) {
            ws.send(JSON.stringify({ type: 'error', message: '需要管理员权限' }));
            break;
          }
          await withLock(() => handleUpdatePrizes(ws, msg));
          break;
        }
        case 'reset': {
          if (!isAdmin(ws)) {
            ws.send(JSON.stringify({ type: 'error', message: '需要管理员权限' }));
            break;
          }
          await withLock(() => handleReset(ws));
          break;
        }
```

- [ ] **Step 4: 在消息入口调用 sanitizeMessage**

将 `ws.on('message', async raw => {` 回调中 `msg = JSON.parse(raw);` 之后添加：

```javascript
      msg = sanitizeMessage(msg);
```

- [ ] **Step 5: 验证服务器启动并测试登录**

```bash
node -e "
  const http = require('http');
  const data = JSON.stringify({password: 'admin123'});
  const req = http.request({hostname:'localhost',port:3000,path:'/api/login',method:'POST',headers:{'Content-Type':'application/json','Content-Length':data.length}}, res => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => console.log(body));
  });
  req.write(data);
  req.end();
"
```

先启动服务器 `node server.js`，再运行测试脚本。Expected: `{"success":true,"token":"..."}`

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat(server): add admin auth - login API, WebSocket token verification, permission checks"
```

---

### Task 4: 创建登录页 login.html

**Files:**
- Create: `public/login.html`

- [ ] **Step 1: 创建登录页面**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>管理员登录</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body class="page-scrollable">
  <div id="bg-layer"></div>
  <main class="login-container">
    <div class="login-card panel">
      <h1>🔐 管理员登录</h1>
      <form id="login-form">
        <input type="password" id="input-password" placeholder="请输入管理员密码" autofocus required />
        <button type="submit" class="btn btn-primary btn-login">登录</button>
      </form>
      <div id="login-error" class="login-error hidden"></div>
      <a href="/" class="login-back">返回抽奖页</a>
    </div>
  </main>
  <script>
  (function() {
    'use strict';
    const form = document.getElementById('login-form');
    const input = document.getElementById('input-password');
    const errorEl = document.getElementById('login-error');

    form.addEventListener('submit', async e => {
      e.preventDefault();
      errorEl.classList.add('hidden');
      const password = input.value;
      if (!password) return;
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        });
        const data = await res.json();
        if (data.success) {
          sessionStorage.setItem('adminToken', data.token);
          location.href = '/admin.html';
        } else {
          errorEl.textContent = '密码错误';
          errorEl.classList.remove('hidden');
        }
      } catch {
        errorEl.textContent = '网络错误';
        errorEl.classList.remove('hidden');
      }
    });
  })();
  </script>
</body>
</html>
```

- [ ] **Step 2: 在 style.css 末尾添加登录页样式**

在 `@media (prefers-reduced-motion: reduce)` 块之后添加：

```css
/* ==================== 登录页 ==================== */
.login-container {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 24px;
}
.login-card {
  width: 100%;
  max-width: 380px;
  text-align: center;
}
.login-card h1 {
  font-size: 24px;
  margin-bottom: 24px;
}
.login-card input {
  width: 100%;
  padding: 12px 16px;
  border-radius: 8px;
  border: 1px solid var(--color-card-border);
  background: rgba(255, 255, 255, 0.1);
  color: var(--color-text);
  font-size: 16px;
  margin-bottom: 16px;
}
.btn-login {
  width: 100%;
  padding: 12px;
  font-size: 16px;
}
.login-error {
  color: #ff6b6b;
  font-size: 14px;
  margin-top: 12px;
}
.login-back {
  display: inline-block;
  margin-top: 16px;
  color: var(--color-text-muted);
  font-size: 14px;
}
```

- [ ] **Step 3: 验证登录页可访问**

启动服务器，浏览器访问 `http://localhost:3000/login.html`，应看到登录表单。

- [ ] **Step 4: Commit**

```bash
git add public/login.html public/style.css
git commit -m "feat: add admin login page"
```

---

### Task 5: 创建公共模块 common.js

**Files:**
- Create: `public/common.js`

- [ ] **Step 1: 创建 common.js**

```javascript
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
      // 发送排队消息
      while (pendingMessages.length > 0) {
        const msg = pendingMessages.shift();
        ws.send(JSON.stringify(msg));
      }
    };

    ws.onmessage = e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      // 调用通用 onMessage
      if (onMessage) onMessage(msg);

      // 调用类型特定 handler
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
  const hasDrawn = state.prizes.some(p => p.drawn.length > 0);
  const history = state.history || [];
  if (!hasDrawn && history.length === 0) return false;

  const lines = ['抽奖结果', ''];
  state.prizes.filter(p => p.drawn.length > 0).forEach(p => {
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
```

- [ ] **Step 2: 验证模块可导入（无语法错误）**

```bash
node -e "import('./public/common.js').then(() => console.log('OK')).catch(e => console.error(e.message))"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add public/common.js
git commit -m "feat: create common.js ES module with shared utilities"
```

---

### Task 6: 重构 script.js 使用 common.js

**Files:**
- Modify: `public/script.js`
- Modify: `public/index.html`

- [ ] **Step 1: 修改 index.html，将 `<script src="script.js"></script>` 替换为 module 引入**

将 `<script src="script.js"></script>` 替换为：

```html
  <script type="module" src="script.js"></script>
```

- [ ] **Step 2: 重写 script.js，改为 ES module，引入 common.js**

完整替换 `public/script.js`：

```javascript
import { escapeHtml, showToast, parseNameList, loadNameList, createWS, exportToText } from './common.js';

(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const fireworksCanvas = $('fireworks-canvas');
  const ctx = fireworksCanvas.getContext('2d');

  const prizeTabsEl = $('prize-tabs');
  const rollingNameEl = $('rolling-name');
  const drawnListEl = $('drawn-list');
  const resultsSummaryEl = $('results-summary');

  const btnDraw = $('btn-draw');
  const btnMusic = $('btn-music');
  const btnExport = $('btn-export');

  const modalWinner = $('modal-winner');
  const winnerPrizeEl = $('winner-prize');
  const winnerNameEl = $('winner-name');
  const btnCloseWinner = $('btn-close-winner');

  const toastEl = $('toast');
  const bgMusic = $('bg-music');
  const winMusic = $('win-music');

  let state = { prizes: [], history: [] };
  let nameList = [];
  let hqPool = new Set();
  let selectedPrizeIndex = 0;
  let isDrawing = false;
  let isRolling = false;
  let isDrawInitiator = false;
  let rollRAF = null;
  let musicOn = false;

  const wsManager = createWS({
    onOpen: () => showToast(toastEl, '已连接到服务器'),
    onClose: () => { showToast(toastEl, '连接已断开，正在重连...', 'error'); resetDrawUI(); },
    onError: () => showToast(toastEl, '连接异常', 'error'),
  });

  wsManager.on('init', msg => {
    state = msg.state;
    if (!state.history) state.history = [];
    renderAll();
  });

  wsManager.on('drawResult', msg => handleDrawResult(msg));

  wsManager.on('prizesUpdated', msg => {
    state = msg.state;
    if (!state.history) state.history = [];
    renderAll();
  });

  wsManager.on('resetDone', msg => {
    state = msg.state;
    if (!state.history) state.history = [];
    renderAll();
    rollingNameEl.textContent = '准备抽奖';
    rollingNameEl.classList.remove('animating', 'winner-reveal');
  });

  wsManager.on('error', msg => {
    showToast(toastEl, msg.message, 'error');
    resetDrawUI();
  });

  init();

  function init() {
    loadNameList().then(({ names, hqPool: hp }) => {
      nameList = names;
      hqPool = hp;
    }).catch(() => showToast(toastEl, '加载名单失败', 'error'));
    resizeCanvas();
    bindEvents();
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resizeCanvas, 100);
    });
    tryAutoPlayMusic();
  }

  function send(msg) { wsManager.send(msg); }

  // ==================== 音乐 ====================
  function tryAutoPlayMusic() {
    const play = () => {
      bgMusic.volume = 0.3;
      bgMusic.play().then(() => { musicOn = true; btnMusic.textContent = '🔊'; }).catch(() => { musicOn = false; btnMusic.textContent = '🔇'; });
    };
    document.addEventListener('click', function once() {
      if (!musicOn) play();
      document.removeEventListener('click', once);
    });
  }

  function toggleMusic() {
    if (musicOn) {
      bgMusic.pause();
      musicOn = false;
      btnMusic.textContent = '🔇';
    } else {
      bgMusic.volume = 0.3;
      bgMusic.play().catch(() => {});
      musicOn = true;
      btnMusic.textContent = '🔊';
    }
  }

  function playWinSound() {
    winMusic.currentTime = 0;
    winMusic.volume = 0.6;
    winMusic.play().catch(() => {});
  }

  // ==================== 渲染 ====================
  function renderAll() {
    renderPrizeTabs();
    renderDrawnList();
    renderResults();
  }

  function renderPrizeTabs() {
    if (state.prizes.length === 0) {
      prizeTabsEl.innerHTML = '<span style="color:var(--color-text-muted)">暂无奖项，请在管理后台配置</span>';
      return;
    }
    if (selectedPrizeIndex >= state.prizes.length) selectedPrizeIndex = 0;
    prizeTabsEl.innerHTML = state.prizes.map((p, i) => {
      const remaining = p.total - p.drawn.length;
      const isFull = remaining <= 0;
      const cls = ['prize-tab', i === selectedPrizeIndex ? 'active' : '', isFull ? 'full' : '', p.isConsolation ? 'consolation' : ''].filter(Boolean).join(' ');
      const label = p.isConsolation ? `${escapeHtml(p.name)} 🌻` : `${escapeHtml(p.name)} 🏆`;
      return `<button class="${cls}" data-index="${i}">${label} (${remaining}/${p.total})</button>`;
    }).join('');
  }

  function renderDrawnList() {
    const prize = state.prizes[selectedPrizeIndex];
    if (!prize || prize.drawn.length === 0) { drawnListEl.innerHTML = ''; return; }
    drawnListEl.innerHTML = `<h3>${escapeHtml(prize.name)} 已中奖</h3><div class="drawn-names">${prize.drawn.map(n => `<span class="drawn-name-badge">${escapeHtml(n)}</span>`).join('')}</div>`;
  }

  function renderResults() {
    const hasDrawn = state.prizes.some(p => p.drawn.length > 0);
    const history = state.history || [];
    const hasHistory = history.length > 0;
    if (!hasDrawn && !hasHistory) {
      resultsSummaryEl.innerHTML = '<p style="color:var(--color-text-muted);text-align:center">暂无中奖记录</p>';
      return;
    }
    let html = '';
    if (hasDrawn) {
      html += state.prizes.filter(p => p.drawn.length > 0).map(p => `<div class="result-group"><h3>🏆 ${escapeHtml(p.name)}</h3><ul>${p.drawn.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul></div>`).join('');
    }
    if (hasHistory) {
      html += '<div class="result-group"><h3>📋 抽奖记录</h3><ul class="history-list">';
      history.slice().reverse().forEach(h => {
        const time = new Date(h.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        html += `<li class="history-item"><span class="history-time">${time}</span> ${escapeHtml(h.prizeName)} → ${h.winners.map(w => escapeHtml(w)).join('、')}</li>`;
      });
      html += '</ul></div>';
    }
    resultsSummaryEl.innerHTML = html;
  }

  // ==================== 抽奖流程 ====================
  function resetDrawUI() {
    stopRollingAnimation();
    isDrawing = false;
    isRolling = false;
    isDrawInitiator = false;
    btnDraw.disabled = false;
    btnDraw.textContent = '🎯 开始抽奖';
  }

  function startDraw() {
    const prize = state.prizes[selectedPrizeIndex];
    if (!prize) { showToast(toastEl, '请先选择奖项', 'error'); return; }
    const remaining = prize.total - prize.drawn.length;
    if (remaining <= 0) { showToast(toastEl, `"${prize.name}" 名额已满`, 'error'); return; }
    if (isRolling) {
      isRolling = false;
      isDrawInitiator = true;
      btnDraw.disabled = true;
      btnDraw.textContent = '抽奖中...';
      send({ type: 'draw', prizeName: prize.name });
      return;
    }
    if (isDrawing) return;
    const allDrawn = new Set();
    state.prizes.forEach(p => p.drawn.forEach(n => allDrawn.add(n)));
    let candidates = nameList.filter(n => !allDrawn.has(n));
    if (!prize.isConsolation) candidates = candidates.filter(n => !hqPool.has(n));
    if (candidates.length === 0) { showToast(toastEl, '没有可供抽奖的候选人', 'error'); return; }
    isDrawing = true;
    isRolling = true;
    btnDraw.textContent = '⏹ 停止抽奖';
    startRollingAnimation(candidates);
  }

  function startRollingAnimation(candidates) {
    rollingNameEl.classList.add('animating');
    rollingNameEl.classList.remove('winner-reveal');
    let lastUpdate = 0;
    function tick(timestamp) {
      if (timestamp - lastUpdate >= 80) {
        const idx = Math.floor(Math.random() * candidates.length);
        rollingNameEl.textContent = candidates[idx];
        lastUpdate = timestamp;
      }
      if (isRolling) rollRAF = requestAnimationFrame(tick);
    }
    rollRAF = requestAnimationFrame(tick);
  }

  function stopRollingAnimation() {
    if (rollRAF) { cancelAnimationFrame(rollRAF); rollRAF = null; }
    rollingNameEl.classList.remove('animating');
  }

  function handleDrawResult(msg) {
    const winners = msg.winners;
    state = msg.state;
    if (!state.history) state.history = [];
    renderAll();
    if (isDrawInitiator) {
      stopRollingAnimation();
      playWinSound();
      rollingNameEl.textContent = winners.length === 1 ? winners[0] : winners.join('、');
      rollingNameEl.classList.add('winner-reveal');
      setTimeout(() => { showWinnerModal(msg.prizeName, winners.length === 1 ? winners[0] : winners.join('、')); launchFireworks(); }, 200);
    }
    isDrawing = false;
    isRolling = false;
    isDrawInitiator = false;
    btnDraw.disabled = false;
    btnDraw.textContent = '🎯 开始抽奖';
  }

  function showWinnerModal(prizeName, winnerName) {
    winnerPrizeEl.textContent = `🎊 ${prizeName}`;
    winnerNameEl.textContent = winnerName;
    modalWinner.classList.remove('hidden');
  }

  // ==================== 烟花效果 ====================
  let fireworks = [];
  let particles = [];
  let fireworksRunning = false;

  function resizeCanvas() {
    fireworksCanvas.width = window.innerWidth;
    fireworksCanvas.height = window.innerHeight;
  }

  function launchFireworks() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    fireworks = [];
    particles = [];
    for (let i = 0; i < 5; i++) setTimeout(() => fireworks.push(createFirework()), i * 300);
    if (!fireworksRunning) { fireworksRunning = true; animateFireworks(); }
  }

  function createFirework() {
    return {
      x: Math.random() * fireworksCanvas.width,
      y: fireworksCanvas.height,
      targetY: Math.random() * fireworksCanvas.height * 0.4 + 50,
      speed: 4 + Math.random() * 3,
      exploded: false,
      color: `hsl(${Math.random() * 360}, 80%, 60%)`,
    };
  }

  function animateFireworks() {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
    ctx.fillRect(0, 0, fireworksCanvas.width, fireworksCanvas.height);
    for (let i = fireworks.length - 1; i >= 0; i--) {
      const fw = fireworks[i];
      if (!fw.exploded) {
        fw.y -= fw.speed;
        ctx.beginPath();
        ctx.arc(fw.x, fw.y, 2, 0, Math.PI * 2);
        ctx.fillStyle = fw.color;
        ctx.fill();
        if (fw.y <= fw.targetY) { fw.exploded = true; explode(fw); fireworks.splice(i, 1); }
      }
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx; p.y += p.vy; p.vy += 0.05; p.life -= 0.02;
      if (p.life <= 0) { particles[i] = particles[particles.length - 1]; particles.pop(); continue; }
      ctx.globalAlpha = p.life;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fillStyle = p.color; ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (fireworks.length > 0 || particles.length > 0) requestAnimationFrame(animateFireworks);
    else { ctx.clearRect(0, 0, fireworksCanvas.width, fireworksCanvas.height); fireworksRunning = false; }
  }

  function explode(fw) {
    const count = 60 + Math.floor(Math.random() * 40);
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 / count) * i;
      const speed = 1 + Math.random() * 3;
      particles.push({ x: fw.x, y: fw.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, size: 1 + Math.random() * 2, color: fw.color, life: 1 });
    }
  }

  // ==================== 事件绑定 ====================
  function bindEvents() {
    btnDraw.addEventListener('click', startDraw);
    btnMusic.addEventListener('click', toggleMusic);
    if (btnExport) btnExport.addEventListener('click', () => {
      if (!exportToText(state)) showToast(toastEl, '暂无中奖记录可导出');
      else showToast(toastEl, '结果已导出');
    });

    prizeTabsEl.addEventListener('click', e => {
      const tab = e.target.closest('.prize-tab');
      if (!tab || tab.classList.contains('full')) return;
      if (isDrawing || isRolling) { showToast(toastEl, '抽奖进行中，无法切换奖项', 'error'); return; }
      selectedPrizeIndex = parseInt(tab.dataset.index, 10);
      renderPrizeTabs();
      renderDrawnList();
      rollingNameEl.textContent = '准备抽奖';
      rollingNameEl.classList.remove('animating', 'winner-reveal');
    });

    btnCloseWinner.addEventListener('click', () => modalWinner.classList.add('hidden'));
    modalWinner.addEventListener('click', e => { if (e.target === modalWinner) modalWinner.classList.add('hidden'); });

    window.addEventListener('beforeunload', () => {
      if (rollRAF) cancelAnimationFrame(rollRAF);
      if (fireworksRunning) { fireworksRunning = false; ctx.clearRect(0, 0, fireworksCanvas.width, fireworksCanvas.height); }
    });
  }
})();
```

- [ ] **Step 3: 浏览器测试**

启动服务器，访问 `http://localhost:3000`，验证抽奖页功能正常（连接、抽奖、烟花、导出）。

- [ ] **Step 4: Commit**

```bash
git add public/script.js public/index.html
git commit -m "refactor: convert script.js to ES module, use common.js"
```

---

### Task 7: 提取 admin.js 并使用 common.js

**Files:**
- Create: `public/admin.js`
- Modify: `public/admin.html`

- [ ] **Step 1: 创建 admin.js**

```javascript
import { escapeHtml, showToast, parseNameList, loadNameList, createWS, exportToText } from './common.js';

(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const prizeEditor = $('prize-editor');
  const btnAddPrize = $('btn-add-prize');
  const btnSavePrizes = $('btn-save-prizes');
  const btnReset = $('btn-reset');
  const btnExport = $('btn-export');
  const nameListEl = $('name-list');
  const toastEl = $('toast');

  let state = { prizes: [] };
  let nameList = [];
  let hqPool = new Set();
  let editorData = [];
  let hasUnsavedChanges = false;

  function getToken() { return sessionStorage.getItem('adminToken'); }

  const wsManager = createWS({
    getToken,
    onOpen: () => showToast(toastEl, '已连接到服务器'),
    onClose: () => showToast(toastEl, '连接已断开，正在重连...', 'error'),
    onError: () => showToast(toastEl, '连接异常', 'error'),
  });

  wsManager.on('init', msg => {
    state = msg.state;
    renderPrizeEditor(state.prizes.map(p => ({ ...p, drawn: [...p.drawn] })));
  });

  wsManager.on('prizesUpdated', msg => {
    state = msg.state;
    renderPrizeEditor(state.prizes.map(p => ({ ...p, drawn: [...p.drawn] })));
    showToast(toastEl, '奖项配置已更新');
  });

  wsManager.on('resetDone', msg => {
    state = msg.state;
    renderPrizeEditor(state.prizes.map(p => ({ ...p, drawn: [...p.drawn] })));
    showToast(toastEl, '抽奖已重置');
  });

  wsManager.on('drawResult', msg => {
    state = msg.state;
    renderPrizeEditor(state.prizes.map(p => ({ ...p, drawn: [...p.drawn] })));
  });

  wsManager.on('error', msg => showToast(toastEl, msg.message, 'error'));

  init();

  function init() {
    loadNameList().then(({ names, hqPool: hp }) => {
      nameList = names;
      hqPool = hp;
      renderNameList();
    }).catch(() => showToast(toastEl, '加载名单失败', 'error'));
    bindEvents();
  }

  function send(msg) { wsManager.send(msg); }

  function renderNameList() {
    const allDrawn = new Set();
    state.prizes.forEach(p => p.drawn.forEach(n => allDrawn.add(n)));
    nameListEl.innerHTML = nameList.map(name => {
      const isDrawn = allDrawn.has(name);
      return `<span class="name-tag${isDrawn ? ' drawn' : ''}">${escapeHtml(name)}</span>`;
    }).join('');
  }

  // ==================== 奖项编辑器 ====================
  const dragSupported = 'draggable' in document.createElement('div');
  let dragSrcIndex = null;

  function renderPrizeEditor(data) {
    editorData = data || [];
    prizeEditor.innerHTML = editorData.map((p, i) => `
      <div class="prize-row${dragSupported ? ' draggable' : ''}" data-index="${i}" draggable="true">
        <span class="drag-handle" title="拖动排序">⠿</span>
        <input type="text" value="${escapeHtml(p.name)}" placeholder="奖项名称" data-field="name" />
        <input type="number" value="${p.total}" min="1" placeholder="总人数" data-field="total" />
        <input type="number" value="${p.perDraw || 1}" min="1" placeholder="单次" data-field="perDraw" />
        <label class="consolation-label"><input type="checkbox" ${p.isConsolation ? 'checked' : ''} data-field="isConsolation" />阳光普照</label>
        <span class="prize-drawn-count">${p.drawn.length}人已中奖</span>
        <button class="btn btn-remove" data-remove="${i}">删除</button>
      </div>
    `).join('');
    renderNameList();
    bindDragEvents();
  }

  function syncEditorData() {
    const rows = prizeEditor.querySelectorAll('.prize-row');
    rows.forEach((row, i) => {
      if (!editorData[i]) return;
      const nameInput = row.querySelector('[data-field="name"]');
      const totalInput = row.querySelector('[data-field="total"]');
      const perDrawInput = row.querySelector('[data-field="perDraw"]');
      const consolationInput = row.querySelector('[data-field="isConsolation"]');
      editorData[i].name = nameInput.value;
      editorData[i].total = parseInt(totalInput.value, 10) || 1;
      editorData[i].perDraw = parseInt(perDrawInput.value, 10) || 1;
      editorData[i].isConsolation = consolationInput ? consolationInput.checked : false;
    });
  }

  function bindDragEvents() {
    if (!dragSupported) return;
    prizeEditor.querySelectorAll('.prize-row').forEach(row => {
      row.addEventListener('dragstart', e => { dragSrcIndex = parseInt(row.dataset.index, 10); row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
      row.addEventListener('dragend', () => { row.classList.remove('dragging'); prizeEditor.querySelectorAll('.prize-row').forEach(r => r.classList.remove('drag-over')); });
      row.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; row.classList.add('drag-over'); });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', e => {
        e.preventDefault(); row.classList.remove('drag-over');
        const targetIndex = parseInt(row.dataset.index, 10);
        if (dragSrcIndex === null || dragSrcIndex === targetIndex) return;
        syncEditorData();
        const item = editorData.splice(dragSrcIndex, 1)[0];
        editorData.splice(targetIndex, 0, item);
        renderPrizeEditor(editorData);
      });
    });
  }

  function addPrizeRow() {
    editorData.push({ name: '', total: 1, perDraw: 1, drawn: [], isConsolation: false });
    renderPrizeEditor(editorData);
  }

  function removePrizeRow(index) {
    editorData.splice(index, 1);
    renderPrizeEditor(editorData);
  }

  function savePrizes() {
    const rows = prizeEditor.querySelectorAll('.prize-row');
    const prizes = [];
    let valid = true;
    let errorMsg = '';
    rows.forEach((row, i) => {
      const name = row.querySelector('[data-field="name"]').value.trim();
      const total = parseInt(row.querySelector('[data-field="total"]').value, 10);
      const perDraw = parseInt(row.querySelector('[data-field="perDraw"]').value, 10);
      const consolationInput = row.querySelector('[data-field="isConsolation"]');
      if (!name || isNaN(total) || total < 1 || isNaN(perDraw) || perDraw < 1) {
        valid = false;
        if (!name) row.querySelector('[data-field="name"]').style.borderColor = 'red';
        return;
      }
      row.querySelector('[data-field="name"]').style.borderColor = '';
      row.querySelector('[data-field="total"]').style.borderColor = '';
      row.querySelector('[data-field="perDraw"]').style.borderColor = '';
      const existing = editorData[i] || {};
      const drawn = existing.drawn || [];
      if (drawn.length > total) {
        valid = false; errorMsg = `"${name}" 的总人数不能少于已中奖人数(${drawn.length}人)`;
        row.querySelector('[data-field="total"]').style.borderColor = 'red';
      }
      prizes.push({ name, total, perDraw: perDraw || 1, drawn, isConsolation: consolationInput ? consolationInput.checked : false });
    });
    if (!valid) { showToast(toastEl, errorMsg || '请确保每个奖项都有名称，总人数和单次抽取人数均≥1', 'error'); return; }
    const names = prizes.map(p => p.name);
    const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
    if (duplicates.length > 0) { showToast(toastEl, `奖项名称重复: ${duplicates.join('、')}`, 'error'); return; }
    send({ type: 'updatePrizes', prizes });
    hasUnsavedChanges = false;
  }

  function resetLottery() {
    if (!confirm('确定要重置所有抽奖结果吗？此操作不可撤销。')) return;
    send({ type: 'reset' });
  }

  // ==================== 事件绑定 ====================
  function bindEvents() {
    btnAddPrize.addEventListener('click', addPrizeRow);
    btnSavePrizes.addEventListener('click', savePrizes);
    btnReset.addEventListener('click', resetLottery);
    if (btnExport) btnExport.addEventListener('click', () => {
      if (!exportToText(state)) showToast(toastEl, '暂无中奖记录可导出');
      else showToast(toastEl, '结果已导出');
    });
    prizeEditor.addEventListener('click', e => {
      const btn = e.target.closest('[data-remove]');
      if (btn) removePrizeRow(parseInt(btn.dataset.remove, 10));
    });
    prizeEditor.addEventListener('input', () => { hasUnsavedChanges = true; });
    window.addEventListener('beforeunload', e => {
      if (hasUnsavedChanges) { e.preventDefault(); e.returnValue = ''; }
    });
  }
})();
```

- [ ] **Step 2: 修改 admin.html — 移除内联 script，引入 admin.js**

将 admin.html 中 `<script>` 到 `</script>` 的全部内容替换为：

```html
  <script type="module" src="admin.js"></script>
```

保留 `<script>` 标签本身但改为 module 引入。删除内联 IIFE 代码。

- [ ] **Step 3: 浏览器测试管理页**

访问 `http://localhost:3000/admin.html`，验证奖项编辑、保存、重置功能正常。

- [ ] **Step 4: Commit**

```bash
git add public/admin.html public/admin.js
git commit -m "refactor: extract admin.js, convert to ES module with common.js"
```

---

### Task 8: Phase 1 集成测试

- [ ] **Step 1: 启动服务器，完整测试流程**

```bash
node server.js
```

测试清单：
1. 访问 `http://localhost:3000` — 抽奖页正常加载
2. 连接 WebSocket — 看到"已连接"提示
3. 点击抽奖 — 滚动、停止、出结果、烟花正常
4. 访问 `http://localhost:3000/admin.html` — 管理页正常
5. 修改奖项保存 — 正常（无需管理员权限，因为目前前端还没强制要求）
6. 访问 `http://localhost:3000/login.html` — 登录页正常
7. 输入密码 `admin123` 登录 — 跳转到管理页

- [ ] **Step 2: 确认 `.secret` 文件已生成（不要提交）**

将 `.secret` 加入 `.gitignore`（如果还没有）。

```bash
echo .secret >> .gitignore
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: add .secret to gitignore"
```

---

## Phase 2: 核心功能增强

### Task 9: 服务端 undo 接口

**Files:**
- Modify: `server.js`

- [ ] **Step 1: 在 `handleReset` 函数之后添加 `handleUndo` 函数**

```javascript
/** 处理撤销上一次抽奖 */
async function handleUndo(ws) {
  const state = loadState();
  if (!state.history || state.history.length === 0) {
    ws.send(JSON.stringify({ type: 'error', message: '没有可撤销的抽奖记录' }));
    return;
  }

  const last = state.history[state.history.length - 1];
  const prize = state.prizes.find(p => p.name === last.prizeName);

  if (!prize) {
    ws.send(JSON.stringify({ type: 'error', message: `奖项 "${last.prizeName}" 已不存在，无法撤销` }));
    return;
  }

  // 从 prize.drawn 中移除中奖者
  for (const winner of last.winners) {
    const idx = prize.drawn.indexOf(winner);
    if (idx !== -1) prize.drawn.splice(idx, 1);
  }

  state.history.pop();
  await saveState(state);

  broadcast({ type: 'undoResult', state });
}
```

- [ ] **Step 2: 在 switch 中添加 undo case（在 reset 之后）**

```javascript
        case 'undo': {
          if (!isAdmin(ws)) {
            ws.send(JSON.stringify({ type: 'error', message: '需要管理员权限' }));
            break;
          }
          await withLock(() => handleUndo(ws));
          break;
        }
```

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(server): add undo last draw endpoint"
```

---

### Task 10: 服务端在线人数广播

**Files:**
- Modify: `server.js`

- [ ] **Step 1: 添加在线人数广播辅助函数**

在 `broadcast` 函数之后添加：

```javascript
function broadcastOnlineCount() {
  broadcast({ type: 'onlineCount', count: wss.clients.size });
}
```

- [ ] **Step 2: 在 `ws.on('open')`（实际是 connection callback）末尾和 close handler 中调用**

在 `wss.on('connection', ws => {` 回调中，`ws.send(JSON.stringify({ type: 'init', state: loadState() }));` 之后添加：

```javascript
  broadcastOnlineCount();
```

在 `ws.on('close', ...)` 回调中，`drawCooldowns.delete(ws);` 之后添加：

```javascript
    broadcastOnlineCount();
```

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(server): broadcast online user count"
```

---

### Task 11: 服务端名单 CRUD + Excel 导出 API

**Files:**
- Modify: `server.js`

- [ ] **Step 1: 添加名单更新和 Excel 导出 API**

在 `app.get('/api/names', ...)` 之后添加：

```javascript
app.put('/api/names', express.json(), async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!verifyToken(token)) {
    return res.status(401).json({ error: '需要管理员权限' });
  }
  const list = req.body;
  if (!Array.isArray(list)) {
    return res.status(400).json({ error: '数据格式错误，需要数组' });
  }
  // 校验每个条目
  for (const item of list) {
    if (!item.name || typeof item.name !== 'string') {
      return res.status(400).json({ error: '每个条目必须有 name 字段' });
    }
    item.name = stripHtml(item.name).trim();
    if (item.dept && typeof item.dept === 'string') {
      item.dept = stripHtml(item.dept).trim();
    }
  }
  const data = { name: list };
  await writeJSON(LIST_FILE, data);
  _cachedNameList = null; // 清除缓存
  res.json({ success: true });
});

app.get('/api/export', async (req, res) => {
  const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
  if (!verifyToken(token)) {
    return res.status(401).json({ error: '需要管理员权限' });
  }
  const format = req.query.format || 'txt';
  const state = loadState();

  if (format === 'xlsx') {
    const XLSX = require('xlsx');
    const wb = XLSX.utils.book_new();

    // Sheet 1: 中奖汇总
    const summaryData = state.prizes
      .filter(p => p.drawn.length > 0)
      .flatMap(p => p.drawn.map((name, i) => ({ '奖项': p.name, '中奖者': name, '序号': i + 1 })));
    const ws1 = XLSX.utils.json_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(wb, ws1, '中奖汇总');

    // Sheet 2: 抽奖记录
    const historyData = (state.history || []).map(h => ({
      '时间': new Date(h.time).toLocaleString('zh-CN'),
      '奖项': h.prizeName,
      '中奖者': h.winners.join('、'),
    }));
    const ws2 = XLSX.utils.json_to_sheet(historyData);
    XLSX.utils.book_append_sheet(wb, ws2, '抽奖记录');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=lottery_${Date.now()}.xlsx`);
    res.send(buf);
  } else {
    res.status(400).json({ error: '不支持的格式，请使用 format=xlsx' });
  }
});
```

- [ ] **Step 2: 修改原有 GET /api/names 返回完整数据**

将 `app.get('/api/names', async (_req, res) => {` 中的 `res.json({ names });` 改为返回完整数据：

```javascript
app.get('/api/names', async (_req, res) => {
  const data = await readJSON(LIST_FILE, { name: [] });
  res.json(data);
});
```

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(server): add names CRUD API, Excel export endpoint"
```

---

### Task 12: 前端 — 倒计时动画 + 快捷键 + 在线人数 + undo 按钮

**Files:**
- Modify: `public/script.js`
- Modify: `public/style.css`
- Modify: `public/admin.js`

- [ ] **Step 1: 在 script.js 的状态变量区添加倒计时相关变量**

在 `let musicOn = false;` 之后添加：

```javascript
  let countdownRAF = null;
```

- [ ] **Step 2: 替换 startDraw 函数，加入倒计时逻辑**

将 `function startDraw() {` 整个函数替换为：

```javascript
  function startDraw() {
    const prize = state.prizes[selectedPrizeIndex];
    if (!prize) { showToast(toastEl, '请先选择奖项', 'error'); return; }
    const remaining = prize.total - prize.drawn.length;
    if (remaining <= 0) { showToast(toastEl, `"${prize.name}" 名额已满`, 'error'); return; }

    if (isRolling) {
      // 倒计时中点击停止 -> 直接进入抽奖
      isRolling = false;
      if (countdownRAF) { cancelAnimationFrame(countdownRAF); countdownRAF = null; }
      isDrawInitiator = true;
      btnDraw.disabled = true;
      btnDraw.textContent = '抽奖中...';
      send({ type: 'draw', prizeName: prize.name });
      return;
    }
    if (isDrawing) return;

    const allDrawn = new Set();
    state.prizes.forEach(p => p.drawn.forEach(n => allDrawn.add(n)));
    let candidates = nameList.filter(n => !allDrawn.has(n));
    if (!prize.isConsolation) candidates = candidates.filter(n => !hqPool.has(n));
    if (candidates.length === 0) { showToast(toastEl, '没有可供抽奖的候选人', 'error'); return; }

    isDrawing = true;
    btnDraw.disabled = true;

    // 3-2-1 倒计时
    startCountdown(candidates);
  }

  function startCountdown(candidates) {
    const steps = ['3', '2', '1'];
    let stepIndex = 0;
    rollingNameEl.classList.add('countdown');
    rollingNameEl.classList.remove('animating', 'winner-reveal');

    function tick() {
      if (stepIndex < steps.length) {
        rollingNameEl.textContent = steps[stepIndex];
        rollingNameEl.classList.remove('countdown-pop');
        void rollingNameEl.offsetWidth; // 强制 reflow
        rollingNameEl.classList.add('countdown-pop');
        stepIndex++;
        countdownRAF = setTimeout(tick, 800);
      } else {
        rollingNameEl.classList.remove('countdown', 'countdown-pop');
        // 进入名字滚动
        isRolling = true;
        btnDraw.disabled = false;
        btnDraw.textContent = '⏹ 停止抽奖';
        startRollingAnimation(candidates);
      }
    }
    tick();
  }
```

- [ ] **Step 3: 在 bindEvents 函数中添加快捷键和在线人数处理**

在 `bindEvents` 函数中 `window.addEventListener('beforeunload', ...)` 之前添加：

```javascript
    // 快捷键
    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.code === 'Space') { e.preventDefault(); startDraw(); }
      if (e.code === 'Escape') { modalWinner.classList.add('hidden'); }
    });

    // 在线人数
    wsManager.on('onlineCount', msg => {
      let el = $('online-count');
      if (!el) {
        el = document.createElement('span');
        el.id = 'online-count';
        el.className = 'online-count';
        document.querySelector('.toolbar-actions').prepend(el);
      }
      el.textContent = `在线 ${msg.count} 人`;
    });
```

- [ ] **Step 4: 在 style.css 末尾添加倒计时和在线人数样式**

```css
/* ==================== 倒计时 ==================== */
.rolling-name.countdown {
  font-size: 120px;
  color: var(--color-primary);
  text-shadow: 0 0 40px rgba(231, 76, 60, 0.8);
}

.countdown-pop {
  animation: countdownPop 0.5s ease-out !important;
}

@keyframes countdownPop {
  0% { transform: scale(2); opacity: 0; }
  60% { transform: scale(0.9); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}

/* ==================== 在线人数 ==================== */
.online-count {
  font-size: 13px;
  color: var(--color-text-muted);
  padding: 4px 10px;
  border: 1px solid var(--color-card-border);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.06);
}
```

- [ ] **Step 5: 在 admin.js 中添加 undo 按钮和在线人数**

在 admin.js 的 `init` 函数中 `bindEvents();` 之后添加 WebSocket handler 注册。

在 `wsManager.on('error', ...)` 之后添加：

```javascript
  wsManager.on('undoResult', msg => {
    state = msg.state;
    renderPrizeEditor(state.prizes.map(p => ({ ...p, drawn: [...p.drawn] })));
    showToast(toastEl, '已撤销上一次抽奖');
  });

  wsManager.on('onlineCount', msg => {
    let el = $('online-count');
    if (!el) {
      el = document.createElement('span');
      el.id = 'online-count';
      el.className = 'online-count';
      document.querySelector('.toolbar-actions').prepend(el);
    }
    el.textContent = `在线 ${msg.count} 人`;
  });
```

在 `resetLottery` 函数之后添加：

```javascript
  function undoLastDraw() {
    send({ type: 'undo' });
  }
```

在 `bindEvents` 函数中 `btnReset.addEventListener('click', resetLottery);` 之后添加：

```javascript
    const btnUndo = $('btn-undo');
    if (btnUndo) btnUndo.addEventListener('click', undoLastDraw);
```

- [ ] **Step 6: 在 admin.html 中添加 undo 按钮**

在 `<button id="btn-reset" class="btn btn-danger">🔄 重置所有抽奖结果</button>` 之前添加：

```html
        <button id="btn-undo" class="btn btn-warning">↩️ 撤销上一次抽奖</button>
```

在 style.css 中添加警告按钮样式：

```css
.btn-warning {
  border-color: rgba(241, 196, 15, 0.5);
  color: var(--color-gold);
}
.btn-warning:hover {
  background: rgba(241, 196, 15, 0.2);
}
```

- [ ] **Step 7: 浏览器测试**

1. 抽奖页：点击开始 -> 看到 3-2-1 倒计时 -> 滚动 -> 停止 -> 出结果
2. 空格键：触发倒计时/停止
3. ESC：关闭弹窗
4. 右上角：显示在线人数
5. 管理页：点击撤销按钮 -> 上一次抽奖被撤销

- [ ] **Step 8: Commit**

```bash
git add public/script.js public/admin.js public/admin.html public/style.css
git commit -m "feat: add countdown animation, keyboard shortcuts, online count, undo button"
```

---

### Task 13: 名单管理后台 UI

**Files:**
- Modify: `public/admin.html`
- Modify: `public/admin.js`
- Modify: `public/style.css`

- [ ] **Step 1: 在 admin.html 的参与人员 section 中替换内容**

将 `<div id="name-list" class="name-grid"></div>` 替换为：

```html
      <div class="name-toolbar">
        <input type="text" id="input-add-name" placeholder="姓名" />
        <input type="text" id="input-add-dept" placeholder="地区 (如 BJ)" style="width:80px" />
        <button id="btn-add-name" class="btn btn-sm">添加</button>
        <button id="btn-batch-import" class="btn btn-sm">批量导入</button>
      </div>
      <div id="name-list" class="name-grid"></div>
      <div id="batch-import-panel" class="hidden">
        <textarea id="batch-input" placeholder="每行一个：姓名,地区&#10;例：张三,BJ&#10;李四,SD" rows="5"></textarea>
        <button id="btn-batch-confirm" class="btn btn-primary btn-sm">确认导入</button>
        <button id="btn-batch-cancel" class="btn btn-sm">取消</button>
      </div>
```

- [ ] **Step 2: 在 admin.js 中添加名单管理逻辑**

在 `renderNameList` 函数中修改，让每个名字标签带删除按钮：

```javascript
  function renderNameList() {
    const allDrawn = new Set();
    state.prizes.forEach(p => p.drawn.forEach(n => allDrawn.add(n)));
    nameListEl.innerHTML = nameList.map((name, i) => {
      const isDrawn = allDrawn.has(name);
      const dept = nameDeptMap[name] || '';
      return `<span class="name-tag${isDrawn ? ' drawn' : ''}" data-index="${i}">${escapeHtml(name)}${dept ? ` (${dept})` : ''}<button class="name-remove" data-remove="${i}">×</button></span>`;
    }).join('');
  }
```

在状态变量区添加 `let nameDeptMap = {};`

修改 init 中的 loadNameList：

```javascript
    loadNameList().then(({ names, hqPool: hp }) => {
      nameList = names;
      hqPool = hp;
    }).catch(() => showToast(toastEl, '加载名单失败', 'error'));

    // 加载完整名单数据（含 dept）
    fetch('/api/names').then(r => r.json()).then(data => {
      const list = Array.isArray(data) ? data : (data.name || []);
      nameList = list.map(item => item.name).filter(Boolean);
      nameDeptMap = {};
      list.forEach(item => { nameDeptMap[item.name] = item.dept || ''; });
      renderNameList();
    });
```

在 bindEvents 中添加：

```javascript
    // 名单管理
    $('btn-add-name').addEventListener('click', addNameEntry);
    $('btn-batch-import').addEventListener('click', () => $('batch-import-panel').classList.remove('hidden'));
    $('btn-batch-cancel').addEventListener('click', () => $('batch-import-panel').classList.add('hidden'));
    $('btn-batch-confirm').addEventListener('click', batchImport);
    nameListEl.addEventListener('click', e => {
      const btn = e.target.closest('[data-remove]');
      if (btn) removeNameEntry(parseInt(btn.dataset.remove, 10));
    });
```

在 resetLottery/undoLastDraw 之后添加名单操作函数：

```javascript
  async function saveNameList() {
    const list = nameList.map(name => ({ name, dept: nameDeptMap[name] || '' }));
    const token = getToken();
    const res = await fetch('/api/names', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(list),
    });
    if (!res.ok) { showToast(toastEl, '保存名单失败', 'error'); return false; }
    showToast(toastEl, '名单已保存');
    return true;
  }

  function addNameEntry() {
    const nameInput = $('input-add-name');
    const deptInput = $('input-add-dept');
    const name = nameInput.value.trim();
    if (!name) return;
    nameList.push(name);
    nameDeptMap[name] = deptInput.value.trim();
    nameInput.value = '';
    deptInput.value = '';
    renderNameList();
    saveNameList();
  }

  function removeNameEntry(index) {
    const name = nameList[index];
    nameList.splice(index, 1);
    delete nameDeptMap[name];
    renderNameList();
    saveNameList();
  }

  function batchImport() {
    const text = $('batch-input').value.trim();
    if (!text) return;
    const lines = text.split('\n').filter(l => l.trim());
    for (const line of lines) {
      const parts = line.split(',').map(s => s.trim());
      const name = parts[0];
      if (!name) continue;
      if (nameList.includes(name)) continue;
      nameList.push(name);
      nameDeptMap[name] = parts[1] || '';
    }
    renderNameList();
    saveNameList();
    $('batch-import-panel').classList.add('hidden');
    $('batch-input').value = '';
  }
```

- [ ] **Step 3: 添加名单管理相关 CSS**

```css
/* ==================== 名单管理 ==================== */
.name-toolbar {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.name-toolbar input {
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--color-card-border);
  background: rgba(255, 255, 255, 0.1);
  color: var(--color-text);
  font-size: 14px;
}
.btn-sm {
  padding: 4px 10px;
  font-size: 13px;
}
.name-tag {
  position: relative;
}
.name-remove {
  display: none;
  position: absolute;
  top: -4px;
  right: -4px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #e74c3c;
  color: #fff;
  border: none;
  font-size: 10px;
  cursor: pointer;
  line-height: 16px;
  text-align: center;
  padding: 0;
}
.name-tag:hover .name-remove {
  display: block;
}
#batch-import-panel {
  margin-top: 10px;
}
#batch-import-panel textarea {
  width: 100%;
  padding: 8px;
  border-radius: 6px;
  border: 1px solid var(--color-card-border);
  background: rgba(255, 255, 255, 0.1);
  color: var(--color-text);
  font-size: 13px;
  margin-bottom: 8px;
  resize: vertical;
}
```

- [ ] **Step 4: 浏览器测试名单管理**

1. 管理页显示名单（含地区信息）
2. 添加一个新人 -> 保存成功
3. 删除一个人 -> 保存成功
4. 批量导入 -> 确认导入成功

- [ ] **Step 5: Commit**

```bash
git add public/admin.html public/admin.js public/style.css
git commit -m "feat: add name list management UI with add/delete/batch import"
```

---

### Task 14: 大屏展示页 display.html + display.js

**Files:**
- Create: `public/display.html`
- Create: `public/display.js`
- Modify: `public/style.css`

- [ ] **Step 1: 创建 display.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>抽奖大屏</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body class="display-page">
  <div id="bg-layer"></div>
  <canvas id="fireworks-canvas"></canvas>

  <div class="display-container">
    <div id="display-prize-name" class="display-prize-name"></div>
    <div class="display-stage">
      <div id="rolling-name" class="display-rolling">准备抽奖</div>
    </div>
    <div id="display-drawn" class="display-drawn"></div>
  </div>

  <div id="modal-winner" class="modal hidden">
    <div class="modal-content winner-modal display-winner-modal">
      <div class="winner-announce">
        <div id="winner-prize" class="winner-prize"></div>
        <div id="winner-name" class="winner-name"></div>
      </div>
      <button id="btn-close-winner" class="btn btn-primary">确认</button>
    </div>
  </div>

  <div id="toast" class="toast hidden"></div>

  <audio id="win-music" preload="auto">
    <source src="music/win.mp3" type="audio/mpeg" />
  </audio>

  <script type="module" src="display.js"></script>
</body>
</html>
```

- [ ] **Step 2: 创建 display.js**

```javascript
import { escapeHtml, showToast, createWS } from './common.js';

(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const fireworksCanvas = $('fireworks-canvas');
  const ctx = fireworksCanvas.getContext('2d');
  const prizeNameEl = $('display-prize-name');
  const rollingNameEl = $('display-rolling');
  const drawnEl = $('display-drawn');
  const modalWinner = $('modal-winner');
  const winnerPrizeEl = $('winner-prize');
  const winnerNameEl = $('winner-name');
  const toastEl = $('toast');
  const winMusic = $('win-music');

  let state = { prizes: [], history: [] };

  const wsManager = createWS({
    onOpen: () => showToast(toastEl, '已连接'),
    onClose: () => showToast(toastEl, '连接断开，重连中...', 'error'),
  });

  wsManager.on('init', msg => { state = msg.state; render(); });
  wsManager.on('drawResult', msg => handleDrawResult(msg));
  wsManager.on('prizesUpdated', msg => { state = msg.state; render(); });
  wsManager.on('resetDone', msg => { state = msg.state; render(); });
  wsManager.on('undoResult', msg => { state = msg.state; render(); });

  init();

  function init() {
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    $('btn-close-winner').addEventListener('click', () => modalWinner.classList.add('hidden'));
    modalWinner.addEventListener('click', e => { if (e.target === modalWinner) modalWinner.classList.add('hidden'); });
  }

  function resizeCanvas() {
    fireworksCanvas.width = window.innerWidth;
    fireworksCanvas.height = window.innerHeight;
  }

  function render() {
    // 显示当前可抽奖的奖项
    const available = state.prizes.find(p => p.total - p.drawn.length > 0);
    const prize = available || state.prizes[0];
    if (prize) {
      const remaining = prize.total - prize.drawn.length;
      prizeNameEl.textContent = `${prize.name} (${remaining}/${prize.total})`;
      drawnEl.innerHTML = prize.drawn.map(n => `<span class="display-drawn-badge">${escapeHtml(n)}</span>`).join('');
    }
    if (!available && state.prizes.length > 0) {
      rollingNameEl.textContent = '所有奖项已抽完';
    }
  }

  function handleDrawResult(msg) {
    state = msg.state;
    render();
    const winners = msg.winners;
    playWinSound();
    rollingNameEl.textContent = winners.join('、');
    rollingNameEl.classList.add('winner-reveal');

    setTimeout(() => {
      winnerPrizeEl.textContent = `🎊 ${msg.prizeName}`;
      winnerNameEl.textContent = winners.join('、');
      modalWinner.classList.remove('hidden');
      launchFireworks();
    }, 300);
  }

  function playWinSound() {
    winMusic.currentTime = 0;
    winMusic.volume = 0.6;
    winMusic.play().catch(() => {});
  }

  // ==================== 烟花（复用） ====================
  let fireworks = [];
  let particles = [];
  let fireworksRunning = false;

  function launchFireworks() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    fireworks = [];
    particles = [];
    for (let i = 0; i < 8; i++) setTimeout(() => fireworks.push(createFirework()), i * 200);
    if (!fireworksRunning) { fireworksRunning = true; animateFireworks(); }
  }

  function createFirework() {
    return { x: Math.random() * fireworksCanvas.width, y: fireworksCanvas.height, targetY: Math.random() * fireworksCanvas.height * 0.4 + 50, speed: 5 + Math.random() * 4, exploded: false, color: `hsl(${Math.random() * 360}, 80%, 60%)` };
  }

  function animateFireworks() {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
    ctx.fillRect(0, 0, fireworksCanvas.width, fireworksCanvas.height);
    for (let i = fireworks.length - 1; i >= 0; i--) {
      const fw = fireworks[i];
      if (!fw.exploded) { fw.y -= fw.speed; ctx.beginPath(); ctx.arc(fw.x, fw.y, 3, 0, Math.PI * 2); ctx.fillStyle = fw.color; ctx.fill(); if (fw.y <= fw.targetY) { fw.exploded = true; explode(fw); fireworks.splice(i, 1); } }
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]; p.x += p.vx; p.y += p.vy; p.vy += 0.05; p.life -= 0.02;
      if (p.life <= 0) { particles[i] = particles[particles.length - 1]; particles.pop(); continue; }
      ctx.globalAlpha = p.life; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fillStyle = p.color; ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (fireworks.length > 0 || particles.length > 0) requestAnimationFrame(animateFireworks);
    else { ctx.clearRect(0, 0, fireworksCanvas.width, fireworksCanvas.height); fireworksRunning = false; }
  }

  function explode(fw) {
    const count = 80 + Math.floor(Math.random() * 40);
    for (let i = 0; i < count; i++) { const angle = (Math.PI * 2 / count) * i; const speed = 1.5 + Math.random() * 3.5; particles.push({ x: fw.x, y: fw.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, size: 1.5 + Math.random() * 2.5, color: fw.color, life: 1 }); }
  }
})();
```

- [ ] **Step 3: 添加大屏展示页 CSS**

```css
/* ==================== 大屏展示 ==================== */
.display-page {
  overflow: hidden;
}

.display-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100vh;
  padding: 40px;
  gap: 30px;
}

.display-prize-name {
  font-size: 48px;
  font-weight: 700;
  color: var(--color-gold);
  text-shadow: 0 0 30px rgba(241, 196, 15, 0.6);
}

.display-stage {
  width: 80%;
  height: 300px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
  border-radius: 20px;
  border: 3px dashed var(--color-card-border);
}

.display-rolling {
  font-size: 80px;
  font-weight: 700;
  color: var(--color-gold);
  text-shadow: 0 0 30px rgba(241, 196, 15, 0.5);
  text-align: center;
}

.display-rolling.winner-reveal {
  animation: winnerBounce 0.6s ease-out;
}

.display-drawn {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  justify-content: center;
  max-width: 80%;
}

.display-drawn-badge {
  padding: 8px 20px;
  border-radius: 10px;
  background: linear-gradient(135deg, var(--color-gold), var(--color-gold-dark));
  color: #333;
  font-size: 24px;
  font-weight: 600;
}

.display-winner-modal {
  min-width: 500px;
}

.display-winner-modal .winner-name {
  font-size: 72px;
}
```

- [ ] **Step 4: 在 index.html 工具栏添加大屏模式按钮**

在 `<button id="btn-music"` 之前添加：

```html
      <a href="/display.html" class="btn" title="大屏展示" target="_blank">🖥️ 大屏</a>
```

- [ ] **Step 5: 浏览器测试**

1. 访问 `http://localhost:3000/display.html` — 看到大屏展示页
2. 在另一个标签页打开抽奖页，进行抽奖
3. 大屏页同步显示结果和烟花

- [ ] **Step 6: Commit**

```bash
git add public/display.html public/display.js public/style.css public/index.html
git commit -m "feat: add display mode page for projector/big screen"
```

---

### Task 15: Excel 导出 UI

**Files:**
- Modify: `public/admin.js`
- Modify: `public/script.js`

- [ ] **Step 1: 在 admin.js 中修改导出逻辑**

在 bindEvents 中，将 btnExport 的 click handler 改为：

```javascript
    if (btnExport) btnExport.addEventListener('click', () => {
      // 提供格式选择
      const useExcel = confirm('点击"确定"导出 Excel，点击"取消"导出文本文件');
      if (useExcel) {
        const token = getToken();
        window.open(`/api/export?format=xlsx&token=${encodeURIComponent(token)}`, '_blank');
        showToast(toastEl, 'Excel 文件已下载');
      } else {
        if (!exportToText(state)) showToast(toastEl, '暂无中奖记录可导出');
        else showToast(toastEl, '结果已导出');
      }
    });
```

- [ ] **Step 2: 在 script.js 中同样修改导出逻辑**

在 bindEvents 中，将 btnExport 的 click handler 改为：

```javascript
    if (btnExport) btnExport.addEventListener('click', () => {
      const useExcel = confirm('点击"确定"导出 Excel，点击"取消"导出文本文件');
      if (useExcel) {
        window.open('/api/export?format=xlsx', '_blank');
        showToast(toastEl, 'Excel 文件已下载');
      } else {
        if (!exportToText(state)) showToast(toastEl, '暂无中奖记录可导出');
        else showToast(toastEl, '结果已导出');
      }
    });
```

- [ ] **Step 3: 测试导出**

1. 管理页导出 Excel — 确认下载 .xlsx 文件
2. 管理页导出文本 — 确认下载 .txt 文件

- [ ] **Step 4: Commit**

```bash
git add public/admin.js public/script.js
git commit -m "feat: add Excel export option to admin and draw pages"
```

---

## Phase 3: 体验增强

### Task 16: 烟花动画改进

**Files:**
- Modify: `public/script.js`
- Modify: `public/display.js`

- [ ] **Step 1: 在 script.js 的 animateFireworks 中替换渲染逻辑**

将 `ctx.fillStyle = 'rgba(0, 0, 0, 0.15)'; ctx.fillRect(...)` 行替换为：

```javascript
    ctx.clearRect(0, 0, fireworksCanvas.width, fireworksCanvas.height);
```

- [ ] **Step 2: 同样修改 display.js**

同样替换 display.js 中的 `ctx.fillStyle = 'rgba(0, 0, 0, 0.15)'; ctx.fillRect(...)` 为 `ctx.clearRect(...)`。

- [ ] **Step 3: 测试烟花效果**

抽奖后观察烟花 — 应无残影，粒子淡出干净。

- [ ] **Step 4: Commit**

```bash
git add public/script.js public/display.js
git commit -m "fix: use clearRect for fireworks, eliminate trailing artifacts"
```

---

### Task 17: 移动端响应式优化

**Files:**
- Modify: `public/style.css`

- [ ] **Step 1: 替换现有的 `@media (max-width: 700px)` 块**

替换整个 `@media (max-width: 700px) { ... }` 块为：

```css
@media (max-width: 700px) {
  .container {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr auto;
    height: auto;
    min-height: calc(100vh - 60px);
    overflow-y: auto;
  }
  .panel-draw {
    min-height: 400px;
  }
  .btn-draw-action {
    padding: 12px 32px;
    font-size: 16px;
  }
  .rolling-name {
    font-size: 28px;
  }
  .prize-tabs {
    overflow-x: auto;
    flex-wrap: nowrap;
    justify-content: flex-start;
    padding-bottom: 4px;
  }
  .prize-tab {
    font-size: 13px;
    padding: 6px 14px;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .toolbar .title {
    font-size: 16px;
    letter-spacing: 1px;
  }
  .winner-name {
    font-size: 36px;
  }
  .winner-modal {
    min-width: auto;
    width: 90vw;
  }
  .display-prize-name {
    font-size: 32px;
  }
  .display-rolling {
    font-size: 48px;
  }
  .display-stage {
    height: 200px;
    width: 95%;
  }
}
```

- [ ] **Step 2: 在手机或浏览器模拟器中测试**

确认按钮、名字、选项卡在小屏幕上显示正常。

- [ ] **Step 3: Commit**

```bash
git add public/style.css
git commit -m "fix: improve mobile responsive styles"
```

---

### Task 18: 二维码入口

**Files:**
- Modify: `server.js`
- Modify: `public/script.js`
- Modify: `public/admin.js`

- [ ] **Step 1: 在 server.js 中添加二维码 API 和 IP 检测**

在 REST API 区域添加：

```javascript
// ==================== 二维码 ====================

let detectedIP = null;

function detectLocalIP() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        detectedIP = iface.address;
        return;
      }
    }
  }
  detectedIP = 'localhost';
}
detectLocalIP();

app.get('/api/qrcode', async (_req, res) => {
  const QRCode = require('qrcode');
  const url = `http://${detectedIP}:${PORT}`;
  try {
    const svg = await QRCode.toString(url, { type: 'svg', width: 200 });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
  } catch (err) {
    res.status(500).json({ error: '生成二维码失败' });
  }
});
```

- [ ] **Step 2: 在 script.js 的 bindEvents 中添加二维码弹窗**

在 bindEvents 函数中快捷键注册之前添加：

```javascript
    // 二维码弹窗
    let qrModal = $('qr-modal');
    if (!qrModal) {
      // 动态创建
    }
    const btnQR = $('btn-qr');
    if (btnQR) {
      btnQR.addEventListener('click', () => {
        let modal = document.querySelector('.qr-modal');
        if (!modal) {
          modal = document.createElement('div');
          modal.className = 'modal qr-modal';
          modal.innerHTML = `<div class="modal-content" style="text-align:center;padding:20px;">
            <h3 style="margin-bottom:12px;">扫码参与抽奖</h3>
            <img src="/api/qrcode" alt="QR Code" style="background:#fff;padding:12px;border-radius:8px;" />
            <p style="margin-top:10px;color:var(--color-text-muted);font-size:14px;">扫描二维码打开抽奖页面</p>
            <button class="btn" style="margin-top:12px;" onclick="this.closest('.modal').classList.add('hidden')">关闭</button>
          </div>`;
          modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
          document.body.appendChild(modal);
        } else {
          modal.classList.remove('hidden');
        }
      });
    }
```

- [ ] **Step 3: 在 index.html 工具栏添加二维码按钮**

在 `<button id="btn-export"` 之前添加：

```html
      <button id="btn-qr" class="btn btn-icon" title="扫码入口">📱</button>
```

在 admin.html 工具栏中也添加类似按钮（admin.js 中也添加相同逻辑）。

- [ ] **Step 4: 测试**

点击二维码按钮 -> 弹窗显示 SVG 二维码 -> 手机扫描可访问。

- [ ] **Step 5: Commit**

```bash
git add server.js public/script.js public/index.html
git commit -m "feat: add QR code entry for mobile access"
```

---

### Task 19: 文件上传 API + 奖项图片 + 音效上传

**Files:**
- Modify: `server.js`
- Modify: `public/admin.html`
- Modify: `public/admin.js`
- Modify: `public/style.css`

- [ ] **Step 1: 在 server.js 中添加文件上传 API**

在配置区域添加：

```javascript
const multer = require('multer');

// 延迟初始化 multer（避免影响 Phase 1）
let uploadMiddleware = null;

function getUploadMiddleware() {
  if (uploadMiddleware) return uploadMiddleware;
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const subDir = file.fieldname === 'music' ? 'music' : 'uploads';
      const dir = path.join(__dirname, 'public', subDir);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  });
  uploadMiddleware = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const allowed = {
        image: ['.jpg', '.jpeg', '.png'],
        music: ['.mp3'],
      };
      const ext = path.extname(file.originalname).toLowerCase();
      const allowedExts = allowed[file.fieldname] || allowed.image;
      if (allowedExts.includes(ext)) cb(null, true);
      else cb(new Error(`不支持的文件格式: ${ext}`));
    },
  });
  return uploadMiddleware;
}
```

安装 multer：

```bash
npm install multer
```

在 REST API 区域添加上传路由：

```javascript
app.post('/api/upload', (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!verifyToken(token)) return res.status(401).json({ error: '需要管理员权限' });
  getUploadMiddleware().fields([
    { name: 'image', maxCount: 1 },
    { name: 'music', maxCount: 1 },
  ])(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const files = req.files;
    const result = {};
    if (files.image) result.image = files.image[0].filename;
    if (files.music) result.music = files.music[0].filename;
    res.json({ success: true, ...result });
  });
});
```

- [ ] **Step 2: 在奖项数据结构中支持 image 字段**

服务端 `handleUpdatePrizes` 中的验证无需改动（image 是可选字段），保存时会自然保留。

- [ ] **Step 3: 在 admin.html 的奖项编辑器中添加图片上传 UI**

修改 `renderPrizeEditor` 函数的 HTML 模板，在每个 prize-row 中添加图片上传：

在 `<button class="btn btn-remove"` 之前添加：

```html
          <label class="btn btn-sm upload-label" title="上传奖品图片"><input type="file" accept="image/*" class="hidden" data-field="image" data-index="${i}" />🖼️</label>
          ${p.image ? `<img src="/uploads/${p.image}" class="prize-thumb" />` : ''}
```

- [ ] **Step 4: 在 admin.html 中添加音效管理区块**

在抽奖控制 section 之前添加：

```html
    <!-- 音效管理 -->
    <section class="panel admin-section">
      <h2>音效管理</h2>
      <div class="sound-upload-grid">
        <div>
          <label>背景音乐：</label>
          <input type="file" id="upload-bg-music" accept=".mp3" />
          <button class="btn btn-sm" id="btn-upload-bg">上传</button>
        </div>
        <div>
          <label>中奖音效：</label>
          <input type="file" id="upload-win-music" accept=".mp3" />
          <button class="btn btn-sm" id="btn-upload-win">上传</button>
        </div>
      </div>
    </section>
```

- [ ] **Step 5: 添加相关 CSS**

```css
.upload-label {
  cursor: pointer;
  position: relative;
}
.upload-label input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}
.prize-thumb {
  width: 32px;
  height: 32px;
  object-fit: cover;
  border-radius: 4px;
  flex-shrink: 0;
}
.sound-upload-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sound-upload-grid div {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sound-upload-grid label {
  font-size: 14px;
  min-width: 80px;
}
.sound-upload-grid input[type="file"] {
  font-size: 13px;
  color: var(--color-text-muted);
}
```

- [ ] **Step 6: 在 admin.js 中添加上传逻辑**

在 bindEvents 中添加：

```javascript
    // 图片上传
    prizeEditor.addEventListener('change', async e => {
      const input = e.target;
      if (input.type !== 'file' || !input.dataset.index) return;
      const file = input.files[0];
      if (!file) return;
      const formData = new FormData();
      formData.append('image', file);
      const token = getToken();
      const res = await fetch('/api/upload', { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: formData });
      const data = await res.json();
      if (data.success && data.image) {
        const idx = parseInt(input.dataset.index, 10);
        if (editorData[idx]) { editorData[idx].image = data.image; renderPrizeEditor(editorData); }
      }
    });

    // 音效上传
    $('btn-upload-bg')?.addEventListener('click', async () => {
      const file = $('upload-bg-music')?.files[0];
      if (!file) return;
      const formData = new FormData();
      formData.append('music', file);
      const token = getToken();
      const res = await fetch('/api/upload', { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: formData });
      const data = await res.json();
      showToast(toastEl, data.success ? '背景音乐已更新，刷新页面生效' : '上传失败', data.success ? '' : 'error');
    });

    $('btn-upload-win')?.addEventListener('click', async () => {
      const file = $('upload-win-music')?.files[0];
      if (!file) return;
      const formData = new FormData();
      formData.append('music', file);
      const token = getToken();
      const res = await fetch('/api/upload', { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: formData });
      const data = await res.json();
      showToast(toastEl, data.success ? '中奖音效已更新，刷新页面生效' : '上传失败', data.success ? '' : 'error');
    });
```

- [ ] **Step 7: 在抽奖页和大屏页展示奖品图片**

在 script.js 的 `renderPrizeTabs` 中，选项卡 HTML 里的 label 后面加图片：

```javascript
      const imgHtml = p.image ? `<img src="/uploads/${p.image}" class="prize-tab-thumb" />` : '';
      return `<button class="${cls}" data-index="${i}">${imgHtml}${label} (${remaining}/${p.total})</button>`;
```

CSS：

```css
.prize-tab-thumb {
  width: 20px;
  height: 20px;
  object-fit: cover;
  border-radius: 4px;
  vertical-align: middle;
  margin-right: 4px;
}
```

- [ ] **Step 8: 测试上传**

1. 管理页上传奖品图片 -> 选项卡显示缩略图
2. 管理页上传音效 -> 刷新后音效替换

- [ ] **Step 9: Commit**

```bash
git add server.js package.json package-lock.json public/admin.html public/admin.js public/script.js public/style.css
git commit -m "feat: add file upload for prize images and sound effects"
```

---

### Task 20: 中奖结果分享图

**Files:**
- Modify: `public/script.js`
- Modify: `public/style.css`

- [ ] **Step 1: 在 script.js 的 showWinnerModal 函数中添加生成海报按钮**

修改 showWinnerModal：

```javascript
  function showWinnerModal(prizeName, winnerName) {
    winnerPrizeEl.textContent = `🎊 ${prizeName}`;
    winnerNameEl.textContent = winnerName;
    modalWinner.classList.remove('hidden');
    // 确保海报按钮存在
    let posterBtn = $('btn-poster');
    if (!posterBtn) {
      posterBtn = document.createElement('button');
      posterBtn.id = 'btn-poster';
      posterBtn.className = 'btn';
      posterBtn.textContent = '📸 生成海报';
      posterBtn.style.marginTop = '10px';
      $('btn-close-winner').parentNode.insertBefore(posterBtn, $('btn-close-winner'));
      posterBtn.addEventListener('click', () => generatePoster(winnerPrizeEl.textContent, winnerNameEl.textContent));
    }
  }

  function generatePoster(prizeTitle, winnerName) {
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 800;
    const ctx = canvas.getContext('2d');

    // 背景
    const grad = ctx.createLinearGradient(0, 0, 600, 800);
    grad.addColorStop(0, '#8b0000');
    grad.addColorStop(0.5, '#c62828');
    grad.addColorStop(1, '#7f0000');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 600, 800);

    // 金色边框
    ctx.strokeStyle = '#f1c40f';
    ctx.lineWidth = 4;
    ctx.strokeRect(20, 20, 560, 760);

    // 标题
    ctx.fillStyle = '#f1c40f';
    ctx.font = 'bold 36px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('🎉 恭喜中奖 🎉', 300, 150);

    // 奖项名
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 32px "Microsoft YaHei", sans-serif';
    ctx.fillText(prizeTitle, 300, 280);

    // 中奖者
    ctx.fillStyle = '#f1c40f';
    ctx.font = 'bold 60px "Microsoft YaHei", sans-serif';
    ctx.fillText(winnerName, 300, 420);

    // 时间
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '20px "Microsoft YaHei", sans-serif';
    ctx.fillText(new Date().toLocaleString('zh-CN'), 300, 540);

    // 底部
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '16px "Microsoft YaHei", sans-serif';
    ctx.fillText('多人同步抽奖系统', 300, 720);

    // 下载
    canvas.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `中奖海报_${winnerName}.png`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(toastEl, '海报已生成');
    }, 'image/png');
  }
```

- [ ] **Step 2: 测试**

抽奖中奖 -> 弹窗中点击"生成海报" -> 下载 PNG 图片。

- [ ] **Step 3: Commit**

```bash
git add public/script.js
git commit -m "feat: add winner poster generation from canvas"
```

---

### Task 21: 多轮抽奖会话

**Files:**
- Modify: `server.js`
- Modify: `public/admin.html`
- Modify: `public/admin.js`

- [ ] **Step 1: 在 server.js 中修改 state 结构以支持多会话**

添加会话管理辅助函数（在 loadState/saveState 之后）：

```javascript
// ==================== 多会话支持 ====================

function migrateToSessions(state) {
  // 如果已经是新格式，直接返回
  if (state.sessions) return state;
  // 旧格式迁移
  return {
    currentSession: 'default',
    sessions: {
      default: {
        prizes: state.prizes || [],
        history: state.history || [],
      },
    },
  };
}

// 覆盖 loadState 以支持会话
const _origLoadState = loadState;
function loadStateWithSessions() {
  let state = _origLoadState();
  state = migrateToSessions(state);
  cachedState = state;
  return JSON.parse(JSON.stringify(state));
}

function getCurrentSession() {
  const state = loadStateWithSessions();
  const key = state.currentSession;
  return { state, session: state.sessions[key], key };
}

function getSessionData() {
  const { state, session } = getCurrentSession();
  return {
    prizes: session.prizes,
    history: session.history,
  };
}
```

- [ ] **Step 2: 添加会话管理 API**

```javascript
app.get('/api/sessions', (_req, res) => {
  const state = loadStateWithSessions();
  const sessions = Object.keys(state.sessions).map(key => ({
    key,
    name: key,
    drawCount: (state.sessions[key].history || []).length,
    prizeCount: (state.sessions[key].prizes || []).length,
  }));
  res.json({ current: state.currentSession, sessions });
});

app.post('/api/sessions', express.json(), (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!verifyToken(token)) return res.status(401).json({ error: '需要管理员权限' });
  const name = stripHtml(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '活动名称不能为空' });
  const state = loadStateWithSessions();
  if (state.sessions[name]) return res.status(400).json({ error: '活动已存在' });
  state.sessions[name] = { prizes: [], history: [] };
  state.currentSession = name;
  cachedState = state;
  writeJSON(STATE_FILE, state);
  broadcast({ type: 'sessionChanged', state, sessionName: name });
  res.json({ success: true });
});

app.put('/api/sessions/switch', express.json(), (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!verifyToken(token)) return res.status(401).json({ error: '需要管理员权限' });
  const name = req.body.name;
  const state = loadStateWithSessions();
  if (!state.sessions[name]) return res.status(404).json({ error: '活动不存在' });
  state.currentSession = name;
  cachedState = state;
  writeJSON(STATE_FILE, state);
  broadcast({ type: 'sessionChanged', state, sessionName: name });
  res.json({ success: true });
});
```

- [ ] **Step 3: 修改 handleDraw 等函数使用会话数据**

在 handleDraw、handleReset、handleUndo、handleUpdatePrizes 中，将 `const state = loadState()` 改为从 `getCurrentSession()` 获取数据，操作后更新回 `state.sessions[key]`。

核心模式：每个 handler 开头：

```javascript
  const { state, session, key } = getCurrentSession();
```

结尾保存时：

```javascript
  state.sessions[key] = { prizes: session.prizes, history: session.history };
  await saveState(state);
```

由于这个修改涉及多处，需要仔细逐函数替换。

- [ ] **Step 4: 在 admin.html 中添加活动管理区块**

在管理页最上方（admin-container 内第一个 section 之前）添加：

```html
    <!-- 活动管理 -->
    <section class="panel admin-section">
      <h2>活动管理</h2>
      <div class="session-bar">
        <select id="session-select" class="session-select"></select>
        <button id="btn-switch-session" class="btn btn-sm">切换</button>
        <input type="text" id="input-new-session" placeholder="新活动名称" />
        <button id="btn-create-session" class="btn btn-sm btn-primary">创建</button>
      </div>
    </section>
```

- [ ] **Step 5: 在 admin.js 中添加活动管理逻辑**

```javascript
  // 加载活动列表
  async function loadSessions() {
    const res = await fetch('/api/sessions');
    const data = await res.json();
    const select = $('session-select');
    if (!select) return;
    select.innerHTML = data.sessions.map(s =>
      `<option value="${escapeHtml(s.name)}" ${s.name === data.current ? 'selected' : ''}>${escapeHtml(s.name)} (${s.drawCount}次抽奖)</option>`
    ).join('');
  }
```

在 init 中调用 `loadSessions()`。

在 bindEvents 中添加：

```javascript
    // 活动管理
    $('btn-switch-session')?.addEventListener('click', async () => {
      const name = $('session-select')?.value;
      if (!name) return;
      const token = getToken();
      await fetch('/api/sessions/switch', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ name }) });
      loadSessions();
    });

    $('btn-create-session')?.addEventListener('click', async () => {
      const input = $('input-new-session');
      const name = input?.value.trim();
      if (!name) return;
      const token = getToken();
      const res = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ name }) });
      const data = await res.json();
      if (data.success) { input.value = ''; loadSessions(); showToast(toastEl, '活动已创建并切换'); }
      else showToast(toastEl, data.error, 'error');
    });
```

- [ ] **Step 6: 在所有前端页面处理 sessionChanged 消息**

在 script.js、admin.js、display.js 中添加：

```javascript
  wsManager.on('sessionChanged', msg => {
    state = msg.state;
    renderAll();
    showToast(toastEl, '活动已切换');
  });
```

- [ ] **Step 7: 添加会话管理 CSS**

```css
.session-bar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.session-select {
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--color-card-border);
  background: rgba(255, 255, 255, 0.1);
  color: var(--color-text);
  font-size: 14px;
  min-width: 200px;
}
.session-bar input {
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--color-card-border);
  background: rgba(255, 255, 255, 0.1);
  color: var(--color-text);
  font-size: 14px;
}
```

- [ ] **Step 8: 测试**

1. 创建新活动 -> 自动切换
2. 切换回旧活动 -> 状态恢复
3. 多客户端同步切换

- [ ] **Step 9: Commit**

```bash
git add server.js public/admin.html public/admin.js public/script.js public/style.css
git commit -m "feat: add multi-session support for independent lottery events"
```

---

### Task 22: 最终集成测试

- [ ] **Step 1: 完整功能回归测试**

测试清单：
1. 抽奖页：加载、连接、选择奖项、倒计时、抽奖、烟花、导出
2. 管理页：登录、编辑奖项、名单管理、撤销、重置、Excel 导出
3. 大屏页：同步展示、烟花效果
4. 二维码：生成、扫描
5. 多会话：创建、切换、独立数据
6. 快捷键：空格、ESC
7. 移动端：响应式布局
8. 鉴权：未登录不能管理操作

- [ ] **Step 2: 修复发现的问题**

如有问题，修复并提交。

- [ ] **Step 3: 最终 Commit**

```bash
git add -A
git commit -m "chore: final integration and cleanup"
```
