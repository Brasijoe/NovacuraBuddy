// Step Recorder tab: Start / Pause / Stop, the live step list (edit sentence and note, move, merge, delete) and the
// saved recordings. Model in lib/step-recorder.js, capture in content/step-recorder.js, state in the background worker.
let srTimer = null;
let srLast = "";

const srEl = (id) => document.getElementById(id);

function srOnShow() { srRefresh(); clearInterval(srTimer); srTimer = setInterval(srRefresh, 1000); }
function srOnHide() { clearInterval(srTimer); srTimer = null; }

async function srRefresh() {
  const res = await send({ type: "STEPREC_GET" });
  if (res.error && !res.sessions) return;
  const { rec, sessions = [] } = res;
  const state = rec ? rec.state : "idle";
  srEl("srStart").disabled = state === "recording" || state === "paused";
  srEl("srPause").disabled = !rec;
  srEl("srPause").textContent = state === "paused" ? "▶ Resume" : "❚❚ Pause";
  srEl("srStop").disabled = !rec;
  srEl("srLang").value = rec ? rec.lang : srEl("srLang").value;
  srEl("srSubRow").hidden = !rec;
  srEl("srSubStart").hidden = !!(rec && rec.sub);
  srEl("srSubEnd").hidden = !(rec && rec.sub);
  const bar = srEl("srStatusBar");
  bar.className = "status-bar" + (state === "recording" ? " recording" : "");
  srEl("srStatusText").textContent = !rec ? "Open the Flow web client in the active tab, then press Start."
    : state === "paused" ? `Paused (${rec.steps.length} steps) - nothing is captured` : `Recording (${rec.steps.length} steps)`;

  // Do not rebuild the list while the user types in it.
  const sig = JSON.stringify([rec && rec.steps.map((s) => [s.id, s.number, s.text, s.note]), sessions.map((s) => s.id)]);
  const typing = srEl("srSteps").contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (sig !== srLast && !typing) {
    srLast = sig;
    srRenderSteps(rec);
    srRenderSessions(sessions);
  }
}

/** Screenshot with its numbered marker; the marker is an overlay, so renumbering never needs a new picture. */
function srThumb(step) {
  const wrap = document.createElement("div");
  wrap.className = "sr-thumb";
  if (!step.screenshot) { wrap.textContent = "No screenshot" + (step.shotError ? ": " + step.shotError : ""); wrap.style.padding = "6px"; return wrap; }
  const img = document.createElement("img");
  img.src = step.screenshot;
  wrap.appendChild(img);
  const m = step.marker;
  if (m && m.vw && m.vh) {
    const el = document.createElement("span");
    el.className = "sr-marker sr-" + m.shape;
    if (m.shape === "circle") { el.style.left = (m.x / m.vw) * 100 + "%"; el.style.top = (m.y / m.vh) * 100 + "%"; el.textContent = step.number; }
    else { el.style.left = (m.x / m.vw) * 100 + "%"; el.style.top = (m.y / m.vh) * 100 + "%"; el.style.width = (m.w / m.vw) * 100 + "%"; el.style.height = (m.h / m.vh) * 100 + "%"; }
    wrap.appendChild(el);
  }
  return wrap;
}

function srRenderSteps(rec) {
  const box = srEl("srSteps");
  box.innerHTML = "";
  if (!rec || !rec.steps.length) {
    box.innerHTML = '<div class="empty-state">No steps yet. Press Start and work in the Flow web client.</div>';
    return;
  }
  let screen = null;
  for (const s of rec.steps) {
    if (s.screen !== screen) {
      screen = s.screen;
      if (screen) { const h = document.createElement("div"); h.className = "sr-screen"; h.textContent = screen; box.appendChild(h); }
    }
    const card = document.createElement("div");
    card.className = "sr-step" + (s.sub ? " sr-substep" : "");
    const head = document.createElement("div");
    head.className = "sr-head";
    const num = document.createElement("span");
    num.className = "sr-num";
    num.textContent = s.number;
    const text = document.createElement("input");
    text.className = "sr-text";
    text.value = s.text;
    text.onchange = () => srEdit({ op: "text", id: s.id, value: text.value });
    head.append(num, text);
    if (s.review) {
      const w = document.createElement("span");
      w.className = "sr-flag";
      w.textContent = "⚠";
      w.title = "Names were read from the page layout and not yet verified for this control type. Please check the sentence.";
      head.appendChild(w);
    }
    const note = document.createElement("textarea");
    note.className = "sr-note";
    note.rows = 1;
    note.placeholder = "Note (optional)";
    note.value = s.note || "";
    note.onchange = () => srEdit({ op: "note", id: s.id, value: note.value });
    const tools = document.createElement("div");
    tools.className = "sr-tools";
    for (const [label, op, title] of [["↑", "up", "Move up"], ["↓", "down", "Move down"], ["⤴ Merge", "merge", "Merge into the step before"], ["✕", "delete", "Delete step"]]) {
      const b = document.createElement("button");
      b.className = "icon-btn";
      b.textContent = label;
      b.title = title;
      b.onclick = () => srEdit({ op, id: s.id });
      tools.appendChild(b);
    }
    card.append(head, srThumb(s), note, tools);
    box.appendChild(card);
  }
  box.scrollTop = box.scrollHeight;
}

function srRenderSessions(sessions) {
  const list = srEl("srSessions");
  list.innerHTML = "";
  if (!sessions.length) { list.innerHTML = '<div class="empty-state">No saved recordings yet.</div>'; return; }
  for (const s of sessions) {
    const item = document.createElement("div");
    item.className = "sess-item";
    const info = document.createElement("div");
    info.className = "sess-info";
    info.innerHTML = '<div class="sess-title"></div><div class="sess-meta"></div>';
    info.querySelector(".sess-title").textContent = s.name;
    info.querySelector(".sess-meta").textContent = `${s.steps.length} steps · ${new Date(s.createdAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`;
    info.onclick = () => srOpenEditor(s.id);
    info.style.cursor = "pointer";
    const del = document.createElement("button");
    del.className = "icon-btn";
    del.textContent = "✕";
    del.title = "Delete this recording";
    del.onclick = async () => { await send({ type: "STEPREC_DELETE_SESSION", id: s.id }); srLast = ""; srRefresh(); };
    item.append(info, del);
    list.appendChild(item);
  }
}

async function srEdit(edit) { await send({ type: "STEPREC_EDIT", edit }); srLast = ""; srRefresh(); }

srEl("srStart").onclick = async () => {
  const res = await send({ type: "STEPREC_START", lang: srEl("srLang").value });
  if (!res.ok) srEl("srStatusText").textContent = res.error || "Could not start.";
  else { srLast = ""; srRefresh(); }
};
srEl("srPause").onclick = async () => {
  const cur = await send({ type: "STEPREC_GET" });
  await send({ type: cur.rec && cur.rec.state === "paused" ? "STEPREC_RESUME" : "STEPREC_PAUSE" });
  srRefresh();
};
srEl("srStop").onclick = async () => {
  const res = await send({ type: "STEPREC_STOP" });
  srLast = ""; srRefresh();
  if (res.ok && res.session) srOpenEditor(res.session.id);
};
const srOpenEditor = (id) => chrome.tabs.create({ url: chrome.runtime.getURL("recorder/steps-editor.html?id=" + encodeURIComponent(id)) });
srEl("srLang").onchange = async () => { const cur = await send({ type: "STEPREC_GET" }); if (cur.rec) await srEdit({ op: "lang", value: srEl("srLang").value }); };
srEl("srSubStart").onclick = async () => {
  const res = await send({ type: "STEPREC_SUB", action: "start", workflow: "" });
  if (!res.ok) srEl("srStatusText").textContent = res.error || "";
  srLast = ""; srRefresh();
};
srEl("srSubEnd").onclick = async () => { await send({ type: "STEPREC_SUB", action: "end" }); srRefresh(); };
