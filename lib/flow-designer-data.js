/* ============================================================
   Flow designer data helpers shared by Commit Dependencies, Flow
   Analysis, Flow Documentation and the connector labels:
   materialize (replay a flow's designer events into its steps and
   arrows), lineDiff, designerSnapshot / saveAndCommit (save a flow's
   FULL data and commit it) and scan (every asset of an organisation).
   ============================================================ */
(function (global) {
  const FlowModules = typeof require === "function" ? require("./flow-modules.js") : global.FlowModules;
  const FlowDesignerTab = typeof require === "function" ? require("./flow-designer-tab.js") : global.FlowDesignerTab;
  const FlowTransfer = typeof require === "function" ? require("./flow-transfer.js") : global.FlowTransfer;
  const LIBRARY_NAME = "App Library";

  /** The flow's entities (steps, arrows, ...) after replaying its designer `data` events: an
   *  "x-created" event adds entity `id`, "x-deleted"/"x-removed" drops it, any other event on a
   *  known id updates its fields. Events without an id (module-added, ...) carry no entity. The
   *  Map keeps creation order, which is the order the Designer created them in. */
  function materialize(data) {
    const items = new Map();
    for (const e of Array.isArray(data) ? data : []) {
      if (!e || typeof e !== "object") continue;
      const id = e.id || e.stepId || e.arrowId;
      const type = String(e.type || "");
      if (!id) continue;
      if (/-created$/.test(type)) items.set(id, { ...e, kind: type.replace(/-created$/, "") });
      else if (/-(deleted|removed)$/.test(type)) items.delete(id);
      else if (items.has(id)) {
        const { type: _t, ...rest } = e;
        items.set(id, { ...items.get(id), ...rest });
      }
    }
    return items;
  }

  /** Line diff of two texts: [{ op: "=" | "+" | "-", text }], or null when too long to show. */
  function lineDiff(a, b) {
    const x = String(a || "").split(/\r?\n/), y = String(b || "").split(/\r?\n/);
    if (x.length * y.length > 250000) return null;
    const L = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1));
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) {
      L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
    const out = [];
    let i = 0, j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) { out.push({ op: "=", text: x[i] }); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: "-", text: x[i++] });
      else out.push({ op: "+", text: y[j++] });
    }
    while (i < x.length) out.push({ op: "-", text: x[i++] });
    while (j < y.length) out.push({ op: "+", text: y[j++] });
    return out;
  }

  async function pool(items, size, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
    await Promise.all(Array.from({ length: Math.min(size, items.length) || 1 }, worker));
    return out;
  }

  /** Every asset of the organisation (App Library and every package) . */
  async function scan({ flowFetch, orgId }) {
    const packages = await FlowTransfer.listPackages({ flowFetch, orgId });
    const locations = [{ id: null, name: LIBRARY_NAME }, ...packages];
    // One retry: a package missing from the scan would turn its assets into unknown references.
    const list = (loc) => FlowModules.listAssets({ flowFetch, orgId, packageId: loc.id });
    const failedPackages = [];
    const lists = await pool(locations, 3, (loc) => list(loc).catch(() => list(loc)).catch((e) => { failedPackages.push(`${loc.name}: ${e.message}`); return []; }));
    const assets = [];
    locations.forEach((loc, i) => {
      for (const a of lists[i]) {
        assets.push({
          id: a.id, name: a.name, type: a.type, description: a.description || "", color: a.color || null,
          tagIds: a.tagIds || [], mainBranch: a.mainBranch || null,
          packageId: loc.id, packageName: loc.name
        });
      }
    });
    return { orgId, packages, assets, failedPackages, scannedAt: new Date().toISOString() };
  }

  function designerSnapshot(d) {
    return {
      assets: d.assets || [],
      data: Array.isArray(d.data) ? d.data : [],
      parameterTypeExpression: d.parameterTypeExpression || "{}",
      resultTypeExpression: d.resultTypeExpression || "{}",
      isInbox: !!d.isInbox,
      hasSuitcase: !!d.hasSuitcase,
      architecture: d.architecture || "sequential"
    };
  }

  /** Saves `snapshot` (a designerSnapshot) as the flow's full content and commits it. */
  async function saveAndCommit({ flowFetch, orgId, asset, snapshot, message, commit = true, branch: knownBranch }) {
    const current = await FlowDesignerTab.getDesignerData({ flowFetch, orgId, itemId: asset.id });
    // data: [] so the snapshot's full data REPLACES the flow's (saveDesignerAssets appends events).
    const saved = { ...snapshot, eTag: current.eTag, data: [] };
    await FlowDesignerTab.saveDesignerAssets({ flowFetch, orgId, itemId: asset.id, designerData: saved, assets: snapshot.assets, events: snapshot.data });
    if (!commit) return { previous: designerSnapshot(current), branch: null }; // saved only
    // An app, page or automation (the type the used-by lookup gives) is a product, not an asset: it
    // has no asset record, so its fresh branch comes from the package's product endpoint
    // (UNVERIFIED live), else the branch the lookup gave. Anything else is an asset.
    const isProduct = /^(application|page|automation)$/.test(asset.type || "");
    const fromProduct = async () => {
      if (asset.packageId) {
        const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/packages/${asset.packageId}/products/${asset.id}`);
        const product = res.ok ? await res.json().catch(() => null) : null;
        if (product && product.mainBranch) return product;
      }
      if (knownBranch && knownBranch.id) return { mainBranch: knownBranch };
      throw new Error(`Could not find the branch of ${asset.name || asset.id}.`);
    };
    const fresh = isProduct ? await fromProduct()
      : await FlowModules.getModuleAsset({ flowFetch, orgId, packageId: asset.packageId, assetId: asset.id }).catch((e) => (knownBranch && knownBranch.id ? { mainBranch: knownBranch } : Promise.reject(e)));
    const branch = await FlowDesignerTab.commitFlow({ flowFetch, orgId, itemId: asset.id, branch: fresh.mainBranch, designerData: { ...saved, assets: snapshot.assets }, message });
    return { previous: designerSnapshot(current), branch };
  }

  const api = { materialize, lineDiff, scan, designerSnapshot, saveAndCommit };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.FlowDesignerData = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
