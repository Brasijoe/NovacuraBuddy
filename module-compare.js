// Results page of the Module Compare tab: modules on the left (status, red counter of impacted
// functions the flows use), the chosen module on the right: where it is used, the status of each
// used function/type/data source, and a diff of what changed with a severity per finding.
const params = new URLSearchParams(location.search);
const sel = { orgId: params.get("orgId"), packageId: params.get("packageId") || "", baseUrl: params.get("baseUrl") };
const el = (id) => document.getElementById(id);

const STATUS = {
  same: ["No changes", "ok"], changed: ["Changes", "warn"], error: ["Error", "crit"], skipped: ["Not from IFS", "muted"], notfound: ["Not found in IFS", "crit"], updated: ["Updated", "info"]
};
const USE_STATUS = { unchanged: ["Unchanged", "ok"], changed: ["Changed", "warn"], impacted: ["Impacted", "crit"] };
const SEVERITY_LABEL = { critical: "Critical", major: "Major", minor: "Minor", info: "Info" };
const KIND_LABEL = { function: "Function", type: "Type", let: "Data source" };

let result = null;
let selectedId = null;
let selectedKey = null; // a used declaration, or a change, picked for the diff panel
let selectedFlowId = null;

function chip(text, cls, title) {
  const c = document.createElement("span");
  c.className = `ft-chip mc-chip-${cls}`;
  c.textContent = text;
  if (title) c.title = title;
  return c;
}
const severityChip = (s) => (s ? chip(SEVERITY_LABEL[s], `sev-${s}`) : null);
const statusOf = (m) => (m.updated ? "updated" : m.status);

function counter(n, cls, title) {
  const b = document.createElement("span");
  b.className = `mc-counter mc-counter-${cls}`;
  b.textContent = n;
  b.title = title;
  return b;
}

function visibleModules() {
  const q = el("mcFilter").value.trim().toLowerCase();
  const onlyChanged = el("mcOnlyChanged").checked;
  return result.modules.filter((m) => (!onlyChanged || m.status === "changed")
    && (!q || m.name.toLowerCase().includes(q) || String(m.packageName || "").toLowerCase().includes(q)));
}

function renderList() {
  const list = el("mcModuleList");
  list.innerHTML = "";
  const modules = visibleModules();
  for (const m of modules) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = `fd-group mc-module${m.id === selectedId ? " is-active" : ""}`;
    const text = document.createElement("span");
    text.className = "mc-module-text";
    const name = document.createElement("span");
    name.className = "fd-group-name";
    name.textContent = m.name;
    const sub = document.createElement("span");
    sub.className = "list-count";
    sub.textContent = m.packageName || "";
    text.append(name, sub);
    const right = document.createElement("span");
    right.className = "ft-chips mc-module-right";
    const [label, cls] = STATUS[statusOf(m)];
    right.append(chip(label, cls, m.error || ""));
    if (m.impactedCount && !m.updated) right.append(counter(m.impactedCount, "red", `${m.impactedCount} used function(s)/type(s) hit by a major or critical change`));
    if (m.changedUsedCount && !m.updated) right.append(counter(m.changedUsedCount, "orange", `${m.changedUsedCount} used function(s)/type(s) with minor changes`));
    btn.append(text, right);
    btn.onclick = () => { selectedId = m.id; selectedKey = null; selectedFlowId = null; renderList(); renderDetail(); };
    li.append(btn);
    list.append(li);
  }
  if (!modules.length) {
    const li = document.createElement("li");
    li.className = "empty-state";
    li.textContent = el("mcOnlyChanged").checked ? "No changed modules match." : "No modules match.";
    list.append(li);
  }
}

function section(title, tip) {
  const head = document.createElement("div");
  head.className = "section-head";
  const h = document.createElement("h2");
  h.textContent = title;
  head.append(h);
  if (tip) head.append(infoTip(tip));
  return head;
}

function renderDiff(diff) {
  const pre = document.createElement("pre");
  pre.className = "lf-code mc-code";
  if (!diff) { pre.textContent = "Too large to diff line by line."; return pre; }
  // Unchanged stretches longer than 6 lines fold to their first and last 3.
  const out = [];
  for (let i = 0; i < diff.length;) {
    if (diff[i].op !== "=") { out.push(diff[i++]); continue; }
    let j = i;
    while (j < diff.length && diff[j].op === "=") j++;
    const run = diff.slice(i, j);
    if (run.length > 6) out.push(...run.slice(0, 3), { op: "…", text: `${run.length - 6} unchanged lines` }, ...run.slice(-3));
    else out.push(...run);
    i = j;
  }
  for (const line of out) {
    const span = document.createElement("span");
    span.className = line.op === "+" ? "lf-add mc-add" : line.op === "-" ? "lf-del mc-del" : line.op === "…" ? "mc-fold" : "";
    span.textContent = `${line.op === "=" ? " " : line.op === "…" ? "⋯" : line.op} ${line.text}\n`;
    pre.append(span);
  }
  return pre;
}

function renderChange(c) {
  const card = document.createElement("div");
  card.className = "mc-change";
  const head = document.createElement("div");
  head.className = "mc-change-head";
  const name = document.createElement("strong");
  name.textContent = c.name;
  head.append(name, chip(`${KIND_LABEL[c.kind]}${c.private ? " (private)" : ""}`, "muted"), chip(c.status === "added" ? "Added" : c.status === "removed" ? "Removed" : "Changed", c.status === "removed" ? "crit" : "warn"));
  const sev = severityChip(c.severity);
  if (sev) head.append(sev);
  card.append(head);
  if (c.findings.length) {
    const ul = document.createElement("ul");
    ul.className = "mc-findings";
    for (const f of c.findings) {
      const li = document.createElement("li");
      li.append(severityChip(f.severity), document.createTextNode(` ${f.text}`));
      ul.append(li);
    }
    card.append(ul);
  }
  card.append(renderDiff(c.diff));
  return card;
}

function renderDiffPanel(m) {
  const wrap = document.createElement("div");
  wrap.id = "mcDiffPanel";
  wrap.className = "mc-diff-panel";
  if (!selectedKey) return wrap;
  const byKey = new Map(m.changes.map((c) => [c.key, c]));
  let used = null;
  for (const f of m.usage) if (f.flowId === selectedFlowId) used = f.used.find((u) => u.key === selectedKey) || used;
  const keys = used ? used.changes : [selectedKey];
  const title = used ? `${used.name}: what changed` : `${(byKey.get(selectedKey) || {}).name || selectedKey}`;
  wrap.append(section(title, used ? "The changes in this function, type or data source itself and in every sub-function and type it depends on, at any depth. Each finding is rated: Critical breaks callers (a new mandatory input, a removed function), Major probably breaks them (a changed type, a removed field your flows use), Minor changes behaviour, Info is harmless (a new optional field)." : null));
  if (used && !keys.length) {
    const p = document.createElement("p");
    p.className = "list-count";
    p.textContent = "Nothing it uses has changed.";
    wrap.append(p);
  }
  for (const k of keys) if (byKey.has(k)) wrap.append(renderChange(byKey.get(k)));
  return wrap;
}

function selectItem(key, flowId) {
  selectedKey = key;
  selectedFlowId = flowId || null;
  renderDetail();
  const panel = el("mcDiffPanel");
  if (panel) panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** The flow's steps that use the module: step name, what of the module it uses (click one for its
 *  diff), status and severity. */
function renderFlowSteps(m, f) {
  const wrap = document.createElement("div");
  wrap.className = "mc-steps-table";
  const title = document.createElement("div");
  title.className = "mc-sub";
  title.append(`Steps (${f.steps.filter((st) => st.status !== "unchanged").length} affected of ${f.steps.length} using the module)`);
  title.append(infoTip("The steps of this flow whose configuration uses the module, with what they use. Impacted: a major or critical change reaches it. Changed: only minor changes. The same marks show on the steps in the Flow Designer."));
  wrap.append(title);
  const byKey = new Map(f.used.map((u) => [u.key, u]));
  for (const st of f.steps) {
    const row = document.createElement("div");
    row.className = `mc-step-row mc-step-${st.status}`;
    const name = document.createElement("a");
    name.href = "#";
    name.className = "mc-step-name";
    name.textContent = st.label;
    name.title = "Open the flow in the Designer and focus this step";
    name.onclick = (e) => { e.preventDefault(); openFlow(f.flowId, st.id); };
    const chips = document.createElement("span");
    chips.className = "ft-chips";
    const checked = f.recheck && f.recheck.steps.find((x) => x.id === st.id);
    for (const key of st.items) {
      const u = byKey.get(key);
      if (!u) continue;
      const c = chip(u.name, u.status === "impacted" ? "crit" : u.status === "changed" ? "warn" : "muted", "Show what changed");
      c.classList.add("mc-chip-click");
      c.onclick = () => selectItem(u.key, f.flowId);
      chips.append(c);
    }
    const [label, cls] = USE_STATUS[st.status];
    chips.append(chip(label, cls));
    const sev = severityChip(st.severity);
    if (sev) chips.append(sev);
    if (checked) {
      const [rl, rc] = RECHECK_STATUS[checked.status];
      chips.append(chip(rl, rc, recheckText(checked)));
    }
    row.append(name, chips);
    wrap.append(row);
    if (checked && checked.status !== "fixed") {
      const detail = document.createElement("ul");
      detail.className = "mc-findings mc-recheck-detail";
      for (const item of checked.items) {
        for (const fd of item.open) { const li = document.createElement("li"); li.append(chip("Still open", "crit"), ` ${item.name}: ${fd.text}`); detail.append(li); }
        for (const fd of item.manual) { const li = document.createElement("li"); li.append(chip("Check by hand", "warn"), ` ${item.name}: ${fd.text}`); detail.append(li); }
      }
      if (detail.children.length) wrap.append(detail);
    }
  }
  return wrap;
}

const RECHECK_STATUS = { fixed: ["Fixed", "ok"], open: ["Still open", "crit"], manual: ["Check by hand", "warn"] };

function recheckText(checked) {
  return checked.items.flatMap((i) => [...i.open.map((f) => `Open: ${i.name}: ${f.text}`), ...i.manual.map((f) => `Check: ${i.name}: ${f.text}`), ...i.fixed.map((f) => `Fixed: ${i.name}: ${f.text}`)]).join("\n") || (checked.gone ? "The step is gone." : "It no longer uses anything that changed.");
}

function openFlow(flowId, stepId) {
  send({ type: "MC_OPEN_FLOW", orgId: sel.orgId, flowId, stepId: stepId || null });
}

/** Reads the flow again (not the module) and checks whether its steps now fit the updated module. */
async function recheckFlow(m, f, btn) {
  btn.disabled = true;
  btn.textContent = "Checking…";
  try {
    const response = await call({ type: "MC_FLOW", orgId: sel.orgId, itemId: f.flowId, moduleIds: [m.id] });
    const re = ModuleCompare.recheckFlow({ module: m, flowId: f.flowId, steps: response.steps || [] });
    if (re) f.recheck = re;
    const saved = await send({ type: "MC_SAVE_RESULT", orgId: sel.orgId, packageId: sel.packageId, baseUrl: sel.baseUrl, result });
    if (!saved.ok) showError(`The recheck could not be saved: ${saved.error}`);
    showNotice(re && re.status === "fixed" ? `${f.flowName}: all affected steps are fixed.` : `${f.flowName}: rechecked — see the steps for what is still open.`);
  } catch (e) {
    showError(`Recheck of ${f.flowName} failed: ${e.message}`, true);
  }
  renderDetail();
}

function renderUsage(m) {
  const wrap = document.createElement("div");
  wrap.append(section(`Where it is used (${m.usage.length} flow${m.usage.length === 1 ? "" : "s"})`, "The flows in the scan that reference this module, and the functions, types and data sources of it they use (found in the flow's steps by name). A function counts as impacted when it, or any sub-function or type it depends on, has a major or critical change. Click one to see its diff."));
  if (!m.usage.length) {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = m.usedBy ? "Flows reference this module, but none of its functions were found by name in their steps." : "No flow in the scan references this module.";
    wrap.append(p);
    return wrap;
  }
  for (const f of m.usage) {
    const card = document.createElement("div");
    card.className = "fd-chain mc-flow";
    const head = document.createElement("div");
    head.className = "mc-change-head";
    const name = document.createElement("a");
    name.href = "#";
    name.className = "mc-flow-link";
    name.textContent = f.flowName;
    name.title = "Open the flow in the Flow Designer";
    name.onclick = (e) => { e.preventDefault(); openFlow(f.flowId, null); };
    head.append(name);
    if (f.packageName) head.append(chip(f.packageName, "muted"));
    if (f.recheck) {
      const [rl, rc] = RECHECK_STATUS[f.recheck.status];
      head.append(chip(`${rl} · checked ${new Date(f.recheck.checkedAt).toLocaleTimeString()}`, rc));
    }
    if (f.used.some((u) => u.status !== "unchanged")) {
      const btn = document.createElement("button");
      btn.className = "mc-recheck-btn";
      btn.textContent = "Recheck flow";
      btn.title = "Reads this flow again (the module is not generated again) and checks whether its steps now fit the module's new code: new mandatory fields sent, removed fields and functions no longer used, calls with the right number of arguments. Changes that can't be checked automatically are listed as Check by hand.";
      btn.onclick = () => recheckFlow(m, f, btn);
      head.append(btn);
    }
    card.append(head);
    if (f.steps && f.steps.length) {
      card.append(renderFlowSteps(m, f));
      const sub = document.createElement("div");
      sub.className = "mc-sub";
      sub.textContent = "Functions, types and data sources used";
      card.append(sub);
    }
    const table = document.createElement("div");
    table.className = "mc-used";
    for (const u of f.used) {
      const row = document.createElement("button");
      row.className = `mc-used-row${u.key === selectedKey && f.flowId === selectedFlowId ? " is-active" : ""}`;
      const n = document.createElement("span");
      n.className = "mc-used-name";
      n.textContent = u.name;
      const [label, cls] = USE_STATUS[u.status];
      const chips = document.createElement("span");
      chips.className = "ft-chips";
      chips.append(chip(KIND_LABEL[u.kind], "muted", u.how === "name" ? "Found by its name in the flow's steps" : "Called as Module.name"), chip(label, cls));
      const sev = severityChip(u.severity);
      if (sev) chips.append(sev);
      row.append(n, chips);
      row.onclick = () => selectItem(u.key, f.flowId);
      table.append(row);
    }
    card.append(table);
    wrap.append(card);
  }
  return wrap;
}

function renderAllChanges(m) {
  const wrap = document.createElement("div");
  wrap.append(section(`All changes (${m.changes.length})`, "Every declaration of the module that differs from the generated code, the ones your flows use (directly or through a sub-function) first. Click one to see its diff."));
  const table = document.createElement("div");
  table.className = "mc-used";
  for (const c of m.changes) {
    const row = document.createElement("button");
    row.className = `mc-used-row${c.key === selectedKey && !selectedFlowId ? " is-active" : ""}`;
    const n = document.createElement("span");
    n.className = "mc-used-name";
    n.textContent = c.name;
    const chips = document.createElement("span");
    chips.className = "ft-chips";
    chips.append(chip(KIND_LABEL[c.kind], "muted"));
    if (c.used) chips.append(chip("Used", "info", "Your flows use it, directly or through a function that depends on it"));
    const sev = severityChip(c.severity);
    if (sev) chips.append(sev);
    row.append(n, chips);
    row.onclick = () => selectItem(c.key, null);
    table.append(row);
  }
  wrap.append(table);
  return wrap;
}

function updateButton(m) {
  const btn = document.createElement("button");
  btn.className = "btn-primary";
  btn.textContent = "Update module";
  let armed = false;
  btn.onclick = async () => {
    if (!armed) { armed = true; btn.textContent = "Click again to commit the new code"; setTimeout(() => { armed = false; btn.textContent = "Update module"; }, 5000); return; }
    btn.disabled = true;
    btn.textContent = "Updating…";
    const ok = await updateModule(m);
    btn.disabled = false;
    btn.textContent = ok ? "Updated" : "Update module";
    armed = false;
  };
  return btn;
}

async function updateModule(m) {
  clearError(true);
  const response = await send({
    type: "MC_UPDATE", orgId: sel.orgId, packageId: m.packageId, assetId: m.id, code: m.newSource, baseUrl: sel.baseUrl,
    flowIds: m.usage.map((f) => f.flowId), masterPassword: ""
  });
  if (!response.ok) { showError(`Updating ${m.name} failed: ${explainLocked(response)}`, true); return false; }
  m.updated = true;
  showNotice(`${m.name} updated and committed. Flows use the new version once they are refreshed.`);
  renderList();
  renderDetail();
  renderSummary();
  return true;
}

function renderDetail() {
  const detail = el("mcDetail");
  detail.innerHTML = "";
  const m = result.modules.find((x) => x.id === selectedId);
  if (!m) {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = "Choose a module on the left.";
    detail.append(p);
    return;
  }
  const head = document.createElement("div");
  head.className = "mc-detail-head";
  const titles = document.createElement("div");
  const h = document.createElement("div");
  h.className = "mc-detail-title";
  h.textContent = m.name;
  const chips = document.createElement("div");
  chips.className = "ft-chips";
  const [label, cls] = STATUS[statusOf(m)];
  chips.append(chip(label, cls), chip(m.packageName || "App Library", "muted"));
  if (m.projection) chips.append(chip(`${m.projection}.svc`, "muted", "The IFS projection the module is generated from"));
  if (m.maxSeverity && !m.updated) chips.append(severityChip(m.maxSeverity));
  titles.append(h, chips);
  head.append(titles);
  if (m.status === "changed" && !m.updated && m.newSource) head.append(updateButton(m));
  detail.append(head);

  if (m.status === "error" || m.status === "skipped" || m.status === "notfound") {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = m.error;
    detail.append(p);
    return;
  }
  if (m.status === "same") {
    const p = document.createElement("p");
    p.className = "list-count";
    p.textContent = "The code generated from the IFS instance matches this module (only the header with the generation time differs).";
    detail.append(p);
  }
  if (m.updated) {
    const p = document.createElement("p");
    p.className = "list-count";
    p.textContent = "Updated in this session: the module now holds the generated code. Rescan to compare again.";
    detail.append(p);
  }
  detail.append(renderUsage(m));
  if (m.changes && m.changes.length) detail.append(renderAllChanges(m));
  detail.append(renderDiffPanel(m));
}

function renderSummary() {
  const ms = result.modules;
  const changed = ms.filter((m) => m.status === "changed" && !m.updated);
  const impacted = changed.reduce((n, m) => n + (m.impactedCount || 0), 0);
  const skipped = ms.filter((m) => m.status === "skipped").length;
  const notFound = ms.filter((m) => m.status === "notfound").length;
  const failed = ms.filter((m) => m.status === "error").length;
  el("mcSummary").textContent = [
    `Scanned ${new Date(result.scannedAt).toLocaleString()}: ${ms.length} module(s), ${changed.length} with changes, ${impacted} impacted function(s) in use`,
    `${result.flowCount} flow(s) checked`,
    skipped ? `${skipped} not generated from IFS` : null,
    notFound ? `${notFound} not found in IFS` : null,
    failed ? `${failed} failed` : null
  ].filter(Boolean).join(" · ");
  el("mcUpdateAllBtn").hidden = !changed.some((m) => m.newSource);
}

function showResult(r) {
  result = r;
  if (!r) {
    el("mcResults").hidden = true;
    el("mcEmpty").hidden = false;
    el("mcEmpty").textContent = "No scan yet — hit Rescan.";
    return;
  }
  el("mcEmpty").hidden = !!r.modules.length;
  el("mcEmpty").textContent = "No modules found in this organisation/package.";
  el("mcResults").hidden = !r.modules.length;
  if (!r.modules.some((m) => m.id === selectedId)) {
    const first = r.modules.find((m) => m.impactedCount) || r.modules.find((m) => m.status === "changed") || r.modules[0];
    selectedId = first ? first.id : null;
    selectedKey = null;
  }
  renderSummary();
  renderList();
  renderDetail();
  const errors = r.errors || [];
  el("mcErrors").hidden = !errors.length;
  el("mcErrorsSummary").textContent = `${errors.length} item(s) could not be read`;
  el("mcErrorList").innerHTML = "";
  for (const e of errors) { const li = document.createElement("li"); li.textContent = e; el("mcErrorList").append(li); }
}

/* --- Scan: runs here (not in the service worker) as many short background reads, so no single
   call can time out however many modules and flows there are. --- */

// Same header test as FlowTransfer.ifsProjectionOf (the background's copy).
const ifsProjectionOf = (source) => {
  const header = /^\s*\/\*[\s\S]*?\*\//.exec(String(source || ""));
  const m = header && /#importSource\("[^"]*?\/([A-Za-z0-9_]+)\.svc[^"]*"\)/.exec(header[0]);
  return m ? m[1] : null;
};

/** A background call that throws on failure (the scan's per-item errors are collected by runScan). */
async function call(message) {
  const response = await send({ ...message, masterPassword: "" });
  if (!response.ok) throw new Error(explainLocked(response));
  return response;
}

const stepState = {}; // step id -> { current, total, state: "todo" | "running" | "done" }

function renderSteps() {
  const list = el("mcSteps");
  list.innerHTML = "";
  for (const step of ModuleCompare.SCAN_STEPS) {
    const st = stepState[step.id] || { state: "todo" };
    const li = document.createElement("li");
    li.className = `mc-step mc-step-${st.state}`;
    const mark = document.createElement("span");
    mark.className = "mc-step-mark";
    mark.textContent = st.state === "done" ? "✓" : st.state === "running" ? "" : st.state === "failed" ? "!" : "";
    const label = document.createElement("span");
    label.textContent = step.label;
    const count = document.createElement("span");
    count.className = "list-count";
    count.textContent = st.total ? `${st.current}/${st.total}` : "";
    li.append(mark, label, count);
    list.append(li);
  }
}

function onStep(id, current, total) {
  const ids = ModuleCompare.SCAN_STEPS.map((s) => s.id);
  for (const prev of ids.slice(0, ids.indexOf(id))) if (stepState[prev] && stepState[prev].state !== "done") stepState[prev].state = "done";
  stepState[id] = { current, total, state: current >= total ? "done" : "running" };
  const index = ids.indexOf(id) + (total ? current / total : 0);
  el("mcProgressFill").style.width = `${Math.round((index / ids.length) * 100)}%`;
  renderSteps();
}

async function scan() {
  const btn = el("mcRescanBtn");
  btn.disabled = true;
  clearError(true);
  for (const k of Object.keys(stepState)) delete stepState[k];
  renderSteps();
  el("mcProgress").hidden = false;
  el("mcProgressFill").style.width = "0%";
  if (!result) el("mcEmpty").hidden = true;
  const { orgId, packageId, baseUrl } = sel;
  try {
    const r = await ModuleCompare.runScan({
      packageId: packageId || null,
      flow: {
        listPackages: async () => (await call({ type: "FT_PACKAGES", orgId })).packages,
        listAssets: async (pkg) => (await call({ type: "MC_ASSETS", orgId, packageId: pkg })).assets,
        readSource: async (m) => (await call({ type: "MC_SOURCE", orgId, assetId: m.id, versionId: m.versionId })).source,
        readDesigner: async (itemId, moduleIds) => call({ type: "MC_FLOW", orgId, itemId, moduleIds })
      },
      generateCode: async (projection) => {
        const response = await call({ type: "MC_GENERATE", baseUrl, projection });
        if (response.notFound) throw Object.assign(new Error(response.error), { notFound: true });
        return response.code;
      },
      ifsProjectionOf,
      onProgress: onStep
    });
    const full = { ...r, orgId, packageId: packageId || null, baseUrl };
    const saved = await send({ type: "MC_SAVE_RESULT", orgId, packageId, baseUrl, result: full });
    if (!saved.ok) showError(`The result could not be saved for later: ${saved.error}`);
    el("mcProgress").hidden = true;
    showResult(full);
  } catch (e) {
    const running = Object.values(stepState).find((st) => st.state === "running");
    if (running) running.state = "failed";
    renderSteps();
    showError(`Scan failed: ${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

el("mcUpdateAllBtn").onclick = async () => {
  const btn = el("mcUpdateAllBtn");
  const todo = result.modules.filter((m) => m.status === "changed" && !m.updated && m.newSource);
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.textContent = `Click again to update ${todo.length} module(s)`;
    setTimeout(() => { btn.dataset.armed = ""; btn.textContent = "Update all changed"; }, 5000);
    return;
  }
  btn.dataset.armed = "";
  btn.disabled = true;
  for (const [i, m] of todo.entries()) {
    btn.textContent = `Updating ${i + 1}/${todo.length}…`;
    if (!(await updateModule(m))) break;
  }
  btn.disabled = false;
  btn.textContent = "Update all changed";
};

async function main() {
  if (!sel.orgId || !sel.baseUrl) return showError("No organisation or IFS instance given — start the scan from the side panel's Module Compare tab.", true);
  el("mcTitle").textContent = `Module compare · ${params.get("org") || sel.orgId}`;
  document.title = `Module compare · ${params.get("org") || sel.orgId}`;
  el("mcSubtitle").textContent = `${params.get("pkg") || (sel.packageId ? sel.packageId : "All packages")}${sel.packageId ? " + App Library" : ""} · ${sel.baseUrl}`;
  send({ type: "LIST_INSTANCES" }).then((response) => {
    const instance = response.ok && response.instances.find((i) => i.baseUrl === sel.baseUrl);
    if (instance) el("mcSubtitle").textContent = el("mcSubtitle").textContent.replace(sel.baseUrl, instance.name);
  });
  el("mcRescanBtn").onclick = scan;
  el("mcFilter").addEventListener("input", () => result && renderList());
  el("mcOnlyChanged").addEventListener("change", () => result && renderList());
  const last = await send({ type: "MC_LAST_RESULT", ...sel });
  if (last.ok && last.result) showResult(last.result);
  if (params.get("scan") === "1") {
    params.delete("scan");
    history.replaceState(null, "", `?${params}`); // a reload shows, not rescans
    return scan();
  }
  if (!last.ok || !last.result) showResult(null);
}

main();
