// Injected into the Flow web client (app.novacura.com). Idle until the Step Recorder is started in the side
// panel: only then does it listen (capture phase) for clicks and for finished inputs and report each one to the
// background worker, which takes the screenshot. Password values are never read. Nothing is sent anywhere
// else; steps stay in the browser's extension storage.
(function () {
  // A copy left behind by a reloaded extension is orphaned (its chrome.runtime is gone): switch it off and take over.
  if (window.__nbStepRecorder && window.__nbStepRecorder.dispose) { try { window.__nbStepRecorder.dispose(); } catch { /* already dead */ } }
  const SR = { armed: false, any: false };
  window.__nbStepRecorder = SR;
  const onDown = (ev) => { if (ev.button === 0) report(ev, "click"); };
  const onChange = (ev) => report(ev, "change");
  SR.dispose = () => { SR.armed = false; removeEventListener("pointerdown", onDown, true); removeEventListener("change", onChange, true); };

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
    const h = [...document.querySelectorAll("h1, h2, [role='heading']")].find((e) => e.offsetParent !== null && text(e) && !/^(info|information|informationen)$/i.test(text(e)));
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

  /** The smallest element at the click that carries text (for read-only objects), never a big container. */
  function textObjectOf(raw) {
    for (let el = raw; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      const t = text(el);
      if (t && t.length <= 120) return el;
      if (t) return null; // the nearest text belongs to a container
    }
    return null;
  }

  /** A fingerprint of what is on screen: the visible labels of controls and headings (no typed values), to tell pages apart. */
  function layoutSig() {
    const out = new Set();
    for (const e of document.querySelectorAll("button, a[href], [role='button'], [role='tab'], [role='menuitem'], label, h1, h2, h3, [role='heading'], th, [role='columnheader']")) {
      if (out.size >= 80) break;
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) continue;
      const t = text(e).toLowerCase();
      if (t && t.length <= 40) out.add(t);
    }
    return [...out];
  }

  /** A readable name for an icon-only control: svg title, the icon's name from its <use> link or class, data-testid/name/id. */
  function iconName(el) {
    const t = el.querySelector("svg title");
    if (t && t.textContent.trim()) return t.textContent.trim();
    const use = el.querySelector("use");
    const href = use && (use.getAttribute("href") || use.getAttribute("xlink:href"));
    const pretty = (x) => String(x || "").split(/[#/]/).pop().replace(/^(icon|ic|fa|mdi|ms)[-_]/i, "").replace(/[-_]+/g, " ").trim();
    if (href && pretty(href)) return pretty(href);
    for (const n of [el, ...el.querySelectorAll("[class]")].slice(0, 6)) {
      for (const c of String(n.getAttribute("class") || "").split(/\s+/)) {
        const m = /^(?:icon|ic|fa|mdi|ms|material-icons?)[-_]([a-z][a-z0-9-_]+)$/i.exec(c);
        if (m && !/^(button|btn|small|large|medium|regular|solid|outline|fw|lg|sm)$/i.test(m[1])) return pretty(m[1]);
      }
    }
    return pretty(el.getAttribute("data-testid") || el.getAttribute("data-name") || el.getAttribute("name") || "");
  }

  // Controls that have no name anywhere get a generic one ("Pinned Step", or "Object"); the step shows the control's icon.
  function genericName(el) {
    let hint = "";
    for (let n = el, i = 0; n && i < 4; n = n.parentElement, i++) hint += " " + (n.getAttribute("class") || "") + " " + (n.id || "") + " " + (n.getAttribute("title") || "") + " " + (n.getAttribute("data-testid") || "") + " " + (n.getAttribute("aria-label") || "");
    return /pin/i.test(hint) ? "Pinned Step" : "Object";
  }

  function describe(ev, kind) {
    const raw = ev.target instanceof Element ? ev.target : null;
    if (!raw) return { ignored: "no element" };
    const strict = controlOf(raw);
    // By default a click that hit no control (empty page area, plain text) is not a step; with "any object" on, read-only text counts.
    const el = strict || (SR.any ? textObjectOf(raw) : null);
    if (!el) return { ignored: "click hit no control (" + raw.tagName.toLowerCase() + (SR.any ? ", no short text there" : ", read-only objects are off") + ")" };
    const tag = el.tagName.toLowerCase();
    const row = raw.closest("tr, [role='row'], [role='option']");
    const grid = row && row.closest("table, [role='grid'], [role='listbox'], [role='table']");
    const info = { event: kind, readonly: !strict, tag, role: el.getAttribute("role") || "", type: el.getAttribute("type") || (tag === "input" ? "text" : ""), label: text(el), prompt: labelOf(el) };
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
    // A read-only or disabled field is something to point at (value shown on screen), not something to type in.
    if (kind === "click" && /^(input|textarea|select)$/.test(tag) && (el.readOnly || el.disabled || el.getAttribute("aria-readonly") === "true")) {
      if (!SR.any) return { ignored: "read-only field (read-only objects are off)" };
      const val = el.type === "password" ? "" : (el.value || "");
      info.readonly = true;
      info.label = ((info.prompt ? info.prompt + ": " : "") + val).slice(0, 120);
    }
    if (kind === "click" && !info.readonly && !info.rowKey && (info.label.length > 80 || !info.label) && !/^(input|textarea|select)$/.test(tag)) {
      // A clickable card or tile (e.g. an Inbox entry): its first line of text is its name; an icon button has a tooltip or alt text.
      const first = String(el.innerText || "").split("\n").map((l) => l.replace(/\s+/g, " ").trim()).find(Boolean);
      const tip = el.querySelector("[title], [aria-label], img[alt]");
      const name = (first && first.length <= 80 ? first : first ? first.slice(0, 80) : "") || (tip && (tip.getAttribute("title") || tip.getAttribute("aria-label") || tip.getAttribute("alt"))) || "";
      const named = name || iconName(el) || labelOf(el);
      if (!named) { info.label = genericName(el); info.review = true; info.generic = true; }
      else info.label = named.trim();
    }
    const r = (kind === "change" || /^(input|select|textarea)$/.test(tag) ? el : row || el).getBoundingClientRect();
    return { info, screen: screenTitle(), page: location.pathname + location.hash, sig: layoutSig(), rect: { x: r.left, y: r.top, w: r.width, h: r.height }, point: ev.clientX !== undefined && kind === "click" ? { x: ev.clientX, y: ev.clientY } : null, vw: innerWidth, vh: innerHeight };
  }

  function report(ev, kind) {
    if (!SR.armed) return;
    if (!chrome.runtime || !chrome.runtime.id) { SR.dispose(); return; } // extension was reloaded: this copy is orphaned
    if (ev.target instanceof Element && ev.target.closest("[data-nb-ignore]")) return;
    try {
      const d = describe(ev, kind);
      if (d) chrome.runtime.sendMessage({ type: "STEPREC_EVENT", event: d }).catch(() => {});
    } catch (e) {
      if (/context invalidated/i.test(String(e && e.message))) { SR.dispose(); return; } // reload the Flow tab after reloading the extension
      // Anything else is shown in the panel's "Last clicks" log instead of failing silently.
      try { chrome.runtime.sendMessage({ type: "STEPREC_EVENT", event: { ignored: "script error: " + String((e && e.message) || e) + " | " + String((e && e.stack) || "").split("\n").slice(1, 3).join(" ").slice(0, 200) } }).catch(() => {}); } catch { /* nothing more to do */ }
    }
  }

  addEventListener("pointerdown", onDown, true);
  addEventListener("change", onChange, true);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "STEPREC_ARM") { SR.armed = !!msg.armed; SR.any = !!msg.any; sendResponse({ ok: true, top: window === window.top }); }
  });
  chrome.runtime.sendMessage({ type: "STEPREC_QUERY" }).then((res) => { if (res && res.armed) { SR.armed = true; SR.any = !!res.any; } }).catch(() => {});
})();
