// Permission Check tab. Step 1: scan the flow open in the Designer for the IFS projections it calls,
// per connector (a connector can run as the calling user or as the generic IAM client user).
let pcScan = null; // { flowName, projections, connectors, unassigned }
const PC_MODULES = "__modules__";

function pcHint(text) {
  const el = document.getElementById("pcHint");
  el.textContent = text || "";
  el.hidden = !text;
}

/** The projections of the ticked connectors (and the modules entry), each with who uses it. */
function pcSelectedProjections() {
  const ticked = new Set([...document.querySelectorAll("#pcConnectors input:checked")].map((b) => b.value));
  const rows = new Map();
  const add = (projection, assets) => {
    if (!rows.has(projection)) rows.set(projection, new Set());
    for (const a of assets) rows.get(projection).add(a);
  };
  for (const c of pcScan.connectors) if (ticked.has(c.id)) for (const p of c.projections) add(p, c.assets);
  if (ticked.has(PC_MODULES)) for (const r of pcScan.unassigned) add(r.projection, r.assets);
  return [...rows].map(([projection, assets]) => ({ projection, assets: [...assets].sort() })).sort((a, b) => a.projection.localeCompare(b.projection));
}

function pcRenderList() {
  const list = document.getElementById("pcList");
  list.innerHTML = "";
  const rows = pcSelectedProjections();
  for (const { projection, assets } of rows) {
    const li = document.createElement("li");
    li.textContent = `${projection} — used by ${assets.join(", ")}`;
    list.appendChild(li);
  }
  document.getElementById("pcSummary").textContent = `${pcScan.flowName || "Open flow"}: ${rows.length} projection(s) for the selected connectors.`;
}

function pcRenderConnectors() {
  const box = document.getElementById("pcConnectors");
  box.innerHTML = "";
  const addRow = (value, text, checked) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = value;
    input.checked = checked;
    input.onchange = pcRenderList;
    label.append(input, document.createTextNode(` ${text}`));
    box.appendChild(label);
  };
  const looksIfs = (c) => /ifs/i.test(`${c.name} ${c.type || ""}`);
  const anyIfs = pcScan.connectors.some(looksIfs);
  for (const c of pcScan.connectors) addRow(c.id, `${c.name}${c.type ? ` (${c.type})` : ""} — ${c.projections.length} projection(s)`, !anyIfs || looksIfs(c));
  if (pcScan.unassigned.length) addRow(PC_MODULES, `Modules (no connector) — ${pcScan.unassigned.length} projection(s)`, true);
  if (!pcScan.connectors.length && !pcScan.unassigned.length) box.textContent = "No connectors or modules calling IFS found.";
}

document.getElementById("pcScanBtn").addEventListener("click", async () => {
  const btn = document.getElementById("pcScanBtn");
  btn.disabled = true;
  document.getElementById("pcResult").hidden = true;
  pcHint("Reading the flow and everything it uses…");
  const response = await send({ type: "PC_SCAN" });
  btn.disabled = false;
  if (!response.ok) return pcHint(response.error);
  pcHint("");
  pcScan = response;
  pcRenderConnectors();
  pcRenderList();
  document.getElementById("pcResult").hidden = false;
});

// Compare with IFS (read-only): the projections of the ticked connectors against one user's or some
// permission sets' grants.
let pcPicker = null;
let pcUsersFor = null;

function pcMode() { return document.querySelector("input[name=pcMode]:checked").value; }

function pcModeChanged() {
  const user = pcMode() === "user";
  document.getElementById("pcUser").hidden = !user;
  document.querySelector("#pcPicker .checklist").hidden = user;
}
for (const r of document.querySelectorAll("input[name=pcMode]")) r.addEventListener("change", pcModeChanged);

function pcInitPicker() {
  if (pcPicker) return;
  pcPicker = renderPermissionPicker(document.getElementById("pcPicker"), {
    send, onError: pcHint, emptySetsText: "No customer permission sets found.",
    onChange: async (ready) => {
      pcModeChanged();
      const baseUrl = pcPicker.baseUrl();
      const list = document.getElementById("pcUserList");
      list.innerHTML = "";
      if (!ready || !baseUrl || pcUsersFor === baseUrl) return;
      const response = await send({ type: "PC_TARGETS", baseUrl });
      if (!response.ok) return pcHint(response.error);
      pcUsersFor = baseUrl;
      for (const u of response.users) list.append(new Option(u.name === u.id ? u.id : `${u.id} — ${u.name}`, u.id));
    }
  });
}

document.getElementById("pcCompareBtn").addEventListener("click", async () => {
  const baseUrl = pcPicker.baseUrl();
  if (!baseUrl) return pcHint("Choose an IFS installation first.");
  const required = pcSelectedProjections();
  if (!required.length) return pcHint("No projections selected.");
  const user = document.getElementById("pcUser").value.trim();
  const roles = pcPicker.selectedIds();
  if (pcMode() === "user" ? !user : !roles.length) return pcHint(pcMode() === "user" ? "Enter an IFS user." : "Tick at least one permission set.");
  const origin = new URL(baseUrl).origin;
  // The click is the user gesture chrome.permissions.request needs; ask before any other await.
  const granted = await new Promise((resolve) => chrome.permissions.request({ origins: [origin + "/*"] }, resolve));
  if (!granted) return pcHint(`Permission for ${origin} was not granted.`);
  pcHint("Reading grants from IFS…");
  const response = await send({ type: "PC_COMPARE", baseUrl, required, ...(pcMode() === "user" ? { user } : { roles }) });
  if (!response.ok) return pcHint(explainLocked(response));
  pcHint("");
  const out = document.getElementById("pcCompareOut");
  out.hidden = false;
  out.innerHTML = "";
  const head = document.createElement("p");
  head.className = "list-count";
  head.textContent = response.missing.length
    ? `${response.missing.length} of ${required.length} projection(s) not granted.`
    : `All ${required.length} projection(s) are granted.`;
  out.appendChild(head);
  const ul = document.createElement("ul");
  ul.className = "checklist";
  for (const r of response.missing) {
    const li = document.createElement("li");
    li.textContent = `Missing: ${r.projection}${r.suggestions && r.suggestions.length ? ` — granted by ${r.suggestions.join(", ")}` : ""}`;
    ul.appendChild(li);
  }
  for (const r of response.granted) {
    const li = document.createElement("li");
    li.textContent = `OK: ${r.projection}${r.via ? ` (via ${r.via})` : ""}`;
    ul.appendChild(li);
  }
  out.appendChild(ul);
});

pcInitPicker();
