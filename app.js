/**
 * Midday Cravings Refreshment House — cashier order app
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
const LS_CASHIERS_CACHE = 'mc_cashiers_cache_v1';
const LS_CASHIERS_UPDATED = 'mc_cashiers_updated_v1';
const LS_SESSION = 'mc_cashier_session_v1'; // { name, loginAt }

const AUTO_LOGOUT_HOUR = 22; // 10:00 PM, local device time

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
function loadCashiers() {
  try { return JSON.parse(localStorage.getItem(LS_CASHIERS_CACHE) || '[]'); }
  catch (e) { return []; }
}
function saveCashiers(list) {
  localStorage.setItem(LS_CASHIERS_CACHE, JSON.stringify(list));
  localStorage.setItem(LS_CASHIERS_UPDATED, new Date().toISOString());
}
function loadSession() {
  try { return JSON.parse(localStorage.getItem(LS_SESSION) || 'null'); }
  catch (e) { return null; }
}
function saveSession(session) {
  if (session) localStorage.setItem(LS_SESSION, JSON.stringify(session));
  else localStorage.removeItem(LS_SESSION);
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
// Minutes between two 'HH:MM' strings, handling an order confirmed before
// midnight and released after. Returns null if either is missing/bad.
function turnaroundMinutes(timeOrdered, timeReceived) {
  if (!timeOrdered || !timeReceived) return null;
  const toMinutes = (t) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(t));
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const a = toMinutes(timeOrdered);
  const b = toMinutes(timeReceived);
  if (a === null || b === null) return null;
  let diff = b - a;
  if (diff < 0) diff += 1440;
  return diff;
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
  wireLoginScreen();

  state.menu = loadMenu();
  renderMenu();
  renderMenuStatus();

  updateOnlineStatus();
  window.addEventListener('online', () => {
    updateOnlineStatus();
    refreshMenu();
    refreshCashiers();
    syncQueue();
  });
  window.addEventListener('offline', updateOnlineStatus);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkAutoLogout();
  });

  refreshMenu();     // best-effort, no-op if offline
  refreshCashiers();  // best-effort, no-op if offline
  syncQueue();        // best-effort
  setInterval(() => { syncQueue(); checkAutoLogout(); }, 60000); // every minute

  renderQueueTab();

  if (isLoggedIn()) {
    showLoggedInUI();
  } else {
    document.getElementById('appShell').hidden = true;
    document.getElementById('loginScreen').hidden = false;
    renderLoginScreen();
  }
});

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
}

// ---------------------------------------------------------------------
// Cashier login
// ---------------------------------------------------------------------
let loginSelectedName = null;

function wireLoginScreen() {
  document.getElementById('loginBtn').addEventListener('click', attemptLogin);
  document.getElementById('loginPin').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') attemptLogin();
  });
}

async function refreshCashiers() {
  if (!navigator.onLine) return;
  if (!CONFIG.API_URL || CONFIG.API_URL.startsWith('PASTE_')) return;
  try {
    const res = await fetch(CONFIG.API_URL + '?action=cashiers', { method: 'GET' });
    const data = await res.json();
    if (data.ok && Array.isArray(data.cashiers)) {
      saveCashiers(data.cashiers);
      if (!isLoggedIn()) renderLoginScreen();
    }
  } catch (e) {
    // offline or unreachable — keep using whatever's cached
  }
}

function renderLoginScreen() {
  const cashiers = loadCashiers();
  const list = document.getElementById('loginCashierList');
  const pinField = document.getElementById('loginPinField');
  const err = document.getElementById('loginError');
  err.hidden = true;
  pinField.hidden = true;
  loginSelectedName = null;

  if (!cashiers.length) {
    list.innerHTML = '<p class="muted small">No cashier list loaded yet. Connect this device to the internet once, then reopen the app.</p>';
    return;
  }
  list.innerHTML = cashiers.map(c =>
    `<button type="button" class="choice-btn login-name-btn" data-name="${escapeHtml(c.name)}">${escapeHtml(c.name)}</button>`
  ).join('');
  list.querySelectorAll('.login-name-btn').forEach(btn => {
    btn.addEventListener('click', () => selectLoginName(btn.dataset.name));
  });
}

function selectLoginName(name) {
  loginSelectedName = name;
  document.querySelectorAll('.login-name-btn').forEach(b => b.classList.toggle('selected', b.dataset.name === name));
  const pinField = document.getElementById('loginPinField');
  pinField.hidden = false;
  const pinInput = document.getElementById('loginPin');
  pinInput.value = '';
  pinInput.focus();
}

function attemptLogin() {
  const err = document.getElementById('loginError');
  err.hidden = true;
  if (!loginSelectedName) {
    err.textContent = 'Pick your name first.';
    err.hidden = false;
    return;
  }
  const pin = document.getElementById('loginPin').value.trim();
  if (!pin) {
    err.textContent = 'Enter your PIN.';
    err.hidden = false;
    return;
  }
  const cashiers = loadCashiers();
  const match = cashiers.find(c => c.name === loginSelectedName);
  if (!match || String(match.pin || '') !== pin) {
    err.textContent = 'Wrong PIN. Try again.';
    err.hidden = false;
    return;
  }
  saveSession({ name: loginSelectedName, loginAt: new Date().toISOString() });
  showLoggedInUI();
}

function logout() {
  saveSession(null);
  document.getElementById('appShell').hidden = true;
  document.getElementById('loginScreen').hidden = false;
  renderLoginScreen();
}

function showLoggedInUI() {
  document.getElementById('loginScreen').hidden = true;
  document.getElementById('appShell').hidden = false;
  const session = loadSession();
  const name = session ? session.name : '';
  document.getElementById('cashierBadge').textContent = name ? ('On duty: ' + name) : '';
  document.getElementById('cashierDisplayNameSettings').textContent = name;
}

// A session is valid until the next 10:00 PM boundary after it started —
// log in at 3pm, logged out at 10pm that night; log in at 11pm, logged out
// at 10pm the *next* night.
function nextLogoutBoundary(loginAtIso) {
  const from = new Date(loginAtIso);
  const boundary = new Date(from.getFullYear(), from.getMonth(), from.getDate(), AUTO_LOGOUT_HOUR, 0, 0, 0);
  if (from.getTime() >= boundary.getTime()) {
    boundary.setDate(boundary.getDate() + 1);
  }
  return boundary;
}

function isLoggedIn() {
  const session = loadSession();
  if (!session) return false;
  const boundary = nextLogoutBoundary(session.loginAt);
  if (Date.now() >= boundary.getTime()) {
    saveSession(null);
    return false;
  }
  return true;
}

function checkAutoLogout() {
  if (!loadSession()) return;
  if (!isLoggedIn()) {
    document.getElementById('appShell').hidden = true;
    document.getElementById('loginScreen').hidden = false;
    renderLoginScreen();
    showToast('Logged out automatically at 10:00 PM');
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
  }
  if (!line) return;

  line.qty = Math.max(0, line.qty + delta);
  if (line.qty === 0) {
    state.lines = state.lines.filter(l => l.itemId !== itemId);
  }
  renderMenu();
  renderOrderLines();
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

  document.getElementById('saveOrderBtn').addEventListener('click', saveOrder);
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
    // Time ordered is captured right now, at the moment the order is
    // confirmed — not earlier while items were still being added.
    date = todayStr();
    timeOrdered = nowTimeStr();
    timeReceived = ''; // marked later from the Orders tab, once it's handed over
  }

  const session = loadSession();

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
    cashier: session ? session.name : '',
    source: state.backfill ? 'backfill' : 'live',
    savedAt: new Date().toISOString(),
    status: 'pending',
  };

  const queue = loadQueue();
  queue.push(order);
  saveQueue(queue);

  resetOrderForm();
  showToast('Order confirmed' + (navigator.onLine ? ' — syncing…' : ' — will sync when online') +
    '. You can start the next order now.');
  renderQueueTab();
  syncQueue();
}

function resetOrderForm() {
  state.lines = [];
  state.refNumber = '';
  document.getElementById('refNumber').value = '';
  renderMenu();
  renderOrderLines();
  updateSaveButton();

  if (state.backfill) {
    document.getElementById('backfillTimeOrdered').value = nowTimeStr();
    document.getElementById('backfillTimeReceived').value = '';
  }
}

// ---------------------------------------------------------------------
// Queue / sync / release
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
        if (r && (r.status === 'ok' || r.status === 'duplicate' || r.status === 'updated')) {
          return { ...o, status: 'synced', orderId: r.orderId || o.orderId };
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

// Cashier taps "Mark as released" for an order that's still being
// prepared. This works whether the order has synced yet or not — it just
// stamps the release time locally and (re-)queues it for sync. If the
// order already made it to the sheet, the backend updates that same row
// instead of creating a new one.
function markReleased(clientOrderId) {
  const queue = loadQueue();
  const order = queue.find(o => o.clientOrderId === clientOrderId);
  if (!order || order.timeReceived) return;
  order.timeReceived = nowTimeStr();
  order.status = 'pending';
  saveQueue(queue);
  renderQueueTab();
  showToast('Marked released' + (navigator.onLine ? ' — syncing…' : ' — will sync when online'));
  syncQueue();
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
    const released = !!o.timeReceived;
    const turnaround = released ? turnaroundMinutes(o.timeOrdered, o.timeReceived) : null;
    return `<div class="queue-item">
      <div class="qi-top">
        <span>${escapeHtml(o.date)} ${escapeHtml(o.timeOrdered || '')}</span>
        <span class="qi-status ${o.status}">${o.status}</span>
      </div>
      <div>${escapeHtml(itemsSummary)}</div>
      <div class="muted small">${escapeHtml(o.orderType)} · ${escapeHtml(o.paymentMode)}${o.refNumber ? ' · ' + escapeHtml(o.refNumber) : ''} · ${fmtMoney(o.total)}${o.source === 'backfill' ? ' · backfill' : ''}${o.cashier ? ' · ' + escapeHtml(o.cashier) : ''}</div>
      ${released
        ? `<div class="qi-turnaround">Released ${escapeHtml(o.timeReceived)}${turnaround !== null ? ' · turnaround ' + turnaround + ' min' : ''}</div>`
        : `<button type="button" class="qi-mark-btn" data-client-id="${escapeHtml(o.clientOrderId)}">Mark as released</button>`
      }
    </div>`;
  }).join('');

  list.querySelectorAll('.qi-mark-btn').forEach(btn => {
    btn.addEventListener('click', () => markReleased(btn.dataset.clientId));
  });
}

// ---------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------
function wireSettingsTab() {
  document.getElementById('logoutBtn').addEventListener('click', logout);
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
 
