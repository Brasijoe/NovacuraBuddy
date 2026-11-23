// Pin step tab: keeps a copy of the step window open in the Flow Designer in the side panel, so its
// code and settings stay in view while you edit another step. The copy is a read-only snapshot made
// by content/designer.js (PIN_READ); nothing is ever written to the flow from here.
const SP_KEY = "stepPins"; // chrome.storage.local: { on, size, pins: [{ id, title, page, at, editors, fields, expanded, from }] }
const SP_MAX = 6;
const sp = { on: true, size: 12, pins: [], open: null, flow: null, tabId: null, timer: null };

function spEsc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function spSave() { return chrome.storage.local.set({ [SP_KEY]: { on: sp.on, size: sp.size, pins: sp.pins } }); }

async function spReadOpenStep() {
  const tabs = await chrome.tabs.query({ url: "https://build.novacura.com/*" });
  const tab = tabs.find((t) => t.active) || tabs[0];
  if (!tab) return { error: "No Flow Designer tab is open." };
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "PIN_READ" });
    if (!res || !res.ok) return { error: (res && res.error) || "The Designer page did not answer." };
    return { step: res.step, flow: res.flow, tabId: tab.id };
  } catch { return { error: "Reload the Flow Designer tab once so Buddy can read it." }; }
}

/** The Designer's variable type icon names, as the format of an output: record = one record, sequence = a list of them. */
function spKind(icon) {
  if (icon === "record") return "Record";
  if (icon === "sequence") return "Sequence (array)";
  return icon ? `Single value (${icon})` : "Unknown";
}
/** Columns of every `type Name = { field: type, ... }` in the step's code: [{ type, columns: [{ name, type }] }]. */
function spTypes(editors) {
  const out = [];
  for (const e of editors || []) {
    const re = /\btype\s+(\w+)\s*=\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(e.text))) {
      const columns = m[2].split(/[,\n]/).map((l) => l.trim()).filter(Boolean).map((l) => { const k = l.indexOf(":"); return k < 0 ? null : { name: l.slice(0, k).trim(), type: l.slice(k + 1).trim() }; }).filter(Boolean);
      if (columns.length) out.push({ type: m[1], columns });
    }
  }
  return out;
}
function spStepKey(s) { return `${s.title}`; }
const spPins = () => sp.pins.filter((p) => p.flow === sp.flow);

async function spPoll() {
  if (document.getElementById("panel-step-pin").hidden) return;
  const { step, error, flow, tabId } = await spReadOpenStep();
  const flowChanged = flow !== sp.flow;
  sp.open = step || null; sp.flow = flow || null; sp.tabId = tabId || null;
  if (flowChanged) spRender();
  const note = document.getElementById("spOpenNote");
  const btn = document.getElementById("spPinBtn");
  if (error) note.textContent = error;
  else if (!step) note.textContent = "No step window is open in the Designer. Open a step to pin it.";
  else note.textContent = `Open: ${step.title || "Step"} (${step.editors.length} code ${step.editors.length === 1 ? "editor" : "editors"}, ${step.fields.length} fields)`;
  btn.disabled = !sp.on || !step;
}

function spRender() {
  document.getElementById("spOn").checked = sp.on;
  document.getElementById("spSize").value = sp.size;
  document.getElementById("spPanel").classList.toggle("is-off", !sp.on);
  const list = document.getElementById("spList");
  list.hidden = !sp.on;
  document.getElementById("spUnpinAll").hidden = !sp.on || !spPins().length;
  document.getElementById("spOffNote").hidden = sp.on;
  list.innerHTML = "";
  const pins = spPins();
  if (!pins.length) { list.innerHTML = '<p class="api-hint">Nothing pinned for this flow yet. Open a step in the Designer and press "Pin current step".</p>'; return; }
  for (const pin of pins) {
    const card = document.createElement("div");
    card.className = "sp-pin" + (pin.expanded ? " is-open" : "");
    const details = !pin.expanded ? "" : `<div class="sp-details">
        <div class="sp-meta">Pinned ${new Date(pin.at).toLocaleTimeString()}${pin.heading && pin.heading !== pin.title ? ` · Window: ${spEsc(pin.heading)}` : ""}
          <span class="sp-meta-actions"><button class="sp-link" data-act="update" data-id="${pin.id}" title="Read this step again from the open step window">&#8635; Update</button></span></div>
        ${spTypes(pin.editors).map((t, i) => `<div class="sp-label"><span>Columns of ${spEsc(t.type)} (${t.columns.length})</span><button class="sp-link" data-copyc="${pin.id}:${i}" title="Copy the column names, one per line">Copy names</button></div><dl class="sp-fields sp-cols" style="font-size:${sp.size}px">${t.columns.map((c) => `<dt>${spEsc(c.name)}</dt><dd><span class="sp-val">${spEsc(c.type)}</span></dd>`).join("")}</dl>`).join("")}
        ${pin.editors.map((e, i) => `<div class="sp-label"><span>${spEsc(e.label || e.language || "Code")}</span><button class="sp-link" data-copy="${pin.id}:${i}">Copy</button></div><pre class="sp-code" style="font-size:${sp.size}px">${spEsc(e.text)}</pre>`).join("")}
        ${pin.fields.length ? `<dl class="sp-fields" style="font-size:${sp.size}px">${pin.fields.map((f, i) => `<dt>${spEsc(f.label || "Field")}</dt><dd><span class="sp-val">${spEsc(f.value)}</span><button class="sp-link sp-copyval" data-copyf="${pin.id}:${i}" title="Copy this value">Copy</button></dd>`).join("")}</dl>` : ""}
        ${!pin.editors.length && !pin.fields.length ? '<p class="api-hint">The step window showed no code or fields Buddy could read.</p>' : ""}
      </div>`;
    const outLine = (pin.outputs || []).length ? `<div class="sp-from">${pin.outputs.map((o, i) => `Output: <b>${spEsc(o.name || "?")}</b> · ${spEsc(spKind(o.icon))}<button class="sp-link" data-copyo="${pin.id}:${i}" title="Copy the output variable name">Copy</button>`).join(" · ")}</div>` : "";
    const from = pin.from ? `<div class="sp-from">Last opened from <button class="sp-link" data-act="back" data-id="${pin.id}" title="Applies the open step and opens ${spEsc(pin.from.title)} again">&#8617; ${spEsc(pin.from.title)}</button></div>` : "";
    card.innerHTML = `<div class="sp-row">
        <button class="sp-toggle" data-act="fold" data-id="${pin.id}" aria-expanded="${!!pin.expanded}" title="${pin.expanded ? "Hide" : "Show"} details"><span class="sp-caret" aria-hidden="true"></span><span class="sp-title">${spEsc(pin.title || "Step")}</span></button>
        <button class="btn-primary sp-open" data-act="reopen" data-id="${pin.id}" title="Applies the step open in the Designer, then opens this one there">Open</button>
        <button class="sp-x" data-act="remove" data-id="${pin.id}" title="Unpin" aria-label="Unpin">&times;</button>
      </div>${outLine}${from}${details}`;
    list.appendChild(card);
  }
}

function initStepPinPanel() {
  chrome.storage.local.get(SP_KEY).then(({ [SP_KEY]: st }) => {
    if (st) { sp.on = st.on !== false; sp.size = st.size || 12; sp.pins = st.pins || []; }
    spRender();
  });
  document.getElementById("spOn").addEventListener("change", (e) => { sp.on = e.target.checked; spSave(); spRender(); spPoll(); });
  document.getElementById("spSize").addEventListener("input", (e) => { sp.size = +e.target.value; spSave(); spRender(); });
  document.getElementById("spPinBtn").addEventListener("click", async () => {
    await spPoll();
    const s = sp.open;
    if (!sp.on || !s) return;
    const pin = { id: String(Date.now()), flow: sp.flow, title: s.title, heading: s.heading, page: s.page, key: spStepKey(s), at: s.at, editors: s.editors, fields: s.fields, outputs: s.outputs || [], expanded: false };
    sp.pins = [pin, ...sp.pins.filter((p) => !(p.flow === pin.flow && p.key === pin.key))];
    while (spPins().length > SP_MAX) sp.pins.splice(sp.pins.lastIndexOf(spPins().pop()), 1);
    await spSave(); spRender();
  });
  document.getElementById("spUnpinAll").addEventListener("click", async () => { sp.pins = sp.pins.filter((p) => p.flow !== sp.flow); await spSave(); spRender(); });
  document.getElementById("spList").addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.copyc) {
      const [id, i] = b.dataset.copyc.split(":");
      const pin = sp.pins.find((p) => p.id === id);
      try { await navigator.clipboard.writeText(spTypes(pin.editors)[+i].columns.map((c) => c.name).join("\n")); b.textContent = "Copied"; } catch { b.textContent = "Failed"; }
      setTimeout(() => { b.textContent = "Copy names"; }, 1500);
      return;
    }
    if (b.dataset.copyo) {
      const [id, i] = b.dataset.copyo.split(":");
      const pin = sp.pins.find((p) => p.id === id);
      try { await navigator.clipboard.writeText(pin.outputs[+i].name); b.textContent = "Copied"; } catch { b.textContent = "Failed"; }
      setTimeout(() => { b.textContent = "Copy"; }, 1500);
      return;
    }
    if (b.dataset.copyf) {
      const [id, i] = b.dataset.copyf.split(":");
      const pin = sp.pins.find((p) => p.id === id);
      try { await navigator.clipboard.writeText(pin.fields[+i].value); b.textContent = "Copied"; } catch { b.textContent = "Failed"; }
      setTimeout(() => { b.textContent = "Copy"; }, 1500);
      return;
    }
    if (b.dataset.copy) {
      const [id, i] = b.dataset.copy.split(":");
      const pin = sp.pins.find((p) => p.id === id);
      try { await navigator.clipboard.writeText(pin.editors[+i].text); b.textContent = "Copied"; } catch { b.textContent = "Failed"; }
      setTimeout(() => { b.textContent = "Copy"; }, 1500);
      return;
    }
    const pin = sp.pins.find((p) => p.id === b.dataset.id);
    if (!pin) return;
    if (b.dataset.act === "remove") sp.pins = sp.pins.filter((p) => p !== pin);
    if (b.dataset.act === "fold") pin.expanded = !pin.expanded;
    if (b.dataset.act === "reopen" || b.dataset.act === "back") {
      await spPoll();
      const note = document.getElementById("spOpenNote");
      const target = b.dataset.act === "back" ? pin.from : { title: pin.title, heading: pin.heading };
      if (b.dataset.act === "reopen" && sp.open && spStepKey(sp.open) !== pin.key) pin.from = { title: sp.open.title, heading: sp.open.heading }; // remember where we came from (not pinned)
      const res = sp.tabId ? await chrome.tabs.sendMessage(sp.tabId, { type: "PIN_REOPEN", title: target.title, alt: target.heading }).catch(() => null) : null;
      note.textContent = res && res.ok ? `Clicked "${res.clicked}" in the Designer.` : (res && res.error) || "The Designer did not answer.";
      await spSave(); spRender(); return;
    }
    if (b.dataset.act === "update") {
      await spPoll();
      if (sp.open && spStepKey(sp.open) === pin.key) Object.assign(pin, { at: sp.open.at, editors: sp.open.editors, fields: sp.open.fields, outputs: sp.open.outputs || [] });
      else document.getElementById("spOpenNote").textContent = "That step is not the one open in the Designer right now.";
    }
    await spSave(); spRender();
  });
}

function spOnShow() { spPoll(); clearInterval(sp.timer); sp.timer = setInterval(spPoll, 2000); }
function spOnHide() { clearInterval(sp.timer); }
