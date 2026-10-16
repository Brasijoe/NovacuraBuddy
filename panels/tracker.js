let searchResultNames = []; // survive refreshProjections' periodic re-render; cleared only by a new search or instance switch

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
    activated_stale: "Update available", unknown: "Status unavailable", no_designer: "—"
  }[status] || status;
}

// --- Incremental row rendering: the panel polls every 5s, and rebuilding the whole list on
// every tick (the original innerHTML="" approach) made the UI visibly flicker/refresh. Rows are
// built once and mutated in place; only genuinely new/removed names touch the DOM tree shape.
const rowElements = new Map(); // upper-cased name -> { name, status, actions, lastStatus }
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

function renderActions(entry, { name, status, assetId, headVersionId, open }) {
  entry.actions.innerHTML = "";
  const disabledTitle = open ? "" : "Open or interact with the Designer tab first";

  if (status === "unknown" || status === "no_designer") return;

  if (status === "not_created") {
    const btn = document.createElement("button");
    btn.textContent = "Create";
    btn.className = "btn-primary";
    btn.disabled = !open;
    btn.title = disabledTitle || "Create the module and activate it in the open flow";
    btn.onclick = () => runAction(btn, "Creating & activating…", () => actionOrShowError({ type: "CREATE_MODULE", baseUrl: currentBaseUrl, projectionName: name, masterPassword: masterPasswordOf() }));
    entry.actions.appendChild(btn);
    return;
  }

  if (status === "created") {
    const activateBtn = document.createElement("button");
    activateBtn.textContent = "Activate";
    activateBtn.className = "btn-primary";
    activateBtn.disabled = !open;
    activateBtn.title = disabledTitle;
    activateBtn.onclick = () => runAction(activateBtn, "Activating…", () => actionOrShowError({ type: "ACTIVATE_MODULE", assetId, headVersionId, projectionName: name }));
    entry.actions.appendChild(activateBtn);
  }

  if (status !== "activated") {
    const reloadBtn = document.createElement("button");
    reloadBtn.textContent = "Reload & Activate";
    reloadBtn.disabled = !open;
    reloadBtn.title = disabledTitle;
    reloadBtn.onclick = () => runAction(reloadBtn, "Reloading…", () => actionOrShowError({ type: "RELOAD_AND_ACTIVATE", baseUrl: currentBaseUrl, projectionName: name, masterPassword: masterPasswordOf() }));
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
      void entry.status.offsetWidth; // restart the animation on a real transition
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
  const hint = document.getElementById("designerHint");
  hint.textContent = !designerResponse.open
    ? "No Flow Designer tab active — switch to the Designer tab of the flow (Create/Activate act on it)."
    : !designerResponse.hasFlowToken
      ? "Designer tab found, but no Flow session yet — click anywhere in the Designer tab once."
      : "";
  hint.hidden = !hint.textContent;

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

  // One call for the whole list, not one per row — a row the user can SEE but whose status we
  // couldn't fetch (no Designer tab, no session token yet) still renders, with a plain "Status
  // unavailable" badge and the real reason in its title, instead of silently not appearing at
  // all (count said "N tracked", the list showed nothing — confusing and now fixed).
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
  const response = await actionOrShowError({ type: "CLEAR_TRACKED", baseUrl: currentBaseUrl });
  if (!response) return;
  resetProjectionList();
  refreshProjections();
});

document.getElementById("searchBtn").addEventListener("click", async () => {
  const term = document.getElementById("searchTerm").value.trim();
  if (!term || !currentBaseUrl) return;
  const response = await actionOrShowError({ type: "SEARCH_PROJECTION", baseUrl: currentBaseUrl, term, masterPassword: masterPasswordOf() });
  if (!response) return;
  searchResultNames = response.results.map((r) => r.ProjectionName);
  if (searchResultNames.length === 0) showError(`No projection found matching "${term}".`, true);
  refreshProjections();
});
