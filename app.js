import { db, auth, googleProvider } from './firebase.js';
import {
  collection, doc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, where, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
  signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";


// ==================== STATE ====================
let currentUser = null;
let positions = [];   // Firestoreのトレードデータ
let unsubscribe = null;
let editingId = null;
let fxRate = parseFloat(localStorage.getItem('tl_fx') || '153');
let sortKey = 'entryDate';
let sortAsc = false;
const NISA_LIMIT = 2400000;
const NISA_YEAR = new Date().getFullYear();

// ==================== UTILS ====================
const $ = id => document.getElementById(id);
const fmt = (n, d=0) => n == null || isNaN(n) ? '—' : new Intl.NumberFormat('ja-JP', {maximumFractionDigits:d, minimumFractionDigits:d}).format(n);
const fmtJpy = n => n == null || isNaN(n) ? '—' : '¥' + fmt(n);
const fmtUsd = n => n == null || isNaN(n) ? '—' : '$' + fmt(n, 2);
const fmtPct = n => n == null || isNaN(n) ? '—' : (n >= 0 ? '+' : '') + fmt(n, 2) + '%';
const fmtDate = s => s || '—';

function toast(msg, type='') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show ' + type;
  setTimeout(() => t.className = '', 3000);
}

// ==================== AUTH ====================
onAuthStateChanged(auth, user => {
  if (user) {
    currentUser = user;
    $('auth-screen').style.display = 'none';
    $('app').classList.add('visible');
    startListener();
    updateFxDisplay();
  } else {
    currentUser = null;
    $('auth-screen').style.display = 'flex';
    $('app').classList.remove('visible');
    if (unsubscribe) unsubscribe();
    positions = [];
  }
});

$('btn-google-login').addEventListener('click', async () => {
  try { await signInWithPopup(auth, googleProvider); }
  catch(e) { toast('ログインに失敗しました: ' + e.message, 'error'); }
});

$('btn-logout').addEventListener('click', async () => {
  if (confirm('ログアウトしますか？')) await signOut(auth);
});

// ==================== FIRESTORE ====================
function startListener() {
  if (unsubscribe) unsubscribe();
  const q = query(
    collection(db, 'tradelog'),
    where('uid', '==', currentUser.uid),
    orderBy('entryDate', 'desc')
  );
  unsubscribe = onSnapshot(q, snap => {
    positions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderAll();
  }, err => {
    if (err.code === 'failed-precondition') {
      toast('インデックスの作成が必要です。コンソールを確認してください。', 'error');
    }
  });
}

async function savePosition(data) {
  try {
    if (editingId) {
      await updateDoc(doc(db, 'tradelog', editingId), { ...data, updatedAt: serverTimestamp() });
      toast('取引を更新しました', 'success');
    } else {
      await addDoc(collection(db, 'tradelog'), { ...data, uid: currentUser.uid, createdAt: serverTimestamp() });
      toast('取引を追加しました', 'success');
    }
  } catch(e) { toast('保存エラー: ' + e.message, 'error'); }
}

async function deletePosition(id) {
  if (!confirm('この取引を削除しますか？')) return;
  try {
    await deleteDoc(doc(db, 'tradelog', id));
    toast('削除しました');
  } catch(e) { toast('削除エラー', 'error'); }
}

// ==================== FX RATE ====================
async function fetchFxRate() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await res.json();
    if (data.rates && data.rates.JPY) {
      fxRate = data.rates.JPY;
      localStorage.setItem('tl_fx', fxRate);
      updateFxDisplay();
      return true;
    }
  } catch(e) {}
  return false;
}

function updateFxDisplay() {
  $('fx-rate').textContent = 'USD/JPY: ' + fxRate.toFixed(2);
}

$('fx-chip').addEventListener('click', () => {
  $('fx-modal-input').value = fxRate;
  $('fx-modal').classList.add('open');
});

$('fx-refresh').addEventListener('click', async () => {
  toast('為替レートを取得中...');
  const ok = await fetchFxRate();
  toast(ok ? 'レートを更新しました (' + fxRate.toFixed(2) + ')' : '取得失敗。手動入力してください', ok ? 'success' : 'error');
  $('fx-modal-input').value = fxRate;
});

$('fx-save').addEventListener('click', () => {
  const v = parseFloat($('fx-modal-input').value);
  if (v > 0) { fxRate = v; localStorage.setItem('tl_fx', v); updateFxDisplay(); }
  $('fx-modal').classList.remove('open');
  renderAll();
});

$('fx-cancel').addEventListener('click', () => $('fx-modal').classList.remove('open'));

// ==================== TABS ====================
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelector(`.tab[data-tab="${name}"]`).classList.add('active');
  $('page-' + name).classList.add('active');
  if (name === 'positions') renderPositions();
  if (name === 'analytics') renderAnalytics();
}

document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
});

// ==================== CALCULATIONS ====================
function calcCommission(account, entryPriceUsd, shares, entryFx) {
  if (account === 'nisa') return 0;
  const amountUsd = entryPriceUsd * shares;
  const amountJpy = amountUsd * entryFx;
  if (account === 'rakuten') {
    // 0.495% 上限$22
    const commUsd = Math.min(amountUsd * 0.00495, 22);
    const fxComm = entryPriceUsd > 0 ? 0.25 * shares : 0; // 為替手数料 25銭/ドル
    return Math.round(commUsd * entryFx + fxComm);
  }
  if (account === 'moomoo') {
    // 0.132% 上限$22 ($8.3以下無料)、為替無料
    const commUsd = amountUsd <= 8.3 / 0.00132 ? 0 : Math.min(amountUsd * 0.00132, 22);
    return Math.round(commUsd * entryFx);
  }
  return 0;
}

function calcTrade(t) {
  const entryJpy = t.entryPrice * t.entryFx;
  const totalCost = Math.round(t.shares * entryJpy + (t.commission || 0));
  let totalExit = 0, totalExitShares = 0;
  (t.exits || []).forEach(ex => {
    totalExit += ex.shares * ex.exitPrice * ex.exitFx;
    totalExitShares += ex.shares;
  });
  const remainShares = t.shares - totalExitShares;
  const costOfSold = totalExitShares > 0 ? (totalCost * totalExitShares / t.shares) : 0;
  const pnl = totalExitShares > 0 ? Math.round(totalExit - costOfSold) : null;
  const pnlPct = pnl != null && costOfSold > 0 ? (pnl / costOfSold) * 100 : null;
  const status = remainShares <= 0 ? 'closed' : totalExitShares > 0 ? 'partial' : 'open';
  return { entryJpy, totalCost, totalExitShares, remainShares, pnl, pnlPct, status };
}

// ==================== NISA TRACKING ====================
function calcNisaUsed() {
  return positions
    .filter(t => t.account === 'nisa' && t.entryDate && t.entryDate.startsWith(NISA_YEAR + ''))
    .reduce((s, t) => s + (t.totalCost || 0), 0);
}

function renderNisaBar() {
  const used = calcNisaUsed();
  const pct = Math.min((used / NISA_LIMIT) * 100, 100);
  $('nisa-used').textContent = '¥' + fmt(used / 10000, 0) + '万';
  const bar = $('nisa-progress');
  bar.style.width = pct + '%';
  bar.className = 'nisa-progress' + (pct > 90 ? ' danger' : pct > 70 ? ' warn' : '');
}

// ==================== RENDER ALL ====================
function renderAll() {
  renderNisaBar();
  renderTrades();
}

// ==================== RENDER TRADES ====================
function getFiltered() {
  const q = ($('search-input').value || '').toUpperCase();
  const st = $('filter-status').value;
  const res = $('filter-result').value;
  const acc = $('filter-account').value;
  return positions.filter(t => {
    const calc = calcTrade(t);
    if (q && !t.ticker.includes(q) && !(t.name||'').toUpperCase().includes(q)) return false;
    if (st && calc.status !== st) return false;
    if (acc && t.account !== acc) return false;
    if (res === 'win' && !(calc.pnl > 0)) return false;
    if (res === 'loss' && !(calc.pnl < 0)) return false;
    return true;
  });
}

function getSorted(arr) {
  return [...arr].sort((a, b) => {
    const ac = calcTrade(a), bc = calcTrade(b);
    const map = { pnl: t => calcTrade(t).pnl, pnlPct: t => calcTrade(t).pnlPct, status: t => calcTrade(t).status };
    let av = map[sortKey] ? map[sortKey](a) : a[sortKey];
    let bv = map[sortKey] ? map[sortKey](b) : b[sortKey];
    if (av == null) return 1; if (bv == null) return -1;
    if (typeof av === 'string') return sortAsc ? av.localeCompare(bv,'ja') : bv.localeCompare(av,'ja');
    return sortAsc ? av - bv : bv - av;
  });
}

function sortBy(key) {
  if (sortKey === key) sortAsc = !sortAsc; else { sortKey = key; sortAsc = false; }
  renderTrades();
}

window.sortBy = sortBy;

function renderTrades() {
  const filtered = getSorted(getFiltered());
  const body = $('trades-body');
  renderSummary(filtered);

  if (filtered.length === 0) {
    body.innerHTML = `<tr><td colspan="20"><div class="empty"><div class="empty-icon">📋</div><p>取引記録がありません</p></div></td></tr>`;
    return;
  }

  body.innerHTML = filtered.map(t => {
    const c = calcTrade(t);
    const statusLabel = { open: '保有中', partial: '一部決済', closed: '決済済' }[c.status];
    const statusCls = { open: 's-open', partial: 's-partial', closed: 's-closed' }[c.status];
    const resultCls = c.pnl == null ? 'r-open' : c.pnl > 0 ? 'r-win' : 'r-loss';
    const resultLabel = c.pnl == null ? '保有中' : c.pnl > 0 ? '✓ 勝' : '✗ 負';
    const pnlCls = c.pnl == null ? 'c-blue' : c.pnl > 0 ? 'c-pos' : 'c-neg';
    const acctCls = { nisa: 'acct-nisa', rakuten: 'acct-rakuten', moomoo: 'acct-moomoo' }[t.account] || '';
    const acctLabel = { nisa: 'NISA', rakuten: '楽天特定', moomoo: 'moomoo' }[t.account] || t.account || '';
    const rr = t.stopLoss && t.takeProfit && t.entryPrice !== t.stopLoss
      ? ((t.takeProfit - t.entryPrice) / (t.entryPrice - t.stopLoss)).toFixed(2)
      : null;
    const lastExit = (t.exits || []).slice(-1)[0];

    return `<tr>
      <td>
        <span class="ticker-pill">${t.ticker}</span>
        ${t.name ? `<div class="sub-text">${t.name}</div>` : ''}
      </td>
      <td><span class="acct-pill ${acctCls}">${acctLabel}</span></td>
      <td class="mono">${fmtDate(t.entryDate)}<div class="sub-text">${t.sector||''}</div></td>
      <td class="mono">${fmt(t.shares)}<div class="sub-text">残:${fmt(c.remainShares)}</div></td>
      <td class="mono">${fmtUsd(t.entryPrice)}<div class="sub-text">@${t.entryFx}</div></td>
      <td class="mono">${fmtJpy(c.entryJpy)}</td>
      <td class="mono c-acc">${fmtJpy(c.totalCost)}${t.commission ? `<div class="sub-text">手数料:${fmtJpy(t.commission)}</div>` : ''}</td>
      <td class="mono">${t.per ? fmt(t.per,1) : '—'}<div class="sub-text">${t.perFwd ? '予:'+fmt(t.perFwd,1) : ''}</div></td>
      <td class="mono">${lastExit ? fmtDate(lastExit.exitDate) : '—'}<div class="sub-text">${t.deliveryDate ? '受渡:'+t.deliveryDate : ''}</div></td>
      <td class="mono">${lastExit ? fmtUsd(lastExit.exitPrice) : '—'}<div class="sub-text">${c.totalExitShares > 0 ? fmt(c.totalExitShares)+'株' : ''}</div></td>
      <td class="mono ${pnlCls}">${fmtJpy(c.pnl)}</td>
      <td class="mono ${pnlCls}">${fmtPct(c.pnlPct)}</td>
      <td><span class="result-pill ${resultCls}">${resultLabel}</span>${rr ? `<div class="sub-text">RR:${rr}</div>` : ''}</td>
      <td><span class="status-pill ${statusCls}">${statusLabel}</span></td>
      <td style="max-width:140px; overflow:hidden; text-overflow:ellipsis; color:var(--text2)">${t.note||'—'}</td>
      <td>
        <button class="icon-btn" onclick="openEdit('${t.id}')" title="編集">✏️</button>
        ${c.status !== 'closed' ? `<button class="icon-btn exit" onclick="openExitModal('${t.id}')" title="決済">💹</button>` : ''}
        <button class="icon-btn del" onclick="deletePosition('${t.id}')" title="削除">🗑</button>
      </td>
    </tr>`;
  }).join('');
}

window.openEdit = openEdit;
window.deletePosition = deletePosition;
window.openExitModal = openExitModal;

function renderSummary(filtered) {
  const calcs = filtered.map(t => ({ t, c: calcTrade(t) }));
  const closed = calcs.filter(x => x.c.pnl != null);
  const wins = closed.filter(x => x.c.pnl > 0);
  const losses = closed.filter(x => x.c.pnl < 0);
  const totalPnl = closed.reduce((s, x) => s + x.c.pnl, 0);
  const totalInvested = calcs.reduce((s, x) => s + (x.c.totalCost || 0), 0);
  const winRate = closed.length > 0 ? wins.length / closed.length * 100 : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, x) => s + x.c.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, x) => s + x.c.pnl, 0) / losses.length : 0;
  const pf = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : null;
  const openCount = calcs.filter(x => x.c.status !== 'closed').length;

  $('summary-cards').innerHTML = [
    { label: '総損益', val: fmtJpy(totalPnl), cls: totalPnl >= 0 ? 'c-pos' : 'c-neg' },
    { label: '投資総額', val: fmtJpy(totalInvested), cls: 'c-acc' },
    { label: '勝率', val: closed.length > 0 ? fmt(winRate,1)+'%' : '—', sub: `${wins.length}勝 ${losses.length}敗`, cls: winRate >= 50 ? 'c-pos' : 'c-neg' },
    { label: 'PF', val: pf ? fmt(pf,2) : '—', sub: 'プロフィットファクター', cls: pf >= 1 ? 'c-pos' : 'c-neg' },
    { label: '取引数', val: filtered.length, sub: `保有中:${openCount}`, cls: 'c-muted' },
    { label: '平均利益', val: avgWin ? fmtJpy(avgWin) : '—', cls: 'c-pos' },
    { label: '平均損失', val: avgLoss ? fmtJpy(avgLoss) : '—', cls: 'c-neg' },
  ].map(c => `<div class="card"><div class="card-label">${c.label}</div><div class="card-val ${c.cls}">${c.val}</div>${c.sub ? `<div class="card-sub">${c.sub}</div>` : ''}</div>`).join('');
}

// ==================== ADD / EDIT MODAL ====================
$('btn-add').addEventListener('click', () => {
  editingId = null;
  $('modal-title').textContent = '新規エントリー';
  clearForm();
  $('f-entry-fx').value = fxRate.toFixed(2);
  $('trade-modal').classList.add('open');
});

function openEdit(id) {
  const t = positions.find(x => x.id === id);
  if (!t) return;
  editingId = id;
  $('modal-title').textContent = '取引編集';
  $('f-ticker').value = t.ticker || '';
  $('f-name').value = t.name || '';
  $('f-sector').value = t.sector || '';
  $('f-account').value = t.account || 'nisa';
  $('f-strategy').value = t.strategy || '';
  $('f-entry-date').value = t.entryDate || '';
  $('f-shares').value = t.shares || '';
  $('f-entry-price').value = t.entryPrice || '';
  $('f-entry-fx').value = t.entryFx || fxRate;
  $('f-per').value = t.per || '';
  $('f-per-fwd').value = t.perFwd || '';
  $('f-stop-loss').value = t.stopLoss || '';
  $('f-take-profit').value = t.takeProfit || '';
  $('f-delivery-date').value = t.deliveryDate || '';
  $('f-entry-reason').value = t.entryReason || '';
  $('f-note').value = t.note || '';
  calcModal();
  $('trade-modal').classList.add('open');
}

function clearForm() {
  ['f-ticker','f-name','f-sector','f-strategy','f-entry-date','f-shares','f-entry-price',
   'f-entry-fx','f-per','f-per-fwd','f-stop-loss','f-take-profit','f-delivery-date',
   'f-entry-reason','f-note'].forEach(id => { $(id) && ($(id).value = ''); });
  $('f-account').value = 'nisa';
  $('f-commission-display').textContent = '¥0';
  $('f-entry-jpy').value = '';
  $('f-total-cost').value = '';
  //$('img-preview').innerHTML = '';
}

$('btn-close-modal').addEventListener('click', () => $('trade-modal').classList.remove('open'));
$('btn-save-trade').addEventListener('click', saveTrade);

function calcModal() {
  const shares = parseInt($('f-shares').value) || 0;
  const ep = parseFloat($('f-entry-price').value) || 0;
  const efx = parseFloat($('f-entry-fx').value) || fxRate;
  const account = $('f-account').value;
  const comm = calcCommission(account, ep, shares, efx);
  const entryJpy = ep * efx;
  const totalCost = Math.round(shares * entryJpy + comm);
  $('f-entry-jpy').value = ep > 0 ? fmtJpy(entryJpy) : '';
  $('f-total-cost').value = totalCost > 0 ? fmtJpy(totalCost) : '';
  $('f-commission-display').textContent = fmtJpy(comm);
}

$('f-shares').addEventListener('input', calcModal);
$('f-entry-price').addEventListener('input', calcModal);
$('f-entry-fx').addEventListener('input', calcModal);
$('f-account').addEventListener('change', calcModal);

async function saveTrade() {
  const ticker = $('f-ticker').value.trim().toUpperCase();
  const entryDate = $('f-entry-date').value;
  const shares = parseInt($('f-shares').value);
  const entryPrice = parseFloat($('f-entry-price').value);
  if (!ticker || !entryDate || !shares || !entryPrice) {
    toast('ティッカー、エントリー日、株数、買値は必須です', 'error');
    return;
  }
  const efx = parseFloat($('f-entry-fx').value) || fxRate;
  const account = $('f-account').value;
  const comm = calcCommission(account, entryPrice, shares, efx);
  const entryJpy = entryPrice * efx;
  const totalCost = Math.round(shares * entryJpy + comm);

  const data = {
    ticker, shares, entryPrice, entryDate, entryFx: efx, entryJpy, totalCost, commission: comm, account,
    name: $('f-name').value.trim(),
    sector: $('f-sector').value,
    strategy: $('f-strategy').value,
    per: parseFloat($('f-per').value) || null,
    perFwd: parseFloat($('f-per-fwd').value) || null,
    stopLoss: parseFloat($('f-stop-loss').value) || null,
    takeProfit: parseFloat($('f-take-profit').value) || null,
    deliveryDate: $('f-delivery-date').value || null,
    entryReason: $('f-entry-reason').value.trim(),
    note: $('f-note').value.trim(),
  };

  // 既存のexitsを保持
  if (editingId) {
    const existing = positions.find(x => x.id === editingId);
    if (existing) data.exits = existing.exits || [];
  }

  $('trade-modal').classList.remove('open');
  await savePosition(data);
}

// ==================== EXIT MODAL ====================
let exitingId = null;

function openExitModal(id) {
  exitingId = id;
  const t = positions.find(x => x.id === id);
  if (!t) return;
  const c = calcTrade(t);
  $('exit-ticker').textContent = t.ticker;
  $('exit-remain').textContent = fmt(c.remainShares) + '株';
  $('exit-avg-cost').textContent = fmtJpy(t.entryJpy);
  $('f-exit-shares').max = c.remainShares;
  $('f-exit-shares').value = c.remainShares;
  $('f-exit-price').value = '';
  $('f-exit-fx').value = fxRate.toFixed(2);
  $('f-exit-date').value = new Date().toISOString().split('T')[0];
  $('f-exit-reason').value = '';
  renderExitHistory(t);
  calcExit(t);
  $('exit-modal').classList.add('open');
}

function calcExit(t) {
  if (!t) { t = positions.find(x => x.id === exitingId); }
  if (!t) return;
  const c = calcTrade(t);
  const shares = parseInt($('f-exit-shares').value) || 0;
  const xp = parseFloat($('f-exit-price').value) || 0;
  const xfx = parseFloat($('f-exit-fx').value) || fxRate;
  const exitAmount = shares * xp * xfx;
  const costOfSold = shares > 0 ? (t.totalCost * shares / t.shares) : 0;
  const pnl = xp > 0 ? Math.round(exitAmount - costOfSold) : null;
  const pnlPct = pnl != null && costOfSold > 0 ? (pnl / costOfSold) * 100 : null;
  const pnlEl = $('exit-pnl-preview');
  pnlEl.textContent = pnl != null ? fmtJpy(pnl) + ' (' + fmtPct(pnlPct) + ')' : '—';
  pnlEl.className = pnl == null ? '' : pnl >= 0 ? 'c-pos' : 'c-neg';
}

['f-exit-shares','f-exit-price','f-exit-fx'].forEach(id => {
  $(id) && $(id).addEventListener('input', () => calcExit(null));
});

function renderExitHistory(t) {
  const exits = t.exits || [];
  if (exits.length === 0) { $('exits-history').innerHTML = ''; return; }
  $('exits-history').innerHTML = '<div style="font-size:11px;color:var(--muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.07em">決済履歴</div>' +
    exits.map((ex, i) => `
      <div class="exit-row">
        <span class="mono">${ex.exitDate}</span>
        <span class="mono">${fmt(ex.shares)}株 @ ${fmtUsd(ex.exitPrice)}</span>
        <span class="mono ${ex.pnl >= 0 ? 'c-pos':'c-neg'}">${fmtJpy(ex.pnl)}</span>
        <button class="icon-btn del" onclick="removeExit('${t.id}',${i})" title="削除">✕</button>
      </div>`).join('');
}

window.removeExit = async function(id, idx) {
  if (!confirm('この決済記録を削除しますか？')) return;
  const t = positions.find(x => x.id === id);
  if (!t) return;
  const exits = [...(t.exits || [])];
  exits.splice(idx, 1);
  await updateDoc(doc(db, 'tradelog', id), { exits, updatedAt: serverTimestamp() });
  toast('削除しました');
};

$('btn-save-exit').addEventListener('click', async () => {
  const t = positions.find(x => x.id === exitingId);
  if (!t) return;
  const c = calcTrade(t);
  const shares = parseInt($('f-exit-shares').value);
  const exitPrice = parseFloat($('f-exit-price').value);
  const exitDate = $('f-exit-date').value;
  if (!shares || !exitPrice || !exitDate) { toast('株数、売値、決済日は必須です', 'error'); return; }
  if (shares > c.remainShares) { toast(`残株数(${c.remainShares}株)を超えています`, 'error'); return; }
  const xfx = parseFloat($('f-exit-fx').value) || fxRate;
  const exitAmount = shares * exitPrice * xfx;
  const costOfSold = t.totalCost * shares / t.shares;
  const pnl = Math.round(exitAmount - costOfSold);
  const pnlPct = costOfSold > 0 ? (pnl / costOfSold) * 100 : 0;
  const exitRecord = { shares, exitPrice, exitFx: xfx, exitDate, pnl, pnlPct, reason: $('f-exit-reason').value.trim() };
  const exits = [...(t.exits || []), exitRecord];
  await updateDoc(doc(db, 'tradelog', exitingId), { exits, updatedAt: serverTimestamp() });
  toast('決済を記録しました', 'success');
  $('exit-modal').classList.remove('open');
});

$('btn-close-exit').addEventListener('click', () => $('exit-modal').classList.remove('open'));

// ==================== IMAGES ====================

// 画像機能は無効（Firebase Storage有料プランが必要）

// ==================== POSITIONS VIEW ====================
function renderPositions() {
  const open = positions.filter(t => {
    const c = calcTrade(t);
    return c.status !== 'closed';
  });
  const grid = $('pos-grid');
  if (open.length === 0) {
    grid.innerHTML = `<div style="grid-column:1/-1"><div class="empty"><div class="empty-icon">💼</div><p>保有中の銘柄はありません</p></div></div>`;
    return;
  }
  // Group by ticker
  const grouped = {};
  open.forEach(t => {
    if (!grouped[t.ticker]) grouped[t.ticker] = { ticker:t.ticker, name:t.name, sector:t.sector, items:[] };
    grouped[t.ticker].items.push(t);
  });
  grid.innerHTML = Object.values(grouped).map(g => {
    const totalShares = g.items.reduce((s, t) => { const c = calcTrade(t); return s + c.remainShares; }, 0);
    const totalCost = g.items.reduce((s, t) => { const c = calcTrade(t); return s + (t.totalCost * c.remainShares / t.shares); }, 0);
    const avgJpy = totalShares > 0 ? totalCost / totalShares : 0;
    const avgUsd = avgJpy / (g.items[0].entryFx || fxRate);
    const acctLabel = { nisa:'NISA', rakuten:'楽天特定', moomoo:'moomoo' }[g.items[0].account] || '';
    const acctCls = { nisa:'acct-nisa', rakuten:'acct-rakuten', moomoo:'acct-moomoo' }[g.items[0].account] || '';
    return `<div class="pos-card">
      <div class="pos-head">
        <div>
          <div class="pos-ticker">${g.ticker}</div>
          <div class="pos-name">${g.name||''} ${g.sector ? '· '+g.sector : ''}</div>
        </div>
        <span class="acct-pill ${acctCls}">${acctLabel}</span>
      </div>
      <div class="pos-stats">
        <div><div class="pos-stat-l">保有株数</div><div class="pos-stat-v">${fmt(totalShares)}株</div></div>
        <div><div class="pos-stat-l">平均取得単価(USD)</div><div class="pos-stat-v">${fmtUsd(avgUsd)}</div></div>
        <div><div class="pos-stat-l">平均取得単価(JPY)</div><div class="pos-stat-v">${fmtJpy(avgJpy)}</div></div>
        <div><div class="pos-stat-l">投資総額(JPY)</div><div class="pos-stat-v c-acc">${fmtJpy(totalCost)}</div></div>
        ${g.items[0].stopLoss ? `<div><div class="pos-stat-l">損切価格</div><div class="pos-stat-v c-neg">${fmtUsd(g.items[0].stopLoss)}</div></div>` : ''}
        ${g.items[0].takeProfit ? `<div><div class="pos-stat-l">目標価格</div><div class="pos-stat-v c-pos">${fmtUsd(g.items[0].takeProfit)}</div></div>` : ''}
      </div>
    </div>`;
  }).join('');
}

// ==================== ANALYTICS ====================
function renderAnalytics() {
  const calcs = positions.map(t => ({ t, c: calcTrade(t) }));
  const closed = calcs.filter(x => x.c.pnl != null);
  const wins = closed.filter(x => x.c.pnl > 0);
  const losses = closed.filter(x => x.c.pnl < 0);
  const totalPnl = closed.reduce((s, x) => s + x.c.pnl, 0);
  const maxWin = wins.length > 0 ? wins.reduce((a, b) => a.c.pnl > b.c.pnl ? a : b) : null;
  const maxLoss = losses.length > 0 ? losses.reduce((a, b) => a.c.pnl < b.c.pnl ? a : b) : null;

  $('analytics-cards').innerHTML = [
    { label: '累計損益', val: fmtJpy(totalPnl), cls: totalPnl >= 0 ? 'c-pos' : 'c-neg' },
    { label: '最大利益取引', val: maxWin ? fmtJpy(maxWin.c.pnl) : '—', sub: maxWin?.t.ticker, cls: 'c-pos' },
    { label: '最大損失取引', val: maxLoss ? fmtJpy(maxLoss.c.pnl) : '—', sub: maxLoss?.t.ticker, cls: 'c-neg' },
    { label: 'NISA残枠', val: fmtJpy(NISA_LIMIT - calcNisaUsed()), sub: `${NISA_YEAR}年`, cls: 'c-acc' },
  ].map(c => `<div class="card"><div class="card-label">${c.label}</div><div class="card-val ${c.cls}">${c.val}</div>${c.sub ? `<div class="card-sub">${c.sub}</div>` : ''}</div>`).join('');

  drawWLPie(wins.length, losses.length);
  drawSectorBar(calcs);
}

function drawWLPie(w, l) {
  const cv = $('wl-canvas');
  const ctx = cv.getContext('2d');
  cv.width = cv.parentElement.clientWidth || 300;
  cv.height = 200;
  ctx.clearRect(0, 0, cv.width, cv.height);
  const total = w + l;
  if (total === 0) { ctx.fillStyle='#4a5568'; ctx.font='13px Zen Kaku Gothic New'; ctx.textAlign='center'; ctx.fillText('データなし', cv.width/2, cv.height/2); return; }
  const cx = cv.width/2, cy = cv.height/2 - 10, r = Math.min(cx, cy) - 16;
  const wAngle = (w/total) * Math.PI * 2;
  [[wAngle, '#34d399'], [Math.PI*2 - wAngle, '#f87171']].reduce((start, [angle, color]) => {
    ctx.beginPath(); ctx.moveTo(cx,cy); ctx.arc(cx,cy,r,start-Math.PI/2,start+angle-Math.PI/2); ctx.closePath();
    ctx.fillStyle = color; ctx.fill(); return start + angle;
  }, 0);
  ctx.beginPath(); ctx.arc(cx,cy,r*0.55,0,Math.PI*2); ctx.fillStyle='#0e1117'; ctx.fill();
  ctx.fillStyle='#e2e8f0'; ctx.font='bold 15px DM Mono'; ctx.textAlign='center';
  ctx.fillText((w/total*100).toFixed(0)+'%', cx, cy+5);
  ctx.font='11px Zen Kaku Gothic New'; ctx.fillStyle='#4a5568';
  ctx.fillText(`${w}勝 ${l}敗`, cx, cy+20);
  // legend
  [[20,'#34d399','勝ち'], [70,'#f87171','負け']].forEach(([x, c, label]) => {
    ctx.fillStyle=c; ctx.fillRect(x, cv.height-22, 10, 10);
    ctx.fillStyle='#94a3b8'; ctx.textAlign='left'; ctx.font='11px Zen Kaku Gothic New';
    ctx.fillText(label, x+14, cv.height-13);
  });
}

function drawSectorBar(calcs) {
  const cv = $('sector-canvas');
  const ctx = cv.getContext('2d');
  cv.width = cv.parentElement.clientWidth || 300;
  cv.height = 200;
  ctx.clearRect(0, 0, cv.width, cv.height);
  const closed = calcs.filter(x => x.c.pnl != null && x.t.sector);
  if (closed.length === 0) { ctx.fillStyle='#4a5568'; ctx.font='13px Zen Kaku Gothic New'; ctx.textAlign='center'; ctx.fillText('データなし', cv.width/2, cv.height/2); return; }
  const map = {};
  closed.forEach(x => { map[x.t.sector] = (map[x.t.sector]||0) + x.c.pnl; });
  const entries = Object.entries(map).sort((a,b) => b[1]-a[1]);
  const max = Math.max(...entries.map(e => Math.abs(e[1])));
  const barH = Math.min(20, (cv.height-20) / entries.length - 5);
  const midX = cv.width * 0.42;
  entries.forEach(([sec, pnl], i) => {
    const y = 10 + i*(barH+5);
    const bw = (Math.abs(pnl)/max) * (cv.width * 0.45);
    ctx.fillStyle = pnl >= 0 ? 'rgba(52,211,153,0.7)' : 'rgba(248,113,113,0.7)';
    ctx.fillRect(midX, y, pnl >= 0 ? bw : -bw, barH);
    ctx.fillStyle='#4a5568'; ctx.font=`${Math.min(11,barH)}px Zen Kaku Gothic New`; ctx.textAlign='right';
    ctx.fillText(sec.length>8?sec.substr(0,7)+'…':sec, midX-5, y+barH*0.75);
    ctx.fillStyle = pnl>=0?'#34d399':'#f87171'; ctx.textAlign='left';
    ctx.fillText((pnl>=0?'+':'')+(pnl/10000).toFixed(0)+'万', midX+(pnl>=0?bw+4:4), y+barH*0.75);
  });
}

// ==================== CSV EXPORT ====================
$('btn-export').addEventListener('click', () => {
  const headers = ['ティッカー','銘柄名','口座','セクター','戦略','エントリー日','株数','買値(USD)','エントリー時FX','買値(JPY)','投資総額(JPY)','手数料(JPY)','PER','予想PER','受渡日','エントリー理由','損切価格(USD)','目標価格(USD)','ステータス','決済済株数','損益(JPY)','損益率(%)','メモ'];
  const rows = positions.map(t => {
    const c = calcTrade(t);
    return [
      t.ticker, t.name, t.account, t.sector, t.strategy, t.entryDate, t.shares, t.entryPrice, t.entryFx, t.entryJpy?.toFixed(0), t.totalCost?.toFixed(0), t.commission,
      t.per, t.perFwd, t.deliveryDate, t.entryReason, t.stopLoss, t.takeProfit,
      c.status, c.totalExitShares, c.pnl?.toFixed(0), c.pnlPct?.toFixed(2), t.note
    ].map(v => v==null?'':'"'+String(v).replace(/"/g,'""')+'"').join(',');
  });
  const blob = new Blob(['\uFEFF'+[headers.join(','),...rows].join('\n')], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `tradelog_${new Date().toISOString().slice(0,10)}.csv`; a.click();
  toast('CSVを出力しました', 'success');
});

// ==================== NOTION CSV IMPORT ====================
$('btn-import').addEventListener('click', () => $('import-modal').classList.add('open'));
$('btn-close-import').addEventListener('click', () => $('import-modal').classList.remove('open'));

const dropZone = $('drop-zone');
dropZone.addEventListener('click', () => $('csv-file-input').click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('drag'); handleCSV(e.dataTransfer.files[0]); });
$('csv-file-input').addEventListener('change', e => { handleCSV(e.target.files[0]); e.target.value=''; });

async function handleCSV(file) {
  if (!file) return;
  const text = await file.text();
  const lines = text.split('\n').filter(l => l.trim());
  const headers = lines[0].split(',').map(h => h.replace(/^["']|["']$/g,'').trim());

  // Notionのカラム名マッピング
  const map = {
    ticker: ['ティッカー','Ticker','ticker','銘柄'],
    entryDate: ['エントリー','エントリー日','Entry Date','entry_date'],
    entryPrice: ['取得単価（ドル）','取得単価(ドル)','取得単価','Entry Price','entry_price','買値'],
    shares: ['取得株数','株数','Shares','shares'],
    per: ['PER','per'],
    perFwd: ['予想PER','予想per','Forward PER'],
    exitDate: ['クローズ','決済日','Exit Date','exit_date'],
    exitShares: ['売却株数','Exit Shares'],
    note: ['備考','メモ','Note','note'],
    pnl: ['損益（円）','損益(円)','損益','PnL'],
    deliveryDate: ['受渡日','Delivery Date'],
    totalCost: ['投資元本（円）','投資元本(円)','投資元本','投資総額'],
  };

  const getIdx = aliases => {
    for (const a of aliases) {
      const idx = headers.findIndex(h => h === a || h.includes(a));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const idxMap = {};
  Object.entries(map).forEach(([key, aliases]) => { idxMap[key] = getIdx(aliases); });

  const parseRow = line => {
    const cols = [];
    let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; } else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; } else { cur += ch; }
    }
    cols.push(cur.trim());
    return cols;
  };

  const trades = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseRow(lines[i]);
    const get = key => idxMap[key] !== -1 ? (cols[idxMap[key]]||'').replace(/^["']|["']$/g,'').trim() : '';
    const ticker = get('ticker').toUpperCase();
    if (!ticker) continue;
    const entryPrice = parseFloat(get('entryPrice')) || null;
    const shares = parseInt(get('shares')) || null;
    const entryDate = formatNotionDate(get('entryDate'));
    const exitDate = formatNotionDate(get('exitDate'));
    const exitPrice = null; // Notionには売値(USD)がないためスキップ
    const exitShares = parseInt(get('exitShares')) || null;
    const pnlJpy = parseFloat(get('pnl').replace(/[¥,]/g,'')) || null;
    const totalCost = parseFloat(get('totalCost').replace(/[¥,]/g,'')) || null;

    const trade = {
      ticker,
      name: '',
      entryDate: entryDate || '',
      entryPrice: entryPrice || 0,
      shares: shares || 0,
      entryFx: fxRate,
      entryJpy: entryPrice ? entryPrice * fxRate : 0,
      totalCost: totalCost || (entryPrice && shares ? Math.round(entryPrice * fxRate * shares) : 0),
      commission: 0,
      account: 'nisa',
      per: parseFloat(get('per')) || null,
      perFwd: parseFloat(get('perFwd')) || null,
      deliveryDate: formatNotionDate(get('deliveryDate')) || null,
      note: get('note'),
      exits: [],
      uid: currentUser.uid,
      importedFromNotion: true,
    };

    // 決済情報があれば追加
    if (exitDate && exitShares) {
      const costOfSold = trade.totalCost * exitShares / trade.shares;
      trade.exits = [{
        exitDate,
        shares: exitShares,
        exitPrice: null,
        exitFx: fxRate,
        pnl: pnlJpy || 0,
        pnlPct: pnlJpy && costOfSold ? (pnlJpy / costOfSold) * 100 : 0,
        reason: '',
      }];
    }
    trades.push(trade);
  }

  if (trades.length === 0) { toast('取り込めるデータがありませんでした', 'error'); return; }
  $('import-preview').innerHTML = `<div style="color:var(--text2); margin-bottom:12px">${trades.length}件のデータを取り込みます</div>` +
    trades.slice(0,5).map(t => `<div class="exit-row"><span class="ticker-pill">${t.ticker}</span><span class="mono">${t.entryDate}</span><span class="mono">${fmt(t.shares)}株 @ $${t.entryPrice}</span></div>`).join('') +
    (trades.length > 5 ? `<div style="color:var(--muted);font-size:12px;margin-top:8px">...他${trades.length-5}件</div>` : '');
  $('btn-confirm-import').onclick = async () => {
    for (const t of trades) {
      await addDoc(collection(db, 'tradelog'), { ...t, createdAt: serverTimestamp() });
    }
    toast(`${trades.length}件取り込みました`, 'success');
    $('import-modal').classList.remove('open');
  };
  $('btn-confirm-import').style.display = 'inline-flex';
}

function formatNotionDate(str) {
  if (!str) return null;
  // YYYY/MM/DD → YYYY-MM-DD
  const m = str.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  return null;
}

// ==================== FILTERS ====================
['search-input','filter-status','filter-result','filter-account'].forEach(id => {
  $(id) && $(id).addEventListener('change', renderTrades);
  $(id) && $(id).addEventListener('input', renderTrades);
});

// FX auto-fetch on load
fetchFxRate();
