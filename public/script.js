/**
 * 多人同步抽奖系统 - 抽奖页面逻辑
 *
 * 负责：WebSocket 通信、抽奖 UI 渲染、动画控制、背景音乐
 */

(function () {
  'use strict';

  // ==================== DOM 引用 ====================
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

  // ==================== 状态 ====================
  let state = { prizes: [], history: [] };
  let nameList = [];
  let hqPool = new Set();
  let selectedPrizeIndex = 0;
  let isDrawing = false;
  let isRolling = false;
  let isDrawInitiator = false;
  let rollRAF = null;
  let musicOn = false;
  let ws = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;

  // ==================== 初始化 ====================
  init();

  function init() {
    loadNameList();
    connectWebSocket();
    resizeCanvas();
    bindEvents();
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resizeCanvas, 100);
    });
    tryAutoPlayMusic();
  }

  // ==================== WebSocket ====================
  function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}`;
    ws = new WebSocket(url);

    ws.onopen = () => {
      reconnectAttempts = 0;
      showToast('已连接到服务器');
      clearReconnect();
    };

    ws.onmessage = e => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      handleMessage(msg);
    };

    ws.onclose = () => {
      showToast('连接已断开，正在重连...', 'error');
      resetDrawUI();
      scheduleReconnect();
    };

    ws.onerror = () => {
      showToast('连接异常', 'error');
    };
  }

  function scheduleReconnect() {
    clearReconnect();
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => {
      connectWebSocket();
    }, delay);
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
      showToast('未连接到服务器，请稍后重试', 'error');
    }
  }

  // ==================== 消息处理 ====================
  function handleMessage(msg) {
    switch (msg.type) {
      case 'init':
        state = msg.state;
        if (!state.history) state.history = [];
        renderAll();
        break;
      case 'drawResult':
        handleDrawResult(msg);
        break;
      case 'prizesUpdated':
        state = msg.state;
        if (!state.history) state.history = [];
        renderAll();
        break;
      case 'resetDone':
        state = msg.state;
        if (!state.history) state.history = [];
        renderAll();
        rollingNameEl.textContent = '准备抽奖';
        rollingNameEl.classList.remove('animating', 'winner-reveal');
        break;
      case 'error':
        showToast(msg.message, 'error');
        resetDrawUI();
        break;
    }
  }

  // ==================== 加载名单 ====================
  function loadNameList() {
    fetch('data/list.json')
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) {
          nameList = data.map(item => item.name).filter(Boolean);
          hqPool = new Set();
        } else {
          const list = data.name || [];
          nameList = list.map(item => item.name).filter(Boolean);
          hqPool = new Set(
            list.filter(item => item.dept === 'CN').map(item => item.name).filter(Boolean)
          );
        }
      })
      .catch(() => {
        showToast('加载名单失败', 'error');
      });
  }

  // ==================== 音乐 ====================
  function tryAutoPlayMusic() {
    const play = () => {
      bgMusic.volume = 0.3;
      bgMusic.play().then(() => {
        musicOn = true;
        btnMusic.textContent = '🔊';
      }).catch(() => {
        musicOn = false;
        btnMusic.textContent = '🔇';
      });
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

  /** 渲染奖项选项卡 */
  function renderPrizeTabs() {
    if (state.prizes.length === 0) {
      prizeTabsEl.innerHTML = '<span style="color:var(--color-text-muted)">暂无奖项，请在管理后台配置</span>';
      return;
    }

    if (selectedPrizeIndex >= state.prizes.length) {
      selectedPrizeIndex = 0;
    }

    prizeTabsEl.innerHTML = state.prizes.map((p, i) => {
      const remaining = p.total - p.drawn.length;
      const isFull = remaining <= 0;
      const cls = [
        'prize-tab',
        i === selectedPrizeIndex ? 'active' : '',
        isFull ? 'full' : '',
        p.isConsolation ? 'consolation' : '',
      ].filter(Boolean).join(' ');
      const label = p.isConsolation ? `${escapeHtml(p.name)} 🌻` : `${escapeHtml(p.name)} 🏆`;
      return `<button class="${cls}" data-index="${i}">${label} (${remaining}/${p.total})</button>`;
    }).join('');
  }

  /** 渲染当前奖项已中奖名单 */
  function renderDrawnList() {
    const prize = state.prizes[selectedPrizeIndex];
    if (!prize || prize.drawn.length === 0) {
      drawnListEl.innerHTML = '';
      return;
    }

    drawnListEl.innerHTML = `
      <h3>${escapeHtml(prize.name)} 已中奖</h3>
      <div class="drawn-names">
        ${prize.drawn.map(n => `<span class="drawn-name-badge">${escapeHtml(n)}</span>`).join('')}
      </div>
    `;
  }

  /** 渲染中奖结果汇总 */
  function renderResults() {
    const hasDrawn = state.prizes.some(p => p.drawn.length > 0);
    const history = state.history || [];
    const hasHistory = history.length > 0;

    if (!hasDrawn && !hasHistory) {
      resultsSummaryEl.innerHTML = '<p style="color:var(--color-text-muted);text-align:center">暂无中奖记录</p>';
      return;
    }

    let html = '';

    // 中奖汇总
    if (hasDrawn) {
      html += state.prizes
        .filter(p => p.drawn.length > 0)
        .map(p => `
          <div class="result-group">
            <h3>🏆 ${escapeHtml(p.name)}</h3>
            <ul>${p.drawn.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>
          </div>
        `).join('');
    }

    // 抽奖记录
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
    if (!prize) {
      showToast('请先选择奖项', 'error');
      return;
    }

    const remaining = prize.total - prize.drawn.length;
    if (remaining <= 0) {
      showToast(`"${prize.name}" 名额已满`, 'error');
      return;
    }

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

    if (!prize.isConsolation) {
      candidates = candidates.filter(n => !hqPool.has(n));
    }

    if (candidates.length === 0) {
      showToast('没有可供抽奖的候选人', 'error');
      return;
    }

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
      if (isRolling) {
        rollRAF = requestAnimationFrame(tick);
      }
    }
    rollRAF = requestAnimationFrame(tick);
  }

  function stopRollingAnimation() {
    if (rollRAF) {
      cancelAnimationFrame(rollRAF);
      rollRAF = null;
    }
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

      if (winners.length === 1) {
        rollingNameEl.textContent = winners[0];
        rollingNameEl.classList.add('winner-reveal');
        setTimeout(() => {
          showWinnerModal(msg.prizeName, winners[0]);
          launchFireworks();
        }, 200);
      } else {
        rollingNameEl.textContent = winners.join('、');
        rollingNameEl.classList.add('winner-reveal');
        setTimeout(() => {
          showWinnerModal(msg.prizeName, winners.join('、'));
          launchFireworks();
        }, 200);
      }
    }

    isDrawing = false;
    isRolling = false;
    isDrawInitiator = false;
    btnDraw.disabled = false;
    btnDraw.textContent = '🎯 开始抽奖';
  }

  // ==================== 中奖弹窗 ====================

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

    for (let i = 0; i < 5; i++) {
      setTimeout(() => {
        fireworks.push(createFirework());
      }, i * 300);
    }

    if (!fireworksRunning) {
      fireworksRunning = true;
      animateFireworks();
    }
  }

  function createFirework() {
    const x = Math.random() * fireworksCanvas.width;
    const targetY = Math.random() * fireworksCanvas.height * 0.4 + 50;
    return {
      x,
      y: fireworksCanvas.height,
      targetY,
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

        if (fw.y <= fw.targetY) {
          fw.exploded = true;
          explode(fw);
          fireworks.splice(i, 1);
        }
      }
    }

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.05;
      p.life -= 0.02;

      if (p.life <= 0) {
        particles[i] = particles[particles.length - 1];
        particles.pop();
        continue;
      }

      ctx.globalAlpha = p.life;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
    }

    ctx.globalAlpha = 1;

    if (fireworks.length > 0 || particles.length > 0) {
      requestAnimationFrame(animateFireworks);
    } else {
      ctx.clearRect(0, 0, fireworksCanvas.width, fireworksCanvas.height);
      fireworksRunning = false;
    }
  }

  function explode(fw) {
    const count = 60 + Math.floor(Math.random() * 40);
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 / count) * i;
      const speed = 1 + Math.random() * 3;
      particles.push({
        x: fw.x,
        y: fw.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 1 + Math.random() * 2,
        color: fw.color,
        life: 1,
      });
    }
  }

  // ==================== 导出结果 ====================

  function exportResults() {
    const hasDrawn = state.prizes.some(p => p.drawn.length > 0);
    const history = state.history || [];
    if (!hasDrawn && history.length === 0) {
      showToast('暂无中奖记录可导出');
      return;
    }

    const lines = ['抽奖结果', ''];

    // 汇总
    state.prizes.filter(p => p.drawn.length > 0).forEach(p => {
      lines.push(`${p.name}: ${p.drawn.join('、')}`);
    });

    // 详细记录
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
    showToast('结果已导出');
  }

  // ==================== 工具函数 ====================

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  let toastTimer = null;
  function showToast(message, type) {
    toastEl.textContent = message;
    toastEl.className = 'toast' + (type === 'error' ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.add('hidden');
    }, 3000);
  }

  // ==================== 事件绑定 ====================

  function bindEvents() {
    btnDraw.addEventListener('click', startDraw);
    btnMusic.addEventListener('click', toggleMusic);
    if (btnExport) btnExport.addEventListener('click', exportResults);

    prizeTabsEl.addEventListener('click', e => {
      const tab = e.target.closest('.prize-tab');
      if (!tab || tab.classList.contains('full')) return;
      if (isDrawing || isRolling) {
        showToast('抽奖进行中，无法切换奖项', 'error');
        return;
      }
      selectedPrizeIndex = parseInt(tab.dataset.index, 10);
      renderPrizeTabs();
      renderDrawnList();
      rollingNameEl.textContent = '准备抽奖';
      rollingNameEl.classList.remove('animating', 'winner-reveal');
    });

    btnCloseWinner.addEventListener('click', () => {
      modalWinner.classList.add('hidden');
    });

    modalWinner.addEventListener('click', e => {
      if (e.target === modalWinner) modalWinner.classList.add('hidden');
    });

    window.addEventListener('beforeunload', () => {
      if (rollRAF) cancelAnimationFrame(rollRAF);
      if (fireworksRunning) {
        fireworksRunning = false;
        ctx.clearRect(0, 0, fireworksCanvas.width, fireworksCanvas.height);
      }
    });
  }
})();
