/* Copy & link tab (linked-copy.html), opened from the Linked Flows side panel. Two panes: the
 * source flow on the left, the target packages on the right, then the plan and the run button.
 * Runs on top of panels/linked-flows.js (scan, statuses, results view) and its LF_PLAN_LINK /
 * LF_LINK messages. */

const lc = {
  sourceId: null,
  srcFilter: "",
  tgtFilter: "",
  choice: new Map(), // package id -> "copy" | "link"
  plan: null,
  seq: 0,
  timer: null
};

const lcSource = () => (lc.sourceId ? lfAsset(lc.sourceId) : null);
const lcSameName = (a, b) => a.name.toUpperCase() === b.name.toUpperCase();

/* --- source pane --- */

function lcRenderSource() {
  const root = lfEl("lcSource");
  root.innerHTML = "";
  if (!lf.scan) { root.appendChild(lfH("span", { className: "ft-env-status", textContent: "Reading packages…" })); return; }
  const src = lcSource();
  if (src) {
    root.appendChild(lfH("div", { className: "lc-picked" },
      ftKindIcon(src.type),
      lfH("span", { className: "lc-picked-text" }, lfH("strong", { textContent: src.name }), lfH("span", { className: "api-hint", textContent: src.packageName })),
      src.tag ? ftChip(`⛓ ${src.tag.id}`, "info", "Already linked: new copies join this group") : ftChip("Not linked yet", "muted")));
  }
  const filter = lfH("input", { type: "search", className: "lf-filter", placeholder: "Filter flows and packages…", autocomplete: "off", value: lc.srcFilter });
  filter.addEventListener("input", () => { lc.srcFilter = filter.value; lcRenderSourceList(list); });
  root.appendChild(filter);
  const list = lfH("div", { className: "lc-list" });
  root.appendChild(list);
  lcRenderSourceList(list);
}

/** Flows with the same name in several packages that aren't one group yet: usually today's
 *  hand-made duplicates, offered first. */
function lcSuggestions() {
  const byName = new Map();
  for (const a of lfFlows()) {
    const key = a.name.toUpperCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(a);
  }
  return [...byName.values()].filter((list) => new Set(list.map((a) => a.packageId)).size > 1 && new Set(list.map((a) => (a.tag ? a.tag.id : `x${a.id}`))).size > 1);
}

function lcRenderSourceList(list) {
  list.innerHTML = "";
  const filter = lc.srcFilter;
  const sugg = lcSuggestions().filter((s) => lfMatches(filter, s[0].name, ...s.map((a) => a.packageName))).slice(0, 5);
  if (sugg.length) {
    list.appendChild(lfH("div", { className: "lc-group-title" }, lfH("span", { textContent: "Same name in several packages" }), infoTip("These flows exist in more than one package and aren't linked together yet. Pick one to start from: the others are set to Link.")));
    for (const s of sugg) {
      const start = s.find((a) => a.tag) || s.find((a) => a.id === lf.itemId) || s[0];
      list.appendChild(lfH("button", { type: "button", className: "lc-row lc-row-suggest", onclick: () => lcPick(start.id, s) },
        lfIcon("link"),
        lfH("span", { className: "lc-row-text" }, lfH("strong", { textContent: s[0].name }), lfH("span", { className: "api-hint", textContent: s.map((a) => a.packageName).join(", ") }))));
    }
  }
  const byPkg = new Map();
  for (const a of lfFlows()) {
    if (!lfMatches(filter, a.name, a.packageName)) continue;
    const key = a.packageId || "";
    if (!byPkg.has(key)) byPkg.set(key, { name: a.packageName, packageId: a.packageId, flows: [] });
    byPkg.get(key).flows.push(a);
  }
  const pkgs = [...byPkg.values()].sort((a, b) => (a.packageId === null) - (b.packageId === null) || a.name.localeCompare(b.name));
  if (!pkgs.length) { list.appendChild(lfH("p", { className: "ft-env-status", textContent: filter ? "No flow matches the filter." : "No flows in this organisation." })); return; }
  const src = lcSource();
  for (const p of pkgs) {
    p.flows.sort((a, b) => a.name.localeCompare(b.name));
    const details = lfH("details", { className: "lf-pkg" });
    details.open = !!filter || pkgs.length === 1 || (src && (src.packageId || "") === (p.packageId || ""));
    details.appendChild(lfH("summary", {},
      lfH("span", { className: `ft-icon ft-icon-${p.packageId ? "package" : "library"}`, textContent: p.packageId ? "P" : "L" }),
      lfH("span", { className: "ft-name", textContent: p.name }),
      ftChip(String(p.flows.length), "muted", `${p.flows.length} flow${p.flows.length === 1 ? "" : "s"}`)));
    const ul = lfH("div", { className: "lc-flows" });
    for (const a of p.flows) {
      ul.appendChild(lfH("button", { type: "button", className: `lc-row${src && src.id === a.id ? " is-picked" : ""}`, onclick: () => lcPick(a.id) },
        ftKindIcon(a.type),
        lfH("span", { className: "lc-row-text" }, lfH("span", { className: "ft-name", textContent: a.name, title: a.name })),
        a.tag ? ftChip(`⛓ ${a.tag.id}`, "muted", "Linked") : null,
        a.id === lf.itemId ? ftChip("open", "info", "Open in the Designer") : null));
    }
    details.appendChild(ul);
    list.appendChild(details);
  }
}

/** Picks the source; `sameNamed` (a suggestion) sets the other same-named flows to Link. */
function lcPick(id, sameNamed) {
  lc.sourceId = id;
  lc.choice.clear();
  const src = lcSource();
  for (const a of sameNamed || []) if (a.id !== id && a.packageId && !(src.tag && a.tag && a.tag.id === src.tag.id)) lc.choice.set(a.packageId, "link");
  lcRender();
}

/* --- target pane --- */

/** Per package: what it holds for the source, and what can be done there. */
function lcTargetOf(pkg, src) {
  const group = src.tag ? (lfGroups().get(src.tag.id) || []) : [];
  const member = group.find((m) => m.packageId === pkg.id);
  if (member) return { pkg, state: "member", flow: member };
  const same = lfFlows().find((a) => a.packageId === pkg.id && lcSameName(a, src));
  if (same && same.tag) return { pkg, state: "other-group", flow: same };
  if (same) return { pkg, state: "has", flow: same };
  return { pkg, state: "none" };
}

function lcRenderTargets() {
  const root = lfEl("lcTargets");
  root.innerHTML = "";
  const src = lcSource();
  if (!src) { root.appendChild(lfH("div", { className: "lf-empty-aside" }, lfIcon("link"), lfH("strong", { textContent: "Pick a source flow" }), lfH("span", { className: "api-hint", textContent: "The packages you can copy it to appear here." }))); return; }
  const targets = lf.scan.packages.filter((p) => p.id !== src.packageId).map((p) => lcTargetOf(p, src));
  const missing = targets.filter((t) => t.state === "none");
  const tools = lfH("div", { className: "lc-tools" },
    lfH("input", { type: "search", className: "lf-filter", placeholder: "Filter packages…", autocomplete: "off", value: lc.tgtFilter, oninput: (e) => { lc.tgtFilter = e.target.value; lcRenderTargetList(list, targets); } }),
    lfH("button", { className: "btn-ghost", textContent: `Copy to all ${missing.length} without it`, disabled: !missing.length, onclick: () => { for (const t of missing) lc.choice.set(t.pkg.id, "copy"); lcRender(); } }),
    lfH("button", { className: "btn-ghost", textContent: "Clear", disabled: !lc.choice.size, onclick: () => { lc.choice.clear(); lcRender(); } }));
  root.appendChild(tools);
  const list = lfH("div", { className: "lc-list" });
  root.appendChild(list);
  lcRenderTargetList(list, targets);
}

function lcRenderTargetList(list, targets) {
  list.innerHTML = "";
  const shown = targets.filter((t) => lfMatches(lc.tgtFilter, t.pkg.name)).sort((a, b) => a.pkg.name.localeCompare(b.pkg.name));
  if (!shown.length) { list.appendChild(lfH("p", { className: "ft-env-status", textContent: targets.length ? "No package matches." : "This organisation has no other packages." })); return; }
  for (const t of shown) {
    const pick = lc.choice.get(t.pkg.id) || null;
    const set = (value) => { if (value) lc.choice.set(t.pkg.id, value); else lc.choice.delete(t.pkg.id); lcRender(); };
    const seg = (options) => lfH("div", { className: "lc-seg", role: "group" }, ...options.map(([value, label, tip]) =>
      lfH("button", { type: "button", className: pick === value ? "is-on" : "", "aria-pressed": String(pick === value), title: tip, textContent: label, onclick: () => set(value) })));
    let right, note = null;
    if (t.state === "member") {
      right = ftChip("Linked", "ok", "Already a copy in this group");
      note = `${t.flow.name} · ${LF_STATUS[lfStatusOf(t.flow.id)] ? LF_STATUS[lfStatusOf(t.flow.id)][0] : ""}`;
    } else if (t.state === "has") {
      right = seg([[null, "Skip", "Leave this package as it is"], ["link", "Link", `Link its own "${t.flow.name}" as it is`], ["copy", "Copy", "Create a second flow with this name, linked"]]);
      note = `Has "${t.flow.name}"`;
    } else if (t.state === "other-group") {
      right = seg([[null, "Skip", "Leave this package as it is"], ["copy", "Copy", "Create a second flow with this name, linked"]]);
      note = `Has "${t.flow.name}", linked in group ${t.flow.tag.id}`;
    } else {
      right = seg([[null, "Skip", "Leave this package as it is"], ["copy", "Copy", "Create a linked copy here"]]);
    }
    list.appendChild(lfH("div", { className: `lc-target lc-target-${t.state}${pick ? ` is-${pick}` : ""}` },
      lfH("span", { className: "ft-icon ft-icon-package", textContent: "P" }),
      lfH("span", { className: "lc-row-text" }, lfH("strong", { textContent: t.pkg.name }), note ? lfH("span", { className: "api-hint", textContent: note }) : null),
      right));
  }
}

/* --- plan --- */

function lcIds() {
  const src = lcSource();
  const adopt = [], fresh = [];
  for (const [pkgId, what] of lc.choice) {
    if (what === "copy") fresh.push(pkgId);
    else if (what === "link") { const t = lcTargetOf({ id: pkgId }, src); if (t.flow) adopt.push(t.flow.id); }
  }
  return { adopt, fresh };
}

function lcRenderPlan() {
  const root = lfEl("lfWork");
  if (lf.work && lf.work.kind === "results") return; // the results stay until Back
  root.innerHTML = "";
  const src = lcSource();
  const { adopt, fresh } = src ? lcIds() : { adopt: [], fresh: [] };
  if (!src || (!adopt.length && !fresh.length)) {
    root.appendChild(lfH("p", { className: "api-hint", textContent: src ? "Set at least one package to Copy or Link." : "Pick a source flow, then the target packages." }));
    return;
  }
  const cards = lfH("div", { id: "lcPlanCards", className: "lc-plan-cards" }, lfH("span", { className: "ft-env-status", textContent: "Checking…" }));
  root.appendChild(cards);
  const run = lfCta({ icon: "link", tone: "blue", label: "Checking…", disabled: true });
  run.id = "lcRun";
  run.addEventListener("click", () => lfBusy(run, fresh.length ? "Copying and linking…" : "Linking…", lcRun));
  root.appendChild(lfH("div", { className: "lc-run" }, run));
  clearTimeout(lc.timer);
  lc.timer = setTimeout(lcPlanNow, 250);
}

async function lcPlanNow() {
  const src = lcSource();
  if (!src) return;
  const seq = ++lc.seq;
  const { adopt, fresh } = lcIds();
  const response = await sendOrShowError({ type: "LF_PLAN_LINK", orgId: lf.orgId, sourceId: src.id, adoptIds: adopt, newPackageIds: fresh }, true);
  const cards = lfEl("lcPlanCards"), run = lfEl("lcRun");
  if (seq !== lc.seq || !cards) return;
  cards.innerHTML = "";
  if (!response) return;
  const plan = response.plan;
  lc.plan = plan;
  const card = (pkg, tone, title, chips, extra) => lfH("div", { className: `lc-plan-card lc-plan-${tone}` },
    lfH("div", { className: "lc-plan-head" }, lfH("span", { className: "ft-icon ft-icon-package", textContent: "P" }), lfH("strong", { textContent: pkg })),
    lfH("span", { className: "lc-plan-what", textContent: title }), ftChipRow(...chips), extra || null);
  if (!plan.linkId) cards.appendChild(card(plan.sourcePackage, "source", "Source: gets the link tag", [ftChip("steps unchanged", "muted")]));
  for (const f of plan.fresh) {
    cards.appendChild(f.blocked ? card(f.packageName, "blocked", "Not possible", [], lfH("span", { className: "ft-note ft-differs", textContent: f.blocked }))
      : card(f.packageName, "copy", "New linked copy", [ftChip("committed", "muted"), f.existingId ? ftChip("second flow with this name", "warn") : null], lfRefList(f.refs)));
  }
  for (const a of plan.adopt) {
    cards.appendChild(a.blocked ? card(a.packageName, "blocked", "Not possible", [], lfH("span", { className: "ft-note ft-differs", textContent: a.blocked }))
      : card(a.packageName, "link", "Links its own flow", [a.sameSteps ? ftChip("Same steps: in sync", "ok") : ftChip("Steps differ", "warn", "Linked with its own steps. Push or pull afterwards to make them equal.")]));
  }
  if (plan.blocked) cards.appendChild(lfH("p", { className: "ft-note ft-differs", textContent: plan.blocked }));
  const copies = plan.fresh.filter((f) => !f.blocked).length, links = plan.adopt.filter((a) => !a.blocked).length;
  lfSetLabel(run, copies && links ? `Copy to ${copies} & link ${links}` : copies ? `Copy & link to ${copies} package${copies === 1 ? "" : "s"}` : `Link ${links} flow${links === 1 ? "" : "s"}`);
  run.disabled = !!plan.blocked || !(copies + links);
}

async function lcRun() {
  const src = lcSource();
  const { adopt, fresh } = lcIds();
  const response = await sendOrShowError({ type: "LF_LINK", orgId: lf.orgId, sourceId: src.id, adoptIds: adopt, newPackageIds: fresh }, true);
  if (!response) return;
  lc.choice.clear();
  lfShowResults(`Linked group ${response.outcome.linkId}`, response.outcome.results.map((r) => ({
    ...r,
    outcome: r.outcome === "failed" ? "failed" : "pushed",
    note: r.outcome === "created" ? `new linked copy, committed${r.copiedIn && r.copiedIn.length ? ` · copied in ${r.copiedIn.join(", ")}` : ""}` : r.outcome === "linked" ? (r.differs ? "linked · steps differ, push or pull to align" : "linked") : r.reason
  })));
}

/* --- page --- */

function lcRender() {
  lcRenderSource();
  if (lf.scan) lcRenderTargets();
  lcRenderPlan();
}

// Hooks from panels/linked-flows.js.
function lcOnLoading() { if (!lf.scan) lcRenderSource(); }
function lcOnScan() {
  if (lc.sourceId && !lfAsset(lc.sourceId)) lc.sourceId = null;
  if (!lc.sourceId && lf.itemId && lfAsset(lf.itemId)) lc.sourceId = lf.itemId;
  if (lf.work && lf.work.kind === "results") { lcRenderSource(); lcRenderTargets(); return; }
  lcRender();
}
function lcReset() { lf.work = null; lcRender(); }

(function () {
  const q = new URLSearchParams(location.search);
  if (q.get("org")) lf.orgId = q.get("org");
  if (q.get("flow")) lc.sourceId = q.get("flow");
  lcRender();
  lfOnShow();
  setInterval(refreshLinkedFlowsState, 5000);
})();
