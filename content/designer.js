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

/** Every root to search: the document, open shadow roots and same-origin iframes, at any depth. */
function mcRoots() {
  const roots = [document];
  for (let i = 0; i < roots.length && i < 200; i++) {
    const root = roots[i];
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot && el.shadowRoot !== mc.root) roots.push(el.shadowRoot);
      if (el.tagName === "IFRAME") { try { if (el.contentDocument) roots.push(el.contentDocument); } catch { /* cross-origin */ } }
    }
  }
  return roots;
}

const mcNorm = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
const MC_LABEL_ATTRS = ["title", "aria-label", "data-name", "data-label", "name"];
const MC_ID_ATTRS = ["id", "data-id", "data-step-id", "data-node-id", "data-element-id", "data-item-id", "model-id", "data-model-id"];

/** Climbs from a matched element to the step's box: the nearest ancestor of a node-like size. */
function mcBox(el) {
  for (let i = 0; i < 5 && el.parentElement; i++) {
    const r = el.getBoundingClientRect();
    if (r.width >= 60 && r.height >= 28) break;
    el = el.parentElement;
  }
  return el;
}

/** The canvas elements of a step: by its id in an attribute, else by its label (exact text, a
 *  text that starts with it, or a title/aria-label), searched through shadow roots and frames. */
function mcFindTargets(step, roots) {
  const label = mcNorm(step.label);
  const exact = [], prefix = [];
  for (const root of roots) {
    for (const attr of MC_ID_ATTRS) {
      const hit = root.querySelector(`[${attr}="${String(step.id).replace(/"/g, '\\"')}"]`);
      if (hit && !(mc.host && mc.host.contains(hit))) return [hit];
    }
    if (!label) continue;
    const walker = (root.ownerDocument || root).createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = mcNorm(n.nodeValue);
      if (!t || !n.parentElement || /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/.test(n.parentElement.tagName)) continue;
      if (t === label) exact.push(mcBox(n.parentElement));
      else if (t.startsWith(label) && t.length <= label.length + 40) prefix.push(mcBox(n.parentElement));
    }
    for (const attr of MC_LABEL_ATTRS) {
      for (const el of root.querySelectorAll(`[${attr}]`)) if (mcNorm(el.getAttribute(attr)) === label) exact.push(mcBox(el));
    }
  }
  const found = exact.length ? exact : prefix;
  return [...new Set(found)].filter((el) => !(el.closest && el.closest("#novacura-buddy-module-compare")));
}

/** What the page is made of, for finding out why steps aren't found (copied for the developer). */
function mcDiagnostics() {
  const roots = mcRoots();
  const tags = new Map();
  let canvases = [], svgs = 0, texts = [];
  for (const root of roots) {
    for (const el of root.querySelectorAll("*")) {
      const tag = el.tagName.toLowerCase();
      if (tag.includes("-")) tags.set(tag, (tags.get(tag) || 0) + 1);
      if (tag === "canvas") { const r = el.getBoundingClientRect(); canvases.push(`${Math.round(r.width)}x${Math.round(r.height)}`); }
      if (tag === "svg") svgs++;
    }
  }
  const path = (el) => { const out = []; for (let e = el, i = 0; e && i < 7; e = e.parentElement, i++) out.unshift(e.tagName.toLowerCase() + (e.id ? `#${e.id}` : "") + (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\s+/).slice(0, 3).join(".") : "")); return out.join(" > "); };
  for (const step of (mc.marks && mc.marks.steps) || []) {
    const word = mcNorm(step.label).split(" ")[0];
    let shown = 0;
    for (const root of roots) {
      const walker = (root.ownerDocument || root).createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n && shown < 3; n = walker.nextNode()) {
        if (word && mcNorm(n.nodeValue).includes(word) && n.parentElement && !/^(SCRIPT|STYLE|NOSCRIPT)$/.test(n.parentElement.tagName)) {
          texts.push(`"${step.label}" ~ "${n.nodeValue.trim().slice(0, 60)}" @ ${path(n.parentElement)}`);
          shown++;
        }
      }
    }
    if (!shown) texts.push(`"${step.label}" (id ${step.id}): no text containing "${word}"`);
  }
  const attrsWithIds = [];
  for (const step of (mc.marks && mc.marks.steps) || []) {
    for (const root of roots) for (const el of root.querySelectorAll("*")) {
      for (const at of el.attributes || []) if (at.value && at.value.includes(step.id)) attrsWithIds.push(`${step.id} in ${el.tagName.toLowerCase()}[${at.name}]`);
    }
  }
  return [
    `NovacuraBuddy Designer diagnostics ${new Date().toISOString()}`,
    `url: ${location.pathname}`,
    `roots: ${roots.length} (shadow roots/frames), iframes: ${document.querySelectorAll("iframe").length}, svg: ${svgs}, canvas: ${canvases.join(", ") || "none"}`,
    `custom elements: ${[...tags].sort((x, y) => y[1] - x[1]).slice(0, 40).map(([t, n]) => `${t}(${n})`).join(" ")}`,
    "label search:", ...texts,
    "step ids in attributes:", ...(attrsWithIds.slice(0, 20).length ? attrsWithIds.slice(0, 20) : ["none"]),
    `canvas texts (${mc.canvas ? mc.canvas.texts.length : "none reported"}): ${mc.canvas ? mc.canvas.texts.slice(0, 40).map((t) => `"${t.text.slice(0, 30)}"@${Math.round(t.left)},${Math.round(t.top)}`).join(" ") : ""}`
  ].join("\n");
}


// The Designer draws its flow on a <canvas>: content/canvas-hook.js (in the page) reports where
// every text is drawn. A step is found there by its name (also when the canvas cuts it short with
// "…"); the mark is drawn around the name.
mc.canvas = null; // { canvas: rect, texts: [{ text, left, top, width, height }] }
addEventListener("novacura-buddy-canvas-texts", (e) => {
  try { mc.canvas = JSON.parse(e.detail); } catch { return; }
  if (!mc.marks || mc.hidden) return;
  const missingBefore = mc.marks.steps.filter((st) => !(mc.targets.get(st.id) || []).length).length;
  mcLocate();
  mcPlace();
  if (mc.marks.steps.filter((st) => !(mc.targets.get(st.id) || []).length).length !== missingBefore) mcRenderPanel();
});
dispatchEvent(new CustomEvent("novacura-buddy-canvas-ask"));

const MC_PAD = { x: 14, y: 12 }; // from the drawn name out to roughly the step's box

function mcCanvasTargets(step) {
  if (!mc.canvas) return [];
  const label = mcNorm(step.label);
  if (!label) return [];
  const hits = mc.canvas.texts.filter((t) => {
    const text = mcNorm(t.text);
    const cut = text.replace(/(…|\.\.\.)$/, "").trim();
    return text === label || (cut !== text && cut.length >= 4 && label.startsWith(cut));
  });
  return hits.map((t) => ({
    canvasText: true,
    rect: () => ({ left: t.left - MC_PAD.x, top: t.top - MC_PAD.y, width: t.width + 2 * MC_PAD.x, height: t.height + 2 * MC_PAD.y, right: t.left + t.width + MC_PAD.x, bottom: t.top + t.height + MC_PAD.y })
  }));
}

/** A target's box on screen (an element, or a name drawn on the canvas). */
const mcRect = (target) => (target.canvasText ? target.rect() : target.getBoundingClientRect());

/** Scrolls a step into view, flashes its outline and selects it with a click, as the user would. */
function mcFocusStep(stepId) {
  const target = (mc.targets.get(stepId) || [])[0];
  if (!target) return false;
  const flash = () => {
    mcPlace();
    mc.layer.querySelectorAll(`[data-step="${stepId}"]`).forEach((o) => { o.classList.remove("flash"); void o.offsetWidth; o.classList.add("flash"); });
  };
  // Select the step the way a user does: a click on it (on the canvas, at the drawn name).
  const clickAt = (r) => {
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const el = target.canvasText ? document.elementFromPoint(x, y) : target;
    if (!el || (mc.host && mc.host.contains(el))) return;
    const opts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true, view: window };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      el.dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type, opts) : new MouseEvent(type, { ...opts, buttons: type.endsWith("down") ? 1 : 0 }));
    }
  };
  if (!target.canvasText) {
    target.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    setTimeout(() => { clickAt(target.getBoundingClientRect()); flash(); }, 450);
    return true;
  }
  const box = mc.canvas.canvas;
  const r = mcRect(target);
  const inView = r.left >= box.left && r.top >= box.top && r.right <= box.left + box.width && r.bottom <= box.top + box.height;
  if (!inView) {
    // Off screen: ask the canvas to scroll towards it (mouse-wheel panning); the next redraw
    // reports the new position and the step is focused from there.
    const canvas = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (canvas) {
      const dx = r.left + r.width / 2 - (box.left + box.width / 2), dy = r.top + r.height / 2 - (box.top + box.height / 2);
      canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, deltaX: dx, deltaY: dy, deltaMode: 0 }));
    }
    setTimeout(() => { mcLocate(); const t = (mc.targets.get(stepId) || [])[0]; if (t) { clickAt(mcRect(t)); } flash(); }, 500);
    return true;
  }
  clickAt(r);
  flash();
  return true;
}

function mcPlace() {
  if (!mc.layer) return;
  mc.layer.innerHTML = "";
  if (!mc.marks || mc.hidden) return;
  for (const step of mc.marks.steps) {
    const color = MC_COLORS[step.severity] || MC_COLORS.minor;
    for (const target of mc.targets.get(step.id) || []) {
      if (!target.canvasText && !target.isConnected) continue;
      const r = mcRect(target);
      if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) continue;
      const outline = document.createElement("div");
      outline.className = "outline";
      outline.dataset.step = step.id;
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
    row.onclick = () => { mcLocate(); mcFocusStep(step.id); };
    list.append(row);
  }
  panel.append(list);
  const foot = h("div", "foot");
  foot.append(`Module Compare scan ${new Date(mc.marks.scannedAt).toLocaleString()}`);
  const open = h("a", null, "Open results");
  open.onclick = () => chrome.runtime.sendMessage({ type: "MC_OPEN_RESULTS", ...mc.marks.scan }).catch(() => {});
  foot.append(open);
  panel.append(foot);
  if (mc.marks.steps.some((st) => !(mc.targets.get(st.id) || []).length)) {
    const diag = h("div", "foot");
    diag.append("Some steps were not found on the canvas.");
    const copy = h("a", null, "Copy page info");
    copy.title = "Copies a description of how this page draws its steps (tags, where the step names are) to send to the developer";
    copy.onclick = async () => {
      const probe = await chrome.runtime.sendMessage({ type: "MC_PAGE_PROBE" }).catch((e) => ({ ok: false, error: e.message }));
      const locations = mc.marks.steps.map((st) => `${st.label}: location ${JSON.stringify(st.location)}`);
      const text = [mcDiagnostics(), "step locations:", ...locations, "page probe:", probe && probe.ok ? probe.text : `failed: ${probe && probe.error}`].join("\n");
      try { await navigator.clipboard.writeText(text); copy.textContent = "Copied"; }
      catch { copy.textContent = "Copy failed"; }
    };
    diag.append(copy);
    panel.append(diag);
  }
}

function mcLocate() {
  mc.targets = new Map();
  if (!mc.marks) return;
  const roots = mcRoots();
  for (const step of mc.marks.steps) {
    const found = mcFindTargets(step, roots);
    mc.targets.set(step.id, found.length ? found : mcCanvasTargets(step));
  }
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
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.moduleCompareMarks) mcRefresh(true);
  if (area === "local" && changes.mcFocusRequest) mcFocusPending();
});

// "Open the step" from the results page: the background stores { orgId, flowId, stepId, at } and
// opens or activates this flow's tab; the step is focused once it is drawn (tried for 20s).
async function mcFocusPending() {
  const { mcFocusRequest: req } = await chrome.storage.local.get("mcFocusRequest");
  const m = MC_DESIGNER_URL_RE.exec(location.href);
  if (!req || !m || req.flowId !== m[2] || Date.now() - req.at > 60000) return;
  await chrome.storage.local.remove("mcFocusRequest");
  if (!req.stepId) return;
  mc.hidden = false;
  for (let i = 0; i < 40; i++) {
    await mcRefresh(true);
    mcLocate();
    if (mcFocusStep(req.stepId)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}
mcFocusPending();
setInterval(() => { if (mc.marks && !mc.hidden) mcPlace(); }, 300);
