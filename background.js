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

const instanceStore = IfsInstances.createIfsInstanceStore({ local: chrome.storage.local, session: chrome.storage.session });
const flowToken = FlowToken.createTokenCache(45 * 60 * 1000);
let excludedSet = ProjectionFilter.parseExcludedList(""); // populated in init()
let designerTabState = null; // { tabId, orgId, itemId, packageId }

async function init() {
  const text = await (await fetch(chrome.runtime.getURL("lib/excluded-projections.txt"))).text();
  excludedSet = ProjectionFilter.parseExcludedList(text);
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

const UNMATCHED_HOSTS_KEY = "unmatchedHosts";

async function recordUnmatchedHost(hostname) {
  const { [UNMATCHED_HOSTS_KEY]: hosts = [] } = await chrome.storage.session.get(UNMATCHED_HOSTS_KEY);
  if (hosts.includes(hostname)) return;
  await chrome.storage.session.set({ [UNMATCHED_HOSTS_KEY]: [...hosts, hostname] });
}

chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
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
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const token = FlowToken.extractBearerToken(details.requestHeaders);
    if (token) flowToken.set(token);
    return {};
  },
  { urls: ["https://build.novacura.com/*"] },
  ["requestHeaders", "extraHeaders"]
);

async function refreshDesignerTabState() {
  const tabs = await chrome.tabs.query({ url: "https://build.novacura.com/admin/design/designer/*" });
  if (!tabs.length) {
    designerTabState = null;
    return;
  }
  const parsed = FlowDesignerTab.parseDesignerTabUrl(tabs[0].url);
  if (!parsed) {
    designerTabState = null;
    return;
  }
  designerTabState = { tabId: tabs[0].id, orgId: parsed.orgId, itemId: parsed.itemId, packageId: null };
}

chrome.tabs.onUpdated.addListener(() => refreshDesignerTabState());
chrome.tabs.onRemoved.addListener(() => refreshDesignerTabState());

function boundFlowFetch() {
  const token = flowToken.get();
  if (!token) throw new Error("No Novacura Flow session found yet — open or interact with the Designer tab first.");
  return (path, options) => FlowConnectRest.flowFetch(token, path, options);
}

async function ensureDesignerPackageId() {
  if (!designerTabState) throw new Error("No Flow Designer tab is open.");
  if (!designerTabState.packageId) {
    designerTabState.packageId = await FlowDesignerTab.resolvePackageId({
      flowFetch: boundFlowFetch(), orgId: designerTabState.orgId, itemId: designerTabState.itemId
    });
  }
  if (!designerTabState.packageId) throw new Error("Could not find which package the open flow belongs to.");
  return designerTabState.packageId;
}

async function handleCreateModule({ baseUrl, projectionName, masterPassword }) {
  const packageId = await ensureDesignerPackageId();
  const flowFetch = boundFlowFetch();
  const masterKey = await instanceStore.ensureMasterKey(async () => masterPassword);
  const ifsToken = await instanceStore.getIfsAuthToken(baseUrl, masterKey);

  const inputs = await ProjectionSearch.fetchProjectionCodegenInputs(baseUrl, ifsToken, projectionName);
  const code = await FlowModules.generateModuleCode({
    flowFetch, csdlXml: inputs.csdl, openApiJson: inputs.openApiJson,
    codeGenSubPath: inputs.codeGenSubPath, importSourcePath: inputs.projectionSubPath
  });
  const asset = await FlowModules.findOrCreateModule({ flowFetch, orgId: designerTabState.orgId, packageId, projectionName });
  const newBranch = await FlowModules.commitModuleCode({ flowFetch, orgId: designerTabState.orgId, packageId, assetId: asset.id, flowScriptCode: code });
  return { assetId: asset.id, headVersionId: newBranch.headVersionId };
}

async function handleActivateModule({ assetId, headVersionId }) {
  if (!designerTabState) throw new Error("No Flow Designer tab is open.");
  const flowFetch = boundFlowFetch();
  await FlowDesignerTab.activateModule({ flowFetch, orgId: designerTabState.orgId, itemId: designerTabState.itemId, assetId, headVersionId });
  try {
    const [response] = await chrome.tabs.sendMessage(designerTabState.tabId, { type: "CLICK_REFRESH" });
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
          // Tracking an instance's host requires the actual (not just declared) host permission —
          // optional_host_permissions in the manifest only makes requesting it possible, it grants nothing
          // by itself. Without this, webRequest silently never fires for that host at all.
          const origin = new URL(message.baseUrl).origin + "/*";
          const granted = await chrome.permissions.request({ origins: [origin] });
          if (!granted) return sendResponse({ ok: false, error: `Permission for ${origin} was not granted — tracking for this instance won't work.` });
          await instanceStore.saveInstance(message.baseUrl, message.fields, await instanceStore.ensureMasterKey(async () => message.masterPassword));
          return sendResponse({ ok: true });
        }
        case "DELETE_INSTANCE":
          await instanceStore.deleteInstance(message.baseUrl);
          return sendResponse({ ok: true });
        case "GET_UNMATCHED_HOSTS": {
          const { [UNMATCHED_HOSTS_KEY]: hosts = [] } = await chrome.storage.session.get(UNMATCHED_HOSTS_KEY);
          return sendResponse({ ok: true, hosts });
        }
        case "SET_TRACKING_ENABLED":
          await chrome.storage.local.set({ [TRACKING_ENABLED_KEY]: message.enabled });
          return sendResponse({ ok: true });
        case "GET_TRACKED": {
          const key = TRACKED_PROJECTIONS_PREFIX + message.baseUrl;
          const { [key]: list = [] } = await chrome.storage.session.get(key);
          return sendResponse({ ok: true, tracked: list });
        }
        case "SEARCH_PROJECTION": {
          const masterKey = await instanceStore.ensureMasterKey(async () => message.masterPassword);
          const token = await instanceStore.getIfsAuthToken(message.baseUrl, masterKey);
          const meta = await ProjectionSearch.queryProjectionMeta(message.baseUrl, token, message.term);
          return sendResponse({ ok: true, meta });
        }
        case "GET_DESIGNER_STATUS":
          return sendResponse({ ok: true, open: !!designerTabState, hasFlowToken: !!flowToken.get() });
        case "GET_MODULE_STATUS": {
          if (!designerTabState) return sendResponse({ ok: true, status: "not_created", assetId: null, headVersionId: null });
          const packageId = await ensureDesignerPackageId();
          const flowFetch = boundFlowFetch();
          const moduleAsset = await FlowModules.findExistingModule({ flowFetch, orgId: designerTabState.orgId, packageId, projectionName: message.projectionName });
          const designerData = await FlowDesignerTab.getDesignerData({ flowFetch, orgId: designerTabState.orgId, itemId: designerTabState.itemId });
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
