// Full-page Quick Report editor. Shares panels/common.js (send/showError/showNotice) and the
// deploy form with the side panel; all GitHub/IFS work happens in the background worker.
const els = {
  title: document.getElementById("editorTitle"),
  name: document.getElementById("qrName"),
  tags: document.getElementById("qrTags"),
  sql: document.getElementById("qrSql"),
  save: document.getElementById("saveBtn"),
  beautify: document.getElementById("beautifyBtn"),
  deployHint: document.getElementById("deployHint"),
  deployForm: document.getElementById("deployForm"),
  history: document.querySelector("#historyTable tbody"),
  byInstanceSelect: document.getElementById("byInstanceSelect"),
  byInstance: document.querySelector("#byInstanceTable tbody")
};

let editing = { id: null, sqlSha: null, jsonSha: null, createdAt: null };
let dirty = false;
let instancesByUrl = {};
let reportNames = {};

const fmt = (iso) => new Date(iso).toLocaleString();
const instanceName = (key) => (instancesByUrl[key] ? instancesByUrl[key].name : key);
const parseTags = () => els.tags.value.split(",").map((t) => t.trim()).filter(Boolean);

function explain(response) {
  return response.needsMasterPassword
    ? "Saved credentials are locked — unlock them in the NovacuraBuddy side panel, then try again."
    : response.error;
}

function fillTable(tbody, rows) {
  tbody.innerHTML = "";
  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.className = "empty-state";
    td.textContent = "Nothing deployed yet.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const cells of rows) {
    const tr = document.createElement("tr");
    for (const cell of cells) {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

async function refreshHistory() {
  if (!editing.id) return fillTable(els.history, []);
  const response = await send({ type: "QR_HISTORY", qrId: editing.id });
  if (!response.ok) return showError(response.error, true);
  fillTable(els.history, response.deployments.map((d) => [instanceName(d.instanceKey), d.quickReportId, fmt(d.deployedAt)]));
}

async function refreshByInstance() {
  if (!els.byInstanceSelect.value) return fillTable(els.byInstance, []);
  const response = await send({ type: "QR_HISTORY", baseUrl: els.byInstanceSelect.value });
  if (!response.ok) return showError(response.error, true);
  fillTable(els.byInstance, response.deployments.map((d) => [reportNames[d.qrId] || d.qrId, d.quickReportId, fmt(d.deployedAt)]));
}

function renderDeploy() {
  els.deployHint.hidden = !!editing.id;
  if (!editing.id) { els.deployForm.innerHTML = ""; return; }
  renderDeployForm(els.deployForm, () => (dirty ? null : { id: editing.id, name: els.name.value.trim(), content: els.sql.value }), {
    send,
    onDeployed: (result) => {
      showNotice(`Deployed — Quick Report id ${result.quickReportId} on ${instanceName(result.baseUrl)}.`);
      refreshHistory();
      refreshByInstance();
    },
    onError: (message) => showError(message, true)
  });
}

function applyReport(report) {
  editing = { id: report.id, sqlSha: report.sqlSha, jsonSha: report.jsonSha, createdAt: report.createdAt };
  reportNames[report.id] = report.name;
  els.name.value = report.name;
  els.tags.value = (report.tags || []).join(", ");
  els.sql.value = report.content;
  els.title.textContent = report.name;
  document.title = `${report.name} — Quick Report`;
  window.history.replaceState(null, "", `?id=${encodeURIComponent(report.id)}`);
  dirty = false;
  renderDeploy();
  refreshHistory();
}

async function loadInstances() {
  const response = await send({ type: "LIST_INSTANCES" });
  if (!response.ok) return showError(response.error, true);
  instancesByUrl = Object.fromEntries(response.instances.map((i) => [i.baseUrl, i]));
  els.byInstanceSelect.innerHTML = "";
  els.byInstanceSelect.append(new Option("Choose an IFS instance…", ""));
  for (const i of response.instances) els.byInstanceSelect.append(new Option(i.name, i.baseUrl));
}

async function loadReports() {
  const id = new URLSearchParams(location.search).get("id");
  let reports;
  const response = await send({ type: "QR_LIST", masterPassword: "" });
  if (response.ok) {
    reports = response.reports;
  } else {
    const cached = await send({ type: "QR_LIST_CACHED" });
    reports = cached.ok && cached.cache ? cached.cache.reports : [];
    showError(`${explain(response)} — showing the last cached copy; saving may be refused until the list loads.`, true);
  }
  reportNames = Object.fromEntries(reports.map((r) => [r.id, r.name]));
  if (!id) return renderDeploy();
  const report = reports.find((r) => r.id === id);
  if (!report) return showError(`Quick Report "${id}" wasn't found in your folder.`, true);
  applyReport(report);
}

els.save.addEventListener("click", async () => {
  const name = els.name.value.trim();
  if (!name) return showError("Give the report a name first.", true);
  els.save.disabled = true;
  els.save.textContent = "Saving…";
  const response = await send({
    type: "QR_SAVE",
    masterPassword: "",
    report: { id: editing.id, name, content: els.sql.value, tags: parseTags(), sqlSha: editing.sqlSha, jsonSha: editing.jsonSha, createdAt: editing.createdAt }
  });
  els.save.disabled = false;
  els.save.textContent = "Save";
  if (!response.ok) return showError(explain(response), true);
  clearError(true);
  applyReport(response.report);
  showNotice("Saved to GitHub.");
});

els.beautify.addEventListener("click", () => {
  try {
    els.sql.value = sqlFormatter.format(els.sql.value, { language: "plsql" });
    dirty = true;
  } catch (e) {
    showError(`Beautify couldn't parse this SQL: ${e.message}`, true);
  }
});

for (const field of [els.name, els.tags, els.sql]) field.addEventListener("input", () => { dirty = true; });
els.byInstanceSelect.addEventListener("change", refreshByInstance);
window.addEventListener("beforeunload", (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ""; }
});

(async () => {
  await loadInstances();
  await loadReports();
})();
