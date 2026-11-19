// Quick Reports tab, "Scan org for Quick Report usage": pick the Flow organisation and an IFS instance
// (for the Quick Report names), Scan. The scan runs from the results page (qr-usage.html), which opens
// in a new tab and shows its progress.
const qruEl = (id) => document.getElementById(id);
let qruOrgsLoaded = false;

function qruHint(text) {
  qruEl("qruHint").textContent = text || "";
  qruEl("qruHint").hidden = !text;
}

const qruSelection = () => ({ orgId: qruEl("qruOrgSelect").value, baseUrl: qruEl("qruInstanceSelect").value });

function qruOpenResults(sel, scan) {
  const q = new URLSearchParams({ orgId: sel.orgId, baseUrl: sel.baseUrl });
  q.set("org", qruEl("qruOrgSelect").selectedOptions[0].textContent);
  if (scan) q.set("scan", "1");
  chrome.tabs.create({ url: chrome.runtime.getURL(`qr-usage.html?${q}`) });
}

async function qruShowLast() {
  const sel = qruSelection();
  qruEl("qruScanBtn").disabled = !sel.orgId;
  const last = qruEl("qruLast");
  last.hidden = true;
  if (!sel.orgId) return;
  const key = `qrUsage:${sel.orgId}`;
  const { [key]: result } = await chrome.storage.local.get(key);
  const now = qruSelection();
  if (!result || now.orgId !== sel.orgId) return;
  last.textContent = `Last scan: ${new Date(result.scannedAt).toLocaleString()}, ${result.reports.length} Quick Report(s) in ${result.flowCount} flow(s). `;
  const open = document.createElement("a");
  open.href = "#";
  open.textContent = "Open";
  open.onclick = (e) => { e.preventDefault(); qruOpenResults(sel, false); };
  last.appendChild(open);
  last.hidden = false;
}

async function qruLoadInstances() {
  const select = qruEl("qruInstanceSelect");
  const previous = select.value;
  const response = await send({ type: "LIST_INSTANCES" });
  select.innerHTML = "";
  select.append(new Option("Without names", ""));
  if (!response.ok) return;
  const list = response.instances.slice().sort((a, b) => a.name.localeCompare(b.name));
  for (const i of list) select.append(new Option(i.name, i.baseUrl));
  if (list.some((i) => i.baseUrl === previous)) select.value = previous;
  else if (list.length === 1) select.value = list[0].baseUrl;
}

/** Fills the organisation list once Flow has a session (the 5s poll retries until it does). */
async function qruLoadOrgs() {
  const orgSelect = qruEl("qruOrgSelect");
  const [ctx, orgs] = await Promise.all([send({ type: "LF_CONTEXT" }), send({ type: "FT_ORGS" })]);
  const previous = orgSelect.value;
  const designerOrg = ctx.ok ? ctx.orgId : null;
  if (!orgs.ok || !orgs.orgs.length) {
    if (!orgSelect.options.length) orgSelect.append(new Option(designerOrg ? "Organisation of the open flow" : "No Flow session yet…", designerOrg || ""));
    qruEl("qruOrgHint").textContent = orgs.ok
      ? "Flow returned no organisations for your user."
      : "No Flow session yet: open Flow in a tab (or refresh the open Flow tab) and click in it once. The list fills in by itself.";
    qruEl("qruOrgHint").hidden = false;
    qruShowLast();
    return;
  }
  qruEl("qruOrgHint").hidden = true;
  orgSelect.innerHTML = "";
  orgSelect.append(new Option("Choose an organisation…", ""));
  for (const o of orgs.orgs) orgSelect.append(new Option(o.name, o.id));
  const wanted = previous || designerOrg || (orgs.orgs.length === 1 ? orgs.orgs[0].id : "");
  if (orgs.orgs.some((o) => o.id === wanted)) orgSelect.value = wanted;
  qruOrgsLoaded = true;
  qruShowLast();
}

async function qruOnShow() {
  qruHint("");
  await qruLoadInstances();
  await qruLoadOrgs();
}

function refreshQruState() {
  const panel = qruEl("panel-quick-reports");
  if (panel && !panel.hidden && !qruOrgsLoaded) qruLoadOrgs();
}

qruEl("qruOrgSelect").addEventListener("change", qruShowLast);

qruEl("qruScanBtn").addEventListener("click", async () => {
  const sel = qruSelection();
  if (!sel.orgId) return;
  if (sel.baseUrl) {
    const origin = new URL(sel.baseUrl).origin;
    // The click is the user gesture chrome.permissions.request needs; ask before any other await.
    const granted = await new Promise((resolve) => chrome.permissions.request({ origins: [origin + "/*"] }, resolve));
    if (!granted) return qruHint(`Permission for ${origin} was not granted — can't read the names from IFS there.`);
    const lock = await send({ type: "GET_LOCK_STATUS" });
    if (lock.ok && lock.passwordSet && !lock.unlocked) return qruHint("Saved credentials are locked — unlock them above, then scan.");
  }
  qruHint("");
  qruOpenResults(sel, true);
});
