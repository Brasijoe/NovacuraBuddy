importScripts(
  "lib/credential-crypto.js",
  "lib/projection-filter.js",
  "lib/ifs-instances.js",
  "lib/recorder-capture.js",
  "lib/projection-search.js",
  "lib/flow-connect-rest.js",
  "lib/tracking.js",
  "lib/flow-designer-tab.js",
  "lib/flow-modules.js",
  "lib/flow-token.js",
  "lib/ifs-client.js",
  "lib/ifs-permissions.js",
  "lib/qr-deploy.js",
  "lib/qr-history.js",
  "lib/gh-library.js",
  "lib/qr-library.js",
  "lib/cl-library.js",
  "lib/custom-lu-model.js",
  "lib/custom-lu-deploy.js",
  "lib/github-settings.js",
  "lib/qr-service.js",
  "lib/cl-service.js",
  "lib/update-check.js"
);

// Without this, the toolbar icon has no default_popup and MV3 does nothing on click — the panel
// only opens via Chrome's own side-panel menu, which most users won't find unprompted.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const TRACKING_ENABLED_KEY = "trackingEnabled";
const TRACKED_PROJECTIONS_PREFIX = "tracked:"; // + baseUrl, chrome.storage.session
const UNMATCHED_HOSTS_KEY = "unmatchedHosts";
const DISMISSED_HOSTS_KEY = "dismissedUnmatchedHosts"; // hosts the user dismissed this browser session; never re-raised
const FLOW_TOKEN_PERSIST_KEY = "flowTokenPersist"; // { token, expiresAt }, chrome.storage.session
const DESIGNER_TAB_PERSIST_KEY = "designerTabPersist"; // { tabId, orgId, itemId, packageId, packageResolved }

const LOG_PREFIX = "[IFS Projection Tracker]";
function log(...args) { console.log(LOG_PREFIX, ...args); }
function logError(...args) { console.error(LOG_PREFIX, ...args); }

const instanceStore = IfsInstances.createIfsInstanceStore({ local: chrome.storage.local, session: chrome.storage.session });
globalThis.__recorderInstanceStore = instanceStore; // RecorderCapture lists instances from the shared store
const githubSettings = GithubSettings.createGithubSettings(chrome.storage.local);
const qrHistory = QrHistory.createQrHistory(chrome.storage.local);
const qrService = QrService.createQrService({ instanceStore, settings: githubSettings, history: qrHistory, cacheStorage: chrome.storage.local });
const clService = ClService.createClService({ instanceStore, settings: githubSettings, history: qrHistory });

// Update notice: checked only when the browser starts (user decision) — no timer, no check on
// panel open. The stored result carries `currentVersion`, so it is ignored once the user has
// installed the update (no lingering banner).
const UPDATE_INFO_KEY = "updateInfo";
const UPDATE_DISMISSED_KEY = "updateDismissed";

async function runUpdateCheck() {
  const info = await UpdateCheck.checkForUpdate(chrome.runtime.getManifest().version);
  if (info.reason) {
    // Network/HTTP failure: keep whatever we already know (e.g. an available update) instead of overwriting it.
    log("Update check:", info.reason);
    return;
  }
  await chrome.storage.local.set({ [UPDATE_INFO_KEY]: { ...info, checkedAt: Date.now() } });
}

async function readUpdateInfo() {
  const { [UPDATE_INFO_KEY]: info } = await chrome.storage.local.get(UPDATE_INFO_KEY);
  return info && info.currentVersion === chrome.runtime.getManifest().version ? info : null;
}

chrome.runtime.onStartup.addListener(() => {
  runUpdateCheck().catch((e) => logError("Update check failed:", e.message));
});
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
    await RecorderCapture.init().catch((e) => logError("Recorder init failed:", e));
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

async function recordUnmatchedHost(hostname) {
  const { [DISMISSED_HOSTS_KEY]: dismissed = [], [UNMATCHED_HOSTS_KEY]: hosts = [] } = await chrome.storage.session.get([DISMISSED_HOSTS_KEY, UNMATCHED_HOSTS_KEY]);
  if (dismissed.includes(hostname) || hosts.includes(hostname)) return;
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
      const instance = IfsInstances.findInstanceForHost(instances, hostname);
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

function requireProjectionName(projectionName, action) {
  if (typeof projectionName !== "string" || !projectionName.trim()) {
    throw new Error(`${action}: no projection/module name was given — nothing was changed.`);
  }
}

async function handleCreateModule({ baseUrl, projectionName, masterPassword }) {
  requireProjectionName(projectionName, "Create module");
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
  // IFS's own spelling of the name (callers may pass any case, e.g. QuickReport<id> from Quick Reports).
  const asset = await FlowModules.findOrCreateModule({ flowFetch, orgId: tab.orgId, packageId, projectionName: inputs.projectionName });
  log("Module asset id =", asset.id, "— committing module code...");
  const newBranch = await FlowModules.commitModuleCode({ flowFetch, orgId: tab.orgId, packageId, assetId: asset.id, flowScriptCode: code });
  log("CREATE_MODULE done: assetId=", asset.id, "headVersionId=", newBranch.headVersionId);
  return { assetId: asset.id, headVersionId: newBranch.headVersionId, projectionName: asset.name || inputs.projectionName };
}

async function handleActivateModule({ assetId, headVersionId, projectionName }) {
  requireProjectionName(projectionName, "Activate module"); // it becomes the module-added event's name
  log("ACTIVATE_MODULE start: assetId=", assetId, "headVersionId=", headVersionId);
  const tab = captureDesignerTab();
  await FlowDesignerTab.activateModule({ flowFetch: boundFlowFetch(), orgId: tab.orgId, itemId: tab.itemId, assetId, headVersionId, moduleName: projectionName });
  log("ACTIVATE_MODULE done — refreshing the Designer so the module shows up...");
  return refreshDesignerTab(tab);
}

async function handleDeactivateModule({ assetId }) {
  log("DEACTIVATE_MODULE start: assetId=", assetId);
  const tab = captureDesignerTab();
  await FlowDesignerTab.deactivateModule({ flowFetch: boundFlowFetch(), orgId: tab.orgId, itemId: tab.itemId, assetId });
  log("DEACTIVATE_MODULE done — refreshing the Designer so the module disappears...");
  return refreshDesignerTab(tab);
}

/** After any module save: let the Designer reload itself so it shows the change (and holds the
 *  new etag for its own next save). */
async function refreshDesignerTab(tab) {
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
      if (RecorderCapture.isRecorderMessage(message.type)) {
        // The recorder answers these itself; this router must not answer them too (the old
        // default branch replied "Unknown message type", racing the recorder's real reply).
        // The listener already returns true, so the async reply is allowed.
        RecorderCapture.handleMessage(message, (response) => {
          if (message.type === "STOP_RECORDING" && response && response.unmatchedHosts) {
            response.unmatchedHosts.forEach((host) => enqueueTrackingWrite(() => recordUnmatchedHost(host)));
          }
          sendResponse(response);
        });
        return;
      }
      const { masterPassword, fields, token, report, ...safeMessage } = message;
      log("Message:", message.type, fields ? { ...safeMessage, fields: { ...fields, secretPayload: "[redacted]" } } : safeMessage, report ? { report: report.id } : "");
      const masterKey = () => instanceStore.ensureMasterKey(IfsInstances.createOneShotPrompt(message.masterPassword));
      switch (message.type) {
        // The Traffic Explorer's token comes from IFS Buddy's own capture (recorder-capture.js),
        // unchanged; the Tracker keeps using its webRequest-sniffed flowToken.
        case "GET_FLOW_TOKEN":
          return sendResponse({ ok: true, token: await RecorderCapture.captureFlowAuthToken() });
        case "CLEAR_FLOW_TOKEN":
          await chrome.storage.session.remove("flowAuthToken");
          return sendResponse({ ok: true });
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
          const savedKey = await instanceStore.saveInstance(message.baseUrl, message.fields, await instanceStore.ensureMasterKey(IfsInstances.createOneShotPrompt(message.masterPassword)));
          // The instance now exists, so its "not set up yet" notice is obsolete.
          const savedHost = new URL(savedKey || message.baseUrl).hostname;
          await enqueueTrackingWrite(async () => {
            const { [UNMATCHED_HOSTS_KEY]: pending = [] } = await chrome.storage.session.get(UNMATCHED_HOSTS_KEY);
            await chrome.storage.session.set({ [UNMATCHED_HOSTS_KEY]: pending.filter((h) => h !== savedHost) });
          });
          return sendResponse({ ok: true });
        }
        case "TEST_INSTANCE": {
          const masterKey = await instanceStore.ensureMasterKey(IfsInstances.createOneShotPrompt(message.masterPassword));
          instanceStore.clearIfsAuthToken(message.baseUrl); // always a real round-trip, never the cache
          await instanceStore.getIfsAuthToken(message.baseUrl, masterKey);
          return sendResponse({ ok: true });
        }
        case "RENAME_INSTANCE":
          await instanceStore.renameInstance(message.baseUrl, message.name);
          return sendResponse({ ok: true });
        case "DELETE_INSTANCE":
          await instanceStore.deleteInstance(message.baseUrl);
          return sendResponse({ ok: true });
        case "DISMISS_UNMATCHED_HOST": {
          // Remember the dismissal too, or the Tracker listener would re-add the host on its next IFS call.
          await enqueueTrackingWrite(async () => {
            const { [UNMATCHED_HOSTS_KEY]: hosts = [], [DISMISSED_HOSTS_KEY]: dismissed = [] } = await chrome.storage.session.get([UNMATCHED_HOSTS_KEY, DISMISSED_HOSTS_KEY]);
            await chrome.storage.session.set({
              [UNMATCHED_HOSTS_KEY]: hosts.filter((h) => h !== message.host),
              [DISMISSED_HOSTS_KEY]: dismissed.includes(message.host) ? dismissed : [...dismissed, message.host],
            });
          });
          return sendResponse({ ok: true });
        }
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
            return sendResponse({ ok: true, statuses, packageModules: [] });
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
          // Every module in the open flow's package, from the same two lists — the tracker's
          // second section.
          const packageModules = assets
            .filter((a) => a.type === "module")
            .map((a) => ({ name: a.name, status: FlowDesignerTab.computeModuleStatus(a, designerData.assets), assetId: a.id, headVersionId: a.mainBranch.headVersionId }))
            .sort((a, b) => a.name.localeCompare(b.name));
          log("Computed status for", message.projectionNames.length, "projection(s) and", packageModules.length, "package module(s) in one pass");
          return sendResponse({ ok: true, statuses, packageModules });
        }
        case "DEACTIVATE_MODULE":
          return sendResponse({ ok: true, result: await handleDeactivateModule(message) });
        case "CREATE_MODULE": { // Create always activates in the open flow too
          const created = await handleCreateModule(message);
          return sendResponse({ ok: true, result: await handleActivateModule(created) });
        }
        case "ACTIVATE_MODULE":
          return sendResponse({ ok: true, result: await handleActivateModule(message) });
        case "QR_GET_SETTINGS":
          return sendResponse({ ok: true, ...(await qrService.getGithubSettings()) });
        case "QR_SAVE_SETTINGS":
          return sendResponse({ ok: true, ...(await qrService.saveGithubSettings({ token: message.token, repo: message.repo }, await masterKey())) });
        case "QR_LIST":
          return sendResponse({ ok: true, ...(await qrService.listReports(await masterKey())) });
        case "QR_LIST_CACHED":
          return sendResponse({ ok: true, cache: await qrService.getCachedReports() });
        case "QR_SAVE":
          return sendResponse({ ok: true, report: await qrService.saveReport(await masterKey(), message.report) });
        case "QR_MOVE_UNOWNED":
          return sendResponse({ ok: true, ...(await qrService.moveUnowned(await masterKey())) });
        case "PERMISSION_SETS":
          return sendResponse({ ok: true, ...(await qrService.listPermissionSets(message.baseUrl, await masterKey())) });
        case "QR_DEPLOY":
          return sendResponse({ ok: true, outcome: await qrService.deploy(await masterKey(), message) });
        case "QR_HISTORY":
          return sendResponse({
            ok: true,
            deployments: message.qrId ? await qrService.historyForReport(message.qrId)
              : message.baseUrl ? await qrService.historyForInstance(message.baseUrl)
              : await qrService.historyAll()
          });
        case "CL_LIBRARY":
          return sendResponse({ ok: true, lus: await clService.listLibrary(await masterKey()) });
        case "CL_CREATE":
          return sendResponse({ ok: true, lu: await clService.createInLibrary(await masterKey(), message.lu) });
        case "CL_ENV_LIST":
          return sendResponse({ ok: true, lus: await clService.listEnvironment(message.baseUrl, await masterKey()) });
        case "CL_ENV_GET":
          return sendResponse({ ok: true, lu: await clService.getEnvironmentLu(message.baseUrl, await masterKey(), message.name) });
        case "CL_DEPLOY":
          return sendResponse({ ok: true, results: await clService.deploy(await masterKey(), message) });
        case "GET_UPDATE_INFO": {
          const info = await readUpdateInfo();
          const { [UPDATE_DISMISSED_KEY]: dismissedVersion } = await chrome.storage.local.get(UPDATE_DISMISSED_KEY);
          return sendResponse({ ok: true, info, dismissed: !!info && !!info.available && info.version === dismissedVersion });
        }
        case "DISMISS_UPDATE":
          await chrome.storage.local.set({ [UPDATE_DISMISSED_KEY]: message.version });
          return sendResponse({ ok: true });
        default:
          return sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (e) {
      logError("Message", message.type, "failed:", e.message, e.stack);
      if (e.service === "connect" && e.status === 401) flowToken.clear();
      sendResponse({ ok: false, error: e.message, code: e.code, needsMasterPassword: e.code === "MASTER_PASSWORD_REQUIRED" });
    }
  })();
  return true; // keep the message channel open for the async response
});
