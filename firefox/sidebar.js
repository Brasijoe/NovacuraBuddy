function send(message) {
  return browser.runtime.sendMessage(message).catch((err) => ({
    ok: false,
    error: (err && err.message) || "No response from the extension's background page — try again."
  }));
}

function showError(message) {
  const el = document.getElementById("error");
  el.textContent = message;
  el.hidden = false;
}

function clearError() {
  const el = document.getElementById("error");
  el.hidden = true;
  el.textContent = "";
}

async function sendOrShowError(message) {
  const response = await send(message);
  if (!response || !response.ok) {
    showError((response && response.error) || "Something went wrong.");
    return null;
  }
  clearError();
  return response;
}

let currentBaseUrl = null;
let currentInstances = [];
let searchResultNames = []; // survive refreshProjections' periodic re-render; cleared only by a new search or instance switch

function updateCurrentInstanceLabel() {
  const instance = currentInstances.find((i) => i.baseUrl === currentBaseUrl);
  document.getElementById("currentInstanceName").textContent = instance ? instance.name : "No instance selected";
}

async function refreshInstances() {
  const response = await sendOrShowError({ type: "LIST_INSTANCES" });
  if (!response) return;
  currentInstances = response.instances;
  if (!currentBaseUrl && currentInstances.length) currentBaseUrl = currentInstances[0].baseUrl;

  const list = document.getElementById("instanceList");
  list.innerHTML = "";
  for (const instance of currentInstances) {
    const li = document.createElement("li");
    li.className = instance.baseUrl === currentBaseUrl ? "is-selected" : "";
    li.title = "Select this instance";

    const name = document.createElement("span");
    name.className = "instance-name";
    name.textContent = `${instance.name} (${instance.baseUrl})`;
    li.appendChild(name);

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.className = "btn-ghost";
    deleteBtn.onclick = async (e) => {
      e.stopPropagation();
      await sendOrShowError({ type: "DELETE_INSTANCE", baseUrl: instance.baseUrl });
      if (currentBaseUrl === instance.baseUrl) currentBaseUrl = null;
      refreshInstances();
    };
    li.appendChild(deleteBtn);

    li.onclick = () => {
      currentBaseUrl = instance.baseUrl;
      resetProjectionList();
      updateCurrentInstanceLabel();
      refreshInstances();
      refreshProjections();
    };
    list.appendChild(li);
  }
  updateCurrentInstanceLabel();
}

document.getElementById("instanceForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const baseUrl = document.getElementById("instanceBaseUrl").value;

  // browser.permissions.request() also only works from inside a real user gesture — this submit
  // handler is one, the background page's onMessage listener is not.
  let origin;
  try {
    origin = new URL(baseUrl).origin + "/*";
  } catch (err) {
    showError(`"${baseUrl}" isn't a valid URL.`);
    return;
  }
  const granted = await browser.permissions.request({ origins: [origin] });
  if (!granted) {
    showError(`Permission for ${origin} was not granted — tracking for this instance won't work until it is.`);
    return;
  }

  const response = await sendOrShowError({
    type: "SAVE_INSTANCE",
    baseUrl,
    masterPassword: document.getElementById("masterPassword").value,
    fields: {
      name: document.getElementById("instanceName").value,
      authMethod: "client_credentials",
      tokenEndpoint: document.getElementById("instanceTokenEndpoint").value,
      clientId: document.getElementById("instanceClientId").value,
      secretPayload: { clientSecret: document.getElementById("instanceClientSecret").value }
    }
  });
  if (!response) return;
  e.target.reset();
  refreshInstances();
});

document.getElementById("trackingToggle").addEventListener("change", (e) => {
  sendOrShowError({ type: "SET_TRACKING_ENABLED", enabled: e.target.checked });
});

async function initTrackingToggle() {
  const response = await sendOrShowError({ type: "GET_TRACKING_ENABLED" });
  if (response) document.getElementById("trackingToggle").checked = response.enabled;
}

function statusLabel(status) {
  return {
    not_created: "Not created", created: "Created", activated: "Activated",
    activated_stale: "Update available", unknown: "Status unavailable"
  }[status] || status;
}

const masterPasswordOf = () => document.getElementById("masterPassword").value;

const rowElements = new Map(); // upper-cased name -> { row, name, status, actions, lastStatus }
const projectionListEl = document.getElementById("projectionList");

function resetProjectionList() {
  rowElements.clear();
  searchResultNames = [];
  projectionListEl.innerHTML = "";
}

function buildProjectionRow() {
  const row = document.createElement("li");
  row.className = "projection-row";

  const name = document.createElement("span");
  name.className = "proj-name";

  const status = document.createElement("span");
  status.className = "status";

  const actions = document.createElement("span");
  actions.className = "proj-actions";

  row.append(name, status, actions);
  return { row, name, status, actions, lastStatus: null };
}

function runAction(btn, busyLabel, action) {
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyLabel;
  action()
    .catch(() => {})
    .finally(() => {
      btn.textContent = originalLabel;
      refreshProjections();
    });
}

function renderActions(entry, { name, status, assetId, headVersionId, open }) {
  entry.actions.innerHTML = "";
  const disabledTitle = open ? "" : "Open or interact with the Designer tab first";

  if (status === "unknown") return;

  if (status === "not_created") {
    const btn = document.createElement("button");
    btn.textContent = "Create";
    btn.className = "btn-primary";
    btn.disabled = !open;
    btn.title = disabledTitle;
    btn.onclick = () => runAction(btn, "Creating…", () => sendOrShowError({ type: "CREATE_MODULE", baseUrl: currentBaseUrl, projectionName: name, masterPassword: masterPasswordOf() }));
    entry.actions.appendChild(btn);
    return;
  }

  if (status === "created") {
    const activateBtn = document.createElement("button");
    activateBtn.textContent = "Activate";
    activateBtn.className = "btn-primary";
    activateBtn.disabled = !open;
    activateBtn.title = disabledTitle;
    activateBtn.onclick = () => runAction(activateBtn, "Activating…", () => sendOrShowError({ type: "ACTIVATE_MODULE", assetId, headVersionId }));
    entry.actions.appendChild(activateBtn);
  }

  if (status !== "activated") {
    const reloadBtn = document.createElement("button");
    reloadBtn.textContent = "Reload & Activate";
    reloadBtn.disabled = !open;
    reloadBtn.title = disabledTitle;
    reloadBtn.onclick = () => runAction(reloadBtn, "Reloading…", () => sendOrShowError({ type: "RELOAD_AND_ACTIVATE", baseUrl: currentBaseUrl, projectionName: name, masterPassword: masterPasswordOf() }));
    entry.actions.appendChild(reloadBtn);
  }
}

function upsertProjectionRow(name, { status, assetId, headVersionId, open }) {
  const key = name.toUpperCase();
  let entry = rowElements.get(key);
  if (!entry) {
    entry = buildProjectionRow();
    entry.name.textContent = name;
    rowElements.set(key, entry);
    projectionListEl.appendChild(entry.row);
  }

  if (entry.lastStatus !== status) {
    entry.status.className = `status status-${status}`;
    entry.status.textContent = statusLabel(status);
    if (entry.lastStatus !== null && entry.lastStatus !== "unknown") {
      entry.status.classList.remove("flash");
      void entry.status.offsetWidth;
      entry.status.classList.add("flash");
    }
    entry.lastStatus = status;
  }
  renderActions(entry, { name, status, assetId, headVersionId, open });
}

async function refreshProjections() {
  document.getElementById("listCount").textContent = "";
  if (!currentBaseUrl) return;

  const [trackedResponse, designerResponse] = await Promise.all([
    sendOrShowError({ type: "GET_TRACKED", baseUrl: currentBaseUrl }),
    sendOrShowError({ type: "GET_DESIGNER_STATUS" })
  ]);
  if (!trackedResponse || !designerResponse) return;

  document.getElementById("designerDot").classList.toggle("is-open", designerResponse.open);

  const trackedNames = trackedResponse.tracked.slice().sort((a, b) => b.firstSeenAt - a.firstSeenAt).map((row) => row.projectionName);
  const trackedUpper = new Set(trackedNames.map((n) => n.toUpperCase()));
  const extraSearchNames = searchResultNames.filter((n) => !trackedUpper.has(n.toUpperCase()));
  const desired = [...trackedNames, ...extraSearchNames];
  const desiredUpper = new Set(desired.map((n) => n.toUpperCase()));

  for (const key of [...rowElements.keys()]) {
    if (!desiredUpper.has(key)) {
      rowElements.get(key).row.remove();
      rowElements.delete(key);
    }
  }

  document.getElementById("listCount").textContent = desired.length ? `${desired.length} tracked` : "";
  if (desired.length === 0) return;

  const statusesResponse = await sendOrShowError({ type: "GET_MODULE_STATUSES", projectionNames: desired });
  for (const name of desired) {
    const row = statusesResponse && statusesResponse.statuses[name];
    if (row) {
      upsertProjectionRow(name, { ...row, open: designerResponse.open });
    } else {
      upsertProjectionRow(name, { status: "unknown", assetId: null, headVersionId: null, open: designerResponse.open });
      const key = name.toUpperCase();
      rowElements.get(key).status.title = (statusesResponse ? "" : "Could not check status — see the error above.");
    }
  }
}

document.getElementById("clearTraceBtn").addEventListener("click", async () => {
  if (!currentBaseUrl) return;
  const response = await sendOrShowError({ type: "CLEAR_TRACKED", baseUrl: currentBaseUrl });
  if (!response) return;
  resetProjectionList();
  refreshProjections();
});

async function refreshUnmatchedHosts() {
  const response = await sendOrShowError({ type: "GET_UNMATCHED_HOSTS" });
  if (!response) return;
  const container = document.getElementById("unmatchedHosts");
  container.innerHTML = "";
  for (const host of response.hosts) {
    const p = document.createElement("p");
    const label = document.createElement("span");
    label.textContent = `Traced calls to "${host}" don't match any saved instance.`;
    const btn = document.createElement("button");
    btn.textContent = "Add this instance";
    btn.className = "btn-ghost";
    btn.onclick = () => {
      document.getElementById("instancesDrawer").open = true;
      document.getElementById("instanceBaseUrl").value = `https://${host}`;
      document.getElementById("instanceBaseUrl").focus();
    };
    p.append(label, btn);
    container.appendChild(p);
  }
}

document.getElementById("searchBtn").addEventListener("click", async () => {
  const term = document.getElementById("searchTerm").value.trim();
  if (!term || !currentBaseUrl) return;
  const response = await sendOrShowError({ type: "SEARCH_PROJECTION", baseUrl: currentBaseUrl, term, masterPassword: masterPasswordOf() });
  if (!response) return;
  searchResultNames = response.results.map((r) => r.ProjectionName);
  if (searchResultNames.length === 0) showError(`No projection found matching "${term}".`);
  refreshProjections();
});

initTrackingToggle();
refreshInstances();
refreshProjections();
refreshUnmatchedHosts();
setInterval(() => { refreshProjections(); refreshUnmatchedHosts(); }, 5000);
