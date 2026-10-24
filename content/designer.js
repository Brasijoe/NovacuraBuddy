// Injected into build.novacura.com Designer tabs. Clicks the Designer's own "reload document"
// button so a module the extension just added shows up without a full page reload.
// Real markup (2026-10-16, user-supplied DOM):
//   <app-refresh-button ...><button aria-label="Refresh" class="... disabled:text-disabled">
//     <app-colored-svg><div style="mask-image: url(&quot;assets/icons/arrows-clockwise.svg&quot;)"></div></app-colored-svg>
//   </button></app-refresh-button>
// The button can be disabled until the Designer notices the remote document changed — clicking it
// then does nothing — so this waits briefly for it to enable. The background falls back to a full
// tab reload when this reports clicked: false.
const WAIT_FOR_ENABLED_MS = 5000;
const POLL_MS = 250;

function findRefreshButton() {
  const candidates = [
    ...document.querySelectorAll("app-refresh-button button"),
    ...document.querySelectorAll('button[aria-label="Refresh"]'),
    ...[...document.querySelectorAll('[style*="arrows-clockwise.svg"]')].map((icon) => icon.closest("button"))
  ];
  return candidates.find((b) => b && b.offsetParent !== null) || null; // first visible one
}

async function clickRefreshWhenEnabled() {
  const deadline = Date.now() + WAIT_FOR_ENABLED_MS;
  for (;;) {
    const button = findRefreshButton();
    if (button && !button.disabled) {
      button.click();
      return { clicked: true };
    }
    if (Date.now() >= deadline) return { clicked: false, reason: button ? "button stayed disabled" : "button not found" };
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "CLICK_REFRESH") return;
  clickRefreshWhenEnabled()
    .then(sendResponse)
    .catch(() => sendResponse({ clicked: false, reason: "error" }));
  return true; // keep the channel open for the async response
});

// --- Module Compare marks -------------------------------------------------------------------
// Marks the steps of the open flow that the last Module Compare scan found affected by changed
// module code: a list in the corner and a badge on each step on the canvas. Read-only: nothing is
// drawn into the Designer's own markup (our layer sits on top), nothing is saved to the flow.
// Steps are found on the canvas by their id in an attribute, else by their label text.
const MC_DESIGNER_URL_RE = /\/admin\/design\/designer\/organizations\/([^/]+)\/items\/([^/?#]+)/;
const MC_COLORS = { critical: "#ff3333", major: "#fd6e15", minor: "#0c65f4", info: "#6b7280" };
const MC_SEVERITY = { critical: "Critical", major: "Major", minor: "Minor", info: "Info" };
const mc = { key: null, marks: null, collapsed: false, hidden: false, host: null, root: null, layer: null, targets: new Map() };

function mcEnsureHost() {
  if (mc.host) return;
  mc.host = document.createElement("div");
  mc.host.id = "novacura-buddy-module-compare";
  mc.root = mc.host.attachShadow({ mode: "open" });
  mc.root.innerHTML = `<style>
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; }
    .outline { position: fixed; border: 2px solid; border-radius: 8px; box-sizing: border-box; pointer-events: none; }
    .badge { position: fixed; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; color: #fff; font: 700 11px/18px system-ui, sans-serif; text-align: center; pointer-events: auto; cursor: help; box-shadow: 0 1px 3px rgba(0,0,0,.3); }
    .panel { position: fixed; right: 16px; bottom: 16px; width: 340px; max-height: 50vh; display: flex; flex-direction: column; background: #fff; color: #141635; border: 1px solid #d9dcef; border-radius: 12px; box-shadow: 0 8px 28px rgba(20,22,53,.22); font: 13px/1.4 system-ui, sans-serif; z-index: 2147483001; pointer-events: auto; }
    .head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid #eceef8; cursor: pointer; }
    .head b { flex: 1; }
    .count { min-width: 20px; height: 20px; border-radius: 10px; background: #ff3333; color: #fff; font-weight: 700; font-size: 11px; display: inline-flex; align-items: center; justify-content: center; padding: 0 6px; }
    .count.orange { background: #fd6e15; }
    button { font: inherit; border: none; background: none; cursor: pointer; color: #6b7280; padding: 2px 6px; border-radius: 6px; }
    button:hover { background: #f1f2fa; color: #141635; }
    .list { overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 4px; }
    .row { border: 1px solid #eceef8; border-left: 4px solid; border-radius: 8px; padding: 6px 8px; cursor: pointer; }
    .row:hover { background: #f7f8fd; }
    .row .name { font-weight: 600; }
    .row .missing { color: #6b7280; font-size: 11px; }
    .use { font-size: 12px; margin-top: 2px; }
    .use code { font: 11.5px ui-monospace, monospace; overflow-wrap: anywhere; word-break: break-all; }
    .finding { font-size: 11.5px; color: #4b5068; }
    .sev { display: inline-block; padding: 0 6px; border-radius: 8px; color: #fff; font-size: 10.5px; font-weight: 600; margin-right: 4px; }
    .foot { padding: 6px 10px; border-top: 1px solid #eceef8; font-size: 11.5px; color: #6b7280; display: flex; justify-content: space-between; align-items: center; }
    .foot a { color: #0c65f4; cursor: pointer; }
    @keyframes flash { 0%, 100% { opacity: 1; } 50% { opacity: .2; } }
    .flash { animation: flash .4s ease-in-out 3; }
    @media (prefers-color-scheme: dark) {
      .panel { background: #1b1d3a; color: #eef0ff; border-color: #33365c; }
      .head, .foot { border-color: #33365c; } .row { border-color: #33365c; } .row:hover { background: #24274a; }
      .finding, .row .missing, .foot { color: #a9acc9; } button:hover { background: #2a2d52; color: #fff; }
    }
  </style><div class="layer"></div><div class="panel" hidden></div>`;
  mc.layer = mc.root.querySelector(".layer");
  document.documentElement.appendChild(mc.host);
}

/** The canvas element of a step: by its id in an attribute, else every element showing its label. */
function mcFindTargets(step) {
  const esc = (v) => (window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/"/g, '\\"'));
  const byId = document.querySelector(["id", "data-id", "data-step-id", "data-node-id", "data-element-id"].map((a) => `[${a}="${esc(step.id)}"]`).join(","));
  if (byId && !mc.host.contains(byId)) return [byId];
  const label = String(step.label || "").trim();
  if (!label) return [];
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeValue.trim() !== label) continue;
    let el = n.parentElement;
    if (!el || el.closest("#novacura-buddy-module-compare")) continue;
    // Climb to the step's box: the nearest ancestor of a node-like size.
    for (let i = 0; i < 4 && el.parentElement; i++) {
      const r = el.getBoundingClientRect();
      if (r.width >= 60 && r.height >= 28) break;
      el = el.parentElement;
    }
    out.push(el);
  }
  return out;
}

function mcPlace() {
  if (!mc.layer) return;
  mc.layer.innerHTML = "";
  if (!mc.marks || mc.hidden) return;
  for (const step of mc.marks.steps) {
    const color = MC_COLORS[step.severity] || MC_COLORS.minor;
    for (const el of mc.targets.get(step.id) || []) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) continue;
      const outline = document.createElement("div");
      outline.className = "outline";
      Object.assign(outline.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px`, borderColor: color });
      const badge = document.createElement("div");
      badge.className = "badge";
      badge.textContent = step.uses.length > 1 ? `! ${step.uses.length}` : "!";
      badge.title = mcStepText(step);
      Object.assign(badge.style, { left: `${r.right - 8}px`, top: `${r.top - 10}px`, background: color });
      mc.layer.append(outline, badge);
    }
  }
}

function mcStepText(step) {
  return [`${MC_SEVERITY[step.severity] || ""} — ${step.label}`,
    ...step.uses.flatMap((u) => [`${u.module}.${u.name} (${MC_SEVERITY[u.severity] || u.status})`, ...u.findings.map((f) => `  • ${f.text}`)])].join("\n");
}

function mcRenderPanel() {
  mcEnsureHost();
  const panel = mc.root.querySelector(".panel");
  panel.hidden = !mc.marks || !mc.marks.steps.length || mc.hidden;
  if (panel.hidden) return;
  const impacted = mc.marks.steps.filter((s) => s.status === "impacted").length;
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  panel.innerHTML = "";
  const head = h("div", "head");
  const count = h("span", `count${impacted ? "" : " orange"}`, String(mc.marks.steps.length));
  count.title = `${impacted} impacted, ${mc.marks.steps.length - impacted} with minor changes`;
  const toggle = h("button", null, mc.collapsed ? "▴" : "▾");
  const close = h("button", null, "✕");
  close.title = "Hide the marks for this flow (until the page is reloaded)";
  head.append(count, h("b", null, "Steps affected by module changes"), toggle, close);
  head.onclick = (e) => { if (e.target === close) return; mc.collapsed = !mc.collapsed; mcRenderPanel(); };
  close.onclick = () => { mc.hidden = true; mcRenderPanel(); mcPlace(); };
  panel.append(head);
  if (mc.collapsed) return;
  const list = h("div", "list");
  for (const step of mc.marks.steps) {
    const row = h("div", "row");
    row.style.borderLeftColor = MC_COLORS[step.severity] || MC_COLORS.minor;
    const name = h("div", "name");
    const sev = h("span", "sev", MC_SEVERITY[step.severity] || "Changed");
    sev.style.background = MC_COLORS[step.severity] || MC_COLORS.minor;
    name.append(sev, step.label);
    row.append(name);
    if (!(mc.targets.get(step.id) || []).length) row.append(h("div", "missing", "Not found on the canvas"));
    for (const u of step.uses) {
      const use = h("div", "use");
      use.append("uses ", h("code", null, `${u.module}.${u.name}`));
      row.append(use);
      for (const f of u.findings.slice(0, 2)) row.append(h("div", "finding", `• ${f.text}`));
    }
    row.title = mcStepText(step);
    row.onclick = () => {
      const el = (mc.targets.get(step.id) || [])[0];
      if (!el) return;
      el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
      setTimeout(() => { mcPlace(); mc.layer.querySelectorAll(".outline").forEach((o) => o.classList.add("flash")); }, 400);
    };
    list.append(row);
  }
  panel.append(list);
  const foot = h("div", "foot");
  foot.append(`Module Compare scan ${new Date(mc.marks.scannedAt).toLocaleString()}`);
  const open = h("a", null, "Open results");
  open.onclick = () => chrome.runtime.sendMessage({ type: "MC_OPEN_RESULTS", ...mc.marks.scan }).catch(() => {});
  foot.append(open);
  panel.append(foot);
}

function mcLocate() {
  mc.targets = new Map();
  if (mc.marks) for (const step of mc.marks.steps) mc.targets.set(step.id, mcFindTargets(step));
}

async function mcRefresh(force) {
  const m = MC_DESIGNER_URL_RE.exec(location.href);
  const key = m ? `${m[1]}/${m[2]}` : null;
  if (!force && key === mc.key) return;
  if (key !== mc.key) mc.hidden = false;
  mc.key = key;
  mc.marks = null;
  if (m) {
    const res = await chrome.runtime.sendMessage({ type: "MC_FLOW_MARKS", orgId: m[1], itemId: m[2] }).catch(() => null);
    if (mc.key !== key) return;
    mc.marks = res && res.ok ? res.marks : null;
  }
  mcLocate();
  mcRenderPanel();
  mcPlace();
}

mcRefresh();
setInterval(() => {
  mcRefresh(false);
  if (!mc.marks || mc.hidden) return;
  // The canvas re-renders and moves (pan, zoom, edits): find the steps again and redraw.
  mcLocate();
  mcPlace();
}, 1000);
addEventListener("scroll", () => mcPlace(), true);
addEventListener("resize", () => mcPlace());
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.moduleCompareMarks) mcRefresh(true); });
setInterval(() => { if (mc.marks && !mc.hidden) mcPlace(); }, 300);
