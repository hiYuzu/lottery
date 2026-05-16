import { escapeHtml, showToast, createWS } from './common.js';

(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const fireworksCanvas = $('fireworks-canvas');
  const ctx = fireworksCanvas.getContext('2d');
  const prizeNameEl = $('display-prize-name');
  const rollingNameEl = $('rolling-name');
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

  function resizeCanvas() { fireworksCanvas.width = window.innerWidth; fireworksCanvas.height = window.innerHeight; }

  function render() {
    const available = state.prizes.find(p => p.total - p.drawn.length > 0);
    const prize = available || state.prizes[0];
    if (prize) {
      const remaining = prize.total - prize.drawn.length;
      prizeNameEl.textContent = `${prize.name} (${remaining}/${prize.total})`;
      drawnEl.innerHTML = prize.drawn.map(n => `<span class="display-drawn-badge">${escapeHtml(n)}</span>`).join('');
    }
    if (!available && state.prizes.length > 0) rollingNameEl.textContent = '所有奖项已抽完';
  }

  function handleDrawResult(msg) {
    state = msg.state; render();
    const winners = msg.winners;
    winMusic.currentTime = 0; winMusic.volume = 0.6; winMusic.play().catch(() => {});
    rollingNameEl.textContent = winners.join('、');
    rollingNameEl.classList.add('winner-reveal');
    setTimeout(() => {
      winnerPrizeEl.textContent = `🎊 ${msg.prizeName}`;
      winnerNameEl.textContent = winners.join('、');
      modalWinner.classList.remove('hidden');
      launchFireworks();
    }, 300);
  }

  let fireworks = [], particles = [], fireworksRunning = false;

  function launchFireworks() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    fireworks = []; particles = [];
    for (let i = 0; i < 8; i++) setTimeout(() => fireworks.push(createFirework()), i * 200);
    if (!fireworksRunning) { fireworksRunning = true; animateFireworks(); }
  }

  function createFirework() {
    return { x: Math.random() * fireworksCanvas.width, y: fireworksCanvas.height, targetY: Math.random() * fireworksCanvas.height * 0.4 + 50, speed: 5 + Math.random() * 4, exploded: false, color: `hsl(${Math.random() * 360}, 80%, 60%)` };
  }

  function animateFireworks() {
    ctx.clearRect(0, 0, fireworksCanvas.width, fireworksCanvas.height);
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
