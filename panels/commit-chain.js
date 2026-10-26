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
  mode: "commit", // "commit" or "save" (save only moves the references and saves, no new version)
  open: new Set(), // rows with their dependency list unfolded
  run: null, // { done: Map id -> result, failed: { id, error } | null, running }
  envs: null,
  deploy: new Set(),
  prodOk: false,
  loadSeq: 0,
  loading: false,
  progress: null // { current, total, name } of the scan
};

const ccEl = (id) => document.getElementById(id);
const ccVisible = () => !ccEl("panel-commit-chain").hidden;
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
  cc.selected = new Set(cc.plan.items.filter((i) => i.needs).map((i) => i.id));
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
  const needing = items.filter((i) => i.needs);
  const unknown = items.some((i) => !i.known && !i.missing);
  if (cc.plan.cycles.length) {
    root.appendChild(lfH("div", { className: "lf-strip lf-strip-warn" },
      lfH("strong", { textContent: "Flows that use each other" }),
      lfH("span", { className: "api-hint", textContent: `${cc.plan.cycles.map((c) => c.join(" → ")).join("; ")}. These cannot be put in order; the loop is cut where it closes, so one of them is committed before it points at the other's newest version.` })));
  }
  root.appendChild(lfH("div", { className: "lf-label" },
    lfH("h2", { textContent: "Used by" }),
    lfH("span", { className: "list-count", textContent: items.length === 1 ? "Nothing uses it" : `${ccPlural(items.length - 1, "asset uses", "assets use")} it · ${needing.length} to update` }),
    infoTip("The open asset at the top and, indented below it, the flows that use it, and the flows that use those. Untick what should stay as it is. The run goes bottom to top: the open asset first, then each flow above it, pointed at the new versions below it. A row says why it is ticked: changes of its own, an older version of something it uses, or something it uses that is updated first.")));
  root.appendChild(lfH("span", { className: "api-hint", textContent: `Scanned ${ccPlural(cc.plan.scanned, "flow", "flows")}${cc.plan.failed.length ? `; ${cc.plan.failed.length} could not be read (${cc.plan.failed.slice(0, 5).join(", ")}${cc.plan.failed.length > 5 ? ", …" : ""})` : ""}.` }));
  if (!needing.length) {
    root.appendChild(lfH("div", { className: "banner banner-deployed", textContent: unknown ? "Nothing is marked as changed. Flow doesn't say which assets have uncommitted changes, so tick the ones you want updated below." : "Everything in this tree is up to date." }));
  }
  const list = lfH("div", { className: "lf-diff cc-list" });
  const order = new Map(items.map((i, n) => [i.id, n + 1]));
  for (const { id, depth } of cc.plan.tree) {
    const item = ccItem(id);
    const wrap = ccRow(item, order.get(id));
    wrap.style.marginLeft = `${Math.min(depth, 6) * 14}px`;
    list.appendChild(wrap);
    if (cc.open.has(item.id)) list.appendChild(ccDeps(item));
  }
  root.appendChild(list);
  root.appendChild(ccRenderMode());
  if (cc.mode === "commit") root.appendChild(ccRenderDeploy());

  const chosen = items.filter((i) => cc.selected.has(i.id));
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
  return box;
}

function ccRow(item, number) {
  const checked = cc.selected.has(item.id);
  const state = cc.run && cc.run.done.get(item.id);
  const failed = cc.run && cc.run.failed && cc.run.failed.id === item.id;
  const input = lfH("input", { type: "checkbox", checked, disabled: !!(cc.run && cc.run.running) || item.missing });
  input.addEventListener("change", () => { if (input.checked) cc.selected.add(item.id); else cc.selected.delete(item.id); ccRender(); });
  const chips = ftChipRow(
    ...item.reasons.map((r) => ftChip(r.kind === "dirty" ? "Uncommitted" : r.kind === "newer" ? "Older dependency" : "Dependency first", r.kind === "dirty" ? "warn" : "info", r.text)),
    !item.needs ? ftChip(item.known ? "Up to date" : "Unknown state", item.known ? "ok" : "muted", item.known ? "Committed, and it uses the latest versions." : `Flow doesn't say whether this asset has uncommitted changes (branch fields: ${item.branchKeys.join(", ") || "none"}).`) : null,
    item.missing ? ftChip("Not found", "warn", "Referenced, but not in this organisation's packages or App Library.") : null,
    item.packageId ? null : ftChip("App Library", "muted", "Shared by all packages"));
  const row = lfH("div", { className: "lf-diff-row cc-row" },
    lfH("span", { className: "cc-n", textContent: String(number) }),
    lfH("label", { className: "cc-main" }, input, ftKindIcon(item.type), lfH("strong", { className: "ft-name", textContent: item.name })),
    state ? ftChip("Committed", "ok") : failed ? ftChip("Failed", "warn", cc.run.failed.error) : item.deps.length ? lfH("button", { type: "button", className: "btn-ghost cc-fold", textContent: cc.open.has(item.id) ? "Hide uses" : `Uses ${item.deps.length}`, title: "The assets this one references", onclick: () => { if (cc.open.has(item.id)) cc.open.delete(item.id); else cc.open.add(item.id); ccRender(); } }) : lfH("span"));
  const wrap = lfH("div", { className: "cc-item" }, row, lfH("div", { className: "cc-chips" }, chips));
  return wrap;
}

function ccDeps(item) {
  const box = lfH("div", { className: "cc-deps" });
  const steps = item.steps !== null ? `${ccPlural(item.steps, "step", "steps")}` : "";
  box.appendChild(lfH("span", { className: "api-hint", textContent: `${steps}${steps && item.deps.length ? " · " : ""}${item.deps.length ? "uses:" : ""}` }));
  for (const d of item.deps) {
    const dep = ccItem(d.id);
    const note = d.outdated ? "newer version available" : dep && dep.needs ? "committed first" : "up to date";
    box.appendChild(lfH("div", { className: "cc-dep" }, ftKindIcon(d.type), lfH("span", { className: "ft-name", textContent: d.name }), lfH("span", { className: "api-hint", textContent: note })));
  }
  return box;
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
  const items = cc.plan.items.filter((i) => cc.selected.has(i.id) && (cc.mode === "commit" || i.type !== "module"));
  const run = { done: new Map(), failed: null, running: true, finished: false, deployRows: [], commit: cc.mode === "commit" };
  cc.run = run;
  ccRender();
  const committedHere = new Set();
  for (const item of items) {
    // A reference moves to its dependency's head version when that dependency is committed (before
    // or in this run); one that still has uncommitted changes and was not ticked is left alone.
    const bump = item.deps.map((d) => ccItem(d.id)).filter((dep) => dep && !dep.missing && (!dep.dirty || committedHere.has(dep.id)))
      .map((dep) => ({ assetId: dep.id, packageId: dep.packageId }));
    const asset = { id: item.id, name: item.name, type: item.type, packageId: item.packageId };
    const response = await send({ type: "CC_COMMIT", orgId: cc.orgId, asset, bump, commit: run.commit });
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
    const res = await send({ type: "LF_DEPLOY", orgId: cc.orgId, envId: env.id, assetIds: flows.map((f) => f.id) });
    const label = `${env.name}${env.isProduction ? " (PROD)" : ""}`;
    if (!res.ok) { run.deployRows.push({ ok: false, title: `Deploy to ${label}`, note: res.error }); continue; }
    const good = res.results.filter((x) => x.ok);
    const bad = res.results.filter((x) => !x.ok);
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
