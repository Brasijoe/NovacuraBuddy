/* Commit Dependencies tab: updates the open asset's users, a tree of the flows above it, bottom to top
 * (lib/flow-commit-chain.js). The preview lists the tree leaves first with what needs a commit and
 * why, all ticked; the run commits one asset at a time, stops at the first error and offers Undo
 * per commit. Deploy chips and the PROD confirmation are the Linked Flows ones. */

const cc = {
  inited: false,
  orgId: null,
  itemId: null,
  hasToken: false,
  plan: null,
  selected: new Set(),
  message: "", // the open asset's last commit message, passed on to the flows above it
  mode: "commit", // "commit" or "save" (save only moves the references and saves, no new version)
  run: null, // { done: Map id -> result, failed: { id, error } | null, running }
  envs: null,
  deploy: new Set(),
  prodOk: false,
  loadSeq: 0,
  loading: false,
  collapsed: new Set(), // nodes whose branch is folded away
  progress: null // { current, total, name } of the scan
};

const ccEl = (id) => document.getElementById(id);
const ccVisible = () => !ccEl("panel-commit-chain").hidden;
// Apps, pages and automations: committing them from here is switched off (their content is not stored like a flow's).
const ccIsProduct = (i) => /^(application|page|automation)$/.test(i.type || "");
const ccItem = (id) => (cc.plan ? cc.plan.items.find((i) => i.id === id) : null);

function ccOnShow() {
  if (!cc.inited) {
    cc.inited = true;
    ccEl("ccRescanBtn").addEventListener("click", () => ccLoad());
  }
  refreshCommitChainState(true);
}

/** From the 5s poll: follows the Designer tab (open flow, organisation) while the tab is shown. */
async function refreshCommitChainState(first) {
  if (!ccVisible() || (cc.run && cc.run.running)) return;
  const ctx = await send({ type: "LF_CONTEXT" });
  if (!ctx.ok) return;
  cc.hasToken = ctx.hasFlowToken;
  const hint = ccEl("ccSessionHint");
  hint.textContent = ctx.hasFlowToken ? "" : "No Flow session yet: open Flow in a tab (or refresh the open Flow tab) and click in it once.";
  hint.hidden = !hint.textContent;
  if (!ctx.hasFlowToken) return;
  const changed = ctx.itemId !== cc.itemId || ctx.orgId !== cc.orgId;
  cc.itemId = ctx.itemId;
  cc.orgId = ctx.orgId;
  if (!cc.itemId) { cc.plan = null; return ccRender(); }
  if ((first || changed) && !cc.loading) ccLoad();
}

async function ccLoad() {
  if (!cc.orgId || !cc.itemId || cc.loading) return;
  const seq = ++cc.loadSeq;
  cc.loading = true;
  cc.progress = null;
  cc.run = null;
  cc.plan = null;
  ccRender();
  const response = await sendOrShowError({ type: "CC_PLAN", orgId: cc.orgId, rootId: cc.itemId }, true);
  cc.loading = false;
  if (seq !== cc.loadSeq) return;
  if (!response) return ccRender();
  cc.plan = response.plan;
  cc.collapsed = new Set();
  const { active } = ccStructure();
  // Everything with something to update; the branches that are already up to date are greyed and left unticked.
  cc.selected = new Set(cc.plan.items.filter((i) => !i.missing && i.id !== cc.plan.rootId && !ccIsProduct(i) && active.get(i.id)).map((i) => i.id));
  cc.message = (ccItem(cc.plan.rootId) || {}).lastCommitMessage || "";
  cc.deploy = new Set();
  cc.prodOk = false;
  cc.envs = null;
  ccRender();
  ccLoadEnvironments();
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "CC_PROGRESS" || !cc.loading || message.orgId !== cc.orgId) return;
  cc.progress = { current: message.current, total: message.total, name: message.name };
  const status = ccEl("ccRoot").querySelector(".ft-env-status");
  if (status) status.textContent = `Scanning flow ${Math.min(cc.progress.current + 1, cc.progress.total)} of ${cc.progress.total}: ${cc.progress.name}`;
});

/** Flows and automations of the tree that a run would commit: the ones that can be deployed. */
const ccDeployables = () => (cc.plan && cc.mode === "commit" ? cc.plan.items.filter((i) => lfDeployable(i) && cc.selected.has(i.id)) : []);

async function ccLoadEnvironments() {
  const seq = cc.loadSeq;
  const flows = (cc.plan ? cc.plan.items.filter(lfDeployable) : []).map((i) => ({ id: i.id, packageId: i.packageId }));
  if (!flows.length) return;
  const response = await send({ type: "LF_ENVIRONMENTS", orgId: cc.orgId, flows });
  if (seq !== cc.loadSeq || (cc.run && cc.run.running)) return;
  cc.envs = response.ok ? { list: response.environments.filter((e) => e.type !== "dev"), deployed: response.deployed || {} } : { list: [], deployed: {}, error: response.error };
  ccRender();
}

/* --- rendering --- */

const ccPlural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function ccRender() {
  const root = ccEl("ccRoot");
  root.innerHTML = "";
  const title = ccEl("ccTitle");
  const rootItem = cc.plan ? ccItem(cc.plan.rootId) : null;
  title.textContent = rootItem ? `${rootItem.name} · ${rootItem.packageName}` : cc.itemId ? "" : "Open a flow in the Flow Designer.";
  if (cc.loading) { root.appendChild(lfH("span", { className: "ft-env-status", textContent: cc.progress ? `Scanning flow ${Math.min(cc.progress.current + 1, cc.progress.total)} of ${cc.progress.total}: ${cc.progress.name}` : "Listing the assets…" })); return; }
  if (!cc.plan) return;
  if (cc.run && (cc.run.finished || cc.run.failed)) return ccRenderResults(root);

  const items = cc.plan.items;
  if (cc.plan.cycles.length) {
    root.appendChild(lfH("div", { className: "lf-strip lf-strip-warn" },
      lfH("strong", { textContent: "Flows that use each other" }),
      lfH("span", { className: "api-hint", textContent: `${cc.plan.cycles.map((c) => c.join(" → ")).join("; ")}. These cannot be put in order; the loop is cut where it closes, so one of them is committed before it points at the other's newest version.` })));
  }
  root.appendChild(lfH("div", { className: "lf-label" },
    lfH("h2", { textContent: "Used by" }),
    lfH("span", { className: "list-count", textContent: items.length === 1 ? "Nothing uses it" : ccPlural(items.length - 1, "asset uses it", "assets use it") }),
    lfH("button", { type: "button", className: "btn-ghost", textContent: "All", title: "Tick every asset", onclick: () => { cc.selected = new Set(cc.plan.items.filter((i) => !i.missing && i.id !== cc.plan.rootId && !ccIsProduct(i)).map((i) => i.id)); ccRender(); } }),
    lfH("button", { type: "button", className: "btn-ghost", textContent: "None", title: "Untick every asset", onclick: () => { cc.selected = new Set(); ccRender(); } }),
    infoTip("The open asset at the top and, branching below it, the flows that use it, and the flows that use those. All are ticked; unticking one leaves out its whole branch. The run goes bottom to top: the open asset first, then each flow above it, pointed at the new versions below it. Hover a row for details."),
    lfH("button", { type: "button", className: "btn-ghost", textContent: "Copy scan info", title: "Copies what was scanned (every asset, its package and whether it was read) to send to the developer",
      onclick: async (e) => { try { await navigator.clipboard.writeText(cc.plan.info); e.target.textContent = "Copied"; } catch { e.target.textContent = "Copy failed"; } } })));
  if (cc.plan.failedPackages && cc.plan.failedPackages.length) root.appendChild(lfH("div", { className: "banner banner-error", textContent: `The asset list of ${ccPlural(cc.plan.failedPackages.length, "package", "packages")} could not be read, so flows in them were not scanned: ${cc.plan.failedPackages.slice(0, 5).join("; ")}` }));
  const list = lfH("div", { className: "cc-tree" });
  const order = new Map(items.map((i, n) => [i.id, n + 1]));
  for (const row of ccTreeLayout()) list.appendChild(ccRow(ccItem(row.id), order.get(row.id), row.guide, row));
  root.appendChild(list);
  root.appendChild(ccRenderMode());
  if (cc.mode === "commit") root.appendChild(ccRenderDeploy());

  const chosen = items.filter((i) => cc.selected.has(i.id) && i.id !== cc.plan.rootId);
  const envCount = cc.mode === "commit" ? cc.deploy.size : 0;
  const blockedByProd = cc.mode === "commit" && ccDeployProd().length > 0 && !cc.prodOk;
  const busy = !!(cc.run && cc.run.running);
  const verb = `${cc.mode === "save" ? "Save" : "Commit"} ${ccPlural(chosen.length, "asset", "assets")}`;
  const run = lfCta({
    icon: "push", label: envCount ? `${verb} & deploy` : verb, badge: envCount ? ccPlural(envCount, "environment", "environments") : null,
    disabled: !chosen.length || blockedByProd || busy,
    title: blockedByProd ? "Confirm the production deploy first." : "Runs from the open asset up through the flows that use it and stops at the first error"
  });
  if (busy) lfSetLabel(run, "Committing…");
  run.addEventListener("click", ccRun);
  root.appendChild(lfH("div", { className: "lf-cta-row" }, run,
    infoTip("Handles the ticked assets one by one, bottom to top. Before a flow is committed or saved it is pointed at the new versions of what it uses and saved with all its steps. The first error stops the run; what was done stays done and can be undone.")));
  if (busy) root.appendChild(ccProgress());
}

function ccRenderMode() {
  const busy = !!(cc.run && cc.run.running);
  const box = lfH("div", { className: "lf-deploy" });
  box.appendChild(lfH("div", { className: "lf-label" }, lfH("h2", { textContent: "What to do" }),
    infoTip("Commit: the flows point at the new versions and get a new committed version (and can be deployed afterwards). Save: the flows point at the new versions and are saved, but no new version is committed, so you can check them in the Designer first. The open asset itself is only committed, never just saved.")));
  const row = lfH("div", { className: "cc-mode" });
  for (const [value, label] of [["commit", "Commit"], ["save", "Save only"]]) {
    const input = lfH("input", { type: "radio", name: "ccMode", checked: cc.mode === value, disabled: busy });
    input.addEventListener("change", () => { cc.mode = value; ccRender(); });
    row.appendChild(lfH("label", { className: "api-check" }, input, lfH("span", { textContent: label })));
  }
  box.appendChild(row);
  const rootItem = ccItem(cc.plan.rootId);
  const msg = lfH("input", { type: "text", className: "cc-message", value: cc.message, placeholder: "Auto generated version.", disabled: busy });
  msg.addEventListener("input", () => { cc.message = msg.value; });
  box.appendChild(lfH("label", { className: "cc-message-row" },
    lfH("span", { className: "api-hint", textContent: `Commit message of ${rootItem ? rootItem.name : "the open asset"}` }), msg,
    infoTip(`The flows above the open asset are committed as "Commit from Asset ${rootItem ? rootItem.name : "<asset>"}: <this message>". It starts as the open asset's last commit message when Flow tells it, otherwise empty (then "Auto generated version.").`)));
  return box;
}

/** The tree as parent/children (from the plan's depth-first list), the children of every node
 *  with something to update first and the branches that are all up to date last. */
function ccStructure() {
  const kids = new Map(), stack = [];
  for (const { id, depth } of cc.plan.tree) {
    kids.set(id, []);
    stack.length = depth;
    if (depth) kids.get(stack[depth - 1]).push(id);
    stack[depth] = id;
  }
  const active = new Map(); // branch has something to update
  const mark = (id) => { const below = kids.get(id).map((k) => mark(k)).some(Boolean); const a = !!(ccItem(id) || {}).needs || below; active.set(id, a); return a; };
  mark(cc.plan.rootId);
  for (const list of kids.values()) list.sort((x, y) => Number(active.get(y)) - Number(active.get(x))); // stable: active first
  return { kids, active };
}

/** The rows to draw, each with its connector guide ("│  ├─ "); collapsed nodes hide their branch. */
function ccTreeLayout() {
  const { kids, active } = ccStructure();
  const rows = [];
  const walk = (id, prefix, last, depth) => {
    rows.push({ id, guide: depth ? prefix + (last ? "└─ " : "├─ ") : "", grey: !active.get(id), kids: kids.get(id).length });
    if (cc.collapsed.has(id)) return;
    const list = kids.get(id);
    list.forEach((k, i) => walk(k, depth ? prefix + (last ? "   " : "│  ") : "", i === list.length - 1, depth + 1));
  };
  // The open asset is the source and not part of the tree: what uses it are the top level entries.
  const top = kids.get(cc.plan.rootId);
  top.forEach((k, i) => walk(k, "", i === top.length - 1, 0));
  return rows;
}

/** Ids of the branch below a node: every asset that uses it, directly or through others. */
function ccBranch(id) {
  const { kids } = ccStructure();
  const out = [];
  const walk = (n) => { for (const k of kids.get(n)) { out.push(k); walk(k); } };
  walk(id);
  return out;
}

function ccRow(item, number, guide, row) {
  const state = cc.run && cc.run.done.get(item.id);
  const failed = cc.run && cc.run.failed && cc.run.failed.id === item.id;
  const input = lfH("input", { type: "checkbox", checked: cc.selected.has(item.id), disabled: !!(cc.run && cc.run.running) || item.missing || ccIsProduct(item), title: ccIsProduct(item) ? `Committing ${item.type}s from here is switched off: update it in the Designer.` : "" });
  input.addEventListener("change", () => {
    for (const id of [item.id, ...ccBranch(item.id)]) if (input.checked) cc.selected.add(id); else cc.selected.delete(id);
    ccRender();
  });
  const info = [`${item.type}${item.packageName ? ` · ${item.packageName}` : " · App Library"}`, ...item.reasons.map((r) => r.text), item.missing ? "Not found in this organisation" : null,
    ...(item.products || []).map((p) => `Runs as ${p.type} "${p.name}"`)].filter(Boolean).join("\n");
  const fold = row.kids
    ? lfH("button", { type: "button", className: "btn-ghost cc-fold", textContent: cc.collapsed.has(item.id) ? "▸" : "▾", title: cc.collapsed.has(item.id) ? `Show the ${ccPlural(ccBranch(item.id).length, "asset", "assets")} below` : "Hide the branch below",
        onclick: () => { if (cc.collapsed.has(item.id)) cc.collapsed.delete(item.id); else cc.collapsed.add(item.id); ccRender(); } })
    : lfH("span", { className: "cc-fold" });
  return lfH("div", { className: `cc-node${row.grey ? " cc-grey" : ""}`, title: info },
    lfH("span", { className: "cc-guide", textContent: guide }), fold,
    lfH("label", { className: "cc-main" }, input, ftKindIcon(item.type), lfH("strong", { className: "ft-name", textContent: item.name })),
    state ? ftChip("Committed", "ok") : failed ? ftChip("Failed", "warn", cc.run.failed.error) : lfH("span"));
}

function ccProgress() {
  const chosen = cc.plan.items.filter((i) => cc.selected.has(i.id));
  return lfH("span", { className: "ft-env-status", textContent: `${cc.run.commit ? "Committed" : "Saved"} ${cc.run.done.size} of ${chosen.length}…` });
}

const ccDeployProd = () => (cc.envs ? cc.envs.list.filter((e) => e.isProduction && cc.deploy.has(e.id)) : []);

function ccRenderDeploy() {
  const box = lfH("div", { className: "lf-deploy" });
  box.appendChild(lfH("div", { className: "lf-label" }, lfH("h2", { textContent: "Deploy afterwards" }),
    infoTip("Optional. Tick the environments that should get the new versions once every commit went through. Only flows and automations are deployed, each from its own package; modules and sub-flows ship inside them. Nothing is remembered: every run starts with none ticked.")));
  if (!cc.plan.items.some(lfDeployable)) {
    box.appendChild(lfH("span", { className: "api-hint", textContent: "No flow or automation in this tree can be deployed on its own. Sub-flows and modules reach an environment with the flows that use them." }));
    return box;
  }
  if (!cc.envs) { box.appendChild(lfH("span", { className: "api-hint", textContent: "Reading environments…" })); return box; }
  if (cc.envs.error) { box.appendChild(lfH("span", { className: "api-hint", textContent: `Environments could not be read: ${cc.envs.error}` })); return box; }
  if (!cc.envs.list.length) { box.appendChild(lfH("span", { className: "api-hint", textContent: "This organisation has no environments to deploy to." })); return box; }
  const busy = !!(cc.run && cc.run.running);
  const ids = ccDeployables().map((i) => i.id);
  const chips = lfH("div", { className: "lf-env-chips" });
  for (const env of cc.envs.list) {
    const on = cc.deploy.has(env.id);
    const live = ids.filter((id) => (cc.envs.deployed[id] || []).includes(env.id)).length;
    const chip = lfH("button", { type: "button", disabled: busy, className: `lf-env-chip lf-env-${env.isProduction ? "prod" : env.type}${on ? " is-on" : ""}`, "aria-pressed": String(on),
      title: `${env.name} (${env.type})${live ? ` · ${live} of these flows deployed there now` : ""}` },
      lfH("span", { className: "lf-env-check", textContent: on ? "✓" : "" }),
      lfH("span", { textContent: env.name }),
      env.isProduction ? lfH("span", { className: "lf-env-tag", textContent: "PROD" }) : null,
      live ? lfH("span", { className: "lf-env-live", title: "Deployed there now" }) : null);
    chip.addEventListener("click", () => {
      if (on) cc.deploy.delete(env.id); else cc.deploy.add(env.id);
      if (!ccDeployProd().length) cc.prodOk = false;
      ccRender();
    });
    chips.appendChild(chip);
  }
  box.appendChild(chips);
  const prod = ccDeployProd();
  if (prod.length) {
    const ok = lfH("input", { type: "checkbox", checked: cc.prodOk, disabled: busy });
    ok.addEventListener("change", () => { cc.prodOk = ok.checked; ccRender(); });
    box.appendChild(lfH("div", { className: "lf-strip lf-strip-danger" },
      lfH("strong", { textContent: `⚠ Deploying to production: ${prod.map((e) => e.name).join(", ")}` }),
      lfH("span", { className: "api-hint", textContent: "Users there get the new versions as soon as the deploy finishes." }),
      lfH("label", { className: "api-check" }, ok, lfH("span", { textContent: `Yes, deploy to ${prod.map((e) => e.name).join(", ")}` }))));
  }
  return box;
}

/* --- run --- */

async function ccRun() {
  if (cc.run && cc.run.running) return;
  // A module has nothing to save without a commit, so a save-only run leaves it out.
  const items = cc.plan.items.filter((i) => cc.selected.has(i.id) && i.id !== cc.plan.rootId && !ccIsProduct(i) && (cc.mode === "commit" || i.type !== "module"));
  const run = { done: new Map(), failed: null, running: true, finished: false, deployRows: [], commit: cc.mode === "commit" };
  cc.run = run;
  ccRender();
  const committedHere = new Set();
  for (const item of items) {
    // A reference moves to its dependency's head version when that dependency is committed (before
    // or in this run); one that still has uncommitted changes and was not ticked is left alone.
    const bump = item.deps.map((d) => ccItem(d.id)).filter((dep) => dep && !dep.missing && (!dep.dirty || committedHere.has(dep.id)))
      .map((dep) => ({ assetId: dep.id, packageId: dep.packageId, headVersionId: dep.headVersionId }));
    const asset = { id: item.id, name: item.name, type: item.type, packageId: item.packageId, mainBranch: item.branchId ? { id: item.branchId, headVersionId: item.headVersionId } : null };
    const rootItem = ccItem(cc.plan.rootId);
    const text = (cc.message || "").trim();
    const commitMessage = item.id === cc.plan.rootId ? (text || undefined) : `Commit from Asset ${rootItem ? rootItem.name : ""}: ${text || "Auto generated version."}`;
    const response = await send({ type: "CC_COMMIT", orgId: cc.orgId, asset, bump, commit: run.commit, commitMessage });
    if (!response || !response.ok) {
      run.failed = { id: item.id, error: (response && response.error) || "No response from the extension." };
      break;
    }
    committedHere.add(item.id);
    run.done.set(item.id, { headVersionId: response.headVersionId, undo: response.undo });
    ccRender();
  }
  try {
    if (!run.failed && run.commit && cc.deploy.size) await ccDeploy(run);
  } catch (e) {
    run.deployRows.push({ ok: false, title: "Deploy", note: e.message });
  } finally {
    run.running = false;
    run.finished = true;
    ccRender();
  }
}

async function ccDeploy(run) {
  const committed = [...run.done.keys()];
  const flows = ccDeployables().filter((i) => committed.includes(i.id));
  const envs = cc.envs ? cc.envs.list.filter((e) => cc.deploy.has(e.id)) : [];
  if (!flows.length) { run.deployRows.push({ ok: true, title: "Nothing to deploy", note: "No flow or automation was committed in this run." }); return; }
  const name = (id) => { const i = ccItem(id); return i ? i.name : id; };
  for (const env of envs) {
    const res = await send({ type: "LF_DEPLOY", orgId: cc.orgId, envId: env.id, assetIds: flows.map((f) => f.id), flows: flows.map((f) => ({ id: f.id, type: f.type, packageId: f.packageId, headVersionId: (run.done.get(f.id) || {}).headVersionId || null })) });
    const label = `${env.name}${env.isProduction ? " (PROD)" : ""}`;
    if (!res.ok) { run.deployRows.push({ ok: false, title: `Deploy to ${label}`, note: res.error }); continue; }
    const good = res.results.filter((x) => x.ok);
    const bad = res.results.filter((x) => !x.ok);
    if (!res.results.length) bad.push({ id: flows[0].id, error: "Flow was not asked to deploy anything: none of the committed assets could be matched to a deployable flow or automation." });
    run.deployRows.push({
      ok: !!good.length,
      title: `${!good.length ? "Not deployed to" : bad.length ? "Partly deployed to" : "Deployed to"} ${label}`,
      note: [good.length ? good.map((x) => name(x.id)).join(", ") : null, ...bad.map((x) => `${name(x.id)}: ${x.error}`)].filter(Boolean).join(" · ")
    });
  }
}

function ccRenderResults(root) {
  const run = cc.run;
  const items = cc.plan.items.filter((i) => cc.selected.has(i.id));
  const failedItem = run.failed ? ccItem(run.failed.id) : null;
  root.appendChild(lfH("div", { className: run.failed ? "banner banner-warning" : "banner banner-deployed",
    textContent: run.failed ? `Stopped at ${failedItem ? failedItem.name : "an asset"}: ${ccPlural(run.done.size, "asset", "assets")} ${run.commit ? "committed" : "saved"}, the rest untouched.` : `${run.commit ? "Committed" : "Saved"} ${ccPlural(run.done.size, "asset", "assets")}, bottom to top.` }));
  const row = (mark, tone, title, note, actions) => lfH("div", { className: "lf-res" },
    lfH("span", { className: `lf-mark lf-mark-${tone}`, textContent: mark }),
    lfH("span", { className: "lf-res-text" }, lfH("strong", { textContent: title }), lfH("span", { className: "api-hint", textContent: note || "" })),
    actions || lfH("span"));
  for (const item of items) {
    const result = run.done.get(item.id);
    const failed = run.failed && run.failed.id === item.id;
    if (result) {
      const actions = lfH("span", { className: "lf-res-actions" }, lfH("button", { className: "btn-ghost", textContent: "Open", onclick: () => lfOpenInDesigner2(item.id) }));
      if (result.undo) {
        const undo = lfH("button", { className: "btn-ghost", textContent: "Undo", title: "Put this asset back to what it was before this run, as a new version. Flows above it keep pointing at the version they have." });
        undo.addEventListener("click", async () => {
          undo.disabled = true;
          undo.textContent = "Undoing…";
          const res = await sendOrShowError({ type: "CC_UNDO", orgId: cc.orgId, asset: { id: item.id, name: item.name, type: item.type, packageId: item.packageId }, undo: result.undo }, true);
          if (res) { result.undo = null; undo.remove(); showNotice(`${item.name} is back to its content before the commit.`); } else { undo.disabled = false; undo.textContent = "Undo"; }
        });
        actions.appendChild(undo);
      }
      root.appendChild(row("✓", "ok", item.name, `${item.packageName || "App Library"} · ${run.commit ? "committed" : "saved"}`, actions));
    } else if (failed) {
      root.appendChild(row("!", "fail", item.name, run.failed.error));
    } else {
      root.appendChild(row("–", "skip", item.name, run.failed ? "not done: the run stopped before it" : ""));
    }
  }
  for (const d of run.deployRows) root.appendChild(row(d.ok ? "✓" : "!", d.ok ? "ok" : "fail", d.title, d.note));
  root.appendChild(lfH("div", { className: "deploy-actions" }, lfH("button", { textContent: run.failed ? "Back to the list" : "Done", onclick: () => ccLoad() })));
}

function lfOpenInDesigner2(id) {
  chrome.tabs.create({ url: `https://build.novacura.com/admin/design/designer/organizations/${cc.orgId}/items/${id}` });
}
