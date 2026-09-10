/**
 * Midday Cravings and Refreshment House — Order Tracking backend
 * =================================================================
 * This Google Apps Script project turns a Google Sheet into the backend
 * for the cashier order app. It exposes a small JSON API (doGet / doPost)
 * that the offline-capable web app talks to, and it builds live dashboard
 * tabs (Daily Summary, Monthly Summary) with formulas.
 *
 * SETUP (one-time):
 *   1. In this bound spreadsheet, open Extensions > Apps Script.
 *   2. Paste this file in as Code.gs (replace the default content).
 *   3. In the toolbar function dropdown pick `setup`, click Run once.
 *      (First run will ask you to authorize the script — that's normal.)
 *   4. Fill in real prices in the "Menu Items" tab whenever you have them
 *      — rows with a blank price still work, the cashier app just lets
 *      the price be typed in manually for that one sale until you set it.
 *   5. Deploy > New deployment > type "Web app".
 *        - Execute as: Me
 *        - Who has access: Anyone
 *      Copy the resulting /exec URL — that is the API_URL the frontend
 *      app needs (see frontend/config.js).
 *
 * Every time you edit this file after the first deployment, use
 * Deploy > Manage deployments > (pencil icon) > New version, so the
 * live /exec URL picks up the change.
 */

const SHEET_MENU = 'Menu Items';
const SHEET_ORDERS = 'Orders';
const SHEET_LINES = 'Order Lines';
const SHEET_DAILY = 'Daily Summary';
const SHEET_MONTHLY = 'Monthly Summary';
const TIMEZONE = 'Asia/Manila';

const ORDERS_HEADERS = ['OrderID', 'ClientOrderID', 'Date', 'Month', 'DailyOrderNo',
  'TimeOrdered', 'TimeReceived', 'OrderType', 'PaymentMode', 'RefNumber',
  'Total', 'ItemsSummary', 'Cashier', 'Source', 'SyncedAt'];
const LINES_HEADERS = ['ClientOrderID', 'OrderID', 'ItemName', 'UnitPrice', 'Qty', 'LineTotal'];
const MENU_HEADERS = ['Item ID', 'Item Name', 'Category', 'Price', 'Active'];

// ---------------------------------------------------------------------
// One-time setup
// ---------------------------------------------------------------------
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(TIMEZONE);

  ensureSheet(ss, SHEET_MENU, MENU_HEADERS);
  seedSampleMenuRowIfEmpty(ss);
  ensureSheet(ss, SHEET_ORDERS, ORDERS_HEADERS);
  ensureSheet(ss, SHEET_LINES, LINES_HEADERS);
  buildDailySummary(ss);
  buildMonthlySummary(ss);

  SpreadsheetApp.getUi().alert(
    'Setup complete!\n\n' +
    'Tabs created: Menu Items, Orders, Order Lines, Daily Summary, Monthly Summary.\n\n' +
    'Next steps:\n' +
    '1. Add your menu items and (when ready) prices to the "Menu Items" tab.\n' +
    '2. Deploy this project as a Web App (Deploy > New deployment > Web app,\n' +
    '   execute as Me, access: Anyone) and copy the /exec URL into the\n' +
    '   frontend app\'s config.js.'
  );
}

function ensureSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0 && headers.length > 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#f3f3f3');
    sheet.autoResizeColumns(1, headers.length);
  }
  return sheet;
}

function seedSampleMenuRowIfEmpty(ss) {
  const sheet = ss.getSheetByName(SHEET_MENU);
  if (sheet.getLastRow() <= 1) {
    // A couple of example rows so the tab's shape is obvious. Price is left
    // blank on purpose — edit or delete these once your real menu is ready.
    sheet.getRange(2, 1, 2, MENU_HEADERS.length).setValues([
      ['1', 'Puto Cake (example — edit me)', 'Puto', '', 'TRUE'],
      ['2', 'Ube Tart (example — edit me)', 'Pastry', '', 'TRUE'],
    ]);
  }
}

function buildDailySummary(ss) {
  const sheet = ensureSheet(ss, SHEET_DAILY, []);
  sheet.clear();
  sheet.getRange('A1').setValue('Sales by Date').setFontWeight('bold');
  sheet.getRange('A2').setFormula(
    `=IFERROR(QUERY(${SHEET_ORDERS}!A2:O, ` +
    `"select C, count(A), sum(K) where C is not null group by C order by C desc ` +
    `label C 'Date', count(A) 'Orders', sum(K) 'Total Sales'"), "No orders yet")`
  );

  sheet.getRange('F1').setValue('Cash Breakdown by Date (sum of Total per payment mode)').setFontWeight('bold');
  sheet.getRange('F2').setFormula(
    `=IFERROR(QUERY(${SHEET_ORDERS}!A2:O, ` +
    `"select C, sum(K) where C is not null group by C pivot I order by C desc label C 'Date'"), "")`
  );

  sheet.getRange('M1').setValue('Dine-in vs Take-out by Date').setFontWeight('bold');
  sheet.getRange('M2').setFormula(
    `=IFERROR(QUERY(${SHEET_ORDERS}!A2:O, ` +
    `"select C, sum(K) where C is not null group by C pivot H order by C desc label C 'Date'"), "")`
  );
  sheet.autoResizeColumns(1, 20);
}

function buildMonthlySummary(ss) {
  const sheet = ensureSheet(ss, SHEET_MONTHLY, []);
  sheet.clear();
  sheet.getRange('A1').setValue('Sales by Month').setFontWeight('bold');
  sheet.getRange('A2').setFormula(
    `=IFERROR(QUERY(${SHEET_ORDERS}!A2:O, ` +
    `"select D, count(A), sum(K) where D is not null group by D order by D desc ` +
    `label D 'Month', count(A) 'Orders', sum(K) 'Total Sales'"), "No orders yet")`
  );

  sheet.getRange('F1').setValue('Cash Breakdown by Month').setFontWeight('bold');
  sheet.getRange('F2').setFormula(
    `=IFERROR(QUERY(${SHEET_ORDERS}!A2:O, ` +
    `"select D, sum(K) where D is not null group by D pivot I order by D desc label D 'Month'"), "")`
  );

  sheet.getRange('M1').setValue('Dine-in vs Take-out by Month').setFontWeight('bold');
  sheet.getRange('M2').setFormula(
    `=IFERROR(QUERY(${SHEET_ORDERS}!A2:O, ` +
    `"select D, sum(K) where D is not null group by D pivot H order by D desc label D 'Month'"), "")`
  );

  sheet.getRange('T1').setValue('Best Sellers (all time, from Order Lines)').setFontWeight('bold');
  sheet.getRange('T2').setFormula(
    `=IFERROR(QUERY('${SHEET_LINES}'!A2:F, ` +
    `"select C, sum(E), sum(F) where C is not null group by C order by sum(F) desc ` +
    `label C 'Item', sum(E) 'Qty Sold', sum(F) 'Revenue'"), "")`
  );
  sheet.autoResizeColumns(1, 24);
}

// ---------------------------------------------------------------------
// Web API
// ---------------------------------------------------------------------
function doGet(e) {
  const action = (e.parameter.action || 'ping');
  try {
    if (action === 'menu') return jsonOut({ ok: true, items: getMenuItems() });
    if (action === 'ping') return jsonOut({ ok: true, serverTime: new Date().toISOString() });
    return jsonOut({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    if (action === 'syncOrders') {
      const results = syncOrders(body.orders || []);
      return jsonOut({ ok: true, results: results });
    }
    return jsonOut({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------
function getMenuItems() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_MENU);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, MENU_HEADERS.length).getValues();
  return rows
    .filter(r => r[1]) // has an Item Name
    .map(r => ({
      itemId: String(r[0] || ''),
      name: String(r[1] || ''),
      category: String(r[2] || ''),
      price: (r[3] === '' || r[3] === null) ? null : Number(r[3]),
      active: String(r[4]).toUpperCase() !== 'FALSE',
    }));
}

// ---------------------------------------------------------------------
// Orders sync
// ---------------------------------------------------------------------
// Uses a lock + a small in-memory pass over existing ClientOrderIDs so that
// re-sending the same offline order twice (e.g. a flaky connection retried
// the request) never creates a duplicate row.
function syncOrders(orders) {
  if (!orders.length) return [];
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const ordersSheet = ss.getSheetByName(SHEET_ORDERS);
    const linesSheet = ss.getSheetByName(SHEET_LINES);

    const existingIds = getExistingClientOrderIds(ordersSheet);
    // Count existing orders per date, so DailyOrderNo continues correctly.
    const dailyCounts = getDailyOrderCounts(ordersSheet);

    const results = [];
    const newOrderRows = [];
    const newLineRows = [];
    const now = new Date();

    orders.forEach(o => {
      if (!o.clientOrderId) {
        results.push({ clientOrderId: null, status: 'error', error: 'missing clientOrderId' });
        return;
      }
      if (existingIds.has(o.clientOrderId)) {
        results.push({ clientOrderId: o.clientOrderId, status: 'duplicate' });
        return;
      }
      const dateStr = o.date; // expected 'yyyy-MM-dd'
      const monthStr = dateStr ? dateStr.slice(0, 7) : '';
      const nextNo = (dailyCounts[dateStr] || 0) + 1;
      dailyCounts[dateStr] = nextNo;

      const orderId = dateStr + '-' + String(nextNo).padStart(3, '0');
      const itemsSummary = (o.lines || [])
        .map(l => `${l.qty}x ${l.itemName}`)
        .join(', ');

      newOrderRows.push([
        orderId, o.clientOrderId, dateStr, monthStr, nextNo,
        o.timeOrdered || '', o.timeReceived || '', o.orderType || '',
        o.paymentMode || '', o.refNumber || '',
        Number(o.total) || 0, itemsSummary, o.cashier || '',
        o.source || 'live', now.toISOString(),
      ]);

      (o.lines || []).forEach(l => {
        newLineRows.push([
          o.clientOrderId, orderId, l.itemName,
          (l.unitPrice === null || l.unitPrice === undefined) ? '' : Number(l.unitPrice),
          Number(l.qty) || 0, Number(l.lineTotal) || 0,
        ]);
      });

      existingIds.add(o.clientOrderId);
      results.push({ clientOrderId: o.clientOrderId, status: 'ok', orderId: orderId });
    });

    if (newOrderRows.length) {
      ordersSheet.getRange(ordersSheet.getLastRow() + 1, 1, newOrderRows.length, ORDERS_HEADERS.length)
        .setValues(newOrderRows);
    }
    if (newLineRows.length) {
      linesSheet.getRange(linesSheet.getLastRow() + 1, 1, newLineRows.length, LINES_HEADERS.length)
        .setValues(newLineRows);
    }
    return results;
  } finally {
    lock.releaseLock();
  }
}

function getExistingClientOrderIds(ordersSheet) {
  const ids = new Set();
  const lastRow = ordersSheet.getLastRow();
  if (lastRow < 2) return ids;
  const col = ordersSheet.getRange(2, 2, lastRow - 1, 1).getValues(); // column B
  col.forEach(r => { if (r[0]) ids.add(String(r[0])); });
  return ids;
}

function getDailyOrderCounts(ordersSheet) {
  const counts = {};
  const lastRow = ordersSheet.getLastRow();
  if (lastRow < 2) return counts;
  const dates = ordersSheet.getRange(2, 3, lastRow - 1, 1).getValues(); // column C
  dates.forEach(r => {
    const d = String(r[0] || '');
    if (!d) return;
    counts[d] = (counts[d] || 0) + 1;
  });
  return counts;
}
