/**
 * Midday Cravings and Refreshment House — cashier order app
 * Works fully offline: everything is saved to localStorage on this device
 * and synced to the Google Sheet in the background whenever the app can
 * reach the internet.
 */

// ---------------------------------------------------------------------
// Storage helpers (localStorage — simple, synchronous, durable enough
// for a single till's daily order volume)
// ---------------------------------------------------------------------
const LS_QUEUE = 'mc_orders_queue_v1';
const LS_MENU = 'mc_menu_cache_v1';
const LS_MENU_UPDATED = 'mc_menu_updated_v1';
const LS_CASHIER = 'mc_cashier_name_v1';

function loadQueue() {
  try { return JSON.parse(localStorage.getItem(LS_QUEUE) || '[]'); }
  catch (e) { return []; }
}
function saveQueue(queue) {
  localStorage.setItem(LS_QUEUE, JSON.stringify(queue));
}
function loadMenu() {
  try { return JSON.parse(localStorage.getItem(LS_MENU) || '[]'); }
  catch (e) { return []; }
}
function saveMenu(items) {
  localStorage.setItem(LS_MENU, JSON.stringify(items));
  localStorage.setItem(LS_MENU_UPDATED, new Date().toISOString());
}

function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function pad2(n) { return String(n).padStart(2, '0'); }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function nowTimeStr() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fmtMoney(n) {
  return '₱' + (Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------------
// App state (current, unsaved order)
// ---------------------------------------------------------------------
const state = {
  menu: [],
  orderType: 'Dine-in',
  paymentMode: 'Cash',
  refNumber: '',
  lines: [], // { itemId, name, unitPrice, qty }
  timeOrdered: null, // 'HH:MM', captured at first item add (live mode)
  timeReceived: null,
  backfill: false,
};

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  registerServiceWorker();
  wireTabs();
  wireOrderForm();
  wireQueueTab();
  wireSettingsTab();

  state.menu = loadMenu();
  renderMenu();
  renderMenuStatus();

  document.getElementById('cashierName').value = localStorage.getItem(LS_CASHIER) || '';

  updateOnlineStatus();
  window.addEventListener('online', () => { updateOnlineStatus(); refreshMenu(); syncQueue(); });
  window.addEventListener('offline', updateOnlineStatus);

  refreshMenu(); // best-effort, no-op if offline
  syncQueue();   // best-effort
  setInterval(syncQueue, 60000); // retry every minute while app is open

  renderQueueTab();
});

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
}

// ---------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------
function wireTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'queue') renderQueueTab();
    });
  });
}

// ---------------------------------------------------------------------
// Online status
// ---------------------------------------------------------------------
function updateOnlineStatus() {
  const pill = document.getElementById('statusPill');
  if (navigator.onLine) {
    pill.textContent = 'Online';
    pill.className = 'status-pill online';
  } else {
    pill.textContent = 'Offline — saving locally';
    pill.className = 'status-pill offline';
  }
}

// ---------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------
async function refreshMenu() {
  if (!navigator.onLine) return;
  if (!CONFIG.API_URL || CONFIG.API_URL.startsWith('PASTE_')) return;
  try {
    const res = await fetch(CONFIG.API_URL + '?action=menu', { method: 'GET' });
    const data = await res.json();
    if (data.ok && Array.isArray(data.items)) {
      state.menu = data.items;
      saveMenu(data.items);
      renderMenu();
      renderMenuStatus();
    }
  } catch (e) {
    // offline or unreachable — keep using cached menu
  }
}

function renderMenuStatus() {
  const el = document.getElementById('menuStatus');
  if (!el) return;
  const updated = localStorage.getItem(LS_MENU_UPDATED);
  const count = state.menu.length;
  el.textContent = updated
    ? `${count} item(s) cached — last refreshed ${new Date(updated).toLocaleString()}`
    : `${count} item(s) cached`;
}

function renderMenu() {
  const container = document.getElementById('menuList');
  if (!state.menu.length) {
    container.innerHTML = '<p class="muted">No menu loaded yet. Connect to the internet once to download it — it will then work offline.</p>';
    return;
  }
  const active = state.menu.filter(i => i.active !== false);
  const byCategory = {};
  active.forEach(item => {
    const cat = item.category || 'Other';
    (byCategory[cat] = byCategory[cat] || []).push(item);
  });

  let html = '';
  Object.keys(byCategory).sort().forEach(cat => {
    html += `<div class="menu-category">${escapeHtml(cat)}</div>`;
    byCategory[cat].forEach(item => {
      const line = state.lines.find(l => l.itemId === item.itemId);
      const qty = line ? line.qty : 0;
      const hasPrice = item.price !== null && item.price !== undefined;
      html += `
        <div class="menu-item" data-item-id="${escapeHtml(item.itemId)}">
          <div>
            <div class="menu-item-name">${escapeHtml(item.name)}</div>
            <div class="menu-item-price ${hasPrice ? '' : 'unset'}">
              ${hasPrice ? fmtMoney(item.price) : 'No price set — you\'ll enter it'}
            </div>
          </div>
          <div class="qty-stepper">
            <button type="button" class="qty-minus">−</button>
            <span>${qty}</span>
            <button type="button" class="qty-plus">+</button>
          </div>
        </div>`;
    });
  });
  container.innerHTML = html;

  container.querySelectorAll('.qty-plus').forEach(btn => {
    btn.addEventListener('click', () => {
      const itemId = btn.closest('.menu-item').dataset.itemId;
      addQty(itemId, 1);
    });
  });
  container.querySelectorAll('.qty-minus').forEach(btn => {
    btn.addEventListener('click', () => {
      const itemId = btn.closest('.menu-item').dataset.itemId;
      addQty(itemId, -1);
    });
  });
}

function addQty(itemId, delta) {
  const item = state.menu.find(i => i.itemId === itemId);
  if (!item) return;
  let line = state.lines.find(l => l.itemId === itemId);

  if (!line && delta > 0) {
    let unitPrice = item.price;
    if (unitPrice === null || unitPrice === undefined) {
      const typed = prompt(`No price is set yet for "${item.name}". Enter the price for this sale (₱):`);
      const num = parseFloat(typed);
      if (isNaN(num) || num < 0) return; // cancelled or invalid
      unitPrice = num;
    }
    line = { itemId: item.itemId, name: item.name, unitPrice, qty: 0 };
    state.lines.push(line);
    if (!state.timeOrdered && !state.backfill) {
      state.timeOrdered = nowTimeStr();
    }
  }
  if (!line) return;

  line.qty = Math.max(0, line.qty + delta);
  if (line.qty === 0) {
    state.lines = state.lines.filter(l => l.itemId !== itemId);
  }
  renderMenu();
  renderOrderLines();
  renderFulfillment();
  updateSaveButton();
}

function renderOrderLines() {
  const card = document.getElementById('orderLinesCard');
  const container = document.getElementById('orderLines');
  if (!state.lines.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  let total = 0;
  container.innerHTML = state.lines.map(l => {
    const lineTotal = l.unitPrice * l.qty;
    total += lineTotal;
    return `<div class="order-line">
      <span class="ol-name">${l.qty}× ${escapeHtml(l.name)}</span>
      <span>${fmtMoney(lineTotal)}</span>
    </div>`;
  }).join('');
  document.getElementById('orderTotal').textContent = fmtMoney(total);
}

function currentTotal() {
  return state.lines.reduce((sum, l) => sum + l.unitPrice * l.qty, 0);
}

// ---------------------------------------------------------------------
// Order form wiring
// ---------------------------------------------------------------------
function wireOrderForm() {
  document.getElementById('backfillToggle').addEventListener('change', (e) => {
    state.backfill = e.target.checked;
    document.getElementById('backfillFields').hidden = !state.backfill;
    if (state.backfill) {
      document.getElementById('backfillDate').value = todayStr();
      document.getElementById('backfillTimeOrdered').value = nowTimeStr();
      document.getElementById('backfillTimeReceived').value = '';
    }
    renderFulfillment();
  });

  document.querySelectorAll('#orderTypeGroup .choice-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#orderTypeGroup .choice-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      state.orderType = btn.dataset.value;
    });
  });

  document.querySelectorAll('#paymentGroup .choice-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#paymentGroup .choice-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      state.paymentMode = btn.dataset.value;
      const refField = document.getElementById('refNumberField');
      refField.hidden = (state.paymentMode === 'Cash');
    });
  });

  document.getElementById('refNumber').addEventListener('input', (e) => {
    state.refNumber = e.target.value;
  });

  document.getElementById('markReceivedBtn').addEventListener('click', () => {
    state.timeReceived = nowTimeStr();
    renderFulfillment();
  });

  document.getElementById('saveOrderBtn').addEventListener('click', saveOrder);

  renderFulfillment();
}

function renderFulfillment() {
  const orderedEl = document.getElementById('timeOrderedDisplay');
  const receivedEl = document.getElementById('timeReceivedDisplay');
  const receivedCard = document.getElementById('receivedCard');

  if (state.backfill) {
    receivedCard.hidden = true; // handled via the backfill date/time fields instead
    return;
  }
  receivedCard.hidden = false;
  orderedEl.textContent = state.timeOrdered
    ? `Time ordered: ${state.timeOrdered} (auto-captured when you added the first item)`
    : 'Time ordered: will be captured when you add the first item';
  receivedEl.textContent = state.timeReceived
    ? `Time received: ${state.timeReceived}`
    : 'Not marked received yet';
}

function updateSaveButton() {
  const btn = document.getElementById('saveOrderBtn');
  const hint = document.getElementById('saveOrderHint');
  const ok = state.lines.length > 0;
  btn.disabled = !ok;
  hint.hidden = ok;
}

function saveOrder() {
  if (!state.lines.length) return;

  let date, timeOrdered, timeReceived;
  if (state.backfill) {
    date = document.getElementById('backfillDate').value || todayStr();
    timeOrdered = document.getElementById('backfillTimeOrdered').value || '';
    timeReceived = document.getElementById('backfillTimeReceived').value || '';
  } else {
    date = todayStr();
    timeOrdered = state.timeOrdered || nowTimeStr();
    timeReceived = state.timeReceived || '';
  }

  const order = {
    clientOrderId: uuid(),
    date, timeOrdered, timeReceived,
    orderType: state.orderType,
    paymentMode: state.paymentMode,
    refNumber: state.paymentMode === 'Cash' ? '' : (state.refNumber || ''),
    total: currentTotal(),
    lines: state.lines.map(l => ({
      itemName: l.name, unitPrice: l.unitPrice, qty: l.qty, lineTotal: l.unitPrice * l.qty,
    })),
    cashier: localStorage.getItem(LS_CASHIER) || '',
    source: state.backfill ? 'backfill' : 'live',
    savedAt: new Date().toISOString(),
    status: 'pending',
  };

  const queue = loadQueue();
  queue.push(order);
  saveQueue(queue);

  resetOrderForm();
  showToast('Order saved' + (navigator.onLine ? ' — syncing…' : ' — will sync when online'));
  renderQueueTab();
  syncQueue();
}

function resetOrderForm() {
  state.lines = [];
  state.timeOrdered = null;
  state.timeReceived = null;
  state.refNumber = '';
  document.getElementById('refNumber').value = '';
  renderMenu();
  renderOrderLines();
  renderFulfillment();
  updateSaveButton();

  if (state.backfill) {
    document.getElementById('backfillTimeOrdered').value = nowTimeStr();
    document.getElementById('backfillTimeReceived').value = '';
  }
}

// ---------------------------------------------------------------------
// Queue / sync
// ---------------------------------------------------------------------
let syncing = false;

async function syncQueue() {
  if (syncing) return;
  if (!navigator.onLine) return;
  if (!CONFIG.API_URL || CONFIG.API_URL.startsWith('PASTE_')) return;

  const queue = loadQueue();
  const pending = queue.filter(o => o.status !== 'synced');
  if (!pending.length) return;

  syncing = true;
  try {
    const res = await fetch(CONFIG.API_URL, {
      method: 'POST',
      // text/plain avoids a CORS preflight that Apps Script can't answer.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'syncOrders', orders: pending }),
    });
    const data = await res.json();
    if (data.ok && Array.isArray(data.results)) {
      const byId = {};
      data.results.forEach(r => { byId[r.clientOrderId] = r; });
      const updated = queue.map(o => {
        const r = byId[o.clientOrderId];
        if (r && (r.status === 'ok' || r.status === 'duplicate')) {
          return { ...o, status: 'synced', orderId: r.orderId };
        }
        if (r && r.status === 'error') {
          return { ...o, status: 'error', error: r.error };
        }
        return o;
      });
      saveQueue(updated);
      renderQueueTab();
    }
  } catch (e) {
    // stays pending, will retry
  } finally {
    syncing = false;
  }
}

function wireQueueTab() {
  document.getElementById('syncNowBtn').addEventListener('click', () => {
    showToast(navigator.onLine ? 'Syncing…' : 'You are offline — will sync automatically once connected');
    syncQueue();
  });
}

function renderQueueTab() {
  const queue = loadQueue().slice().reverse(); // newest first
  const pendingCount = queue.filter(o => o.status !== 'synced').length;

  const badge = document.getElementById('pendingBadge');
  if (pendingCount > 0) {
    badge.hidden = false;
    badge.textContent = pendingCount;
  } else {
    badge.hidden = true;
  }

  document.getElementById('queueSummary').textContent =
    `${queue.length} order(s) saved on this device — ${pendingCount} waiting to sync.`;

  const list = document.getElementById('queueList');
  if (!queue.length) {
    list.innerHTML = '<p class="muted small">No orders saved yet.</p>';
    return;
  }
  list.innerHTML = queue.map(o => {
    const itemsSummary = o.lines.map(l => `${l.qty}× ${l.itemName}`).join(', ');
    return `<div class="queue-item">
      <div class="qi-top">
        <span>${escapeHtml(o.date)} ${escapeHtml(o.timeOrdered || '')}</span>
        <span class="qi-status ${o.status}">${o.status}</span>
      </div>
      <div>${escapeHtml(itemsSummary)}</div>
      <div class="muted small">${escapeHtml(o.orderType)} · ${escapeHtml(o.paymentMode)}${o.refNumber ? ' · ' + escapeHtml(o.refNumber) : ''} · ${fmtMoney(o.total)}${o.source === 'backfill' ? ' · backfill' : ''}</div>
    </div>`;
  }).join('');
}

// ---------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------
function wireSettingsTab() {
  document.getElementById('cashierName').addEventListener('change', (e) => {
    localStorage.setItem(LS_CASHIER, e.target.value.trim());
  });
  document.getElementById('refreshMenuBtn').addEventListener('click', () => {
    showToast('Refreshing menu…');
    refreshMenu();
  });
}

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.hidden = true; }, 2500);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
