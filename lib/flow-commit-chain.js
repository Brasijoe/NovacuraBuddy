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

  /** The message of an asset's last commit, if its branch says (field names are a guess: UNVERIFIED). */
  function lastCommitMessage(branch) {
    for (const k of ["commitMessage", "latestCommitMessage", "lastCommitMessage", "headCommitMessage", "message"]) {
      if (branch && typeof branch[k] === "string" && branch[k].trim()) return branch[k].trim();
    }
    return "";
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

  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

  /** Every known asset a flow uses: the assets[] list (with the version it points at), plus any
   *  known asset id found in its data, such as a component step's configuration.componentId or
   *  a sub-flow's assetId, so an entry missing from assets[] can't hide a user. */
  function referencedIds(designer, index, ownId) {
    const list = (designer.assets || []).filter((r) => r.assetId !== ownId);
    const known = new Set(list.map((r) => r.assetId));
    const byLower = new Map([...index.keys()].map((id) => [String(id).toLowerCase(), id]));
    for (const found of new Set(JSON.stringify(designer.data || []).match(UUID_RE) || [])) {
      const id = byLower.get(found.toLowerCase());
      if (id && id !== ownId && !known.has(id)) { known.add(id); list.push({ assetId: id, assetVersion: null }); }
    }
    return list;
  }

  /** The tree ABOVE `rootId`: the flows that use it, the flows that use those, and so on (a flow
   *  only ever uses assets of its own package or the App Library: for an asset of a package only
   *  that package's flows are read, for an App Library asset every flow). `items` is bottom to top (the root first, a user after everything it uses) and is
   *  the commit order; `tree` is the same assets for display, as { id, depth } with the users of an
   *  asset under it. Each asset is listed once. A reference cycle cannot be ordered: it is cut
   *  where it closes and listed in `cycles` ([[names…]]). */
  async function plan({ flowFetch, orgId, rootId, scanResult, log, onProgress, concurrency = 8 }) {
    const index = new Map(scanResult.assets.map((a) => [a.id, a]));
    const root = index.get(rootId);
    if (!root) throw new Error("The open asset was not found in this organisation.");
    // Flow's own used-by lookup (one GET) gives the apps, pages, automations and components that
    // use the asset, however deep. If it isn't available, every flow is read instead (slow).
    const readByScan = async () => {
      // Apps, pages and automations are products, listed per package and missing from the asset
      // listing. They are scanned too, and shown on the asset they run directly.
      const products = new Map(); // asset id -> [{ name, type }]
      const productRefs = new Map(); // product id -> the assets its committed version uses directly
      const wanted = (scanResult.packages || []).filter((pkg) => !root.packageId || pkg.id === root.packageId);
      await Promise.all(wanted.map(async (pkg) => {
        try {
          const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/packages/${pkg.id}/products`);
          if (!res.ok) return;
          for (const p of (await res.json()) || []) {
            const assetId = p.assetDto ? p.assetDto.assetId : ((((p.mainBranch || {}).versionInfo || {}).assets || []).find((u) => !u.usedIndirectly) || {}).assetId;
            if (assetId) (products.get(assetId) || products.set(assetId, []).get(assetId)).push({ name: p.name, type: p.type });
            // The product is a designer item of its own (the asset listing leaves it out) with
            // steps that can use the open asset, so it is scanned like a flow.
            productRefs.set(p.id, ((((p.mainBranch || {}).versionInfo || {}).assets) || []).filter((u) => u && u.assetId && !u.usedIndirectly).map((u) => ({ assetId: u.assetId, assetVersion: u.assetVersion || null })));
            if (p.id && !index.has(p.id)) index.set(p.id, { id: p.id, name: p.name, type: p.type, packageId: pkg.id, packageName: pkg.name, mainBranch: p.mainBranch || null });
          }
        } catch (e) { if (log) log("Commit chain: products of", pkg.name, "failed:", e.message); }
      }));
      const candidates = [...index.values()].filter((a) => a.type !== "module" && (!root.packageId || a.packageId === root.packageId));

      // What every candidate flow references, with the version it points at (GET only). The
      // assets[] list is what the Designer keeps, but any known asset id found in a flow's data
      // (a sub-flow step, a module event) counts as a use too, so a missing assets[] entry
      // can't hide a user. A flow that can't be read is retried once, then reported in `failed`.
      const refs = new Map(); // flow id -> [{ assetId, assetVersion }]
      const steps = new Map();
      const failed = [];
      let next = 0, done = 0;
      const worker = async () => {
        while (next < candidates.length) {
          const flow = candidates[next++];
          if (onProgress) onProgress(done, candidates.length, flow.name);
          const own = productRefs.get(flow.id); // a product also lists what its committed version uses
          try {
            const designer = await FlowDesignerTab.getDesignerData({ flowFetch, orgId, itemId: flow.id }).catch(() => FlowDesignerTab.getDesignerData({ flowFetch, orgId, itemId: flow.id }));
            const list = referencedIds(designer, index, flow.id);
            for (const r of own || []) if (r.assetId !== flow.id && !list.some((x) => x.assetId === r.assetId)) list.push(r);
            refs.set(flow.id, list);
            steps.set(flow.id, [...FlowLinks.materialize(designer.data).values()].filter((e) => e.kind !== "arrow").length);
          } catch (e) {
            if (own) refs.set(flow.id, own.filter((r) => r.assetId !== flow.id)); // the designer of a product may not open: its version info stands in
            else failed.push(flow.name);
            if (log) log("Commit chain: could not read", flow.name, e.message);
          }
          if (onProgress) onProgress(++done, candidates.length, flow.name);
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));

      return { candidates, refs, steps, failed, products };
    };
    const readByUsedBy = async () => {
      const usedByOf = async (assetId) => {
        const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/assets/${assetId}/used-by`);
        if (!res.ok) throw new Error(`used-by answered ${res.status}`);
        const list = await res.json();
        if (!Array.isArray(list)) throw new Error("used-by gave no list");
        return list;
      };
      const top = await usedByOf(rootId);
      const edges = new Map(); // user id -> [{ assetId, assetVersion }] of what it consists of
      const seen = new Set();
      const visit = (node) => {
        if (!node || !node.id) return;
        if (!index.has(node.id) && node.id !== rootId) {
          index.set(node.id, { id: node.id, name: node.name, type: node.type, packageId: (node.location || {}).packageId || null, packageName: (node.location || {}).packageName || "",
            mainBranch: node.mainBranchId ? { id: node.mainBranchId, headVersionId: node.headVersionId } : null });
        }
        // An asset on several paths gets the edges of every one of them.
        const list = edges.get(node.id) || edges.set(node.id, []).get(node.id);
        let added = !seen.has(node.id);
        seen.add(node.id);
        for (const c of node.consistsOf || []) {
          if (c && c.id && !list.some((e) => e.assetId === c.id)) { list.push({ assetId: c.id, assetVersion: null }); added = true; }
        }
        if (added) for (const child of node.consistsOf || []) visit(child);
      };
      visit({ id: rootId, consistsOf: [] });
      // Each entry is the full path: an app or automation, the components inside it, down to the
      // asset. Not trusting the depth Flow goes to, every component found is asked for its own
      // users in turn, until no new asset turns up (the end of every chain).
      for (const node of top) visit(node);
      const asked = new Set([rootId]);
      const PRODUCTS = /^(application|page|automation)$/;
      for (let round = 0; round < 50; round++) {
        const todo = [...edges.keys()].filter((id) => !asked.has(id) && !PRODUCTS.test((index.get(id) || {}).type || "")).slice(0, 400);
        if (!todo.length) break;
        todo.forEach((id) => asked.add(id));
        let at = 0;
        const askWorker = async () => {
          while (at < todo.length) {
            const id = todo[at++];
            if (onProgress) onProgress(at, todo.length, `users of ${(index.get(id) || {}).name || id}`);
            try { for (const node of await usedByOf(id)) visit(node); } catch (e) { if (log) log("Commit chain: used-by of", id, "failed:", e.message); }
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, askWorker));
      }
      // Where a use is written down, the Designer says which version it points at.
      const users = [...edges.keys()].filter((id) => id !== rootId);
      // An app, page or automation lists the versions it was committed with; its Designer may not open.
      const PRODUCT = /^(application|page|automation)$/;
      const productVersions = new Map(); // product id -> Map(asset id -> version)
      const productPackages = new Set(users.filter((id) => PRODUCT.test(index.get(id).type) && index.get(id).packageId).map((id) => index.get(id).packageId));
      await Promise.all([...productPackages].map(async (pkg) => {
        try {
          const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/packages/${pkg}/products`);
          if (!res.ok) return;
          for (const p of (await res.json()) || []) {
            productVersions.set(p.id, new Map((((p.mainBranch || {}).versionInfo || {}).assets || []).filter((u) => u && u.assetId).map((u) => [u.assetId, u.assetVersion || null])));
          }
        } catch (e) { if (log) log("Commit chain: products of", pkg, "failed:", e.message); }
      }));
      const steps = new Map(), refs = new Map(), failed = [];
      let next = 0, done = 0;
      const worker = async () => {
        while (next < users.length) {
          const id = users[next++];
          const name = index.get(id).name;
          if (onProgress) onProgress(done, users.length, name);
          let list = edges.get(id).slice();
          try {
            const designer = await FlowDesignerTab.getDesignerData({ flowFetch, orgId, itemId: id });
            const own = referencedIds(designer, index, id);
            list = [...own, ...list.filter((e) => !own.some((o) => o.assetId === e.assetId))];
            steps.set(id, [...FlowLinks.materialize(designer.data).values()].filter((e) => e.kind !== "arrow").length);
          } catch (e) { if (log) log("Commit chain: designer of", name, "not read:", e.message); }
          const listed = productVersions.get(id);
          refs.set(id, list.filter((r) => r.assetId !== id).map((r) => (!r.assetVersion && listed && listed.get(r.assetId) ? { ...r, assetVersion: listed.get(r.assetId) } : r)));
          if (onProgress) onProgress(++done, users.length, name);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, users.length) }, worker));
      return { candidates: users.map((id) => index.get(id)), refs, steps, failed, products: new Map(), usedBy: true };
    };
    let found;
    try { found = await readByUsedBy(); } catch (e) { if (log) log("Commit chain: used-by lookup failed, scanning every flow:", e.message); found = await readByScan(); }
    const { candidates, refs, steps, failed, products } = found;

    // Who uses whom, and the tree above the root (depth first, users under the asset they use).
    const users = new Map(); // asset id -> [flow id]
    for (const [flowId, list] of refs) for (const r of new Set(list.map((x) => x.assetId))) (users.get(r) || users.set(r, []).get(r)).push(flowId);
    const byName = (x, y) => (index.get(x).name || "").localeCompare(index.get(y).name || "");
    // Everything above the root, then each asset's level = the longest path down to the root, and
    // its place in the tree = under the deepest asset it uses (so A uses B uses root puts A under
    // B, even when A also uses root directly).
    const reach = new Set([rootId]);
    for (const queue = [rootId]; queue.length;) for (const u of users.get(queue.shift()) || []) if (!reach.has(u)) { reach.add(u); queue.push(u); }
    const usesInTree = (id) => [...new Set((refs.get(id) || []).map((r) => r.assetId))].filter((d) => d !== id && reach.has(d));
    const cycles = [], level = new Map(), busy = new Set();
    const levelOf = (id, path) => {
      if (id === rootId) return 0;
      if (level.has(id)) return level.get(id);
      busy.add(id);
      let best = 0;
      for (const d of usesInTree(id)) {
        if (busy.has(d)) { cycles.push([...path, id, d].map((x) => index.get(x).name)); continue; }
        best = Math.max(best, levelOf(d, [...path, id]) + 1);
      }
      busy.delete(id);
      level.set(id, best || 1);
      return level.get(id);
    };
    for (const d of usesInTree(rootId)) cycles.push([rootId, d, rootId].map((x) => index.get(x).name)); // the open asset uses something that uses it
    for (const id of reach) levelOf(id, []);
    const kids = new Map([...reach].map((id) => [id, []]));
    for (const id of reach) {
      if (id === rootId) continue;
      const deps = usesInTree(id).filter((d) => (level.get(d) || 0) === level.get(id) - 1 || d === rootId && level.get(id) === 1).sort(byName);
      const parent = deps[0] || rootId;
      kids.get(parent).push(id);
    }
    const tree = [];
    (function walk(id, depth) {
      tree.push({ id, depth });
      for (const k of kids.get(id).sort(byName)) walk(k, depth + 1);
    })(rootId, 0);

    const nodes = new Map();
    for (const { id } of tree) {
      const asset = index.get(id);
      const fresh = await FlowModules.getModuleAsset({ flowFetch, orgId, packageId: asset.packageId, assetId: id }).catch(() => asset);
      const mainBranch = fresh.mainBranch || asset.mainBranch;
      const state = branchState({ ...asset, ...fresh, mainBranch });
      nodes.set(id, {
        id, name: asset.name, type: asset.type, packageId: asset.packageId, packageName: asset.packageName,
        headVersionId: (mainBranch || {}).headVersionId || null, dirty: id === rootId ? false : state.dirty, known: state.known, // the open asset is the source: it is not committed here, what uses it points at its head version
        branchId: (mainBranch || {}).id || null, branchKeys: Object.keys(mainBranch || {}), lastCommitMessage: lastCommitMessage(mainBranch), deps: [], steps: steps.has(id) ? steps.get(id) : null, products: products.get(id) || []
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
    const counts = new Map(candidates.map((f) => [f.packageName || "App Library", 0]));
    for (const f of candidates) counts.set(f.packageName || "App Library", counts.get(f.packageName || "App Library") + 1);
    const info = [`open asset: ${root.name} (${rootId}) type ${root.type}, package ${root.packageName || "App Library"} [${root.packageId || "none"}]`,
      `packages in the organisation: ${(scanResult.packages || []).length}; asset listing failed for: ${(scanResult.failedPackages || []).join(" | ") || "none"}`,
      `flows per package: ${[...counts].map(([n, c]) => `${n.trim()} ${c}`).join(", ")}`,
      `flows read: ${candidates.length - failed.length} of ${candidates.length}${found.usedBy ? " (used-by lookup)" : ""}; products found for ${products.size} flow assets`,
      ...candidates.map((f) => `${failed.includes(f.name) ? "FAILED" : "ok"} | ${f.name} | ${f.type} | ${f.packageName || "App Library"} | uses ${(refs.get(f.id) || []).length}${(refs.get(f.id) || []).some((r) => r.assetId === rootId) ? " | USES THE OPEN ASSET" : ""}`)].join("\n");
    return { rootId, orgId, cycles, items, tree, scanned: candidates.length - failed.length, failed, failedPackages: scanResult.failedPackages || [], info };
  }

  /** Commits one asset (a plan item). `bump` lists the dependencies whose reference moves to
   *  their current head version ({ assetId, packageId }): the ones committed before this run
   *  and in it, never one that still has unselected uncommitted changes. Returns { headVersionId,
   *  undo } where undo puts the previous content back as a new version. */
  async function commitOne({ flowFetch, orgId, asset, bump, log, commit = true, message }) {
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
      const given = bump.find((b) => b.assetId === ref.assetId).headVersionId; // known from the plan: no extra read
      const head = given || (await FlowModules.getModuleAsset({ flowFetch, orgId, packageId: bumpIds.get(ref.assetId), assetId: ref.assetId })).mainBranch.headVersionId;
      if (ref.assetVersion && ref.assetVersion !== head) idMap[ref.assetVersion] = head;
      assets.push({ ...ref, assetVersion: head });
    }
    const data = Object.keys(idMap).length ? FlowTransfer.remap(current.data, idMap, null) : current.data;
    const snapshot = { ...FlowLinks.designerSnapshot(current), assets, data: Array.isArray(data) ? data : [] };
    const { previous, branch } = await FlowLinks.saveAndCommit({ flowFetch, orgId, asset: { id, packageId }, snapshot, message: message || "Committed with its dependencies by Novacura Buddy.", commit, branch: asset.mainBranch });
    if (log) log(`Commit chain: ${commit ? "committed" : "saved"} flow`, name);
    return { headVersionId: branch && branch.headVersionId, undo: { kind: "flow", previous, saved: !commit } };
  }

  /** Puts an asset back to the content it had before commitOne, as a new version. */
  async function undoOne({ flowFetch, orgId, asset, undo }) {
    if (undo.kind === "module") {
      await FlowModules.commitModuleCode({ flowFetch, orgId, packageId: asset.packageId, assetId: asset.id, flowScriptCode: undo.previousSource });
    } else {
      await FlowLinks.saveAndCommit({ flowFetch, orgId, asset: { id: asset.id, name: asset.name, type: asset.type, packageId: asset.packageId }, snapshot: undo.previous, branch: asset.mainBranch, message: "Commit undone by Novacura Buddy.", commit: !undo.saved });
    }
  }

  const api = { lastCommitMessage, referencedIds, branchState, markNeeds, plan, commitOne, undoOne };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.FlowCommitChain = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
