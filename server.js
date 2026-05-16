/**
 * 多人同步抽奖系统 - 服务端
 *
 * 技术栈：express（静态文件服务） + ws（WebSocket 实时通信）
 * 所有抽奖状态统一由本文件维护，通过 state.json 持久化。
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// ==================== 配置 ====================
const PORT = 3000;
const STATE_FILE = path.join(__dirname, 'state.json');
const LIST_FILE = path.join(__dirname, 'public', 'data', 'list.json');

// ==================== 鉴权常量与工具函数 ====================
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

// ==================== Express 静态服务 ====================
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);

// ==================== 工具函数 ====================

/** 读取 JSON 文件（异步），失败则返回默认值 */
async function readJSON(filePath, fallback) {
  try {
    const raw = await fsp.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** 写入 JSON 文件（异步原子写入：先写临时文件，再重命名替换） */
async function writeJSON(filePath, data) {
  const tmp = filePath + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await fsp.rename(tmp, filePath);
}

/** 同步读取 JSON（仅用于启动时初始化） */
function readJSONSync(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// ==================== 名单管理（异步 + 缓存） ====================

let _cachedNameList = null;
let _nameListCacheTime = 0;
const NAME_LIST_TTL = 3000; // 3秒缓存

/** 读取抽奖名单，带缓存 */
async function loadNameList() {
  const now = Date.now();
  if (_cachedNameList && (now - _nameListCacheTime) < NAME_LIST_TTL) {
    return _cachedNameList;
  }
  const data = await readJSON(LIST_FILE, { name: [] });
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
  _cachedNameList = { names, hqPool };
  _nameListCacheTime = now;
  return _cachedNameList;
}

// ==================== 状态管理（内存缓存 + 异步持久化） ====================

const DEFAULT_STATE = {
  prizes: [
    { name: '三等奖', total: 3, perDraw: 1, drawn: [], isConsolation: false },
    { name: '二等奖', total: 2, perDraw: 1, drawn: [], isConsolation: false },
    { name: '一等奖', total: 1, perDraw: 1, drawn: [], isConsolation: false },
  ],
  history: [],
};

let cachedState = null;

/** 读取/初始化抽奖状态（使用内存缓存） */
function loadState() {
  if (cachedState) return JSON.parse(JSON.stringify(cachedState));
  cachedState = readJSONSync(STATE_FILE, DEFAULT_STATE);
  if (!cachedState.history) cachedState.history = [];
  return JSON.parse(JSON.stringify(cachedState));
}

/** 持久化状态（更新缓存 + 写入前先备份） */
async function saveState(state) {
  cachedState = state;
  if (fs.existsSync(STATE_FILE)) {
    fs.copyFileSync(STATE_FILE, STATE_FILE + '.bak');
  }
  await writeJSON(STATE_FILE, state);
}

// ==================== 全局互斥锁（防止并发状态修改） ====================

let _mutexQueue = Promise.resolve();

/** 将异步操作序列化，确保同一时间只有一个操作修改状态 */
function withLock(fn) {
  let release;
  const prev = _mutexQueue;
  _mutexQueue = new Promise(r => { release = r; });
  return prev.then(() => fn()).finally(() => release());
}

// ==================== 抽奖频率限制 ====================
const drawCooldowns = new Map(); // ws -> 上次抽奖时间戳
const DRAW_COOLDOWN_MS = 2000; // 2秒冷却

function checkDrawRateLimit(ws) {
  const now = Date.now();
  const last = drawCooldowns.get(ws) || 0;
  if (now - last < DRAW_COOLDOWN_MS) return false;
  drawCooldowns.set(ws, now);
  return true;
}

// ==================== WebSocket 服务 ====================
const wss = new WebSocketServer({ server, maxPayload: 10 * 1024 }); // 10KB 上限

/** 广播消息给所有已连接的客户端 */
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(msg);
    }
  });
}

/** 广播在线用户数量给所有客户端 */
function broadcastOnlineCount() {
  broadcast({ type: 'onlineCount', count: wss.clients.size });
}

wss.on('connection', ws => {
  console.log('[WS] 新客户端连接，当前连接数:', wss.clients.size);

  // 解析 URL 中的 token 参数
  try {
    const url = new URL(ws.upgradeReq.url, `http://${ws.upgradeReq.headers.host}`);
    const token = url.searchParams.get('token');
    ws._isAdmin = verifyToken(token);
  } catch {
    ws._isAdmin = false;
  }

  // 连接建立后立即发送当前完整状态
  ws.send(JSON.stringify({ type: 'init', state: loadState() }));

  // 广播在线用户数量
  broadcastOnlineCount();

  ws.on('message', async raw => {
    let msg;
    try {
      msg = JSON.parse(raw);
      msg = sanitizeMessage(msg);
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: '无效的消息格式' }));
      return;
    }

    try {
      switch (msg.type) {
        // -------- 登录 --------
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
        // -------- 抽奖 --------
        case 'draw': {
          await withLock(() => handleDraw(ws, msg));
          break;
        }
        // -------- 更新奖项配置 --------
        case 'updatePrizes': {
          if (!isAdmin(ws)) {
            ws.send(JSON.stringify({ type: 'error', message: '需要管理员权限' }));
            break;
          }
          await withLock(() => handleUpdatePrizes(ws, msg));
          break;
        }
        // -------- 重置抽奖 --------
        case 'reset': {
          if (!isAdmin(ws)) {
            ws.send(JSON.stringify({ type: 'error', message: '需要管理员权限' }));
            break;
          }
          await withLock(() => handleReset(ws));
          break;
        }
        default:
          ws.send(JSON.stringify({ type: 'error', message: `未知消息类型: ${msg.type}` }));
      }
    } catch (err) {
      console.error('[WS] 处理消息异常:', err);
      ws.send(JSON.stringify({ type: 'error', message: '服务器内部错误' }));
    }
  });

  ws.on('close', () => {
    drawCooldowns.delete(ws);
    console.log('[WS] 客户端断开，当前连接数:', wss.clients.size);
    // 广播在线用户数量
    broadcastOnlineCount();
  });

  ws.on('error', err => {
    console.error('[WS] 连接异常:', err.message);
  });
});

// ==================== 消息处理函数 ====================

/** 处理抽奖请求 */
async function handleDraw(ws, msg) {
  const prizeName = msg.prizeName;
  if (!prizeName || typeof prizeName !== 'string') {
    ws.send(JSON.stringify({ type: 'error', message: '缺少奖项名称' }));
    return;
  }

  // 频率限制
  if (!checkDrawRateLimit(ws)) {
    ws.send(JSON.stringify({ type: 'error', message: '操作过于频繁，请稍后' }));
    return;
  }

  const state = loadState();
  const prize = state.prizes.find(p => p.name === prizeName);

  if (!prize) {
    ws.send(JSON.stringify({ type: 'error', message: `奖项 "${prizeName}" 不存在` }));
    return;
  }

  const remaining = prize.total - prize.drawn.length;
  if (remaining <= 0) {
    ws.send(JSON.stringify({ type: 'error', message: `奖项 "${prizeName}" 名额已满` }));
    return;
  }

  // 计算候选人：名单中去除所有已中奖的人
  const allDrawn = new Set();
  state.prizes.forEach(p => p.drawn.forEach(n => allDrawn.add(n)));

  const { names, hqPool } = await loadNameList();
  let candidates = names.filter(n => !allDrawn.has(n));

  if (!prize.isConsolation) {
    candidates = candidates.filter(n => !hqPool.has(n));
  }

  if (candidates.length === 0) {
    ws.send(JSON.stringify({ type: 'error', message: '没有可供抽奖的候选人' }));
    return;
  }

  // 根据 perDraw 决定本次抽取人数
  const perDraw = prize.perDraw || 1;
  const drawCount = Math.min(perDraw, remaining, candidates.length);
  const winners = [];
  const pool = [...candidates];
  for (let i = 0; i < drawCount; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    winners.push(pool[idx]);
    pool.splice(idx, 1);
  }

  prize.drawn.push(...winners);

  // 记录抽奖历史
  if (!state.history) state.history = [];
  state.history.push({
    prizeName,
    winners: [...winners],
    time: new Date().toISOString(),
  });

  await saveState(state);

  // 广播中奖结果和最新状态
  broadcast({
    type: 'drawResult',
    winners,
    prizeName,
    state,
  });
}

/** 处理奖项配置更新 */
async function handleUpdatePrizes(ws, msg) {
  const prizes = msg.prizes;
  if (!Array.isArray(prizes)) {
    ws.send(JSON.stringify({ type: 'error', message: '奖项数据格式错误' }));
    return;
  }

  // 校验每个奖项
  const nameSet = new Set();
  for (const p of prizes) {
    const perDraw = Number(p.perDraw) || 1;
    p.perDraw = perDraw;
    if (!p.name || typeof p.total !== 'number' || p.total < 1 || perDraw < 1) {
      ws.send(JSON.stringify({ type: 'error', message: '每个奖项必须有名称，总人数和单次抽取人数均≥1' }));
      return;
    }
    if (perDraw > p.total) {
      ws.send(JSON.stringify({ type: 'error', message: `"${p.name}" 的单次抽取人数不能超过总人数` }));
      return;
    }
    if (Array.isArray(p.drawn) && p.drawn.length > p.total) {
      ws.send(JSON.stringify({ type: 'error', message: `"${p.name}" 的总人数不能少于已中奖人数(${p.drawn.length}人)` }));
      return;
    }
    const trimmedName = p.name.trim();
    if (nameSet.has(trimmedName)) {
      ws.send(JSON.stringify({ type: 'error', message: `奖项名称重复: "${trimmedName}"` }));
      return;
    }
    nameSet.add(trimmedName);
    if (!Array.isArray(p.drawn)) {
      p.drawn = [];
    }
  }

  const oldState = loadState();
  const state = { prizes, history: oldState.history || [] };
  await saveState(state);

  broadcast({ type: 'prizesUpdated', state });
}

/** 处理重置 */
async function handleReset(ws) {
  const state = loadState();
  state.prizes.forEach(p => (p.drawn = []));
  state.history = [];
  await saveState(state);
  broadcast({ type: 'resetDone', state });
}

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

// ==================== REST API ====================
app.get('/api/names', async (_req, res) => {
  const { names } = await loadNameList();
  res.json({ names });
});

// ==================== 启动服务 ====================
// 恢复：如果上次原子写入中断，.tmp 存在而 state.json 损坏或缺失
if (fs.existsSync(STATE_FILE + '.tmp') && !fs.existsSync(STATE_FILE)) {
  try {
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    console.log('[恢复] 从临时文件恢复了 state.json');
  } catch (_) { /* 忽略，走正常初始化 */ }
}

// 初始化 state.json（仅首次）
if (!fs.existsSync(STATE_FILE)) {
  cachedState = JSON.parse(JSON.stringify(DEFAULT_STATE));
  fs.writeFileSync(STATE_FILE, JSON.stringify(cachedState, null, 2), 'utf-8');
} else {
  cachedState = readJSONSync(STATE_FILE, DEFAULT_STATE);
  if (!cachedState.history) cachedState.history = [];
}

server.listen(PORT, () => {
  console.log(`\n🎉 抽奖系统已启动！`);
  console.log(`   本地访问: http://localhost:${PORT}`);
  console.log(`   局域网访问: http://<本机IP>:${PORT}`);
  console.log(`   按 Ctrl+C 停止服务\n`);
});

// ==================== 优雅关闭 ====================
function gracefulShutdown() {
  console.log('\n正在关闭服务器...');
  wss.clients.forEach(client => client.close());
  server.close(() => {
    console.log('服务器已关闭');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000); // 强制退出兜底
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
