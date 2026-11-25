// Entity Check tab: scan the open flow / a package / an organisation for the IFS projections
// ("entities") in use, check each one's Active state in an IFS instance, and switch single ones
// on or off after a confirmation. The shown state always starts from IFS.
const ecEl = (id) => document.getElementById(id);
let ecRows = [];          // [{ projection, usedIn, state, deprecated, component }]
let ecBaseUrl = "";       // the instance the rows were checked against
let ecFilter = "all";     // all | enabled | disabled | missing
let ecBusy = false;
let ecHasToken = false;
let ecHasFlow = false;
let ecConfirm = null;     // { projection, active } waiting for the user's confirmation
const EC_STATES = { enabled: "Enabled", disabled: "Disabled", missing: "Not found" };

let ecPicker = null;
const ecInstanceUrl = () => (ecPicker ? ecPicker.baseUrl() : "");
const ecScope = () => document.querySelector("input[name=ecScope]:checked").value;

function ecHint(text) {
  ecEl("ecHint").textContent = text || "";
  ecEl("ecHint").hidden = !text;
}

function ecUpdateControls() {
  const scope = ecScope();
  ecEl("ecOrg").hidden = scope === "current";
  ecEl("ecPackage").hidden = scope !== "package";
  ecEl("ecOrg").disabled = !ecHasToken;
  ecEl("ecPackage").disabled = !ecHasToken;
  const scopeOk = scope === "current" ? ecHasFlow : !!ecEl("ecOrg").value && (scope === "org" || !!ecEl("ecPackage").value);
  ecEl("ecScanBtn").disabled = ecBusy || !scopeOk || !ecInstanceUrl();
  if (scope === "current" && !ecHasFlow) ecHint("Open a flow in the Flow Designer tab (build.novacura.com), then Refresh.");
  else if (ecEl("ecHint").textContent.startsWith("Open a flow")) ecHint("");
}

async function ecLoad() {
  ecEl("ecRefreshBtn").disabled = true;
  try {
    const [ctx, orgs] = await Promise.all([send({ type: "FLOW_CONTEXT" }), send({ type: "FT_ORGS" })]);
    if (!ecPicker) ecPicker = renderPermissionPicker(ecEl("ecPicker"), { send, onError: ecHint, emptySetsText: "No customer permission sets found.", onChange: () => ecUpdateControls() });
    ecHasFlow = !!(ctx.ok && ctx.itemId);
    ecHasToken = !!(ctx.ok && ctx.hasFlowToken && orgs.ok);
    const chip = ecEl("ecSession");
    chip.className = `ft-chip ft-chip-${ecHasToken ? "ok" : "warn"}`;
    chip.textContent = ecHasToken ? "Flow session found" : "No Flow session";
    chip.title = ecHasToken ? "" : "Open Flow in a tab and click in it once, then Refresh.";
    ecEl("ecScopeCard").classList.toggle("is-disabled", !ecHasToken);
    const org = ecEl("ecOrg");
    const prevOrg = org.value;
    org.innerHTML = "";
    if (ecHasToken) {
      org.append(new Option("Choose an organisation…", ""));
      for (const o of orgs.orgs) org.append(new Option(o.name, o.id));
      const want = prevOrg || ctx.orgId || (orgs.orgs.length === 1 ? orgs.orgs[0].id : "");
      if (orgs.orgs.some((o) => o.id === want)) org.value = want;
    } else org.append(new Option("Open Flow in a tab, then Refresh", ""));
    await ecLoadPackages();
  } finally {
    ecEl("ecRefreshBtn").disabled = false;
    ecUpdateControls();
  }
}

async function ecLoadPackages() {
  const select = ecEl("ecPackage");
  const prev = select.value;
  select.innerHTML = "";
  select.append(new Option("Choose a package…", ""));
  const orgId = ecEl("ecOrg").value;
  if (!orgId || !ecHasToken) return;
  const r = await send({ type: "FT_PACKAGES", orgId });
  if (ecEl("ecOrg").value !== orgId || !r.ok) return;
  for (const p of r.packages) select.append(new Option(p.name, p.id));
  if (r.packages.some((p) => p.id === prev)) select.value = prev;
}

function ecOnShow() { ecLoad(); }

// ---- scanning --------------------------------------------------------------------------------

async function ecPool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

/** -> Map projection name -> Set(where used). */
async function ecScan() {
  const scope = ecScope();
  if (scope === "current") {
    ecHint("Reading the flow and everything it uses…");
    const r = await send({ type: "EC_SCAN_CURRENT" });
    if (!r.ok) throw new Error(r.error);
    const usage = new Map();
    for (const u of r.usage) usage.set(u.projection, new Set(u.where));
    return usage;
  }
  const orgId = ecEl("ecOrg").value, packageId = scope === "package" ? ecEl("ecPackage").value : "";
  ecHint("Listing flows and modules…");
  const list = await send({ type: "EC_ASSETS", orgId, packageId });
  if (!list.ok) throw new Error(list.error);
  const assets = list.assets;
  const usage = new Map();
  let done = 0, failed = 0;
  await ecPool(assets, 4, async (a) => {
    const r = await send({ type: "EC_ASSET", orgId, assetId: a.id, versionId: a.versionId, assetType: a.type });
    if (r.ok) EntityCheck.addUsage(usage, r.names, `${a.name}${a.packageName ? ` (${a.packageName})` : ""}`);
    else failed++;
    ecHint(`Reading flows and modules… ${++done} of ${assets.length}`);
  });
  if (failed) ecHint(`${failed} of ${assets.length} item(s) could not be read.`);
  return usage;
}

ecEl("ecScanBtn").addEventListener("click", async () => {
  ecBusy = true;
  ecUpdateControls();
  ecEl("ecResultCard").hidden = true;
  const baseUrl = ecInstanceUrl();
  ecBusy = true;
  try {
    const usage = await ecScan();
    if (!usage.size) { ecHint("No IFS projections found in the scanned flows."); return; }
    ecHint(`Checking ${usage.size} projection(s) in IFS…`);
    const st = await send({ type: "EC_STATUS", baseUrl, names: [...usage.keys()] });
    if (!st.ok) throw new Error(st.error);
    ecRows = EntityCheck.buildRows(usage, st.meta);
    ecBaseUrl = baseUrl;
    ecConfirm = null;
    ecHint("");
    ecEl("ecResultCard").hidden = false;
    ecRender();
  } catch (e) {
    ecHint(e.message);
  } finally {
    ecBusy = false;
    ecUpdateControls();
  }
});

// ---- results ---------------------------------------------------------------------------------

function ecRender() {
  const counts = { enabled: 0, disabled: 0, missing: 0 };
  for (const r of ecRows) counts[r.state]++;
  const sum = ecEl("ecSummary");
  sum.innerHTML = "";
  const chip = (cls, text) => { const c = document.createElement("span"); c.className = `ft-chip ${cls}`; c.textContent = text; return c; };
  sum.append(chip("ft-chip-info", `${ecRows.length} found`), chip("ft-chip-ok", `${counts.enabled} enabled`),
    chip(counts.disabled ? "ft-chip-warn" : "ft-chip-muted", `${counts.disabled} disabled`), chip(counts.missing ? "ft-chip-warn" : "ft-chip-muted", `${counts.missing} not found`));
  const f = ecEl("ecFilters");
  f.innerHTML = "";
  for (const [key, label] of [["all", "All"], ["enabled", "Enabled"], ["disabled", "Disabled"], ["missing", "Not found"]]) {
    const b = document.createElement("button");
    b.className = `btn-ghost ec-filter${ecFilter === key ? " is-active" : ""}`;
    b.textContent = label;
    b.onclick = () => { ecFilter = key; ecRender(); };
    f.appendChild(b);
  }
  ecRenderList();
}

function ecRenderList() {
  const query = ecEl("ecSearch").value;
  const shown = ecRows.filter((r) => (ecFilter === "all" || r.state === ecFilter) && EntityCheck.matches(r, query));
  ecEl("ecCount").textContent = `${shown.length} of ${ecRows.length} shown`;
  const list = ecEl("ecList");
  list.innerHTML = "";
  if (!shown.length) { list.innerHTML = '<p class="api-hint">Nothing matches.</p>'; return; }
  for (const r of shown) {
    const row = document.createElement("div");
    row.className = `ec-row ec-${r.state}`;
    const main = document.createElement("div");
    main.className = "ec-main";
    const name = document.createElement("strong");
    name.textContent = r.projection;
    const status = document.createElement("span");
    status.className = `ft-chip ${r.state === "enabled" ? "ft-chip-ok" : r.state === "disabled" ? "ft-chip-warn" : "ft-chip-muted"}`;
    status.textContent = EC_STATES[r.state] + (r.deprecated ? " · deprecated" : "");
    main.append(name, status);
    const sub = document.createElement("div");
    sub.className = "pc-sub ec-sub";
    const used = r.usedIn.filter(Boolean);
    sub.textContent = [r.component, used.length ? `used in ${used.slice(0, 3).join(", ")}${used.length > 3 ? ` +${used.length - 3}` : ""}` : ""].filter(Boolean).join(" · ");
    sub.title = used.join("\n");
    const left = document.createElement("div");
    left.className = "ec-left";
    left.append(main, sub);
    row.appendChild(left);
    if (r.state !== "missing") {
      const sw = document.createElement("label");
      sw.className = "toggle";
      sw.title = r.state === "enabled" ? "Switch off in IFS" : "Switch on in IFS";
      sw.innerHTML = '<input type="checkbox"><span class="toggle-track"><span class="toggle-thumb"></span></span>';
      const input = sw.querySelector("input");
      input.checked = r.state === "enabled";
      input.onclick = (e) => { e.preventDefault(); ecConfirm = { projection: r.projection, active: r.state !== "enabled" }; ecRenderList(); };
      row.appendChild(sw);
    }
    list.appendChild(row);
    if (ecConfirm && ecConfirm.projection === r.projection) {
      const box = document.createElement("div");
      box.className = "ec-confirm";
      const t = document.createElement("span");
      t.textContent = `${ecConfirm.active ? "Enable" : "Disable"} ${r.projection} in IFS?`;
      const ok = document.createElement("button");
      ok.className = "btn-primary";
      ok.textContent = ecConfirm.active ? "Enable" : "Disable";
      ok.onclick = () => ecApply(r, ecConfirm.active, ok);
      const no = document.createElement("button");
      no.className = "btn-ghost";
      no.textContent = "Cancel";
      no.onclick = () => { ecConfirm = null; ecRenderList(); };
      box.append(t, ok, no);
      list.appendChild(box);
    }
  }
}

async function ecApply(row, active, btn) {
  btn.disabled = true;
  btn.textContent = "Working…";
  const r = await send({ type: "EC_SET", baseUrl: ecBaseUrl, projection: row.projection, active, roles: active && ecPicker ? ecPicker.selectedIds() : [] });
  ecConfirm = null;
  if (r.ok) {
    row.state = EntityCheck.stateOf(r.row);
    const failed = (r.grants || []).filter((g) => !g.ok);
    const granted = (r.grants || []).length - failed.length;
    ecHint(failed.length ? `${row.projection}: not granted to ${failed.map((g) => `${g.role} (${g.error})`).join(", ")}` : granted ? `${row.projection} granted to ${granted} permission set(s).` : "");
  }
  else ecHint(`${row.projection}: ${r.error}`);
  ecRender();
}

ecEl("ecSearch").addEventListener("input", ecRenderList);
ecEl("ecRefreshBtn").addEventListener("click", ecLoad);
for (const r of document.querySelectorAll("input[name=ecScope]")) r.addEventListener("change", ecUpdateControls);
ecEl("ecOrg").addEventListener("change", () => { ecLoadPackages().then(ecUpdateControls); });
ecEl("ecPackage").addEventListener("change", ecUpdateControls);
document.addEventListener("ifs-unlocked", () => { if (!ecEl("panel-entity-check").hidden) ecLoad(); });
