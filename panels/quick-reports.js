let qrReports = [];
let qrSearch = null;
let qrLoadedOnce = false;
let qrRenderedSig = null; // identity of what the list currently shows; unchanged → keep the DOM (and any open deploy form)

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
    deployBtn.onclick = () => {
      form.hidden = !form.hidden;
      if (!form.hidden) {
        renderDeployForm(form, () => report, {
          send,
          onDeployed: (result) => showNotice(`Deployed "${report.name}" — Quick Report id ${result.quickReportId}.`),
          onError: (message) => showError(message, true)
        });
      }
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
