# Midday Cravings — Order Tracking System

Replaces the cashier's paper order log with an app that:
- works **fully offline** on the cashier's phone (saves locally, syncs automatically once online)
- auto-computes date, time, and total
- records order #, items, total, payment mode + reference number (for GCash/bank transfer), time ordered, time received, dine-in/take-out
- writes everything to a Google Sheet, with a live **Daily Summary** and **Monthly Summary** dashboard (sales totals, cash breakdown by payment mode, dine-in vs. take-out, best sellers)
- lets you type in past paper transactions as a "backfill" until you're fully switched over
- does **not** hardcode any prices — you fill those in whenever your menu pricing is final; until then, the cashier can type a price in for that one sale

There are two parts to set up, in order: the **Google Sheet backend**, then the **cashier app** (frontend).

---

## Part 1 — Google Sheet backend (~10 minutes)

1. Go to [sheets.google.com](https://sheets.google.com) and create a new blank spreadsheet. Name it something like "Midday Cravings — Orders".
2. In the menu, go to **Extensions > Apps Script**. This opens the Apps Script editor, bound to this spreadsheet.
3. Delete the placeholder code in `Code.gs` and paste in the entire contents of **`backend/Code.gs`** from this folder.
4. Click **Save** (the floppy disk icon).
5. In the function dropdown at the top (next to Run/Debug), select **`setup`**, then click **Run**.
   - The first time, Google will ask you to authorize the script — click through "Advanced" > "Go to (project name) (unsafe)" if it warns you (this is normal for your own scripts). This is only asking for permission to edit *this* spreadsheet.
   - You should get a popup confirming setup is complete, and five new tabs will appear: **Menu Items**, **Orders**, **Order Lines**, **Daily Summary**, **Monthly Summary**.
6. Open the **Menu Items** tab. Two example rows are there to show the shape — replace them with your real items (Item Name, Category). Leave **Price** blank for anything not finalized yet; fill it in whenever you're ready (no re-deployment needed, the app picks up price changes automatically).
7. Back in the Apps Script editor: **Deploy > New deployment**.
   - Click the gear icon next to "Select type" and choose **Web app**.
   - Description: anything, e.g. "v1".
   - Execute as: **Me**.
   - Who has access: **Anyone**.
   - Click **Deploy**, then **Authorize access** again if asked.
   - Copy the **Web app URL** — it ends in `/exec`. You'll need it in Part 2.

> Whenever you edit `Code.gs` later, you must do **Deploy > Manage deployments** > pencil icon > **New version** for the change to take effect on the live URL — saving alone isn't enough.

---

## Part 2 — Cashier app (frontend)

This has already been deployed to GitHub Pages for you. The cashier app's live address is:

**https://argon1199.github.io/midday-cravings-orders/**

Repo: `argon1199/midday-cravings-orders`. `backend/Code.gs` holds the Apps Script backend from Part 1; the app files (`index.html`, `style.css`, `app.js`, `config.js`, `manifest.json`, `service-worker.js`) live at the repo root, since GitHub Pages serves from the root.

**One step still needed from you:** `config.js` in the repo still has the placeholder `API_URL`. Once you finish Part 1 (deploy the Apps Script Web App) and have the `/exec` URL, either send it to me to paste in, or edit `config.js` yourself on GitHub (open the file → pencil/edit icon → replace the placeholder → commit). Until that's set, the app saves orders locally fine but has nothing to sync to yet, and the menu will show "No menu loaded yet."

If you ever want to change the app's look or behavior later, edit the files directly on GitHub (or ask me to). Whenever `index.html`, `style.css`, `app.js`, `config.js`, or `manifest.json` changes, also bump `CACHE_NAME` in `service-worker.js` (e.g. `mc-orders-v2` → `v3`) in the same commit — otherwise phones that already installed the app keep using their old cached copy and never see the update.

### Installing it on the cashier's phone

- **Android (Chrome):** open the URL above → tap the ⋮ menu → **"Add to Home screen"** → confirm. It now opens full-screen like a normal app, and works with the phone in airplane mode.
- **iPhone (Safari — must be Safari, not Chrome):** open the URL → tap the Share icon → **"Add to Home Screen"** → confirm.

### Using it

- **New Order** tab: pick order type, tap items to add/remove (tap **+** repeatedly for quantity), pick payment mode (reference number field appears for GCash/Bank Transfer), tap **Mark as received now** when the order is handed over, then **Save order**. Time ordered is captured automatically the moment the first item is tapped.
- **Backfill a past order** toggle: unlocks the date and both time fields so you can type in a transaction from the paper log for any past day.
- **Orders** tab: shows every order saved on this device and whether it's synced yet. If offline, everything shows "pending" until the phone reconnects — then it syncs automatically (also retries every minute in the background, or tap **Sync now**).
- **Settings** tab: set the cashier's name (shown on synced orders) and manually refresh the cached menu/prices.

### Testing before go-live

1. With good signal, open the app once (this downloads and caches the menu + app itself).
2. Turn on **Airplane Mode**.
3. Create a test order, save it — it should appear in the Orders tab as "pending".
4. Turn Airplane Mode back off — within ~60 seconds it should flip to "synced", and the row should appear in the **Orders** tab of your Google Sheet.
5. Delete the test row from the Sheet's Orders and Order Lines tabs when you're done testing.

---

## Reports & dashboard

Open the Google Sheet any time — no need to ask the cashier:
- **Daily Summary** tab: orders and total sales per day, cash breakdown by payment mode per day, dine-in vs. take-out per day.
- **Monthly Summary** tab: the same rollups by month, plus a best-sellers list (quantity and revenue per item, all time).

These are all live formulas (`QUERY`) — no manual refresh needed, no formulas to drag down as new orders come in. You can select any of these ranges and insert a chart (Insert > Chart) if you want a visual.

## Notes / assumptions made

- **Order numbers reset each day** (Order #1, #2… starting fresh every morning) — the daily order number is assigned by the backend based on how many orders already exist for that date, so it stays correct even if the phone was offline for a while and several orders sync at once.
- Reference number is optional (not force-required) for GCash/Bank Transfer, in case the cashier is mid-transaction and needs to save first and check the reference after — worth keeping an eye on this at first in case you'd rather make it mandatory.
- One cashier device is assumed for now. If you eventually run two tills at once, each gets its own copy of the app (same config.js / same Apps Script URL) — the sync logic is built to avoid duplicate rows even if two devices submit around the same time.
