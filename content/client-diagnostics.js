// Injected into the Flow web client (app.novacura.com). While the Diagnostic panel is open and the
// current step is a Database step, a button copies the step's PL/SQL with the variables from the
// panel's Variables tab written in as literals. The SQL is not in the client or the trace log: the
// extension reads it from the flow's designer data (see lib/flow-step-sql.js). Read-only.
const CD = { host: null, root: null, cache: new Map(), key: null, state: null };
const CD_APP_RE = /\/apps\/v1\/appPackages\/[^/]+\/versions\/[^/]+\/apps\/([^/]+)\/versions\/([^/?#]+)/;

function cdPanel() {
  const heading = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,div,span,p")].find((e) => e.children.length === 0 && e.textContent.trim() === "Diagnostic panel");
  if (!heading) return null;
  let panel = heading;
  for (let i = 0; i < 6 && panel.parentElement; i++) {
    panel = panel.parentElement;
    if (panel.querySelector("table, .mud-tabs, [role=tablist]")) break;
  }
  return { heading, panel };
}

/** "Flow / Step" shown under the panel title. */
function cdBreadcrumb(p) {
  const el = [...p.panel.querySelectorAll("*")].find((e) => e.children.length === 0 && / \/ /.test(e.textContent) && e.textContent.length < 200);
  return el ? FlowStepSql.parseBreadcrumb(el.textContent) : null;
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
function cdVariables(p) {
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
    if (/^record$/i.test(type)) { stack.push({ left, name }); continue; }
    values[[...stack.map((s) => s.name), name.replace(/\s*\(\d+\)$/, "")].join("__")] = cdFlowLiteral(cells[cells.length - 2].textContent, type);
  }
  return values;
}

function cdEnsureHost() {
  if (CD.host) return;
  CD.host = document.createElement("div");
  CD.host.id = "novacura-buddy-client";
  CD.root = CD.host.attachShadow({ mode: "open" });
  CD.root.innerHTML = `<style>
    :host { all: initial; }
    .bar { position: fixed; left: 16px; bottom: 16px; z-index: 2147483002; display: flex; align-items: center; gap: 6px; background: #fff; color: #141635; border: 1px solid #d9dcef; border-radius: 10px; padding: 6px 8px; box-shadow: 0 6px 22px rgba(20,22,53,.22); font: 13px/1.3 system-ui, sans-serif; }
    button { font: inherit; border: 1px solid #0c65f4; background: #0c65f4; color: #fff; border-radius: 7px; padding: 4px 10px; cursor: pointer; }
    button.ghost { background: none; color: #6b7280; border-color: #d1d5db; padding: 4px 8px; }
    .note { font-size: 11.5px; color: #6b7280; max-width: 340px; }
    @media (prefers-color-scheme: dark) { .bar { background: #1b1d3a; color: #eef0ff; border-color: #33365c; } .note { color: #a9acc9; } }
  </style><div class="bar" hidden></div>`;
  document.documentElement.appendChild(CD.host);
}

function cdRender() {
  cdEnsureHost();
  const bar = CD.root.querySelector(".bar");
  const st = CD.state;
  const sig = st ? `${st.kind}|${st.key}|${st.error || ""}` : "";
  if (bar.dataset.sig === sig) return;
  bar.dataset.sig = sig;
  bar.hidden = !st;
  bar.innerHTML = "";
  if (!st) return;
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
  if (st.kind === "sql") {
    const copy = h("button", null, "Copy with values");
    copy.title = `Copies this Database step's code with the variables from the Variables tab written in as PL/SQL literals ('text', 12, NULL, TO_DATE(...)). Code from: ${st.source}`;
    copy.onclick = async () => {
      const p = cdPanel();
      const vars = p && cdVariables(p);
      if (!vars) { copy.textContent = "Open the Variables tab first"; setTimeout(() => { copy.textContent = "Copy with values"; }, 2500); return; }
      try { await navigator.clipboard.writeText(PlsqlTestScript.inlineBinds(st.sql, vars)); copy.textContent = "Copied"; } catch { copy.textContent = "Copy failed"; }
      setTimeout(() => { copy.textContent = "Copy with values"; }, 2000);
    };
    bar.append(copy, h("span", "note", `Database step "${st.step}"`));
  } else {
    bar.append(h("span", "note", st.error));
    if (st.tried) {
      const details = h("button", "ghost", "Copy details");
      details.onclick = async () => { try { await navigator.clipboard.writeText(st.tried.join("\n")); details.textContent = "Copied"; } catch { details.textContent = "Copy failed"; } };
      bar.append(details);
    }
  }
}

async function cdTick() {
  const p = cdPanel();
  const crumb = p && cdBreadcrumb(p);
  if (!crumb) { CD.key = null; CD.state = null; cdRender(); return; }
  const key = `${crumb.flow}|${crumb.step}`;
  if (key === CD.key) { cdRender(); return; }
  CD.key = key;
  CD.state = null;
  cdRender();
  let res = CD.cache.get(key);
  if (!res) {
    const vars = cdVariables(p) || {};
    const envLiteral = vars.environment__environmentName || vars.environment__environmentType || "";
    const envName = envLiteral.replace(/^"([\s\S]*)"$/, "$1");
    res = await chrome.runtime.sendMessage({ type: "STEP_SQL", flowName: crumb.flow, stepName: crumb.step, versions: cdVersions(), envName }).catch((e) => ({ ok: false, error: e.message }));
    if (res && res.ok) CD.cache.set(key, res);
  }
  if (CD.key !== key) return;
  if (res && res.ok && res.sql !== undefined) CD.state = { kind: "sql", key, sql: res.sql, source: res.source, step: crumb.step };
  else if (res && res.ok === false && res.notDatabase) CD.state = null; // a step that is not a Database step: nothing to offer
  else CD.state = { kind: "error", key, error: (res && res.error) || "SQL not available", tried: res && res.tried };
  cdRender();
}

setInterval(() => { cdTick().catch(() => {}); }, 800);
