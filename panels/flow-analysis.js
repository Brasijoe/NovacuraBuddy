/* Flow Analysis tab: the open flow, and everything it uses at any depth, compared with the version
 * deployed on an environment (lib/flow-analysis.js). Read-only. The open flow and organisation
 * follow the Designer tab; the environment is picked in step 2; the result lists the assets that
 * changed, the steps changed in each and the fields changed in each step, with a line diff for
 * scripts. */

const fa = {
  inited: false, orgId: null, itemId: null, hasToken: false,
  data: null, // { root, assets, environments, names }
  loading: false, loadSeq: 0,
  envId: "", versionId: "", // versionId: manual deployed version (when the lookup finds none)
  run: null, // { env, deployed, rows, progress, error, tried }
  ignoreSys: true,
  open: new Set()
};

const faEl = (id) => document.getElementById(id);
const faVisible = () => !faEl("panel-flow-analysis").hidden;
const faShort = (id) => String(id || "").slice(0, 8);
const faPlural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const FA_TYPES = { module: "Module", component: "Component", application: "Application", page: "Page", automation: "Automation", workflow: "Workflow", flow: "Flow" };
const FA_PRODUCTS = /^(application|page|automation|workflow)$/i;

function faOnShow() {
  if (!fa.inited) {
    fa.inited = true;
    faEl("faRefreshBtn").addEventListener("click", () => faLoad());
    faEl("faCompareBtn").addEventListener("click", () => faCompare());
    faEl("faEnv").addEventListener("change", () => { if (faEl("faEnv").value === fa.envId) return; fa.envId = faEl("faEnv").value; fa.run = null; fa.versionId = ""; faRender(); });
    faEl("faIgnoreSys").addEventListener("change", () => { fa.ignoreSys = faEl("faIgnoreSys").checked; faRender(); });
  }
  refreshFlowAnalysisState(true);
}

/** From the 5s poll: follows the Designer tab (open flow, organisation) while the tab is shown. */
async function refreshFlowAnalysisState(first) {
  if (!faVisible() || fa.loading || (fa.run && fa.run.running)) return;
  const ctx = await send({ type: "LF_CONTEXT" });
  if (!ctx.ok) return;
  fa.hasToken = ctx.hasFlowToken;
  const changed = ctx.itemId !== fa.itemId || ctx.orgId !== fa.orgId;
  fa.itemId = ctx.itemId;
  fa.orgId = ctx.orgId;
  if (changed) { fa.data = null; fa.run = null; fa.versionId = ""; }
  if (fa.hasToken && fa.itemId && (first || changed) && !fa.data) faLoad(); else faRender();
}

async function faLoad() {
  if (!fa.orgId || !fa.itemId || fa.loading) return;
  const seq = ++fa.loadSeq;
  fa.loading = true;
  fa.run = null;
  faRender();
  const response = await sendOrShowError({ type: "FA_ROOT", orgId: fa.orgId, itemId: fa.itemId }, true);
  fa.loading = false;
  if (seq !== fa.loadSeq) return;
  fa.data = response && response.ok ? response : null;
  if (fa.data && !fa.data.environments.some((e) => e.id === fa.envId)) fa.envId = "";
  faRender();
}

/* --- the comparison --- */

async function faCompare() {
  const d = fa.data;
  const env = d && d.environments.find((e) => e.id === fa.envId);
  if (!env || !d.root.packageId) return;
  const seq = ++fa.loadSeq;
  const run = fa.run = { env, running: true, rows: [], progress: "Looking up the deployed version…", error: null, tried: [], deployed: null };
  faRender();
  const dep = await sendOrShowError({ type: "FA_DEPLOYED", orgId: fa.orgId, itemId: d.root.id, packageId: d.root.packageId, env, versionId: fa.versionId || null }, true);
  if (seq !== fa.loadSeq) return;
  if (!dep) { run.running = false; run.error = "The deployed version could not be read."; return faRender(); }
  run.tried = dep.tried || [];
  if (!dep.versionId) {
    run.running = false;
    run.error = `Could not find which version of ${d.root.name || "the flow"} is deployed on ${env.name}.`;
    run.needVersion = true;
    return faRender();
  }
  run.deployed = { versionId: dep.versionId };
  // Everything the flow uses: the deployed version's list against the open flow's list, plus the flow itself.
  const jobs = FlowAnalysis.compareAssetLists(dep.assets.filter((a) => a.assetId !== d.root.id), d.assets.filter((a) => a.assetId !== d.root.id));
  const meta = new Map(d.assets.map((a) => [a.assetId, a]));
  if (dep.versionId !== d.root.headVersionId) jobs.unshift({ assetId: d.root.id, status: "changed", fromVersion: dep.versionId, toVersion: d.root.headVersionId, isRoot: true });
  for (const j of jobs) {
    const m = meta.get(j.assetId) || {}, nm = d.names[j.assetId] || {};
    Object.assign(j, { name: j.isRoot ? d.root.name : m.name || nm.name || faShort(j.assetId), type: j.isRoot ? d.root.type : m.type || nm.type || "", packageName: j.isRoot ? d.root.packageName : m.packageName || "" });
  }
  run.jobs = jobs;
  let next = 0, done = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      run.progress = `Reading ${faShort(job.assetId) === job.name ? "asset" : job.name} (${done + 1} of ${jobs.length})`;
      if (seq === fa.loadSeq) faRender();
      let result = null, error = null;
      if (job.status === "added" || job.status === "removed") result = { steps: [], arrows: 0, root: [], code: null, info: {} };
      if (!result) {
        const r = await send({ type: "FA_ASSET", orgId: fa.orgId, assetId: job.assetId, assetType: job.type, fromVersion: job.fromVersion, toVersion: job.toVersion, headVersionId: job.isRoot ? d.root.headVersionId : null });
        if (r && r.ok) result = r.result; else error = (r && r.error) || "Could not be read";
      }
      run.rows.push({ ...job, result, error });
      done++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
  if (seq !== fa.loadSeq) return;
  run.running = false;
  faRender();
}

/* --- rendering --- */

function faDate(v) {
  if (!v) return "";
  const t = new Date(v);
  if (isNaN(t)) return String(v);
  return t.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** "v18 (13 Oct, 16:45, JS)" from a version id and the info read for it. */
function faVersionLabel(versionId, info) {
  if (!versionId) return faH("span", { className: "fa-ver", textContent: "—" });
  const i = (info || {})[versionId] || {};
  const bits = [faDate(i.date)].filter(Boolean);
  const label = i.number !== null && i.number !== undefined ? `v${i.number}` : faShort(versionId);
  return faH("span", { className: "fa-ver" }, faH("strong", { textContent: label }), bits.length ? ` (${bits.join(", ")}` : "", i.by ? faH("span", { className: "fa-initials", title: i.by, textContent: FlowAnalysis.initialsOf(i.by) }) : "", bits.length ? ")" : "");
}
const faH = lfH;

function faRenderDiffLines(lines) {
  const box = faH("div", { className: "fa-code" });
  for (const l of lines) {
    if (l.op === "skip") box.appendChild(faH("div", { className: "fa-skip", textContent: `… ${faPlural(l.count, "unchanged line", "unchanged lines")}` }));
    else box.appendChild(faH("div", { className: `fa-line fa-${l.op === "+" ? "add" : l.op === "-" ? "del" : "same"}` }, faH("span", { className: "fa-sign", textContent: l.op === "=" ? "" : l.op }), l.text));
  }
  return box;
}

const faVal = (v) => (v === undefined ? "(none)" : v === "" ? "(empty)" : String(v));

function faRenderChange(c) {
  const row = faH("div", { className: "fa-change" }, faH("div", { className: "fa-path", textContent: c.path || "(value)" }));
  if (c.lines) row.appendChild(faRenderDiffLines(c.lines));
  else row.appendChild(faH("div", { className: "fa-values" }, faH("code", { className: "fa-before", textContent: faVal(c.before) }), faH("span", { className: "fa-arrow", textContent: "→" }), faH("code", { className: "fa-after", textContent: faVal(c.after) })));
  return row;
}

function faRenderStep(s) {
  const tag = s.status === "changed" ? faPlural(s.changes.length, "change", "changes") : s.status === "added" ? "Added" : "Removed";
  const head = faH("div", { className: "fa-step-head" }, faH("strong", { textContent: s.label }), s.stepType || s.kind ? faH("span", { className: "fa-kind", textContent: s.stepType || s.kind }) : "", faH("span", { className: `fa-tag fa-tag-${s.status}`, textContent: tag }));
  const box = faH("div", { className: "fa-step" }, head);
  for (const c of s.changes) box.appendChild(faRenderChange(c));
  return box;
}

function faCountOf(row) {
  const r = row.result;
  if (!r) return 0;
  if (r.code) return r.code.filter((l) => l.op === "+" || l.op === "-").length ? 1 : 0;
  return r.steps.length + r.root.length + (r.arrows ? 1 : 0);
}

function faRenderAsset(row, info) {
  const open = fa.open.has(row.assetId);
  const r = row.result;
  const statusTag = row.status === "added" ? faH("span", { className: "fa-tag fa-tag-added", textContent: "New" }) : row.status === "removed" ? faH("span", { className: "fa-tag fa-tag-removed", textContent: "Removed" }) : null;
  const n = faCountOf(row);
  const head = faH("button", { type: "button", className: "fa-asset-head", "aria-expanded": String(open), onclick: () => { open ? fa.open.delete(row.assetId) : fa.open.add(row.assetId); faRender(); } },
    faH("span", { className: "fa-caret", textContent: open ? "▾" : "▸" }),
    faH("strong", { className: "fa-asset-name", textContent: row.name }),
    faH("span", { className: "fa-kind", textContent: FA_TYPES[String(row.type).toLowerCase()] || row.type || "Asset" }),
    row.isRoot ? faH("span", { className: "fa-kind", textContent: "Open flow" }) : row.indirect ? faH("span", { className: "fa-kind", textContent: "Indirect" }) : "",
    statusTag, row.status === "changed" && !row.error ? faH("span", { className: "fa-count", textContent: faPlural(n, "change", "changes") }) : "");
  const sub = faH("div", { className: "fa-asset-versions" }, faVersionLabel(row.fromVersion, (r && r.info) || info), faH("span", { className: "fa-arrow", textContent: "→" }), faVersionLabel(row.toVersion, (r && r.info) || info));
  const card = faH("div", { className: "fa-asset" }, head, sub);
  if (!open) return card;
  const body = faH("div", { className: "fa-asset-body" });
  if (row.error) body.appendChild(faH("p", { className: "api-hint", textContent: row.error }));
  else if (r && r.unreadable) body.appendChild(faH("p", { className: "api-hint", textContent: `The content of this version could not be read (${(r.tried || []).slice(-4).join("; ") || "no endpoint answered"}).` }));
  else if (row.status !== "changed") body.appendChild(faH("p", { className: "api-hint", textContent: row.status === "added" ? "The environment does not have this asset yet." : "The open flow no longer uses this asset." }));
  else if (r && r.code) body.appendChild(r.code.length ? faRenderDiffLines(r.code) : faH("p", { className: "api-hint", textContent: "Only the version number differs: the code is the same." }));
  else if (r) {
    if (!r.steps.length && !r.root.length && !r.arrows) body.appendChild(faH("p", { className: "api-hint", textContent: "Only the version number differs: no step changed." }));
    if (r.steps.length) body.appendChild(faH("h3", { className: "fa-sub", textContent: `Steps changed (${r.steps.length})` }));
    for (const s of r.steps) body.appendChild(faRenderStep(s));
    if (r.arrows) body.appendChild(faH("p", { className: "api-hint", textContent: `${faPlural(r.arrows, "arrow", "arrows")} added, removed or changed.` }));
    for (const c of r.root) body.appendChild(faRenderChange(c));
  }
  card.appendChild(body);
  return card;
}

function faRender() {
  const d = fa.data;
  const ctxLine = faEl("faContext");
  const hint = faEl("faSessionHint");
  hint.textContent = !fa.hasToken ? "No Flow session yet: open Flow in a tab (or refresh the open Flow tab) and click in it once." : !fa.itemId ? "Open a flow in the Flow Designer." : "";
  hint.hidden = !hint.textContent;
  const ready = !!d;
  ctxLine.hidden = !ready;
  faEl("faOpenHint").hidden = ready;
  faEl("faRefreshBtn").disabled = !fa.hasToken || !fa.itemId || fa.loading;
  for (const id of ["faOrg", "faFlow", "faPackage"]) faEl(id).textContent = "";
  if (ready) {
    faEl("faOrg").textContent = fa.orgId;
    faEl("faFlow").textContent = d.root.name || faShort(d.root.id);
    faEl("faPackage").textContent = d.root.packageName || "(App Library)";
  }
  const card2 = faEl("faEnvCard");
  card2.classList.toggle("is-disabled", !ready);
  const sel = faEl("faEnv");
  const envs = ready ? d.environments : [];
  const want = JSON.stringify(envs.map((e) => [e.id, e.name]));
  if (sel.dataset.sig !== want) {
    sel.dataset.sig = want;
    sel.innerHTML = "";
    sel.appendChild(new Option("Choose an environment…", ""));
    for (const e of envs) sel.appendChild(new Option(`${e.name} (${e.type})`, e.id));
  }
  sel.value = fa.envId;
  sel.dispatchEvent(new Event("change"));
  sel.disabled = !ready;
  const deployable = ready && FA_PRODUCTS.test(d.root.type || "") && !!d.root.packageId;
  const note = faEl("faEnvNote");
  note.textContent = ready && !deployable ? "Only apps, pages and automations are deployed to an environment. Open one of those, or open the flow from the app that uses it." : "";
  note.hidden = !note.textContent;
  faEl("faCompareBtn").disabled = !deployable || !fa.envId || (fa.run && fa.run.running);

  const res = faEl("faResult");
  res.innerHTML = "";
  res.hidden = !(fa.loading || fa.run);
  if (fa.loading) { res.hidden = false; res.appendChild(faH("p", { className: "ft-env-status", textContent: "Reading the flow and its assets…" })); return; }
  const run = fa.run;
  if (!run) return;
  if (run.running) res.appendChild(faH("p", { className: "ft-env-status", textContent: run.progress }));
  if (run.error) {
    res.appendChild(faH("div", { className: "banner banner-error", textContent: run.error }));
    if (run.needVersion) {
      const input = faH("input", { type: "text", placeholder: "Deployed version id (guid)", value: fa.versionId });
      res.appendChild(faH("div", { className: "fa-manual" }, faH("span", { className: "api-hint", textContent: "If you know the version id deployed there (visible in Flow's deploy overview), enter it and compare again." }), input,
        faH("button", { type: "button", className: "btn-ghost", textContent: "Use this version", onclick: () => { fa.versionId = input.value.trim(); faCompare(); } })));
    }
    if (run.tried.length) res.appendChild(faH("button", { type: "button", className: "btn-ghost", textContent: "Copy what was tried", onclick: async (e) => { try { await navigator.clipboard.writeText(run.tried.join("\n")); e.target.textContent = "Copied"; } catch { e.target.textContent = "Copy failed"; } } }));
    return;
  }
  const hideSys = (r) => fa.ignoreSys && /^_SYS/i.test(r.packageName || "");
  const rows = run.rows.filter((r) => !hideSys(r)).sort((a, b) => (b.isRoot ? 1 : 0) - (a.isRoot ? 1 : 0) || String(a.name).localeCompare(String(b.name)));
  if (run.running && !rows.length) return;
  const changed = rows.filter((r) => r.error || r.status !== "changed" || faCountOf(r) > 0 || (r.result && r.result.unreadable));
  const info = {};
  const total = changed.reduce((n, r) => n + (r.status === "changed" ? Math.max(faCountOf(r), 0) : 1), 0);
  res.appendChild(faH("h2", { className: "fa-title", textContent: `Changes since ${run.env.name}` }));
  res.appendChild(faH("p", { className: "fa-summary" }, faH("strong", { textContent: faPlural(total, "change", "changes") }), " · ", faPlural(changed.length, "asset changed", "assets changed"), run.deployed ? ` · deployed ${faShort(run.deployed.versionId)} → current` : ""));
  if (!changed.length && !run.running) res.appendChild(faH("p", { className: "api-hint", textContent: "Nothing changed: the flow and everything it uses are the same as on this environment." }));
  for (const r of changed) res.appendChild(faRenderAsset(r, info));
}
