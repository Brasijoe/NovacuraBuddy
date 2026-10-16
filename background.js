importScripts(
  "lib/credential-crypto.js",
  "lib/projection-filter.js",
  "lib/ifs-instances.js",
  "lib/projection-search.js",
  "lib/flow-connect-rest.js",
  "lib/tracking.js",
  "lib/flow-designer-tab.js",
  "lib/flow-modules.js",
  "lib/flow-token.js"
);

// Without this, the toolbar icon has no default_popup and MV3 does nothing on click — the panel
// only opens via Chrome's own side-panel menu, which most users won't find unprompted.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const TRACKING_ENABLED_KEY = "trackingEnabled";
const TRACKED_PROJECTIONS_PREFIX = "tracked:"; // + baseUrl, chrome.storage.session
const UNMATCHED_HOSTS_KEY = "unmatchedHosts";
const FLOW_TOKEN_PERSIST_KEY = "flowTokenPersist"; // { token, expiresAt }, chrome.storage.session
const DESIGNER_TAB_PERSIST_KEY = "designerTabPersist"; // { tabId, orgId, itemId, packageId, packageResolved }

const LOG_PREFIX = "[IFS Projection Tracker]";
function log(...args) { console.log(LOG_PREFIX, ...args); }
function logError(...args) { console.error(LOG_PREFIX, ...args); }

const instanceStore = IfsInstances.createIfsInstanceStore({ local: chrome.storage.local, session: chrome.storage.session });
const flowToken = FlowToken.createTokenCache(45 * 60 * 1000);
let excludedSet = ProjectionFilter.parseExcludedList(""); // populated once `ready` resolves
let designerTabState = null; // { tabId, orgId, itemId, packageId, packageResolved }

// MV3 kills this service worker after ~30s idle, wiping every top-level `let` above. Both the
// sniffed Connect token and the resolved Designer-tab state are persisted to chrome.storage.session
// (survives worker restarts, not browser restarts) so a restart doesn't make a still-open, still-
// authenticated Designer tab look absent (spec §7a's documented 45-minute window only holds if the
// worker actually lives that long, which it usually doesn't).
async function restorePersistedState() {
  const { [FLOW_TOKEN_PERSIST_KEY]: tokenState } = await chrome.storage.session.get(FLOW_TOKEN_PERSIST_KEY);
  if (tokenState && tokenState.expiresAt > Date.now()) {
    flowToken.set(tokenState.token); // expiry comes from the token's own JWT `exp`, so a restart doesn't extend it
  }
  const { [DESIGNER_TAB_PERSIST_KEY]: tabState } = await chrome.storage.session.get(DESIGNER_TAB_PERSIST_KEY);
  if (tabState) designerTabState = tabState;
}

async function persistFlowToken(token) {
  await chrome.storage.session.set({ [FLOW_TOKEN_PERSIST_KEY]: { token, expiresAt: flowToken.expiresAt() } });
}

async function persistDesignerTabState() {
  await chrome.storage.session.set({ [DESIGNER_TAB_PERSIST_KEY]: designerTabState });
}

let ready;
function init() {
  ready = (async () => {
    const text = await (await fetch(chrome.runtime.getURL("lib/excluded-projections.txt"))).text();
    excludedSet = ProjectionFilter.parseExcludedList(text);
    await restorePersistedState();
    // Without this, a Designer tab already open and idle before the worker starts/restarts stays
    // invisible until its next tabs.onUpdated fires — which a tab that's just sitting there open
    // may never do — leaving Create/Activate stuck disabled for a reason the user can't act on.
    await refreshDesignerTabState();
    log("Ready. Excluded projections:", [...excludedSet].join(", "));
  })();
}
init();

async function isTrackingEnabled() {
  const { [TRACKING_ENABLED_KEY]: enabled = true } = await chrome.storage.local.get(TRACKING_ENABLED_KEY);
  return enabled;
}

function instanceForHost(instances, hostname) {
  return instances.find((i) => {
    try { return new URL(i.baseUrl).hostname === hostname; } catch { return false; }
  });
}

async function recordUnmatchedHost(hostname) {
  const { [UNMATCHED_HOSTS_KEY]: hosts = [] } = await chrome.storage.session.get(UNMATCHED_HOSTS_KEY);
  if (hosts.includes(hostname)) return;
  await chrome.storage.session.set({ [UNMATCHED_HOSTS_KEY]: [...hosts, hostname] });
}

// Serializes the read-modify-write of a session-storage tracked list: Aurena fires several .svc
// calls close together, and two overlapping onBeforeRequest handlers reading the same pre-write
// snapshot would otherwise silently drop one hit (or a whole distinct projection) to a last-write-
// wins race. Chaining every upsert through one promise makes each read see the previous write.
let trackingQueue = Promise.resolve();

function enqueueTrackingWrite(fn) {
  trackingQueue = trackingQueue.then(fn, fn);
  return trackingQueue;
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    enqueueTrackingWrite(async () => {
      await ready;
      const enabled = await isTrackingEnabled();
      if (!Tracking.shouldTrackUrl(details.url, enabled, excludedSet)) return;

      const hostname = new URL(details.url).hostname;
      const instances = await instanceStore.listInstances();
      const instance = instanceForHost(instances, hostname);
      if (!instance) {
        await recordUnmatchedHost(hostname); // side panel's GET_UNMATCHED_HOSTS surfaces an "add this instance" prompt
        return;
      }

      const projectionName = ProjectionFilter.extractSvcName(details.url);
      const key = TRACKED_PROJECTIONS_PREFIX + instance.baseUrl;
      const { [key]: list = [] } = await chrome.storage.session.get(key);
      const next = Tracking.upsertTrackedProjection(list, projectionName, Date.now());
      if (next.length !== list.length) log("Tracked new projection:", projectionName, "on", instance.baseUrl);
      await chrome.storage.session.set({ [key]: next });
    });
  },
  { urls: ["<all_urls>"] }
);

// Diagnostic only, capped — if token capture stays broken, this is the thing to read: does Chrome
// even deliver an Authorization header to this listener for Connect's own XHR/fetch calls at all,
// or is a header present but under a name/shape extractBearerToken doesn't recognize?
let diagnosticLogsLeft = 8;

chrome.webRequest.onBeforeSendHeaders.addListener(
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
  ["requestHeaders", "extraHeaders"]
);

// Scoped to the active tab of the focused window, not "any tab anywhere with a Designer URL" —
// otherwise Create/Activate stayed enabled forever once a Designer tab existed, even after
// switching away to a completely different tab, which is confusing: the buttons act on whichever
// tab is actually in front of the user right now.
async function refreshDesignerTabState() {
  // Only normal browser windows count: focusing a DevTools window (e.g. this worker's console),
  // a popup, or leaving the browser must not make the Designer tab look closed.
  let activeTab = null;
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    [activeTab] = await chrome.tabs.query({ active: true, windowId: win.id });
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
  // Keep the already-resolved packageId when it's still the same org+item — this cache is spec
  // §7's whole point ("a one-time cost per Designer tab, not per action"); re-deriving it on every
  // tab-state refresh (which fires often while just browsing) would defeat it.
  // `packageResolved` is separate from `packageId` because null is a real answer: a global flow.
  designerTabState = {
    tabId: activeTab.id,
    orgId: parsed.orgId,
    itemId: parsed.itemId,
    packageId: samePlace ? designerTabState.packageId : null,
    packageResolved: samePlace ? !!designerTabState.packageResolved : false
  };
  await persistDesignerTabState();
}

chrome.tabs.onActivated.addListener(() => refreshDesignerTabState());
chrome.tabs.onUpdated.addListener(() => refreshDesignerTabState());
chrome.tabs.onRemoved.addListener(() => refreshDesignerTabState());
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) refreshDesignerTabState();
});

function boundFlowFetch() {
  const token = flowToken.get();
  if (!token) throw new Error("No Novacura Flow session found yet — open or interact with the Designer tab first.");
  return (path, options) => FlowConnectRest.flowFetch(token, path, options);
}

// Resolves packageId against a specific, already-captured tab snapshot — never the live mutable
// `designerTabState` — so a navigation mid-await can't turn a later property read into a raw
// TypeError. Still updates the live state's cache opportunistically when it's still the same tab.
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
    const response = await chrome.tabs.sendMessage(tab.tabId, { type: "CLICK_REFRESH" });
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
    await chrome.tabs.reload(tab.tabId);
    return { refreshed: true };
  } catch (e) {
    log("Tab reload failed:", e.message);
    return { refreshed: false };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      // A restarted worker must finish restoring the persisted Connect token and Designer tab
      // before answering — otherwise the panel's first poll after every restart saw neither.
      await ready;
      const { masterPassword, fields, ...safeMessage } = message;
      log("Message:", message.type, fields ? { ...safeMessage, fields: { ...fields, secretPayload: "[redacted]" } } : safeMessage);
      switch (message.type) {
        case "LIST_INSTANCES":
          return sendResponse({ ok: true, instances: await instanceStore.listInstances() });
        case "GET_LOCK_STATUS":
          return sendResponse({ ok: true, ...(await instanceStore.getLockStatus()) });
        case "UNLOCK":
          await instanceStore.ensureMasterKey(IfsInstances.createOneShotPrompt(message.masterPassword));
          return sendResponse({ ok: true });
        case "SAVE_INSTANCE": {
          // The host permission must already be granted by the time this runs — sidepanel.js
          // requests it from the submit handler's own user gesture, since chrome.permissions.request()
          // rejects with "must be called during a user gesture" when called from a service worker's
          // onMessage handler (no gesture context survives the messaging hop). This only verifies.
          const origin = new URL(message.baseUrl).origin + "/*";
          const granted = await chrome.permissions.contains({ origins: [origin] });
          if (!granted) return sendResponse({ ok: false, error: `Permission for ${origin} was not granted — tracking for this instance won't work.` });
          // Connection check first: an instance whose credentials IFS rejects is never saved.
          try {
            await IfsInstances.requestIfsToken(message.fields, message.fields.secretPayload);
          } catch (e) {
            throw new Error(`Connection check failed, instance not saved — ${e.message}`);
          }
          await instanceStore.saveInstance(message.baseUrl, message.fields, await instanceStore.ensureMasterKey(IfsInstances.createOneShotPrompt(message.masterPassword)));
          return sendResponse({ ok: true });
        }
        case "TEST_INSTANCE": {
          const masterKey = await instanceStore.ensureMasterKey(IfsInstances.createOneShotPrompt(message.masterPassword));
          instanceStore.clearIfsAuthToken(message.baseUrl); // always a real round-trip, never the cache
          await instanceStore.getIfsAuthToken(message.baseUrl, masterKey);
          return sendResponse({ ok: true });
        }
        case "DELETE_INSTANCE":
          await instanceStore.deleteInstance(message.baseUrl);
          return sendResponse({ ok: true });
        case "GET_UNMATCHED_HOSTS": {
          const { [UNMATCHED_HOSTS_KEY]: hosts = [] } = await chrome.storage.session.get(UNMATCHED_HOSTS_KEY);
          return sendResponse({ ok: true, hosts });
        }
        case "GET_TRACKING_ENABLED":
          return sendResponse({ ok: true, enabled: await isTrackingEnabled() });
        case "SET_TRACKING_ENABLED":
          await chrome.storage.local.set({ [TRACKING_ENABLED_KEY]: message.enabled });
          return sendResponse({ ok: true });
        case "GET_TRACKED": {
          const key = TRACKED_PROJECTIONS_PREFIX + message.baseUrl;
          const { [key]: list = [] } = await chrome.storage.session.get(key);
          return sendResponse({ ok: true, tracked: list });
        }
        case "CLEAR_TRACKED": {
          const key = TRACKED_PROJECTIONS_PREFIX + message.baseUrl;
          await chrome.storage.session.remove(key);
          log("Cleared tracked projections for", message.baseUrl);
          return sendResponse({ ok: true });
        }
        case "SEARCH_PROJECTION": {
          const masterKey = await instanceStore.ensureMasterKey(IfsInstances.createOneShotPrompt(message.masterPassword));
          const token = await instanceStore.getIfsAuthToken(message.baseUrl, masterKey);
          const results = await ProjectionSearch.searchProjections(message.baseUrl, token, message.term);
          return sendResponse({ ok: true, results });
        }
        case "GET_DESIGNER_STATUS":
          return sendResponse({ ok: true, open: !!designerTabState, hasFlowToken: !!flowToken.get() });
        case "GET_MODULE_STATUSES": {
          // One pass for the whole tracked list, not one round-trip per row: findExistingModule
          // alone re-GETs the package's entire asset list every call, and getDesignerData re-GETs
          // the whole flow's designer JSON every call — with N tracked rows that was N×(at least 2)
          // sequential Connect REST calls on every 5s poll, which is exactly why Create/the list felt
          // slow and inconsistent (a transient failure partway through the sequential loop flashed
          // the error banner for that one poll). Fetch both lists ONCE here, match every name
          // against them locally.
          if (!designerTabState) {
            const statuses = {};
            for (const name of message.projectionNames) statuses[name] = { status: "no_designer", assetId: null, headVersionId: null };
            return sendResponse({ ok: true, statuses });
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
          return sendResponse({ ok: true, statuses });
        }
        case "ACTIVATE_MODULE":
        case "CREATE_MODULE": // Create always activates in the open flow too
        case "RELOAD_AND_ACTIVATE":
          if (message.type !== "ACTIVATE_MODULE") {
            const created = await handleCreateModule(message);
            return sendResponse({ ok: true, result: await handleActivateModule(created) });
          }
          return sendResponse({ ok: true, result: await handleActivateModule(message) });
        default:
          return sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (e) {
      logError("Message", message.type, "failed:", e.message, e.stack);
      if (e.service === "connect" && e.status === 401) flowToken.clear();
      sendResponse({ ok: false, error: e.message, needsMasterPassword: e.code === "MASTER_PASSWORD_REQUIRED" });
    }
  })();
  return true; // keep the message channel open for the async response
});
