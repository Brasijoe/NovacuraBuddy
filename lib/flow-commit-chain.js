/* ============================================================
   Flow Commit Chain — commits an asset and everything that uses it,
   the asset itself first. A flow references its modules and sub-flows at one version
   each, so a changed dependency has to be committed before the flow
   above it, and that flow then has to point at the dependency's new
   version before it is committed itself.

   plan   reads the tree ABOVE an asset (the flows that use it, and the
          flows that use those), orders it bottom to top and marks what
          needs a commit: own uncommitted changes, a dependency with a
          newer version, a dependency that is committed first.
   commitOne commits one asset: a module is committed again with its
          current code (the sequence Create module uses), a flow gets
          its dependency references moved to their head versions and is
          saved with its FULL data (never only the new events), then
          committed (or only saved, with commit: false). Returns what Undo needs.

   UNVERIFIED live: which fields tell an uncommitted asset (the Flow
   asset listing is read for a few likely ones, see branchState), and
   the flow commit sequence (see FlowDesignerTab.commitFlow).
   ============================================================ */
(function (global) {
  const FlowModules = typeof require === "function" ? require("./flow-modules.js") : global.FlowModules;
  const FlowDesignerTab = typeof require === "function" ? require("./flow-designer-tab.js") : global.FlowDesignerTab;
  const FlowTransfer = typeof require === "function" ? require("./flow-transfer.js") : global.FlowTransfer;
  const FlowLinks = typeof require === "function" ? require("./flow-links.js") : global.FlowLinks;

  const DIRTY_KEYS = ["hasUncommittedChanges", "hasChanges", "isDirty", "isModified", "modified", "uncommitted"];
  const COMMITTED_KEYS = ["latestCommittedVersionId", "latestCommittedVersion", "lastCommittedVersionId", "committedVersionId"];

  /** { dirty, known } from what an asset (or its mainBranch) says about uncommitted changes:
   *  a boolean flag, or a latest-committed version that is not the head. known is false when
   *  Flow tells nothing of the sort, so the UI can offer to commit such assets anyway. */
  function branchState(asset) {
    const branch = asset && asset.mainBranch;
    for (const src of [branch, asset]) {
      if (!src) continue;
      for (const k of DIRTY_KEYS) if (typeof src[k] === "boolean") return { dirty: src[k], known: true };
    }
    if (branch) {
      for (const k of COMMITTED_KEYS) {
        if (branch[k] === undefined) continue;
        return { dirty: !branch[k] || branch[k] !== branch.headVersionId, known: true };
      }
    }
    return { dirty: false, known: false };
  }

  /** Marks what needs a commit, in place. `order` is bottom to top (a dependency before its
   *  users), `nodes` id -> { dirty, deps: [{ id, outdated }], missing }. A node needs a commit
   *  when it has changes of its own, uses a dependency that has a newer version, or uses one
   *  that is committed before it. `reasons` says which, for the preview. */
  function markNeeds(order, nodes) {
    for (const id of order) {
      const n = nodes.get(id);
      n.reasons = [];
      if (n.missing) { n.needs = false; continue; }
      if (n.dirty) n.reasons.push({ kind: "dirty", text: "Uncommitted changes" });
      for (const d of n.deps) {
        const dep = nodes.get(d.id);
        if (d.outdated) n.reasons.push({ kind: "newer", text: `Uses an older version of ${d.name}` });
        else if (dep && dep.needs) n.reasons.push({ kind: "below", text: `${d.name} gets a new version first` });
      }
      n.needs = n.reasons.length > 0;
    }
    return order.map((id) => nodes.get(id));
  }

  /** The tree ABOVE `rootId`: the flows that use it, the flows that use those, and so on (a flow
   *  only ever uses assets of its own package and the App Library, so only that package's flows
   *  are read). `items` is bottom to top (the root first, a user after everything it uses) and is
   *  the commit order; `tree` is the same assets for display, as { id, depth } with the users of an
   *  asset under it. Each asset is listed once. A reference cycle cannot be ordered: it is cut
   *  where it closes and listed in `cycles` ([[names…]]). */
  async function plan({ flowFetch, orgId, rootId, scanResult, log, concurrency = 4 }) {
    const index = new Map(scanResult.assets.map((a) => [a.id, a]));
    const root = index.get(rootId);
    if (!root) throw new Error("The open asset was not found in this organisation.");
    const candidates = scanResult.assets.filter((a) => a.type !== "module" && (!root.packageId || !a.packageId || a.packageId === root.packageId));

    // What every candidate flow references, with the version it points at (GET only).
    const refs = new Map(); // flow id -> [{ assetId, assetVersion }]
    const steps = new Map();
    let next = 0;
    const worker = async () => {
      while (next < candidates.length) {
        const flow = candidates[next++];
        try {
          const designer = await FlowDesignerTab.getDesignerData({ flowFetch, orgId, itemId: flow.id });
          refs.set(flow.id, (designer.assets || []).filter((r) => r.assetId !== flow.id));
          steps.set(flow.id, [...FlowLinks.materialize(designer.data).values()].filter((e) => e.kind !== "arrow").length);
        } catch (e) { if (log) log("Commit chain: could not read", flow.name, e.message); }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));

    // Who uses whom, and the tree above the root (depth first, users under the asset they use).
    const users = new Map(); // asset id -> [flow id]
    for (const [flowId, list] of refs) for (const r of new Set(list.map((x) => x.assetId))) (users.get(r) || users.set(r, []).get(r)).push(flowId);
    const byName = (x, y) => (index.get(x).name || "").localeCompare(index.get(y).name || "");
    const tree = [], cycles = [], inTree = new Set();
    (function walk(id, depth, path) {
      inTree.add(id);
      tree.push({ id, depth });
      for (const u of (users.get(id) || []).sort(byName)) {
        if (path.has(u)) { cycles.push([...path, id, u].map((x) => index.get(x).name)); continue; }
        if (inTree.has(u)) continue;
        walk(u, depth + 1, new Set(path).add(id));
      }
    })(rootId, 0, new Set());

    const nodes = new Map();
    for (const { id } of tree) {
      const asset = index.get(id);
      const fresh = await FlowModules.getModuleAsset({ flowFetch, orgId, packageId: asset.packageId, assetId: id }).catch(() => asset);
      const mainBranch = fresh.mainBranch || asset.mainBranch;
      const state = branchState({ ...asset, ...fresh, mainBranch });
      nodes.set(id, {
        id, name: asset.name, type: asset.type, packageId: asset.packageId, packageName: asset.packageName,
        headVersionId: (mainBranch || {}).headVersionId || null, dirty: state.dirty, known: state.known,
        branchKeys: Object.keys(mainBranch || {}), deps: [], steps: steps.has(id) ? steps.get(id) : null
      });
      if (log) log("Commit chain: read", asset.name);
    }
    for (const node of nodes.values()) {
      for (const r of refs.get(node.id) || []) {
        const dep = nodes.get(r.assetId);
        if (!dep || node.deps.some((d) => d.id === dep.id)) continue; // only what is in this tree
        node.deps.push({ id: dep.id, name: dep.name, type: dep.type, version: r.assetVersion || null, headVersionId: dep.headVersionId,
          outdated: !!(r.assetVersion && dep.headVersionId && r.assetVersion !== dep.headVersionId && !dep.dirty) });
      }
    }

    // Bottom to top: an asset after everything of the tree it uses.
    const order = [], seen = new Set();
    const place = (id) => {
      if (seen.has(id)) return;
      seen.add(id); // marked first, so a cycle ends here
      for (const d of nodes.get(id).deps) place(d.id);
      order.push(id);
    };
    for (const { id } of tree) place(id);
    const items = markNeeds(order, nodes);
    for (const { id, depth } of tree) nodes.get(id).depth = depth;
    return { rootId, orgId, cycles, items, tree };
  }

  /** Commits one asset (a plan item). `bump` lists the dependencies whose reference moves to
   *  their current head version ({ assetId, packageId }): the ones committed before this run
   *  and in it, never one that still has unselected uncommitted changes. Returns { headVersionId,
   *  undo } where undo puts the previous content back as a new version. */
  async function commitOne({ flowFetch, orgId, asset, bump, log, commit = true }) {
    const { id, name, type, packageId } = asset;
    if (type === "module" && !commit) return { headVersionId: null, undo: null }; // a module has nothing to save
    if (type === "module") {
      const previousSource = await FlowModules.getModuleSource({ flowFetch, orgId, packageId, assetId: id });
      if (!String(previousSource).trim()) throw new Error(`${name} has no code to commit.`);
      const branch = await FlowModules.commitModuleCode({ flowFetch, orgId, packageId, assetId: id, flowScriptCode: previousSource });
      if (log) log("Commit chain: committed module", name);
      return { headVersionId: branch.headVersionId, undo: { kind: "module", previousSource } };
    }
    const current = await FlowDesignerTab.getDesignerData({ flowFetch, orgId, itemId: id });
    const bumpIds = new Map((bump || []).map((b) => [b.assetId, b.packageId]));
    const idMap = {};
    const assets = [];
    for (const ref of current.assets || []) {
      if (!bumpIds.has(ref.assetId)) { assets.push(ref); continue; }
      const meta = await FlowModules.getModuleAsset({ flowFetch, orgId, packageId: bumpIds.get(ref.assetId), assetId: ref.assetId });
      const head = meta.mainBranch.headVersionId;
      if (ref.assetVersion && ref.assetVersion !== head) idMap[ref.assetVersion] = head;
      assets.push({ ...ref, assetVersion: head });
    }
    const data = Object.keys(idMap).length ? FlowTransfer.remap(current.data, idMap, null) : current.data;
    const snapshot = { ...FlowLinks.designerSnapshot(current), assets, data: Array.isArray(data) ? data : [] };
    const { previous, branch } = await FlowLinks.saveAndCommit({ flowFetch, orgId, asset: { id, packageId }, snapshot, message: "Committed with its dependencies by Novacura Buddy.", commit });
    if (log) log(`Commit chain: ${commit ? "committed" : "saved"} flow`, name);
    return { headVersionId: branch && branch.headVersionId, undo: { kind: "flow", previous, saved: !commit } };
  }

  /** Puts an asset back to the content it had before commitOne, as a new version. */
  async function undoOne({ flowFetch, orgId, asset, undo }) {
    if (undo.kind === "module") {
      await FlowModules.commitModuleCode({ flowFetch, orgId, packageId: asset.packageId, assetId: asset.id, flowScriptCode: undo.previousSource });
    } else {
      await FlowLinks.saveAndCommit({ flowFetch, orgId, asset: { id: asset.id, packageId: asset.packageId }, snapshot: undo.previous, message: "Commit undone by Novacura Buddy.", commit: !undo.saved });
    }
  }

  const api = { branchState, markNeeds, plan, commitOne, undoOne };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.FlowCommitChain = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
