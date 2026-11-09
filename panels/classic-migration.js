/* Flow Classic Migration tab: load a Classic export (.wap / .flow), map its connectors to Connect
 * connectors, pick organisation + package (+ IFS instance for OData steps) and create the flows in
 * Flow Connect. The work is done by lib/classic-migration/service.js (an ES module, imported on
 * first use); this panel only drives it. Flows are saved, not committed (see the service header). */

let cmService = null;
let cmDecoded = null; // { flows, summaries, dependencyOrder, ... }
let cmRest = null;
let cmUserId = "";
let cmOrgConnectors = []; // [{ id, name, type }] of the picked organisation
let cmRestProjects = {}; // Classic connector name -> { operations }
let cmBusy = false;
let cmLoadedOnce = false;
const cmEl = (id) => document.getElementById(id);
const CM_MAPPING_KEY = "cmConnectorMapping"; // { [orgId]: { [classicConnectorName]: connectorId } }
const CM_RUNAS_KEY = "cmRunAsUser"; // { [orgId]: { [classicConnectorName]: boolean } }
const CM_IFS10_TYPE = "Database.IFS10";

async function cmLoadService() {
  if (!cmService) cmService = await import(chrome.runtime.getURL("lib/classic-migration/service.js"));
  return cmService;
}

function cmHint(text) {
  const el = cmEl("cmFileHint");
  el.textContent = text || "";
  el.hidden = !text;
}

async function cmFlowSession() {
  const response = await send({ type: "CM_CONTEXT" });
  if (!response.ok) {
    cmRest = null;
    throw new Error(response.error || "No Flow session.");
  }
  const svc = await cmLoadService();
  cmRest = svc.createRest(response.token);
  cmUserId = response.userId;
}

async function cmGetJson(path, what) {
  const res = await cmRest.get(path);
  if (!res.ok) throw new Error(`Could not load ${what} (${res.status}).`);
  return res.json();
}

/** Greys out the target selection and shows the session chip, depending on whether a Flow token exists. */
function cmSetSession(ok, message) {
  const chip = cmEl("cmSession");
  chip.className = `ft-chip ft-chip-${ok ? "ok" : "warn"}`;
  chip.textContent = ok ? "Flow session found" : "No Flow session";
  chip.title = ok ? "" : message || "";
  cmEl("cmOrg").disabled = !ok;
  cmEl("cmPackage").disabled = !ok;
  cmEl("cmTargetCard").classList.toggle("is-disabled", !ok);
  if (!ok) {
    cmEl("cmOrg").innerHTML = "";
    cmEl("cmPackage").innerHTML = "";
    cmEl("cmOrg").append(new Option("Open Flow in a tab, then Refresh", ""));
    cmOrgConnectors = [];
    if (cmDecoded) cmRenderConnectors();
  }
  cmUpdateRun();
}

/** Reloads everything this tab reads: Flow session, organisations, packages, connectors and IFS instances. */
async function cmRefresh() {
  const btn = cmEl("cmRefreshBtn");
  btn.disabled = true;
  try {
    await cmFillInstances(cmEl("cmInstance").value);
    try {
      await cmFlowSession();
      cmSetSession(true);
      await cmFillOrgs(cmEl("cmOrg").value, cmEl("cmPackage").value);
    } catch (e) {
      cmSetSession(false, e.message);
    }
  } finally {
    btn.disabled = false;
  }
}

function cmOnShow() {
  // Always (re)check when the tab opens: the Flow token may have appeared since, and no Flow tab is needed to see the menus.
  cmRefresh();
}

// While the tab is open without a session, look again every few seconds (a Flow tab may be opened meanwhile).
setInterval(() => {
  if (!cmEl("panel-classic-migration").hidden && !cmRest && !cmBusy) cmRefresh();
}, 5000);

async function cmFillInstances(keep) {
  const select = cmEl("cmInstance");
  select.innerHTML = "";
  select.append(new Option("None (no IFS OData steps)", ""));
  const response = await send({ type: "LIST_INSTANCES" });
  if (response.ok) for (const i of response.instances.slice().sort((a, b) => a.name.localeCompare(b.name))) select.append(new Option(i.name, i.baseUrl));
  if (keep && [...select.options].some((o) => o.value === keep)) select.value = keep;
}

async function cmFillOrgs(keepOrg, keepPackage) {
  const select = cmEl("cmOrg");
  select.innerHTML = "";
  const [orgs, target] = await Promise.all([send({ type: "FT_ORGS" }), send({ type: "FT_DEFAULT_TARGET", excludeItemId: null })]);
  if (!orgs.ok) throw new Error(orgs.error);
  for (const o of orgs.orgs) select.append(new Option(o.name, o.id));
  const t = target && target.ok ? target.target : null;
  if (keepOrg && orgs.orgs.some((o) => o.id === keepOrg)) select.value = keepOrg;
  else if (t && orgs.orgs.some((o) => o.id === t.orgId)) select.value = t.orgId;
  await cmOrgChanged(keepPackage || (t && t.packageId));
}

async function cmOrgChanged(preferPackage) {
  const orgId = cmEl("cmOrg").value;
  const pkg = cmEl("cmPackage");
  pkg.innerHTML = "";
  pkg.append(new Option("Loading…", ""));
  const response = await send({ type: "FT_PACKAGES", orgId });
  pkg.innerHTML = "";
  if (!response.ok) return showError(response.error, true);
  pkg.append(new Option("Choose a package…", ""));
  for (const p of response.packages) pkg.append(new Option(p.name, p.id));
  if (preferPackage && response.packages.some((p) => p.id === preferPackage)) pkg.value = preferPackage;
  try {
    cmOrgConnectors = await cmGetJson(`/admin/admin-connector/api/organisation/${orgId}/connectors`, "connectors");
  } catch (e) {
    cmOrgConnectors = [];
    showError(e.message, true);
  }
  cmRenderConnectors();
  cmUpdateRun();
}

/* --- flow list --- */

function cmSelectedFlows() {
  const checked = new Set([...cmEl("cmFlows").querySelectorAll("input[type=checkbox]:checked")].map((c) => c.dataset.vid));
  return cmDecoded.dependencyOrder.map((vid) => cmDecoded.flows.find((f) => f.versionIdentifier === vid)).filter((f) => f && checked.has(f.versionIdentifier));
}

function cmRenderFlows() {
  const box = cmEl("cmFlows");
  box.innerHTML = "";
  const byId = new Map(cmDecoded.summaries.map((s) => [s.versionIdentifier, s]));
  for (const vid of cmDecoded.dependencyOrder) {
    const s = byId.get(vid);
    if (!s) continue;
    const row = document.createElement("label");
    row.className = "cm-flow";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.dataset.vid = vid;
    cb.addEventListener("change", () => { cmRenderConnectors(); cmUpdateRun(); });
    const name = document.createElement("span");
    name.className = "cm-flow-name";
    name.textContent = s.name || "(unnamed)";
    row.append(cb, name,
      ftChip(s.assetKind === "application" ? "Flow" : "Component", "info", s.assetKind === "application" ? "A top-level flow (user flow)" : "A reusable component (fragment / machine flow)"),
      ftChip(`${s.itemCount} steps`, "muted"),
      s.environmentOrigin ? ftChip(s.environmentOrigin, "muted", "Classic environment it was exported from") : null);
    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "btn-ghost cm-preview-btn";
    preview.textContent = "Preview";
    preview.title = "Translate this flow and show its summary and warnings. Nothing is created.";
    preview.addEventListener("click", (ev) => {
      ev.preventDefault();
      const flow = cmDecoded.flows.find((f) => f.versionIdentifier === vid);
      if (flow) cmPreviewFlow(flow, s.name || "(unnamed)");
    });
    row.append(preview);
    box.append(row);
  }
  if (cmDecoded.cyclic.length) box.append(ftChip(`${cmDecoded.cyclic.length} flows include each other in a cycle`, "warn"));
  if (cmDecoded.unresolvedReferences.length) box.append(ftChip(`${cmDecoded.unresolvedReferences.length} included flows are not in the file`, "warn", "Their steps become unresolved markers you fix in the Designer."));
}

/* --- connectors --- */

async function cmRememberedMapping(orgId) {
  const stored = await chrome.storage.local.get(CM_MAPPING_KEY);
  return (stored[CM_MAPPING_KEY] || {})[orgId] || {};
}

async function cmRenderConnectors() {
  const box = cmEl("cmConnectors");
  box.innerHTML = "";
  if (!cmDecoded) {
    box.innerHTML = '<p class="api-hint">Shown once a file is loaded.</p>';
    return;
  }
  const orgId = cmEl("cmOrg").value;
  const remembered = await cmRememberedMapping(orgId);
  const runAsRemembered = ((await chrome.storage.local.get(CM_RUNAS_KEY))[CM_RUNAS_KEY] || {})[orgId] || {};
  const refs = new Map();
  for (const flow of cmSelectedFlows()) for (const ref of cmService.listFlowConnectors(flow)) if (!refs.has(ref.name)) refs.set(ref.name, ref);
  if (!refs.size) {
    box.innerHTML = '<p class="api-hint">The selected flows use no Classic connectors.</p>';
    return;
  }
  for (const ref of refs.values()) {
    const row = document.createElement("div");
    row.className = "cm-connector";
    row.dataset.name = ref.name;
    const label = document.createElement("span");
    label.className = "cm-flow-name";
    label.textContent = ref.name;
    const select = document.createElement("select");
    select.append(new Option("Not mapped", ""));
    for (const c of cmOrgConnectors) select.append(new Option(`${c.name}${c.type ? ` (${c.type})` : ""}`, c.id));
    const preset = remembered[ref.name] || (cmOrgConnectors.find((c) => c.name.toLowerCase() === ref.name.toLowerCase()) || {}).id;
    if (preset && cmOrgConnectors.some((c) => c.id === preset)) select.value = preset;
    row.append(label, ftChip(ref.typeName || "?", "muted"), select);
    if (ref.typeName === "database") {
      // Classic's connector-level "Run as User" is not in the export, so it is asked here, only for
      // a database connector mapped to an IFS Applications 10 connector.
      const runAs = document.createElement("label");
      runAs.className = "cm-runas";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.dataset.runas = "1";
      if (runAsRemembered[ref.name] !== undefined) { box.checked = !!runAsRemembered[ref.name]; box.dataset.touched = "1"; }
      box.addEventListener("change", () => { box.dataset.touched = "1"; cmSaveMapping(); });
      runAs.append(box, " Classic connector was set to Run as User ", Object.assign(document.createElement("span"), { className: "info-tip", title: "", textContent: "" }));
      runAs.querySelector(".info-tip").dataset.tip = "In Classic, Run as User was a setting of the connector and is not in the export. Ticked: database steps without their own runAs run as the signed-in user ({userId}). Unticked: they run as the connector user. Left untouched, the result carries a warning.";
      const sync = () => {
        const c = cmOrgConnectors.find((x) => x.id === select.value);
        box.disabled = !c;
        runAs.title = !c ? "Pick a connector first" : c.type === CM_IFS10_TYPE ? "" : `Only used for IFS Applications 10 connectors (this one is ${c.type || "another type"}).`;
      };
      select.addEventListener("change", sync);
      sync();
      row.append(runAs);
    }
    select.addEventListener("change", cmSaveMapping);
    if (ref.typeName === "rest") {
      row.dataset.rest = "1";
      // Same rule as the Electron app: a mapped REST connector needs its Classic REST project (.ncrcp);
      // without it the calls would only become unresolved markers. Unmapped rows stay optional.
      const pick = document.createElement("div");
      pick.className = "cm-rest";
      const label = document.createElement("div");
      label.className = "cm-rest-label";
      const loaded = cmRestProjects[ref.name];
      const sync = () => {
        const mapped = !!select.value;
        label.textContent = `REST project (.ncrcp) for "${ref.name}"${mapped ? " (required)" : ""}: real endpoints, input and output for this connector's calls`;
        hint.hidden = !mapped || !!cmRestProjects[ref.name];
        cmUpdateRun();
      };
      const hint = document.createElement("div");
      hint.className = "cm-rest-hint";
      hint.textContent = "REST project required: upload the .ncrcp file for this connector. It is not remembered between runs.";
      const status = document.createElement("div");
      status.className = "cm-rest-status";
      const file = document.createElement("input");
      file.type = "file";
      file.accept = ".ncrcp";
      file.className = "cm-rest-file";
      if (loaded) status.append(ftChip(`${loaded.operations.length} endpoint${loaded.operations.length === 1 ? "" : "s"} loaded`, "ok"));
      file.addEventListener("change", async () => {
        if (!file.files[0]) return;
        status.textContent = "";
        try {
          const svc = await cmLoadService();
          cmRestProjects[ref.name] = await svc.decodeRestProjectFile(new Uint8Array(await file.files[0].arrayBuffer()));
          status.textContent = "";
          status.append(ftChip(`${file.files[0].name}: ${cmRestProjects[ref.name].operations.length} endpoint(s) loaded`, "ok"));
        } catch (e) {
          delete cmRestProjects[ref.name];
          status.textContent = "";
          status.append(ftChip(`Could not read the REST project: ${e.message}`, "warn"));
        }
        sync();
      });
      select.addEventListener("change", sync);
      pick.append(label, file, status, hint);
      row.append(pick);
      sync();
    }
    box.append(row);
  }
}

async function cmSaveMapping() {
  const orgId = cmEl("cmOrg").value;
  const stored = await chrome.storage.local.get(CM_MAPPING_KEY);
  const all = stored[CM_MAPPING_KEY] || {};
  all[orgId] = { ...(all[orgId] || {}), ...cmCurrentMapping(true) };
  const runAsAll = (await chrome.storage.local.get(CM_RUNAS_KEY))[CM_RUNAS_KEY] || {};
  runAsAll[orgId] = { ...(runAsAll[orgId] || {}) };
  for (const row of cmEl("cmConnectors").querySelectorAll(".cm-connector")) {
    const box = row.querySelector("input[data-runas]");
    if (box && box.dataset.touched) runAsAll[orgId][row.dataset.name] = box.checked;
  }
  await chrome.storage.local.set({ [CM_MAPPING_KEY]: all, [CM_RUNAS_KEY]: runAsAll });
}

/** Classic connector name -> connector id (rawIds) or the full {id, name, type} objects. */
function cmCurrentMapping(rawIds) {
  const out = {};
  for (const row of cmEl("cmConnectors").querySelectorAll(".cm-connector")) {
    const id = row.querySelector("select").value;
    if (!id) continue;
    const connector = cmOrgConnectors.find((c) => c.id === id);
    if (!connector) continue;
    if (rawIds) { out[row.dataset.name] = id; continue; }
    const entry = { id: connector.id, name: connector.name, type: connector.type || "" };
    const box = row.querySelector("input[data-runas]");
    if (box && box.dataset.touched) entry.runAsUser = box.checked;
    out[row.dataset.name] = entry;
  }
  return out;
}

/** Mapped REST connectors that still lack their .ncrcp. */
function cmMissingRestUploads() {
  return [...cmEl("cmConnectors").querySelectorAll(".cm-connector[data-rest]")].filter((row) => row.querySelector("select").value && !cmRestProjects[row.dataset.name]);
}

function cmUpdateRun() {
  const ok = cmDecoded && cmRest && !cmBusy && !cmMissingRestUploads().length && cmEl("cmPackage").value && cmSelectedFlows().length;
  cmEl("cmRunBtn").disabled = !ok;
  const missing = cmDecoded ? cmMissingRestUploads().length : 0;
  cmEl("cmRunHint").hidden = !missing;
}

/* --- loading the file --- */

cmEl("cmFile").addEventListener("change", async () => {
  const file = cmEl("cmFile").files[0];
  if (!file) return;
  cmHint("");
  cmEl("cmResults").innerHTML = "";
  cmRestProjects = {};
  try {
    const svc = await cmLoadService();
    const instances = (await send({ type: "LIST_INSTANCES" })).instances || [];
    cmDecoded = await svc.decodeArchive(new Uint8Array(await file.arrayBuffer()), instances.map((i) => ({ id: i.baseUrl, name: i.name, baseUrl: i.baseUrl })));
    cmRenderFlows();
    const matched = cmDecoded.summaries.map((s) => s.autoMatchedInstanceId).find(Boolean);
    if (matched) cmEl("cmInstance").value = matched;
    cmRenderConnectors();
    cmUpdateRun();
    cmHint(`${cmDecoded.summaries.length} flow${cmDecoded.summaries.length === 1 ? "" : "s"} found.`);
  } catch (e) {
    cmDecoded = null;
    cmEl("cmFlows").innerHTML = '<p class="api-hint">Load a Classic export first.</p>';
    cmEl("cmConnectors").innerHTML = '<p class="api-hint">Shown once a file is loaded.</p>';
    cmHint(e.message);
  }
});
cmEl("cmOrg").addEventListener("change", () => cmOrgChanged());
cmEl("cmRefreshBtn").addEventListener("click", cmRefresh);
cmEl("cmPackage").addEventListener("change", cmUpdateRun);

/* --- warnings and summary --- */

/** Warnings split like the Electron app: "Needs attention" (blockers, open) and "For your information" (collapsed). */
function cmWarningGroups(warnings) {
  const wrap = document.createElement("div");
  if (!warnings.length) return wrap;
  const { blockers, fyis } = cmService.groupWarningsBySeverity(warnings);
  const group = (title, list, cls, open) => {
    if (!list.length) return;
    const d = document.createElement("details");
    d.className = `cm-warning-group ${cls}`;
    d.open = open;
    const sum = document.createElement("summary");
    sum.textContent = `${title} (${list.length})`;
    const pre = document.createElement("pre");
    pre.className = "cm-notes";
    pre.textContent = list.join("\n");
    d.append(sum, pre);
    wrap.append(d);
  };
  group("Needs attention", blockers, "blocker", true);
  group("For your information", fyis, "fyi", false);
  return wrap;
}

function cmSummaryBlock(emitted) {
  const s = cmService.summarizeEmitted(emitted.data);
  const box = document.createElement("div");
  box.className = "cm-summary";
  const row = (label, value, sub) => {
    const r = document.createElement("div");
    r.className = sub ? "cm-summary-row cm-summary-sub" : "cm-summary-row";
    r.append(Object.assign(document.createElement("span"), { textContent: label }), Object.assign(document.createElement("strong"), { textContent: String(value) }));
    box.append(r);
  };
  row("Connect steps", s.steps);
  row("Connect arrows", s.arrows);
  row("Modules used", s.modules);
  for (const [type, n] of s.stepsByType) row(type, n, true);
  return box;
}

async function cmIfsContext(baseUrl, cache) {
  if (!baseUrl) return null;
  if (cache.ifs) return cache.ifs;
  const t = await actionOrShowError({ type: "CM_IFS_TOKEN", baseUrl, masterPassword: masterPasswordOf() });
  if (!t) throw new Error("Could not get an IFS token (unlock the saved credentials first).");
  cache.ifs = { baseUrl, token: t.token };
  return cache.ifs;
}

/** Translates one flow without creating anything (no target, so no modules are committed) and shows
 *  its summary and warnings, like the Electron app did before "Create in Connect". */
async function cmPreviewFlow(flow, name) {
  const box = cmEl("cmPreview");
  box.hidden = false;
  box.innerHTML = "";
  const title = document.createElement("div");
  title.className = "cm-preview-title";
  title.textContent = `Preview: ${name}`;
  box.append(title);
  const status = document.createElement("p");
  status.className = "api-hint";
  status.textContent = "Translating…";
  box.append(status);
  try {
    const svc = await cmLoadService();
    const cache = {};
    const ifs = await cmIfsContext(cmEl("cmInstance").value, cache);
    const ctx = { rest: cmRest, userId: cmUserId, ifs };
    const emitted = await svc.emitFlow(ctx, { flow, connectorMapping: cmCurrentMapping(false), restProjects: cmRestProjects, includedWorkflows: {} });
    status.remove();
    box.append(cmSummaryBlock(emitted));
    const w = cmWarningGroups(emitted.warnings);
    if (emitted.warnings.length) box.append(w);
    else box.append(Object.assign(document.createElement("p"), { className: "api-hint", textContent: "No warnings." }));
  } catch (e) {
    status.textContent = e.message;
  }
}

/* --- run --- */

function cmResultRow(name) {
  const row = document.createElement("div");
  row.className = "cm-result";
  const head = document.createElement("div");
  head.className = "cm-flow";
  const title = document.createElement("span");
  title.className = "cm-flow-name";
  title.textContent = name;
  head.append(title);
  row.append(head);
  cmEl("cmResults").append(row);
  return {
    status(text, tone) { head.querySelectorAll(".ft-chip").forEach((c) => c.remove()); head.append(ftChip(text, tone)); },
    warnings(lines) {
      if (lines.length) row.append(cmWarningGroups(lines));
    },
    summary(emitted) { row.append(cmSummaryBlock(emitted)); },
    detail(lines) {
      if (!lines.length) return;
      const d = document.createElement("details");
      const sum = document.createElement("summary");
      sum.textContent = `${lines.length} note${lines.length === 1 ? "" : "s"}`;
      const pre = document.createElement("pre");
      pre.className = "cm-notes";
      pre.textContent = lines.join("\n");
      d.append(sum, pre);
      row.append(d);
    }
  };
}

cmEl("cmRunBtn").addEventListener("click", async () => {
  if (cmBusy) return;
  cmBusy = true;
  cmUpdateRun();
  cmEl("cmResults").innerHTML = "";
  try {
    await cmFlowSession(); // fresh token
    const svc = await cmLoadService();
    const orgId = cmEl("cmOrg").value;
    const packageId = cmEl("cmPackage").value;
    const baseUrl = cmEl("cmInstance").value;
    let ifs = null;
    const connectorMapping = cmCurrentMapping(false);
    await cmSaveMapping();
    const included = {}; // Classic version id -> pushed { name, assetId, assetVersion }
    const ctx = { rest: cmRest, userId: cmUserId, get ifs() { return ifs; } };
    for (const flow of cmSelectedFlows()) {
      const row = cmResultRow(flow.name);
      row.status("Translating…", "info");
      try {
        if (baseUrl && !ifs) ifs = await cmIfsContext(baseUrl, {});
        const emitted = await svc.emitFlow(ctx, { flow, connectorMapping, restProjects: cmRestProjects, includedWorkflows: included, target: { orgId, packageId } });
        row.status("Saving…", "info");
        const kind = (cmDecoded.summaries.find((s) => s.versionIdentifier === flow.versionIdentifier) || {}).assetKind || "component";
        const pushed = await svc.pushFlow(ctx, { orgId, packageId, name: flow.name, kind }, emitted, { updateExisting: cmEl("cmExisting").value !== "new", commit: cmEl("cmExisting").value === "update-commit" });
        included[flow.versionIdentifier] = { name: flow.name, assetId: pushed.itemId, assetVersion: pushed.assetVersion };
        const blockers = cmService.groupWarningsBySeverity(emitted.warnings).blockers.length;
        const verb = pushed.committed ? "Overwritten and committed" : pushed.updated ? (pushed.unchanged ? "Already up to date" : "Overwritten") : "Saved";
        row.status(blockers ? `${verb}, ${blockers} need${blockers === 1 ? "s" : ""} attention` : emitted.warnings.length ? `${verb}, ${emitted.warnings.length} FYI` : verb, blockers ? "warn" : "ok");
        if (pushed.committed) row.detail(["Existing asset overwritten and committed as a new version (steps verified after the commit). Reload the flow in the Designer."]);
        else if (pushed.updated) row.detail(["Existing asset overwritten (saved, not committed). Reload the flow in the Designer and commit it there to make it a new version."]);
        row.summary(emitted);
        row.warnings(emitted.warnings);
      } catch (e) {
        row.status("Failed", "warn");
        row.detail([e.message]);
      }
    }
  } catch (e) {
    showError(e.message, true);
  } finally {
    cmBusy = false;
    cmUpdateRun();
  }
});
