// Results page of "Scan org for Quick Report usage": one row per Quick Report that flows call.
const params = new URLSearchParams(location.search);
const sel = { orgId: params.get("orgId"), baseUrl: params.get("baseUrl") || "" };
const el = (id) => document.getElementById(id);
const KEY = `qrUsage:${sel.orgId}`;
let result = null;

async function call(message) {
  const response = await send({ ...message, masterPassword: "" });
  if (!response.ok) throw new Error(explainLocked(response));
  return response;
}

const stepState = {};
function renderSteps() {
  const list = el("quSteps");
  list.innerHTML = "";
  for (const step of QrUsage.SCAN_STEPS) {
    const st = stepState[step.id] || { state: "todo" };
    const li = document.createElement("li");
    li.className = `mc-step mc-step-${st.state}`;
    const mark = document.createElement("span");
    mark.className = "mc-step-mark";
    mark.textContent = st.state === "done" ? "✓" : "";
    const label = document.createElement("span");
    label.textContent = step.label;
    const count = document.createElement("span");
    count.className = "list-count";
    count.textContent = st.total > 1 ? `${st.current}/${st.total}` : "";
    li.append(mark, label, count);
    list.append(li);
  }
}

function onStep(id, current, total) {
  const ids = QrUsage.SCAN_STEPS.map((s) => s.id);
  for (const prev of ids.slice(0, ids.indexOf(id))) if (stepState[prev]) stepState[prev].state = "done";
  stepState[id] = { current, total, state: current >= total ? "done" : "running" };
  el("quProgressFill").style.width = `${Math.round(((ids.indexOf(id) + (total ? current / total : 0)) / ids.length) * 100)}%`;
  renderSteps();
}

const designerUrl = (flowId) => `https://build.novacura.com/admin/design/designer/organizations/${sel.orgId}/items/${flowId}`;

function renderTable() {
  const body = el("quBody");
  body.innerHTML = "";
  const q = el("quFilter").value.trim().toLowerCase();
  const rows = result.reports.filter((r) => !q || [r.functionName, r.id, r.name, ...r.flows.map((f) => f.name)].some((t) => String(t).toLowerCase().includes(q)));
  el("quEmpty").hidden = rows.length > 0;
  el("quEmpty").textContent = result.reports.length ? "No Quick Report matches the filter." : "No flow in this organisation calls a Quick Report.";
  el("quTable").hidden = rows.length === 0;
  for (const r of rows) {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    if (r.name) name.textContent = r.name;
    else { name.textContent = sel.baseUrl ? "Not found in IFS" : "—"; name.className = "qu-noname"; }
    const flows = document.createElement("ul");
    flows.className = "qu-flows";
    for (const f of r.flows) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = designerUrl(f.flowId);
      a.textContent = f.name;
      a.title = "Open in the Flow Designer";
      a.onclick = (e) => { e.preventDefault(); send({ type: "MC_OPEN_FLOW", orgId: sel.orgId, flowId: f.flowId }); };
      const pkg = document.createElement("span");
      pkg.className = "qu-pkg";
      pkg.textContent = f.packageName;
      li.append(a, pkg);
      flows.append(li);
    }
    const cells = [r.functionName, r.id].map((t) => { const td = document.createElement("td"); td.textContent = t; return td; });
    const flowCell = document.createElement("td");
    flowCell.append(flows);
    tr.append(cells[0], cells[1], name, flowCell);
    body.append(tr);
  }
}

function showResult(r) {
  result = r;
  if (!r) {
    el("quSummary").textContent = "No scan yet — press Rescan.";
    return;
  }
  const flows = new Set(r.reports.flatMap((x) => x.flows.map((f) => f.flowId))).size;
  el("quSummary").textContent = `Scanned ${r.flowCount} flow(s) on ${new Date(r.scannedAt).toLocaleString()}: ${r.reports.length} Quick Report(s) used in ${flows} flow(s).`;
  el("quResultCard").hidden = false;
  el("quErrors").hidden = !r.errors.length;
  el("quErrorsSummary").textContent = `${r.errors.length} item(s) could not be read`;
  el("quErrorList").innerHTML = "";
  for (const e of r.errors) { const li = document.createElement("li"); li.textContent = e; el("quErrorList").append(li); }
  renderTable();
}

async function scan() {
  const btn = el("quRescanBtn");
  btn.disabled = true;
  clearError(true);
  for (const k of Object.keys(stepState)) delete stepState[k];
  renderSteps();
  el("quProgress").hidden = false;
  el("quProgressFill").style.width = "0%";
  try {
    const r = await QrUsage.runScan({
      flow: {
        listPackages: async () => (await call({ type: "FT_PACKAGES", orgId: sel.orgId })).packages,
        listAssets: async (pkg) => (await call({ type: "MC_ASSETS", orgId: sel.orgId, packageId: pkg })).assets,
        readFlowIds: async (itemId) => (await call({ type: "QRU_FLOW", orgId: sel.orgId, itemId })).ids
      },
      readNames: sel.baseUrl ? async (ids) => (await call({ type: "QRU_NAMES", baseUrl: sel.baseUrl, ids })).names : null,
      onProgress: onStep
    });
    for (const s of QrUsage.SCAN_STEPS) stepState[s.id] = { ...(stepState[s.id] || {}), state: "done" };
    el("quProgressFill").style.width = "100%";
    renderSteps();
    await chrome.storage.local.set({ [KEY]: r });
    showResult(r);
  } catch (e) {
    showError(`Scan failed: ${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

async function main() {
  if (!sel.orgId) return showError("No organisation given — start the scan from the side panel's Quick Reports tab.", true);
  const org = params.get("org") || sel.orgId;
  el("quTitle").textContent = `Quick Report usage · ${org}`;
  document.title = `Quick Report usage · ${org}`;
  el("quSubtitle").textContent = sel.baseUrl ? sel.baseUrl : "Without Quick Report names";
  send({ type: "LIST_INSTANCES" }).then((response) => {
    const instance = response.ok && response.instances.find((i) => i.baseUrl === sel.baseUrl);
    if (instance) el("quSubtitle").textContent = `Names from ${instance.name}`;
  });
  el("quRescanBtn").onclick = scan;
  el("quFilter").addEventListener("input", () => result && renderTable());
  renderSteps();
  const { [KEY]: last } = await chrome.storage.local.get(KEY);
  if (last) showResult(last);
  if (params.get("scan") === "1") {
    params.delete("scan");
    history.replaceState(null, "", `?${params}`);
    return scan();
  }
  if (!last) showResult(null);
}

main();
