/* Import/Export tab: export the flow open in the Designer (with its modules, sub-flows and other assets)
 * to a .json file, import such a file, or copy the flow straight into another organisation or
 * package. The background (lib/flow-transfer.js) reads and writes Flow Connect; this panel picks
 * the target, shows what exists there, and lets the user choose per asset: use the existing one
 * as-is, update it, or create a new one. */

let ftPkg = null; // the flow package being imported/copied
let ftMode = null; // "copy" | "import"
let ftPlan = null;
let ftChoices = {}; // package asset id -> choice
let ftConnectorChoices = {}; // source connector id -> target connector id ("" = none)
let ftBusy = false;
let ftDesigner = { open: false, hasFlowToken: false };
let ftPlanSeq = 0;

const ftEl = (id) => document.getElementById(id);

const FT_CHOICE_LABELS = { use: "Use existing as-is", update: "Update existing", create: "Create new" };
const FT_LOCATION_LABELS = { package: "target package", library: "App Library" };

function ftAssetCount(pkg) {
  const all = Object.values(pkg.assets);
  const modules = all.filter((a) => a.type === "module").length;
  return `${modules} module(s), ${all.length - modules - 1} other asset(s)`;
}

/** Export/Copy act on the active Designer tab's flow; Import needs a Flow session only. */
function ftApplyState() {
  const reason = designerBlockReason(ftDesigner);
  for (const id of ["ftExportBtn", "ftCopyBtn"]) {
    ftEl(id).disabled = ftBusy || !!reason;
    ftEl(id).title = reason || ftEl(id).dataset.title || ftEl(id).title;
  }
  ftEl("ftImportBtn").disabled = ftBusy || !ftDesigner.hasFlowToken;
  ftEl("ftRunBtn").disabled = ftBusy || !ftPlan;
  const hint = ftEl("ftSourceHint");
  hint.textContent = !ftDesigner.hasFlowToken ? "No Flow session yet: open a Flow Designer tab and click in it once." : reason;
  hint.hidden = !hint.textContent;
}

async function refreshFlowTransferState() {
  const response = await send({ type: "GET_DESIGNER_STATUS" });
  if (!response.ok) return;
  ftDesigner = { open: response.open, hasFlowToken: response.hasFlowToken };
  ftApplyState();
}

async function ftRun(btn, busyLabel, action) {
  const label = btn.textContent;
  ftBusy = true;
  btn.textContent = busyLabel;
  ftApplyState();
  try {
    await action();
  } finally {
    ftBusy = false;
    btn.textContent = label;
    ftApplyState();
  }
}

function ftDownload(pkg) {
  const root = pkg.assets[pkg.rootId];
  const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${String(root.name).replace(/[\\/:*?"<>|]+/g, "_")}.flow.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function ftShowWarnings(pkg) {
  if (pkg.warnings && pkg.warnings.length) showError(pkg.warnings.join(" "), true);
}

async function ftExport() {
  const response = await actionOrShowError({ type: "FT_EXPORT" });
  if (!response) return;
  ftDownload(response.pkg);
  ftShowWarnings(response.pkg);
  showNotice(`Exported ${response.pkg.assets[response.pkg.rootId].name} with ${ftAssetCount(response.pkg)}.`);
}

async function ftCopy() {
  const response = await actionOrShowError({ type: "FT_EXPORT" });
  if (!response) return;
  ftShowWarnings(response.pkg);
  await ftOpen(response.pkg, "copy");
}

async function ftImportFile(file) {
  let pkg;
  try {
    pkg = JSON.parse(await file.text());
  } catch (e) {
    showError(`${file.name} is not a JSON file: ${e.message}`, true);
    return;
  }
  if (!pkg || pkg.format !== "novacura-buddy-flow" || !pkg.assets || !pkg.assets[pkg.rootId]) {
    showError(`${file.name} is not a NovacuraBuddy flow export.`, true);
    return;
  }
  clearError(true);
  await ftOpen(pkg, "import");
}

function ftOption(select, value, text) {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = text;
  select.appendChild(opt);
  return opt;
}

/** Shows the target picker for `pkg`, starting on the package of another open Designer tab. */
async function ftOpen(pkg, mode) {
  ftPkg = pkg;
  ftMode = mode;
  ftPlan = null;
  ftEl("ftResult").hidden = true;
  const root = pkg.assets[pkg.rootId];
  ftEl("ftTitle").textContent = `${mode === "copy" ? "Copy" : "Import"} ${root.name}`;
  ftEl("ftMeta").textContent = `${ftAssetCount(pkg)}${pkg.exportedAt ? ` · exported ${pkg.exportedAt.slice(0, 16).replace("T", " ")}` : ""}`;
  ftEl("ftRunBtn").textContent = mode === "copy" ? "Copy" : "Import";
  ftEl("ftEmpty").hidden = true;
  ftEl("ftTarget").hidden = false;
  ftEl("ftAssets").innerHTML = "";
  ftEl("ftConnectorsBox").hidden = true;

  const [orgs, target] = await Promise.all([
    actionOrShowError({ type: "FT_ORGS" }),
    send({ type: "FT_DEFAULT_TARGET", excludeItemId: mode === "copy" ? pkg.rootId : null })
  ]);
  if (!orgs) return;
  const t = target && target.ok ? target.target : null;
  const orgSelect = ftEl("ftOrg");
  orgSelect.innerHTML = "";
  for (const o of orgs.orgs) ftOption(orgSelect, o.id, o.name);
  orgSelect.value = t && orgs.orgs.some((o) => o.id === t.orgId) ? t.orgId : (pkg.source && pkg.source.orgId) || orgs.orgs[0].id;
  if (!orgSelect.value && orgs.orgs.length) orgSelect.value = orgs.orgs[0].id;
  ftEl("ftTargetHint").textContent = t && t.fromOtherTab ? `Preselected from the open Designer tab "${t.tabTitle}".` : "";
  await ftLoadPackages(t && t.orgId === orgSelect.value ? t.packageId : null);
}

async function ftLoadPackages(preselectPackageId) {
  const select = ftEl("ftPackage");
  select.innerHTML = "";
  ftOption(select, "", "Loading…");
  const response = await actionOrShowError({ type: "FT_PACKAGES", orgId: ftEl("ftOrg").value });
  select.innerHTML = "";
  ftOption(select, "", "No package (App Library)");
  if (!response) return;
  for (const p of response.packages) ftOption(select, p.id, p.name);
  if (preselectPackageId && response.packages.some((p) => p.id === preselectPackageId)) select.value = preselectPackageId;
  await ftLoadPlan();
}

async function ftLoadPlan() {
  const seq = ++ftPlanSeq;
  ftPlan = null;
  ftApplyState();
  ftEl("ftAssets").innerHTML = '<li class="ft-note">Checking the target…</li>';
  const response = await actionOrShowError({ type: "FT_PLAN", pkg: ftPkg, orgId: ftEl("ftOrg").value, packageId: ftEl("ftPackage").value || null });
  if (seq !== ftPlanSeq) return; // the target changed meanwhile
  if (!response) {
    ftEl("ftAssets").innerHTML = "";
    return;
  }
  ftPlan = response.plan;
  ftChoices = {};
  for (const row of ftPlan.assets) ftChoices[row.id] = row.choice;
  ftConnectorChoices = {};
  for (const row of ftPlan.connectors) ftConnectorChoices[row.source.id] = row.targetId || "";
  ftEl("ftRootName").value = ftPlan.rootName;
  ftRenderPlan();
  ftApplyState();
}

function ftRenderPlan() {
  const list = ftEl("ftAssets");
  list.innerHTML = "";
  for (const row of ftPlan.assets) {
    const li = document.createElement("li");
    li.className = "ft-row";
    const head = document.createElement("div");
    head.className = "ft-row-head";
    const name = document.createElement("span");
    name.className = "ft-name";
    name.textContent = row.name + (row.isRoot ? " (this flow)" : "");
    const type = document.createElement("span");
    type.className = "status status-created";
    type.textContent = row.type;
    head.append(name, type);
    const select = document.createElement("select");
    for (const option of row.options) ftOption(select, option, row.isRoot && option === "create" ? "Create new flow" : FT_CHOICE_LABELS[option]);
    select.value = ftChoices[row.id];
    select.disabled = row.options.length === 1;
    select.addEventListener("change", () => {
      ftChoices[row.id] = select.value;
      ftApplyRootName();
    });
    const note = document.createElement("span");
    note.className = "ft-note";
    if (!row.existing) {
      note.textContent = "Not in the target yet, will be created.";
    } else {
      const where = FT_LOCATION_LABELS[row.existing.location] || row.existing.location;
      const code = row.sameCode === true ? ", same code" : row.sameCode === false ? ", code differs" : "";
      note.textContent = `${row.existing.name} exists in the ${where}${code}.`;
      if (row.sameCode === false) note.classList.add("ft-differs");
    }
    li.append(head, note, select);
    list.appendChild(li);
  }

  const box = ftEl("ftConnectorsBox");
  const connectors = ftEl("ftConnectors");
  connectors.innerHTML = "";
  box.hidden = !ftPlan.connectors.length;
  for (const row of ftPlan.connectors) {
    const li = document.createElement("li");
    li.className = "ft-row";
    const name = document.createElement("span");
    name.className = "ft-name";
    name.textContent = row.source.name || row.source.id;
    const select = document.createElement("select");
    ftOption(select, "", "None (steps lose their connector)");
    for (const c of ftPlan.targetConnectors) ftOption(select, c.id, c.name);
    select.value = ftConnectorChoices[row.source.id];
    select.addEventListener("change", () => { ftConnectorChoices[row.source.id] = select.value; });
    const note = document.createElement("span");
    note.className = "ft-note" + (row.targetId ? "" : " ft-differs");
    note.textContent = row.targetId ? "Matched by name in the target organisation." : "No connector of this name in the target organisation.";
    li.append(name, note, select);
    connectors.appendChild(li);
  }
  ftApplyRootName();
}

function ftApplyRootName() {
  ftEl("ftRootNameField").hidden = !ftPlan || ftChoices[ftPkg.rootId] !== "create";
}

async function ftRunImport() {
  if (!ftPlan) return;
  const updates = ftPlan.assets.filter((row) => ftChoices[row.id] === "update").map((row) => row.existing.name);
  if (updates.length && !confirm(`This replaces the content of ${updates.join(", ")} in the target. Other flows using them see the change. Continue?`)) return;
  const rootName = ftEl("ftRootName").value.trim();
  if (ftChoices[ftPkg.rootId] === "create" && !rootName) {
    showError("Enter a name for the new flow.", true);
    return;
  }
  const connectorMap = {};
  for (const [id, target] of Object.entries(ftConnectorChoices)) connectorMap[id] = target || null;
  const orgId = ftEl("ftOrg").value;
  const response = await actionOrShowError({
    type: "FT_IMPORT", pkg: ftPkg, orgId, packageId: ftEl("ftPackage").value || null,
    choices: ftChoices, connectorMap, rootName
  });
  if (!response) return;
  ftShowResult(response.outcome);
}

function ftShowResult(outcome) {
  const box = ftEl("ftResult");
  box.innerHTML = "";
  const title = document.createElement("strong");
  title.textContent = `${ftMode === "copy" ? "Copied" : "Imported"} into ${ftEl("ftOrg").selectedOptions[0].textContent} / ${ftEl("ftPackage").selectedOptions[0].textContent}.`;
  const list = document.createElement("ul");
  for (const r of outcome.results) {
    const li = document.createElement("li");
    li.textContent = `${r.name} (${r.type}): ${{ use: "existing used as-is", update: "existing updated", create: "created" }[r.choice]}`;
    list.appendChild(li);
  }
  box.append(title, list);
  if (outcome.unmappedConnectors.length) {
    const warn = document.createElement("p");
    warn.className = "ft-note ft-differs";
    warn.textContent = `Steps that used ${outcome.unmappedConnectors.join(", ")} have no connector now. Set one in the Designer.`;
    box.appendChild(warn);
  }
  const note = document.createElement("p");
  note.className = "ft-note";
  note.textContent = "Created and updated modules are committed. Flows are saved but not committed: open the flow, check it, and commit it in the Designer.";
  const open = document.createElement("a");
  open.href = `https://build.novacura.com/admin/design/designer/organizations/${outcome.orgId}/items/${outcome.rootId}`;
  open.target = "_blank";
  open.rel = "noopener";
  open.textContent = "Open the flow in the Designer";
  box.append(note, open);
  box.hidden = false;
  ftEl("ftTarget").hidden = true;
  ftEl("ftEmpty").hidden = true;
  ftPkg = null;
  ftPlan = null;
  showNotice("Flow transfer done.");
}

function ftCancel() {
  ftPkg = null;
  ftPlan = null;
  ftPlanSeq++;
  ftEl("ftTarget").hidden = true;
  ftEl("ftEmpty").hidden = false;
  ftApplyState();
}

function initFlowTransferPanel() {
  for (const id of ["ftExportBtn", "ftCopyBtn"]) ftEl(id).dataset.title = ftEl(id).title;
  ftEl("ftExportBtn").addEventListener("click", () => ftRun(ftEl("ftExportBtn"), "Exporting…", ftExport));
  ftEl("ftCopyBtn").addEventListener("click", () => ftRun(ftEl("ftCopyBtn"), "Reading…", ftCopy));
  ftEl("ftImportBtn").addEventListener("click", () => ftEl("ftFile").click());
  ftEl("ftFile").addEventListener("change", async () => {
    const file = ftEl("ftFile").files[0];
    ftEl("ftFile").value = "";
    if (file) await ftRun(ftEl("ftImportBtn"), "Reading…", () => ftImportFile(file));
  });
  ftEl("ftOrg").addEventListener("change", () => ftLoadPackages(null));
  ftEl("ftPackage").addEventListener("change", ftLoadPlan);
  ftEl("ftRunBtn").addEventListener("click", () => ftRun(ftEl("ftRunBtn"), ftMode === "copy" ? "Copying…" : "Importing…", ftRunImport));
  ftEl("ftCancelBtn").addEventListener("click", ftCancel);
  refreshFlowTransferState();
}
