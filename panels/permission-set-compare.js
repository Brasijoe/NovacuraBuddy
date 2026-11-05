// Compare Permission Sets tab: two IFS instances, the permission sets to compare (multi-select),
// what differs, and a previewed plan that creates / merges / syncs sets. Writes only after a second click.
const pscState = { sets: { A: [], B: [] }, data: null, plan: [], confirming: false, names: { A: "A", B: "B" } };

const pscEl = (id) => document.getElementById(id);
function pscHint(text) {
  const el = pscEl("pscHint");
  el.textContent = text || "";
  el.hidden = !text;
}
const pscUrl = (side) => pscEl(side === "A" ? "pscInstA" : "pscInstB").value;
const pscInstName = (side) => { const o = pscEl(side === "A" ? "pscInstA" : "pscInstB"); return o.selectedOptions[0] ? o.selectedOptions[0].text : side; };
const pscMode = () => pscEl("pscMode").value;
const pscRef = () => pscEl("pscRef").value;
const pscPicked = () => [...pscEl("pscSets").querySelectorAll("input:checked")].map((b) => b.value);

/** The sets of both instances as one list; each row says where it exists. */
function pscUnion() {
  const rows = new Map();
  for (const side of ["A", "B"]) for (const s of pscState.sets[side]) {
    if (!rows.has(s.id)) rows.set(s.id, { id: s.id, name: s.name, A: false, B: false });
    rows.get(s.id)[side] = true;
  }
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function pscRenderSets() {
  const box = pscEl("pscSets");
  const keep = new Set(pscPicked());
  box.innerHTML = "";
  const filter = pscEl("pscFilter").value.trim().toLowerCase();
  for (const s of pscUnion()) {
    const label = document.createElement("label");
    label.hidden = !!filter && !`${s.id} ${s.name}`.toLowerCase().includes(filter);
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = s.id;
    input.checked = keep.has(s.id);
    input.onchange = pscCount;
    const where = s.A && s.B ? "both" : s.A ? "only A" : "only B";
    label.append(input, document.createTextNode(` ${s.name === s.id ? s.id : `${s.id} — ${s.name}`} `));
    const tag = document.createElement("span");
    tag.className = "pc-sub";
    tag.textContent = `(${where})`;
    label.appendChild(tag);
    box.appendChild(label);
  }
  if (!box.childElementCount) box.textContent = "Choose both instances to list their permission sets.";
  pscCount();
}

function pscCount() {
  pscEl("pscCount").textContent = `${pscPicked().length} permission set(s) ticked`;
}

function pscTickVisible(on) {
  for (const label of pscEl("pscSets").querySelectorAll("label")) if (!label.hidden) label.querySelector("input").checked = on;
  pscCount();
}

function pscModeChanged() {
  const mode = pscMode();
  pscEl("pscRefRow").hidden = mode === "merge";
  pscEl("pscRemoveRow").hidden = mode !== "sync";
  const names = { A: pscInstName("A"), B: pscInstName("B") };
  for (const o of pscEl("pscRef").options) o.text = `${o.value === "A" ? "A" : "B"}: ${names[o.value]}`;
}

async function pscLoadSets(side) {
  const baseUrl = pscUrl(side);
  pscState.sets[side] = [];
  pscRenderSets();
  if (!baseUrl) return;
  pscHint(`Loading permission sets of ${pscInstName(side)}…`);
  const response = await send({ type: "PSC_SETS", baseUrl });
  if (pscUrl(side) !== baseUrl) return; // another instance was picked meanwhile
  if (!response.ok) return pscHint(explainLocked(response));
  pscHint("");
  pscState.sets[side] = response.sets;
  pscRenderSets();
}

async function pscInit() {
  const response = await send({ type: "LIST_INSTANCES" });
  if (!response.ok) return pscHint(response.error);
  const instances = response.instances.slice().sort((a, b) => a.name.localeCompare(b.name));
  for (const id of ["pscInstA", "pscInstB"]) {
    const select = pscEl(id);
    select.append(new Option("Choose an IFS instance…", ""));
    for (const i of instances) select.append(new Option(i.name, i.baseUrl));
    select.onchange = () => { pscModeChanged(); pscLoadSets(id === "pscInstA" ? "A" : "B"); };
  }
  pscModeChanged();
  pscRenderSets();
}

document.addEventListener("ifs-unlocked", () => { for (const side of ["A", "B"]) if (pscUrl(side) && !pscState.sets[side].length) pscLoadSets(side); });
pscEl("pscFilter").addEventListener("input", pscRenderSets);
pscEl("pscAll").addEventListener("click", () => pscTickVisible(true));
pscEl("pscNone").addEventListener("click", () => pscTickVisible(false));
pscEl("pscMode").addEventListener("change", pscModeChanged);

const pscList = (title, items, cls) => {
  if (!items.length) return null;
  const d = document.createElement("details");
  const s = document.createElement("summary");
  s.textContent = `${title} (${items.length})`;
  if (cls) s.className = cls;
  const ul = document.createElement("ul");
  ul.className = "pc-list";
  for (const x of items) { const li = document.createElement("li"); li.textContent = x; ul.appendChild(li); }
  d.append(s, ul);
  return d;
};

function pscRenderResult(rows) {
  const out = pscEl("pscResult");
  out.innerHTML = "";
  const nameA = pscInstName("A"), nameB = pscInstName("B");
  const same = rows.filter((r) => r.status === "same").length;
  const head = document.createElement("p");
  head.className = "list-count";
  head.textContent = `${rows.length} permission set(s) compared, ${same} identical.`;
  out.appendChild(head);
  for (const r of rows) {
    const card = document.createElement("div");
    card.className = "pc-card";
    const title = document.createElement("div");
    const label = { same: "✓ identical", differs: "differs", onlyA: `only in ${nameA}`, onlyB: `only in ${nameB}` }[r.status];
    title.innerHTML = "";
    const strong = document.createElement("strong");
    strong.textContent = r.role;
    const sub = document.createElement("span");
    sub.className = r.status === "same" ? "pc-sub pc-ok" : "pc-sub pc-missing";
    sub.textContent = ` ${label}`;
    title.append(strong, sub);
    card.appendChild(title);
    const p = r.projections;
    const lists = [
      pscList(`Projections only in ${nameA}`, p.onlyA, "pc-missing"),
      pscList(`Projections only in ${nameB}`, p.onlyB, "pc-missing"),
      pscList("Different access level", p.level.map((l) => `${l.projection}: ${nameA} ${l.A}, ${nameB} ${l.B}`), "pc-missing"),
      pscList(`Actions only in ${nameA}`, r.actions.onlyA.map((a) => `${a.projection} › ${a.action}`), "pc-missing"),
      pscList(`Actions only in ${nameB}`, r.actions.onlyB.map((a) => `${a.projection} › ${a.action}`), "pc-missing"),
      pscList("Same projections", p.both)
    ];
    for (const l of lists) if (l) card.appendChild(l);
    for (const side of ["A", "B"]) {
      const d = pscState.data[side][r.role];
      if (d && d.actionsError) {
        const w = document.createElement("div");
        w.className = "pc-sub";
        w.textContent = `Actions of ${side === "A" ? nameA : nameB} could not be read: ${d.actionsError}`;
        card.appendChild(w);
      }
    }
    out.appendChild(card);
  }
}

function pscChangeLabel(c) {
  const where = pscInstName(c.target);
  return c.type === "create" ? `Create permission set ${c.role} on ${where}`
    : c.type === "grant" ? `Grant ${c.projection} to ${c.role} on ${where}${c.access === "ReadOnly" ? " (reference has read-only; IFS grants Full for now)" : ""}`
    : `Remove ${c.projection} from ${c.role} on ${where}`;
}

function pscRenderPlan(results) {
  const box = pscEl("pscPlan");
  pscState.confirming = false;
  box.innerHTML = "";
  const resultOf = new Map((results || []).map((r) => [r.change, r]));
  const h = document.createElement("h4");
  h.textContent = "Planned changes";
  box.appendChild(h);
  const plan = pscState.plan;
  if (!plan.length) { box.appendChild(document.createTextNode("Nothing to change in this mode.")); return; }
  for (const [title, type] of [["Create", "create"], ["Grants", "grant"], ["Removals", "revoke"]]) {
    const list = plan.filter((c) => c.type === type);
    if (!list.length) continue;
    const sub = document.createElement("div");
    sub.className = "pc-sub";
    sub.textContent = `${title} (${list.length})`;
    const ul = document.createElement("ul");
    ul.className = "pc-list";
    for (const c of list) {
      const li = document.createElement("li");
      const r = resultOf.get(c);
      li.textContent = `${r ? (r.ok ? "✓ " : "✗ ") : ""}${pscChangeLabel(c)}${r && !r.ok ? ` — ${r.error}` : ""}`;
      if (type === "revoke") li.className = "pc-missing";
      ul.appendChild(li);
    }
    box.append(sub, ul);
  }
  const btn = document.createElement("button");
  btn.className = "btn-primary";
  btn.textContent = `Apply ${plan.length} change(s) in IFS`;
  btn.onclick = () => pscApply(btn);
  box.appendChild(btn);
}

/** Two clicks: the first states what will be written and where, the second writes it. */
async function pscApply(btn) {
  const plan = pscState.plan;
  if (!pscState.confirming) {
    pscState.confirming = true;
    const targets = ["A", "B"].filter((s) => plan.some((c) => c.target === s)).map(pscInstName);
    const removals = plan.filter((c) => c.type === "revoke").length;
    btn.textContent = `Click again to write ${plan.length} change(s) to ${targets.join(" and ")}${removals ? ` (${removals} removal(s))` : ""}`;
    return;
  }
  btn.disabled = true;
  btn.textContent = "Writing to IFS…";
  const results = [];
  let failed = null;
  for (const side of ["A", "B"]) {
    const mine = plan.filter((c) => c.target === side);
    if (!mine.length || failed) continue;
    const response = await send({ type: "PSC_APPLY", baseUrl: pscUrl(side), changes: mine.map(({ target, access, ...c }) => c) });
    if (!response.ok) { pscRenderPlan(results); return pscHint(explainLocked(response)); }
    response.results.forEach((r, i) => { results.push({ ...r, change: mine[i] }); if (!r.ok && !failed) failed = r; });
  }
  pscRenderPlan(results);
  pscHint(failed ? `Stopped at the first error: ${failed.error}` : `Applied ${results.length} change(s). Compare again to check.`);
}

pscEl("pscCompareBtn").addEventListener("click", async () => {
  const urls = { A: pscUrl("A"), B: pscUrl("B") };
  if (!urls.A || !urls.B) return pscHint("Choose both IFS instances.");
  if (urls.A === urls.B) return pscHint("Choose two different instances.");
  const roles = pscPicked();
  if (!roles.length) return pscHint("Tick at least one permission set.");
  // The click is the user gesture chrome.permissions.request needs; ask before any other await.
  const origins = [...new Set([urls.A, urls.B].map((u) => new URL(u).origin + "/*"))];
  if (!(await new Promise((resolve) => chrome.permissions.request({ origins }, resolve)))) return pscHint("Permission for the IFS instances was not granted.");
  pscHint("Reading permission sets from both instances…");
  pscEl("pscCompareBtn").disabled = true;
  const [a, b] = await Promise.all([send({ type: "PSC_READ", baseUrl: urls.A, roles }), send({ type: "PSC_READ", baseUrl: urls.B, roles })]);
  pscEl("pscCompareBtn").disabled = false;
  for (const r of [a, b]) if (!r.ok) return pscHint(explainLocked(r));
  pscHint("");
  pscState.data = { A: a.data, B: b.data };
  pscRenderResult(PermissionSetCompare.compareAll(roles, pscState.data));
  pscState.plan = PermissionSetCompare.buildPlan(roles, pscState.data, {
    mode: pscMode(), reference: pscRef(), createMissing: pscEl("pscCreate").checked, removeExtra: pscEl("pscRemove").checked
  });
  pscEl("pscOut").hidden = false;
  pscRenderPlan();
});

pscInit();
