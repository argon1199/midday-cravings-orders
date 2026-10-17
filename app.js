/* Midday Cravings — cashier order log.
 *
 * One frontend, two interchangeable backends (Google Apps Script and the local MVP
 * server). The only thing that differs between them is API_URL in config.js — if this
 * file ever needs to branch on which backend it is talking to, the API contract has
 * been broken and the backend is what should change.
 *
 * Security note: cashier PINs are fetched and cached in localStorage in plaintext so
 * that login works with no connectivity. This is deliberate. The PIN is a duty log —
 * it records who rang up an order on a single shared till — and is not a defence for
 * anything sensitive. Do not put anything behind it that actually needs protecting.
 */
'use strict';

const CFG = window.APP_CONFIG || {};
const API_URL = (CFG.API_URL || '').replace(/\/$/, '');
const LOGOUT_HOUR = Number.isFinite(CFG.LOGOUT_HOUR) ? CFG.LOGOUT_HOUR : 22;
const SYNC_INTERVAL_MS = 60000;

const KEY = {
  session: 'mc.session',
  orders: 'mc.orders',
  menu: 'mc.menu',
  cashiers: 'mc.cashiers',
  discounts: 'mc.discounts',
  shift: 'mc.shift',
  shifts: 'mc.shifts',
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));

const state = {
  session: load(KEY.session, null),
  orders: load(KEY.orders, []),
  menu: load(KEY.menu, []),
  cashiers: load(KEY.cashiers, []),
  discounts: load(KEY.discounts, []),
  shift: load(KEY.shift, null), // the open shift: { date, no, openedAt }
  shifts: load(KEY.shifts, []), // closed shifts (turnover records), queued for sync
  closing: false,
  closeError: '',
  cart: {},
  customPrice: {},
  orderType: 'Dine-in',
  paymentMode: 'Cash',
  discountId: '',
  backfill: false,
  tab: 'new',
  loginPick: null,
  cancelling: null,
  cancelError: '',
};

// One-time carry-over from the old app (GitHub Pages before 2026-10-17), so its
// unsent orders still get sent. The old list is kept as a spare copy.
if (!localStorage.getItem('mc.migratedV1')) {
  const have = new Set(state.orders.map((o) => o.clientOrderId));
  const old = load('mc_orders_queue_v1', []);
  for (const x of Array.isArray(old) ? old : []) {
    if (!x || !x.clientOrderId || have.has(x.clientOrderId)) continue;
    const { error, ...o } = x;
    state.orders.push({ ...o, shiftId: o.shiftId || '', ...(error ? { syncError: error } : {}) });
  }
  save(KEY.orders, state.orders);
  localStorage.setItem('mc.migratedV1', '1');
}

// ---------------------------------------------------------------- utilities

const pad2 = (n) => String(n).padStart(2, '0');
const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const nowTime = (d = new Date()) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const round2 = (n) => Math.round(n * 100) / 100;
const peso = (n) => `₱${Number(n || 0).toFixed(2)}`;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function turnaroundMin(timeOrdered, timeReceived) {
  if (!timeOrdered || !timeReceived) return null;
  const [h1, m1] = timeOrdered.split(':').map(Number);
  const [h2, m2] = timeReceived.split(':').map(Number);
  let diff = h2 * 60 + m2 - (h1 * 60 + m1);
  if (diff < 0) diff += 24 * 60; // spanned midnight
  return diff;
}

// ---------------------------------------------------------------- api + sync

const apiGet = (action) =>
  fetch(`${API_URL}?action=${encodeURIComponent(action)}`).then((r) => r.json());

const apiPost = (body) =>
  fetch(API_URL, {
    method: 'POST',
    // text/plain, not application/json: an Apps Script Web App cannot answer a CORS
    // preflight, and a JSON content-type would trigger one.
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

function toPayload(o) {
  const { orderId, syncError, ...payload } = o;
  return payload;
}

let syncing = false;

async function syncNow() {
  await syncOrderQueue();
  await syncShiftQueue();
}

async function syncShiftQueue() {
  if (syncingShifts || !API_URL) return;
  const queue = state.shifts.filter((s) => s.status !== 'synced');
  if (!queue.length) return;

  syncingShifts = true;
  try {
    const res = await apiPost({ action: 'syncShifts', shifts: queue.map(({ status, syncError, ...s }) => s) });
    if (!res || !res.ok) return;
    const byId = new Map(res.results.map((r) => [r.shiftId, r]));
    for (const s of state.shifts) {
      const r = byId.get(s.shiftId);
      if (!r) continue;
      s.status = r.status === 'error' ? 'error' : 'synced';
      s.syncError = r.status === 'error' ? r.error || 'The records rejected this shift.' : '';
    }
    save(KEY.shifts, state.shifts);
    render();
  } catch {
    // No signal. Retried on the next tick.
  } finally {
    syncingShifts = false;
    renderNetPill();
  }
}

let syncingShifts = false;

async function syncOrderQueue() {
  if (syncing || !API_URL) return;
  const queue = state.orders.filter((o) => o.status !== 'synced');
  if (!queue.length) return;

  syncing = true;
  try {
    const res = await apiPost({ action: 'syncOrders', orders: queue.map(toPayload) });
    if (!res || !res.ok) return;
    const byId = new Map(res.results.map((r) => [r.clientOrderId, r]));
    for (const o of state.orders) {
      const r = byId.get(o.clientOrderId);
      if (!r) continue;
      if (r.status === 'error') {
        o.status = 'error';
        o.syncError = r.error || 'The records rejected this order.';
      } else {
        o.status = 'synced';
        o.syncError = '';
        if (r.orderId) o.orderId = r.orderId;
      }
    }
    save(KEY.orders, state.orders);
    render();
  } catch {
    // No signal. Everything stays queued and is retried on the next tick.
  } finally {
    syncing = false;
    renderNetPill();
  }
}

async function refreshCaches() {
  if (!API_URL) return false;
  try {
    const [menu, cashiers, discounts] = await Promise.all([
      apiGet('menu'),
      apiGet('cashiers'),
      apiGet('discounts'),
    ]);
    if (menu.ok) save(KEY.menu, (state.menu = menu.items));
    if (cashiers.ok) save(KEY.cashiers, (state.cashiers = cashiers.cashiers));
    if (discounts.ok) save(KEY.discounts, (state.discounts = discounts.discounts));
    save('mc.cachedAt', new Date().toISOString());
    render();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- session

// A shift started before the cut-off ends at today's; one started after it ends at
// tomorrow's. Stops an unattended till from staying logged in overnight.
function sessionExpiry(now = new Date()) {
  const exp = new Date(now);
  exp.setHours(LOGOUT_HOUR, 0, 0, 0);
  if (exp.getTime() <= now.getTime()) exp.setDate(exp.getDate() + 1);
  return exp.getTime();
}

function attemptLogin() {
  const err = $('#login-error');
  const pin = $('#login-pin').value.trim();
  const showError = (msg) => {
    err.textContent = msg;
    err.hidden = false;
  };

  if (!state.loginPick) return showError('Tap your name first.');
  const match = state.cashiers.find((c) => c.name === state.loginPick);
  if (!match || String(match.pin) !== pin) return showError('That PIN does not match. Try again.');

  err.hidden = true;
  $('#login-pin').value = '';
  state.session = { cashier: match.name, startedAt: Date.now(), expiresAt: sessionExpiry() };
  save(KEY.session, state.session);
  render();
}

function logout() {
  state.session = null;
  state.loginPick = null;
  state.cart = {};
  state.customPrice = {};
  state.discountId = '';
  state.closing = false; // never hand a half-typed cash count to the next cashier
  state.closeError = '';
  localStorage.removeItem(KEY.session);
  render();
}

function checkSessionExpiry() {
  if (state.session && Date.now() >= state.session.expiresAt) logout();
}

// ---------------------------------------------------------------- shifts

// A shift stays open until a cashier closes it (turnover). Every order is stamped with
// the open shift's id, so an order rung up after a turnover belongs to the next shift.
// The id gets a short random tail (e.g. 2026-10-15-S1-a3f9) so a phone whose storage was
// wiped, or a second phone, cannot reuse an id that the Sheet already has.
const newShift = (date, no, openedAt) => ({ date, no, openedAt, id: `${date}-S${no}-${uuid().slice(0, 4)}` });

function ensureShift() {
  if (state.shift) return;
  state.shift = newShift(todayStr(), 1, new Date().toISOString());
  save(KEY.shift, state.shift);
}

const shiftId = (s) => s.id;

/** Sales split for a list of orders. Cancelled orders are left out, as on the Sheet. */
function sumOrders(list) {
  const t = { orders: 0, total: 0, cash: 0, gcash: 0, bank: 0 };
  for (const o of list) {
    if (o.cancelled) continue;
    t.orders += 1;
    t.total += o.total;
    if (o.paymentMode === 'Cash') t.cash += o.total;
    else if (o.paymentMode === 'GCash') t.gcash += o.total;
    else if (o.paymentMode === 'Bank Transfer') t.bank += o.total;
  }
  for (const k of ['total', 'cash', 'gcash', 'bank']) t[k] = round2(t[k]);
  return t;
}

// A closed shift's cash count is final, so its orders can no longer be cancelled.
const inClosedShift = (o) => Boolean(o.shiftId) && o.shiftId !== shiftId(state.shift);

const shiftOrders = () => state.orders.filter((o) => o.shiftId === shiftId(state.shift));

function closeShift() {
  const raw = $('#close-cash').value.trim();
  const counted = Number(raw);
  if (raw === '' || !Number.isFinite(counted) || counted < 0 || counted > 1e7) {
    state.closeError = 'Type the cash you counted in the till (type 0 if none).';
    return renderSummary();
  }
  const t = sumOrders(shiftOrders());
  const now = new Date();
  state.shifts.push({
    shiftId: shiftId(state.shift),
    date: state.shift.date,
    shiftNo: state.shift.no,
    closedBy: state.session.cashier,
    openedAt: `${state.shift.date} ${nowTime(new Date(state.shift.openedAt))}`,
    closedAt: `${todayStr(now)} ${nowTime(now)}`,
    ...t,
    cashCounted: round2(counted),
    overShort: round2(counted - t.cash),
    notes: $('#close-notes').value.trim(),
    status: 'pending',
  });
  save(KEY.shifts, state.shifts);

  // Next shift: same day continues the count, a new day starts again at 1.
  const today = todayStr(now);
  state.shift = newShift(today, state.shift.date === today ? state.shift.no + 1 : 1, now.toISOString());
  save(KEY.shift, state.shift);
  state.closing = false;
  state.closeError = '';
  render();
  syncNow();
}

// ---------------------------------------------------------------- order maths

function cartLines() {
  return state.menu
    .filter((m) => state.cart[m.itemId] > 0)
    .map((m) => {
      const qty = state.cart[m.itemId];
      const unitPrice = m.price === null ? state.customPrice[m.itemId] ?? null : m.price;
      return { itemName: m.name, unitPrice, qty, lineTotal: round2((unitPrice || 0) * qty) };
    });
}

const selectedDiscount = () => state.discounts.find((d) => d.id === state.discountId) || null;

function orderTotals() {
  const lines = cartLines();
  const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
  const d = selectedDiscount();
  const raw = !d ? 0 : d.type === 'Percent' ? subtotal * (d.value / 100) : d.value;
  const discountAmount = round2(Math.min(raw, subtotal));
  return { lines, subtotal, discount: d, discountAmount, total: round2(subtotal - discountAmount) };
}

/** Returns a human-readable reason the order cannot be confirmed, or '' if it can. */
function orderProblem() {
  const { lines } = orderTotals();
  if (!lines.length) return 'Add at least one item.';
  if (lines.some((l) => !l.unitPrice)) return 'Type a price for the item marked "no price set".';
  const d = selectedDiscount();
  if (d && d.requiresId && !$('#discount-ref').value.trim()) {
    return `${d.name} needs the customer's ID number before you can confirm.`;
  }
  if (state.backfill && (!$('#bf-date').value || !$('#bf-ordered').value)) {
    return 'Fill in the date and time ordered for a backfilled order.';
  }
  return '';
}

function confirmOrder() {
  if (orderProblem()) return;
  const { lines, subtotal, discount, discountAmount, total } = orderTotals();
  const now = new Date();
  const bf = state.backfill;

  state.orders.push({
    clientOrderId: uuid(),
    date: bf ? $('#bf-date').value : todayStr(now),
    timeOrdered: bf ? $('#bf-ordered').value : nowTime(now),
    timeReceived: bf ? $('#bf-received').value || '' : '',
    orderType: state.orderType,
    paymentMode: state.paymentMode,
    refNumber: $('#ref-number').value.trim(),
    subtotal,
    discountName: discount ? discount.name : '',
    discountAmount,
    discountRefId: discount && discount.requiresId ? $('#discount-ref').value.trim() : '',
    total,
    lines,
    cashier: state.session.cashier,
    source: bf ? 'backfill' : 'live',
    shiftId: bf ? '' : shiftId(state.shift), // a backfilled paper order is not part of any shift
    savedAt: now.toISOString(),
    status: 'pending',
    cancelled: false,
    cancelReason: '',
  });
  save(KEY.orders, state.orders);

  state.cart = {};
  state.customPrice = {};
  state.discountId = '';
  state.backfill = false;
  state.tab = 'orders';
  $('#ref-number').value = '';
  $('#discount-ref').value = '';
  $('#backfill-toggle').checked = false;

  render();
  syncNow();
}

function markReleased(clientOrderId) {
  const o = state.orders.find((x) => x.clientOrderId === clientOrderId);
  if (!o || o.timeReceived || o.cancelled) return;
  o.timeReceived = nowTime();
  o.status = 'pending';
  save(KEY.orders, state.orders);
  render();
  syncNow();
}

function cancelOrder(clientOrderId, reason) {
  const o = state.orders.find((x) => x.clientOrderId === clientOrderId);
  if (!o) return;
  if (!reason.trim()) {
    state.cancelError = 'Type a reason before cancelling.';
    return render();
  }
  if (inClosedShift(o)) {
    state.cancelError = 'This order belongs to a closed shift and can no longer be cancelled.';
    return render();
  }
  // Belt and braces: the server rejects this too, but never let the UI submit it.
  if (o.timeReceived) {
    state.cancelError = 'This order was already released and can no longer be cancelled.';
    return render();
  }
  o.cancelled = true;
  o.cancelReason = reason.trim();
  o.status = 'pending';
  save(KEY.orders, state.orders);
  state.cancelling = null;
  state.cancelError = '';
  render();
  syncNow();
}

// ---------------------------------------------------------------- rendering

function renderNetPill() {
  const pendingOrders = state.orders.filter((o) => o.status !== 'synced').length;
  const pending = pendingOrders + state.shifts.filter((s) => s.status !== 'synced').length;
  const pill = $('#net-pill');
  if (!navigator.onLine) {
    pill.textContent = pending ? `Offline · ${pending} waiting` : 'Offline';
  } else {
    pill.textContent = pending ? `${pending} waiting to send` : 'All sent';
  }
  $('#tab-orders-count').textContent = pendingOrders ? `(${pendingOrders})` : '';
}

function renderLogin() {
  const picker = $('#login-cashiers');
  if (!state.cashiers.length) {
    picker.innerHTML = '<p class="hint">No cashiers saved on this phone yet. Connect to the internet once so the app can download the staff list.</p>';
  } else {
    picker.innerHTML = state.cashiers
      .map(
        (c) =>
          `<button class="btn ${c.name === state.loginPick ? 'is-on' : ''}" data-action="pick-cashier" data-name="${esc(c.name)}">${esc(c.name)}</button>`
      )
      .join('');
  }
  $('#login-hint').textContent = API_URL
    ? 'Your PIN records who rang up each order.'
    : 'No backend address is configured — copy config.mvp.js or config.gsheet.js to config.js.';
}

function renderChips(sel, options, current, action) {
  $(sel).innerHTML = options
    .map(
      (o) =>
        `<button class="chip ${o.value === current ? 'is-on' : ''}" data-action="${action}" data-value="${esc(o.value)}">${esc(o.label)}</button>`
    )
    .join('');
}

function renderMenu() {
  const items = state.menu.filter((m) => m.active);
  if (!items.length) {
    $('#menu-list').innerHTML =
      '<div class="card"><p class="hint">No menu saved on this phone yet. Go to Settings and tap "Refresh menu now" while you have signal.</p></div>';
    return;
  }

  const byCategory = new Map();
  for (const m of items) {
    if (!byCategory.has(m.category)) byCategory.set(m.category, []);
    byCategory.get(m.category).push(m);
  }

  $('#menu-list').innerHTML = [...byCategory.entries()]
    .map(([category, rows]) => {
      const body = rows
        .map((m) => {
          const qty = state.cart[m.itemId] || 0;
          const typed = state.customPrice[m.itemId];
          const priceless = m.price === null;
          const canAdd = !priceless || Number(typed) > 0;
          const priceCell = priceless
            ? `<span class="flag-noprice">no price set</span>
               <input class="price-input" type="number" inputmode="decimal" min="0" step="0.01"
                      placeholder="₱ price" value="${typed ?? ''}" data-price-for="${esc(m.itemId)}">`
            : `<span class="price">${peso(m.price)}</span>`;
          return `<div class="menu-row">
            <div class="name"><strong>${esc(m.name)}</strong>${priceCell}</div>
            <div class="stepper">
              <button data-action="qty" data-item="${esc(m.itemId)}" data-delta="-1" ${qty ? '' : 'disabled'} aria-label="Remove one">−</button>
              <span class="qty">${qty}</span>
              <button data-action="qty" data-item="${esc(m.itemId)}" data-delta="1" ${canAdd ? '' : 'disabled'} aria-label="Add one">+</button>
            </div>
          </div>`;
        })
        .join('');
      return `<p class="cat-title">${esc(category)}</p><div class="card">${body}</div>`;
    })
    .join('');
}

function renderNewOrder() {
  renderChips('#order-type', [{ value: 'Dine-in', label: 'Dine-in' }, { value: 'Take-out', label: 'Take-out' }], state.orderType, 'pick-type');
  renderChips(
    '#payment-mode',
    ['Cash', 'GCash', 'Bank Transfer'].map((v) => ({ value: v, label: v })),
    state.paymentMode,
    'pick-payment'
  );
  $('#ref-field').hidden = state.paymentMode === 'Cash';

  $('#discount-card').hidden = state.discounts.length === 0;
  if (state.discounts.length) {
    renderChips(
      '#discount-picker',
      [{ value: '', label: 'None' }, ...state.discounts.map((d) => ({ value: d.id, label: d.name }))],
      state.discountId,
      'pick-discount'
    );
    const d = selectedDiscount();
    $('#discount-id-field').hidden = !(d && d.requiresId);
  }

  $('#backfill-fields').hidden = !state.backfill;
  renderMenu();

  const { lines, subtotal, discount, discountAmount, total } = orderTotals();
  $('#order-summary').innerHTML = !lines.length
    ? '<p class="hint">No items yet — tap + next to what the customer ordered.</p>'
    : `${lines
        .map((l) => `<div class="row"><span>${l.qty}× ${esc(l.itemName)}</span><span>${peso(l.lineTotal)}</span></div>`)
        .join('')}
       <div class="row"><span class="muted">Subtotal</span><span class="muted">${peso(subtotal)}</span></div>
       ${discount ? `<div class="row discount"><span>${esc(discount.name)}</span><span>−${peso(discountAmount)}</span></div>` : ''}
       <div class="row total"><span>Total</span><span>${peso(total)}</span></div>`;

  const problem = orderProblem();
  $('#confirm-order').disabled = Boolean(problem);
  const errEl = $('#confirm-error');
  errEl.hidden = !problem || !lines.length;
  errEl.textContent = problem;
}

function renderOrderCard(o) {
  const pill = `<span class="pill pill-${o.status}">${o.status === 'synced' ? 'Sent' : o.status === 'error' ? 'Problem' : 'Waiting'}</span>`;
  const items = o.lines.map((l) => `${l.qty}× ${esc(l.itemName)}`).join(', ');
  const ref = o.refNumber ? ` · ref ${esc(o.refNumber)}` : '';

  let stateLine = '';
  let actions = '';
  if (o.cancelled) {
    stateLine = `<p class="order-state cancelled">Cancelled — ${esc(o.cancelReason)}</p>`;
  } else if (o.timeReceived) {
    const mins = turnaroundMin(o.timeOrdered, o.timeReceived);
    stateLine = `<p class="order-state released">Released ${esc(o.timeReceived)} · turnaround ${mins} min</p>`;
  } else if (inClosedShift(o)) {
    actions = `<p class="hint">Shift closed — this order can no longer be cancelled.</p>
      <div class="order-actions">
        <button class="btn btn-primary btn-sm" data-action="release" data-id="${esc(o.clientOrderId)}">Mark as released</button>
      </div>`;
  } else if (state.cancelling === o.clientOrderId) {
    actions = `<div class="cancel-form">
        <div class="field">
          <label for="cancel-reason">Why is this order being cancelled? <span class="req">required</span></label>
          <input type="text" id="cancel-reason" autocomplete="off" placeholder="e.g. customer changed their mind">
        </div>
        ${state.cancelError ? `<p class="inline-error">${esc(state.cancelError)}</p>` : ''}
        <div class="order-actions">
          <button class="btn btn-danger btn-sm" data-action="cancel-confirm" data-id="${esc(o.clientOrderId)}">Confirm cancel</button>
          <button class="btn btn-sm" data-action="cancel-abort">Never mind</button>
        </div>
      </div>`;
  } else {
    actions = `<div class="order-actions">
        <button class="btn btn-primary btn-sm" data-action="release" data-id="${esc(o.clientOrderId)}">Mark as released</button>
        <button class="btn btn-danger btn-sm" data-action="cancel-start" data-id="${esc(o.clientOrderId)}">Cancel order</button>
      </div>`;
  }

  return `<article class="order-card ${o.cancelled ? 'is-cancelled' : ''}">
      <div class="order-head">
        <span class="order-id">${esc(o.orderId || 'Not sent yet')}</span>
        ${pill}
      </div>
      <p class="order-meta">${esc(o.date)} ${esc(o.timeOrdered)} · ${esc(o.orderType)} · ${esc(o.paymentMode)}${ref} · ${esc(o.cashier)}</p>
      <p class="order-items">${items}</p>
      ${o.discountName ? `<p class="order-meta">${esc(o.discountName)} −${peso(o.discountAmount)}${o.discountRefId ? ` · ID ${esc(o.discountRefId)}` : ''}</p>` : ''}
      <p class="order-total">${peso(o.total)}</p>
      ${o.syncError ? `<p class="inline-error">${esc(o.syncError)}</p>` : ''}
      ${stateLine}
      ${actions}
    </article>`;
}

function renderOrders() {
  const list = [...state.orders].sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  $('#orders-list').innerHTML = list.length
    ? list.map(renderOrderCard).join('')
    : '<p class="empty">No orders on this phone yet.</p>';
}

function salesRows(t) {
  return `<div class="row total"><span>Total sales</span><span>${peso(t.total)}</span></div>
    <div class="row"><span>Cash</span><span>${peso(t.cash)}</span></div>
    <div class="row"><span>GCash</span><span>${peso(t.gcash)}</span></div>
    <div class="row"><span>Bank Transfer</span><span>${peso(t.bank)}</span></div>
    <div class="row"><span class="muted">Orders</span><span class="muted">${t.orders}</span></div>`;
}

const signed = (n) => `${n < 0 ? '−' : n > 0 ? '+' : ''}${peso(Math.abs(n))}`;

function renderSummary() {
  // A background sync re-renders every tab. Skip this one while the cashier is typing in
  // the close form, or the phone keyboard would close mid-count.
  const focused = document.activeElement;
  if (state.closing && focused && focused.tagName === 'INPUT' && $('#summary-body').contains(focused)) return;
  const today = todayStr();
  const day = sumOrders(state.orders.filter((o) => o.date === today));
  const cur = sumOrders(shiftOrders());
  const open = shiftOrders().filter((o) => !o.cancelled && !o.timeReceived).length;
  const old = state.shift.date !== today;

  let closeBlock;
  if (!state.closing) {
    closeBlock = `<button class="btn btn-primary btn-block" data-action="close-start">Close shift</button>`;
  } else {
    const typed = Number($('#close-cash') ? $('#close-cash').value : '');
    closeBlock = `<div class="field">
        <label for="close-cash">Cash counted in the till <span class="req">required</span></label>
        <input type="number" inputmode="decimal" min="0" step="0.01" id="close-cash" placeholder="₱ 0.00"
               value="${esc($('#close-cash') ? $('#close-cash').value : '')}">
      </div>
      <div class="row"><span class="muted">Expected cash</span><span>${peso(cur.cash)}</span></div>
      <div class="row"><span class="muted">Over / short</span><span id="close-diff">${signed(round2(typed - cur.cash))}</span></div>
      <div class="field">
        <label for="close-notes">Notes <span class="muted">(optional)</span></label>
        <input type="text" id="close-notes" autocomplete="off" value="${esc($('#close-notes') ? $('#close-notes').value : '')}">
      </div>
      ${open ? `<p class="hint">${open} order(s) are not released yet. They stay in this shift.</p>` : ''}
      ${state.closeError ? `<p class="inline-error">${esc(state.closeError)}</p>` : ''}
      <div class="order-actions">
        <button class="btn btn-primary btn-sm" data-action="close-confirm">Confirm close</button>
        <button class="btn btn-sm" data-action="close-abort">Never mind</button>
      </div>`;
  }

  const done = [...state.shifts].filter((s) => s.closedAt.slice(0, 10) === today).reverse();
  const sendState = (s) =>
    s.status === 'synced' ? '' : s.status === 'error' ? ` · problem: ${esc(s.syncError)}` : ' · waiting to send';
  $('#summary-body').innerHTML = `
    <div class="card summary"><p class="label">Today · ${esc(today)}</p>${salesRows(day)}</div>
    <div class="card summary">
      <p class="label">Shift ${state.shift.no} (open)</p>
      ${old ? `<p class="inline-error">This shift started on ${esc(state.shift.date)}. Close it.</p>` : ''}
      ${salesRows(cur)}
      <div class="summary-close">${closeBlock}</div>
    </div>
    ${done.length ? `<div class="card summary"><p class="label">Closed today</p>${done
      .map((s) => `<div class="row"><span>Shift ${s.shiftNo} · ${esc(s.closedBy)}</span><span>${peso(s.total)}</span></div>
        <div class="row"><span class="muted">Counted ${peso(s.cashCounted)}</span><span class="muted">${signed(s.overShort)}${sendState(s)}</span></div>`)
      .join('')}</div>` : ''}`;
}

function renderSettings() {
  $('#settings-who').textContent = state.session ? state.session.cashier : '—';
  $('#settings-expiry').textContent = state.session
    ? `Signs out automatically at ${new Date(state.session.expiresAt).toLocaleString()}.`
    : '';
  const cachedAt = load('mc.cachedAt', null);
  $('#settings-cache').textContent = cachedAt
    ? `${state.menu.length} menu items, ${state.cashiers.length} cashiers, ${state.discounts.length} discounts — last updated ${new Date(cachedAt).toLocaleString()}.`
    : 'Never downloaded on this phone yet.';
  $('#about-build').textContent = API_URL ? `Connected to ${API_URL}` : 'No backend configured.';
}

function render() {
  const signedIn = Boolean(state.session);
  $('#login').hidden = signedIn;
  $('#app').hidden = !signedIn;

  if (!signedIn) return renderLogin();

  $('#topbar-who').textContent = state.session.cashier;
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === state.tab));
  $$('.panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === state.tab));

  renderNewOrder();
  renderOrders();
  renderSummary();
  renderSettings();
  renderNetPill();
}

// ---------------------------------------------------------------- events

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action], [data-tab]');
  if (!el) return;
  const { action, tab } = el.dataset;

  if (tab) {
    state.tab = tab;
    return render();
  }

  switch (action) {
    case 'pick-cashier':
      state.loginPick = el.dataset.name;
      $('#login-error').hidden = true;
      return renderLogin();
    case 'logout':
      return logout();
    case 'refresh-menu':
      return refreshCaches();
    case 'pick-type':
      state.orderType = el.dataset.value;
      return renderNewOrder();
    case 'pick-payment':
      state.paymentMode = el.dataset.value;
      return renderNewOrder();
    case 'pick-discount':
      state.discountId = el.dataset.value;
      return renderNewOrder();
    case 'qty': {
      const id = el.dataset.item;
      const next = (state.cart[id] || 0) + Number(el.dataset.delta);
      if (next <= 0) delete state.cart[id];
      else state.cart[id] = next;
      return renderNewOrder();
    }
    case 'release':
      return markReleased(el.dataset.id);
    case 'cancel-start':
      state.cancelling = el.dataset.id;
      state.cancelError = '';
      return renderOrders();
    case 'cancel-abort':
      state.cancelling = null;
      state.cancelError = '';
      return renderOrders();
    case 'cancel-confirm':
      return cancelOrder(el.dataset.id, $('#cancel-reason') ? $('#cancel-reason').value : '');
    case 'close-start':
      state.closing = true;
      state.closeError = '';
      return renderSummary();
    case 'close-abort':
      state.closing = false;
      state.closeError = '';
      return renderSummary();
    case 'close-confirm':
      return closeShift();
  }
});

$('#login-submit').addEventListener('click', attemptLogin);
$('#login-pin').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') attemptLogin();
});
$('#confirm-order').addEventListener('click', confirmOrder);

$('#backfill-toggle').addEventListener('change', (e) => {
  state.backfill = e.target.checked;
  if (state.backfill && !$('#bf-date').value) $('#bf-date').value = todayStr();
  renderNewOrder();
});

// Typed fields re-validate without a re-render, so the keyboard never loses focus.
document.addEventListener('input', (e) => {
  if (e.target.dataset.priceFor) {
    state.customPrice[e.target.dataset.priceFor] = e.target.value;
    const plus = document.querySelector(`[data-action="qty"][data-item="${e.target.dataset.priceFor}"][data-delta="1"]`);
    if (plus) plus.disabled = !(Number(e.target.value) > 0);
    return;
  }
  if (e.target.id === 'close-cash') {
    $('#close-diff').textContent = signed(round2(Number(e.target.value) - sumOrders(shiftOrders()).cash));
    return;
  }
  if (['discount-ref', 'bf-date', 'bf-ordered'].includes(e.target.id)) {
    const problem = orderProblem();
    $('#confirm-order').disabled = Boolean(problem);
    $('#confirm-error').hidden = !problem || !cartLines().length;
    $('#confirm-error').textContent = problem;
  }
});

window.addEventListener('online', () => {
  renderNetPill();
  syncNow();
  refreshCaches();
});
window.addEventListener('offline', renderNetPill);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  checkSessionExpiry();
  syncNow();
});

setInterval(() => {
  checkSessionExpiry();
  syncNow();
}, SYNC_INTERVAL_MS);

// ---------------------------------------------------------------- boot

ensureShift();
checkSessionExpiry();
render();
syncNow();
refreshCaches();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./service-worker.js').catch(() => {});
}
