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
    if (!rows.has(r.projection)) rows.set(r.projection, { assets: new Set(), access: "read" });
    const row = rows.get(r.projection);
    for (const v of r.via) row.assets.add(v);
    if (r.access === "write") row.access = "write";
  }
  return [...rows].map(([projection, r]) => ({ projection, assets: [...r.assets].sort(), access: r.access })).sort((a, b) => a.projection.localeCompare(b.projection));
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
  const state = result ? new Map(result.rows.map((r) => [r.projection, r])) : null;
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
      const st = state && state.get(r.projection);
      if (st) li.className = st.state === "ok" ? "pc-ok" : "pc-missing";
      const name = document.createElement("span");
      name.textContent = `${st ? (st.state === "ok" ? "✓ " : st.state === "low" ? "⚠ " : "✗ ") : ""}${r.projection} (${r.access === "write" ? "write" : "read"})`;
      const via = document.createElement("span");
      via.className = "pc-sub";
      via.textContent = ` ${r.via.join(", ")}`;
      li.append(name, via);
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
const pcUsers = new Map(); // baseUrl -> users, so picking an instance again refills the list

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
      if (!ready) pcHint("");
      pcModeChanged();
      const baseUrl = pcPicker.baseUrl();
      const list = document.getElementById("pcUserList");
      list.innerHTML = "";
      if (!ready || !baseUrl) return;
      if (!pcUsers.has(baseUrl)) {
        const response = await send({ type: "PC_TARGETS", baseUrl });
        if (!response.ok) return pcHint(explainLocked(response));
        pcUsers.set(baseUrl, response.users);
      }
      if (pcPicker.baseUrl() !== baseUrl) return; // another instance was picked meanwhile
      for (const u of pcUsers.get(baseUrl)) list.append(new Option(u.name === u.id ? u.id : `${u.id} — ${u.name}`, u.id));
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
  pcShowMapping(response);
});

// Mapping: per projection a dropdown of the permission sets it may sit in. The ones that grant it
// now are pre-selected; ticking more adds a grant, unticking removes one. Only a preview for now.
let pcMap = null; // { rows, assignable, selected: Map(projection -> Set(role)) }

function pcDropdown(row, assignable, onChange, store = "selected", label = "permission set(s)") {
  const details = document.createElement("details");
  details.className = "pc-dd";
  const summary = document.createElement("summary");
  details.appendChild(summary);
  const list = document.createElement("div");
  list.className = "pc-dd-list";
  const chosen = () => pcMap[store].get(row.projection);
  const refresh = () => { summary.textContent = chosen().size ? `${chosen().size} ${label}` : "none selected"; };
  for (const p of assignable) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = chosen().has(p.id);
    box.onchange = () => {
      const set = chosen();
      if (box.checked) set.add(p.id); else set.delete(p.id);
      refresh();
      onChange();
    };
    label.append(box, document.createTextNode(` ${p.name === p.id ? p.id : `${p.id} — ${p.name}`}`));
    list.appendChild(label);
  }
  if (!assignable.length) list.textContent = "No permission sets available.";
  details.appendChild(list);
  refresh();
  return details;
}

function pcShowMapping(response) {
  pcMap = { rows: response.rows, assignable: response.assignable, user: response.user, selected: new Map(response.rows.map((r) => [r.projection, new Set(r.current)])), give: new Map(response.rows.map((r) => [r.projection, new Set()])) };
  if (response.warning) pcHint(response.warning);
  const out = document.getElementById("pcCompareOut");
  out.hidden = false;
  out.innerHTML = "";
  const open = response.rows.filter((r) => r.state !== "ok");
  const done = response.rows.filter((r) => r.state === "ok");
  const head = document.createElement("p");
  head.className = "list-count";
  head.textContent = open.length
    ? `${open.length} of ${response.rows.length} projection(s) need a grant or a higher access level.`
    : `All ${response.rows.length} projection(s) are granted.`;
  out.appendChild(head);
  const preview = document.createElement("div");
  preview.className = "pc-preview";
  const section = (title, hint, rows) => {
    if (!rows.length) return;
    const h = document.createElement("h4");
    h.textContent = `${title} (${rows.length})`;
    h.title = hint;
    out.appendChild(h);
    const grid = document.createElement("div");
    grid.className = "pc-grid";
    for (const row of rows) {
      const name = document.createElement("div");
      name.className = "pc-proj" + (row.state === "ok" ? "" : " pc-missing");
      name.textContent = row.projection;
      const note = document.createElement("div");
      note.className = "pc-sub";
      note.textContent = `needs ${row.access === "write" ? "write (Full)" : "read (ReadOnly)"}` +
        (row.state === "low" ? " · granted read-only now" : "") + (row.state === "ok" && row.via ? ` · via ${row.via}` : "");
      name.appendChild(note);
      if (row.managed.length) {
        const m = document.createElement("div");
        m.className = "pc-sub";
        m.textContent = `Also granted by IFS-delivered: ${row.managed.join(", ")}`;
        name.appendChild(m);
      }
      const cell = document.createElement("div");
      cell.appendChild(pcDropdown(row, response.assignable, pcRenderPreview.bind(null, preview)));
      if (row.others.length) {
        const o = document.createElement("div");
        o.className = "pc-sub";
        o.textContent = `Other permission sets with this projection: ${row.others.join(", ")}`;
        name.appendChild(o);
        if (response.user) { // sets the user does not have yet can be given to the user
          const give = pcDropdown(row, row.others.map((id) => ({ id, name: id })), pcRenderPreview.bind(null, preview), "give", "to give to user");
          give.classList.add("pc-dd-give");
          give.querySelector("summary").title = "Give the user these permission sets";
          cell.appendChild(give);
        }
      }
      grid.append(name, cell);
    }
    out.appendChild(grid);
  };
  section("Not granted", "Missing, or granted read-only while the flow writes", open);
  section("Already granted", "Pre-selected are the permission sets that grant the projection now; untick to remove a grant", done);
  const ph = document.createElement("h4");
  ph.textContent = "Planned changes";
  out.append(ph, preview);
  pcRenderPreview(preview);
}

/** What the ticks would change: new grants and removed grants. A preview only: nothing is written to IFS. */
function pcRenderPreview(box) {
  box.innerHTML = "";
  const lines = [];
  for (const row of pcMap.rows) {
    const now = new Set(row.current), want = pcMap.selected.get(row.projection);
    for (const role of want) if (!now.has(role)) lines.push(`Grant ${row.projection} to ${role} (${row.access === "write" ? "Full" : "ReadOnly"})`);
    for (const role of now) if (!want.has(role)) lines.push(`Remove ${row.projection} from ${role}`);
  }
  const given = new Set();
  for (const roles of pcMap.give.values()) for (const role of roles) given.add(role);
  for (const role of given) lines.push(`Assign permission set ${role} to user ${pcMap.user}`);
  const ul = document.createElement("ul");
  ul.className = "pc-list";
  for (const l of lines) { const li = document.createElement("li"); li.textContent = l; ul.appendChild(li); }
  box.append(lines.length ? ul : document.createTextNode("No changes selected."));
  const note = document.createElement("div");
  note.className = "pc-sub";
  note.textContent = "Preview only: applying changes to IFS is not enabled yet.";
  box.appendChild(note);
}

pcInitPicker();
