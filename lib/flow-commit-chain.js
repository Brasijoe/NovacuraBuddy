/* ============================================================
   Flow Commit Chain — commits a flow and everything it uses, leaves
   first. A flow references its modules and sub-flows at one version
   each, so a changed dependency has to be committed before the flow
   above it, and that flow then has to point at the dependency's new
   version before it is committed itself.

   plan   reads the tree below a flow (sub-flows, package modules,
          App Library assets), orders it bottom to top and marks what
          needs a commit: own uncommitted changes, a dependency with a
          newer version, a dependency that is committed first.
   commitOne commits one asset: a module is committed again with its
          current code (the sequence Create module uses), a flow gets
          its dependency references moved to their head versions and is
          saved with its FULL data (never only the new events), then
          committed. Returns what Undo needs.

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

  /** The tree below `rootId`, bottom to top, each asset once. A reference cycle cannot be
   *  ordered: it is cut where it closes and listed in `cycles` ([[names…]]). */
  async function plan({ flowFetch, orgId, rootId, scanResult, log }) {
    const index = new Map(scanResult.assets.map((a) => [a.id, a]));
    const nodes = new Map();
    const order = [];
    const cycles = [];
    const headOf = new Map(); // asset id -> fresh head version id

    async function visit(id, path) {
      if (nodes.has(id)) return;
      const asset = index.get(id);
      if (!asset) {
        nodes.set(id, { id, name: "(not found)", type: "unknown", packageId: null, packageName: "", deps: [], missing: true, dirty: false, known: false });
        order.push(id);
        return;
      }
      const fresh = await FlowModules.getModuleAsset({ flowFetch, orgId, packageId: asset.packageId, assetId: id }).catch(() => asset);
      const state = branchState({ ...asset, ...fresh, mainBranch: fresh.mainBranch || asset.mainBranch });
      const head = (fresh.mainBranch || asset.mainBranch || {}).headVersionId || null;
      headOf.set(id, head);
      const node = {
        id, name: asset.name, type: asset.type, packageId: asset.packageId, packageName: asset.packageName,
        headVersionId: head, dirty: state.dirty, known: state.known,
        branchKeys: Object.keys(fresh.mainBranch || asset.mainBranch || {}), deps: [], steps: null
      };
      nodes.set(id, node);
      if (asset.type !== "module") {
        const designer = await FlowDesignerTab.getDesignerData({ flowFetch, orgId, itemId: id });
        node.steps = [...FlowLinks.materialize(designer.data).values()].filter((e) => e.kind !== "arrow").length;
        for (const ref of designer.assets || []) {
          const dep = index.get(ref.assetId);
          if (path.has(ref.assetId) || ref.assetId === id) {
            cycles.push([...path, id, ref.assetId].map((x) => (index.get(x) || { name: x }).name));
            continue;
          }
          node.deps.push({ id: ref.assetId, name: dep ? dep.name : "(not found)", type: dep ? dep.type : "unknown", version: ref.assetVersion || null });
        }
        const nextPath = new Set(path).add(id);
        for (const d of node.deps) await visit(d.id, nextPath);
        for (const d of node.deps) {
          const head = headOf.get(d.id);
          d.headVersionId = head || null;
          d.outdated = !!(d.version && head && d.version !== head && !(nodes.get(d.id) || {}).dirty);
        }
      }
      order.push(id);
      if (log) log("Commit chain: read", asset.name);
    }
    await visit(rootId, new Set());
    return { rootId, orgId, cycles, items: markNeeds(order, nodes) };
  }

  /** Commits one asset (a plan item). `bump` lists the dependencies whose reference moves to
   *  their current head version ({ assetId, packageId }): the ones committed before this run
   *  and in it, never one that still has unselected uncommitted changes. Returns { headVersionId,
   *  undo } where undo puts the previous content back as a new version. */
  async function commitOne({ flowFetch, orgId, asset, bump, log }) {
    const { id, name, type, packageId } = asset;
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
    const { previous, branch } = await FlowLinks.saveAndCommit({ flowFetch, orgId, asset: { id, packageId }, snapshot, message: "Committed with its dependencies by Novacura Buddy." });
    if (log) log("Commit chain: committed flow", name);
    return { headVersionId: branch && branch.headVersionId, undo: { kind: "flow", previous } };
  }

  /** Puts an asset back to the content it had before commitOne, as a new version. */
  async function undoOne({ flowFetch, orgId, asset, undo }) {
    if (undo.kind === "module") {
      await FlowModules.commitModuleCode({ flowFetch, orgId, packageId: asset.packageId, assetId: asset.id, flowScriptCode: undo.previousSource });
    } else {
      await FlowLinks.saveAndCommit({ flowFetch, orgId, asset: { id: asset.id, packageId: asset.packageId }, snapshot: undo.previous, message: "Commit undone by Novacura Buddy." });
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
