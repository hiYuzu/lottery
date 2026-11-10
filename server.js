const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const STATE_FILE = path.join(DATA_DIR, "state.json");
const PASSWORD = process.env.ADMIN_PASSWORD;
if (!PASSWORD) throw new Error("请设置 ADMIN_PASSWORD");
const secretPath = path.join(DATA_DIR, ".secret");
if (!fs.existsSync(secretPath))
  fs.writeFileSync(secretPath, crypto.randomBytes(32).toString("hex"), {
    mode: 0o600,
  });
const secret = fs.readFileSync(secretPath, "utf8").trim();
const clone = (value) => structuredClone(value);
const id = () => crypto.randomUUID();
const clean = (value) =>
  typeof value === "string" ? value.trim().replace(/<[^>]*>/g, "") : "";
function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
function tokenForLogin() {
  const data = Buffer.from(
    JSON.stringify({ ts: Date.now(), id: id() }),
  ).toString("base64url");
  return (
    data + "." + crypto.createHmac("sha256", secret).update(data).digest("hex")
  );
}
function verifyToken(token) {
  if (typeof token !== "string") return false;
  const [data, signature] = token.split(".");
  if (!data || !/^[a-f0-9]{64}$/.test(signature || "")) return false;
  const expected = crypto.createHmac("sha256", secret).update(data).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(signature, "hex")))
    return false;
  try {
    const age = Date.now() - JSON.parse(Buffer.from(data, "base64url")).ts;
    return age >= 0 && age < 86400000;
  } catch {
    return false;
  }
}
function migrate(raw) {
  requireValue(raw && typeof raw === "object", "状态文件无效");
  const state = raw.sessions
    ? raw
    : { currentSession: "default", sessions: { default: raw } };
  requireValue(
    state.sessions && Object.hasOwn(state.sessions, state.currentSession),
    "活动状态无效",
  );
  let legacy = [];
  const legacyPath = [
    path.join(__dirname, "data/list.json"),
    path.join(__dirname, "public/data/list.json"),
  ].find((p) => fs.existsSync(p));
  if (legacyPath) {
    const list = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
    legacy = Array.isArray(list) ? list : list.name || [];
  }
  state.revision ||= 0;
  for (const [key, session] of Object.entries(state.sessions)) {
    session.history ??= [];
    requireValue(
      Array.isArray(session.prizes) && Array.isArray(session.history),
      "活动记录无效",
    );
    session.name ||= key === "default" ? "抽奖活动" : key;
    session.people ||= clone(legacy);
    session.people.forEach((p) => {
      p.id ||= id();
      p.dept ||= "";
    });
    session.prizes.forEach((p) => {
      p.id ||= id();
      p.drawnIds ||= (p.drawn || []).flatMap((name) =>
        session.people
          .filter((person) => person.name === name)
          .map((person) => person.id),
      );
      p.drawn ||= [];
    });
    session.history.forEach((h) => {
      h.id ||= id();
      h.prizeId ||= session.prizes.find((p) => p.name === h.prizeName)?.id;
      h.winnerIds ||= h.winners.flatMap((name) =>
        session.people.filter((p) => p.name === name).map((p) => p.id),
      );
    });
    session.status ||= "open";
    session.mode ||= "formal";
    session.activeRound ||= null;
  }
  return state;
}
function initialState() {
  const existing = [
    STATE_FILE,
    STATE_FILE + ".tmp",
    STATE_FILE + ".bak",
  ].filter((p) => fs.existsSync(p));
  for (const file of existing) {
    try {
      const state = migrate(JSON.parse(fs.readFileSync(file, "utf8")));
      if (file !== STATE_FILE) {
        if (fs.existsSync(STATE_FILE))
          fs.copyFileSync(STATE_FILE, STATE_FILE + ".corrupt-" + Date.now());
        fs.copyFileSync(file, STATE_FILE);
      }
      return state;
    } catch (error) {
      console.error("状态恢复失败", path.basename(file), error.message);
    }
  }
  requireValue(existing.length === 0, "状态文件无法恢复");
  return migrate({
    prizes: ["三等奖", "二等奖", "一等奖"].map((name, i) => ({
      name,
      total: 3 - i,
      perDraw: 1,
      drawn: [],
      isConsolation: false,
    })),
    history: [],
  });
}
let state = initialState();
// Persist generated IDs once so legacy identities stay stable across restarts.
fs.writeFileSync(STATE_FILE + ".tmp", JSON.stringify(state, null, 2));
fs.renameSync(STATE_FILE + ".tmp", STATE_FILE);
let queue = Promise.resolve();
function withLock(fn) {
  const result = queue.then(fn);
  queue = result.catch(() => {});
  return result;
}
async function save(next) {
  next.revision = state.revision + 1;
  await fsp.copyFile(STATE_FILE, STATE_FILE + ".bak");
  await fsp.writeFile(STATE_FILE + ".tmp", JSON.stringify(next, null, 2));
  await fsp.rename(STATE_FILE + ".tmp", STATE_FILE);
  state = next;
}
function candidates(session, prize) {
  const used = new Set(session.prizes.flatMap((p) => p.drawnIds));
  return session.people.filter(
    (p) => !used.has(p.id) && (prize.isConsolation || p.dept !== "CN"),
  );
}
function snapshot(admin, token) {
  const current = clone(state.sessions[state.currentSession]);
  current.prizes.forEach((p) => {
    p.eligible = candidates(current, p).length;
  });
  if (current.activeRound) {
    current.activeRound.canReveal =
      admin && current.activeRound.owner === token;
    delete current.activeRound.owner;
  }
  if (!admin) {
    delete current.people;
    current.prizes.forEach((p) => delete p.drawnIds);
    current.history.forEach((h) => delete h.winnerIds);
  }
  return {
    revision: state.revision,
    currentSession: state.currentSession,
    session: current,
    sessions: admin
      ? Object.entries(state.sessions).map(([key, s]) => ({
          key,
          name: s.name,
          status: s.status,
          mode: s.mode,
        }))
      : [],
  };
}
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/data", (_req, res) => res.sendStatus(404));
app.use(express.static(path.join(__dirname, "public")));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 });
function send(ws, value) {
  if (ws.readyState === 1) ws.send(JSON.stringify(value));
}
function publish(type = "state", extra = {}) {
  for (const ws of wss.clients)
    send(ws, {
      type,
      state: snapshot(verifyToken(ws.token), ws.token),
      admin: verifyToken(ws.token),
      ...extra,
    });
}
function sameRevision(msg) {
  requireValue(
    msg.sessionId === state.currentSession && msg.revision === state.revision,
    "状态已更新，请重试",
  );
}
async function mutate(ws, msg) {
  requireValue(verifyToken(ws.token), "需要管理员登录");
  const current = state.sessions[state.currentSession];
  if (
    msg.type === "draw" &&
    current.history.some((h) => h.id === msg.roundId)
  ) {
    send(ws, {
      type: "state",
      state: snapshot(true, ws.token),
      admin: true,
      requestId: msg.requestId,
    });
    return;
  }
  sameRevision(msg);
  const next = clone(state);
  const session = next.sessions[next.currentSession];
  requireValue(
    session.status !== "archived" ||
      ["switchSession", "createSession"].includes(msg.type),
    "活动已归档",
  );
  if (!["draw", "cancelRound"].includes(msg.type))
    requireValue(!session.activeRound, "抽奖进行中");
  let event = "state";
  switch (msg.type) {
    case "startRound": {
      const prize = session.prizes.find((p) => p.id === msg.prizeId);
      requireValue(
        prize &&
          prize.drawn.length < prize.total &&
          candidates(session, prize).length,
        "无可用名额",
      );
      session.activeRound = {
        id: id(),
        prizeId: prize.id,
        owner: ws.token,
        startedAt: new Date().toISOString(),
      };
      event = "roundStarted";
      break;
    }
    case "cancelRound":
      requireValue(session.activeRound?.id === msg.roundId, "轮次已变更");
      session.activeRound = null;
      break;
    case "draw": {
      const round = session.activeRound;
      requireValue(
        round && round.id === msg.roundId && round.owner === ws.token,
        "轮次或操作者已变更",
      );
      const prize = session.prizes.find((p) => p.id === round.prizeId);
      const pool = candidates(session, prize);
      const count = Math.min(
        prize.perDraw,
        prize.total - prize.drawn.length,
        pool.length,
      );
      requireValue(count > 0, "无可用名额");
      const winners = [];
      for (let i = 0; i < count; i++)
        winners.push(pool.splice(crypto.randomInt(pool.length), 1)[0]);
      prize.drawn.push(...winners.map((p) => p.name));
      prize.drawnIds.push(...winners.map((p) => p.id));
      session.history.push({
        id: round.id,
        prizeId: prize.id,
        prizeName: prize.name,
        winners: winners.map((p) => p.name),
        winnerIds: winners.map((p) => p.id),
        time: new Date().toISOString(),
      });
      session.activeRound = null;
      event = "drawResult";
      break;
    }
    case "undo": {
      const last = session.history.findLast((h) => !h.voidedAt);
      requireValue(last && last.id === msg.historyId, "记录已变更");
      const prize = session.prizes.find((p) => p.id === last.prizeId);
      requireValue(prize, "奖项不存在");
      const removed = new Set(last.winnerIds);
      prize.drawnIds = prize.drawnIds.filter(
        (personId) => !removed.has(personId),
      );
      for (const name of last.winners) {
        const index = prize.drawn.indexOf(name);
        if (index >= 0) prize.drawn.splice(index, 1);
      }
      last.voidedAt = new Date().toISOString();
      event = "undoResult";
      break;
    }
    case "updatePrizes": {
      requireValue(Array.isArray(msg.prizes), "奖项格式错误");
      const seenNames = new Set(),
        seenIds = new Set();
      const prizes = msg.prizes.map((p) => {
        const name = clean(p.name);
        requireValue(name && !seenNames.has(name), "奖项名称无效或重复");
        requireValue(
          Number.isInteger(p.total) &&
            Number.isInteger(p.perDraw) &&
            p.total >= 1 &&
            p.perDraw >= 1 &&
            p.perDraw <= p.total,
          name + "名额无效",
        );
        seenNames.add(name);
        const old = session.prizes.find((old) => old.id === p.id);
        requireValue(!p.id || old, "奖项已变更");
        const prizeId = old?.id || id();
        requireValue(!seenIds.has(prizeId), "奖项重复");
        seenIds.add(prizeId);
        requireValue(!old || old.drawn.length <= p.total, "总名额少于中奖人数");
        return {
          id: prizeId,
          name,
          total: p.total,
          perDraw: p.perDraw,
          isConsolation: !!p.isConsolation,
          drawn: old?.drawn || [],
          drawnIds: old?.drawnIds || [],
        };
      });
      requireValue(
        session.prizes.every(
          (p) =>
            seenIds.has(p.id) ||
            (!session.history.some((h) => h.prizeId === p.id) &&
              !p.drawn.length),
        ),
        "已开奖记录的奖项不可删除",
      );
      session.prizes = prizes;
      event = "prizesUpdated";
      break;
    }
    case "updateNames": {
      requireValue(Array.isArray(msg.people), "名单格式错误");
      const seen = new Set();
      const people = msg.people.map((p) => {
        const personId = clean(p.id),
          name = clean(p.name),
          dept = clean(p.dept).toUpperCase();
        requireValue(
          personId && name && !seen.has(personId),
          "人员编号或姓名无效",
        );
        seen.add(personId);
        return { id: personId, name, dept };
      });
      for (const p of session.people) {
        if (!session.prizes.some((prize) => prize.drawnIds.includes(p.id)))
          continue;
        requireValue(
          people.some(
            (nextPerson) =>
              nextPerson.id === p.id && nextPerson.name === p.name,
          ),
          "已中奖人员不可删除或改名",
        );
      }
      session.people = people;
      event = "namesUpdated";
      break;
    }
    case "createSession": {
      const name = clean(msg.name);
      requireValue(name, "活动名称不能为空");
      const key = id();
      next.sessions[key] = {
        name,
        mode: msg.mode === "rehearsal" ? "rehearsal" : "formal",
        status: "open",
        prizes: [],
        people: [],
        history: [],
        activeRound: null,
      };
      next.currentSession = key;
      event = "sessionChanged";
      break;
    }
    case "switchSession":
      requireValue(Object.hasOwn(next.sessions, msg.target), "活动不存在");
      next.currentSession = msg.target;
      event = "sessionChanged";
      break;
    case "archiveSession":
      session.status = "archived";
      break;
    case "reset": {
      next.sessions[id()] = {
        ...clone(session),
        name: session.name + " · " + new Date().toISOString(),
        status: "archived",
      };
      session.prizes.forEach((p) => {
        p.drawn = [];
        p.drawnIds = [];
      });
      session.history = [];
      event = "resetDone";
      break;
    }
    default:
      throw new Error("无效操作");
  }
  await save(next);
  publish(event, { requestId: msg.requestId });
}
wss.on("connection", (ws, req) => {
  ws.token = new URL(req.url, "http://localhost").searchParams.get("token");
  send(ws, {
    type: "init",
    state: snapshot(verifyToken(ws.token), ws.token),
    admin: verifyToken(ws.token),
  });
  publish("onlineCount", { count: wss.clients.size });
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
      requireValue(msg && typeof msg === "object", "无效操作");
    } catch {
      send(ws, { type: "error", message: "无效操作" });
      return;
    }
    withLock(() => mutate(ws, msg)).catch((error) =>
      send(ws, {
        type: "error",
        message: error.message,
        requestId: msg.requestId,
        state: snapshot(verifyToken(ws.token), ws.token),
        admin: verifyToken(ws.token),
      }),
    );
  });
  ws.on("close", () => publish("onlineCount", { count: wss.clients.size }));
  ws.on("error", (error) => console.error("WebSocket", error.message));
});
app.post("/api/login", (req, res) => {
  if (req.body?.password !== PASSWORD)
    return res.status(401).json({ success: false, error: "密码错误" });
  res.json({ success: true, token: tokenForLogin() });
});
app.get("/api/verify", (req, res) =>
  res.json({
    valid: verifyToken(
      req.headers.authorization?.replace("Bearer ", "") || req.query.token,
    ),
  }),
);
app.get("/api/names", (req, res) => {
  if (
    !verifyToken(
      req.headers.authorization?.replace("Bearer ", "") || req.query.token,
    )
  )
    return res.sendStatus(401);
  res.json({ name: state.sessions[state.currentSession].people });
});
function apiMutation(type, getData) {
  return (req, res) => {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!verifyToken(token))
      return res.status(401).json({ error: "需要管理员登录" });
    const revision = state.revision,
      sessionId = state.currentSession;
    withLock(async () => {
      await mutate({ token }, { ...getData(req), type, revision, sessionId });
      res.json({ success: true });
    }).catch((error) => res.status(400).json({ error: error.message }));
  };
}
app.put(
  "/api/names",
  apiMutation("updateNames", (req) => ({
    people: Array.isArray(req.body)
      ? req.body.map((p) => ({
          ...p,
          id:
            p.id ||
            state.sessions[state.currentSession].people.find(
              (old) => old.name === p.name,
            )?.id ||
            id(),
        }))
      : req.body,
  })),
);
app.get("/api/sessions", (req, res) => {
  if (
    !verifyToken(
      req.headers.authorization?.replace("Bearer ", "") || req.query.token,
    )
  )
    return res.sendStatus(401);
  res.json({
    current: state.currentSession,
    sessions: snapshot(true).sessions,
  });
});
app.post(
  "/api/sessions",
  apiMutation("createSession", (req) => req.body),
);
app.put(
  "/api/sessions/switch",
  apiMutation("switchSession", (req) => ({ target: req.body.name })),
);
app.get("/api/export", (req, res) => {
  const session = state.sessions[state.currentSession];
  const summary = session.prizes.flatMap((prize) =>
    prize.drawn.map((name) => ({
      活动: session.name,
      奖项: prize.name,
      中奖者: name,
    })),
  );
  const rows = session.history.flatMap((h) =>
    h.winners.map((name) => ({
      活动: session.name,
      模式: session.mode === "rehearsal" ? "彩排" : "正式",
      轮次: h.id,
      奖项: h.prizeName,
      中奖者: name,
      时间: h.time,
      状态: h.voidedAt ? "已撤销" : "有效",
    })),
  );
  const format = req.query.format;
  let body;
  if (format === "xlsx") {
    const XLSX = require("xlsx");
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(summary),
      "中奖汇总",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(rows),
      "抽奖记录",
    );
    body = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    res.type(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  } else if (format === "txt") {
    body =
      "\uFEFF" +
      [
        session.name,
        "中奖汇总",
        ...summary.map((row) => Object.values(row).join("\t")),
        "抽奖记录",
        ...rows.map((row) => Object.values(row).join("\t")),
      ].join("\n");
    res.type("text/plain");
  } else return res.status(400).json({ error: "格式无效" });
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(session.name.replace(/[\\/:*?"<>|]/g, "_") + "_" + new Date().toISOString().slice(0, 10) + "." + format)}`,
  );
  res.send(body);
});
function publicURL() {
  if (process.env.PUBLIC_URL) return new URL("/", process.env.PUBLIC_URL).href;
  const interfaces = Object.entries(require("os").networkInterfaces())
    .filter(
      ([name]) =>
        !/virtual|vethernet|docker|tailscale|loopback|tun|tap/i.test(name),
    )
    .flatMap(([, addresses]) => addresses)
    .filter((address) => address.family === "IPv4" && !address.internal);
  const local = interfaces.find((address) =>
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.address),
  );
  const ip =
    local?.address ||
    interfaces.find((address) => !address.address.startsWith("198.18."))
      ?.address ||
    "localhost";
  return `http://${ip}:${server.address().port}/`;
}
app.get("/api/entry", (_req, res) => res.json({ url: publicURL() }));
app.get("/api/qrcode", async (_req, res) => {
  try {
    res.type("svg").send(
      await require("qrcode").toString(publicURL(), {
        type: "svg",
        width: 240,
      }),
    );
  } catch {
    res.status(500).json({ error: "二维码生成失败" });
  }
});
server.listen(PORT, process.env.HOST || "0.0.0.0", () =>
  console.log(`抽奖系统 http://localhost:${server.address().port}`),
);
function shutdown() {
  wss.clients.forEach((ws) => ws.close());
  server.close(() => queue.finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
