let searchResultNames = []; // survive refreshProjections' periodic re-render; cleared only by a new search or instance switch

document.getElementById("trackingToggle").addEventListener("change", (e) => {
  sendOrShowError({ type: "SET_TRACKING_ENABLED", enabled: e.target.checked });
});

async function initTrackingToggle() {
  const response = await sendOrShowError({ type: "GET_TRACKING_ENABLED" });
  if (response) document.getElementById("trackingToggle").checked = response.enabled;
}

// Activation is shown by the row's switch, so only states the switch can't express get a pill.
function statusLabel(status) {
  return {
    not_created: "Not created", activated_stale: "Update available", unknown: "Status unavailable"
  }[status] || "";
}

// --- Incremental row rendering: the panel polls every 5s, and rebuilding the whole list on
// every tick (the original innerHTML="" approach) made the UI visibly flicker/refresh. Rows are
// built once and mutated in place; only genuinely new/removed names touch the DOM tree shape.
// Both sections (tracked projections, modules in the flow's package) use the same row code.
function createRowList(listEl) {
  return { listEl, rows: new Map() }; // rows: upper-cased name -> { name, status, metaText, actions, lastStatus, busy }
}
const projectionListEl = document.getElementById("projectionList");
const trackedRows = createRowList(projectionListEl);
const packageModuleRows = createRowList(document.getElementById("packageModuleList"));

function resetProjectionList() {
  for (const list of [trackedRows, packageModuleRows]) {
    list.rows.clear();
    list.listEl.innerHTML = "";
  }
  searchResultNames = [];
}

function pruneRows(list, keepUpper) {
  for (const key of [...list.rows.keys()]) {
    if (!keepUpper.has(key)) {
      list.rows.get(key).row.remove();
      list.rows.delete(key);
    }
  }
}

function buildProjectionRow() {
  const row = document.createElement("li");
  row.className = "sess-item projection-card";

  const info = document.createElement("div");
  info.className = "sess-info";
  const name = document.createElement("div");
  name.className = "sess-title proj-name";
  const meta = document.createElement("div");
  meta.className = "sess-meta";
  const status = document.createElement("span");
  status.className = "status";
  const metaText = document.createElement("span");
  metaText.className = "proj-meta-text";
  meta.append(status, metaText);
  info.append(name, meta);

  const actions = document.createElement("span");
  actions.className = "proj-actions";

  row.append(info, actions);
  return { row, name, status, metaText, actions, lastStatus: null, busy: false };
}

/** On = the module is in the open flow. Turning it on creates the module first when it doesn't
 *  exist yet (same path as Quick Reports' Module button); turning it off removes it from the flow. */
function buildModuleSwitch(entry, { name, status, assetId, headVersionId, open }) {
  const active = status === "activated" || status === "activated_stale";
  const label = document.createElement("label");
  label.className = "toggle";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = active;
  input.disabled = !open;
  input.setAttribute("aria-label", `${name} active in the open flow`);
  const track = document.createElement("span");
  track.className = "toggle-track";
  const thumb = document.createElement("span");
  thumb.className = "toggle-thumb";
  track.appendChild(thumb);
  label.append(input, track);
  label.title = !open ? "Open or interact with the Designer tab first"
    : active ? "Active in the open flow — switch off to remove it"
      : status === "not_created" ? "Switch on to create the module and add it to the open flow"
        : "Switch on to add the module to the open flow";

  input.onchange = async () => {
    entry.busy = true;
    input.disabled = true;
    try {
      if (!input.checked) await actionOrShowError({ type: "DEACTIVATE_MODULE", assetId });
      else if (status === "not_created") await createAndActivateModule(currentBaseUrl, name);
      else await actionOrShowError({ type: "ACTIVATE_MODULE", assetId, headVersionId, projectionName: name });
    } finally {
      entry.busy = false;
      refreshProjections(); // the real state wins: a failed action flips the switch back
    }
  };
  return label;
}

function renderActions(entry, state) {
  if (entry.busy) return; // keep the in-flight switch as the user left it until the action ends
  entry.actions.innerHTML = "";
  const { name, status, open } = state;
  if (status === "unknown" || status === "no_designer") return;

  if (status === "activated_stale") {
    const reloadBtn = document.createElement("button");
    reloadBtn.textContent = "Reload & Activate";
    reloadBtn.disabled = !open;
    reloadBtn.title = open ? "Regenerate the module from IFS and activate the new version" : "Open or interact with the Designer tab first";
    reloadBtn.onclick = () => runAction(reloadBtn, "Reloading…", () => createAndActivateModule(currentBaseUrl, name, "RELOAD_AND_ACTIVATE"));
    entry.actions.appendChild(reloadBtn);
  }
  entry.actions.appendChild(buildModuleSwitch(entry, state));
}

function upsertProjectionRow(list, name, state) {
  const key = name.toUpperCase();
  let entry = list.rows.get(key);
  if (!entry) {
    entry = buildProjectionRow();
    entry.name.textContent = name;
    list.rows.set(key, entry);
    list.listEl.appendChild(entry.row);
  }

  if (entry.lastStatus !== state.status) {
    entry.status.className = `status status-${state.status}`;
    entry.status.textContent = statusLabel(state.status);
    entry.status.hidden = !entry.status.textContent;
    if (entry.lastStatus !== null && entry.lastStatus !== "unknown") {
      entry.status.classList.remove("flash");
      void entry.status.offsetWidth; // restart the animation on a real transition
      entry.status.classList.add("flash");
    }
    entry.lastStatus = state.status;
  }
  renderActions(entry, { ...state, name }); // status rows carry no name of their own
  return entry;
}

function renderPackageModules(modules, designer) {
  const designerOpen = designer.open;
  const hint = document.getElementById("packageModuleHint");
  hint.textContent = designerBlockReason(designer) || (modules.length ? "" : "No modules in this flow's package yet.");
  hint.hidden = !hint.textContent;
  document.getElementById("packageModuleCount").textContent = modules.length ? `${modules.length}` : "";
  pruneRows(packageModuleRows, new Set(modules.map((m) => m.name.toUpperCase())));
  for (const m of modules) upsertProjectionRow(packageModuleRows, m.name, { ...m, open: designerOpen });
}

async function refreshProjections() {
  const [trackedResponse, designerResponse] = await Promise.all([
    currentBaseUrl ? sendOrShowError({ type: "GET_TRACKED", baseUrl: currentBaseUrl }) : { tracked: [] },
    sendOrShowError({ type: "GET_DESIGNER_STATUS" })
  ]);
  if (!trackedResponse || !designerResponse) return;

  document.getElementById("designerDot").classList.toggle("is-open", designerResponse.open);
  const hint = document.getElementById("designerHint");
  hint.textContent = designerBlockReason(designerResponse);
  hint.hidden = !hint.textContent;

  const trackedByName = new Map(trackedResponse.tracked.map((t) => [t.projectionName.toUpperCase(), t]));
  const trackedNames = trackedResponse.tracked.slice().sort((a, b) => b.firstSeenAt - a.firstSeenAt).map((row) => row.projectionName);
  const trackedUpper = new Set(trackedNames.map((n) => n.toUpperCase()));
  const extraSearchNames = searchResultNames.filter((n) => !trackedUpper.has(n.toUpperCase()));
  const desired = [...trackedNames, ...extraSearchNames];
  pruneRows(trackedRows, new Set(desired.map((n) => n.toUpperCase())));
  document.getElementById("listCount").textContent = desired.length ? `${desired.length}` : "";

  // One call for both sections, not one per row — a row the user can SEE but whose status we
  // couldn't fetch (no Designer tab, no session token yet) still renders, with a plain "Status
  // unavailable" badge and the real reason in its title, instead of silently not appearing.
  // Designer open but no Flow session yet: the hint above already says so — don't also raise the
  // same failure as an error banner on every 5s poll.
  const canCheck = !designerResponse.open || designerResponse.hasFlowToken;
  const statusesResponse = canCheck ? await sendOrShowError({ type: "GET_MODULE_STATUSES", projectionNames: desired }) : null;
  for (const name of desired) {
    const row = statusesResponse && statusesResponse.statuses[name];
    const entry = row
      ? upsertProjectionRow(trackedRows, name, { ...row, open: designerResponse.open })
      : upsertProjectionRow(trackedRows, name, { status: "unknown", assetId: null, headVersionId: null, open: designerResponse.open });
    if (!row) entry.status.title = statusesResponse ? "" : canCheck ? "Could not check status — see the error above." : designerBlockReason(designerResponse);
    const tracked = trackedByName.get(name.toUpperCase());
    entry.metaText.textContent = tracked
      ? `${tracked.hitCount} hit${tracked.hitCount === 1 ? "" : "s"} · first seen ${new Date(tracked.firstSeenAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "from search";
  }
  // A failed poll keeps the last package list rather than blanking it until the next one.
  if (statusesResponse || !canCheck) renderPackageModules(statusesResponse ? statusesResponse.packageModules || [] : [], designerResponse);
}

// The two sections remember whether they're expanded.
for (const id of ["trackedSection", "packageModuleSection"]) {
  const section = document.getElementById(id);
  try { if (localStorage.getItem(`section:${id}`) === "closed") section.open = false; } catch { /* default open */ }
  section.addEventListener("toggle", () => {
    try { localStorage.setItem(`section:${id}`, section.open ? "open" : "closed"); } catch { /* not persisted */ }
  });
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
