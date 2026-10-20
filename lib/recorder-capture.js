(function (global) {
  const IfsInstances = typeof require === "function" ? require("./ifs-instances.js") : global.IfsInstances;
  const RECORDER_MESSAGES = new Set(["START_RECORDING", "STOP_RECORDING", "GET_STATUS", "OPEN_VIEWER"]);
  const hasChrome = typeof chrome !== "undefined" && !!chrome.debugger;

  function isRecorderMessage(type) {
    return RECORDER_MESSAGES.has(type);
  }

  function unmatchedHostsInCalls(calls, instances) {
    const hosts = new Set();
    for (const call of calls || []) {
      const url = call.url || "";
      if (!url.includes("/main/ifsapplications/projection")) continue;
      let host;
      try { host = new URL(url).hostname; } catch { continue; }
      if (!IfsInstances.findInstanceForHost(instances, host)) hosts.add(host);
    }
    return [...hosts];
  }

  // ---- copied from IFS Buddy background.js (recording part), verbatim unless noted ----
  // Listener registrations are wrapped in if (hasChrome) so this file loads under Node for tests.
  // init() is exported and called by background.js (IFS Buddy called it at top level).

  const URL_FILTER = "main/ifsapplications/projection";
  const CDP_VERSION = "1.3";
  const MAX_BODY_CHARS = 1500000; // 1.5MB max per payload

  let isRecording = false;
  let currentCalls = [];
  let callCounter = 0;

  const attachedTabs = new Set();
  const inflight = new Map(); // "tabId:requestId" -> call object
  let persistTimer = null;
  let keepAliveTimer = null;

  async function init() {
    // currentCalls holds response bodies of up to 1.5 MB each, so it lives in storage.local
    // (session storage's 10 MB quota is shared with Tracker state and the unlock key).
    const s = await chrome.storage.session.get(["isRecording", "callCounter"]);
    const { currentCalls: storedCalls } = await chrome.storage.local.get("currentCalls");
    isRecording = !!s.isRecording;
    currentCalls = storedCalls || [];
    callCounter = s.callCounter || 0;
    updateBadge();
    if (isRecording) {
      attachAllTabs();
      startKeepAlive();
    }
  }

  function updateBadge() {
    chrome.action.setBadgeText({ text: isRecording ? "REC" : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#0A68FF" }); // Novacura Blue
  }

  /* --- Keep-Alive Mechanism --- */
  if (hasChrome) {
    chrome.alarms.onAlarm.addListener(() => { /* Wakes up service worker */ });
  }

  function startKeepAlive() {
    chrome.alarms.create("ifs-keepalive", { periodInMinutes: 0.5 });
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  }

  function stopKeepAlive() {
    chrome.alarms.clear("ifs-keepalive");
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }

  /* --- Tab Attachment Management (recording) --- */
  async function attachAllTabs() {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) await attachTab(t);
  }

  async function attachTab(tab) {
    if (!tab || !tab.id || tab.id < 0) return;
    if (!tab.url || !/^https?:/i.test(tab.url)) return;
    if (attachedTabs.has(tab.id)) return;

    try {
      await chrome.debugger.attach({ tabId: tab.id }, CDP_VERSION);
      attachedTabs.add(tab.id);
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.enable", {
        maxTotalBufferSize: 100 * 1024 * 1024,
        maxResourceBufferSize: 50 * 1024 * 1024,
        maxPostDataSize: 10 * 1024 * 1024
      });
    } catch (e) {
      // Ignore already attached or restricted tabs
    }
  }

  async function detachAllTabs() {
    for (const tabId of [...attachedTabs]) {
      try { await chrome.debugger.detach({ tabId }); } catch (e) {}
      attachedTabs.delete(tabId);
    }
  }

  if (hasChrome) {
    chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
      if (isRecording && info.status === "loading") attachTab(tab);
    });
    chrome.tabs.onCreated.addListener((tab) => { if (isRecording) attachTab(tab); });
    chrome.tabs.onRemoved.addListener((tabId) => attachedTabs.delete(tabId));
    chrome.debugger.onDetach.addListener((source) => {
      if (source.tabId) attachedTabs.delete(source.tabId);
    });

    /* --- Chrome DevTools Protocol Capture (recording only — a no-op while not recording,
       so this coexists safely with the token-capture listener above, which is added/removed
       per-call rather than staying registered) --- */
    chrome.debugger.onEvent.addListener(async (source, method, params) => {
      if (!isRecording || !source.tabId) return;
      const key = source.tabId + ":" + params.requestId;

      switch (method) {
        case "Network.requestWillBeSent": {
          const url = params.request.url || "";
          if (!url.includes(URL_FILTER)) return;
          inflight.set(key, {
            id: "call_" + (++callCounter) + "_" + Date.now(),
            tabId: source.tabId,
            url: url,
            method: params.request.method,
            requestHeaders: params.request.headers || {},
            requestBody: truncate(params.request.postData || null),
            hasPostData: !!params.request.hasPostData,
            timestamp: new Date((params.wallTime || Date.now() / 1000) * 1000).toISOString(),
            startTimeMs: Date.now(),
            _t0: params.timestamp,
            resourceType: params.type || "XHR"
          });
          break;
        }

        case "Network.responseReceived": {
          const rec = inflight.get(key);
          if (!rec) return;
          rec.status = params.response.status;
          rec.statusText = params.response.statusText;
          rec.mimeType = params.response.mimeType;
          rec.remoteIP = params.response.remoteIPAddress || "";
          rec.responseHeaders = params.response.headers || {};
          break;
        }

        case "Network.loadingFinished": {
          const rec = inflight.get(key);
          if (!rec) return;
          inflight.delete(key);
          rec.duration = Math.max(0, Math.round(((params.timestamp - rec._t0) || 0) * 1000));
          rec.size = params.encodedDataLength || 0;

          // Handle large post data if missing in initial event
          if (rec.hasPostData && !rec.requestBody) {
            try {
              const r = await chrome.debugger.sendCommand(
                { tabId: source.tabId }, "Network.getRequestPostData",
                { requestId: params.requestId }
              );
              rec.requestBody = truncate(r.postData);
            } catch (e) {}
          }

          // Fetch response body
          try {
            const r = await chrome.debugger.sendCommand(
              { tabId: source.tabId }, "Network.getResponseBody",
              { requestId: params.requestId }
            );
            rec.responseBody = truncate(r.base64Encoded ? safeAtob(r.body) : r.body);
          } catch (e) {
            rec.responseBody = null;
            rec.responseNote = "Response body unavailable or connection closed";
          }
          pushCall(rec);
          break;
        }

        case "Network.loadingFailed": {
          const rec = inflight.get(key);
          if (!rec) return;
          inflight.delete(key);
          rec.duration = Math.max(0, Math.round(((params.timestamp - rec._t0) || 0) * 1000));
          rec.status = 0;
          rec.error = params.errorText || "Network request failed";
          pushCall(rec);
          break;
        }
      }
    });
  }

  function safeAtob(b64) {
    try {
      const bin = atob(b64);
      const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
      return new TextDecoder("utf-8").decode(bytes);
    } catch (e) {
      return "<binary data>";
    }
  }

  function truncate(str) {
    if (!str) return null;
    return str.length > MAX_BODY_CHARS
      ? str.slice(0, MAX_BODY_CHARS) + "\n\n/* … Payload truncated due to size … */"
      : str;
  }

  function pushCall(rec) {
    delete rec._t0;
    currentCalls.push(rec);
    schedulePersist();
  }

  function schedulePersist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      chrome.storage.local.set({ currentCalls });
      chrome.storage.session.set({ callCounter });
    }, 300);
  }

  async function finalizeSession() {
    const session = {
      id: "sess_" + Date.now(),
      name: "IFS Session " + new Date().toLocaleDateString() + " " + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      createdAt: new Date().toISOString(),
      calls: currentCalls
    };
    const { sessions = [] } = await chrome.storage.local.get("sessions");
    sessions.unshift(session);
    await chrome.storage.local.set({ sessions });
    currentCalls = [];
    return session;
  }

  async function attachAllTabsCounting() {
    await attachAllTabs();
    return attachedTabs.size;
  }

  function handleMessage(msg, sendResponse) {
    switch (msg.type) {
      case "START_RECORDING":
        (async () => {
          try {
            isRecording = true;
            currentCalls = [];
            inflight.clear();
            await chrome.storage.local.set({ currentCalls: [] });
            await chrome.storage.session.set({ isRecording: true });
            updateBadge();
            startKeepAlive();
            // NovacuraBuddy: report when no tab could be attached, instead of "recording" nothing.
            const attached = await attachAllTabsCounting();
            sendResponse(attached > 0 ? { ok: true } : { ok: true, warning: "No tab could be attached — open an IFS tab (http/https) and it will be picked up." });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
        })();
        return true;
      case "STOP_RECORDING":
        (async () => {
          try {
            isRecording = false;
            updateBadge();
            stopKeepAlive();
            await detachAllTabs();

            // Flush any remaining in-flight calls
            for (const [, call] of inflight.entries()) {
              call.duration = Math.max(0, Date.now() - (call.startTimeMs || Date.now()));
              call.status = call.status || 0;
              if (!call.responseBody && !call.error) {
                call.responseNote = "Recording stopped while request was in-flight";
              }
              currentCalls.push(call);
            }
            inflight.clear();

            const session = await finalizeSession();
            await chrome.storage.session.set({ isRecording: false });
            await chrome.storage.local.set({ currentCalls: [] });
            // NovacuraBuddy: hosts in this session without a Basic Data instance
            const instances = await global.__recorderInstanceStore.listInstances();
            const unmatchedHosts = unmatchedHostsInCalls(session.calls, instances);
            sendResponse({ ok: true, session, unmatchedHosts });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
        })();
        return true;
      case "GET_STATUS":
        sendResponse({ recording: isRecording, callCount: currentCalls.length, attachedTabs: attachedTabs.size });
        return undefined;
      case "OPEN_VIEWER":
        chrome.tabs.create({ url: chrome.runtime.getURL("recorder/viewer.html" + (msg.sessionId ? "?s=" + msg.sessionId : "")) });
        sendResponse({ ok: true });
        return undefined;
    }
    return undefined;
  }

  // ---- copied verbatim from $BUDDY/background.js: the Traffic Explorer's Flow Connect token ----
  // The Explorer gets its token exactly as in IFS Buddy (debugger on the Flow tab, reload, first
  // Bearer of that load). Answering it from the Tracker's webRequest sniffer instead gave the
  // admin-connector API a token it rejects with 403.
  /* --- Novacura Flow Auth Token Capture ---
     Ported from migration/'s improved version (real error messages,
     pre-emptive detach before attach, retry-on-transient-detach-race —
     see project memory for why each of these exists) rather than V3's
     original, less resilient copy. */
  const FLOW_URL_PATTERN = "https://build.novacura.com/*";
  const FLOW_TOKEN_CACHE_TTL_MS = 45 * 60 * 1000; // 45 min, safely under Flow's ~1hr token lifetime
  let pendingFlowTokenCapture = null; // in-flight capture promise, shared across concurrent requesters

  async function getCachedFlowAuthToken() {
    const { flowAuthToken } = await chrome.storage.session.get("flowAuthToken");
    if (flowAuthToken && flowAuthToken.expiresAt > Date.now()) {
      return flowAuthToken.token;
    }
    return null;
  }

  async function captureFlowAuthToken() {
    const cached = await getCachedFlowAuthToken();
    if (cached) return cached;

    if (pendingFlowTokenCapture) return pendingFlowTokenCapture;

    pendingFlowTokenCapture = doCaptureFlowAuthTokenWithRetry().finally(() => {
      pendingFlowTokenCapture = null;
    });
    return pendingFlowTokenCapture;
  }

  /** A "Detached while handling command" (or similar) error means something detached the
   *  debugger session WHILE a CDP command was in flight — a real, confirmed-live transient race
   *  around the attach/detach lifecycle, not a structural problem. One automatic retry (fresh
   *  detach-then-attach, same as every attempt) resolves it in practice; only the retry's own
   *  failure is surfaced to the caller. */
  async function doCaptureFlowAuthTokenWithRetry() {
    try {
      return await doCaptureFlowAuthToken();
    } catch (e) {
      if (!/detach/i.test(e.message)) throw e;
      return doCaptureFlowAuthToken();
    }
  }

  async function doCaptureFlowAuthToken() {
    const tabs = await chrome.tabs.query({ url: FLOW_URL_PATTERN });
    if (!tabs.length || !tabs[0].id) {
      throw new Error("No Novacura Flow tab is open. Open https://build.novacura.com, log in, and try again.");
    }
    const tabId = tabs[0].id;
    const alreadyAttached = attachedTabs.has(tabId);

    if (!alreadyAttached) {
      // MV3 service workers get killed and restarted whenever idle, which wipes this in-memory
      // attachedTabs Set — but a prior attach can still be live at the real Chrome/CDP level (it's
      // tied to the tab, not the worker's lifetime). The next attempt then thinks it's attaching
      // fresh but Chrome sees an existing session and refuses. Detaching first (ignoring any error,
      // since there may be nothing to detach) clears that stale state before the real attach.
      try { await chrome.debugger.detach({ tabId }); } catch (e) {}
      try {
        await chrome.debugger.attach({ tabId }, CDP_VERSION);
      } catch (e) {
        // Surface the real Chrome error instead of a generic guess — a remaining common cause
        // after the pre-emptive detach above is DevTools (F12) open on the same tab, which Chrome
        // also refuses to share a debugger session with.
        throw new Error(`Could not attach to the Novacura Flow tab to read your session: ${e.message}`);
      }
      attachedTabs.add(tabId);
      try {
        await chrome.debugger.sendCommand({ tabId }, "Network.enable", {});
      } catch (e) {
        try { await chrome.debugger.detach({ tabId }); } catch (e2) {}
        attachedTabs.delete(tabId);
        throw new Error(`Could not enable network monitoring on the Novacura Flow tab: ${e.message}`);
      }
    }

    try {
      const token = await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          chrome.debugger.onEvent.removeListener(listener);
          reject(new Error("Could not read your Novacura Flow session in time. Try reloading the Flow tab and clicking Retry."));
        }, 10000);

        function listener(source, method, params) {
          if (source.tabId !== tabId || method !== "Network.requestWillBeSent") return;
          const url = params.request.url || "";
          if (!url.startsWith("https://build.novacura.com/")) return;
          const headers = params.request.headers || {};
          const authHeader = headers.Authorization || headers.authorization;
          if (authHeader && /^Bearer\s+/i.test(authHeader)) {
            clearTimeout(timeoutId);
            chrome.debugger.onEvent.removeListener(listener);
            resolve(authHeader.replace(/^Bearer\s+/i, ""));
          }
        }

        chrome.debugger.onEvent.addListener(listener);
        chrome.tabs.reload(tabId).catch(() => {
          clearTimeout(timeoutId);
          chrome.debugger.onEvent.removeListener(listener);
          reject(new Error("Could not reload the Novacura Flow tab to read your session."));
        });
      });

      await chrome.storage.session.set({
        flowAuthToken: { token, expiresAt: Date.now() + FLOW_TOKEN_CACHE_TTL_MS }
      });
      return token;
    } finally {
      if (!alreadyAttached && !isRecording) {
        try { await chrome.debugger.detach({ tabId }); } catch (e) {}
        attachedTabs.delete(tabId);
      }
    }
  }

  const api = { isRecorderMessage, handleMessage, unmatchedHostsInCalls, truncate, init, captureFlowAuthToken };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.RecorderCapture = api;
})(typeof window !== "undefined" ? window : globalThis);
