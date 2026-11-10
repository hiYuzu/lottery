import {
  $,
  escapeHtml as esc,
  toast,
  connect,
  dialog,
  bindExports,
  download,
} from "./common.js";
const display = new URLSearchParams(location.search).has("display");
document.body.classList.toggle("display", display);
let state,
  admin = false,
  online = false,
  busy = false,
  selectedId,
  latestId;
let cancelCelebration = () => {};
const socket = connect(
  (msg) => {
    const changed = state?.currentSession !== msg.state.currentSession;
    state = msg.state;
    admin = msg.admin;
    if (changed || ["undoResult", "resetDone"].includes(msg.type))
      cancelCelebration();
    if (changed) selectedId = null;
    if (state.session.activeRound)
      selectedId = state.session.activeRound.prizeId;
    if (msg.type === "drawResult") {
      const last = state.session.history.findLast((h) => !h.voidedAt);
      selectedId = last?.prizeId;
      if (last && latestId !== last.id) {
        latestId = last.id;
        celebrate();
        if (!matchMedia("(prefers-reduced-motion: reduce)").matches)
          $("stage").animate(
            [
              { transform: "scale(.95)", opacity: 0.3 },
              { transform: "scale(1)", opacity: 1 },
            ],
            500,
          );
        if (!$("bg-music").paused)
          $("win-music")
            .play()
            .catch(() => {});
      }
    }
    render();
  },
  (connected) => {
    online = connected;
    $("connection").textContent = connected ? "在线" : "重连中";
    render();
  },
);
function render() {
  if (!state) return;
  const session = state.session;
  const prizes = session.prizes;
  selectedId ||= prizes[0]?.id;
  if (!prizes.some((p) => p.id === selectedId)) selectedId = prizes[0]?.id;
  const prize = prizes.find((p) => p.id === selectedId);
  const round = session.activeRound;
  $("activity-name").textContent = session.name;
  $("mode").textContent =
    session.status === "archived"
      ? "已归档"
      : session.mode === "rehearsal"
        ? "彩排"
        : "正式";
  $("prize-tabs").innerHTML = prizes
    .map(
      (p) =>
        '<button data-prize="' +
        esc(p.id) +
        '" aria-pressed="' +
        (p.id === selectedId) +
        '">' +
        esc(p.name) +
        "</button>",
    )
    .join("");
  $("prize-name").textContent = prize?.name || "暂无奖项";
  $("progress").textContent = prize
    ? "剩余 " +
      (prize.total - prize.drawn.length) +
      " / " +
      prize.total +
      " · 本轮 " +
      Math.min(
        prize.perDraw,
        prize.total - prize.drawn.length,
        prize.eligible,
      ) +
      " · 候选 " +
      prize.eligible
    : "";
  const last = session.history.findLast(
    (h) => !h.voidedAt && h.prizeId === selectedId,
  );
  $("stage").classList.toggle("rolling", !!round);
  $("stage").innerHTML = round
    ? "<span>抽奖中</span>"
    : last
      ? last.winners
          .map((name) => "<strong>" + esc(name) + "</strong>")
          .join("")
      : "<span>准备</span>";
  $("draw").hidden = !admin || display;
  $("draw").disabled =
    !online ||
    busy ||
    !prize ||
    session.status === "archived" ||
    (round && !round.canReveal) ||
    (!round && (!prize.eligible || prize.drawn.length >= prize.total));
  $("draw").textContent = round
    ? "揭晓结果"
    : prize?.drawn.length >= prize?.total
      ? "已抽完"
      : "开始滚动";
  $("cancel-round").hidden = !admin || display || !round;
  $("cancel-round").disabled = !online || busy;
  $("poster").hidden = !last || !!round;
  $("results").innerHTML = prizes
    .map(
      (p) =>
        "<section><h3>" +
        esc(p.name) +
        '</h3><div class="winner-grid">' +
        (p.drawn.map((n) => "<span>" + esc(n) + "</span>").join("") || "—") +
        "</div></section>",
    )
    .join("");
  $("history").innerHTML = session.history
    .slice()
    .reverse()
    .map(
      (h) =>
        '<p class="' +
        (h.voidedAt ? "voided" : "") +
        '">' +
        esc(h.prizeName) +
        " · " +
        h.winners.map(esc).join("、") +
        " <time>" +
        new Date(h.time).toLocaleTimeString() +
        "</time>" +
        (h.voidedAt ? " · 已撤销" : "") +
        "</p>",
    )
    .join("");
}
async function draw() {
  if (
    $("draw").disabled ||
    $("draw").hidden ||
    document.querySelector("dialog[open]")
  )
    return;
  busy = true;
  render();
  try {
    const round = state.session.activeRound;
    await socket.send(
      round ? "draw" : "startRound",
      round ? { roundId: round.id } : { prizeId: selectedId },
    );
  } catch (error) {
    toast(error.message);
  } finally {
    busy = false;
    render();
  }
}
$("draw").onclick = draw;
$("cancel-round").onclick = async () => {
  const roundId = state.session.activeRound?.id;
  if (!(await dialog("取消本轮", "", "确认"))) return;
  try {
    await socket.send("cancelRound", { roundId });
  } catch (error) {
    toast(error.message);
  }
};
$("prize-tabs").onclick = (event) => {
  const button = event.target.closest("[data-prize]");
  if (button && !state.session.activeRound) {
    selectedId = button.dataset.prize;
    render();
  }
};
$("fullscreen").onclick = () =>
  (document.fullscreenElement
    ? document.exitFullscreen()
    : document.documentElement.requestFullscreen()
  ).catch((error) => toast(error.message));
$("qr").onclick = async () => {
  $("qr").disabled = true;
  try {
    const response = await fetch("/api/entry");
    if (!response.ok) throw new Error("二维码加载失败");
    const { url } = await response.json();
    await dialog(
      "二维码",
      '<img class="qr-image" src="/api/qrcode" alt="二维码"><a class="entry-url" href="' +
        esc(url) +
        '">' +
        esc(url) +
        "</a>",
    );
  } catch (error) {
    toast(error.message);
  } finally {
    $("qr").disabled = false;
  }
};
$("music").onclick = async () => {
  const audio = $("bg-music");
  if (!audio.paused) {
    audio.pause();
    $("music").textContent = "音乐";
    return;
  }
  try {
    audio.volume = 0.3;
    await audio.play();
    $("music").textContent = "静音";
  } catch {
    toast("音源不可用");
  }
};
$("poster").onclick = () => {
  const last = state.session.history.findLast(
    (h) => !h.voidedAt && h.prizeId === selectedId,
  );
  if (!last) return;
  const canvas = document.createElement("canvas");
  canvas.width = 900;
  canvas.height = 280 + last.winners.length * 70;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#481b23";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = "center";
  ctx.fillStyle = "#f5d48b";
  ctx.font = "bold 36px sans-serif";
  ctx.fillText(state.session.name, 450, 70, 820);
  ctx.fillText(last.prizeName, 450, 140, 820);
  last.winners.forEach((name, i) => ctx.fillText(name, 450, 230 + i * 70, 820));
  canvas.toBlob((blob) => {
    if (blob) download(blob, "中奖海报.png");
  });
};
document.addEventListener("keydown", (event) => {
  if (
    event.repeat ||
    event.code !== "Space" ||
    document.querySelector("dialog[open]") ||
    event.target.closest(
      "input,textarea,select,button,a,[contenteditable],summary",
    )
  )
    return;
  if (admin && !display) {
    event.preventDefault();
    draw();
  }
});
bindExports();

setInterval(() => {
  if (
    !online ||
    !admin ||
    !state?.session.activeRound ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  )
    return;
  const session = state.session;
  const prize = session.prizes.find(
    (p) => p.id === session.activeRound.prizeId,
  );
  const used = new Set(session.prizes.flatMap((p) => p.drawnIds));
  const pool = session.people.filter(
    (p) => !used.has(p.id) && (prize.isConsolation || p.dept !== "CN"),
  );
  if (pool.length)
    $("stage").textContent = pool[Math.floor(Math.random() * pool.length)].name;
}, 100);

function celebrate() {
  cancelCelebration();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const canvas = document.createElement("canvas");
  canvas.className = "celebration";
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  canvas.setAttribute("aria-hidden", "true");
  document.body.append(canvas);
  const ctx = canvas.getContext("2d");
  const particles = [];
  for (let burst = 0; burst < 5; burst++) {
    const x = canvas.width * (0.15 + Math.random() * 0.7),
      y = canvas.height * (0.15 + Math.random() * 0.4);
    for (let i = 0; i < 40; i++) {
      const angle = Math.random() * Math.PI * 2,
        speed = 1 + Math.random() * 4;
      particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        color: `hsl(${Math.random() * 360},85%,70%)`,
      });
    }
  }
  let frame, start;
  cancelCelebration = () => {
    cancelAnimationFrame(frame);
    canvas.remove();
  };
  function tick(time) {
    start ??= time;
    const age = (time - start) / 1800;
    if (age >= 1) {
      cancelCelebration();
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1 - age;
    particles.forEach((p) => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.035;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
      ctx.fill();
    });
    frame = requestAnimationFrame(tick);
  }
  frame = requestAnimationFrame(tick);
}
