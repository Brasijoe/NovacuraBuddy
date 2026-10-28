// Injected into the Flow web client (app.novacura.com). Nothing runs in the background: the only
// listeners are a click handler that places ONE button, "Add PL/SQL info", in the Diagnostic panel's
// Trace Logs toolbar. Once it is pressed, the logged steps are looked up in the flow's designer data
// (see lib/flow-step-sql.js) and every Database step's log row gets a "Copy with values" button: the
// step's PL/SQL with the variables from the panel's Variables tab written in as literals. Read-only.
const CD = { observer: null, scanning: false, cache: new Map(), flow: null, button: null };
const CD_APP_RE = /\/apps\/v1\/appPackages\/[^/]+\/versions\/[^/]+\/apps\/([^/]+)\/versions\/([^/?#]+)/;
const CD_LABEL = "Add PL/SQL info";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** The current variables. While the Trace Logs tab is open the Variables tab is not drawn, so it is
 *  opened for a moment and the log tab is restored. */
async function cdReadVariables() {
  let p = cdPanel();
  if (!p) return null;
  const now = cdVariablesNow(p);
  if (now) return now;
  const tabs = [...p.panel.querySelectorAll(".mud-tab")];
  const varTab = tabs.find((t) => t.textContent.trim() === "Variables");
  const back = tabs.find((t) => t.classList.contains("mud-tab-active"));
  if (!varTab) return null;
  varTab.click();
  let values = null;
  for (let i = 0; i < 20 && !values; i++) { await sleep(100); p = cdPanel(); values = p && cdVariablesNow(p); }
  if (back && back !== varTab) back.click();
  return values;
}

/** Logged steps: [{ row, name }] from the Trace Logs table (rows of type "Step"). */
function cdStepRows() {
  const out = [];
  for (const row of document.querySelectorAll(".diagnosticLogTableRow")) {
    const type = (row.children[1] && row.children[1].textContent.trim()) || "";
    const source = row.querySelector(".sourceCell");
    if (type === "Step" && source) out.push({ row, name: source.textContent.trim(), source });
  }
  return out;
}

const CD_BTN_STYLE = "margin-left:8px;padding:1px 8px;border:1px solid #0c65f4;border-radius:6px;background:#fff;color:#0c65f4;font:12px system-ui,sans-serif;cursor:pointer;white-space:nowrap;";

function cdMarkRows() {
  let marked = 0;
  for (const { source, name } of cdStepRows()) {
    const hit = CD.cache.get(name);
    if (!hit) continue;
    marked++;
    if (source.querySelector(".nb-copy")) continue;
    const b = document.createElement("button");
    b.className = "nb-copy";
    b.textContent = "Copy with values";
    b.style.cssText = CD_BTN_STYLE;
    b.title = `Copies this Database step's code with the variables as they are now (Variables tab) written in as PL/SQL literals. Code from: ${hit.source}`;
    b.onclick = async (e) => {
      e.stopPropagation(); e.preventDefault();
      b.textContent = "Reading variables…";
      const vars = await cdReadVariables();
      if (!vars) { b.textContent = "Open the Diagnostic panel"; setTimeout(() => { b.textContent = "Copy with values"; }, 2500); return; }
      try { await navigator.clipboard.writeText(PlsqlTestScript.inlineBinds(hit.sql, vars)); b.textContent = "Copied"; } catch { b.textContent = "Copy failed"; }
      setTimeout(() => { b.textContent = "Copy with values"; }, 2000);
    };
    source.appendChild(b);
  }
  return marked;
}

async function cdScan() {
  if (CD.scanning) return;
  CD.scanning = true;
  const btn = CD.button;
  const say = (text, title) => {
    if (!btn) return;
    btn.textContent = text; btn.title = title || "";
    CD.details = title || "";
    if (CD.detailsButton) CD.detailsButton.style.display = title ? "" : "none";
  };
  try {
    const p = cdPanel();
    const crumb = p && cdBreadcrumb(p);
    const rows = cdStepRows();
    if (!crumb) { say("Flow name not found (click to retry)", "The Diagnostic panel shows no flow name."); return; }
    if (!rows.length) { say("No logged steps yet (click to retry)", "Run the flow with tracing on (Trace steps), then press again."); return; }
    const missing = [...new Set(rows.map((r) => r.name))].filter((n) => !CD.cache.has(n));
    let tried = [];
    if (missing.length) {
      say("Searching PL/SQL steps…");
      const vars = (await cdReadVariables()) || {};
      const lit = (k) => (vars[k] || "").replace(/^"([\s\S]*)"$/, "$1");
      const res = await chrome.runtime.sendMessage({
        type: "STEP_SQL_MANY", flowName: crumb.flow, stepNames: missing, versions: cdVersions(),
        envName: lit("environment__environmentName"), envType: lit("environment__environmentType")
      }).catch((e) => ({ ok: false, error: e.message }));
      if (!res || !res.ok) { say("PL/SQL info: " + ((res && res.error) || "failed") + " (click to retry)", (res && res.error) || ""); return; }
      tried = res.tried || [];
      for (const n of missing) CD.cache.set(n, res.steps[n] || false); // false: not a Database step, not asked again
    }
    const found = cdMarkRows();
    say(found ? `PL/SQL info added (${new Set(rows.filter((r) => CD.cache.get(r.name)).map((r) => r.name)).size})` : "No Database steps found", tried.join("\n"));
    cdWatch();
  } catch (e) {
    say("PL/SQL info failed (click to retry)", String(e && e.message || e));
  } finally {
    CD.scanning = false;
  }
}

/** After the button was pressed only: new log rows get their button too (until the log table goes away). */
function cdWatch() {
  if (CD.observer) return;
  const table = document.querySelector(".diagnosticLogTable");
  if (!table) return;
  let timer = null;
  CD.observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!document.body.contains(table)) { CD.observer.disconnect(); CD.observer = null; if (CD.button) CD.button.textContent = CD_LABEL; return; }
      if (!CD.scanning) cdScan();
    }, 700);
  });
  CD.observer.observe(table, { childList: true, subtree: true });
}

/** Places the one button in the Trace Logs toolbar (next to "Clear logs"). */
function cdDock() {
  const toolbar = document.querySelector(".diagnosticLogTraceToolbar");
  if (!toolbar || toolbar.querySelector("#nb-plsql")) return;
  const b = document.createElement("button");
  b.id = "nb-plsql";
  b.textContent = CD_LABEL;
  b.title = "Finds the Database steps in this log, reads their PL/SQL from the flow's designer data and adds a Copy with values button to their rows. Nothing is looked up before you press this.";
  b.style.cssText = "margin-left:8px;padding:6px 12px;border:1px solid #0c65f4;border-radius:6px;background:#0c65f4;color:#fff;font:13px system-ui,sans-serif;cursor:pointer;white-space:nowrap;";
  b.onclick = (e) => { e.stopPropagation(); b.textContent = "Searching PL/SQL steps…"; cdScan(); };
  CD.button = b;
  const d = document.createElement("button");
  d.textContent = "Copy details";
  d.title = "Copies what the lookup tried (calls and results, no values) so it can be sent to the developer.";
  d.style.cssText = "display:none;margin-left:6px;padding:6px 10px;border:1px solid #9ca3af;border-radius:6px;background:#fff;color:#4b5563;font:12px system-ui,sans-serif;cursor:pointer;white-space:nowrap;";
  d.onclick = async (e) => { e.stopPropagation(); try { await navigator.clipboard.writeText(CD.details || ""); d.textContent = "Copied"; } catch { d.textContent = "Copy failed"; } setTimeout(() => { d.textContent = "Copy details"; }, 2000); };
  CD.detailsButton = d;
  toolbar.append(b, d);
}

// No polling: the button is placed after a click anywhere (opening the panel or its tab is a click)
// and once or twice shortly after the page loaded.
let cdDockTimer = null;
addEventListener("click", () => { clearTimeout(cdDockTimer); cdDockTimer = setTimeout(cdDock, 400); }, true);
setTimeout(cdDock, 3000);
setTimeout(cdDock, 8000);
