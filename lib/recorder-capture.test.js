const test = require("node:test");
const assert = require("node:assert/strict");
const { isRecorderMessage, unmatchedHostsInCalls, truncate } = require("./recorder-capture.js");

test("isRecorderMessage claims exactly the recorder's message types", () => {
  for (const t of ["START_RECORDING", "STOP_RECORDING", "GET_STATUS", "OPEN_VIEWER"]) assert.equal(isRecorderMessage(t), true);
  for (const t of ["GET_FLOW_TOKEN", "GET_TRACKED", "CREATE_MODULE", undefined]) assert.equal(isRecorderMessage(t), false);
});

test("unmatchedHostsInCalls lists IFS hosts without an instance, once each", () => {
  const calls = [
    { url: "https://known.example.com/main/ifsapplications/projection/v1/A.svc/X" },
    { url: "https://new.example.com/main/ifsapplications/projection/v1/B.svc/Y" },
    { url: "https://new.example.com/main/ifsapplications/projection/v1/C.svc/Z" },
    { url: "https://cdn.example.com/script.js" }
  ];
  const instances = [{ baseUrl: "https://known.example.com", name: "K" }];
  assert.deepEqual(unmatchedHostsInCalls(calls, instances), ["new.example.com"]);
});

test("truncate caps very large bodies", () => {
  assert.equal(truncate(null), null);
  assert.ok(truncate("x".repeat(2000000)).length < 2000000);
});

// ---- handleMessage / lifecycle, against a fake chrome installed BEFORE the module is required ----

function makeFakeChrome({ tabs = [] } = {}) {
  const areas = { local: {}, session: {} };
  const area = (data) => ({
    async get(keys) {
      if (keys == null) return { ...data };
      const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in data) out[k] = data[k];
      return out;
    },
    async set(obj) { Object.assign(data, obj); },
    async remove(k) { for (const key of [].concat(k)) delete data[key]; }
  });
  const listeners = () => { const fns = []; return { fns, addListener: (f) => fns.push(f) }; };
  const calls = { attach: [], detach: [], sendCommand: [], badgeText: [], badgeColor: [], alarmsCreated: [], alarmsCleared: [], tabsCreated: [] };
  const fake = {
    storage: { local: area(areas.local), session: area(areas.session) },
    debugger: {
      async attach(target, version) { calls.attach.push({ target, version }); },
      async detach(target) { calls.detach.push(target); },
      async sendCommand(target, method, params) {
        calls.sendCommand.push({ target, method, params });
        if (method === "Network.getResponseBody") return { body: '{"ok":true}', base64Encoded: false };
        return {};
      },
      onEvent: listeners(),
      onDetach: listeners()
    },
    tabs: {
      async query() { return tabs; },
      create(info) { calls.tabsCreated.push(info); },
      onUpdated: listeners(), onCreated: listeners(), onRemoved: listeners()
    },
    action: {
      setBadgeText(o) { calls.badgeText.push(o); },
      setBadgeBackgroundColor(o) { calls.badgeColor.push(o); }
    },
    alarms: {
      create(name, info) { calls.alarmsCreated.push({ name, info }); },
      clear(name) { calls.alarmsCleared.push(name); },
      onAlarm: listeners()
    },
    runtime: {
      getURL: (p) => "chrome-extension://abc/" + p,
      getPlatformInfo(cb) { if (cb) cb({}); }
    }
  };
  return { fake, areas, calls };
}

async function withRecorder(options, fn) {
  const saved = { chrome: global.chrome, store: global.__recorderInstanceStore, RecorderCapture: global.RecorderCapture };
  const env = makeFakeChrome(options);
  global.chrome = env.fake;
  global.__recorderInstanceStore = { listInstances: async () => (options && options.instances) || [] };
  const modPath = require.resolve("./recorder-capture.js");
  delete require.cache[modPath];
  const rec = require("./recorder-capture.js");
  const send = (msg) => new Promise((resolve) => { rec.handleMessage(msg, resolve); });
  try {
    await fn({ rec, send, ...env });
  } finally {
    delete require.cache[modPath];
    global.chrome = saved.chrome;
    global.__recorderInstanceStore = saved.store;
    global.RecorderCapture = saved.RecorderCapture;
    if (saved.chrome === undefined) delete global.chrome;
    if (saved.store === undefined) delete global.__recorderInstanceStore;
    if (saved.RecorderCapture === undefined) delete global.RecorderCapture;
  }
}

const ifsUrl = "https://new.example.com/main/ifsapplications/projection/v1/A.svc/X";

async function recordOneCall(env, url = ifsUrl) {
  const [onEvent] = env.fake.debugger.onEvent.fns;
  const base = { requestId: "r1", timestamp: 1 };
  await onEvent({ tabId: 7 }, "Network.requestWillBeSent", { ...base, wallTime: 1000, type: "XHR", request: { url, method: "GET", headers: {} } });
  await onEvent({ tabId: 7 }, "Network.responseReceived", { ...base, response: { status: 200, statusText: "OK", mimeType: "application/json", headers: {} } });
  await onEvent({ tabId: 7 }, "Network.loadingFinished", { ...base, timestamp: 1.5, encodedDataLength: 12 });
}

test("START_RECORDING with an attachable http tab responds ok, sets the REC badge and attaches the debugger", async () => {
  await withRecorder({ tabs: [{ id: 7, url: "https://new.example.com/app" }] }, async (env) => {
    const res = await env.send({ type: "START_RECORDING" });
    try {
      assert.deepEqual(res, { ok: true });
      assert.ok(env.calls.badgeText.some((b) => b.text === "REC"));
      assert.equal(env.calls.attach.length, 1);
      assert.equal(env.calls.attach[0].target.tabId, 7);
      assert.equal(env.areas.session.isRecording, true);
    } finally {
      await env.send({ type: "STOP_RECORDING" });
    }
  });
});

test("START_RECORDING with only chrome:// tabs responds ok with a warning", async () => {
  await withRecorder({ tabs: [{ id: 1, url: "chrome://extensions" }, { id: 2, url: "chrome://newtab" }] }, async (env) => {
    const res = await env.send({ type: "START_RECORDING" });
    try {
      assert.equal(res.ok, true);
      assert.match(res.warning, /No tab could be attached/);
      assert.equal(env.calls.attach.length, 0);
    } finally {
      await env.send({ type: "STOP_RECORDING" });
    }
  });
});

test("GET_STATUS reports recording, callCount and attachedTabs", async () => {
  await withRecorder({ tabs: [{ id: 7, url: "https://new.example.com/app" }] }, async (env) => {
    assert.deepEqual(await env.send({ type: "GET_STATUS" }), { recording: false, callCount: 0, attachedTabs: 0 });
    await env.send({ type: "START_RECORDING" });
    try {
      await recordOneCall(env);
      assert.deepEqual(await env.send({ type: "GET_STATUS" }), { recording: true, callCount: 1, attachedTabs: 1 });
    } finally {
      await env.send({ type: "STOP_RECORDING" });
    }
  });
});

test("STOP_RECORDING finalizes the session into storage.local.sessions and reports unmatched hosts", async () => {
  const instances = [{ baseUrl: "https://known.example.com", name: "K" }];
  await withRecorder({ tabs: [{ id: 7, url: "https://new.example.com/app" }], instances }, async (env) => {
    env.areas.local.sessions = [{ id: "old", name: "Old", createdAt: "2020-01-01T00:00:00.000Z", calls: [] }];
    await env.send({ type: "START_RECORDING" });
    await recordOneCall(env);
    const res = await env.send({ type: "STOP_RECORDING" });
    assert.equal(res.ok, true);
    assert.deepEqual(res.unmatchedHosts, ["new.example.com"]);
    assert.equal(res.session.calls.length, 1);
    assert.equal(res.session.calls[0].url, ifsUrl);
    const sessions = env.areas.local.sessions;
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].id, res.session.id, "new session is unshifted to the front");
    assert.equal(sessions[1].id, "old");
    assert.ok(sessions[0].name && sessions[0].createdAt);
    assert.equal(sessions[0].calls.length, 1);
    assert.equal(env.areas.session.isRecording, false);
    assert.ok(env.calls.alarmsCleared.includes("ifs-keepalive"));
    assert.ok(env.calls.badgeText.some((b) => b.text === ""));
  });
});

test("currentCalls lives in storage.local, never in storage.session (10 MB quota)", async () => {
  await withRecorder({ tabs: [{ id: 7, url: "https://new.example.com/app" }] }, async (env) => {
    await env.send({ type: "START_RECORDING" });
    try {
      assert.deepEqual(env.areas.local.currentCalls, [], "START resets it in local");
      assert.equal("currentCalls" in env.areas.session, false);
      await recordOneCall(env);
      await new Promise((r) => setTimeout(r, 400)); // schedulePersist debounce is 300ms
      assert.equal(env.areas.local.currentCalls.length, 1);
      assert.equal("currentCalls" in env.areas.session, false);
      assert.equal(env.areas.session.callCounter, 1);
    } finally {
      await env.send({ type: "STOP_RECORDING" });
    }
    assert.deepEqual(env.areas.local.currentCalls, [], "STOP resets it in local");
    assert.equal("currentCalls" in env.areas.session, false);
  });
});

test("init restores a mid-recording state: calls from local, isRecording/callCounter from session", async () => {
  await withRecorder({ tabs: [{ id: 7, url: "https://new.example.com/app" }] }, async (env) => {
    env.areas.session.isRecording = true;
    env.areas.session.callCounter = 5;
    env.areas.local.currentCalls = [{ id: "c1", url: ifsUrl }];
    await env.rec.init();
    try {
      assert.equal((await env.send({ type: "GET_STATUS" })).callCount, 1);
      assert.ok(env.calls.badgeText.some((b) => b.text === "REC"));
    } finally {
      await env.send({ type: "STOP_RECORDING" });
    }
  });
});

test("START_RECORDING and STOP_RECORDING answer { ok: false, error } instead of hanging when storage throws", async () => {
  await withRecorder({ tabs: [] }, async (env) => {
    env.fake.storage.session.set = async () => { throw new Error("quota exceeded"); };
    const start = await env.send({ type: "START_RECORDING" });
    assert.deepEqual(start, { ok: false, error: "quota exceeded" });
  });
  await withRecorder({ tabs: [] }, async (env) => {
    env.fake.storage.local.set = async () => { throw new Error("disk full"); };
    const stop = await env.send({ type: "STOP_RECORDING" });
    assert.deepEqual(stop, { ok: false, error: "disk full" });
  });
});
