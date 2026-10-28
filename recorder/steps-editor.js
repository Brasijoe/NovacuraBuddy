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
$("mLang").onchange = () => { rec.lang = $("mLang").value; SR.relanguage(rec.steps, rec.lang); save(); render(); };
$("seAddSection").onclick = () => { SR.addSection(rec.steps, null, "Introduction"); save(); render(); };
$("sePdf").onclick = async () => {
  buildPrint();
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
  for (const st of run.steps) if (st.marker && st.marker.vw) fig.appendChild(markerEl(st, fig, onChange));
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

  const stepRow = (s, withMarkerTool) => {
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
    if (withMarkerTool && s.marker) tools.append(btn("Remove marker", "Remove this step's marker from the screenshot", () => { s.marker = null; refresh(); }));
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
    const screen = (run.lead && run.lead.screen) || run.steps[0].screen;
    if (screen) { const sc = document.createElement("div"); sc.className = "se-hint"; sc.textContent = screen; card.appendChild(sc); }
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
        if (f) { await fn(f); refresh(); } else b.classList.remove("on");
      });
      ptools.append(tool("Crop", "Keep only the area you draw", (f) => crop(run, f)), tool("Blur", "Blur the area you draw (private data)", (f) => blur(run, f)),
        btn("↑ Page", "Move this page (screenshot and its steps) up", () => { SR.movePage(rec.steps, run.lead.id, -1); refresh(); }),
        btn("↓ Page", "Move this page down", () => { SR.movePage(rec.steps, run.lead.id, 1); refresh(); }));
      if (rec.steps.indexOf(run.lead) > 0) ptools.append(btn("Join previous page", "Treat this page as part of the page before it (this screenshot is dropped)", () => { SR.joinPreviousPage(rec.steps, run.lead.id); refresh(); }));
      ptools.append(hint);
      card.appendChild(ptools);
    } else if (run.lead && run.lead.shotError) {
      const w = document.createElement("div"); w.className = "se-flag"; w.textContent = "No screenshot: " + run.lead.shotError; card.appendChild(w);
    }
    for (const s of run.steps) card.appendChild(stepRow(s, !!(run.lead && run.lead.screenshot)));
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
  for (const st of run.steps) if (st.marker && st.marker.vw) fig.appendChild(markerEl(st, fig, null));
  return fig;
}

/** The print view: cover, contents, then the steps grouped under their screen headings. */
function buildPrint() {
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
    const title = (run.lead && run.lead.screen) || run.steps[0].screen;
    const page = el("section", "p-page");
    if (title && title !== screen) page.append(el("h2", "p-screen", title));
    screen = title;
    if (run.lead && run.lead.screenshot) page.append(printFig(run));
    for (const s of run.steps) {
      const st = el("div", "p-step");
      const line = el("div", "p-line");
      line.append(el("span", "p-num", s.number), el("span", "", s.text));
      st.append(line);
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

load();
