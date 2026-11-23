// Pin step tab: keeps a copy of the step window open in the Flow Designer in the side panel, so its
// code and settings stay in view while you edit another step. The copy is a read-only snapshot made
// by content/designer.js (PIN_READ); nothing is ever written to the flow from here.
const SP_KEY = "stepPins"; // chrome.storage.local: { on, size, pins: [{ id, title, page, at, editors, fields, collapsed }] }
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
  document.getElementById("spOffNote").hidden = sp.on;
  list.innerHTML = "";
  const pins = spPins();
  if (!pins.length) { list.innerHTML = '<p class="api-hint">Nothing pinned for this flow yet. Open a step in the Designer and press "Pin current step".</p>'; return; }
  for (const pin of pins) {
    const card = document.createElement("div");
    card.className = "cm-card sp-pin";
    const body = pin.collapsed ? "" : [
      ...pin.editors.map((e) => `<div class="sp-label">${spEsc(e.label || e.language || "Code")}<button class="btn-ghost sp-copy" data-copy="${pin.id}:${pin.editors.indexOf(e)}">Copy</button></div><pre class="sp-code" style="font-size:${sp.size}px">${spEsc(e.text)}</pre>`),
      pin.fields.length ? `<dl class="sp-fields" style="font-size:${sp.size}px">${pin.fields.map((f) => `<dt>${spEsc(f.label || "Field")}</dt><dd>${spEsc(f.value)}</dd>`).join("")}</dl>` : "",
      !pin.editors.length && !pin.fields.length ? '<p class="api-hint">The step window showed no code or fields Buddy could read.</p>' : ""
    ].join("");
    card.innerHTML = `<div class="section-head"><h2>${spEsc(pin.title || "Step")}</h2><span class="api-hint">${new Date(pin.at).toLocaleTimeString()}</span></div>
      <div class="sp-actions"><button class="btn-ghost" data-act="fold" data-id="${pin.id}">${pin.collapsed ? "Show" : "Fold"}</button><button class="btn-primary" data-act="reopen" data-id="${pin.id}" title="Applies the step open in the Designer (it is pinned too), then reopens this one there">Open in Designer</button><button class="btn-ghost" data-act="update" data-id="${pin.id}" title="Read this step again from the open step window">&#8635; Update</button><button class="btn-ghost" data-act="remove" data-id="${pin.id}">Unpin</button></div>${body}`;
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
    const pin = { id: String(Date.now()), flow: sp.flow, title: s.title, page: s.page, key: spStepKey(s), at: s.at, editors: s.editors, fields: s.fields, collapsed: false };
    sp.pins = [pin, ...sp.pins.filter((p) => !(p.flow === pin.flow && p.key === pin.key))];
    while (spPins().length > SP_MAX) sp.pins.splice(sp.pins.lastIndexOf(spPins().pop()), 1);
    await spSave(); spRender();
  });
  document.getElementById("spList").addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
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
    if (b.dataset.act === "fold") pin.collapsed = !pin.collapsed;
    if (b.dataset.act === "reopen") {
      await spPoll();
      const note = document.getElementById("spOpenNote");
      if (sp.open && spStepKey(sp.open) !== pin.key) { // the open step moves into the pins
        const cur = { id: String(Date.now()), flow: sp.flow, title: sp.open.title, page: sp.open.page, key: spStepKey(sp.open), at: sp.open.at, editors: sp.open.editors, fields: sp.open.fields, collapsed: false };
        sp.pins = [cur, ...sp.pins.filter((p) => !(p.flow === cur.flow && p.key === cur.key))];
      }
      const res = sp.tabId ? await chrome.tabs.sendMessage(sp.tabId, { type: "PIN_REOPEN", title: pin.title }).catch(() => null) : null;
      note.textContent = res && res.ok ? `Clicked "${res.clicked}" in the Designer.` : (res && res.error) || "The Designer did not answer.";
      await spSave(); spRender(); return;
    }
    if (b.dataset.act === "update") {
      await spPoll();
      if (sp.open && spStepKey(sp.open) === pin.key) Object.assign(pin, { at: sp.open.at, editors: sp.open.editors, fields: sp.open.fields });
      else document.getElementById("spOpenNote").textContent = "That step is not the one open in the Designer right now.";
    }
    await spSave(); spRender();
  });
}

function spOnShow() { spPoll(); clearInterval(sp.timer); sp.timer = setInterval(spPoll, 2000); }
function spOnHide() { clearInterval(sp.timer); }
