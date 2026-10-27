// Permission Check tab. Step 1: scan the flow open in the Designer for the IFS projections it calls,
// per connector (a connector can run as the calling user or as the generic IAM client user).
let pcScan = null; // { flowName, connectors: [{ id, name, type, projections: [{ projection, via }] }], noConnector }
const PC_NONE = "__none__";

function pcHint(text) {
  const el = document.getElementById("pcHint");
  el.textContent = text || "";
  el.hidden = !text;
}

/** The overview groups: one per connector, plus the rows no connector step leads to. */
function pcGroups() {
  const groups = pcScan.connectors.map((c) => ({ id: c.id, title: c.name, subtitle: c.type || "", rows: c.projections }));
  if (pcScan.noConnector.length) groups.push({ id: PC_NONE, title: "No connector", subtitle: "direct calls and modules no connector step opens", rows: pcScan.noConnector });
  return groups;
}

const pcTicked = () => new Set([...document.querySelectorAll("#pcConnectors input[type=checkbox]:checked")].map((b) => b.value));

/** The distinct projections of the ticked groups. */
function pcSelectedProjections() {
  const ticked = pcTicked();
  const rows = new Map();
  for (const g of pcGroups()) if (ticked.has(g.id)) for (const r of g.rows) {
    if (!rows.has(r.projection)) rows.set(r.projection, new Set());
    for (const v of r.via) rows.get(r.projection).add(v);
  }
  return [...rows].map(([projection, assets]) => ({ projection, assets: [...assets].sort() })).sort((a, b) => a.projection.localeCompare(b.projection));
}

function pcSummary() {
  const n = pcSelectedProjections().length;
  document.getElementById("pcSummary").textContent = `${pcScan.flowName || "Open flow"}: ${n} projection(s) for the ticked connector(s).`;
}

/** One card per connector: tick box, name, and its projections with what leads to each one.
 *  `result` ({ missing, granted }) from a compare adds a status and the suggested permission sets. */
function pcRender(result) {
  const box = document.getElementById("pcConnectors");
  const ticked = box.childElementCount ? pcTicked() : null;
  box.innerHTML = "";
  const missing = result ? new Map(result.missing.map((r) => [r.projection, r])) : null;
  const granted = result ? new Map(result.granted.map((r) => [r.projection, r])) : null;
  const anyIfs = pcScan.connectors.some((c) => /ifs/i.test(`${c.name} ${c.type || ""}`));
  for (const g of pcGroups()) {
    const card = document.createElement("div");
    card.className = "pc-card";
    const head = document.createElement("label");
    head.className = "pc-card-head";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = g.id;
    input.checked = ticked ? ticked.has(g.id) : g.id === PC_NONE || !anyIfs || /ifs/i.test(`${g.title} ${g.subtitle}`);
    input.onchange = pcSummary;
    const title = document.createElement("strong");
    title.textContent = g.title;
    const sub = document.createElement("span");
    sub.className = "pc-sub";
    sub.textContent = ` ${g.subtitle ? g.subtitle + " · " : ""}${g.rows.length} projection(s)`;
    head.append(input, title, sub);
    card.appendChild(head);
    const ul = document.createElement("ul");
    ul.className = "pc-list";
    for (const r of g.rows) {
      const li = document.createElement("li");
      const miss = missing && missing.get(r.projection);
      const ok = granted && granted.get(r.projection);
      if (miss) li.className = "pc-missing";
      if (ok) li.className = "pc-ok";
      const name = document.createElement("span");
      name.textContent = `${miss ? "✗ " : ok ? "✓ " : ""}${r.projection}`;
      const via = document.createElement("span");
      via.className = "pc-sub";
      via.textContent = ` ${r.via.join(", ")}`;
      li.append(name, via);
      if (miss && miss.suggestions && miss.suggestions.length) {
        const sug = document.createElement("div");
        sug.className = "pc-sub";
        sug.textContent = `granted by: ${miss.suggestions.join(", ")}`;
        li.appendChild(sug);
      }
      if (ok && ok.via) {
        const sub2 = document.createElement("div");
        sub2.className = "pc-sub";
        sub2.textContent = `via ${ok.via}`;
        li.appendChild(sub2);
      }
      ul.appendChild(li);
    }
    card.appendChild(ul);
    box.appendChild(card);
  }
  if (!pcScan.connectors.length && !pcScan.noConnector.length) box.textContent = "No IFS projection calls found.";
  pcSummary();
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
  pcRender(null);
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
  pcRender(response);
  const out = document.getElementById("pcCompareOut");
  out.hidden = false;
  out.textContent = response.missing.length
    ? `${response.missing.length} of ${required.length} projection(s) are not granted (marked ✗ above).`
    : `All ${required.length} projection(s) are granted.`;
});

pcInitPicker();
