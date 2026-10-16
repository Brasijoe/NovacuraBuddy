// browser.runtime.sendMessage returns a Promise natively in Firefox — no callback, no
// chrome.runtime.lastError check needed; a rejection (background page not ready, no listener)
// is caught directly instead.
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
let searchResultNames = []; // survive refreshProjections' periodic re-render; cleared only by a new search

async function refreshInstances() {
  const response = await sendOrShowError({ type: "LIST_INSTANCES" });
  if (!response) return;
  const list = document.getElementById("instanceList");
  list.innerHTML = "";
  for (const instance of response.instances) {
    const li = document.createElement("li");
    li.textContent = `${instance.name} (${instance.baseUrl})`;
    const selectBtn = document.createElement("button");
    selectBtn.textContent = "Select";
    selectBtn.onclick = () => { currentBaseUrl = instance.baseUrl; refreshProjections(); };
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.onclick = async () => { await sendOrShowError({ type: "DELETE_INSTANCE", baseUrl: instance.baseUrl }); refreshInstances(); };
    li.append(selectBtn, deleteBtn);
    list.appendChild(li);
  }
  if (!currentBaseUrl && response.instances.length) currentBaseUrl = response.instances[0].baseUrl;
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
  return { not_created: "Not created", created: "Created", activated: "Activated", activated_stale: "Activated — update available" }[status] || status;
}

const masterPasswordOf = () => document.getElementById("masterPassword").value;

async function renderProjectionRow(container, name) {
  const [statusResponse, designerResponse] = await Promise.all([
    sendOrShowError({ type: "GET_MODULE_STATUS", projectionName: name }),
    sendOrShowError({ type: "GET_DESIGNER_STATUS" })
  ]);
  if (!statusResponse || !designerResponse) return;
  const { status, assetId, headVersionId } = statusResponse;
  const { open } = designerResponse;

  const li = document.createElement("li");
  const label = document.createElement("span");
  label.textContent = name;
  const badge = document.createElement("span");
  badge.className = "status";
  badge.textContent = statusLabel(status);

  const actions = document.createElement("span");
  const disabledTitle = open ? "" : "Open or interact with the Designer tab first";

  if (status === "not_created") {
    const btn = document.createElement("button");
    btn.textContent = "Create";
    btn.disabled = !open;
    btn.title = disabledTitle;
    btn.onclick = () => sendOrShowError({ type: "CREATE_MODULE", baseUrl: currentBaseUrl, projectionName: name, masterPassword: masterPasswordOf() }).then(refreshProjections);
    actions.appendChild(btn);
  } else {
    if (status === "created") {
      const activateBtn = document.createElement("button");
      activateBtn.textContent = "Activate";
      activateBtn.disabled = !open;
      activateBtn.title = disabledTitle;
      activateBtn.onclick = () => sendOrShowError({ type: "ACTIVATE_MODULE", assetId, headVersionId }).then(refreshProjections);
      actions.appendChild(activateBtn);
    }
    if (status !== "activated") {
      const reloadBtn = document.createElement("button");
      reloadBtn.textContent = "Reload & Activate";
      reloadBtn.disabled = !open;
      reloadBtn.title = disabledTitle;
      reloadBtn.onclick = () => sendOrShowError({ type: "RELOAD_AND_ACTIVATE", baseUrl: currentBaseUrl, projectionName: name, masterPassword: masterPasswordOf() }).then(refreshProjections);
      actions.appendChild(reloadBtn);
    }
  }

  li.append(label, badge, actions);
  container.appendChild(li);
}

async function refreshProjections() {
  if (!currentBaseUrl) return;
  const response = await sendOrShowError({ type: "GET_TRACKED", baseUrl: currentBaseUrl });
  if (!response) return;
  const container = document.getElementById("projectionList");
  container.innerHTML = "";

  const trackedNames = response.tracked.slice().sort((a, b) => b.firstSeenAt - a.firstSeenAt).map((row) => row.projectionName);
  const trackedUpper = new Set(trackedNames.map((n) => n.toUpperCase()));
  const extraSearchNames = searchResultNames.filter((n) => !trackedUpper.has(n.toUpperCase()));

  for (const name of [...trackedNames, ...extraSearchNames]) {
    await renderProjectionRow(container, name);
  }
}

async function refreshUnmatchedHosts() {
  const response = await sendOrShowError({ type: "GET_UNMATCHED_HOSTS" });
  if (!response) return;
  const container = document.getElementById("unmatchedHosts");
  container.innerHTML = "";
  for (const host of response.hosts) {
    const p = document.createElement("p");
    p.textContent = `Traced calls to "${host}" don't match any saved instance. `;
    const btn = document.createElement("button");
    btn.textContent = "Add this instance";
    btn.onclick = () => {
      document.getElementById("instanceBaseUrl").value = `https://${host}`;
      document.getElementById("instanceBaseUrl").focus();
    };
    p.appendChild(btn);
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
