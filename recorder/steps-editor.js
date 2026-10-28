// Full-screen editor for a Step Recorder recording (?id=...). Edits are written back to extension storage as you
// go (autosave). The PDF is the page's own print view (cover, contents, steps in the Novacura design), so what you
// see in the editor is what the PDF holds: use "Save as PDF" in the print dialog.
const SR = StepRecorder;
const $ = (id) => document.getElementById(id);
const sessionId = new URLSearchParams(location.search).get("id");
let rec = null;
let where = "sessions"; // "current" while the recording is still running
let saveTimer = null;

async function load() {
  const { stepRec, stepRecSessions = [] } = await chrome.storage.local.get(["stepRec", "stepRecSessions"]);
  if (stepRec && (!sessionId || stepRec.id === sessionId)) { rec = stepRec; where = "current"; }
  else rec = stepRecSessions.find((s) => s.id === sessionId) || stepRecSessions[0] || null;
  if (!rec) { document.body.textContent = "Recording not found."; return; }
  rec.meta = rec.meta || { title: rec.name || "", workflow: "", version: "", author: "", date: new Date().toISOString().slice(0, 10) };
  rec.recordedLang = rec.recordedLang || rec.lang;
  $("mHeadings").checked = rec.meta.headings !== false;
  $("mTitle").value = rec.meta.title; $("mWorkflow").value = rec.meta.workflow; $("mVersion").value = rec.meta.version;
  $("mAuthor").value = rec.meta.author; $("mDate").value = rec.meta.date; $("mLang").value = rec.lang;
  render();
}

function save() {
  $("seSaved").textContent = "Saving…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (where === "current") await chrome.storage.local.set({ stepRec: rec });
    else {
      const { stepRecSessions = [] } = await chrome.storage.local.get("stepRecSessions");
      const i = stepRecSessions.findIndex((s) => s.id === rec.id);
      if (i >= 0) stepRecSessions[i] = rec; else stepRecSessions.unshift(rec);
      await chrome.storage.local.set({ stepRecSessions });
    }
    $("seSaved").textContent = "Saved";
  }, 400);
}

for (const [id, key] of [["mTitle", "title"], ["mWorkflow", "workflow"], ["mVersion", "version"], ["mAuthor", "author"], ["mDate", "date"]]) {
  $(id).oninput = () => { rec.meta[key] = $(id).value; if (key === "title") rec.name = $(id).value || rec.name; save(); };
}
$("mHeadings").onchange = () => { rec.meta.headings = $("mHeadings").checked; save(); };
$("mLang").onchange = () => { rec.lang = $("mLang").value; SR.relanguage(rec.steps, rec.lang); save(); render(); };
$("seAddSection").onclick = () => { SR.addSection(rec.steps, null, "Introduction"); save(); render(); };
$("sePdf").onclick = async () => {
  await buildPrint();
  // Freshly created data-URL images may not be decoded yet; printing before that leaves them blank.
  await Promise.all([...document.querySelectorAll("#print img")].map((i) => i.decode().catch(() => {})));
  window.print();
};

/** The page screenshot with a marker for every step of the page; markers can be dragged. */
function figure(run, onChange) {
  const fig = document.createElement("div");
  fig.className = "se-fig";
  const img = document.createElement("img");
  img.src = run.lead.screenshot;
  fig.appendChild(img);
  for (const st of run.steps) if (markerShown(st)) fig.appendChild(markerEl(st, fig, onChange));
  return fig;
}

function markerEl(step, fig, onChange) {
  const m = step.marker;
  const el = document.createElement("span");
  el.className = "m " + m.shape;
  const place = () => {
    el.style.left = (m.x / m.vw) * 100 + "%"; el.style.top = (m.y / m.vh) * 100 + "%";
    if (m.shape === "frame") { el.style.width = (m.w / m.vw) * 100 + "%"; el.style.height = (m.h / m.vh) * 100 + "%"; }
  };
  place();
  if (m.shape === "circle") el.textContent = step.number; else el.dataset.n = step.number;
  if (onChange) {
    el.onpointerdown = (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const r = fig.getBoundingClientRect();
      const start = { x: e.clientX, y: e.clientY, mx: m.x, my: m.y };
      el.onpointermove = (ev) => { m.x = start.mx + ((ev.clientX - start.x) / r.width) * m.vw; m.y = start.my + ((ev.clientY - start.y) / r.height) * m.vh; place(); };
      el.onpointerup = () => { el.onpointermove = el.onpointerup = null; onChange(); };
    };
  }
  return el;
}

/** Draws a rectangle on a figure; resolves with fractions of the image, or null if too small. */
function drawRect(fig) {
  return new Promise((resolve) => {
    fig.classList.add("draw");
    const sel = document.createElement("div");
    sel.className = "sel";
    let r, a;
    fig.onpointerdown = (e) => {
      r = fig.getBoundingClientRect();
      a = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
      fig.appendChild(sel); fig.setPointerCapture(e.pointerId);
      fig.onpointermove = (ev) => {
        const b = { x: Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1), y: Math.min(Math.max((ev.clientY - r.top) / r.height, 0), 1) };
        const f = { fx: Math.min(a.x, b.x), fy: Math.min(a.y, b.y), fw: Math.abs(a.x - b.x), fh: Math.abs(a.y - b.y) };
        Object.assign(sel.style, { left: f.fx * 100 + "%", top: f.fy * 100 + "%", width: f.fw * 100 + "%", height: f.fh * 100 + "%" });
        sel.f = f;
      };
      fig.onpointerup = () => { fig.onpointerdown = fig.onpointermove = fig.onpointerup = null; fig.classList.remove("draw"); resolve(sel.f && sel.f.fw > 0.02 && sel.f.fh > 0.02 ? sel.f : null); };
    };
  });
}

/** A marker is drawn unless the user switched it off (the data stays, so it can be switched back on). */
const markerShown = (st) => !!(st.marker && st.marker.vw && !st.markerHidden);

// ---- undo for crop / blur: snapshots of the page's screenshot and markers (in memory), plus the untouched original (saved) ----
const undoStack = [];
const snapshot = (run) => ({ leadId: run.lead.id, screenshot: run.lead.screenshot, markers: run.steps.map((st) => [st.id, st.marker ? { ...st.marker } : null]) });
function pushUndo(run) {
  const snap = snapshot(run);
  if (!run.lead.orig) run.lead.orig = { screenshot: snap.screenshot, markers: snap.markers }; // first edit of this page: remember the original
  undoStack.push(snap);
  if (undoStack.length > 15) undoStack.shift();
}
function restoreSnapshot(snap) {
  const lead = rec.steps.find((st) => st.id === snap.leadId);
  if (!lead) return;
  lead.screenshot = snap.screenshot;
  for (const [id, m] of snap.markers) { const st = rec.steps.find((x) => x.id === id); if (st) st.marker = m ? { ...m } : null; }
}
function undoFor(leadId) {
  for (let i = undoStack.length - 1; i >= 0; i--) if (!leadId || undoStack[i].leadId === leadId) { restoreSnapshot(undoStack.splice(i, 1)[0]); save(); render(); return true; }
  return false;
}
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !/^(INPUT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName)) { if (undoFor(null)) e.preventDefault(); }
});

const loadImage = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });

async function crop(run, f) {
  const step = run.lead;
  const img = await loadImage(step.screenshot);
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * f.fw); c.height = Math.round(img.naturalHeight * f.fh);
  c.getContext("2d").drawImage(img, f.fx * img.naturalWidth, f.fy * img.naturalHeight, c.width, c.height, 0, 0, c.width, c.height);
  step.screenshot = c.toDataURL("image/jpeg", 0.85);
  SR.cropPage(run, f);
}

async function blur(run, f) {
  const step = run.lead;
  const img = await loadImage(step.screenshot);
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const x = f.fx * c.width, y = f.fy * c.height, w = f.fw * c.width, h = f.fh * c.height;
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.filter = "blur(10px)";
  ctx.drawImage(img, x - 20, y - 20, w + 40, h + 40, x - 20, y - 20, w + 40, h + 40);
  ctx.restore();
  step.screenshot = c.toDataURL("image/jpeg", 0.85);
}


function btn(label, title, fn, cls) {
  const b = document.createElement("button");
  b.className = "icon" + (cls ? " " + cls : "");
  b.textContent = label; b.title = title; b.onclick = fn;
  return b;
}

function render() {
  const L = SR.DOC_LABELS[rec.lang] || SR.DOC_LABELS.en;
  $("seMixed").hidden = rec.lang === rec.recordedLang;
  const box = $("seSteps");
  box.innerHTML = "";
  const refresh = () => { save(); render(); };
  const runs = SR.pageRuns(rec.steps);

  const stepRow = (s, withMarkerTool, lead) => {
    const card = document.createElement("div");
    card.className = "se-step-row";
    const head = document.createElement("div");
    head.className = "se-head";
    const num = document.createElement("span");
    num.className = "se-num";
    num.textContent = s.number;
    const text = document.createElement("textarea");
    text.rows = 1; text.value = s.text;
    text.oninput = () => { s.text = text.value; s.edited = true; save(); };
    head.append(num, text);
    if (s.icon) StepIcon.stepIcon(s, lead).then((ic) => { if (ic) { const im = document.createElement("img"); im.className = "se-icon"; im.src = ic.url; im.title = "The control you clicked"; text.after(im); } });
    card.appendChild(head);
    if (s.review) { const w = document.createElement("div"); w.className = "se-flag"; w.textContent = "⚠ Names were read from the page layout and not yet verified for this control type. Please check the sentence."; card.appendChild(w); }
    const note = document.createElement("textarea");
    note.rows = 1; note.placeholder = "Note (optional)"; note.value = s.note || "";
    note.oninput = () => { s.note = note.value; save(); };
    card.appendChild(note);
    const tools = document.createElement("div");
    tools.className = "se-tools";
    tools.append(btn("↑", "Move up", () => { SR.moveStep(rec.steps, s.id, -1); refresh(); }), btn("↓", "Move down", () => { SR.moveStep(rec.steps, s.id, 1); refresh(); }),
      btn("Merge with previous", "Join this step into the one before it", () => { SR.mergeWithPrevious(rec.steps, s.id); refresh(); }));
    if (withMarkerTool) {
      const on = markerShown(s);
      tools.append(btn(on ? "Remove marker" : "Add marker", on ? "Hide this step's marker on the screenshot (it can be added back)" : "Show this step's marker on the screenshot; drag it into place", async () => {
        if (on) s.markerHidden = true;
        else {
          s.markerHidden = false;
          if (!s.marker || !s.marker.vw) { const img = await loadImage(lead.screenshot); s.marker = { shape: "circle", x: img.naturalWidth / 2, y: img.naturalHeight / 2, vw: img.naturalWidth, vh: img.naturalHeight }; }
        }
        refresh();
      }));
    }
    tools.append(btn("+ Text section", "Add a free text section after this step", () => { SR.addSection(rec.steps, s.id, "Note"); refresh(); }), btn("Delete", "Delete this step", () => { SR.removeStep(rec.steps, s.id); refresh(); }));
    card.appendChild(tools);
    return card;
  };

  for (const run of runs) {
    const card = document.createElement("div");
    if (run.type === "section") {
      const s = run.step;
      card.className = "se-step se-section";
      const head = document.createElement("div");
      head.className = "se-head";
      const num = document.createElement("span");
      num.className = "se-num"; num.textContent = "¶";
      const text = document.createElement("textarea");
      text.rows = 1; text.placeholder = "Heading"; text.value = s.text;
      text.oninput = () => { s.text = text.value; save(); };
      head.append(num, text);
      const body = document.createElement("textarea");
      body.className = "body"; body.placeholder = "Text"; body.value = s.note || "";
      body.oninput = () => { s.note = body.value; save(); };
      const tools = document.createElement("div");
      tools.className = "se-tools";
      tools.append(btn("↑", "Move up", () => { SR.moveStep(rec.steps, s.id, -1); refresh(); }), btn("↓", "Move down", () => { SR.moveStep(rec.steps, s.id, 1); refresh(); }), btn("Delete", "Delete", () => { SR.removeStep(rec.steps, s.id); refresh(); }));
      card.append(head, body, tools);
      box.appendChild(card);
      continue;
    }
    card.className = "se-step";
    // The page heading: the page's header element as recorded, editable (it is stored apart from how pages are told apart).
    const holder = run.lead || run.steps[0];
    const titleIn = document.createElement("input");
    titleIn.className = "se-page-title";
    titleIn.placeholder = "Page heading (optional)";
    titleIn.value = SR.pageTitle(run);
    titleIn.oninput = () => { holder.title = titleIn.value; save(); };
    card.appendChild(titleIn);
    if (run.lead && run.lead.screenshot) {
      card.appendChild(figure(run, save));
      const ptools = document.createElement("div");
      ptools.className = "se-tools";
      const hint = document.createElement("span");
      hint.className = "se-hint";
      const tool = (label, title, fn) => btn(label, title, async (e) => {
        const b = e.currentTarget; b.classList.add("on"); hint.textContent = "Draw a rectangle on the screenshot…";
        const f = await drawRect(card.querySelector(".se-fig"));
        hint.textContent = "";
        if (f) { pushUndo(run); await fn(f); refresh(); } else b.classList.remove("on");
      });
      ptools.append(tool("Crop", "Keep only the area you draw", (f) => crop(run, f)), tool("Blur", "Blur the area you draw (private data)", (f) => blur(run, f)),
        btn("↑ Page", "Move this page (screenshot and its steps) up", () => { SR.movePage(rec.steps, run.lead.id, -1); refresh(); }),
        btn("↓ Page", "Move this page down", () => { SR.movePage(rec.steps, run.lead.id, 1); refresh(); }));
      if (rec.steps.indexOf(run.lead) > 0) ptools.append(btn("Join previous page", "Treat this page as part of the page before it (this screenshot is dropped)", () => { SR.joinPreviousPage(rec.steps, run.lead.id); refresh(); }));
      ptools.append(btn("↶ Undo", "Undo the last crop or blur on this page (Ctrl+Z)", () => { if (!undoFor(run.lead.id)) hint.textContent = "Nothing to undo on this page."; }));
      if (run.lead.orig && run.lead.orig.screenshot !== run.lead.screenshot) ptools.append(btn("Restore original", "Bring back the screenshot and markers as recorded", () => { pushUndo(run); restoreSnapshot({ leadId: run.lead.id, screenshot: run.lead.orig.screenshot, markers: run.lead.orig.markers }); refresh(); }));
      ptools.append(hint);
      card.appendChild(ptools);
    } else if (run.lead && run.lead.shotError) {
      const w = document.createElement("div"); w.className = "se-flag"; w.textContent = "No screenshot: " + run.lead.shotError; card.appendChild(w);
    }
    for (const s of run.steps) card.appendChild(stepRow(s, !!(run.lead && run.lead.screenshot), run.lead));
    box.appendChild(card);
  }
  document.title = (rec.meta.title || L.untitled) + " - Step Recorder";
}

function printFig(run) {
  const fig = document.createElement("div");
  fig.className = "p-fig";
  const img = document.createElement("img");
  img.src = run.lead.screenshot;
  fig.appendChild(img);
  for (const st of run.steps) if (markerShown(st)) fig.appendChild(markerEl(st, fig, null));
  return fig;
}

/** The print view: cover, contents, then the steps grouped under their screen headings. */
async function buildPrint() {
  const icons = await stepIcons();
  const L = SR.DOC_LABELS[rec.lang] || SR.DOC_LABELS.en;
  const m = rec.meta;
  const root = $("print");
  root.innerHTML = "";
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const cover = el("section", "p-cover");
  cover.append(el("h1", "", SR.brandTitle(m.title) || SR.brandTitle(L.untitled)));
  if (m.workflow) cover.append(el("div", "sub", m.workflow));
  const dl = el("dl");
  for (const [k, v] of [[L.author, m.author], [L.version, m.version], [L.date, m.date], [L.language, SR.LANG_NAMES[rec.lang]]]) if (v) dl.append(el("dt", "", k), el("dd", "", v));
  cover.append(dl);
  root.append(cover);
  const toc = el("section", "p-toc");
  toc.append(el("h2", "", L.contents));
  const ol = el("ol");
  for (const c of SR.contents(rec.steps)) ol.append(el("li", "", c.from ? `${c.title} (${L.step} ${c.from})` : c.title));
  toc.append(ol);
  root.append(toc);
  let screen = null;
  for (const run of SR.pageRuns(rec.steps)) {
    if (run.type === "section") {
      const sec = el("section", "p-sec");
      sec.append(el("h3", "", run.step.text), el("p", "", run.step.note || ""));
      root.append(sec);
      continue;
    }
    const title = SR.pageTitle(run, rec.meta.headings !== false);
    const page = el("section", "p-page");
    if (title) page.append(el("h2", "p-screen", title));
    screen = title;
    if (run.lead && run.lead.screenshot) page.append(printFig(run));
    for (const s of run.steps) {
      const st = el("div", "p-step");
      const line = el("div", "p-line");
      line.append(el("span", "p-num", s.number), el("span", "", s.text));
      st.append(line);
      if (s.icon) { const ic = icons.get(s.id); if (ic) { const im = document.createElement("img"); im.className = "p-icon"; im.src = ic.url; line.append(im); } }
      if (s.note) st.append(el("div", "p-note", s.note));
      page.append(st);
    }
    root.append(page);
  }
  // Footer: language (left) and page number (right).
  let style = $("printStyle");
  if (!style) { style = document.createElement("style"); style.id = "printStyle"; document.head.append(style); }
  style.textContent = `@page { @bottom-left { content: ${JSON.stringify(SR.LANG_NAMES[rec.lang])}; font: 9pt Roboto, Arial, sans-serif; color: #465466; } @bottom-right { content: ${JSON.stringify(L.page + " ")} counter(page); font: 9pt Roboto, Arial, sans-serif; color: #465466; } }`;
}

/** The page screenshot with its numbered markers drawn into it (a Word document cannot overlay them), as JPEG bytes. */
async function flattenedPage(run) {
  const img = await loadImage(run.lead.screenshot);
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const unit = Math.max(c.width / 900, 1); // marker sizes in "editor pixels", scaled to the real image
  const badge = (x, y, n) => {
    ctx.fillStyle = "#0C65F4"; ctx.beginPath(); ctx.arc(x, y, 11 * unit, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = `700 ${13 * unit}px Montserrat, Arial, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(n), x, y + unit * 0.5);
  };
  for (const st of run.steps) {
    const m = st.marker;
    if (!markerShown(st)) continue;
    const sx = c.width / m.vw, sy = c.height / m.vh;
    ctx.lineWidth = 4 * unit; ctx.strokeStyle = "#0C65F4";
    if (m.shape === "circle") {
      ctx.fillStyle = "rgba(12,101,244,0.15)";
      ctx.beginPath(); ctx.arc(m.x * sx, m.y * sy, 17 * unit, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      badge(m.x * sx + 17 * unit * 0.8, m.y * sy - 17 * unit * 0.8, st.number);
    } else {
      ctx.strokeRect(m.x * sx, m.y * sy, m.w * sx, m.h * sy);
      badge(m.x * sx + 4 * unit, m.y * sy - 4 * unit, st.number);
    }
  }
  const b64 = c.toDataURL("image/jpeg", 0.88).split(",")[1];
  const bin = atob(b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, w: c.width, h: c.height };
}

/** Map of step id -> cropped icon, for the steps of unnamed controls. */
async function stepIcons() {
  const m = new Map();
  for (const run of SR.pageRuns(rec.steps)) if (run.type === "page") for (const s of run.steps) if (s.icon) { const ic = await StepIcon.stepIcon(s, run.lead); if (ic) m.set(s.id, ic); }
  return m;
}

function dataUrlBytes(url) {
  const bin = atob(url.split(",")[1]), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function exportDocx() {
  const icons = await stepIcons();
  const L = SR.DOC_LABELS[rec.lang] || SR.DOC_LABELS.en;
  const m = rec.meta;
  const blocks = [];
  let screen = null;
  for (const run of SR.pageRuns(rec.steps)) {
    if (run.type === "section") { blocks.push({ type: "section", heading: run.step.text, text: run.step.note || "" }); continue; }
    const title = SR.pageTitle(run, rec.meta.headings !== false);
    blocks.push({ type: "page", screen: title, image: run.lead && run.lead.screenshot ? await flattenedPage(run) : null, steps: run.steps.map((s) => ({ number: s.number, text: s.text, note: s.note, icon: icons.get(s.id) ? { bytes: dataUrlBytes(icons.get(s.id).url), w: icons.get(s.id).w, h: icons.get(s.id).h } : null })) });
    screen = title;
  }
  const bytes = DocxWriter.buildDocx({
    title: SR.brandTitle(m.title) || SR.brandTitle(L.untitled), workflow: m.workflow,
    meta: [[L.author, m.author], [L.version, m.version], [L.date, m.date], [L.language, SR.LANG_NAMES[rec.lang]]],
    contentsLabel: L.contents, toc: SR.contents(rec.steps).map((c) => (c.from ? `${c.title} (${L.step} ${c.from})` : c.title)),
    pageLabel: L.page, footerLeft: SR.LANG_NAMES[rec.lang], blocks
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
  a.download = ((m.title || rec.name || "step-recording").replace(/[\\/:*?"<>|]+/g, "_").trim() || "step-recording") + ".docx";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
$("seDocx").onclick = () => exportDocx().catch((e) => { $("seSaved").textContent = "Word export failed: " + e.message; });

load();
