let qrReports = [];
let qrSearch = null;
let qrLoadedOnce = false;
let qrRenderedSig = null; // identity of what the list currently shows; unchanged → keep the DOM (and any open panel)
let qrOpenPanel = null; // the one expanded panel in the list (deploy form or module picker): { close() }
let qrDeployments = new Map(); // report id -> its deployments, newest first (one per instance)
let qrDesigner = { open: false, hasFlowToken: false };
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

function renderQrList() {
  const shown = qrSearch ? qrSearch.search(document.getElementById("qrSearch").value) : [];
  document.getElementById("qrCount").textContent = qrReports.length ? `${shown.length} of ${qrReports.length}` : "";
  const list = document.getElementById("qrList");
  const sig = JSON.stringify(shown.map((r) => [r.id, r.name, r.sqlSha, r.jsonSha]));
  if (sig === qrRenderedSig) return;
  qrRenderedSig = sig;
  qrOpenPanel = null;
  qrRows.clear();
  list.innerHTML = "";
  for (const report of shown) list.appendChild(buildQrRow(report));
}

function buildQrRow(report) {
  const li = document.createElement("li");
  li.className = "qr-item";

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
    moduleBtn.hidden = !deployments.length;
    if (!deployments.length && pickerPanel.isOpen) pickerPanel.close();
    if (creatingModule) return;
    const blocked = designerBlockReason(qrDesigner);
    moduleBtn.disabled = !!blocked;
    moduleBtn.title = blocked || "Create the Flow module for this Quick Report's projection and activate it in the open flow";
  }
  qrRows.set(report.id, { applyState });
  applyState();

  li.append(head, preview, form, picker);
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
  text.textContent = "Only include created Quick Reports";
  label.append(input, track, text, infoTip("Off: the module contains every public Quick Report of the instance. On: only the Quick Reports you deployed to this instance with NovacuraBuddy are kept; the others are removed from the module code."));
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

  async function run(onlyCreated, force, baseUrl) {
    running = true;
    applyState();
    button.textContent = "Creating module…";
    const response = await actionOrShowError({ type: "QR_PROJECTION_MODULE", baseUrl, onlyCreated, force, masterPassword: masterPasswordOf() });
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
      proceed.onclick = () => { show("", ""); run(onlyCreated, true, baseUrl); };
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
  });
  refreshQrDeployments();
  refreshQrDesignerState();
  document.getElementById("qrSearch").addEventListener("input", renderQrList);
  document.getElementById("qrRefreshBtn").addEventListener("click", () => { clearError(true); refreshQuickReports(); });
  const topBox = buildQrModuleBox(() => document.getElementById("qrModuleInstance").value);
  document.getElementById("qrModuleBox").appendChild(topBox.element);
  document.getElementById("qrModuleInstance").onchange = () => topBox.applyState();
  fillQrModuleInstances();
  document.getElementById("qrNewBtn").addEventListener("click", () => openQrEditor(null));
}
