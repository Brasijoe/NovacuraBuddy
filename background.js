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

const TRACKING_ENABLED_KEY = "trackingEnabled";
const TRACKED_PROJECTIONS_PREFIX = "tracked:"; // + baseUrl, chrome.storage.session
const UNMATCHED_HOSTS_KEY = "unmatchedHosts";
const FLOW_TOKEN_PERSIST_KEY = "flowTokenPersist"; // { token, expiresAt }, chrome.storage.session
const DESIGNER_TAB_PERSIST_KEY = "designerTabPersist"; // { tabId, orgId, itemId, packageId }

const instanceStore = IfsInstances.createIfsInstanceStore({ local: chrome.storage.local, session: chrome.storage.session });
const flowToken = FlowToken.createTokenCache(45 * 60 * 1000);
let excludedSet = ProjectionFilter.parseExcludedList(""); // populated once `ready` resolves
let designerTabState = null; // { tabId, orgId, itemId, packageId }

// MV3 kills this service worker after ~30s idle, wiping every top-level `let` above. Both the
// sniffed Connect token and the resolved Designer-tab state are persisted to chrome.storage.session
// (survives worker restarts, not browser restarts) so a restart doesn't make a still-open, still-
// authenticated Designer tab look absent (spec §7a's documented 45-minute window only holds if the
// worker actually lives that long, which it usually doesn't).
async function restorePersistedState() {
  const { [FLOW_TOKEN_PERSIST_KEY]: tokenState } = await chrome.storage.session.get(FLOW_TOKEN_PERSIST_KEY);
  if (tokenState && tokenState.expiresAt > Date.now()) {
    flowToken.set(tokenState.token); // restarts the 45-minute window from now — an approximation, not exact TTL continuity
  }
  const { [DESIGNER_TAB_PERSIST_KEY]: tabState } = await chrome.storage.session.get(DESIGNER_TAB_PERSIST_KEY);
  if (tabState) designerTabState = tabState;
}

async function persistFlowToken(token) {
  await chrome.storage.session.set({ [FLOW_TOKEN_PERSIST_KEY]: { token, expiresAt: Date.now() + 45 * 60 * 1000 } });
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
      await chrome.storage.session.set({ [key]: next });
    });
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const token = FlowToken.extractBearerToken(details.requestHeaders);
    if (token) {
      flowToken.set(token);
      persistFlowToken(token);
    }
    return {};
  },
  { urls: ["https://build.novacura.com/*"] },
  ["requestHeaders", "extraHeaders"]
);

async function refreshDesignerTabState() {
  const tabs = await chrome.tabs.query({ url: "https://build.novacura.com/admin/design/designer/*" });
  if (!tabs.length) {
    designerTabState = null;
    await persistDesignerTabState();
    return;
  }
  const parsed = FlowDesignerTab.parseDesignerTabUrl(tabs[0].url);
  if (!parsed) {
    designerTabState = null;
    await persistDesignerTabState();
    return;
  }
  // Keep the already-resolved packageId when it's still the same org+item — this cache is spec
  // §7's whole point ("a one-time cost per Designer tab, not per action"); re-deriving it on every
  // tabs.onUpdated (which fires on *any* tab, constantly, while just browsing Aurena) would defeat
  // it and cost 1+2×packageCount REST calls each time for no reason.
  const samePlace = designerTabState && designerTabState.orgId === parsed.orgId && designerTabState.itemId === parsed.itemId;
  designerTabState = {
    tabId: tabs[0].id,
    orgId: parsed.orgId,
    itemId: parsed.itemId,
    packageId: samePlace ? designerTabState.packageId : null
  };
  await persistDesignerTabState();
}

chrome.tabs.onUpdated.addListener(() => refreshDesignerTabState());
chrome.tabs.onRemoved.addListener(() => refreshDesignerTabState());

function boundFlowFetch() {
  const token = flowToken.get();
  if (!token) throw new Error("No Novacura Flow session found yet — open or interact with the Designer tab first.");
  return (path, options) => FlowConnectRest.flowFetch(token, path, options);
}

// Resolves packageId against a specific, already-captured tab snapshot — never the live mutable
// `designerTabState` — so a navigation mid-await can't turn a later property read into a raw
// TypeError. Still updates the live state's cache opportunistically when it's still the same tab.
async function resolvePackageIdFor(tab) {
  if (tab.packageId) return tab.packageId;
  const packageId = await FlowDesignerTab.resolvePackageId({ flowFetch: boundFlowFetch(), orgId: tab.orgId, itemId: tab.itemId });
  if (!packageId) throw new Error("Could not find which package the open flow belongs to.");
  tab.packageId = packageId;
  if (designerTabState && designerTabState.orgId === tab.orgId && designerTabState.itemId === tab.itemId) {
    designerTabState.packageId = packageId;
    await persistDesignerTabState();
  }
  return packageId;
}

function captureDesignerTab() {
  if (!designerTabState) throw new Error("No Flow Designer tab is open.");
  return { ...designerTabState };
}

async function handleCreateModule({ baseUrl, projectionName, masterPassword }) {
  const tab = captureDesignerTab();
  const packageId = await resolvePackageIdFor(tab);
  const flowFetch = boundFlowFetch();
  const masterKey = await instanceStore.ensureMasterKey(IfsInstances.createOneShotPrompt(masterPassword));
  const ifsToken = await instanceStore.getIfsAuthToken(baseUrl, masterKey);

  const inputs = await ProjectionSearch.fetchProjectionCodegenInputs(baseUrl, ifsToken, projectionName);
  const code = await FlowModules.generateModuleCode({
    flowFetch, csdlXml: inputs.csdl, openApiJson: inputs.openApiJson,
    codeGenSubPath: inputs.codeGenSubPath, importSourcePath: inputs.projectionSubPath
  });
  const asset = await FlowModules.findOrCreateModule({ flowFetch, orgId: tab.orgId, packageId, projectionName });
  const newBranch = await FlowModules.commitModuleCode({ flowFetch, orgId: tab.orgId, packageId, assetId: asset.id, flowScriptCode: code });
  return { assetId: asset.id, headVersionId: newBranch.headVersionId };
}

async function handleActivateModule({ assetId, headVersionId }) {
  const tab = captureDesignerTab();
  const flowFetch = boundFlowFetch();
  await FlowDesignerTab.activateModule({ flowFetch, orgId: tab.orgId, itemId: tab.itemId, assetId, headVersionId });
  try {
    const response = await chrome.tabs.sendMessage(tab.tabId, { type: "CLICK_REFRESH" });
    return { refreshed: !!(response && response.clicked) };
  } catch (e) {
    return { refreshed: false };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case "LIST_INSTANCES":
          return sendResponse({ ok: true, instances: await instanceStore.listInstances() });
        case "SAVE_INSTANCE": {
          // The host permission must already be granted by the time this runs — sidepanel.js
          // requests it from the submit handler's own user gesture, since chrome.permissions.request()
          // rejects with "must be called during a user gesture" when called from a service worker's
          // onMessage handler (no gesture context survives the messaging hop). This only verifies.
          const origin = new URL(message.baseUrl).origin + "/*";
          const granted = await chrome.permissions.contains({ origins: [origin] });
          if (!granted) return sendResponse({ ok: false, error: `Permission for ${origin} was not granted — tracking for this instance won't work.` });
          await instanceStore.saveInstance(message.baseUrl, message.fields, await instanceStore.ensureMasterKey(IfsInstances.createOneShotPrompt(message.masterPassword)));
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
        case "SEARCH_PROJECTION": {
          const masterKey = await instanceStore.ensureMasterKey(IfsInstances.createOneShotPrompt(message.masterPassword));
          const token = await instanceStore.getIfsAuthToken(message.baseUrl, masterKey);
          const results = await ProjectionSearch.searchProjections(message.baseUrl, token, message.term);
          return sendResponse({ ok: true, results });
        }
        case "GET_DESIGNER_STATUS":
          return sendResponse({ ok: true, open: !!designerTabState, hasFlowToken: !!flowToken.get() });
        case "GET_MODULE_STATUS": {
          if (!designerTabState) return sendResponse({ ok: true, status: "not_created", assetId: null, headVersionId: null });
          const tab = captureDesignerTab();
          const packageId = await resolvePackageIdFor(tab);
          const flowFetch = boundFlowFetch();
          const moduleAsset = await FlowModules.findExistingModule({ flowFetch, orgId: tab.orgId, packageId, projectionName: message.projectionName });
          const designerData = await FlowDesignerTab.getDesignerData({ flowFetch, orgId: tab.orgId, itemId: tab.itemId });
          const status = FlowDesignerTab.computeModuleStatus(moduleAsset, designerData.assets);
          return sendResponse({
            ok: true,
            status,
            assetId: moduleAsset ? moduleAsset.id : null,
            headVersionId: moduleAsset ? moduleAsset.mainBranch.headVersionId : null
          });
        }
        case "CREATE_MODULE":
          return sendResponse({ ok: true, result: await handleCreateModule(message) });
        case "ACTIVATE_MODULE":
        case "RELOAD_AND_ACTIVATE":
          if (message.type === "RELOAD_AND_ACTIVATE") {
            const created = await handleCreateModule(message);
            return sendResponse({ ok: true, result: await handleActivateModule(created) });
          }
          return sendResponse({ ok: true, result: await handleActivateModule(message) });
        default:
          return sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (e) {
      if (/\(401\)/.test(e.message)) flowToken.clear();
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // keep the message channel open for the async response
});
