// Results page of "Scan org for Quick Report usage": one row per Quick Report that flows call.
const params = new URLSearchParams(location.search);
const sel = { orgId: params.get("orgId"), baseUrl: params.get("baseUrl") || "", flowId: params.get("flowId") || "" };
const el = (id) => document.getElementById(id);
const KEY = sel.flowId ? `qrUsage:${sel.orgId}:${sel.flowId}` : `qrUsage:${sel.orgId}`;
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

const detailCache = new Map();
const expanded = new Set();

/** Click a row to show the Quick Report's SQL and fields below it (read from IFS on first open). */
function makeExpandable(tr, r) {
  tr.classList.add("qu-row");
  tr.tabIndex = 0;
  tr.setAttribute("aria-expanded", "false");
  const first = tr.firstElementChild;
  const chevron = document.createElement("span");
  chevron.className = "qu-chevron";
  chevron.textContent = "▸";
  first.prepend(chevron);
  let detailRow = null;
  const toggle = async () => {
    if (detailRow) {
      detailRow.remove(); detailRow = null; expanded.delete(r.id);
      tr.setAttribute("aria-expanded", "false"); chevron.textContent = "▸";
      return;
    }
    expanded.add(r.id);
    tr.setAttribute("aria-expanded", "true"); chevron.textContent = "▾";
    detailRow = document.createElement("tr");
    detailRow.className = "qu-detail-row";
    const td = document.createElement("td");
    td.colSpan = 4;
    detailRow.append(td);
    tr.after(detailRow);
    renderDetail(td, r, null);
    try {
      if (!detailCache.has(r.id)) detailCache.set(r.id, (await call({ type: "QRU_DETAIL", baseUrl: sel.baseUrl, id: r.id })).details);
      if (detailRow) renderDetail(td, r, detailCache.get(r.id));
    } catch (e) {
      if (detailRow) renderDetail(td, r, null, e.message);
    }
  };
  tr.addEventListener("click", (e) => { if (!e.target.closest("a")) toggle(); });
  tr.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === tr) { e.preventDefault(); toggle(); } });
  if (expanded.has(r.id)) toggle();
}

function renderDetail(td, r, d, error) {
  td.innerHTML = "";
  const box = document.createElement("div");
  box.className = "qu-detail";
  if (error) { box.textContent = `Could not read the Quick Report from IFS: ${error}`; box.classList.add("qu-detail-error"); td.append(box); return; }
  if (!d) { box.textContent = "Reading from IFS…"; box.classList.add("list-count"); td.append(box); return; }
  const head = document.createElement("div");
  head.className = "qu-detail-head";
  const title = document.createElement("h3");
  title.textContent = "SQL";
  const copy = document.createElement("button");
  copy.textContent = "Copy";
  copy.disabled = !d.sql;
  copy.onclick = async () => { await navigator.clipboard.writeText(d.sql); copy.textContent = "Copied"; setTimeout(() => (copy.textContent = "Copy"), 1500); };
  const edit = document.createElement("button");
  edit.className = "btn-primary";
  edit.textContent = "Edit";
  edit.title = "Open in the Quick Report editor with the name, SQL and this IFS instance filled in";
  edit.onclick = () => {
    const q = new URLSearchParams({ ifsBaseUrl: sel.baseUrl, ifsId: r.id });
    chrome.tabs.create({ url: chrome.runtime.getURL(`qr-editor.html?${q}`) });
  };
  const actions = document.createElement("div");
  actions.className = "qu-detail-actions";
  actions.append(copy, edit);
  head.append(title, actions);
  const sql = document.createElement("pre");
  sql.className = "qu-sql";
  sql.textContent = d.sql || "No SQL stored on this Quick Report.";
  box.append(head, sql);
  if (d.fields.length) {
    const grid = document.createElement("dl");
    grid.className = "qu-fields";
    for (const [k, v] of d.fields) {
      const dt = document.createElement("dt"); dt.textContent = k;
      const dd = document.createElement("dd"); dd.textContent = v;
      grid.append(dt, dd);
    }
    box.append(grid);
  }
  td.append(box);
}

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
    const ifsCell = document.createElement("td");
    const url = sel.baseUrl && IfsLinks.ifsObjectUrl(sel.baseUrl, "quickReport", { quickReportId: r.id });
    if (url) {
      const a = document.createElement("a");
      a.href = url; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Open in IFS ↗"; a.className = "qu-ifs-link";
      a.title = "Open this Quick Report in the IFS web client";
      ifsCell.append(a);
    } else { ifsCell.textContent = "—"; ifsCell.title = "Choose an IFS instance above to get links"; ifsCell.className = "qu-noname"; }
    const cells = [r.functionName, r.id].map((t) => { const td = document.createElement("td"); td.textContent = t; return td; });
    const flowCell = document.createElement("td");
    flowCell.append(flows);
    tr.append(cells[0], cells[1], name, ifsCell, flowCell);
    body.append(tr);
    if (sel.baseUrl) makeExpandable(tr, r);
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
      onlyFlowId: sel.flowId || null,
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

/** The instance select on the result card: fills the IFS links and the missing names without a rescan. */
async function setupInstancePicker() {
  const select = el("quInstance");
  const response = await send({ type: "LIST_INSTANCES" });
  select.innerHTML = "";
  select.append(new Option("Choose an IFS instance…", ""));
  const list = response.ok ? response.instances.slice().sort((a, b) => a.name.localeCompare(b.name)) : [];
  for (const i of list) select.append(new Option(i.name, i.baseUrl));
  el("quInstanceField").hidden = !list.length;
  select.value = list.some((i) => i.baseUrl === sel.baseUrl) ? sel.baseUrl : "";
  select.onchange = async () => {
    sel.baseUrl = select.value;
    if (sel.baseUrl && result && result.reports.some((r) => !r.name)) {
      try {
        const names = (await call({ type: "QRU_NAMES", baseUrl: sel.baseUrl, ids: result.reports.map((r) => r.id) })).names;
        for (const r of result.reports) if (!r.name) r.name = names[r.id] || "";
      } catch (e) { showError(`Names could not be read from IFS: ${e.message}`, true); }
    }
    el("quSubtitle").textContent = sel.baseUrl ? `Names and links from ${select.selectedOptions[0].textContent}` : "Without Quick Report names";
    renderTable();
  };
}

async function main() {
  if (!sel.orgId) return showError("No organisation given — start the scan from the side panel's Quick Reports tab.", true);
  const org = params.get("org") || sel.orgId;
  el("quTitle").textContent = `Quick Report usage · ${org}${sel.flowId ? " · current flow" : ""}`;
  document.title = `Quick Report usage · ${org}`;
  el("quSubtitle").textContent = sel.baseUrl ? sel.baseUrl : "Without Quick Report names";
  send({ type: "LIST_INSTANCES" }).then((response) => {
    const instance = response.ok && response.instances.find((i) => i.baseUrl === sel.baseUrl);
    if (instance) el("quSubtitle").textContent = `Names from ${instance.name}`;
  });
  el("quRescanBtn").onclick = scan;
  await setupInstancePicker();
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
