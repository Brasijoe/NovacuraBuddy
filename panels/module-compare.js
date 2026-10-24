// Module Compare tab: pick the Flow organisation, optionally one package, and the upgraded IFS
// instance, then Scan. The scan runs from the results page (module-compare.html), which opens in
// a new tab and shows its progress.
const mcEl = (id) => document.getElementById(id);

function mcHint(text) {
  mcEl("mcHint").textContent = text || "";
  mcEl("mcHint").hidden = !text;
}

function mcSelection() {
  return { orgId: mcEl("mcOrgSelect").value, packageId: mcEl("mcPackageSelect").value, baseUrl: mcEl("mcInstanceSelect").value };
}

function mcUpdateScanBtn() {
  const { orgId, baseUrl } = mcSelection();
  mcEl("mcScanBtn").disabled = !orgId || !baseUrl;
}

function mcOpenResults(sel, scan) {
  const q = new URLSearchParams({ orgId: sel.orgId, packageId: sel.packageId || "", baseUrl: sel.baseUrl });
  q.set("org", mcEl("mcOrgSelect").selectedOptions[0].textContent);
  q.set("pkg", mcEl("mcPackageSelect").selectedOptions[0].textContent);
  if (scan) q.set("scan", "1");
  chrome.tabs.create({ url: chrome.runtime.getURL(`module-compare.html?${q}`) });
}

async function mcShowLast() {
  mcUpdateScanBtn();
  const last = mcEl("mcLast");
  last.hidden = true;
  const sel = mcSelection();
  if (!sel.orgId || !sel.baseUrl) return;
  const response = await send({ type: "MC_LAST_RESULT", ...sel });
  const now = mcSelection();
  if (now.orgId !== sel.orgId || now.packageId !== sel.packageId || now.baseUrl !== sel.baseUrl || !response.ok || !response.result) return;
  const changed = response.result.modules.filter((m) => m.status === "changed").length;
  last.textContent = `Last scan: ${new Date(response.result.scannedAt).toLocaleString()}, ${changed} of ${response.result.modules.length} module(s) changed. `;
  const open = document.createElement("a");
  open.href = "#";
  open.textContent = "Open";
  open.onclick = (e) => { e.preventDefault(); mcOpenResults(sel, false); };
  last.appendChild(open);
  last.hidden = false;
}

async function mcLoadPackages() {
  const select = mcEl("mcPackageSelect");
  const previous = select.value;
  select.innerHTML = "";
  select.append(new Option("All packages", ""));
  const orgId = mcEl("mcOrgSelect").value;
  if (!orgId) return mcShowLast();
  const response = await send({ type: "FT_PACKAGES", orgId });
  if (mcEl("mcOrgSelect").value !== orgId) return;
  if (!response.ok) return mcHint(response.error);
  for (const p of response.packages) select.append(new Option(p.name, p.id));
  if (response.packages.some((p) => p.id === previous)) select.value = previous;
  mcShowLast();
}

async function mcOnShow() {
  const [ctx, orgs, instances] = await Promise.all([send({ type: "LF_CONTEXT" }), send({ type: "FT_ORGS" }), send({ type: "LIST_INSTANCES" })]);
  mcHint("");
  const orgSelect = mcEl("mcOrgSelect");
  const previousOrg = orgSelect.value;
  orgSelect.innerHTML = "";
  if (!orgs.ok) {
    orgSelect.hidden = true;
    mcHint(orgs.error || "Open a flow in the Flow Designer tab first: the organisations are read from Flow.");
  } else {
    orgSelect.hidden = false;
    orgSelect.append(new Option("Choose an organisation…", ""));
    for (const o of orgs.orgs) orgSelect.append(new Option(o.name, o.id));
    const wanted = previousOrg || (ctx.ok && ctx.orgId) || (orgs.orgs.length === 1 ? orgs.orgs[0].id : "");
    if (orgs.orgs.some((o) => o.id === wanted)) orgSelect.value = wanted;
  }
  const instSelect = mcEl("mcInstanceSelect");
  const previousInst = instSelect.value;
  instSelect.innerHTML = "";
  if (!instances.ok) mcHint(instances.error);
  else if (!instances.instances.length) { instSelect.hidden = true; mcHint("No IFS instances yet — add one in Basic Data."); }
  else {
    instSelect.hidden = false;
    instSelect.append(new Option("Choose an IFS instance…", ""));
    const list = instances.instances.slice().sort((a, b) => a.name.localeCompare(b.name));
    for (const i of list) instSelect.append(new Option(i.name, i.baseUrl));
    if (list.some((i) => i.baseUrl === previousInst)) instSelect.value = previousInst;
    else if (list.length === 1) instSelect.value = list[0].baseUrl;
  }
  await mcLoadPackages();
}

mcEl("mcOrgSelect").addEventListener("change", mcLoadPackages);
mcEl("mcPackageSelect").addEventListener("change", mcShowLast);
mcEl("mcInstanceSelect").addEventListener("change", mcShowLast);

mcEl("mcScanBtn").addEventListener("click", async () => {
  const sel = mcSelection();
  if (!sel.orgId || !sel.baseUrl) return;
  const origin = new URL(sel.baseUrl).origin;
  // The click is the user gesture chrome.permissions.request needs; ask before any other await.
  const granted = await new Promise((resolve) => chrome.permissions.request({ origins: [origin + "/*"] }, resolve));
  if (!granted) return mcHint(`Permission for ${origin} was not granted — can't read IFS there.`);
  const lock = await send({ type: "GET_LOCK_STATUS" });
  if (lock.ok && lock.passwordSet && !lock.unlocked) return mcHint("Saved credentials are locked — unlock them above, then scan.");
  mcHint("");
  mcOpenResults(sel, true);
});
