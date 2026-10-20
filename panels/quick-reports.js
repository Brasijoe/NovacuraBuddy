let qrReports = [];
let qrSearch = null;
let qrLoadedOnce = false;
let qrRenderedSig = null; // identity of what the list currently shows; unchanged → keep the DOM (and any open panel)
let qrOpenPanel = null; // the one expanded panel in the list (deploy form or module picker): { close() }
let qrDeployments = new Map(); // report id -> its deployments, newest first (one per instance)
let qrDesigner = { open: false, hasFlowToken: false };
const qrRows = new Map(); // report id -> { applyState() } for the rows currently shown

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
  const clearConfirmation = () => { if (confirmation) { confirmation.remove(); confirmation = null; } };
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
  if (!qrRows.size) return;
  const response = await send({ type: "GET_DESIGNER_STATUS" });
  if (!response.ok) return;
  qrDesigner = { open: response.open, hasFlowToken: response.hasFlowToken };
  for (const row of qrRows.values()) row.applyState();
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
  document.getElementById("qrNewBtn").addEventListener("click", () => openQrEditor(null));
}
