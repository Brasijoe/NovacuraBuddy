function send(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

let currentBaseUrl = null;

async function refreshInstances() {
  const { instances } = await send({ type: "LIST_INSTANCES" });
  const list = document.getElementById("instanceList");
  list.innerHTML = "";
  for (const instance of instances) {
    const li = document.createElement("li");
    li.textContent = `${instance.name} (${instance.baseUrl})`;
    const selectBtn = document.createElement("button");
    selectBtn.textContent = "Select";
    selectBtn.onclick = () => { currentBaseUrl = instance.baseUrl; refreshProjections(); };
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.onclick = async () => { await send({ type: "DELETE_INSTANCE", baseUrl: instance.baseUrl }); refreshInstances(); };
    li.append(selectBtn, deleteBtn);
    list.appendChild(li);
  }
  if (!currentBaseUrl && instances.length) currentBaseUrl = instances[0].baseUrl;
}

document.getElementById("instanceForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await send({
    type: "SAVE_INSTANCE",
    baseUrl: document.getElementById("instanceBaseUrl").value,
    masterPassword: document.getElementById("masterPassword").value,
    fields: {
      name: document.getElementById("instanceName").value,
      authMethod: "client_credentials",
      tokenEndpoint: document.getElementById("instanceTokenEndpoint").value,
      clientId: document.getElementById("instanceClientId").value,
      secretPayload: { clientSecret: document.getElementById("instanceClientSecret").value }
    }
  });
  e.target.reset();
  refreshInstances();
});

document.getElementById("trackingToggle").addEventListener("change", (e) => {
  send({ type: "SET_TRACKING_ENABLED", enabled: e.target.checked });
});

function statusLabel(status) {
  return { not_created: "Not created", created: "Created", activated: "Activated", activated_stale: "Activated — update available" }[status] || status;
}

const masterPasswordOf = () => document.getElementById("masterPassword").value;

async function renderProjectionRow(container, name) {
  const [{ status, assetId, headVersionId }, { open }] = await Promise.all([
    send({ type: "GET_MODULE_STATUS", projectionName: name }),
    send({ type: "GET_DESIGNER_STATUS" })
  ]);

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
    btn.onclick = () => send({ type: "CREATE_MODULE", baseUrl: currentBaseUrl, projectionName: name, masterPassword: masterPasswordOf() }).then(refreshProjections);
    actions.appendChild(btn);
  } else {
    if (status === "created") {
      const activateBtn = document.createElement("button");
      activateBtn.textContent = "Activate";
      activateBtn.disabled = !open;
      activateBtn.title = disabledTitle;
      activateBtn.onclick = () => send({ type: "ACTIVATE_MODULE", assetId, headVersionId }).then(refreshProjections);
      actions.appendChild(activateBtn);
    }
    const reloadBtn = document.createElement("button");
    reloadBtn.textContent = "Reload & Activate";
    reloadBtn.disabled = !open;
    reloadBtn.title = disabledTitle;
    reloadBtn.onclick = () => send({ type: "RELOAD_AND_ACTIVATE", baseUrl: currentBaseUrl, projectionName: name, masterPassword: masterPasswordOf() }).then(refreshProjections);
    actions.appendChild(reloadBtn);
  }

  li.append(label, badge, actions);
  container.appendChild(li);
}

async function refreshProjections() {
  if (!currentBaseUrl) return;
  const { tracked } = await send({ type: "GET_TRACKED", baseUrl: currentBaseUrl });
  const container = document.getElementById("projectionList");
  container.innerHTML = "";
  const sorted = tracked.slice().sort((a, b) => b.firstSeenAt - a.firstSeenAt);
  for (const row of sorted) {
    await renderProjectionRow(container, row.projectionName);
  }
}

async function refreshUnmatchedHosts() {
  const { hosts } = await send({ type: "GET_UNMATCHED_HOSTS" });
  const container = document.getElementById("unmatchedHosts");
  container.innerHTML = "";
  for (const host of hosts) {
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
  const { meta } = await send({ type: "SEARCH_PROJECTION", baseUrl: currentBaseUrl, term, masterPassword: masterPasswordOf() });
  if (meta) await renderProjectionRow(document.getElementById("projectionList"), meta.ProjectionName);
});

refreshInstances();
refreshProjections();
refreshUnmatchedHosts();
setInterval(() => { refreshProjections(); refreshUnmatchedHosts(); }, 5000);
