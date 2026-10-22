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
// Where an import puts things when the file carries its packages: recreate them ("packages") or
// all into the picked package ("single"); per exported package "use" | "create". App Library
// assets always go back to the App Library (a flow can only use its own package and that).
let ftLayout = { mode: "packages", packageChoices: {} };
// Environment tree selection, one organisation at a time: whole packages (key "" = App Library)
// and single assets.
let ftSel = { orgId: null, orgName: "", packages: new Map(), assets: new Map() };
let ftEnvLoaded = false;
let ftEnvOrgs = []; // the organisations the tree shows, for the filter
// Filter index: orgId -> Promise of [{ id, name, assets }] (App Library first), each org's lists
// loaded once when the filter first needs them.
const ftEnvIndex = new Map();
let ftFilterSeq = 0;
let ftFilterTimer = null;

const ftEl = (id) => document.getElementById(id);

const FT_CHOICE_LABELS = { use: "Use existing as-is", update: "Update existing", create: "Create new", regenerate: "Generate from IFS" };
const FT_LOCATION_CHIPS = { package: "In target package", library: "In App Library" };
const FT_RESULT_CHIPS = { use: ["Used as-is", "info"], update: ["Updated", "warn"], create: ["Created", "ok"], regenerate: ["Generated from IFS", "ok"] };

/** Icon, colour class and label for an asset type. Flows are "component"; automations are taken
 *  to be "workflow" or any type naming automation/machine (UNVERIFIED: only "component" and
 *  "module" have been seen live), so the label also carries the raw type to check it. */
function ftKind(type) {
  const t = String(type || "");
  const kind = t === "module" ? { icon: "M", cls: "module", label: "Module" }
    : t === "connector" ? { icon: "C", cls: "connector", label: "Connector" }
    : t === "workflow" || /automation|machine/i.test(t) ? { icon: "A", cls: "automation", label: "Automation" }
    : t === "component" || t === "flow" ? { icon: "F", cls: "flow", label: "Flow" }
    : { icon: (t || "?").charAt(0).toUpperCase(), cls: "other", label: t || "Unknown" };
  return { ...kind, title: t && t !== kind.label.toLowerCase() ? `${kind.label} (type "${t}")` : kind.label };
}

/** The coloured letter icon for an asset type (shared with the Linked Flows tab). */
function ftKindIcon(type) {
  const kind = ftKind(type);
  const icon = document.createElement("span");
  icon.className = `ft-icon ft-icon-${kind.cls}`;
  icon.textContent = kind.icon;
  icon.title = kind.title;
  return icon;
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

/** What the export is called: the names of what was selected (packages, flows, modules), cut to
 *  60 characters plus "+N others"; stored in the file as `label`. */
function ftRootLabel(pkg) {
  return pkg.label || FlowTree.exportName(FlowTree.rootIdsOf(pkg).map((id) => pkg.assets[id].name));
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
      card.className = "ft-node" + (node.repeat ? " ft-repeat" : "") + (node.type === "connector" ? " ft-connector" : "");
      const head = document.createElement("div");
      head.className = "ft-node-head";
      const icon = ftKindIcon(node.type);
      const name = document.createElement("span");
      name.className = "ft-name";
      name.textContent = node.name;
      head.append(icon, name, node.repeat ? ftChip("used above", "muted", "Listed in full further up") : ftChip(ftKind(node.type).label, "muted"));
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
  const nothing = !ftSel.packages.size && !ftSel.assets.size;
  ftEl("ftBrowseExportBtn").disabled = ftBusy || noSession || nothing;
  ftEl("ftBrowseCopyBtn").disabled = ftBusy || noSession || nothing;
  ftEl("ftRunBtn").disabled = ftBusy || !ftPlan;
  const hint = ftEl("ftSourceHint");
  hint.textContent = noSession ? "No Flow session yet: open Flow in a tab (or refresh the open Flow tab) and click in it once." : reason;
  hint.hidden = !hint.textContent;
}

async function refreshFlowTransferState() {
  const response = await send({ type: "GET_DESIGNER_STATUS" });
  if (!response.ok) return;
  const hadSession = ftDesigner.hasFlowToken;
  ftDesigner = { open: response.open, hasFlowToken: response.hasFlowToken };
  ftApplyState();
  if (!hadSession && ftDesigner.hasFlowToken && ftEl("ftBrowse").open && !ftEnvLoaded) ftEnvInit();
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
  a.download = `${ftRootLabel(pkg)}.flow.json`;
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

async function ftExport(message, names) {
  const response = await actionOrShowError(message);
  if (!response) return;
  if (names) response.pkg.label = FlowTree.exportName(names);
  ftDownload(response.pkg);
  ftShowWarnings(response.pkg);
  ftShowExportSummary(response.pkg);
}

async function ftCopy(message, names) {
  const response = await actionOrShowError(message);
  if (!response) return;
  if (names) response.pkg.label = FlowTree.exportName(names);
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

/* --- environment tree --- */

/** One expandable row. `load()` returns the child specs the first time it is opened. */
function ftEnvRow(spec) {
  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = `ft-env-row ft-env-${spec.kind}`;
  const twisty = document.createElement("button");
  twisty.className = "ft-twisty";
  twisty.textContent = "▸";
  twisty.setAttribute("aria-expanded", "false");
  twisty.disabled = !spec.load;
  row.appendChild(twisty);
  if (spec.selectKey) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.dataset.selectKey = spec.selectKey;
    box.addEventListener("change", () => ftEnvToggle(spec, box.checked));
    row.appendChild(box);
  }
  const kind = spec.kind === "org" ? { icon: "O", cls: "org", label: "Organisation" }
    : spec.kind === "package" ? (spec.packageId ? { icon: "P", cls: "package", label: "Package" } : { icon: "L", cls: "library", label: "App Library" })
    : ftKind(spec.type);
  const icon = document.createElement("span");
  icon.className = `ft-icon ft-icon-${kind.cls}`;
  icon.textContent = kind.icon;
  icon.title = kind.title || kind.label;
  const name = document.createElement("span");
  name.className = "ft-name";
  name.textContent = spec.name;
  name.title = spec.name;
  row.append(icon, name);
  if (spec.chip) row.appendChild(spec.chip);
  li.appendChild(row);

  let children = null;
  const open = async () => {
    const expanded = twisty.getAttribute("aria-expanded") === "true";
    twisty.setAttribute("aria-expanded", String(!expanded));
    if (children) {
      children.hidden = expanded;
      return;
    }
    children = document.createElement("ul");
    children.innerHTML = '<li class="ft-env-status">Loading…</li>';
    li.appendChild(children);
    const specs = await spec.load();
    children.innerHTML = "";
    if (!specs) { // the error banner has the details; say what to do right here
      children.innerHTML = "";
      const hint = document.createElement("li");
      hint.className = "ft-env-status ft-env-error";
      hint.textContent = "Could not load. Refresh the Flow tab and click in it once, then open this again.";
      children.appendChild(hint);
      const failed = children;
      children = null;
      twisty.setAttribute("aria-expanded", "false");
      setTimeout(() => failed.remove(), 8000);
      return;
    }
    if (!specs.length) { // nothing below: no arrow, no empty level
      children.remove();
      twisty.disabled = true;
      twisty.setAttribute("aria-expanded", "false");
      name.style.cursor = "";
      return;
    }
    for (const child of specs) {
      const childLi = ftEnvRow(child);
      children.appendChild(childLi);
      if (child.autoOpen) childLi.open();
    }
    ftEnvSync();
    ftEnvProbe(children, specs);
  };
  twisty.addEventListener("click", open);
  li.noChildren = () => { twisty.disabled = true; };
  name.addEventListener("click", () => { if (!twisty.disabled) open(); });
  li.open = open;
  return li;
}

/** After a level opens: asks, for the flows in it, whether they reference anything, and hides the
 *  arrow of those that don't. Only the opened level is read. */
async function ftEnvProbe(list, specs) {
  const flows = specs.filter((s) => s.asset && s.load);
  if (!flows.length) return;
  const response = await send({ type: "FT_REF_COUNTS", orgId: flows[0].org.id, itemIds: flows.map((s) => s.asset.id) });
  if (!response.ok) return;
  [...list.children].forEach((li, i) => {
    const spec = specs[i];
    if (spec && spec.asset && response.counts[spec.asset.id] === 0 && li.noChildren) li.noChildren();
  });
}

/** An asset row; flows open to what they reference (loaded on demand, at any depth). */
function ftEnvAsset(org, asset, packageKey, selectable) {
  const isModule = asset.type === "module";
  return {
    kind: selectable ? "asset" : "ref",
    name: asset.name,
    type: asset.type,
    selectKey: selectable ? `asset:${org.id}:${asset.id}` : null,
    org, asset, packageKey,
    load: isModule || asset.type === "unknown" ? null : async () => {
      const response = await actionOrShowError({ type: "FT_ASSET_REFS", orgId: org.id, itemId: asset.id });
      return response && response.assets.map((ref) => ftEnvAsset(org, ref, null, false));
    }
  };
}

/** Asset rows of a package, flows before modules, by name. */
function ftEnvAssetSpecs(org, assets, packageKey) {
  const sorted = assets.slice().sort((a, b) => (a.type === "module") - (b.type === "module") || a.name.localeCompare(b.name));
  return sorted.map((asset) => ftEnvAsset(org, asset, packageKey, true));
}

function ftEnvPackage(org, packageId, name) {
  const key = packageId || "";
  return {
    kind: "package", name, packageId, org,
    selectKey: `package:${org.id}:${key}`,
    load: async () => {
      const response = await actionOrShowError({ type: "FT_LIST_ASSETS", orgId: org.id, packageId: packageId || null });
      if (!response) return null;
      return ftEnvAssetSpecs(org, response.assets, key);
    }
  };
}

function ftEnvOrg(org) {
  return {
    kind: "org", name: org.name, org,
    load: async () => {
      const response = await actionOrShowError({ type: "FT_PACKAGES", orgId: org.id });
      if (!response) return null;
      return [ftEnvPackage(org, null, "App Library"), ...response.packages.map((p) => ftEnvPackage(org, p.id, p.name))];
    }
  };
}

const FT_NO_SESSION = "No Flow session yet. Open Flow in a tab (or refresh the open Flow tab) and click in it once. The list then loads by itself.";
const FT_SESSION_LOST = "Flow didn't answer. Refresh the Flow tab and click in it once, then Retry.";

/** Says why the environment tree is empty, with Open Flow and Retry, instead of a blank list. */
function ftEnvMessage(text, detail) {
  const tree = ftEl("ftEnvTree");
  tree.innerHTML = "";
  const li = document.createElement("li");
  li.className = "ft-env-hint banner banner-warning";
  const msg = document.createElement("span");
  msg.textContent = text;
  if (detail) msg.title = detail;
  const open = document.createElement("button");
  open.className = "btn-primary";
  open.textContent = "Open Flow";
  open.addEventListener("click", () => chrome.tabs.create({ url: "https://build.novacura.com/" }));
  const retry = document.createElement("button");
  retry.className = "btn-ghost";
  retry.textContent = "Retry";
  retry.addEventListener("click", () => { ftEnvLoaded = false; ftEnvInit(); });
  li.append(msg, open, retry);
  tree.appendChild(li);
}

/** Loads the organisations and opens the one of the active Designer tab (or the only one). */
async function ftEnvInit() {
  if (!ftDesigner.hasFlowToken) {
    ftEnvMessage(FT_NO_SESSION);
    return;
  }
  ftEnvLoaded = true;
  const tree = ftEl("ftEnvTree");
  tree.innerHTML = '<li class="ft-env-status">Loading…</li>';
  const [orgs, target] = await Promise.all([send({ type: "FT_ORGS" }), send({ type: "FT_DEFAULT_TARGET", excludeItemId: null })]);
  tree.innerHTML = "";
  if (!orgs.ok) {
    ftEnvLoaded = false;
    ftEnvMessage(FT_SESSION_LOST, orgs.error);
    return;
  }
  if (!orgs.orgs.length) {
    tree.innerHTML = '<li class="ft-env-status">Your Flow account has no organisations.</li>';
    return;
  }
  const t = target && target.ok ? target.target : null;
  ftEnvOrgs = orgs.orgs;
  ftEnvIndex.clear();
  for (const org of orgs.orgs) {
    const li = ftEnvRow(ftEnvOrg(org));
    tree.appendChild(li);
    if (orgs.orgs.length === 1 || (t && t.orgId === org.id)) li.open();
  }
  ftEnvSync();
  if (ftEl("ftEnvFilter").value.trim()) ftEnvFilter();
}

/* --- environment filter --- */

/** True when every word of the filter is in one of the texts (case-insensitive). */
function ftMatches(filter, ...texts) {
  const words = String(filter || "").toLowerCase().split(/\s+/).filter(Boolean);
  const hay = texts.join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Every package (and the App Library) of an organisation with its assets, loaded once. A failed
 *  load is forgotten so the next keystroke tries again. */
function ftEnvIndexOf(org) {
  if (!ftEnvIndex.has(org.id)) {
    const load = (async () => {
      const response = await send({ type: "FT_PACKAGES", orgId: org.id });
      if (!response.ok) return null;
      const packages = [{ id: null, name: "App Library" }, ...response.packages.map((p) => ({ id: p.id, name: p.name }))];
      const queue = packages.slice();
      const worker = async () => {
        while (queue.length) {
          const p = queue.shift();
          const list = await send({ type: "FT_LIST_ASSETS", orgId: org.id, packageId: p.id });
          p.assets = list.ok ? list.assets : [];
        }
      };
      await Promise.all([1, 2, 3, 4].map(worker));
      return packages;
    })();
    ftEnvIndex.set(org.id, load);
    load.then((v) => { if (!v) ftEnvIndex.delete(org.id); }, () => ftEnvIndex.delete(org.id));
  }
  return ftEnvIndex.get(org.id);
}

/** While the filter has text: only the packages whose name matches (with all their assets,
 *  closed) and the flows and modules whose name, or package name, matches (opened). The normal
 *  tree comes back when the filter is cleared; ticks are shared by both. */
async function ftEnvFilter() {
  const filter = ftEl("ftEnvFilter").value.trim();
  const seq = ++ftFilterSeq;
  const out = ftEl("ftEnvFiltered");
  ftEl("ftEnvTree").hidden = !!filter;
  out.hidden = !filter;
  if (!filter) {
    out.innerHTML = "";
    ftEnvSync();
    return;
  }
  if (!ftEnvOrgs.length) { // no session yet: the tree's banner says why
    ftEl("ftEnvTree").hidden = false;
    out.hidden = true;
    return;
  }
  if (!out.children.length) out.innerHTML = '<li class="ft-env-status">Searching…</li>';
  const indexes = await Promise.all(ftEnvOrgs.map((org) => ftEnvIndexOf(org).catch(() => null)));
  if (seq !== ftFilterSeq) return; // a newer keystroke is on its way
  out.innerHTML = "";
  let shown = 0;
  ftEnvOrgs.forEach((org, i) => {
    const packages = [];
    for (const p of indexes[i] || []) {
      const whole = ftMatches(filter, p.name);
      const assets = whole ? p.assets : p.assets.filter((a) => ftMatches(filter, a.name, p.name));
      if (!whole && !assets.length) continue;
      shown += whole ? 1 : assets.length;
      const spec = ftEnvPackage(org, p.id, p.name);
      spec.load = assets.length ? async () => ftEnvAssetSpecs(org, assets, p.id || "") : null;
      spec.autoOpen = !whole;
      packages.push(spec);
    }
    if (!packages.length) return;
    const li = ftEnvRow({ kind: "org", name: org.name, org, load: async () => packages });
    out.appendChild(li);
    li.open();
  });
  if (!shown) {
    const failed = indexes.some((x) => !x);
    out.innerHTML = `<li class="ft-env-status">${failed ? "Could not search every organisation. Refresh the Flow tab, click in it once, then type again." : "No package, flow or module matches."}</li>`;
  }
}

function ftEnvToggle(spec, checked) {
  if (checked && ftSel.orgId && ftSel.orgId !== spec.org.id) {
    showNotice(`Selection in ${ftSel.orgName} cleared: an export comes from one organisation.`);
    ftSel.packages.clear();
    ftSel.assets.clear();
  }
  if (checked) {
    ftSel.orgId = spec.org.id;
    ftSel.orgName = spec.org.name;
  }
  if (spec.kind === "package") {
    checked ? ftSel.packages.set(spec.packageId || "", spec.name) : ftSel.packages.delete(spec.packageId || "");
  } else {
    checked ? ftSel.assets.set(spec.asset.id, spec.asset.name) : ftSel.assets.delete(spec.asset.id);
  }
  if (!ftSel.packages.size && !ftSel.assets.size) ftSel.orgId = null;
  ftEnvSync();
}

/** Syncs the checkboxes with the selection; an asset in a ticked package shows as included. */
function ftEnvSync() {
  for (const box of document.querySelectorAll("#ftEnvTree input[data-select-key], #ftEnvFiltered input[data-select-key]")) {
    const [kind, orgId, id] = box.dataset.selectKey.split(":");
    const inOrg = orgId === ftSel.orgId;
    if (kind === "package") {
      box.checked = inOrg && ftSel.packages.has(id);
      continue;
    }
    const packageBox = box.closest("ul").closest("li").querySelector(":scope > .ft-env-row input[data-select-key]");
    const viaPackage = !!packageBox && packageBox.checked;
    box.checked = viaPackage || (inOrg && ftSel.assets.has(id));
    box.disabled = viaPackage;
    box.title = viaPackage ? "Included with its package" : "";
  }
  const parts = [];
  if (ftSel.packages.size) parts.push(`${ftSel.packages.size} package${ftSel.packages.size === 1 ? "" : "s"}`);
  if (ftSel.assets.size) parts.push(`${ftSel.assets.size} asset${ftSel.assets.size === 1 ? "" : "s"}`);
  ftEl("ftBrowseSelected").textContent = parts.length ? `${parts.join(" + ")} in ${ftSel.orgName}` : "Nothing selected";
  ftApplyState();
}

/** Selected package names first, then single assets, in the order they were ticked. */
function ftSelNames() {
  return [...ftSel.packages.values(), ...ftSel.assets.values()];
}

function ftBrowseMessage() {
  return {
    type: "FT_EXPORT",
    orgId: ftSel.orgId,
    packageIds: [...ftSel.packages.keys()].map((k) => k || null),
    assetIds: [...ftSel.assets.keys()]
  };
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
  ftEl("ftIfsBox").hidden = true;
  ftEl("ftIfs").innerHTML = "";
  const hasPackages = !!(pkg.packages && pkg.packages.length);
  ftLayout = { mode: hasPackages ? "packages" : "single", packageChoices: {} };
  ftEl("ftLayoutBox").hidden = !hasPackages;
  for (const radio of document.querySelectorAll('input[name="ftLayout"]')) radio.checked = radio.value === ftLayout.mode;
  ftApplyLayout();

  const roots = FlowTree.rootIdsOf(pkg);
  const t = await ftFillOrgs(ftEl("ftOrg"), mode === "copy" && roots.length === 1 ? roots[0] : null);
  ftEl("ftTargetHint").innerHTML = "";
  if (!ftEl("ftOrg").options.length) {
    ftEl("ftTargetHint").appendChild(ftChip(ftDesigner.hasFlowToken ? FT_SESSION_LOST : FT_NO_SESSION, "warn"));
    return;
  }
  if (t && t.fromOtherTab) ftEl("ftTargetHint").appendChild(ftChip(`From open tab: ${t.tabTitle}`, "info", "Preselected from another open Designer tab"));
  await ftFillPackages(ftEl("ftPackage"), ftEl("ftOrg").value, t && t.orgId === ftEl("ftOrg").value ? t.packageId : null);
  await ftLoadPlan();
}

async function ftLoadPlan() {
  const seq = ++ftPlanSeq;
  ftPlan = null;
  ftApplyState();
  ftApplyKeepLinked();
  const response = await actionOrShowError({ type: "FT_PLAN", pkg: ftPkg, orgId: ftEl("ftOrg").value, packageId: ftEl("ftPackage").value || null, layout: ftLayout });
  if (seq !== ftPlanSeq) return; // the target changed meanwhile
  if (!response) return;
  ftPlan = response.plan;
  // Keep the user's choices across a re-plan where the new target still allows them.
  const previous = ftChoices;
  ftChoices = {};
  ftNames = {};
  for (const row of ftPlan.assets) {
    ftChoices[row.id] = row.options.includes(previous[row.id]) ? previous[row.id] : row.choice;
    if (row.isRoot) ftNames[row.id] = row.newName;
  }
  ftRenderPackages();
  ftConnectorChoices = {};
  for (const row of ftPlan.connectors) ftConnectorChoices[row.source.id] = row.targetId || "";
  ftRenderPlan();
  ftApplyState();
}

function ftApplyLayout() {
  const byPackages = ftLayout.mode === "packages";
  ftEl("ftPackageField").hidden = byPackages;
  ftEl("ftPackagesBox").hidden = !byPackages;
}

/** Name of a plan row's target package: an id, null (App Library) or "new:<exported id>". */
function ftTargetPackageName(target) {
  if (!target) return "App Library";
  if (target.startsWith("new:")) {
    const p = ftPlan.packages.find((x) => `new:${x.source.id}` === target);
    return p ? p.newName : "new package";
  }
  const t = (ftPlan.targetPackages || []).find((x) => x.id === target);
  return t ? t.name : target;
}

/** The exported packages with their choice. */
function ftRenderPackages() {
  ftApplyLayout();
  const list = ftEl("ftPackages");
  list.innerHTML = "";
  if (!ftPlan || ftPlan.layout !== "packages") return;
  for (const p of ftPlan.packages) {
    const li = document.createElement("li");
    li.className = "ft-node";
    const head = document.createElement("div");
    head.className = "ft-node-head";
    const icon = document.createElement("span");
    icon.className = "ft-icon ft-icon-package";
    icon.textContent = "P";
    const name = document.createElement("span");
    name.className = "ft-name";
    name.textContent = p.source.name;
    head.append(icon, name, p.existing ? ftChip("Exists in target", "info") : ftChip("New in target", "ok"));
    const select = document.createElement("select");
    for (const option of p.options) ftOption(select, option, option === "use" ? "Use existing package" : `Create new package "${p.newName}"`);
    select.value = p.choice;
    select.disabled = p.options.length === 1;
    select.addEventListener("change", () => {
      ftLayout.packageChoices[p.source.id] = select.value;
      ftLoadPlan();
    });
    li.append(head, select);
    list.appendChild(li);
  }
}

/** The plan as the dependency tree: each asset's status chips and choice sit on its first card. */
function ftRenderPlan() {
  const rows = new Map(ftPlan.assets.map((row) => [row.id, row]));
  ftRenderTree(ftEl("ftAssets"), ftPkg, (node, card) => {
    const row = rows.get(node.id);
    if (!row) return;
    const code = row.sameCode === true ? ftChip("Same code", "ok") : row.sameCode === false ? ftChip("Code differs", "warn") : null;
    const ifs = row.ifsProjection ? ftChip(`IFS ${row.ifsProjection}`, "muted", "Generated from this IFS projection") : null;
    const where = ftPlan.layout === "packages" || !row.targetPackage ? ftChip(`→ ${ftTargetPackageName(row.targetPackage)}`, "muted", "Where it goes in the target") : null;
    card.appendChild(row.existing
      ? ftChipRow(ftChip(FT_LOCATION_CHIPS[row.existing.location] || row.existing.location, "info", `Matched by name: ${row.existing.name}`), code, ifs, where)
      : ftChipRow(ftChip("New in target", "ok", "Not in the target yet, will be created"), ifs, where));
    const select = document.createElement("select");
    for (const option of row.options) {
      const label = row.isRoot && option === "create" ? "Create new flow"
        : option === "regenerate" ? (row.existing ? "Update existing, generated from IFS" : "Create new, generated from IFS")
        : option === "create" && row.ifsProjection ? "Create new, copy code" : FT_CHOICE_LABELS[option];
      ftOption(select, option, label);
    }
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
    select.addEventListener("change", () => {
      ftChoices[row.id] = select.value;
      ftApplyIfsBox();
    });
  });
  ftApplyIfsBox();

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

/** The IFS instance picker shows while any module is set to "Generate from IFS". */
function ftApplyIfsBox() {
  const needed = !!ftPlan && ftPlan.assets.some((row) => ftChoices[row.id] === "regenerate");
  ftEl("ftIfsBox").hidden = !needed;
  if (!needed) return;
  const select = ftEl("ftIfs");
  if (!select.options.length) {
    ftOption(select, "", currentInstances.length ? "Pick an IFS instance…" : "No IFS instance saved (Basic Data)");
    for (const i of currentInstances) ftOption(select, i.baseUrl, i.name);
    if (currentBaseUrl && currentInstances.some((i) => i.baseUrl === currentBaseUrl)) select.value = currentBaseUrl;
  }
}

async function ftRunImport() {
  if (!ftPlan) return;
  const updates = ftPlan.assets.filter((row) => ftChoices[row.id] === "update" || (ftChoices[row.id] === "regenerate" && row.existing)).map((row) => row.existing.name);
  if (updates.length && !confirm(`This replaces the content of ${updates.join(", ")} in the target. Other flows using them see the change. Continue?`)) return;
  const names = {};
  for (const row of ftPlan.assets.filter((r) => r.isRoot && ftChoices[r.id] === "create")) {
    names[row.id] = (ftNames[row.id] || "").trim();
    if (!names[row.id]) {
      showError(`Enter a name for the new flow ${row.name}.`, true);
      return;
    }
  }
  const regenerating = ftPlan.assets.some((row) => ftChoices[row.id] === "regenerate");
  const baseUrl = regenerating ? ftEl("ftIfs").value : null;
  if (regenerating && !baseUrl) {
    showError('Pick the IFS instance to generate the "Generate from IFS" modules from.', true);
    return;
  }
  const connectorMap = {};
  for (const [id, target] of Object.entries(ftConnectorChoices)) connectorMap[id] = target || null;
  const response = await actionOrShowError({
    type: "FT_IMPORT", pkg: ftPkg, orgId: ftEl("ftOrg").value, packageId: ftEl("ftPackage").value || null, layout: ftLayout,
    choices: ftChoices, connectorMap, names, baseUrl, masterPassword: baseUrl ? masterPasswordOf() : undefined
  });
  if (!response) return;
  const keepLinked = !ftEl("ftKeepLinkedBox").hidden && ftEl("ftKeepLinked").checked;
  ftShowResult(response.outcome, keepLinked ? await ftLinkCopies(response.outcome) : null);
}

/** "Keep linked" is offered for a copy into another package of the organisation it came from:
 *  linked copies live in different packages of one organisation (Linked Flows tab). */
function ftApplyKeepLinked() {
  const pkg = ftPkg;
  const sameOrg = !!pkg && ftMode === "copy" && !!pkg.source && pkg.source.orgId === ftEl("ftOrg").value;
  const flows = sameOrg ? FlowTree.rootIdsOf(pkg).filter((id) => pkg.assets[id] && pkg.assets[id].type !== "module") : [];
  const box = ftEl("ftKeepLinkedBox");
  const show = flows.length > 0;
  if (box.hidden === show) ftEl("ftKeepLinked").checked = false; // fresh choice whenever it (re)appears
  box.hidden = !show;
}

/** After a copy with "Keep linked": links each copied flow with its original. */
async function ftLinkCopies(outcome) {
  const pkg = ftPkg;
  const out = [];
  for (const r of outcome.results.filter((x) => x.isRoot && x.type !== "module" && x.choice !== "use")) {
    const original = pkg.assets[r.id];
    const response = await send({ type: "LF_LINK", orgId: outcome.orgId, sourceId: r.id, adoptIds: [r.targetId], newPackageIds: [] });
    const row = response.ok ? response.outcome.results.find((x) => x.id === r.targetId) : null;
    out.push({ name: original ? original.name : r.name, ok: !!row && row.outcome === "linked", linkId: response.ok ? response.outcome.linkId : null, reason: !response.ok ? response.error : row && row.outcome !== "linked" ? row.reason : null });
  }
  return out;
}

function ftShowResult(outcome, links) {
  const pkg = ftPkg;
  const results = new Map(outcome.results.map((r) => [r.id, r]));
  ftHideViews();
  const box = ftEl("ftResult");
  box.innerHTML = "";
  const title = document.createElement("strong");
  title.textContent = `${ftMode === "copy" ? "Copied" : "Imported"} ${ftRootLabel(pkg)}`;
  const target = ftChipRow(
    ftChip(ftEl("ftOrg").selectedOptions[0].textContent, "info", "Target organisation"),
    ...(outcome.packages && outcome.packages.length
      ? outcome.packages.map((p) => ftChip(`${p.name}: ${p.choice === "create" ? "package created" : "existing package"}`, p.choice === "create" ? "ok" : "info"))
      : [ftChip(ftEl("ftPackage").selectedOptions[0].textContent, "info", "Target package")])
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
  for (const l of links || []) {
    box.appendChild(ftChipRow(l.ok
      ? ftChip(`${l.name}: linked with the original ⛓ ${l.linkId}`, "ok", "See it in the Linked Flows tab")
      : ftChip(`${l.name}: not linked. ${l.reason || ""}`.trim(), "warn")));
  }
  const note = document.createElement("p");
  note.className = "ft-note";
  note.textContent = "Modules and flows are committed as a new version.";
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

  ftEl("ftEnvFilter").addEventListener("input", () => {
    clearTimeout(ftFilterTimer);
    ftFilterTimer = setTimeout(ftEnvFilter, 150);
  });
  ftEl("ftBrowse").addEventListener("toggle", () => {
    if (ftEl("ftBrowse").open && !ftEnvLoaded) ftEnvInit();
  });
  ftEl("ftBrowseClear").addEventListener("click", () => {
    ftSel = { orgId: null, orgName: "", packages: new Map(), assets: new Map() };
    ftEnvSync();
  });
  ftEl("ftBrowseExportBtn").addEventListener("click", () => ftRun(ftEl("ftBrowseExportBtn"), "Exporting…", () => ftExport(ftBrowseMessage(), ftSelNames())));
  ftEl("ftBrowseCopyBtn").addEventListener("click", () => ftRun(ftEl("ftBrowseCopyBtn"), "Reading…", () => ftCopy(ftBrowseMessage(), ftSelNames())));

  ftEl("ftOrg").addEventListener("change", async () => {
    await ftFillPackages(ftEl("ftPackage"), ftEl("ftOrg").value, null);
    await ftLoadPlan();
  });
  ftEl("ftPackage").addEventListener("change", ftLoadPlan);
  for (const radio of document.querySelectorAll('input[name="ftLayout"]')) {
    radio.addEventListener("change", () => {
      ftLayout.mode = radio.value;
      ftApplyLayout();
      ftLoadPlan();
    });
  }
  ftEl("ftRunBtn").addEventListener("click", () => ftRun(ftEl("ftRunBtn"), ftMode === "copy" ? "Copying…" : "Importing…", ftRunImport));
  ftEl("ftCancelBtn").addEventListener("click", ftCancel);
  refreshFlowTransferState();
}
