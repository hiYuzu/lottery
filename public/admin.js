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

  wsManager.on('init', msg => { state = msg.state; renderPrizeEditor(state.prizes.map(p => ({ ...p, drawn: [...p.drawn] }))); });
  wsManager.on('prizesUpdated', msg => { state = msg.state; renderPrizeEditor(state.prizes.map(p => ({ ...p, drawn: [...p.drawn] }))); showToast(toastEl, '奖项配置已更新'); });
  wsManager.on('resetDone', msg => { state = msg.state; renderPrizeEditor(state.prizes.map(p => ({ ...p, drawn: [...p.drawn] }))); showToast(toastEl, '抽奖已重置'); });
  wsManager.on('drawResult', msg => { state = msg.state; renderPrizeEditor(state.prizes.map(p => ({ ...p, drawn: [...p.drawn] }))); });
  wsManager.on('error', msg => showToast(toastEl, msg.message, 'error'));

  init();

  function init() {
    loadNameList().then(({ names, hqPool: hp }) => { nameList = names; hqPool = hp; renderNameList(); }).catch(() => showToast(toastEl, '加载名单失败', 'error'));
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
      editorData[i].name = row.querySelector('[data-field="name"]').value;
      editorData[i].total = parseInt(row.querySelector('[data-field="total"]').value, 10) || 1;
      editorData[i].perDraw = parseInt(row.querySelector('[data-field="perDraw"]').value, 10) || 1;
      const ci = row.querySelector('[data-field="isConsolation"]');
      editorData[i].isConsolation = ci ? ci.checked : false;
    });
  }

  function bindDragEvents() {
    if (!dragSupported) return;
    prizeEditor.querySelectorAll('.prize-row').forEach(row => {
      row.addEventListener('dragstart', e => { dragSrcIndex = parseInt(row.dataset.index, 10); row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
      row.addEventListener('dragend', () => { row.classList.remove('dragging'); prizeEditor.querySelectorAll('.prize-row').forEach(r => r.classList.remove('drag-over')); });
      row.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; row.classList.add('drag-over'); });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', e => { e.preventDefault(); row.classList.remove('drag-over'); const t = parseInt(row.dataset.index, 10); if (dragSrcIndex === null || dragSrcIndex === t) return; syncEditorData(); const item = editorData.splice(dragSrcIndex, 1)[0]; editorData.splice(t, 0, item); renderPrizeEditor(editorData); });
    });
  }

  function addPrizeRow() { editorData.push({ name: '', total: 1, perDraw: 1, drawn: [], isConsolation: false }); renderPrizeEditor(editorData); }
  function removePrizeRow(index) { editorData.splice(index, 1); renderPrizeEditor(editorData); }

  function savePrizes() {
    const rows = prizeEditor.querySelectorAll('.prize-row');
    const prizes = [];
    let valid = true, errorMsg = '';
    rows.forEach((row, i) => {
      const name = row.querySelector('[data-field="name"]').value.trim();
      const total = parseInt(row.querySelector('[data-field="total"]').value, 10);
      const perDraw = parseInt(row.querySelector('[data-field="perDraw"]').value, 10);
      const ci = row.querySelector('[data-field="isConsolation"]');
      if (!name || isNaN(total) || total < 1 || isNaN(perDraw) || perDraw < 1) { valid = false; if (!name) row.querySelector('[data-field="name"]').style.borderColor = 'red'; return; }
      row.querySelector('[data-field="name"]').style.borderColor = ''; row.querySelector('[data-field="total"]').style.borderColor = ''; row.querySelector('[data-field="perDraw"]').style.borderColor = '';
      const existing = editorData[i] || {}; const drawn = existing.drawn || [];
      if (drawn.length > total) { valid = false; errorMsg = `"${name}" 总人数不能少于已中奖人数(${drawn.length}人)`; row.querySelector('[data-field="total"]').style.borderColor = 'red'; }
      prizes.push({ name, total, perDraw: perDraw || 1, drawn, isConsolation: ci ? ci.checked : false });
    });
    if (!valid) { showToast(toastEl, errorMsg || '请确保每个奖项都有名称，总人数和单次抽取人数均≥1', 'error'); return; }
    const names = prizes.map(p => p.name); const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    if (dupes.length > 0) { showToast(toastEl, `奖项名称重复: ${dupes.join('、')}`, 'error'); return; }
    send({ type: 'updatePrizes', prizes }); hasUnsavedChanges = false;
  }

  function resetLottery() { if (!confirm('确定要重置所有抽奖结果吗？此操作不可撤销。')) return; send({ type: 'reset' }); }

  function bindEvents() {
    btnAddPrize.addEventListener('click', addPrizeRow);
    btnSavePrizes.addEventListener('click', savePrizes);
    btnReset.addEventListener('click', resetLottery);
    if (btnExport) btnExport.addEventListener('click', () => {
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
    prizeEditor.addEventListener('click', e => { const btn = e.target.closest('[data-remove]'); if (btn) removePrizeRow(parseInt(btn.dataset.remove, 10)); });
    prizeEditor.addEventListener('input', () => { hasUnsavedChanges = true; });
    window.addEventListener('beforeunload', e => { if (hasUnsavedChanges) { e.preventDefault(); e.returnValue = ''; } });
  }
})();
