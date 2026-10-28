// Injected into the Flow web client (app.novacura.com). Nothing runs in the background: the only
// listeners are a click handler that places ONE button, "Add PL/SQL & REST info", in the Diagnostic panel's
// Trace Logs toolbar. Once it is pressed, the logged steps are looked up in the flow's designer data
// (see lib/flow-step-sql.js) and every Database step's log row gets a "Copy with values" button: the
// step's PL/SQL with the variables from the panel's Variables tab written in as literals; every logged HTTP call gets "Copy Postman"
// (lib/rest-postman.js, from the call's own details in the log). Read-only.
const CD = { observer: null, scanning: false, cache: new Map(), button: null, detailsButton: null, status: { text: "Add PL/SQL & REST info", title: "" }, trail: [], copied: new Map(), active: false };
const CD_APP_RE = /\/apps\/v1\/appPackages\/[^/]+\/versions\/[^/]+\/apps\/([^/]+)\/versions\/([^/?#]+)/;
const CD_TOKEN_RE = /\/token\/organization\/([^/]+)\/environments\/([^/]+)\/package\/([^/?#]+)/;
const CD_LABEL = "Add PL/SQL & REST info";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Writes text to the clipboard: the Clipboard API, else a hidden textarea + execCommand. Returns true on success. */
async function cdCopy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* falls back below */ }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}

/** What "Copy details" copies: the status, what the page shows and what the lookup tried (names and ids, no values). */
function cdReport() {
  const p = cdPanel();
  const crumb = p && cdBreadcrumb(p);
  const rows = cdStepRows();
  return [
    "Novacura Buddy - PL/SQL info details",
    "Status: " + CD.status.text,
    "Diagnostic panel: " + (p ? "found" : "not found"),
    "Flow / step: " + (crumb ? JSON.stringify(crumb) : "not found"),
    "Logged steps: " + (rows.length ? [...new Set(rows.map((r) => r.name))].join(", ") : "none"),
    "Database / REST steps found: " + ([...CD.cache].filter(([, v]) => v).map(([k]) => k).join(", ") || "none"),
    "Flow versions loaded: " + (cdVersions().map((v) => v.app + "@" + v.version).join(", ") || "none"),
    "Org / environment / package: " + (cdIds() ? Object.values(cdIds()).join(" / ") : "not found"),
    "Lookup:",
    ...(CD.trail.length ? CD.trail : ["(not run yet)"]),
    CD.status.title && CD.status.title !== CD.trail.join("\n") ? "Message: " + CD.status.title : ""
  ].filter(Boolean).join("\n");
}

function cdPanel() {
  const heading = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,div,span,p")].find((e) => e.children.length === 0 && e.textContent.trim() === "Diagnostic panel");
  if (!heading) return null;
  let panel = heading;
  for (let i = 0; i < 6 && panel.parentElement; i++) {
    panel = panel.parentElement;
    if (panel.querySelector(".mud-tabs, [role=tablist], .mud-tab")) break;
  }
  return { heading, panel };
}

/** The running flow: "Flow / Step" shown under the panel title, else the flow name in the client's top bar. */
function cdBreadcrumb(p) {
  const el = p && [...p.panel.querySelectorAll("*")].find((e) => e.children.length === 0 && / \/ /.test(e.textContent) && e.textContent.length < 200);
  if (el) return FlowStepSql.parseBreadcrumb(el.textContent);
  const bar = document.querySelector(".mud-appbar, header");
  const title = bar && [...bar.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent.trim() && !/^(Diagnostic panel)$/.test(e.textContent.trim()));
  return title ? FlowStepSql.parseBreadcrumb(title.textContent) : null;
}

/** The versions of flows the client has loaded, newest first: [{ app, version }]. */
function cdVersions() {
  const out = [];
  for (const e of performance.getEntriesByType("resource")) {
    const m = CD_APP_RE.exec(e.name);
    if (m && !out.some((o) => o.app === m[1] && o.version === m[2])) out.unshift({ app: m[1], version: m[2] });
  }
  return out;
}

/** The org, environment and package the client runs in, from its token request: { orgId, envId, packageId } or null. */
function cdIds() {
  let ids = null;
  for (const e of performance.getEntriesByType("resource")) {
    const m = CD_TOKEN_RE.exec(e.name);
    if (m) ids = { orgId: m[1], envId: m[2], packageId: m[3] };
  }
  return ids;
}

/** A value as the Variables tab shows it, as the Designer test panel would write it (see PlsqlTestScript.toLiteral). */
function cdFlowLiteral(value, type) {
  const v = String(value).trim(), t = String(type).trim().toLowerCase();
  if (v === "null" || t === "-" || t === "") return "null";
  if (/bool/.test(t)) return /^(true|1)$/i.test(v) ? "true" : "false";
  if (/date|time/.test(t)) { const d = new Date(v); if (!isNaN(d)) return `Date("${d.toISOString()}")`; }
  if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v) && !/text|string/.test(t)) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The Variables tab as { "Record__field": flow literal }: rows with the type "Record" open a record, indented fields follow. */
function cdVariablesNow(p) {
  const rows = [...p.panel.querySelectorAll("tr.variableRow")];
  if (!rows.length) return null;
  const values = {}, stack = [];
  for (const row of rows) {
    const cells = row.querySelectorAll("td");
    const nameEl = row.querySelector(".variableRowNameCell");
    if (!nameEl || cells.length < 3) continue;
    const name = nameEl.textContent.trim();
    const left = nameEl.getBoundingClientRect().left;
    while (stack.length && stack[stack.length - 1].left >= left - 1) stack.pop();
    const type = cells[cells.length - 1].textContent.trim();
    if (/^record$/i.test(type)) { stack.push({ left, name: name.replace(/\s*\(\d+\)$/, "") }); continue; }
    values[[...stack.map((s) => s.name), name].join("__")] = cdFlowLiteral(cells[cells.length - 2].textContent, type);
  }
  return values;
}

/** The scrolling box of the Trace Logs table, if it scrolls. */
function cdLogScrollBox() {
  for (let el = document.querySelector(".diagnosticLogTableRow"); el; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el;
  }
  return null;
}

/** The current variables. While the Trace Logs tab is open the Variables tab is not drawn, so it is
 *  opened for a moment and the log tab is restored: hidden while it switches, at the same scroll position. */
async function cdReadVariables() {
  let p = cdPanel();
  if (!p) return null;
  const now = cdVariablesNow(p);
  if (now) return now;
  const tabs = [...p.panel.querySelectorAll(".mud-tab")];
  const varTab = tabs.find((t) => t.textContent.trim() === "Variables");
  const back = tabs.find((t) => t.classList.contains("mud-tab-active"));
  if (!varTab) return null;
  const box = cdLogScrollBox();
  const scroll = box ? box.scrollTop : 0;
  const content = p.panel.querySelector(".mud-tabs-panels") || p.panel;
  const height = content.offsetHeight;
  content.style.visibility = "hidden";
  content.style.minHeight = height + "px"; // no jump while the other tab is drawn
  try {
    varTab.click();
    let values = null;
    for (let i = 0; i < 40 && !values; i++) { await sleep(50); p = cdPanel(); values = p && cdVariablesNow(p); }
    if (back && back !== varTab) {
      back.click();
      for (let i = 0; i < 40 && !document.querySelector(".diagnosticLogTableRow"); i++) await sleep(50);
      cdMarkRows(); // the redrawn rows get their buttons back at once
      const again = cdLogScrollBox();
      if (again) again.scrollTop = scroll;
    }
    return values;
  } finally {
    content.style.visibility = "";
    content.style.minHeight = "";
  }
}

/** A short notice at the bottom of the page; it is not part of the panel, so a redraw does not remove it. */
function cdToast(text, ok = true) {
  let t = document.getElementById("nb-toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "nb-toast";
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.style.cssText = `position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;padding:8px 16px;border-radius:8px;background:${ok ? "#166534" : "#b91c1c"};color:#fff;font:13px system-ui,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.25);pointer-events:none;`;
  clearTimeout(cdToast.timer);
  cdToast.timer = setTimeout(() => t.remove(), 2500);
}

/** Logged steps: [{ row, name }] from the Trace Logs table (rows of type "Step"). */
function cdStepRows() {
  const out = [];
  for (const row of document.querySelectorAll(".diagnosticLogTableRow")) {
    const type = (row.children[1] && row.children[1].textContent.trim()) || "";
    const source = row.querySelector(".sourceCell");
    // The name without the button this script adds to the cell.
    const name = source && [...source.childNodes].filter((n) => !(n.classList && n.classList.contains("nb-copy"))).map((n) => n.textContent).join("").trim();
    if (type === "Step" && name) out.push({ row, name, source });
  }
  return out;
}

/** Shows the outcome of a copy on every button for this key, as a notice, and resets the buttons after a moment. */
function cdDone(key, ok, label, message) {
  if (ok) CD.copied.set(key, Date.now());
  cdToast(ok ? message : "Copy failed", ok);
  const each = (fn) => { for (const btn of document.querySelectorAll(".nb-copy")) if (btn.dataset.step === key) fn(btn); };
  each((btn) => { btn.textContent = ok ? "Copied ✓" : "Copy failed"; });
  setTimeout(() => each((btn) => { btn.textContent = label; }), 2500);
}

/** Logged HTTP calls: [{ key, cell, panel }]. Each row is an expansion panel whose details (General, Request,
 *  Response) are in the page already, also while it is closed. */
function cdHttpRows() {
  const out = [];
  document.querySelectorAll(".diagnosticLogTable .mud-expand-panel").forEach((panel, i) => {
    const type = panel.querySelector(".typeCell");
    const cell = panel.querySelector(".resultCell");
    if (type && cell && type.textContent.trim() === "HTTP") out.push({ key: `http:${i}`, cell, panel });
  });
  return out;
}

/** The text of the section under the heading "Request" of a logged HTTP call. */
function cdRequestText(panel) {
  const h = [...panel.querySelectorAll("h6")].find((e) => e.textContent.trim() === "Request");
  const sec = h && h.nextElementSibling;
  return sec ? sec.innerText : "";
}

function cdMarkHttp() {
  let marked = 0;
  for (const { key, cell, panel } of cdHttpRows()) {
    marked++;
    if (cell.querySelector(".nb-copy")) continue;
    const b = document.createElement("button");
    b.className = "nb-copy";
    b.dataset.step = key;
    b.textContent = "Copy Postman";
    b.style.cssText = CD_BTN_STYLE;
    b.title = "Copies this logged call (method, URL, headers, body) as a Postman collection. In Postman: Import > Raw text. A masked header such as the token becomes a Postman variable.";
    b.onclick = async (e) => {
      e.stopPropagation(); e.preventDefault();
      const req = RestPostman.parseLoggedRequest(cdRequestText(panel));
      if (!req.url) { cdToast("The call's details could not be read", false); return; }
      let host = req.url; try { host = new URL(req.url).pathname.split("/").filter(Boolean).pop() || new URL(req.url).host; } catch { /* keep the url */ }
      const ok = await cdCopy(JSON.stringify(RestPostman.collectionFromLog(`${req.method} ${host}`, req), null, 2));
      cdDone(key, ok, "Copy Postman", `Copied: Postman request ${req.method} ${host} (Postman: Import > Raw text)`);
    };
    cell.appendChild(b);
  }
  return marked;
}

const CD_BTN_STYLE = "margin-left:8px;padding:1px 8px;border:1px solid #0c65f4;border-radius:6px;background:#fff;color:#0c65f4;font:12px system-ui,sans-serif;cursor:pointer;white-space:nowrap;";

function cdMarkRows() {
  let marked = cdMarkHttp();
  for (const { source, name } of cdStepRows()) {
    const hit = CD.cache.get(name);
    if (!hit) continue;
    marked++;
    if (source.querySelector(".nb-copy")) continue;
    const label = "Copy with values";
    const b = document.createElement("button");
    b.className = "nb-copy";
    b.dataset.step = name;
    b.textContent = label;
    b.style.cssText = CD_BTN_STYLE;
    b.title = `Copies this Database step's code with the variables as they are now (Variables tab) written in as PL/SQL literals. Code from: ${hit.source}`;
    // The row may be redrawn while copying: the outcome is kept by step name and shown on whichever button is there.
    const copied = CD.copied.get(name);
    if (copied && Date.now() - copied < 2500) b.textContent = "Copied ✓";
    b.onclick = async (e) => {
      e.stopPropagation(); e.preventDefault();
      b.textContent = "Copying…";
      const vars = await cdReadVariables();
      if (!vars) { cdToast("Could not read the Variables tab", false); b.textContent = label; return; }
      const ok = await cdCopy(PlsqlTestScript.inlineBinds(hit.sql, vars));
      cdDone(name, ok, label, `Copied: PL/SQL of "${name}" with values`);
    };
    source.appendChild(b);
  }
  return marked;
}

/** The button's text and the lookup details. The client redraws the toolbar now and then and drops what was
 *  added to it, so the state is kept here and applied to whichever button is in the page. */
function cdStatus(text, title) {
  CD.status = { text, title: title || "" };
  cdApplyStatus();
}
function cdApplyStatus() {
  // Only write what changed: our own writes would otherwise wake the observer again.
  const set = (el, prop, value) => { if (el && el[prop] !== value) el[prop] = value; };
  set(CD.button, "textContent", CD.status.text);
  set(CD.button, "title", CD.status.title || (CD.button && CD.button.dataset.help) || "");
}

async function cdScan() {
  if (CD.scanning) return;
  CD.scanning = true;
  CD.active = true;
  const say = (text, title) => cdStatus(text, title);
  try {
    const rows = cdStepRows();
    cdMarkHttp(); // logged HTTP calls need no lookup: their details are in the log
    if (!rows.length && !cdHttpRows().length) { say("No logged steps yet (click to retry)", "Run the flow with tracing on (Trace steps), then press again."); return; }
    const missing = [...new Set(rows.map((r) => r.name))].filter((n) => !CD.cache.has(n));
    let tried = [];
    if (missing.length) {
      say("Searching PL/SQL steps…");
      const ids = cdIds() || {};
      const res = await chrome.runtime.sendMessage({
        type: "STEP_SQL_MANY", orgId: ids.orgId, packageId: ids.packageId, stepNames: missing, versions: cdVersions()
      }).catch((e) => ({ ok: false, error: e.message }));
      if (!res || !res.ok) { CD.trail = ["Error: " + ((res && res.error) || "no answer from the extension")]; say("PL/SQL info: " + ((res && res.error) || "failed") + " (click to retry)", (res && res.error) || ""); return; }
      tried = res.tried || [];
      CD.trail = tried.length ? tried : ["The lookup returned no details."];
      for (const n of missing) CD.cache.set(n, res.steps[n] || false); // false: not a Database step, not asked again
    }
    const found = cdMarkRows();
    say(found ? `PL/SQL & REST info added (${found})` : "No Database or REST steps found", tried.length ? tried.join("\n") : CD.status.title);
    cdWatch();
  } catch (e) {
    say("PL/SQL info failed (click to retry)", String(e && e.message || e));
  } finally {
    CD.scanning = false;
  }
}

/** After the button was pressed only: whatever the client redraws is repaired (button, row buttons) and new log
 *  rows get theirs, until the Diagnostic panel goes away. */
function cdWatch() {
  if (CD.observer) return;
  const p = cdPanel();
  if (!p) return;
  const root = p.panel;
  let timer = null;
  CD.observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!document.body.contains(root)) { CD.observer.disconnect(); CD.observer = null; CD.active = false; CD.status = { text: CD_LABEL, title: "" }; return; }
      cdDock();
      if (!CD.scanning) cdScan();
    }, 700);
  });
  CD.observer.observe(root, { childList: true, subtree: true });
}

/** Places the one button in the Trace Logs toolbar (next to "Clear logs"). */
function cdDock() {
  const toolbar = document.querySelector(".diagnosticLogTraceToolbar");
  if (!toolbar) return;
  // A button left behind by an older copy of this script (extension reloaded, page not) is replaced.
  const old = toolbar.querySelector("#nb-plsql");
  if (old && old === CD.button) return;
  toolbar.querySelectorAll("#nb-plsql, .nb-details").forEach((el) => el.remove());
  const b = document.createElement("button");
  b.id = "nb-plsql";
  b.textContent = CD_LABEL;
  b.title = "Finds the Database and REST steps in this log, reads them from the flow's designer data and adds Copy with values (PL/SQL) or Copy Postman (REST) buttons to their rows. Nothing is looked up before you press this.";
  b.style.cssText = "margin-left:8px;padding:6px 12px;border:1px solid #0c65f4;border-radius:6px;background:#0c65f4;color:#fff;font:13px system-ui,sans-serif;cursor:pointer;white-space:nowrap;";
  b.dataset.help = b.title;
  b.onclick = (e) => { e.stopPropagation(); cdStatus("Searching PL/SQL steps…", ""); cdScan(); };
  CD.button = b;
  const d = document.createElement("button");
  d.className = "nb-details";
  d.textContent = "Copy details";
  d.title = "Copies what the page shows and what the lookup tried (names and ids, no variable values) so it can be sent to the developer.";
  d.style.cssText = "margin-left:6px;padding:6px 10px;border:1px solid #9ca3af;border-radius:6px;background:#fff;color:#4b5563;font:12px system-ui,sans-serif;cursor:pointer;white-space:nowrap;";
  d.onclick = async (e) => { e.stopPropagation(); d.textContent = (await cdCopy(cdReport())) ? "Copied" : "Copy failed"; setTimeout(() => { d.textContent = "Copy details"; }, 2000); };
  CD.detailsButton = d;
  toolbar.append(b, d);
  cdApplyStatus();
}

// No polling: the button is placed after a click anywhere (opening the panel or its tab is a click)
// and once or twice shortly after the page loaded.
let cdDockTimer = null;
addEventListener("click", () => { clearTimeout(cdDockTimer); cdDockTimer = setTimeout(cdDock, 400); }, true);
setTimeout(cdDock, 3000);
setTimeout(cdDock, 8000);
