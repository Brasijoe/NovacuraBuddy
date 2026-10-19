let qrReports = [];
let qrSearch = null;
let qrLoadedOnce = false;
let qrRenderedSig = null; // identity of what the list currently shows; unchanged → keep the DOM (and any open deploy form)
let qrOpenForm = null; // the one row whose deploy form is expanded: { close() }

function openQrEditor(id) {
  chrome.tabs.create({ url: chrome.runtime.getURL("qr-editor.html" + (id ? `?id=${encodeURIComponent(id)}` : "")) });
}

function setQrReports(reports, fetchedAt) {
  qrReports = reports;
  qrSearch = QrSearch.createQrSearch(reports, Fuse);
  document.getElementById("qrRefreshed").textContent = fetchedAt ? `Last refreshed ${new Date(fetchedAt).toLocaleString()}` : "";
  renderQrList();
}

function renderQrList() {
  const shown = qrSearch ? qrSearch.search(document.getElementById("qrSearch").value) : [];
  document.getElementById("qrCount").textContent = qrReports.length ? `${shown.length} of ${qrReports.length}` : "";
  const list = document.getElementById("qrList");
  const sig = JSON.stringify(shown.map((r) => [r.id, r.name, r.sqlSha, r.jsonSha]));
  if (sig === qrRenderedSig) return;
  qrRenderedSig = sig;
  qrOpenForm = null;
  list.innerHTML = "";
  for (const report of shown) {
    const li = document.createElement("li");
    li.className = "qr-item";

    const head = document.createElement("div");
    head.className = "qr-head";
    const name = document.createElement("span");
    name.className = "qr-name";
    name.textContent = report.name;
    const deployBtn = document.createElement("button");
    deployBtn.textContent = "Deploy";
    const editBtn = document.createElement("button");
    editBtn.className = "btn-ghost";
    editBtn.textContent = "Edit";
    editBtn.onclick = () => openQrEditor(report.id);
    head.append(name, deployBtn, editBtn);

    const preview = document.createElement("div");
    preview.className = "qr-preview";
    preview.textContent = report.content.replace(/\s+/g, " ").trim().slice(0, 160);
    preview.title = report.content;

    const form = document.createElement("div");
    form.hidden = true;
    let deployed = null; // green "Deployed …" line left on the row after the form collapses
    const row = {
      close() {
        form.hidden = true;
        deployBtn.textContent = "Deploy";
        if (qrOpenForm === row) qrOpenForm = null;
      }
    };
    deployBtn.onclick = () => {
      if (!form.hidden) return row.close();
      if (qrOpenForm) qrOpenForm.close();
      if (deployed) { deployed.remove(); deployed = null; }
      form.hidden = false;
      deployBtn.textContent = "Close";
      qrOpenForm = row;
      renderDeployForm(form, () => report, {
        send,
        onClose: () => row.close(),
        onDeployed: (result) => {
          row.close();
          deployed = document.createElement("div");
          deployed.className = "banner banner-deployed";
          deployed.setAttribute("role", "status");
          deployed.textContent = `✓ Deployed to ${result.instanceName} — Quick Report id ${result.quickReportId}.`;
          li.appendChild(deployed);
        },
        onError: (message) => showError(message, true)
      });
    };

    li.append(head, preview, form);
    list.appendChild(li);
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
  });
  document.getElementById("qrSearch").addEventListener("input", renderQrList);
  document.getElementById("qrRefreshBtn").addEventListener("click", () => { clearError(true); refreshQuickReports(); });
  document.getElementById("qrNewBtn").addEventListener("click", () => openQrEditor(null));
}
