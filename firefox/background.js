// Firefox MV2 background page (a real `window`, not a service worker — importScripts() doesn't
// exist here; the lib/*.js files are loaded via manifest.json's background.scripts array instead,
// same shared-global-scope effect). Uses `browser.*` throughout: Firefox's `browser.*` namespace
// is natively Promise-based for every API this file calls (storage, tabs, webRequest, permissions,
// runtime) — unlike its `chrome.*` compat shim, which is callback-oriented and not documented to
// support the promise-when-no-callback pattern the Chrome build relies on. Never assume that shim
// behaves like real Chrome; `browser.*` removes the question entirely.

const TRACKING_ENABLED_KEY = "trackingEnabled";
const TRACKED_PROJECTIONS_PREFIX = "tracked:"; // + baseUrl, browser.storage.session
const UNMATCHED_HOSTS_KEY = "unmatchedHosts";
const FLOW_TOKEN_PERSIST_KEY = "flowTokenPersist"; // { token, expiresAt }, browser.storage.session
const DESIGNER_TAB_PERSIST_KEY = "designerTabPersist"; // { tabId, orgId, itemId, packageId, packageResolved }

const LOG_PREFIX = "[IFS Projection Tracker]";
function log(...args) { console.log(LOG_PREFIX, ...args); }
function logError(...args) { console.error(LOG_PREFIX, ...args); }

const instanceStore = IfsInstances.createIfsInstanceStore({ local: browser.storage.local, session: browser.storage.session });
const flowToken = FlowToken.createTokenCache(45 * 60 * 1000);
let excludedSet = ProjectionFilter.parseExcludedList(""); // populated once `ready` resolves
let designerTabState = null; // { tabId, orgId, itemId, packageId, packageResolved }

async function restorePersistedState() {
  const { [FLOW_TOKEN_PERSIST_KEY]: tokenState } = await browser.storage.session.get(FLOW_TOKEN_PERSIST_KEY);
  if (tokenState && tokenState.expiresAt > Date.now()) {
    flowToken.set(tokenState.token); // expiry comes from the token's own JWT `exp`, so a restart doesn't extend it
  }
  const { [DESIGNER_TAB_PERSIST_KEY]: tabState } = await browser.storage.session.get(DESIGNER_TAB_PERSIST_KEY);
  if (tabState) designerTabState = tabState;
}

async function persistFlowToken(token) {
  await browser.storage.session.set({ [FLOW_TOKEN_PERSIST_KEY]: { token, expiresAt: flowToken.expiresAt() } });
}

async function persistDesignerTabState() {
  await browser.storage.session.set({ [DESIGNER_TAB_PERSIST_KEY]: designerTabState });
}

let ready;
function init() {
  ready = (async () => {
    const text = await (await fetch(browser.runtime.getURL("lib/excluded-projections.txt"))).text();
    excludedSet = ProjectionFilter.parseExcludedList(text);
    await restorePersistedState();
    await refreshDesignerTabState();
    log("Ready. Excluded projections:", [...excludedSet].join(", "));
  })();
}
init();

async function isTrackingEnabled() {
  const { [TRACKING_ENABLED_KEY]: enabled = true } = await browser.storage.local.get(TRACKING_ENABLED_KEY);
  return enabled;
}

function instanceForHost(instances, hostname) {
  return instances.find((i) => {
    try { return new URL(i.baseUrl).hostname === hostname; } catch { return false; }
  });
}

async function recordUnmatchedHost(hostname) {
  const { [UNMATCHED_HOSTS_KEY]: hosts = [] } = await browser.storage.session.get(UNMATCHED_HOSTS_KEY);
  if (hosts.includes(hostname)) return;
  await browser.storage.session.set({ [UNMATCHED_HOSTS_KEY]: [...hosts, hostname] });
}

// Serializes the read-modify-write of a session-storage tracked list — see the Chrome build's
// background.js for the full race-condition rationale; identical fix, same reason, here too.
let trackingQueue = Promise.resolve();

function enqueueTrackingWrite(fn) {
  trackingQueue = trackingQueue.then(fn, fn);
  return trackingQueue;
}

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    enqueueTrackingWrite(async () => {
      await ready;
      const enabled = await isTrackingEnabled();
      if (!Tracking.shouldTrackUrl(details.url, enabled, excludedSet)) return;

      const hostname = new URL(details.url).hostname;
      const instances = await instanceStore.listInstances();
      const instance = instanceForHost(instances, hostname);
      if (!instance) {
        await recordUnmatchedHost(hostname); // sidebar's GET_UNMATCHED_HOSTS surfaces an "add this instance" prompt
        return;
      }

      const projectionName = ProjectionFilter.extractSvcName(details.url);
      const key = TRACKED_PROJECTIONS_PREFIX + instance.baseUrl;
      const { [key]: list = [] } = await browser.storage.session.get(key);
      const next = Tracking.upsertTrackedProjection(list, projectionName, Date.now());
      if (next.length !== list.length) log("Tracked new projection:", projectionName, "on", instance.baseUrl);
      await browser.storage.session.set({ [key]: next });
    });
  },
  { urls: ["<all_urls>"] }
);

// No "extraHeaders" entry here (unlike the Chrome build) — that string is specifically Chrome's
// own M72+ opt-in for seeing restricted headers like Authorization via webRequest; Firefox's
// implementation has never gated Authorization behind a separate flag, and passing an extraInfoSpec
// string Firefox doesn't recognize is a risk not worth taking for no benefit.
let diagnosticLogsLeft = 8;

browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const token = FlowToken.extractBearerToken(details.requestHeaders);
    if (token) {
      if (!flowToken.get()) log("Captured a Novacura Flow session token from", details.url);
      flowToken.set(token);
      persistFlowToken(token);
    } else if (diagnosticLogsLeft > 0 && details.type === "xmlhttprequest") {
      diagnosticLogsLeft--;
      const headerNames = (details.requestHeaders || []).map((h) => h.name);
      log("No Authorization header seen on", details.url, "— headers present:", headerNames.join(", ") || "(none)");
    }
    return {};
  },
  { urls: ["https://build.novacura.com/*"] },
  ["requestHeaders"]
);

// Scoped to the active tab of the focused window — see the Chrome build's background.js for the
// full rationale (buttons should reflect whichever tab is actually in front right now).
async function refreshDesignerTabState() {
  // Only normal browser windows count: focusing a DevTools window (e.g. this worker's console),
  // a popup, or leaving the browser must not make the Designer tab look closed.
  let activeTab = null;
  try {
    const win = await browser.windows.getLastFocused({ windowTypes: ["normal"] });
    [activeTab] = await browser.tabs.query({ active: true, windowId: win.id });
  } catch {
    activeTab = null; // no normal window open at all
  }
  const parsed = activeTab && FlowDesignerTab.parseDesignerTabUrl(activeTab.url);
  if (!parsed) {
    if (designerTabState) log("Active tab is no longer a Designer tab — disabling Create/Activate.");
    designerTabState = null;
    await persistDesignerTabState();
    return;
  }
  const samePlace = designerTabState && designerTabState.orgId === parsed.orgId && designerTabState.itemId === parsed.itemId;
  if (!samePlace) log("Active Designer tab:", parsed);
  designerTabState = {
    tabId: activeTab.id,
    orgId: parsed.orgId,
    itemId: parsed.itemId,
    packageId: samePlace ? designerTabState.packageId : null,
    packageResolved: samePlace ? !!designerTabState.packageResolved : false
  };
  await persistDesignerTabState();
}

browser.tabs.onActivated.addListener(() => refreshDesignerTabState());
browser.tabs.onUpdated.addListener(() => refreshDesignerTabState());
browser.tabs.onRemoved.addListener(() => refreshDesignerTabState());
browser.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== browser.windows.WINDOW_ID_NONE) refreshDesignerTabState();
});

function boundFlowFetch() {
  const token = flowToken.get();
  if (!token) throw new Error("No Novacura Flow session found yet — open or interact with the Designer tab first.");
  return (path, options) => FlowConnectRest.flowFetch(token, path, options);
}

async function resolvePackageIdFor(tab) {
  if (tab.packageResolved) return tab.packageId;
  log("Resolving packageId for orgId=", tab.orgId, "itemId=", tab.itemId, "from the Designer's packageInfo...");
  const packageId = await FlowDesignerTab.resolvePackageId({ flowFetch: boundFlowFetch(), orgId: tab.orgId, itemId: tab.itemId });
  log(packageId ? `Resolved packageId = ${packageId}` : "Open flow is not in a package — using global assets (App Library).");
  tab.packageId = packageId;
  tab.packageResolved = true;
  if (designerTabState && designerTabState.orgId === tab.orgId && designerTabState.itemId === tab.itemId) {
    designerTabState.packageId = packageId;
    designerTabState.packageResolved = true;
    await persistDesignerTabState();
  }
  return packageId;
}

function captureDesignerTab() {
  if (!designerTabState) throw new Error("No Flow Designer tab is open.");
  return { ...designerTabState };
}

async function handleCreateModule({ baseUrl, projectionName, masterPassword }) {
  log("CREATE_MODULE start:", projectionName, "against", baseUrl);
  const tab = captureDesignerTab();
  const packageId = await resolvePackageIdFor(tab);
  const flowFetch = boundFlowFetch();
  const masterKey = await instanceStore.ensureMasterKey(IfsInstances.createOneShotPrompt(masterPassword));
  const ifsToken = await instanceStore.getIfsAuthToken(baseUrl, masterKey);
  log("Got an IFS auth token, fetching $metadata + OpenAPI for", projectionName, "...");

  const inputs = await ProjectionSearch.fetchProjectionCodegenInputs(baseUrl, ifsToken, projectionName);
  log("Codegen inputs ready (csdl", inputs.csdl.length, "bytes, openApiJson", inputs.openApiJson.length, "bytes) — calling Connect's code-gen API...");
  const code = await FlowModules.generateModuleCode({
    flowFetch, csdlXml: inputs.csdl, openApiJson: inputs.openApiJson,
    codeGenSubPath: inputs.codeGenSubPath, importSourcePath: inputs.projectionSubPath
  });
  log("Generated FlowScript source (", code.length, "bytes) — finding or creating the module asset...");
  const asset = await FlowModules.findOrCreateModule({ flowFetch, orgId: tab.orgId, packageId, projectionName });
  log("Module asset id =", asset.id, "— committing module code...");
  const newBranch = await FlowModules.commitModuleCode({ flowFetch, orgId: tab.orgId, packageId, assetId: asset.id, flowScriptCode: code });
  log("CREATE_MODULE done: assetId=", asset.id, "headVersionId=", newBranch.headVersionId);
  return { assetId: asset.id, headVersionId: newBranch.headVersionId, projectionName: asset.name || projectionName };
}

async function handleActivateModule({ assetId, headVersionId, projectionName }) {
  log("ACTIVATE_MODULE start: assetId=", assetId, "headVersionId=", headVersionId);
  const tab = captureDesignerTab();
  const flowFetch = boundFlowFetch();
  await FlowDesignerTab.activateModule({ flowFetch, orgId: tab.orgId, itemId: tab.itemId, assetId, headVersionId, moduleName: projectionName });
  log("ACTIVATE_MODULE done — refreshing the Designer so the module shows up...");
  try {
    const response = await browser.tabs.sendMessage(tab.tabId, { type: "CLICK_REFRESH" });
    if (response && response.clicked) {
      log("Clicked the Designer's own reload button.");
      return { refreshed: true };
    }
    log("Designer reload button not usable (", (response && response.reason) || "no response", ") — reloading the tab instead.");
  } catch (e) {
    log("Designer content script not reachable (", e.message, ") — reloading the tab instead.");
  }
  // Fallback: a full tab reload. Safe here: our save already went through with the Designer's
  // own lock, so its next save would have hit a 412 without a reload anyway.
  try {
    await browser.tabs.reload(tab.tabId);
    return { refreshed: true };
  } catch (e) {
    log("Tab reload failed:", e.message);
    return { refreshed: false };
  }
}

// Firefox's browser.runtime.onMessage natively supports an async listener returning a Promise
// that resolves to the response — no sendResponse/"return true" boilerplate needed (that dance
// exists only for Chrome's callback-based onMessage).
browser.runtime.onMessage.addListener(async (message) => {
  try {
    // A restarted background must finish restoring the persisted Connect token and Designer tab
    // before answering — otherwise the panel's first poll after every restart saw neither.
    await ready;
    const { masterPassword, fields, ...safeMessage } = message;
    log("Message:", message.type, fields ? { ...safeMessage, fields: { ...fields, secretPayload: "[redacted]" } } : safeMessage);
    switch (message.type) {
      case "LIST_INSTANCES":
        return { ok: true, instances: await instanceStore.listInstances() };
      case "GET_LOCK_STATUS":
        return { ok: true, ...(await instanceStore.getLockStatus()) };
      case "UNLOCK":
        await instanceStore.ensureMasterKey(IfsInstances.createOneShotPrompt(message.masterPassword));
        return { ok: true };
      case "SAVE_INSTANCE": {
        // sidebar.js's submit handler requests the host permission itself, from the real user
        // gesture — browser.permissions.request() has the same "must be called during a user
        // gesture" restriction as Chrome's, and no gesture context survives the messaging hop
        // into this background page either. This only verifies it was actually granted.
        const origin = new URL(message.baseUrl).origin + "/*";
        const granted = await browser.permissions.contains({ origins: [origin] });
        if (!granted) return { ok: false, error: `Permission for ${origin} was not granted — tracking for this instance won't work.` };
        // Connection check first: an instance whose credentials IFS rejects is never saved.
        try {
          await IfsInstances.requestIfsToken(message.fields, message.fields.secretPayload);
        } catch (e) {
          throw new Error(`Connection check failed, instance not saved — ${e.message}`);
        }
        await instanceStore.saveInstance(message.baseUrl, message.fields, await instanceStore.ensureMasterKey(IfsInstances.createOneShotPrompt(message.masterPassword)));
        return { ok: true };
      }
      case "TEST_INSTANCE": {
        const masterKey = await instanceStore.ensureMasterKey(IfsInstances.createOneShotPrompt(message.masterPassword));
        instanceStore.clearIfsAuthToken(message.baseUrl); // always a real round-trip, never the cache
        await instanceStore.getIfsAuthToken(message.baseUrl, masterKey);
        return { ok: true };
      }
      case "DELETE_INSTANCE":
        await instanceStore.deleteInstance(message.baseUrl);
        return { ok: true };
      case "GET_UNMATCHED_HOSTS": {
        const { [UNMATCHED_HOSTS_KEY]: hosts = [] } = await browser.storage.session.get(UNMATCHED_HOSTS_KEY);
        return { ok: true, hosts };
      }
      case "GET_TRACKING_ENABLED":
        return { ok: true, enabled: await isTrackingEnabled() };
      case "SET_TRACKING_ENABLED":
        await browser.storage.local.set({ [TRACKING_ENABLED_KEY]: message.enabled });
        return { ok: true };
      case "GET_TRACKED": {
        const key = TRACKED_PROJECTIONS_PREFIX + message.baseUrl;
        const { [key]: list = [] } = await browser.storage.session.get(key);
        return { ok: true, tracked: list };
      }
      case "CLEAR_TRACKED": {
        const key = TRACKED_PROJECTIONS_PREFIX + message.baseUrl;
        await browser.storage.session.remove(key);
        log("Cleared tracked projections for", message.baseUrl);
        return { ok: true };
      }
      case "SEARCH_PROJECTION": {
        const masterKey = await instanceStore.ensureMasterKey(IfsInstances.createOneShotPrompt(message.masterPassword));
        const token = await instanceStore.getIfsAuthToken(message.baseUrl, masterKey);
        const results = await ProjectionSearch.searchProjections(message.baseUrl, token, message.term);
        return { ok: true, results };
      }
      case "GET_DESIGNER_STATUS":
        return { ok: true, open: !!designerTabState, hasFlowToken: !!flowToken.get() };
      case "GET_MODULE_STATUSES": {
        if (!designerTabState) {
          const statuses = {};
          for (const name of message.projectionNames) statuses[name] = { status: "no_designer", assetId: null, headVersionId: null };
          return { ok: true, statuses };
        }
        const tab = captureDesignerTab();
        const packageId = await resolvePackageIdFor(tab);
        const flowFetch = boundFlowFetch();
        const [assets, designerData] = await Promise.all([
          FlowModules.listAssets({ flowFetch, orgId: tab.orgId, packageId }),
          FlowDesignerTab.getDesignerData({ flowFetch, orgId: tab.orgId, itemId: tab.itemId })
        ]);
        const statuses = {};
        for (const name of message.projectionNames) {
          const moduleAsset = FlowModules.findModuleInList(assets, name);
          statuses[name] = {
            status: FlowDesignerTab.computeModuleStatus(moduleAsset, designerData.assets),
            assetId: moduleAsset ? moduleAsset.id : null,
            headVersionId: moduleAsset ? moduleAsset.mainBranch.headVersionId : null
          };
        }
        log("Computed status for", message.projectionNames.length, "projection(s) in one pass");
        return { ok: true, statuses };
      }
      case "ACTIVATE_MODULE":
      case "CREATE_MODULE": // Create always activates in the open flow too
      case "RELOAD_AND_ACTIVATE":
        if (message.type !== "ACTIVATE_MODULE") {
          const created = await handleCreateModule(message);
          return { ok: true, result: await handleActivateModule(created) };
        }
        return { ok: true, result: await handleActivateModule(message) };
      default:
        return { ok: false, error: `Unknown message type: ${message.type}` };
    }
  } catch (e) {
    logError("Message", message.type, "failed:", e.message, e.stack);
    if (e.service === "connect" && e.status === 401) flowToken.clear();
    return { ok: false, error: e.message, needsMasterPassword: e.code === "MASTER_PASSWORD_REQUIRED" };
  }
});
