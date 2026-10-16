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
    const s = await chrome.storage.session.get(["isRecording", "currentCalls", "callCounter"]);
    isRecording = !!s.isRecording;
    currentCalls = s.currentCalls || [];
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
      chrome.storage.session.set({ currentCalls, callCounter });
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
          isRecording = true;
          currentCalls = [];
          inflight.clear();
          await chrome.storage.session.set({ isRecording: true, currentCalls: [] });
          updateBadge();
          startKeepAlive();
          // NovacuraBuddy: report when no tab could be attached, instead of "recording" nothing.
          const attached = await attachAllTabsCounting();
          sendResponse(attached > 0 ? { ok: true } : { ok: true, warning: "No tab could be attached — open an IFS tab (http/https) and it will be picked up." });
        })();
        return true;
      case "STOP_RECORDING":
        (async () => {
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
          await chrome.storage.session.set({ isRecording: false, currentCalls: [] });
          // NovacuraBuddy: hosts in this session without a Basic Data instance
          const instances = await global.__recorderInstanceStore.listInstances();
          const unmatchedHosts = unmatchedHostsInCalls(session.calls, instances);
          sendResponse({ ok: true, session, unmatchedHosts });
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

  const api = { isRecorderMessage, handleMessage, unmatchedHostsInCalls, truncate, init };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.RecorderCapture = api;
})(typeof window !== "undefined" ? window : globalThis);
