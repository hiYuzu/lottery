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
  let countdownRAF = null;

  const wsManager = createWS({
    onOpen: () => showToast(toastEl, '已连接到服务器'),
    onClose: () => { showToast(toastEl, '连接已断开，正在重连...', 'error'); resetDrawUI(); },
    onError: () => showToast(toastEl, '连接异常', 'error'),
  });

  wsManager.on('init', msg => { state = msg.state; if (!state.history) state.history = []; renderAll(); });
  wsManager.on('drawResult', msg => handleDrawResult(msg));
  wsManager.on('prizesUpdated', msg => { state = msg.state; if (!state.history) state.history = []; renderAll(); });
  wsManager.on('resetDone', msg => { state = msg.state; if (!state.history) state.history = []; renderAll(); rollingNameEl.textContent = '准备抽奖'; rollingNameEl.classList.remove('animating', 'winner-reveal'); });
  wsManager.on('error', msg => { showToast(toastEl, msg.message, 'error'); resetDrawUI(); });

  init();

  function init() {
    loadNameList().then(({ names, hqPool: hp }) => { nameList = names; hqPool = hp; }).catch(() => showToast(toastEl, '加载名单失败', 'error'));
    resizeCanvas();
    bindEvents();
    let resizeTimer;
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resizeCanvas, 100); });
    tryAutoPlayMusic();
  }

  function send(msg) { wsManager.send(msg); }

  function tryAutoPlayMusic() {
    const play = () => { bgMusic.volume = 0.3; bgMusic.play().then(() => { musicOn = true; btnMusic.textContent = '🔊'; }).catch(() => { musicOn = false; btnMusic.textContent = '🔇'; }); };
    document.addEventListener('click', function once() { if (!musicOn) play(); document.removeEventListener('click', once); });
  }

  function toggleMusic() {
    if (musicOn) { bgMusic.pause(); musicOn = false; btnMusic.textContent = '🔇'; }
    else { bgMusic.volume = 0.3; bgMusic.play().catch(() => {}); musicOn = true; btnMusic.textContent = '🔊'; }
  }

  function playWinSound() { winMusic.currentTime = 0; winMusic.volume = 0.6; winMusic.play().catch(() => {}); }

  function renderAll() { renderPrizeTabs(); renderDrawnList(); renderResults(); }

  function renderPrizeTabs() {
    if (state.prizes.length === 0) { prizeTabsEl.innerHTML = '<span style="color:var(--color-text-muted)">暂无奖项，请在管理后台配置</span>'; return; }
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
    if (!hasDrawn && history.length === 0) { resultsSummaryEl.innerHTML = '<p style="color:var(--color-text-muted);text-align:center">暂无中奖记录</p>'; return; }
    let html = '';
    if (hasDrawn) html += state.prizes.filter(p => p.drawn.length > 0).map(p => `<div class="result-group"><h3>🏆 ${escapeHtml(p.name)}</h3><ul>${p.drawn.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul></div>`).join('');
    if (history.length > 0) {
      html += '<div class="result-group"><h3>📋 抽奖记录</h3><ul class="history-list">';
      history.slice().reverse().forEach(h => { const time = new Date(h.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); html += `<li class="history-item"><span class="history-time">${time}</span> ${escapeHtml(h.prizeName)} → ${h.winners.map(w => escapeHtml(w)).join('、')}</li>`; });
      html += '</ul></div>';
    }
    resultsSummaryEl.innerHTML = html;
  }

  function resetDrawUI() { stopRollingAnimation(); isDrawing = false; isRolling = false; isDrawInitiator = false; btnDraw.disabled = false; btnDraw.textContent = '🎯 开始抽奖'; }

  function startDraw() {
    const prize = state.prizes[selectedPrizeIndex];
    if (!prize) { showToast(toastEl, '请先选择奖项', 'error'); return; }
    const remaining = prize.total - prize.drawn.length;
    if (remaining <= 0) { showToast(toastEl, `"${prize.name}" 名额已满`, 'error'); return; }
    if (isRolling) {
      if (countdownRAF) { clearTimeout(countdownRAF); countdownRAF = null; }
      isRolling = false; isDrawInitiator = true; btnDraw.disabled = true; btnDraw.textContent = '抽奖中...';
      send({ type: 'draw', prizeName: prize.name }); return;
    }
    if (isDrawing) return;
    const allDrawn = new Set();
    state.prizes.forEach(p => p.drawn.forEach(n => allDrawn.add(n)));
    let candidates = nameList.filter(n => !allDrawn.has(n));
    if (!prize.isConsolation) candidates = candidates.filter(n => !hqPool.has(n));
    if (candidates.length === 0) { showToast(toastEl, '没有可供抽奖的候选人', 'error'); return; }
    isDrawing = true; btnDraw.disabled = true;
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
        void rollingNameEl.offsetWidth;
        rollingNameEl.classList.add('countdown-pop');
        stepIndex++;
        countdownRAF = setTimeout(tick, 800);
      } else {
        rollingNameEl.classList.remove('countdown', 'countdown-pop');
        isRolling = true; btnDraw.disabled = false; btnDraw.textContent = '⏹ 停止抽奖';
        startRollingAnimation(candidates);
      }
    }
    tick();
  }

  function startRollingAnimation(candidates) {
    rollingNameEl.classList.add('animating'); rollingNameEl.classList.remove('winner-reveal');
    let lastUpdate = 0;
    function tick(timestamp) { if (timestamp - lastUpdate >= 80) { rollingNameEl.textContent = candidates[Math.floor(Math.random() * candidates.length)]; lastUpdate = timestamp; } if (isRolling) rollRAF = requestAnimationFrame(tick); }
    rollRAF = requestAnimationFrame(tick);
  }

  function stopRollingAnimation() { if (rollRAF) { cancelAnimationFrame(rollRAF); rollRAF = null; } rollingNameEl.classList.remove('animating'); }

  function handleDrawResult(msg) {
    const winners = msg.winners; state = msg.state; if (!state.history) state.history = []; renderAll();
    if (isDrawInitiator) {
      stopRollingAnimation(); playWinSound();
      rollingNameEl.textContent = winners.length === 1 ? winners[0] : winners.join('、');
      rollingNameEl.classList.add('winner-reveal');
      setTimeout(() => { showWinnerModal(msg.prizeName, winners.length === 1 ? winners[0] : winners.join('、')); launchFireworks(); }, 200);
    }
    isDrawing = false; isRolling = false; isDrawInitiator = false; btnDraw.disabled = false; btnDraw.textContent = '🎯 开始抽奖';
  }

  function showWinnerModal(prizeName, winnerName) {
    winnerPrizeEl.textContent = `🎊 ${prizeName}`;
    winnerNameEl.textContent = winnerName;
    modalWinner.classList.remove('hidden');
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
    canvas.width = 600; canvas.height = 800;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 600, 800);
    grad.addColorStop(0, '#8b0000'); grad.addColorStop(0.5, '#c62828'); grad.addColorStop(1, '#7f0000');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, 600, 800);
    ctx.strokeStyle = '#f1c40f'; ctx.lineWidth = 4; ctx.strokeRect(20, 20, 560, 760);
    ctx.fillStyle = '#f1c40f'; ctx.font = 'bold 36px "Microsoft YaHei", sans-serif'; ctx.textAlign = 'center'; ctx.fillText('🎉 恭喜中奖 🎉', 300, 150);
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 32px "Microsoft YaHei", sans-serif'; ctx.fillText(prizeTitle, 300, 280);
    ctx.fillStyle = '#f1c40f'; ctx.font = 'bold 60px "Microsoft YaHei", sans-serif'; ctx.fillText(winnerName, 300, 420);
    ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = '20px "Microsoft YaHei", sans-serif'; ctx.fillText(new Date().toLocaleString('zh-CN'), 300, 540);
    ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.font = '16px "Microsoft YaHei", sans-serif'; ctx.fillText('多人同步抽奖系统', 300, 720);
    canvas.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `中奖海报_${winnerName}.png`; a.click();
      URL.revokeObjectURL(url); showToast(toastEl, '海报已生成');
    }, 'image/png');
  }

  let fireworks = [], particles = [], fireworksRunning = false;
  function resizeCanvas() { fireworksCanvas.width = window.innerWidth; fireworksCanvas.height = window.innerHeight; }
  function launchFireworks() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    fireworks = []; particles = [];
    for (let i = 0; i < 5; i++) setTimeout(() => fireworks.push(createFirework()), i * 300);
    if (!fireworksRunning) { fireworksRunning = true; animateFireworks(); }
  }
  function createFirework() { return { x: Math.random() * fireworksCanvas.width, y: fireworksCanvas.height, targetY: Math.random() * fireworksCanvas.height * 0.4 + 50, speed: 4 + Math.random() * 3, exploded: false, color: `hsl(${Math.random() * 360}, 80%, 60%)` }; }
  function animateFireworks() {
    ctx.clearRect(0, 0, fireworksCanvas.width, fireworksCanvas.height);
    for (let i = fireworks.length - 1; i >= 0; i--) { const fw = fireworks[i]; if (!fw.exploded) { fw.y -= fw.speed; ctx.beginPath(); ctx.arc(fw.x, fw.y, 2, 0, Math.PI * 2); ctx.fillStyle = fw.color; ctx.fill(); if (fw.y <= fw.targetY) { fw.exploded = true; explode(fw); fireworks.splice(i, 1); } } }
    for (let i = particles.length - 1; i >= 0; i--) { const p = particles[i]; p.x += p.vx; p.y += p.vy; p.vy += 0.05; p.life -= 0.02; if (p.life <= 0) { particles[i] = particles[particles.length - 1]; particles.pop(); continue; } ctx.globalAlpha = p.life; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fillStyle = p.color; ctx.fill(); }
    ctx.globalAlpha = 1;
    if (fireworks.length > 0 || particles.length > 0) requestAnimationFrame(animateFireworks); else { ctx.clearRect(0, 0, fireworksCanvas.width, fireworksCanvas.height); fireworksRunning = false; }
  }
  function explode(fw) { const count = 60 + Math.floor(Math.random() * 40); for (let i = 0; i < count; i++) { const angle = (Math.PI * 2 / count) * i; const speed = 1 + Math.random() * 3; particles.push({ x: fw.x, y: fw.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, size: 1 + Math.random() * 2, color: fw.color, life: 1 }); } }

  function bindEvents() {
    btnDraw.addEventListener('click', startDraw);
    btnMusic.addEventListener('click', toggleMusic);
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
    prizeTabsEl.addEventListener('click', e => { const tab = e.target.closest('.prize-tab'); if (!tab || tab.classList.contains('full')) return; if (isDrawing || isRolling) { showToast(toastEl, '抽奖进行中，无法切换奖项', 'error'); return; } selectedPrizeIndex = parseInt(tab.dataset.index, 10); renderPrizeTabs(); renderDrawnList(); rollingNameEl.textContent = '准备抽奖'; rollingNameEl.classList.remove('animating', 'winner-reveal'); });
    btnCloseWinner.addEventListener('click', () => modalWinner.classList.add('hidden'));
    modalWinner.addEventListener('click', e => { if (e.target === modalWinner) modalWinner.classList.add('hidden'); });
    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.code === 'Space') { e.preventDefault(); startDraw(); }
      if (e.code === 'Escape') { modalWinner.classList.add('hidden'); }
    });
    wsManager.on('onlineCount', msg => {
      let el = $('online-count');
      if (!el) { el = document.createElement('span'); el.id = 'online-count'; el.className = 'online-count'; document.querySelector('.toolbar-actions').prepend(el); }
      el.textContent = `在线 ${msg.count} 人`;
    });
    window.addEventListener('beforeunload', () => { if (rollRAF) cancelAnimationFrame(rollRAF); if (fireworksRunning) { fireworksRunning = false; ctx.clearRect(0, 0, fireworksCanvas.width, fireworksCanvas.height); } });
  }
})();
