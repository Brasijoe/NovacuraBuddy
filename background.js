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
  "lib/flow-transfer.js",
  "lib/flow-links.js",
  "lib/flow-environments.js",
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
  "lib/flow-properties-module.js",
  "lib/github-settings.js",
  "lib/qr-service.js",
  "lib/cl-service.js",
  "lib/update-check.js",
  "lib/flow-deps.js",
  "lib/flow-documentation.js",
  "lib/doc-publish.js",
  "apimodule/api-module-service.js"
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
const LAST_FLOW_ORG_KEY = "lastFlowOrgId"; // chrome.storage.local; outlives the Designer tab being active

const LOG_PREFIX = "[IFS Projection Tracker]";
function log(...args) { console.log(LOG_PREFIX, ...args); }
function logError(...args) { console.error(LOG_PREFIX, ...args); }

const instanceStore = IfsInstances.createIfsInstanceStore({ local: chrome.storage.local, session: chrome.storage.session });
globalThis.__recorderInstanceStore = instanceStore; // RecorderCapture lists instances from the shared store
const githubSettings = GithubSettings.createGithubSettings(chrome.storage.local);
const qrHistory = QrHistory.createQrHistory(chrome.storage.local);
const docPublisher = DocPublish.createPublisher({ storage: chrome.storage.local });
const qrService = QrService.createQrService({ instanceStore, settings: githubSettings, history: qrHistory, cacheStorage: chrome.storage.local });
const clService = ClService.createClService({ instanceStore, settings: githubSettings, history: qrHistory });

// Update notice: checked when the browser starts, when the extension is installed/reloaded/updated,
// and when the side panel opens if the last attempt is older than UPDATE_CHECK_MAX_AGE_MS (most
// people never restart the browser, so a startup-only check left the banner silent for days). No
// timer. The stored result carries `currentVersion`, so it is ignored once the user has installed
// the update (no lingering banner).
const UPDATE_INFO_KEY = "updateInfo";
const FLOW_DEPS_PREFIX = "flowDeps:"; // + baseUrl, chrome.storage.local: the last dependency scan
const UPDATE_DISMISSED_KEY = "updateDismissed";
const UPDATE_CHECKED_AT_KEY = "updateCheckedAt";
const UPDATE_CHECK_MAX_AGE_MS = 6 * 60 * 60 * 1000;

async function runUpdateCheck() {
  // Every attempt counts towards the throttle, failed ones too, so an offline panel doesn't hammer GitHub.
  await chrome.storage.local.set({ [UPDATE_CHECKED_AT_KEY]: Date.now() });
  const info = await UpdateCheck.checkForUpdate(chrome.runtime.getManifest().version);
  if (info.reason) {
    // Network/HTTP failure: keep whatever we already know (e.g. an available update) instead of overwriting it.
    log("Update check:", info.reason);
    return;
  }
  await chrome.storage.local.set({ [UPDATE_INFO_KEY]: { ...info, checkedAt: Date.now() } });
}

async function runUpdateCheckIfDue() {
  const { [UPDATE_CHECKED_AT_KEY]: lastCheckedAt } = await chrome.storage.local.get(UPDATE_CHECKED_AT_KEY);
  if (UpdateCheck.isCheckDue(lastCheckedAt, Date.now(), UPDATE_CHECK_MAX_AGE_MS)) await runUpdateCheck();
}

async function readUpdateInfo() {
  const { [UPDATE_INFO_KEY]: info } = await chrome.storage.local.get(UPDATE_INFO_KEY);
  return info && info.currentVersion === chrome.runtime.getManifest().version ? info : null;
}

chrome.runtime.onStartup.addListener(() => {
  runUpdateCheck().catch((e) => logError("Update check failed:", e.message));
});
chrome.runtime.onInstalled.addListener(() => {
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
  if (!samePlace) await chrome.storage.local.set({ [LAST_FLOW_ORG_KEY]: parsed.orgId });
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

/** CL_FLOW_PROPERTIES_MODULE: one org-level FlowProperties module (outside any package) with the
 *  readable Set of each given Custom LU, generated by Flow's code generator per LU projection. */
async function flowPropertiesContext() {
  // Only the org matters (the module is not added to any flow), so this also works from the editor page.
  const { [LAST_FLOW_ORG_KEY]: orgId } = await chrome.storage.local.get(LAST_FLOW_ORG_KEY);
  if (!orgId) throw new Error("FlowProperties: open a Flow Designer tab once, so NovacuraBuddy knows your Flow organisation. Nothing was deployed.");
  return { orgId, flowFetch: boundFlowFetch() };
}

/** CL_FLOW_PROPERTIES_PREFLIGHT: before anything is deployed, prove Flow answers (real round trip)
 *  and that an existing FlowProperties module is ours to change. */
async function handleFlowPropertiesPreflight() {
  const { orgId, flowFetch } = await flowPropertiesContext();
  const moduleName = FlowPropertiesModule.MODULE_NAME;
  try {
    const asset = await FlowModules.findExistingModule({ flowFetch, orgId, packageId: null, projectionName: moduleName });
    if (asset) FlowPropertiesModule.assertOurs(await FlowModules.getModuleSource({ flowFetch, orgId, packageId: null, assetId: asset.id }));
  } catch (err) {
    if (/not made by NovacuraBuddy/.test(err.message)) throw err;
    throw Object.assign(new Error(`FlowProperties: Flow is not reachable — open the Flow Designer and sign in, then try again. Nothing was deployed. (${err.message})`), { service: err.service, status: err.status });
  }
}

async function handleFlowPropertiesModule({ baseUrl, luNames, masterPassword }) {
  const { orgId, flowFetch } = await flowPropertiesContext();
  const tab = { orgId };
  const masterKey = await instanceStore.ensureMasterKey(IfsInstances.createOneShotPrompt(masterPassword));
  const ifsToken = await instanceStore.getIfsAuthToken(baseUrl, masterKey);
  const moduleName = FlowPropertiesModule.MODULE_NAME;
  log("FLOW_PROPERTIES_MODULE start:", luNames, "org", tab.orgId);
  return FlowPropertiesModule.updateFlowPropertiesModule({
    luNames: luNames || [],
    generate: async (lu) => {
      const projection = CustomLuModel.projectionName(lu);
      const inputs = await ProjectionSearch.fetchProjectionCodegenInputs(baseUrl, ifsToken, projection);
      const code = await FlowModules.generateModuleCode({
        flowFetch, csdlXml: inputs.csdl, openApiJson: inputs.openApiJson,
        codeGenSubPath: inputs.codeGenSubPath, importSourcePath: inputs.projectionSubPath
      });
      return { code, setName: `${CustomLuModel.entityName(lu)}Set` };
    },
    readExisting: async () => {
      const asset = await FlowModules.findExistingModule({ flowFetch, orgId: tab.orgId, packageId: null, projectionName: moduleName });
      if (!asset) return null;
      return { asset, source: await FlowModules.getModuleSource({ flowFetch, orgId: tab.orgId, packageId: null, assetId: asset.id }) };
    },
    commit: async (source, existingAsset) => {
      const asset = existingAsset || await FlowModules.createModuleAsset({ flowFetch, orgId: tab.orgId, packageId: null, projectionName: moduleName });
      await FlowModules.commitModuleCode({ flowFetch, orgId: tab.orgId, packageId: null, assetId: asset.id, flowScriptCode: source });
      log("FLOW_PROPERTIES_MODULE committed, assetId=", asset.id);
      return asset;
    },
    now: () => new Date().toISOString().slice(0, 19).replace("T", " ")
  });
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

/** Import/Export tab: the target an import/copy starts on — the package of another open Designer tab
 *  (most recently used first; the user's own login and package, nothing to ask), else the active
 *  Designer tab's own. */
async function handleFlowDefaultTarget({ excludeItemId }) {
  const flowFetch = boundFlowFetch();
  const tabs = await chrome.tabs.query({ url: "https://build.novacura.com/admin/design/designer/*" });
  const candidates = tabs
    .map((t) => ({ tab: t, parsed: FlowDesignerTab.parseDesignerTabUrl(t.url) }))
    .filter((c) => c.parsed)
    .sort((a, b) => (b.tab.lastAccessed || 0) - (a.tab.lastAccessed || 0));
  const other = candidates.find((c) => c.parsed.itemId !== excludeItemId);
  const pick = other || candidates[0];
  if (!pick) {
    const { [LAST_FLOW_ORG_KEY]: orgId } = await chrome.storage.local.get(LAST_FLOW_ORG_KEY);
    return orgId ? { orgId, packageId: null, fromOtherTab: false, tabTitle: "" } : null;
  }
  const packageId = await FlowDesignerTab.resolvePackageId({ flowFetch, orgId: pick.parsed.orgId, itemId: pick.parsed.itemId });
  return { orgId: pick.parsed.orgId, packageId, fromOtherTab: !!other, tabTitle: pick.tab.title || "" };
}

/** After an import that changed the flow open in the active Designer tab, reload it there. */
async function refreshIfOpen(orgId, itemIds) {
  if (designerTabState && designerTabState.orgId === orgId && itemIds.includes(designerTabState.itemId)) {
    await refreshDesignerTab({ ...designerTabState });
  }
}

/** Packages, assets and automations of the open Flow organisation, for matching IFS callers to
 *  flows and grouping per package (read-only). */
async function buildFlowIndex(orgId) {
  if (!orgId || !flowToken.get()) throw new Error("Open a flow in the Flow Designer tab first: grouping per package reads the packages from Flow.");
  const scan = await linkScan(orgId);
  // keys: the short values an asset carries (ids, keys, branch ids) — one of them may be the
  // flow key at the end of a run.novacura.com URL.
  const shortValues = (o) => Object.values(o || {}).filter((v) => typeof v === "string" && v.length <= 64);
  const assets = scan.assets.map(({ id, name, type, packageId, packageName, mainBranch }) =>
    ({ id, name, type, packageId, packageName, keys: [...shortValues(mainBranch)] }));
  // Automations, apps and pages are products, listed per package (GET only). The key at the end
  // of a run.novacura.com URL is matched against them first; one failing package is skipped.
  const flowFetch = boundFlowFetch();
  const products = [];
  for (const pkg of scan.packages) {
    try {
      const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/packages/${pkg.id}/products`);
      if (!res.ok) continue;
      for (const p of (await res.json()) || []) {
        const ext = (p.extensionProperties || []).map((e) => e && e.value);
        products.push({ id: p.id, name: p.name, type: p.type, packageId: pkg.id, packageName: pkg.name,
          // The flow it runs: the asset it uses directly (live list call, 2026-10-23: no assetDto there).
          assetId: p.assetDto ? p.assetDto.assetId : ((((p.mainBranch || {}).versionInfo || {}).assets || []).find((u) => !u.usedIndirectly) || {}).assetId || null, keys: [...shortValues(p.mainBranch), ...ext.filter((v) => typeof v === "string" && v.length <= 64)] });
      }
    } catch (e) {
      log("FD_FLOW_INDEX: products of", pkg.name, "failed:", e.message);
    }
  }
  return { orgId, packages: scan.packages.map(({ id, name }) => ({ id, name })), assets, products };
}

/** Deletes published documentation gists past their expiry. Needs the unlocked master key (the GitHub
 *  token is stored encrypted), so with locked credentials it waits for the next run. */
async function sweepPublishedDocs() {
  if (!(await docPublisher.list()).some((e) => Date.parse(e.expiresAt) <= Date.now())) return;
  let token;
  try { token = await githubSettings.getToken(await instanceStore.ensureMasterKey(IfsInstances.createOneShotPrompt(null))); } catch { return; }
  const { removed, failed } = await docPublisher.sweep({ token });
  if (removed) log("Flow documentation: removed", removed, "expired published copy/copies");
  for (const f of failed) logError("Flow documentation: could not remove expired copy:", f);
}
chrome.alarms.create("sweepPublishedDocs", { periodInMinutes: 15 });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "sweepPublishedDocs") sweepPublishedDocs().catch(() => {}); });
sweepPublishedDocs().catch(() => {});

/** Linked Flows tab: one scan of an organisation's assets (with link tags) is kept for a minute,
 *  so the open-flow strip, the Link flows list and the overview share it. Writes drop it. */
const linkScans = new Map(); // orgId -> { at, promise }
function linkScan(orgId, force) {
  const hit = linkScans.get(orgId);
  if (!force && hit && Date.now() - hit.at < 60000) return hit.promise;
  const promise = FlowLinks.scan({ flowFetch: boundFlowFetch(), orgId });
  linkScans.set(orgId, { at: Date.now(), promise });
  promise.catch(() => linkScans.delete(orgId));
  return promise;
}
const linkScanDone = (orgId) => linkScans.delete(orgId);

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
      const { masterPassword, fields, token, report, code, ...safeMessage } = message;
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
        case "CL_FLOW_PROPERTIES_PREFLIGHT":
          await handleFlowPropertiesPreflight();
          return sendResponse({ ok: true });
        case "CL_FLOW_PROPERTIES_MODULE":
          return sendResponse({ ok: true, ...(await handleFlowPropertiesModule(message)) });
        case "CL_DEPLOY": {
          // Live step updates for the page that asked; nobody listening is fine.
          const onProgress = (progress) => chrome.runtime.sendMessage({ type: "CL_DEPLOY_PROGRESS", deployId: message.deployId, ...progress }).catch(() => {});
          return sendResponse({ ok: true, results: await clService.deploy(await masterKey(), message, onProgress) });
        }
        case "API_FETCH_SPEC":
          return sendResponse({ ok: true, result: await ApiModuleService.fetchSpec({ url: message.url, instanceStore, getMasterKey: masterKey }) });
        case "API_CREATE_MODULE": { // like CREATE_MODULE: save, then activate in the open flow
          const tab = captureDesignerTab();
          const packageId = await resolvePackageIdFor(tab);
          log("API_CREATE_MODULE start:", message.moduleName, "(", (message.code || "").length, "bytes )");
          const saved = await ApiModuleService.saveModule({ flowFetch: boundFlowFetch(), orgId: tab.orgId, packageId, moduleName: message.moduleName, code: message.code, log });
          return sendResponse({ ok: true, result: await handleActivateModule(saved) });
        }
        case "FT_EXPORT": {
          const generator = `NovacuraBuddy ${chrome.runtime.getManifest().version}`;
          if (message.orgId) { // ticked in the environment tree: no Designer tab needed
            log("FT_EXPORT start: org", message.orgId, "packages", message.packageIds, "assets", message.assetIds);
            const pkg = await FlowTransfer.exportSelection({
              flowFetch: boundFlowFetch(), orgId: message.orgId, packageIds: message.packageIds, assetIds: message.assetIds, generator, log
            });
            return sendResponse({ ok: true, pkg });
          }
          const tab = captureDesignerTab();
          const packageId = await resolvePackageIdFor(tab);
          log("FT_EXPORT start: flow", tab.itemId, "package", packageId);
          const pkg = await FlowTransfer.exportFlow({ flowFetch: boundFlowFetch(), orgId: tab.orgId, packageId, itemId: tab.itemId, generator, log });
          return sendResponse({ ok: true, pkg });
        }
        case "FT_LIST_ASSETS":
          return sendResponse({ ok: true, assets: await FlowTransfer.listPackageAssets({ flowFetch: boundFlowFetch(), orgId: message.orgId, packageId: message.packageId || null }) });
        case "FT_ASSET_REFS":
          return sendResponse({ ok: true, assets: await FlowTransfer.listAssetRefs({ flowFetch: boundFlowFetch(), orgId: message.orgId, itemId: message.itemId }) });
        case "FT_REF_COUNTS":
          return sendResponse({ ok: true, counts: await FlowTransfer.countAssetRefs({ flowFetch: boundFlowFetch(), orgId: message.orgId, itemIds: message.itemIds }) });
        case "FT_ORGS":
          return sendResponse({ ok: true, orgs: await FlowTransfer.listOrganisations({ flowFetch: boundFlowFetch() }) });
        case "FT_PACKAGES":
          return sendResponse({ ok: true, packages: await FlowTransfer.listPackages({ flowFetch: boundFlowFetch(), orgId: message.orgId }) });
        case "FT_DEFAULT_TARGET":
          return sendResponse({ ok: true, target: await handleFlowDefaultTarget(message) });
        case "FT_PLAN":
          return sendResponse({ ok: true, plan: await FlowTransfer.planImport({ flowFetch: boundFlowFetch(), pkg: message.pkg, orgId: message.orgId, packageId: message.packageId || null, layout: message.layout }) });
        case "FT_IMPORT": {
          log("FT_IMPORT start: into org", message.orgId, "package", message.packageId || "(App Library)");
          const flowFetch = boundFlowFetch();
          let generateCode = null;
          if (message.baseUrl) { // "Generate from IFS": the same code generation as Create module
            const masterKey = await instanceStore.ensureMasterKey(IfsInstances.createOneShotPrompt(message.masterPassword));
            const ifsToken = await instanceStore.getIfsAuthToken(message.baseUrl, masterKey);
            generateCode = async (projectionName) => {
              log("FT_IMPORT: generating", projectionName, "from", message.baseUrl);
              const inputs = await ProjectionSearch.fetchProjectionCodegenInputs(message.baseUrl, ifsToken, projectionName);
              return FlowModules.generateModuleCode({
                flowFetch, csdlXml: inputs.csdl, openApiJson: inputs.openApiJson,
                codeGenSubPath: inputs.codeGenSubPath, importSourcePath: inputs.projectionSubPath
              });
            };
          }
          const outcome = await FlowTransfer.runImport({
            flowFetch, pkg: message.pkg, orgId: message.orgId, packageId: message.packageId || null, layout: message.layout,
            choices: message.choices, connectorMap: message.connectorMap, names: message.names, generateCode, log
          });
          await refreshIfOpen(message.orgId, outcome.results.filter((r) => r.choice === "update").map((r) => r.targetId));
          return sendResponse({ ok: true, outcome });
        }
        case "LF_CONTEXT": { // the open flow and the organisation the tab starts on
          const { [LAST_FLOW_ORG_KEY]: lastOrgId } = await chrome.storage.local.get(LAST_FLOW_ORG_KEY);
          return sendResponse({ ok: true, orgId: designerTabState ? designerTabState.orgId : lastOrgId || null, itemId: designerTabState ? designerTabState.itemId : null, hasFlowToken: !!flowToken.get() });
        }
        case "LF_SCAN": {
          const result = await linkScan(message.orgId, message.force);
          const assets = result.assets.map(({ id, name, type, packageId, packageName, tag }) => ({ id, name, type, packageId, packageName, tag }));
          return sendResponse({ ok: true, scan: { orgId: result.orgId, packages: result.packages, assets, scannedAt: result.scannedAt } });
        }
        case "LF_STATUSES":
          return sendResponse({ ok: true, statuses: await FlowLinks.statuses({ flowFetch: boundFlowFetch(), orgId: message.orgId, scanResult: await linkScan(message.orgId), linkIds: message.linkIds }) });
        case "LF_PLAN_LINK":
          return sendResponse({ ok: true, plan: await FlowLinks.planLink({ flowFetch: boundFlowFetch(), orgId: message.orgId, sourceId: message.sourceId, adoptIds: message.adoptIds, newPackageIds: message.newPackageIds, scanResult: await linkScan(message.orgId, message.force) }) });
        case "LF_LINK": {
          log("LF_LINK start:", message.sourceId, "adopt", message.adoptIds, "new in", message.newPackageIds);
          try {
            const outcome = await FlowLinks.runLink({ flowFetch: boundFlowFetch(), orgId: message.orgId, sourceId: message.sourceId, adoptIds: message.adoptIds, newPackageIds: message.newPackageIds, log });
            return sendResponse({ ok: true, outcome });
          } finally { linkScanDone(message.orgId); }
        }
        case "LF_PLAN_PUSH":
          return sendResponse({ ok: true, plan: await FlowLinks.planPush({ flowFetch: boundFlowFetch(), orgId: message.orgId, sourceId: message.sourceId, targetIds: message.targetIds, scanResult: await linkScan(message.orgId, true) }) });
        case "LF_LATEST": {
          const latest = await FlowLinks.latestOf({ flowFetch: boundFlowFetch(), orgId: message.orgId, scanResult: await linkScan(message.orgId, true), linkId: message.linkId, exceptId: message.exceptId });
          return sendResponse({ ok: true, latest: latest ? { id: latest.id, name: latest.name, packageName: latest.packageName } : null });
        }
        case "LF_PUSH": {
          log("LF_PUSH start:", message.sourceId, "->", message.targets.map((t) => t.id));
          try {
            const outcome = await FlowLinks.runPush({ flowFetch: boundFlowFetch(), orgId: message.orgId, sourceId: message.sourceId, targets: message.targets, expectedMaxRev: message.expectedMaxRev, expectedSourceFp: message.expectedSourceFp, expectedSourceETag: message.expectedSourceETag, log });
            await refreshIfOpen(message.orgId, outcome.results.filter((r) => r.outcome === "pushed").map((r) => r.id));
            return sendResponse({ ok: true, outcome });
          } finally { linkScanDone(message.orgId); }
        }
        case "LF_ENVIRONMENTS": { // the org's environments, and where the given flows are deployed
          const flowFetch = boundFlowFetch();
          const environments = await FlowEnvironments.listEnvironments({ flowFetch, orgId: message.orgId });
          const deployed = {};
          for (const f of message.flows || []) deployed[f.id] = await FlowEnvironments.deployedIn({ flowFetch, orgId: message.orgId, packageId: f.packageId, assetId: f.id, environments }).catch(() => []);
          return sendResponse({ ok: true, environments, deployed });
        }
        case "LF_DEPLOY": { // the just committed head versions, read fresh after the push
          const flowFetch = boundFlowFetch();
          linkScanDone(message.orgId);
          const index = new Map((await linkScan(message.orgId, true)).assets.map((a) => [a.id, a]));
          const flows = message.assetIds.map((id) => index.get(id)).filter(Boolean).map((a) => ({ id: a.id, type: a.type, packageId: a.packageId, headVersionId: a.mainBranch && a.mainBranch.headVersionId }));
          log("LF_DEPLOY:", message.envId, flows.map((f) => f.id));
          return sendResponse({ ok: true, results: await FlowEnvironments.deploy({ flowFetch, orgId: message.orgId, envId: message.envId, flows }) });
        }
        case "LF_UNLINK":
          try {
            await FlowLinks.unlink({ flowFetch: boundFlowFetch(), orgId: message.orgId, assetId: message.assetId });
            return sendResponse({ ok: true });
          } finally { linkScanDone(message.orgId); }
        case "LF_UNDO":
          try {
            await FlowLinks.undoPush({ flowFetch: boundFlowFetch(), orgId: message.orgId, assetId: message.assetId, undo: message.undo });
            await refreshIfOpen(message.orgId, [message.assetId]);
            return sendResponse({ ok: true });
          } finally { linkScanDone(message.orgId); }
        case "FD_SCAN": { // Flow dependency scanner: read-only, the scan only gets GET methods
          const client = IfsClient.forInstance({ instanceStore, baseUrl: message.baseUrl, masterKey: await masterKey() });
          const ifs = { get: client.get, getText: client.getText };
          const onProgress = (step, current, total) =>
            chrome.runtime.sendMessage({ type: "FD_SCAN_PROGRESS", scanId: message.scanId, step, current, total }).catch(() => {});
          const result = { baseUrl: IfsInstances.normalizeBaseUrl(message.baseUrl), ...(await FlowDeps.runScan({ ifs, patterns: message.patterns, onProgress })) };
          await chrome.storage.local.set({ [FLOW_DEPS_PREFIX + result.baseUrl]: result });
          return sendResponse({ ok: true, result });
        }
        case "FD_FLOW_INDEX": {
          const { [LAST_FLOW_ORG_KEY]: lastOrgId } = await chrome.storage.local.get(LAST_FLOW_ORG_KEY);
          return sendResponse({ ok: true, index: await buildFlowIndex(designerTabState ? designerTabState.orgId : lastOrgId) });
        }
        case "FDOC_GENERATE": { // documentation of the open flow: read-only Flow calls, IFS only when asked for
          const tab = captureDesignerTab();
          const packageId = await resolvePackageIdFor(tab);
          const flowFetch = boundFlowFetch();
          const progress = (step, current, total) => chrome.runtime.sendMessage({ type: "FDOC_PROGRESS", step, current, total }).catch(() => {});
          progress("Reading the flow and everything it uses");
          const pkg = await FlowTransfer.exportFlow({ flowFetch, orgId: tab.orgId, packageId, itemId: tab.itemId, generator: `NovacuraBuddy ${chrome.runtime.getManifest().version}`, log });
          progress("Finding where it is used");
          const scan = await linkScan(tab.orgId);
          // A flow can only use its own package's assets and the App Library, so a packaged asset is
          // looked for in its package and the library; a global one (no package) in every package.
          const { refs, failed } = await FlowDocumentation.readReferences({ flowFetch, orgId: tab.orgId, assets: scan.assets.filter((a) => !packageId || a.packageId === packageId || a.packageId === null), onProgress: (c, t) => progress("Reading flows to find where it is used", c, t) });
          const usedBy = FlowDocumentation.computeUsedBy(scan.assets, refs);
          const packageNames = new Map(scan.assets.map((a) => [a.id, a.packageName]));
          for (const a of Object.values(pkg.assets)) a.packageName = packageNames.get(a.id) || null;
          let ifs = null;
          if (message.baseUrl) {
            progress("Scanning IFS for callers");
            const client = IfsClient.forInstance({ instanceStore, baseUrl: message.baseUrl, masterKey: await masterKey() });
            const result = await FlowDeps.runScan({ ifs: { get: client.get, getText: client.getText }, onProgress: (step, c, t) => progress(`IFS scan: ${step}`, c, t) });
            const instance = (await instanceStore.listInstances()).find((i) => IfsInstances.normalizeBaseUrl(i.baseUrl) === IfsInstances.normalizeBaseUrl(message.baseUrl));
            ifs = { instanceName: instance ? instance.name : message.baseUrl, scannedAt: result.scannedAt, chains: FlowDocumentation.ifsChainsFor(result.chains, await buildFlowIndex(tab.orgId), Object.keys(pkg.assets)) };
          }
          const orgs = await FlowTransfer.listOrganisations({ flowFetch }).catch(() => []);
          const orgName = (orgs.find((o) => o.id === tab.orgId) || {}).name || null;
          const files = FlowDocumentation.buildDocs({ pkg, rootId: tab.itemId, usedBy, ifs, notes: message.notes, orgName, design: message.design !== false });
          const rootName = pkg.assets[tab.itemId].name;
          return sendResponse({ ok: true, name: rootName, files, stats: { assets: Object.keys(pkg.assets).length, usedBy: (usedBy[tab.itemId] || []).length, ifsChains: ifs ? (ifs.chains[tab.itemId] || []).length : null, unreadFlows: failed } });
        }
        case "FDOC_PUBLISH": { // the only outward step: a secret gist that is deleted again after `hours`
          const token = await githubSettings.getToken(await masterKey());
          return sendResponse({ ok: true, entry: await docPublisher.publish({ token, name: message.name, files: message.files, hours: message.hours }) });
        }
        case "FDOC_LIST": {
          sweepPublishedDocs().catch(() => {});
          return sendResponse({ ok: true, entries: await docPublisher.list() });
        }
        case "FDOC_DELETE": { // removes a gist this extension published (its own, on request)
          const token = await githubSettings.getToken(await masterKey());
          await docPublisher.remove({ token, gistId: message.gistId });
          return sendResponse({ ok: true });
        }
        case "FD_LAST_RESULT": {
          const key = FLOW_DEPS_PREFIX + IfsInstances.normalizeBaseUrl(message.baseUrl);
          const { [key]: result = null } = await chrome.storage.local.get(key);
          return sendResponse({ ok: true, result });
        }
        case "GET_UPDATE_INFO": {
          // Fire and forget: a fresh result lands in storage and the panel's onChanged listener re-renders the banner.
          runUpdateCheckIfDue().catch((e) => logError("Update check failed:", e.message));
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
