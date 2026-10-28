// Injected into the Flow web client (app.novacura.com). Idle until the Step Recorder is started in the side
// panel: only then does it listen (capture phase) for clicks and for finished inputs and report each one to the
// background worker, which takes the screenshot. Password values are never read. Nothing is sent anywhere
// else; steps stay in the browser's extension storage.
(function () {
  if (window.__nbStepRecorder) return;
  const SR = { armed: false };
  window.__nbStepRecorder = SR;

  const text = (el) => (el && (el.getAttribute("aria-label") || el.innerText || el.textContent || "") || "").replace(/\s+/g, " ").trim().slice(0, 120);

  function labelOf(el) {
    if (!el) return "";
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return text(l); }
    const wrap = el.closest("label");
    if (wrap) return text(wrap);
    const by = el.getAttribute("aria-labelledby");
    if (by) { const t = by.split(/\s+/).map((id) => text(document.getElementById(id))).filter(Boolean).join(" "); if (t) return t; }
    const own = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder");
    if (own) return own.trim();
    // Nearest preceding text in the same field container, the way the web client lays out prompts above inputs.
    for (let p = el.parentElement, depth = 0; p && depth < 4; p = p.parentElement, depth++) {
      const l = p.querySelector("label, [class*='label' i], [class*='prompt' i]");
      if (l && !l.contains(el)) return text(l);
    }
    return "";
  }

  function screenTitle() {
    const h = [...document.querySelectorAll("h1, h2, [role='heading']")].find((e) => e.offsetParent !== null && text(e));
    return h ? text(h) : "";
  }

  const INTERACTIVE = "button, a[href], [role='button'], [role='link'], [role='menuitem'], [role='tab'], [role='option'], [role='switch'], [role='checkbox'], [role='radio'], input, textarea, select, summary";

  /** The control a click hit: a real control, a data row of a grid, or an element the cursor shows as clickable. Never an ancestor that merely has text. */
  function controlOf(raw) {
    const hit = raw.closest(INTERACTIVE);
    if (hit) return hit;
    const row = raw.closest("tr, [role='row']");
    if (row && row.closest("table, [role='grid'], [role='table'], [role='listbox']") && !row.querySelector("th")) return row;
    if (getComputedStyle(raw).cursor === "pointer") {
      let el = raw;
      while (el.parentElement && el.parentElement !== document.body && getComputedStyle(el.parentElement).cursor === "pointer") el = el.parentElement;
      return el;
    }
    return null;
  }

  function describe(ev, kind) {
    const raw = ev.target instanceof Element ? ev.target : null;
    if (!raw) return null;
    const el = controlOf(raw);
    if (!el) return null; // a click that hit no control (empty page area) is not a step
    const tag = el.tagName.toLowerCase();
    const row = raw.closest("tr, [role='row'], [role='option']");
    const grid = row && row.closest("table, [role='grid'], [role='listbox'], [role='table']");
    const info = { event: kind, tag, role: el.getAttribute("role") || "", type: el.getAttribute("type") || (tag === "input" ? "text" : ""), label: text(el), prompt: labelOf(el) };
    if (kind === "change") {
      info.checked = !!el.checked || el.getAttribute("aria-checked") === "true";
      info.value = el.type === "password" ? "" : el.value;
      if (el.type === "password") info.value = "x"; // only to pass the empty check; masked by classify
    }
    if (row && grid && !/^(button|a|input)$/.test(tag)) {
      const cells = [...row.children];
      const cell = raw.closest("td, th, [role='cell'], [role='gridcell']");
      info.rowKey = text(cells[0]);
      const idx = cell ? cells.indexOf(cell) : 0;
      const head = grid.querySelectorAll("th, [role='columnheader']")[Math.max(idx, 0)];
      info.columnHeader = text(head);
      info.listTitle = text(grid) && text(grid).length < 60 ? text(grid) : (grid.getAttribute("aria-label") || "");
      const dialog = grid.closest("[role='dialog'], [role='listbox'], [class*='lov' i], [class*='lookup' i]");
      if (dialog) { info.inLov = true; info.prompt = info.prompt || text(dialog.querySelector("h1, h2, h3, [role='heading']")); } else info.inList = true;
      info.review = true; // layout guessed, not yet verified against the real web client
    }
    if (kind === "click" && !info.rowKey && (info.label.length > 80 || !info.label) && !/^(input|textarea|select)$/.test(tag)) return null; // a container, not a labelled control
    const r = (kind === "change" || /^(input|select|textarea)$/.test(tag) ? el : row || el).getBoundingClientRect();
    return { info, screen: screenTitle(), page: location.pathname + location.hash, rect: { x: r.left, y: r.top, w: r.width, h: r.height }, point: ev.clientX !== undefined && kind === "click" ? { x: ev.clientX, y: ev.clientY } : null, vw: innerWidth, vh: innerHeight };
  }

  function report(ev, kind) {
    if (!SR.armed) return;
    if (ev.target instanceof Element && ev.target.closest("[data-nb-ignore]")) return;
    const d = describe(ev, kind);
    if (d) chrome.runtime.sendMessage({ type: "STEPREC_EVENT", event: d }).catch(() => {});
  }

  addEventListener("pointerdown", (ev) => { if (ev.button === 0) report(ev, "click"); }, true);
  addEventListener("change", (ev) => report(ev, "change"), true);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "STEPREC_ARM") { SR.armed = !!msg.armed; sendResponse({ ok: true, top: window === window.top }); }
  });
  chrome.runtime.sendMessage({ type: "STEPREC_QUERY" }).then((res) => { if (res && res.armed) SR.armed = true; }).catch(() => {});
})();
