/* Import/Export tab: export the flow open in the Designer, or flows / a whole package picked in
 * the package browser, with every module, sub-flow and asset they use (at any depth) to a .json
 * file; import such a file; or copy straight into another organisation or package. The
 * background (lib/flow-transfer.js) reads and writes Flow Connect; this panel shows the
 * dependency tree (lib/flow-tree.js) and lets the user choose per asset: use the existing one
 * as-is, update it, or create a new one. */

let ftPkg = null; // the flow package being imported/copied
let ftMode = null; // "copy" | "import"
let ftPlan = null;
let ftChoices = {}; // package asset id -> choice
let ftNames = {}; // exported flow id -> name when created new
let ftConnectorChoices = {}; // source connector id -> target connector id ("" = none)
let ftBusy = false;
let ftDesigner = { open: false, hasFlowToken: false };
let ftPlanSeq = 0;
let ftBrowseAssets = []; // [{ id, name, type }] of the browsed package
let ftBrowseSelected = new Set();

const ftEl = (id) => document.getElementById(id);

const FT_CHOICE_LABELS = { use: "Use existing as-is", update: "Update existing", create: "Create new" };
const FT_LOCATION_CHIPS = { package: "In target package", library: "In App Library" };
const FT_RESULT_CHIPS = { use: ["Used as-is", "info"], update: ["Updated", "warn"], create: ["Created", "ok"] };

function ftKind(type) {
  if (type === "module") return { icon: "M", cls: "module", label: "Module" };
  if (type === "connector") return { icon: "C", cls: "connector", label: "Connector" };
  if (type === "component" || type === "workflow" || type === "flow") return { icon: "F", cls: "flow", label: "Flow" };
  return { icon: String(type || "?").charAt(0).toUpperCase(), cls: "other", label: type };
}

/** A small pill: tone "info" (blue), "ok" (green), "warn" (orange) or "muted". */
function ftChip(text, tone, title) {
  const chip = document.createElement("span");
  chip.className = `ft-chip ft-chip-${tone || "muted"}`;
  chip.textContent = text;
  if (title) chip.title = title;
  return chip;
}

function ftChipRow(...chips) {
  const row = document.createElement("div");
  row.className = "ft-chips";
  row.append(...chips.filter(Boolean));
  return row;
}

function ftSummaryChips(pkg) {
  const { flows, modules, other } = FlowTree.summarize(pkg);
  return ftChipRow(
    ftChip(`${flows} flow${flows === 1 ? "" : "s"}`, "info"),
    ftChip(`${modules} module${modules === 1 ? "" : "s"}`, "info"),
    other ? ftChip(`${other} other`, "muted") : null,
    pkg.connectors && pkg.connectors.length ? ftChip(`${pkg.connectors.length} connector${pkg.connectors.length === 1 ? "" : "s"}`, "muted") : null,
    pkg.exportedAt ? ftChip(`exported ${pkg.exportedAt.slice(0, 16).replace("T", " ")}`, "muted") : null
  );
}

function ftRootLabel(pkg) {
  const roots = FlowTree.rootIdsOf(pkg);
  return roots.length === 1 ? pkg.assets[roots[0]].name : `${roots.length} assets`;
}

/** Renders FlowTree.dependencyTree(pkg) into `container`. `decorate(node, card)` may add to a
 *  first-occurrence asset's card (the import plan adds its choice there). */
function ftRenderTree(container, pkg, decorate) {
  container.innerHTML = "";
  container.classList.add("ft-tree");
  (function render(nodes, parent) {
    for (const node of nodes) {
      const li = document.createElement("li");
      const card = document.createElement("div");
      const kind = ftKind(node.type);
      card.className = "ft-node" + (node.repeat ? " ft-repeat" : "") + (node.type === "connector" ? " ft-connector" : "");
      const head = document.createElement("div");
      head.className = "ft-node-head";
      const icon = document.createElement("span");
      icon.className = `ft-icon ft-icon-${kind.cls}`;
      icon.textContent = kind.icon;
      icon.title = kind.label;
      const name = document.createElement("span");
      name.className = "ft-name";
      name.textContent = node.name;
      head.append(icon, name, node.repeat ? ftChip("used above", "muted", "Listed in full further up") : ftChip(kind.label, "muted"));
      card.appendChild(head);
      if (!node.repeat && decorate) decorate(node, card);
      li.appendChild(card);
      if (node.children.length) {
        const ul = document.createElement("ul");
        render(node.children, ul);
        li.appendChild(ul);
      }
      parent.appendChild(li);
    }
  })(FlowTree.dependencyTree(pkg), container);
}

/** Export/Copy of the open flow act on the active Designer tab; the rest needs a Flow session. */
function ftApplyState() {
  const reason = designerBlockReason(ftDesigner);
  for (const id of ["ftExportBtn", "ftCopyBtn"]) {
    ftEl(id).disabled = ftBusy || !!reason;
    ftEl(id).title = reason || ftEl(id).dataset.title;
  }
  const noSession = !ftDesigner.hasFlowToken;
  ftEl("ftImportBtn").disabled = ftBusy || noSession;
  ftEl("ftBrowseExportBtn").disabled = ftBusy || noSession || !ftBrowseSelected.size;
  ftEl("ftBrowseCopyBtn").disabled = ftBusy || noSession || !ftBrowseSelected.size;
  ftEl("ftRunBtn").disabled = ftBusy || !ftPlan;
  const hint = ftEl("ftSourceHint");
  hint.textContent = noSession ? "No Flow session yet: open build.novacura.com and click in it once." : reason;
  hint.hidden = !hint.textContent;
}

async function refreshFlowTransferState() {
  const response = await send({ type: "GET_DESIGNER_STATUS" });
  if (!response.ok) return;
  const hadSession = ftDesigner.hasFlowToken;
  ftDesigner = { open: response.open, hasFlowToken: response.hasFlowToken };
  ftApplyState();
  if (!hadSession && ftDesigner.hasFlowToken && ftEl("ftBrowse").open && !ftEl("ftBrowseOrg").options.length) ftBrowseInit();
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
  const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${String(ftRootLabel(pkg)).replace(/[\\/:*?"<>|]+/g, "_")}.flow.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function ftShowWarnings(pkg) {
  if (pkg.warnings && pkg.warnings.length) showError(pkg.warnings.join(" "), true);
}

function ftHideViews() {
  for (const id of ["ftSummary", "ftTarget", "ftResult"]) ftEl(id).hidden = true;
  ftEl("ftEmpty").hidden = true;
}

/** After an export: what went into the file, as a tree. */
function ftShowExportSummary(pkg) {
  ftHideViews();
  const box = ftEl("ftSummary");
  box.innerHTML = "";
  const title = document.createElement("strong");
  title.textContent = `Exported ${ftRootLabel(pkg)}`;
  const tree = document.createElement("ul");
  ftRenderTree(tree, pkg);
  box.append(title, ftSummaryChips(pkg), tree);
  box.hidden = false;
}

async function ftExport(message) {
  const response = await actionOrShowError(message);
  if (!response) return;
  ftDownload(response.pkg);
  ftShowWarnings(response.pkg);
  ftShowExportSummary(response.pkg);
}

async function ftCopy(message) {
  const response = await actionOrShowError(message);
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
  if (!pkg || pkg.format !== "novacura-buddy-flow" || !pkg.assets || !FlowTree.rootIdsOf(pkg).every((id) => pkg.assets[id])) {
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

/** Fills an organisation select and returns the default target (another open Designer tab's). */
async function ftFillOrgs(select, excludeItemId) {
  const [orgs, target] = await Promise.all([
    actionOrShowError({ type: "FT_ORGS" }),
    send({ type: "FT_DEFAULT_TARGET", excludeItemId })
  ]);
  if (!orgs) return null;
  const t = target && target.ok ? target.target : null;
  select.innerHTML = "";
  for (const o of orgs.orgs) ftOption(select, o.id, o.name);
  if (t && orgs.orgs.some((o) => o.id === t.orgId)) select.value = t.orgId;
  return t;
}

/** Fills a package select ("" = App Library) and preselects `packageId` when it is there. */
async function ftFillPackages(select, orgId, packageId) {
  select.innerHTML = "";
  ftOption(select, "", "Loading…");
  const response = await actionOrShowError({ type: "FT_PACKAGES", orgId });
  select.innerHTML = "";
  ftOption(select, "", "No package (App Library)");
  if (!response) return;
  for (const p of response.packages) ftOption(select, p.id, p.name);
  if (packageId && response.packages.some((p) => p.id === packageId)) select.value = packageId;
}

/* --- package browser --- */

async function ftBrowseInit() {
  const t = await ftFillOrgs(ftEl("ftBrowseOrg"), null);
  if (!ftEl("ftBrowseOrg").options.length) return;
  await ftFillPackages(ftEl("ftBrowsePackage"), ftEl("ftBrowseOrg").value, t && t.orgId === ftEl("ftBrowseOrg").value ? t.packageId : null);
  await ftBrowseLoad();
}

async function ftBrowseLoad() {
  const list = ftEl("ftBrowseList");
  list.innerHTML = '<p class="ft-note">Loading…</p>';
  ftBrowseSelected = new Set();
  const response = await actionOrShowError({ type: "FT_LIST_ASSETS", orgId: ftEl("ftBrowseOrg").value, packageId: ftEl("ftBrowsePackage").value || null });
  ftBrowseAssets = response ? response.assets : [];
  ftBrowseRender();
}

function ftBrowseRender() {
  const list = ftEl("ftBrowseList");
  list.innerHTML = "";
  if (!ftBrowseAssets.length) list.innerHTML = '<p class="ft-note">Nothing in this package.</p>';
  const groups = new Map();
  for (const a of ftBrowseAssets) {
    const label = ftKind(a.type).label;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(a);
  }
  const sorted = [...groups.entries()].sort(([a], [b]) => (a === "Flow" ? -1 : b === "Flow" ? 1 : a.localeCompare(b)));
  for (const [label, assets] of sorted) {
    const folder = document.createElement("details");
    folder.className = "ft-folder";
    folder.open = label === "Flow";
    const summary = document.createElement("summary");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.addEventListener("click", (e) => e.stopPropagation());
    box.addEventListener("change", () => {
      for (const a of assets) box.checked ? ftBrowseSelected.add(a.id) : ftBrowseSelected.delete(a.id);
      ftBrowseSync();
    });
    const icon = document.createElement("span");
    icon.className = `ft-icon ft-icon-${ftKind(assets[0].type).cls}`;
    icon.textContent = ftKind(assets[0].type).icon;
    const name = document.createElement("span");
    name.className = "ft-name";
    name.textContent = `${label}s`;
    summary.append(box, icon, name, ftChip("", "info"));
    const ul = document.createElement("ul");
    for (const a of assets) {
      const li = document.createElement("li");
      const row = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.assetId = a.id;
      cb.addEventListener("change", () => {
        cb.checked ? ftBrowseSelected.add(a.id) : ftBrowseSelected.delete(a.id);
        ftBrowseSync();
      });
      const text = document.createElement("span");
      text.textContent = a.name;
      row.append(cb, text);
      li.appendChild(row);
      ul.appendChild(li);
    }
    folder.dataset.ids = assets.map((a) => a.id).join(",");
    folder.append(summary, ul);
    list.appendChild(folder);
  }
  ftBrowseSync();
}

function ftBrowseSync() {
  for (const cb of ftEl("ftBrowseList").querySelectorAll("input[data-asset-id]")) cb.checked = ftBrowseSelected.has(cb.dataset.assetId);
  for (const folder of ftEl("ftBrowseList").querySelectorAll(".ft-folder")) {
    const ids = folder.dataset.ids.split(",");
    const on = ids.filter((id) => ftBrowseSelected.has(id)).length;
    const box = folder.querySelector("summary input");
    box.checked = on === ids.length;
    box.indeterminate = on > 0 && on < ids.length;
    folder.querySelector("summary .ft-chip").textContent = `${on}/${ids.length}`;
  }
  const all = ftEl("ftBrowseAll");
  all.checked = ftBrowseAssets.length > 0 && ftBrowseSelected.size === ftBrowseAssets.length;
  all.indeterminate = ftBrowseSelected.size > 0 && ftBrowseSelected.size < ftBrowseAssets.length;
  ftEl("ftBrowseSelected").textContent = `${ftBrowseSelected.size} of ${ftBrowseAssets.length} selected`;
  ftEl("ftBrowseCount").textContent = ftBrowseAssets.length ? `${ftBrowseAssets.length}` : "";
  ftApplyState();
}

function ftBrowseMessage() {
  // Flows first, so a one-flow pick is named after that flow.
  const rootIds = ftBrowseAssets.filter((a) => ftBrowseSelected.has(a.id)).sort((a, b) => (a.type === "module") - (b.type === "module")).map((a) => a.id);
  return { type: "FT_EXPORT", orgId: ftEl("ftBrowseOrg").value, packageId: ftEl("ftBrowsePackage").value || null, rootIds };
}

/* --- import / copy target and plan --- */

/** Shows the target picker for `pkg`, starting on the package of another open Designer tab. */
async function ftOpen(pkg, mode) {
  ftPkg = pkg;
  ftMode = mode;
  ftPlan = null;
  ftHideViews();
  ftEl("ftTitle").textContent = `${mode === "copy" ? "Copy" : "Import"} ${ftRootLabel(pkg)}`;
  ftEl("ftMeta").innerHTML = "";
  ftEl("ftMeta").appendChild(ftSummaryChips(pkg));
  ftEl("ftRunBtn").textContent = mode === "copy" ? "Copy" : "Import";
  ftEl("ftTarget").hidden = false;
  ftRenderTree(ftEl("ftAssets"), pkg);
  ftEl("ftConnectorsBox").hidden = true;

  const roots = FlowTree.rootIdsOf(pkg);
  const t = await ftFillOrgs(ftEl("ftOrg"), mode === "copy" && roots.length === 1 ? roots[0] : null);
  if (!ftEl("ftOrg").options.length) return;
  ftEl("ftTargetHint").innerHTML = "";
  if (t && t.fromOtherTab) ftEl("ftTargetHint").appendChild(ftChip(`From open tab: ${t.tabTitle}`, "info", "Preselected from another open Designer tab"));
  await ftFillPackages(ftEl("ftPackage"), ftEl("ftOrg").value, t && t.orgId === ftEl("ftOrg").value ? t.packageId : null);
  await ftLoadPlan();
}

async function ftLoadPlan() {
  const seq = ++ftPlanSeq;
  ftPlan = null;
  ftApplyState();
  const response = await actionOrShowError({ type: "FT_PLAN", pkg: ftPkg, orgId: ftEl("ftOrg").value, packageId: ftEl("ftPackage").value || null });
  if (seq !== ftPlanSeq) return; // the target changed meanwhile
  if (!response) return;
  ftPlan = response.plan;
  ftChoices = {};
  ftNames = {};
  for (const row of ftPlan.assets) {
    ftChoices[row.id] = row.choice;
    if (row.isRoot) ftNames[row.id] = row.newName;
  }
  ftConnectorChoices = {};
  for (const row of ftPlan.connectors) ftConnectorChoices[row.source.id] = row.targetId || "";
  ftRenderPlan();
  ftApplyState();
}

/** The plan as the dependency tree: each asset's status chips and choice sit on its first card. */
function ftRenderPlan() {
  const rows = new Map(ftPlan.assets.map((row) => [row.id, row]));
  ftRenderTree(ftEl("ftAssets"), ftPkg, (node, card) => {
    const row = rows.get(node.id);
    if (!row) return;
    const code = row.sameCode === true ? ftChip("Same code", "ok") : row.sameCode === false ? ftChip("Code differs", "warn") : null;
    card.appendChild(row.existing
      ? ftChipRow(ftChip(FT_LOCATION_CHIPS[row.existing.location] || row.existing.location, "info", `Matched by name: ${row.existing.name}`), code)
      : ftChipRow(ftChip("New in target", "ok", "Not in the target yet, will be created")));
    const select = document.createElement("select");
    for (const option of row.options) ftOption(select, option, row.isRoot && option === "create" ? "Create new flow" : FT_CHOICE_LABELS[option]);
    select.value = ftChoices[row.id];
    select.disabled = row.options.length === 1;
    card.appendChild(select);
    if (row.isRoot) {
      const field = document.createElement("label");
      field.className = "ft-node-name";
      field.textContent = "Name";
      const input = document.createElement("input");
      input.value = ftNames[row.id];
      input.spellcheck = false;
      input.addEventListener("input", () => { ftNames[row.id] = input.value; });
      field.appendChild(input);
      field.hidden = ftChoices[row.id] !== "create";
      card.appendChild(field);
      select.addEventListener("change", () => { field.hidden = select.value !== "create"; });
    }
    select.addEventListener("change", () => { ftChoices[row.id] = select.value; });
  });

  const box = ftEl("ftConnectorsBox");
  const connectors = ftEl("ftConnectors");
  connectors.innerHTML = "";
  box.hidden = !ftPlan.connectors.length;
  for (const row of ftPlan.connectors) {
    const li = document.createElement("li");
    li.className = "ft-node";
    const head = document.createElement("div");
    head.className = "ft-node-head";
    const icon = document.createElement("span");
    icon.className = "ft-icon ft-icon-connector";
    icon.textContent = "C";
    const name = document.createElement("span");
    name.className = "ft-name";
    name.textContent = row.source.name || row.source.id;
    head.append(icon, name, row.targetId ? ftChip("Matched by name", "ok") : ftChip("No match in target", "warn"));
    const select = document.createElement("select");
    ftOption(select, "", "None (steps lose their connector)");
    for (const c of ftPlan.targetConnectors) ftOption(select, c.id, c.name);
    select.value = ftConnectorChoices[row.source.id];
    select.addEventListener("change", () => { ftConnectorChoices[row.source.id] = select.value; });
    li.append(head, select);
    connectors.appendChild(li);
  }
}

async function ftRunImport() {
  if (!ftPlan) return;
  const updates = ftPlan.assets.filter((row) => ftChoices[row.id] === "update").map((row) => row.existing.name);
  if (updates.length && !confirm(`This replaces the content of ${updates.join(", ")} in the target. Other flows using them see the change. Continue?`)) return;
  const names = {};
  for (const row of ftPlan.assets.filter((r) => r.isRoot && ftChoices[r.id] === "create")) {
    names[row.id] = (ftNames[row.id] || "").trim();
    if (!names[row.id]) {
      showError(`Enter a name for the new flow ${row.name}.`, true);
      return;
    }
  }
  const connectorMap = {};
  for (const [id, target] of Object.entries(ftConnectorChoices)) connectorMap[id] = target || null;
  const response = await actionOrShowError({
    type: "FT_IMPORT", pkg: ftPkg, orgId: ftEl("ftOrg").value, packageId: ftEl("ftPackage").value || null,
    choices: ftChoices, connectorMap, names
  });
  if (!response) return;
  ftShowResult(response.outcome);
}

function ftShowResult(outcome) {
  const pkg = ftPkg;
  const results = new Map(outcome.results.map((r) => [r.id, r]));
  ftHideViews();
  const box = ftEl("ftResult");
  box.innerHTML = "";
  const title = document.createElement("strong");
  title.textContent = `${ftMode === "copy" ? "Copied" : "Imported"} ${ftRootLabel(pkg)}`;
  const target = ftChipRow(
    ftChip(ftEl("ftOrg").selectedOptions[0].textContent, "info", "Target organisation"),
    ftChip(ftEl("ftPackage").selectedOptions[0].textContent, "info", "Target package")
  );
  const tree = document.createElement("ul");
  ftRenderTree(tree, pkg, (node, card) => {
    const r = results.get(node.id);
    if (!r) return;
    const [label, tone] = FT_RESULT_CHIPS[r.choice];
    const chips = ftChipRow(ftChip(label, tone), r.isRoot && r.choice === "create" && r.name !== node.name ? ftChip(`as "${r.name}"`, "muted") : null);
    card.appendChild(chips);
    if (r.isRoot) {
      const open = document.createElement("a");
      open.href = `https://build.novacura.com/admin/design/designer/organizations/${outcome.orgId}/items/${r.targetId}`;
      open.target = "_blank";
      open.rel = "noopener";
      open.className = "ft-chip ft-chip-link";
      open.textContent = "Open in Designer ↗";
      chips.appendChild(open);
    }
  });
  box.append(title, target, tree);
  if (outcome.unmappedConnectors.length) {
    box.appendChild(ftChipRow(ftChip(`No connector: ${outcome.unmappedConnectors.join(", ")}`, "warn", "Set the connector on these steps in the Designer")));
  }
  const note = document.createElement("p");
  note.className = "ft-note";
  note.textContent = "Modules are committed. Flows are saved but not committed: open each flow, check it, and commit it in the Designer.";
  box.appendChild(note);
  box.hidden = false;
  ftPkg = null;
  ftPlan = null;
  showNotice(`${ftMode === "copy" ? "Copy" : "Import"} done.`);
}

function ftCancel() {
  ftPkg = null;
  ftPlan = null;
  ftPlanSeq++;
  ftHideViews();
  ftEl("ftEmpty").hidden = false;
  ftApplyState();
}

function initFlowTransferPanel() {
  for (const id of ["ftExportBtn", "ftCopyBtn"]) ftEl(id).dataset.title = ftEl(id).title;
  ftEl("ftExportBtn").addEventListener("click", () => ftRun(ftEl("ftExportBtn"), "Exporting…", () => ftExport({ type: "FT_EXPORT" })));
  ftEl("ftCopyBtn").addEventListener("click", () => ftRun(ftEl("ftCopyBtn"), "Reading…", () => ftCopy({ type: "FT_EXPORT" })));
  ftEl("ftImportBtn").addEventListener("click", () => ftEl("ftFile").click());
  ftEl("ftFile").addEventListener("change", async () => {
    const file = ftEl("ftFile").files[0];
    ftEl("ftFile").value = "";
    if (file) await ftRun(ftEl("ftImportBtn"), "Reading…", () => ftImportFile(file));
  });

  ftEl("ftBrowse").addEventListener("toggle", () => {
    if (ftEl("ftBrowse").open && !ftEl("ftBrowseOrg").options.length && ftDesigner.hasFlowToken) ftBrowseInit();
  });
  ftEl("ftBrowseOrg").addEventListener("change", async () => {
    await ftFillPackages(ftEl("ftBrowsePackage"), ftEl("ftBrowseOrg").value, null);
    await ftBrowseLoad();
  });
  ftEl("ftBrowsePackage").addEventListener("change", ftBrowseLoad);
  ftEl("ftBrowseAll").addEventListener("change", () => {
    ftBrowseSelected = ftEl("ftBrowseAll").checked ? new Set(ftBrowseAssets.map((a) => a.id)) : new Set();
    ftBrowseSync();
  });
  ftEl("ftBrowseExportBtn").addEventListener("click", () => ftRun(ftEl("ftBrowseExportBtn"), "Exporting…", () => ftExport(ftBrowseMessage())));
  ftEl("ftBrowseCopyBtn").addEventListener("click", () => ftRun(ftEl("ftBrowseCopyBtn"), "Reading…", () => ftCopy(ftBrowseMessage())));

  ftEl("ftOrg").addEventListener("change", async () => {
    await ftFillPackages(ftEl("ftPackage"), ftEl("ftOrg").value, null);
    await ftLoadPlan();
  });
  ftEl("ftPackage").addEventListener("change", ftLoadPlan);
  ftEl("ftRunBtn").addEventListener("click", () => ftRun(ftEl("ftRunBtn"), ftMode === "copy" ? "Copying…" : "Importing…", ftRunImport));
  ftEl("ftCancelBtn").addEventListener("click", ftCancel);
  refreshFlowTransferState();
}
