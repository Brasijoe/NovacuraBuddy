const test = require("node:test");
const assert = require("node:assert/strict");

function mockChrome() {
  const store = {};
  const sent = [];
  global.chrome = {
    storage: { local: {
      get: async (k) => (typeof k === "string" ? { [k]: store[k] } : { ...store }),
      set: async (o) => Object.assign(store, o),
      remove: async (k) => { delete store[k]; }
    } },
    tabs: {
      query: async () => [{ id: 7, windowId: 1, url: "https://app.novacura.com/x" }],
      get: async (id) => ({ id, windowId: 1, url: "https://app.novacura.com/x" }),
      sendMessage: async (id, m) => { sent.push([id, m]); return { ok: true }; },
      captureVisibleTab: async () => "data:image/jpeg;base64,AAAA"
    },
    scripting: { executeScript: async () => {} }
  };
  return { store, sent };
}

test("record, edit and stop a session", async () => {
  const { store, sent } = mockChrome();
  const Svc = require("./step-recorder-service.js");
  const sender = { tab: { id: 7, windowId: 1 } };
  assert.equal((await Svc.handle({ type: "STEPREC_START", lang: "de" }, {})).ok, true);
  assert.deepEqual(sent[0], [7, { type: "STEPREC_ARM", armed: true }]);
  const ev = (info, point) => ({ type: "STEPREC_EVENT", event: { info, screen: "Pack", rect: { x: 1, y: 2, w: 3, h: 4 }, point, vw: 100, vh: 50 } });
  await Svc.handle(ev({ event: "click", tag: "button", label: "Proceed" }, { x: 5, y: 6 }), sender);
  await Svc.handle(ev({ event: "change", tag: "input", type: "text", prompt: "Shipment No", value: "SHP-1" }, null), sender);
  await Svc.handle(ev({ event: "click", tag: "div" }, { x: 1, y: 1 }), sender);
  let rec = store.stepRec;
  assert.deepEqual(rec.steps.map((s) => s.text), ["Klicken Sie auf „Proceed“.", "Geben Sie „SHP-1“ in „Shipment No“ ein."]);
  assert.equal(rec.steps[0].marker.shape, "circle");
  assert.equal(rec.steps[1].marker.shape, "frame");
  assert.ok(rec.steps[0].screenshot.startsWith("data:image/jpeg"));
  // same screen and URL: one screenshot per page, the later step only adds its marker
  assert.equal(rec.steps[0].leads, true);
  assert.equal(rec.steps[1].leads, false);
  assert.equal(rec.steps[1].screenshot, null);
  // paused: nothing is captured, and events from other tabs are ignored
  await Svc.handle({ type: "STEPREC_PAUSE" }, {});
  await Svc.handle(ev({ event: "click", tag: "button", label: "X" }, { x: 1, y: 1 }), sender);
  await Svc.handle({ type: "STEPREC_RESUME" }, {});
  await Svc.handle(ev({ event: "click", tag: "button", label: "Y" }, { x: 1, y: 1 }), { tab: { id: 9 } });
  assert.equal(store.stepRec.steps.length, 2);
  await Svc.handle({ type: "STEPREC_EDIT", edit: { op: "lang", value: "en" } }, {});
  assert.equal(store.stepRec.steps[0].text, 'Click "Proceed".');
  await Svc.handle({ type: "STEPREC_SUB", action: "start", workflow: "Pack" }, {});
  assert.equal(store.stepRec.sub, "2");
  await Svc.handle(ev({ event: "click", tag: "button", label: "Next" }, { x: 1, y: 1 }), sender);
  assert.deepEqual(store.stepRec.steps.map((s) => s.number), ["1", "2", "2.1"]);
  const stop = await Svc.handle({ type: "STEPREC_STOP" }, {});
  assert.equal(stop.session.steps.length, 3);
  assert.equal(store.stepRec, undefined);
  assert.equal(store.stepRecSessions.length, 1);
});

test("start refuses a tab that is not the Flow web client", async () => {
  mockChrome();
  chrome.tabs.get = async (id) => ({ id, url: "https://example.com/" });
  const Svc = require("./step-recorder-service.js");
  const res = await Svc.handle({ type: "STEPREC_START", tabId: 3 }, {});
  assert.equal(res.ok, false);
});

test("a failed screenshot is recorded as an error on the step, not lost", async () => {
  const { store } = mockChrome();
  chrome.tabs.captureVisibleTab = async () => { throw new Error("Either the '<all_urls>' or 'activeTab' permission is required."); };
  const Svc = require("./step-recorder-service.js");
  await Svc.handle({ type: "STEPREC_START" }, {});
  await Svc.handle({ type: "STEPREC_EVENT", event: { info: { event: "click", tag: "button", label: "OK" }, point: { x: 1, y: 1 }, vw: 10, vh: 10 } }, { tab: { id: 7, windowId: 1 } });
  assert.equal(store.stepRec.steps.length, 1);
  assert.equal(store.stepRec.steps[0].screenshot, null);
  assert.match(store.stepRec.steps[0].shotError, /permission/);
});

test("start reports a page that has no recorder script", async () => {
  const { store } = mockChrome();
  chrome.tabs.sendMessage = async () => { throw new Error("Could not establish connection. Receiving end does not exist."); };
  chrome.scripting.executeScript = async () => { throw new Error("Cannot access contents of the page. Extension manifest must request permission"); };
  const Svc = require("./step-recorder-service.js");
  const res = await Svc.handle({ type: "STEPREC_START" }, {});
  assert.equal(res.ok, false);
  assert.match(res.error, /Site access/);
  assert.equal(store.stepRec, undefined);
});

test("a new screen title (or URL when there is no title) or a LoV starts a new page with its own screenshot", async () => {
  const { store } = mockChrome();
  let shots = 0;
  chrome.tabs.captureVisibleTab = async () => "data:image/jpeg;base64,S" + ++shots;
  const Svc = require("./step-recorder-service.js");
  await Svc.handle({ type: "STEPREC_START" }, {});
  const sender = { tab: { id: 7, windowId: 1 } };
  const click = (label, screen, page, extra) => Svc.handle({ type: "STEPREC_EVENT", event: { info: { event: "click", tag: "button", label, ...extra }, screen, page, point: { x: 1, y: 1 }, vw: 10, vh: 10 } }, sender);
  await click("A", "Pick", "/a"); await click("B", "Pick", "/b"); await click("C", "Pack", "/b");
  await click("D", "Pack", "/b"); await Svc.handle({ type: "STEPREC_NEWPAGE" }, {}); await click("E", "Pack", "/b");
  await click("F", "", "/c"); await click("G", "", "/c"); await click("H", "", "/d");
  assert.deepEqual(store.stepRec.steps.map((s) => s.leads), [true, false, true, false, true, true, false, true]);
  assert.equal(shots, 5);
});
