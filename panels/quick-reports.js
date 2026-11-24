let qrReports = [];
let qrSearch = null;
let qrLoadedOnce = false;
let qrRenderedSig = null; // identity of what the list currently shows; unchanged → keep the DOM (and any open panel)
let qrOpenPanel = null; // the one expanded panel in the list (deploy form or module picker): { close() }
let qrDeployments = new Map(); // report id -> its deployments, newest first (one per instance)
let qrDesigner = { open: false, hasFlowToken: false };
let qrFolderState = QrFolders.empty(); // customer folders (see lib/qr-folders.js)
const qrRows = new Map(); // report id -> { applyState() } for the rows currently shown
const qrModuleBoxes = new Set(); // { applyState() } of every QuickReports module control on screen

function openQrEditor(id) {
  chrome.tabs.create({ url: chrome.runtime.getURL("qr-editor.html" + (id ? `?id=${encodeURIComponent(id)}` : "")) });
}

const qrInstanceFor = (instanceKey) => currentInstances.find((i) => new URL(i.baseUrl).origin === instanceKey) || null;
const qrInstanceName = (instanceKey) => (qrInstanceFor(instanceKey) || { name: instanceKey }).name;
const qrDeploymentLabel = (d) => `${qrInstanceName(d.instanceKey)} · ID ${d.quickReportId}`;

function setQrReports(reports, fetchedAt) {
  qrReports = reports;
  qrSearch = QrSearch.createQrSearch(reports, Fuse);
  document.getElementById("qrRefreshed").textContent = fetchedAt ? `Last refreshed ${new Date(fetchedAt).toLocaleString()}` : "";
  renderQrList();
}

/** A button that expands `panel` under its row; only one panel in the whole list is open at once. */
function qrExpander(btn, panel, label) {
  const expander = {
    get isOpen() { return !panel.hidden; },
    open() {
      if (qrOpenPanel) qrOpenPanel.close();
      panel.hidden = false;
      btn.textContent = "Close";
      qrOpenPanel = expander;
    },
    close() {
      panel.hidden = true;
      btn.textContent = label;
      if (qrOpenPanel === expander) qrOpenPanel = null;
    }
  };
  return expander;
}

async function updateQrFolders(next) {
  qrFolderState = next;
  qrRenderedSig = null;
  renderQrList();
  await QrFolders.save(next);
}

function renderQrList() {
  const term = document.getElementById("qrSearch").value;
  const searching = !!term.trim();
  const shown = qrSearch ? qrSearch.search(term) : [];
  document.getElementById("qrCount").textContent = qrReports.length ? `${shown.length} of ${qrReports.length}` : "";
  const list = document.getElementById("qrList");
  const sig = JSON.stringify([shown.map((r) => [r.id, r.name, r.sqlSha, r.jsonSha]), qrFolderState, searching]);
  if (sig === qrRenderedSig) return;
  qrRenderedSig = sig;
  qrOpenPanel = null;
  qrRows.clear();
  list.innerHTML = "";
  if (!qrFolderState.folders.length) {
    for (const report of shown) list.appendChild(buildQrRow(report));
    return;
  }
  // While searching, folders without a hit disappear and the others open up so hits are visible.
  for (const g of QrFolders.group(qrFolderState, shown, { hideEmpty: searching })) list.appendChild(buildQrFolder(g, searching));
}

/** One expandable customer folder (or the "No folder" group): a header you can drop reports on,
 *  and the report rows below it. */
function buildQrFolder({ folder, reports }, searching) {
  const id = folder ? folder.id : "";
  const collapsed = !searching && !!(folder ? qrFolderState.collapsed[folder.id] : qrFolderState.collapsed["__none"]);
  const li = document.createElement("li");
  li.className = "qr-folder" + (folder ? "" : " qr-folder-none");

  const head = document.createElement("div");
  head.className = "qr-folder-head";
  const toggle = document.createElement("button");
  toggle.className = "qr-folder-toggle btn-ghost";
  toggle.setAttribute("aria-expanded", String(!collapsed));
  const caret = document.createElement("span");
  caret.className = "qr-caret";
  caret.textContent = collapsed ? "▸" : "▾";
  const title = document.createElement("span");
  title.className = "qr-folder-name";
  title.textContent = folder ? folder.name : "No folder";
  const count = document.createElement("span");
  count.className = "qr-folder-count";
  count.textContent = String(reports.length);
  toggle.append(caret, title, count);
  toggle.onclick = () => updateQrFolders(QrFolders.setCollapsed(qrFolderState, folder ? folder.id : "__none", !collapsed));
  head.appendChild(toggle);

  if (folder) {
    const rename = document.createElement("button");
    rename.className = "btn-ghost";
    rename.textContent = "Rename";
    rename.onclick = () => {
      const input = document.createElement("input");
      input.value = folder.name;
      input.className = "qr-folder-input";
      toggle.replaceWith(input);
      rename.hidden = true;
      input.focus();
      input.select();
      let done = false;
      const finish = (apply) => {
        if (done) return;
        done = true;
        if (!apply || input.value.trim() === folder.name) return updateQrFolders(qrFolderState);
        try { updateQrFolders(QrFolders.renameFolder(qrFolderState, folder.id, input.value)); }
        catch (e) { showError(e.message, true); updateQrFolders(qrFolderState); }
      };
      input.onkeydown = (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); };
      input.onblur = () => finish(true);
    };
    const del = document.createElement("button");
    del.className = "btn-ghost";
    del.textContent = "Delete";
    del.title = "Deletes the folder only; its reports move to “No folder”";
    let armed = false;
    del.onclick = () => {
      if (!armed) { armed = true; del.textContent = "Sure? Reports stay"; return; }
      updateQrFolders(QrFolders.deleteFolder(qrFolderState, folder.id));
    };
    del.onblur = () => { armed = false; del.textContent = "Delete"; };
    head.append(rename, del);
  }

  const inner = document.createElement("ul");
  inner.className = "qr-list qr-folder-body";
  inner.hidden = collapsed;
  if (!reports.length) {
    const hint = document.createElement("li");
    hint.className = "empty-state qr-folder-empty";
    hint.textContent = "Drag Quick Reports here.";
    inner.appendChild(hint);
  }
  for (const report of reports) inner.appendChild(buildQrRow(report));
  li.append(head, inner);

  // Drop target: the whole folder card.
  li.addEventListener("dragover", (e) => {
    if (!e.dataTransfer || !e.dataTransfer.types.includes("application/x-qr-report")) return;
    e.preventDefault();
    li.classList.add("is-drop");
  });
  li.addEventListener("dragleave", (e) => { if (!li.contains(e.relatedTarget)) li.classList.remove("is-drop"); });
  li.addEventListener("drop", (e) => {
    li.classList.remove("is-drop");
    const rid = e.dataTransfer && e.dataTransfer.getData("application/x-qr-report");
    if (!rid) return;
    e.preventDefault();
    updateQrFolders(QrFolders.moveReport(qrFolderState, rid, id || null));
  });
  return li;
}

/** "New folder" button + inline name field in the list toolbar. */
function initQrFolderCreate() {
  const btn = document.getElementById("qrNewFolderBtn");
  const row = document.getElementById("qrNewFolderRow");
  const input = document.getElementById("qrNewFolderInput");
  const close = () => { row.hidden = true; input.value = ""; };
  const create = () => {
    try {
      updateQrFolders(QrFolders.addFolder(qrFolderState, input.value).state);
      close();
    } catch (e) { showError(e.message, true); }
  };
  btn.onclick = () => { row.hidden = !row.hidden; if (!row.hidden) input.focus(); };
  document.getElementById("qrNewFolderOk").onclick = create;
  document.getElementById("qrNewFolderCancel").onclick = close;
  input.onkeydown = (e) => { if (e.key === "Enter") create(); if (e.key === "Escape") close(); };
}

function buildQrRow(report) {
  const li = document.createElement("li");
  li.className = "qr-item";
  li.draggable = true;
  li.title = "Drag onto a customer folder to file this report";
  li.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("application/x-qr-report", report.id);
    e.dataTransfer.effectAllowed = "move";
    li.classList.add("is-dragging");
  });
  li.addEventListener("dragend", () => li.classList.remove("is-dragging"));

  const head = document.createElement("div");
  head.className = "qr-head";
  const name = document.createElement("span");
  name.className = "qr-name";
  name.textContent = report.name;
  const pill = document.createElement("span");
  pill.className = "status status-deployed";
  pill.hidden = true;
  const deployBtn = document.createElement("button");
  deployBtn.textContent = "Deploy";
  const moduleBtn = document.createElement("button");
  moduleBtn.textContent = "Module";
  moduleBtn.hidden = true;
  const editBtn = document.createElement("button");
  editBtn.className = "btn-ghost";
  editBtn.textContent = "Edit";
  editBtn.onclick = () => openQrEditor(report.id);
  head.append(name, pill, deployBtn, moduleBtn, editBtn);

  const linksEl = document.createElement("div");
  linksEl.className = "qr-ifs-links";

  const preview = document.createElement("div");
  preview.className = "qr-preview";
  preview.textContent = report.content.replace(/\s+/g, " ").trim().slice(0, 160);
  preview.title = report.content;

  const form = document.createElement("div");
  form.hidden = true;
  const picker = document.createElement("div");
  picker.className = "qr-picker";
  picker.hidden = true;

  // The row's one green confirmation line (last deploy or module), replaced by the next action.
  let confirmation = null;
  let moduleBoxEl = null; // the "Create/update QuickReports module" option shown after a deploy
  const clearConfirmation = () => {
    if (confirmation) { confirmation.remove(); confirmation = null; }
    if (moduleBoxEl) { moduleBoxEl.remove(); moduleBoxEl = null; }
  };
  const confirm = (text) => {
    clearConfirmation();
    confirmation = document.createElement("div");
    confirmation.className = "banner banner-deployed";
    confirmation.setAttribute("role", "status");
    confirmation.textContent = text;
    li.appendChild(confirmation);
  };

  const deployPanel = qrExpander(deployBtn, form, "Deploy");
  deployBtn.onclick = () => {
    if (deployPanel.isOpen) return deployPanel.close();
    clearConfirmation();
    deployPanel.open();
    renderDeployForm(form, () => report, {
      send,
      onClose: () => deployPanel.close(),
      onDeployed: (result) => {
        deployPanel.close();
        confirm(`✓ Deployed to ${result.instanceName} — Quick Report id ${result.quickReportId}.`);
        const deployedUrl = IfsLinks.ifsObjectUrl(result.baseUrl, "quickReport", { quickReportId: result.quickReportId });
        if (deployedUrl) {
          const a = document.createElement("a");
          a.href = deployedUrl; a.target = "_blank"; a.rel = "noopener"; a.className = "qr-ifs-link";
          a.textContent = " Open in IFS ↗";
          confirmation.appendChild(a);
        }
        const moduleBox = buildQrModuleBox(() => result.baseUrl);
        li.appendChild(moduleBox.element);
        moduleBoxEl = moduleBox.element;
      },
      onError: (message) => showError(message, true)
    });
  };

  let creatingModule = false;
  async function createModuleFor(deployment) {
    const projectionName = QrDeploy.quickReportProjectionName(deployment.quickReportId);
    const instance = qrInstanceFor(deployment.instanceKey);
    clearConfirmation();
    creatingModule = true;
    moduleBtn.disabled = true;
    moduleBtn.textContent = "Creating & activating…";
    const response = await createAndActivateModule(instance ? instance.baseUrl : deployment.instanceKey, projectionName);
    creatingModule = false;
    moduleBtn.textContent = "Module";
    applyState();
    if (response) confirm(`✓ Module ${projectionName} (${qrInstanceName(deployment.instanceKey)}) created & activated in the open flow.`);
    refreshProjections();
  }

  const pickerPanel = qrExpander(moduleBtn, picker, "Module");
  moduleBtn.onclick = () => {
    const deployments = qrDeployments.get(report.id) || [];
    if (deployments.length === 1) return createModuleFor(deployments[0]);
    if (pickerPanel.isOpen) return pickerPanel.close();
    picker.innerHTML = "";
    const title = document.createElement("div");
    title.className = "qr-picker-title";
    title.textContent = "Create the module for which deployment?";
    picker.appendChild(title);
    for (const deployment of deployments) {
      const option = document.createElement("button");
      option.className = "qr-pick";
      option.textContent = qrDeploymentLabel(deployment);
      option.onclick = () => { pickerPanel.close(); createModuleFor(deployment); };
      picker.appendChild(option);
    }
    pickerPanel.open();
  };

  // Deploy count + Module availability; re-run whenever history or the Designer tab changes.
  function applyState() {
    const deployments = qrDeployments.get(report.id) || [];
    pill.hidden = !deployments.length;
    pill.textContent = `Deployed (${deployments.length})`;
    pill.title = deployments.map(qrDeploymentLabel).join("\n");
    linksEl.innerHTML = "";
    for (const d of deployments) {
      const instance = qrInstanceFor(d.instanceKey);
      const url = IfsLinks.ifsObjectUrl(instance ? instance.baseUrl : d.instanceKey, "quickReport", { quickReportId: d.quickReportId });
      if (!url) continue;
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener";
      a.className = "qr-ifs-link";
      a.textContent = deployments.length > 1 ? `Open in IFS ↗ (${qrInstanceName(d.instanceKey)})` : "Open in IFS ↗";
      a.title = `Open Quick Report ${d.quickReportId} in ${qrInstanceName(d.instanceKey)}`;
      linksEl.appendChild(a);
    }
    moduleBtn.hidden = !deployments.length;
    if (!deployments.length && pickerPanel.isOpen) pickerPanel.close();
    if (creatingModule) return;
    const blocked = designerBlockReason(qrDesigner);
    moduleBtn.disabled = !!blocked;
    moduleBtn.title = blocked || "Create the Flow module for this Quick Report's projection and activate it in the open flow";
  }
  qrRows.set(report.id, { applyState });
  applyState();

  li.append(head, linksEl, preview, form, picker);
  return li;
}

/** The "QuickReports module" control: switch (off = full module), button, and the confirmation /
 *  warning text. `getBaseUrl()` returns the IFS instance to generate from ("" = none chosen).
 *  Used in the tab's own section and after a deploy. */
function buildQrModuleBox(getBaseUrl) {
  const box = document.createElement("div");
  box.className = "qr-module-box";
  const row = document.createElement("div");
  row.className = "deploy-actions";
  const label = document.createElement("label");
  label.className = "toggle";
  const input = document.createElement("input");
  input.type = "checkbox";
  const track = document.createElement("span");
  track.className = "toggle-track";
  track.innerHTML = '<span class="toggle-thumb"></span>';
  const text = document.createElement("span");
  text.className = "toggle-label";
  text.textContent = "Only include used Quick Reports";
  label.append(input, track, text, infoTip("Off: the module contains every public Quick Report of the instance. On: Buddy first scans all flows of your Flow organisation (same scan as \"Scan org for Quick Report usage\") and keeps only the Quick Reports that flows actually call; the others are removed from the module code."));
  const button = document.createElement("button");
  button.className = "btn-primary";
  button.textContent = "Create/update QuickReports module";
  row.append(button);
  const message = document.createElement("div");
  box.append(label, row, message);

  const show = (kind, content) => {
    message.innerHTML = "";
    if (!content) return;
    const el = document.createElement("div");
    el.className = `banner banner-${kind}`;
    el.setAttribute("role", "status");
    el.append(...(Array.isArray(content) ? content : [content]));
    message.appendChild(el);
  };
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  let running = false;

  /** The ids of the Quick Reports the org's flows call: the same scan as the usage page. */
  async function scanUsedIds() {
    const org = await send({ type: "QR_ORG" });
    if (!org.ok) throw new Error(org.error || "Could not find your Flow organisation");
    const call = async (message) => { const r = await send({ ...message, masterPassword: "" }); if (!r.ok) throw new Error(r.error || "Flow read failed"); return r; };
    const result = await QrUsage.runScan({
      flow: {
        listPackages: async () => (await call({ type: "FT_PACKAGES", orgId: org.orgId })).packages,
        listAssets: async (pkg) => (await call({ type: "MC_ASSETS", orgId: org.orgId, packageId: pkg })).assets,
        readFlowIds: async (itemId) => (await call({ type: "QRU_FLOW", orgId: org.orgId, itemId })).ids
      },
      readNames: null,
      onProgress: (step, current, total) => { button.textContent = `Scanning flows… (${step} ${current}/${total})`; }
    });
    if (result.errors.length) throw new Error(`${result.errors.length} flow(s) could not be read, so the list of used Quick Reports would be incomplete. Nothing was changed. First error: ${result.errors[0]}`);
    return result.reports.map((r) => r.id);
  }

  async function run(onlyUsed, force, baseUrl, knownIds) {
    running = true;
    applyState();
    let usedIds = knownIds || null;
    if (onlyUsed && !usedIds) {
      button.textContent = "Scanning flows…";
      try { usedIds = await scanUsedIds(); } catch (e) { running = false; button.textContent = "Create/update QuickReports module"; applyState(); return showError(e.message, true); }
    }
    button.textContent = "Creating module…";
    const response = await actionOrShowError({ type: "QR_PROJECTION_MODULE", baseUrl, usedIds: onlyUsed ? usedIds : null, force, masterPassword: masterPasswordOf() });
    running = false;
    button.textContent = "Create/update QuickReports module";
    applyState();
    if (!response) return show("", "");
    const r = response.result;
    if (r.status === "needsConfirmation") {
      const warn = document.createElement("span");
      warn.textContent = `The module you are creating will contain ${plural(r.total, "Quick Report")} (${r.added} new), while the current version contains ${r.existing}. ${plural(r.lost.length, "Quick Report")} would be lost from the module. Do you want to proceed, or create the full module instead?`;
      const proceed = document.createElement("button");
      proceed.className = "btn-primary";
      proceed.textContent = "Proceed";
      proceed.onclick = () => { show("", ""); run(onlyUsed, true, baseUrl, usedIds); };
      const full = document.createElement("button");
      full.textContent = "Create full module";
      full.onclick = () => { input.checked = false; show("", ""); run(false, false, baseUrl); };
      const cancel = document.createElement("button");
      cancel.className = "btn-ghost";
      cancel.textContent = "Cancel";
      cancel.onclick = () => show("", "");
      return show("warning", [warn, proceed, full, cancel]);
    }
    show("deployed", `✓ Module QuickReports committed in Flow with ${plural(r.total, "Quick Report")} (${r.added} new).`);
  }

  button.onclick = async () => {
    const baseUrl = getBaseUrl();
    if (!baseUrl) return showError("Choose an IFS instance first.", true);
    show("", "");
    // Must run inside the click's user gesture, before any other await.
    const origin = new URL(baseUrl).origin;
    const granted = await new Promise((resolve) => chrome.permissions.request({ origins: [origin + "/*"] }, resolve));
    if (!granted) return showError(`Permission for ${origin} was not granted — can't read its QuickReports projection.`, true);
    run(input.checked, false, baseUrl);
  };

  function applyState() {
    const blocked = !qrDesigner.hasFlowToken ? "No Flow session yet — open the Flow Designer and click anywhere in it once." : !getBaseUrl() ? "Choose an IFS instance first." : "";
    button.disabled = running || !!blocked;
    button.title = blocked || "Creates or updates the QuickReports module at the top level of your Flow organisation";
  }
  const handle = { applyState, element: box };
  qrModuleBoxes.add(handle);
  applyState();
  return handle;
}

async function fillQrModuleInstances() {
  const select = document.getElementById("qrModuleInstance");
  const previous = select.value;
  const response = await send({ type: "LIST_INSTANCES" });
  select.innerHTML = "";
  if (!response.ok) return;
  const instances = response.instances.slice().sort((a, b) => a.name.localeCompare(b.name));
  select.hidden = !instances.length;
  select.append(new Option("Choose an IFS instance…", ""));
  for (const instance of instances) select.append(new Option(instance.name, instance.baseUrl));
  if (instances.some((i) => i.baseUrl === previous)) select.value = previous;
  for (const handle of qrModuleBoxes) handle.applyState();
}

async function refreshQrDeployments() {
  const response = await send({ type: "QR_HISTORY" });
  if (!response.ok) return;
  qrDeployments = new Map();
  for (const d of response.deployments) {
    if (!qrDeployments.has(d.qrId)) qrDeployments.set(d.qrId, []);
    qrDeployments.get(d.qrId).push(d);
  }
  for (const row of qrRows.values()) row.applyState();
}

/** Called from the side panel's 5s poll: keeps the Module buttons in step with the Designer tab. */
async function refreshQrDesignerState() {
  if (!qrRows.size && !qrModuleBoxes.size) return;
  const response = await send({ type: "GET_DESIGNER_STATUS" });
  if (!response.ok) return;
  qrDesigner = { open: response.open, hasFlowToken: response.hasFlowToken };
  for (const row of qrRows.values()) row.applyState();
  for (const handle of qrModuleBoxes) {
    if (handle.element.isConnected) handle.applyState(); else qrModuleBoxes.delete(handle);
  }
}

async function refreshQuickReports() {
  qrLoadedOnce = true;
  const hint = document.getElementById("qrSetupHint");
  const settings = await send({ type: "QR_GET_SETTINGS" });
  if (!settings.ok) return showError(settings.error, true);
  if (!settings.hasToken) {
    hint.textContent = "Add a GitHub token in Basic Data to see your Quick Reports.";
    hint.hidden = false;
    setQrReports([], null);
    return;
  }
  hint.hidden = true;

  const cached = await send({ type: "QR_LIST_CACHED" });
  if (cached.ok && cached.cache) setQrReports(cached.cache.reports, cached.cache.fetchedAt);

  const btn = document.getElementById("qrRefreshBtn");
  btn.disabled = true;
  btn.textContent = "Refreshing…";
  const fresh = await sendOrShowError({ type: "QR_LIST", masterPassword: masterPasswordOf() }, true);
  btn.disabled = false;
  btn.textContent = "Refresh";
  if (fresh) setQrReports(fresh.reports, fresh.fetchedAt);
}

function initQuickReportsPanel() {
  // The editor tab writes qrCache after a save; pick it up so Deploy never sends stale SQL.
  chrome.storage.onChanged.addListener((changes, area) => {
    const change = area === "local" && changes.qrCache;
    if (change && change.newValue && change.newValue.reports) setQrReports(change.newValue.reports, change.newValue.fetchedAt);
    // Every finished deploy (side panel or editor tab) lands in qrDeployments.
    if (area === "local" && changes.qrDeployments) refreshQrDeployments();
    // Folders edited on another PC (sync) or the editor tab.
    if (changes[QrFolders.KEY] && changes[QrFolders.KEY].newValue) {
      qrFolderState = QrFolders.normalize(changes[QrFolders.KEY].newValue);
      qrRenderedSig = null;
      renderQrList();
    }
  });
  refreshQrDeployments();
  refreshQrDesignerState();
  QrFolders.load().then((state) => { qrFolderState = state; qrRenderedSig = null; renderQrList(); });
  initQrFolderCreate();
  document.getElementById("qrSearch").addEventListener("input", renderQrList);
  document.getElementById("qrRefreshBtn").addEventListener("click", () => { clearError(true); refreshQuickReports(); });
  const topBox = buildQrModuleBox(() => document.getElementById("qrModuleInstance").value);
  document.getElementById("qrModuleBox").appendChild(topBox.element);
  document.getElementById("qrModuleInstance").onchange = () => topBox.applyState();
  fillQrModuleInstances();
  document.getElementById("qrNewBtn").addEventListener("click", () => openQrEditor(null));
}
