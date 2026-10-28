/* Step Recorder - background side. Holds the recording in chrome.storage.local ("stepRec": the current one,
   "stepRecSessions": saved ones), takes a screenshot for every event the content script reports and applies
   the panel's edits through StepRecorder. */
(function (global) {
  const SR = typeof require === "function" ? require("./step-recorder.js") : global.StepRecorder;
  const hasChrome = typeof chrome !== "undefined" && !!chrome.storage;
  const MESSAGES = new Set(["STEPREC_START", "STEPREC_PAUSE", "STEPREC_RESUME", "STEPREC_STOP", "STEPREC_GET", "STEPREC_EVENT", "STEPREC_QUERY", "STEPREC_EDIT", "STEPREC_SUB", "STEPREC_NEWPAGE", "STEPREC_OPTION", "STEPREC_DELETE_SESSION", "STEPREC_LOAD_SESSION"]);
  const isStepRecMessage = (t) => MESSAGES.has(t);

  const get = async () => (await chrome.storage.local.get("stepRec")).stepRec || null;
  const put = (rec) => chrome.storage.local.set({ stepRec: rec });
  let chain = Promise.resolve();
  const serial = (fn) => (chain = chain.then(fn, fn));

  /** true when the page's recorder script answered, else the error text. */
  async function arm(tabId, armed, any) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: "STEPREC_ARM", armed, any: !!any });
      return r && r.ok ? true : "The page did not answer.";
    } catch (e) { return String((e && e.message) || e); }
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /** { shot } or { error }. Chrome allows about two captures a second, so a rate-limit error is retried once. */
  async function screenshot(windowId) {
    let err = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return { shot: await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 80 }) }; } catch (e) {
        err = String((e && e.message) || e);
        if (!/MAX_CAPTURE|quota|per second/i.test(err)) break;
        await wait(600);
      }
    }
    return { error: err };
  }

  /** Clicks get a circle at the click point; finished inputs get a frame around the field. */
  function markerFor(ev) {
    const r = ev.rect || {};
    const base = { vw: ev.vw, vh: ev.vh };
    if (ev.point) return { ...base, shape: "circle", x: ev.point.x, y: ev.point.y };
    return { ...base, shape: "frame", x: r.x, y: r.y, w: r.w, h: r.h };
  }

  const pending = new Set(); // screenshots still being taken
  const logEntry = (rec, text) => { rec.log = [...(rec.log || []).slice(-14), { t: Date.now(), text }]; };

  /** Attaches a screenshot to a page's lead step once Chrome has taken it; the step itself was added straight away. */
  async function attachShot(stepId, shotPromise) {
    const { shot, error } = await shotPromise; // waited for outside the queue, so later clicks are not held up
    return serial(async () => {
      const rec = await get();
      const step = rec && rec.steps.find((s) => s.id === stepId);
      if (!step) return;
      step.screenshot = shot || null; step.shotError = error || "";
      await put(rec);
    });
  }

  async function onEvent(msg, sender) {
    const rec = await get();
    if (!rec || rec.state !== "recording" || !sender.tab || sender.tab.id !== rec.tabId) return { ok: false };
    const ev = msg.event;
    rec.events = (rec.events || 0) + 1;
    if (ev.ignored) { rec.skipped = (rec.skipped || 0) + 1; logEntry(rec, "ignored: " + ev.ignored); await put(rec); return { ok: true, skipped: true }; }
    const c = SR.classify(ev.info);
    if (!c) { rec.skipped = (rec.skipped || 0) + 1; logEntry(rec, "ignored: " + (ev.info.event === "click" ? "click on a field (recorded when you leave it)" : "empty input") + " [" + (ev.info.label || ev.info.tag) + "]"); await put(rec); return { ok: true, skipped: true }; }
    // One screenshot per page: a step on the same screen (title, URL when there is none), the same layer (LoV or not) and
    // mostly the same visible controls as the page being recorded only adds its marker.
    const lov = c.kind === "lov";
    const samePage = !rec.forceNewPage && SR.samePage(rec.curPage, { screen: ev.screen, page: ev.page, lov, sig: ev.sig });
    const shotPromise = samePage ? null : screenshot(sender.tab.windowId); // started now, so it shows the page as it was at the click
    const step = SR.addStep(rec.steps, { kind: c.kind, data: c.data, lang: rec.lang, screen: ev.screen, screenshot: null, shotError: "", leads: !samePage, url: ev.page, lov, marker: markerFor(ev), review: !!ev.info.review, icon: ev.info.generic && ev.rect && ev.rect.w > 0 ? { x: ev.rect.x, y: ev.rect.y, w: ev.rect.w, h: ev.rect.h, vw: ev.vw, vh: ev.vh } : null }, rec.sub);
    if (!samePage) { rec.forceNewPage = false; rec.curPage = { screen: ev.screen, url: ev.page, lov, sig: ev.sig || [] }; }
    logEntry(rec, "step " + step.number + ": " + step.text + (samePage ? "" : " (new page)"));
    await put(rec);
    if (shotPromise) { const job = attachShot(step.id, shotPromise).finally(() => pending.delete(job)); pending.add(job); }
    return { ok: true, id: step.id };
  }

  async function handle(msg, sender) {
    switch (msg.type) {
      case "STEPREC_GET": return { rec: await get(), sessions: (await chrome.storage.local.get("stepRecSessions")).stepRecSessions || [] };
      case "STEPREC_QUERY": {
        const rec = await get();
        return { armed: !!(rec && rec.state === "recording" && sender.tab && sender.tab.id === rec.tabId), any: !!(rec && rec.any) };
      }
      case "STEPREC_START": {
        const tab = msg.tabId ? await chrome.tabs.get(msg.tabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
        if (!tab || !/^https:\/\/app\.novacura\.com\//.test(tab.url || "")) return { ok: false, error: "Open the Flow web client (app.novacura.com) in the active tab first." };
        const rec = { id: SR.TIMESTAMP_ID(), name: msg.name || "Recording " + new Date().toLocaleString(), lang: msg.lang || "en", state: "recording", tabId: tab.id, sub: null, steps: [], createdAt: Date.now() };
        rec.events = 0; rec.skipped = 0; rec.any = !!msg.any;
        let injectError = "";
        try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/step-recorder.js"] }); } catch (e) { injectError = String((e && e.message) || e); }
        const armed = await arm(tab.id, true, rec.any);
        if (armed !== true) {
          return { ok: false, error: "Cannot reach the Flow web client page (" + (injectError || armed) + "). Check Chrome > Extensions > Novacura Buddy > Details > Site access is \"On all sites\" (or on app.novacura.com), then reload the Flow tab (F5) and press Start again." };
        }
        await put(rec);
        return { ok: true, rec };
      }
      case "STEPREC_PAUSE": case "STEPREC_RESUME": {
        const rec = await get();
        if (!rec) return { ok: false };
        rec.state = msg.type === "STEPREC_PAUSE" ? "paused" : "recording";
        if (msg.type === "STEPREC_RESUME") rec.forceNewPage = true;
        await put(rec);
        await arm(rec.tabId, rec.state === "recording", rec.any);
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
      case "STEPREC_OPTION": { // msg.any: also record clicks on read-only objects
        const rec = await get();
        if (!rec) return { ok: false };
        rec.any = !!msg.any;
        await put(rec);
        await arm(rec.tabId, rec.state === "recording", rec.any);
        return { ok: true, rec };
      }
      case "STEPREC_NEWPAGE": { // the next step takes a new screenshot even if the page looks the same
        const rec = await get();
        if (!rec) return { ok: false };
        rec.forceNewPage = true;
        await put(rec);
        return { ok: true };
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

  const api = { isStepRecMessage, handle, MESSAGES, flush: async () => { while (pending.size) await Promise.all([...pending]); await chain; } };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.StepRecService = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
