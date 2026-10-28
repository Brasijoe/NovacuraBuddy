/* Step Recorder - background side. Holds the recording in chrome.storage.local ("stepRec": the current one,
   "stepRecSessions": saved ones), takes a screenshot for every event the content script reports and applies
   the panel's edits through StepRecorder. */
(function (global) {
  const SR = typeof require === "function" ? require("./step-recorder.js") : global.StepRecorder;
  const hasChrome = typeof chrome !== "undefined" && !!chrome.storage;
  const MESSAGES = new Set(["STEPREC_START", "STEPREC_PAUSE", "STEPREC_RESUME", "STEPREC_STOP", "STEPREC_GET", "STEPREC_EVENT", "STEPREC_QUERY", "STEPREC_EDIT", "STEPREC_SUB", "STEPREC_DELETE_SESSION", "STEPREC_LOAD_SESSION"]);
  const isStepRecMessage = (t) => MESSAGES.has(t);

  const get = async () => (await chrome.storage.local.get("stepRec")).stepRec || null;
  const put = (rec) => chrome.storage.local.set({ stepRec: rec });
  let chain = Promise.resolve();
  const serial = (fn) => (chain = chain.then(fn, fn));

  async function arm(tabId, armed) {
    try { await chrome.tabs.sendMessage(tabId, { type: "STEPREC_ARM", armed }); } catch { /* tab without the script */ }
  }

  async function screenshot(windowId) {
    try { return await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 80 }); } catch { return null; }
  }

  /** Clicks get a circle at the click point; finished inputs get a frame around the field. */
  function markerFor(ev) {
    const r = ev.rect || {};
    const base = { vw: ev.vw, vh: ev.vh };
    if (ev.point) return { ...base, shape: "circle", x: ev.point.x, y: ev.point.y };
    return { ...base, shape: "frame", x: r.x, y: r.y, w: r.w, h: r.h };
  }

  async function onEvent(msg, sender) {
    const rec = await get();
    if (!rec || rec.state !== "recording" || !sender.tab || sender.tab.id !== rec.tabId) return { ok: false };
    const ev = msg.event;
    const c = SR.classify(ev.info);
    if (!c) return { ok: true, skipped: true };
    const shot = await screenshot(sender.tab.windowId);
    const fresh = (await get()) || rec;
    if (fresh.state !== "recording") return { ok: true, skipped: true };
    const step = SR.addStep(fresh.steps, { kind: c.kind, data: c.data, lang: fresh.lang, screen: ev.screen, screenshot: shot, marker: markerFor(ev), review: !!ev.info.review }, fresh.sub);
    await put(fresh);
    return { ok: true, id: step.id };
  }

  async function handle(msg, sender) {
    switch (msg.type) {
      case "STEPREC_GET": return { rec: await get(), sessions: (await chrome.storage.local.get("stepRecSessions")).stepRecSessions || [] };
      case "STEPREC_QUERY": {
        const rec = await get();
        return { armed: !!(rec && rec.state === "recording" && sender.tab && sender.tab.id === rec.tabId) };
      }
      case "STEPREC_START": {
        const tab = msg.tabId ? await chrome.tabs.get(msg.tabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
        if (!tab || !/^https:\/\/app\.novacura\.com\//.test(tab.url || "")) return { ok: false, error: "Open the Flow web client (app.novacura.com) in the active tab first." };
        const rec = { id: SR.TIMESTAMP_ID(), name: msg.name || "Recording " + new Date().toLocaleString(), lang: msg.lang || "en", state: "recording", tabId: tab.id, sub: null, steps: [], createdAt: Date.now() };
        await put(rec);
        try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/step-recorder.js"] }); } catch { /* already injected by the manifest */ }
        await arm(tab.id, true);
        return { ok: true, rec };
      }
      case "STEPREC_PAUSE": case "STEPREC_RESUME": {
        const rec = await get();
        if (!rec) return { ok: false };
        rec.state = msg.type === "STEPREC_PAUSE" ? "paused" : "recording";
        await put(rec);
        await arm(rec.tabId, rec.state === "recording");
        return { ok: true, rec };
      }
      case "STEPREC_STOP": {
        const rec = await get();
        if (!rec) return { ok: false };
        await arm(rec.tabId, false);
        rec.state = "stopped";
        const saved = (await chrome.storage.local.get("stepRecSessions")).stepRecSessions || [];
        saved.unshift({ ...rec, tabId: undefined, stoppedAt: Date.now() });
        await chrome.storage.local.set({ stepRecSessions: saved });
        await chrome.storage.local.remove("stepRec");
        return { ok: true, session: saved[0] };
      }
      case "STEPREC_SUB": { // msg.action "start" (the last step opens a sub-workflow) | "end"
        const rec = await get();
        if (!rec) return { ok: false };
        if (msg.action === "start") {
          const last = rec.steps[rec.steps.length - 1];
          if (!last || last.sub) return { ok: false, error: "A sub-workflow starts after a main step." };
          last.kind = "sub"; last.data = { workflow: msg.workflow || "" }; last.text = SR.sentence(last, rec.lang); last.edited = false;
          rec.sub = last.number;
        } else rec.sub = null;
        await put(rec);
        return { ok: true, rec };
      }
      case "STEPREC_EDIT": { // msg.edit = { op: text|note|delete|up|down|merge|lang, id, value }
        const rec = await get();
        if (!rec) return { ok: false };
        const e = msg.edit || {};
        const step = rec.steps.find((s) => s.id === e.id);
        if (e.op === "text" && step) { step.text = e.value; step.edited = true; }
        else if (e.op === "note" && step) step.note = e.value;
        else if (e.op === "delete") SR.removeStep(rec.steps, e.id);
        else if (e.op === "up" || e.op === "down") SR.moveStep(rec.steps, e.id, e.op === "up" ? -1 : 1);
        else if (e.op === "merge") SR.mergeWithPrevious(rec.steps, e.id);
        else if (e.op === "lang") { rec.lang = e.value; SR.relanguage(rec.steps, e.value); }
        else if (e.op === "name") rec.name = e.value;
        await put(rec);
        return { ok: true, rec };
      }
      case "STEPREC_EVENT": return serial(() => onEvent(msg, sender));
      case "STEPREC_DELETE_SESSION": {
        const saved = ((await chrome.storage.local.get("stepRecSessions")).stepRecSessions || []).filter((s) => s.id !== msg.id);
        await chrome.storage.local.set({ stepRecSessions: saved });
        return { ok: true, sessions: saved };
      }
      default: return { ok: false, error: "Unknown step recorder message" };
    }
  }

  const api = { isStepRecMessage, handle, MESSAGES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.StepRecService = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
