(function (global) {
  // Permission check: which IFS projections the open flow calls (from the modules it uses and the
  // .svc URLs in its steps), and - once a user's granted projections are known - which are missing.
  // Pure functions; the background reads Flow and IFS.

  /** The flow and every asset it uses (as read by FlowTransfer.exportFlow) -> one row per
   *  projection: { projection, assets: [names that refer to it] }, sorted by name. */
  function projectionUsage(pkg, namesIn) {
    const byProjection = new Map();
    for (const asset of Object.values(pkg.assets || {})) {
      for (const name of namesIn(asset)) {
        if (!byProjection.has(name)) byProjection.set(name, new Set());
        byProjection.get(name).add(asset.name);
      }
    }
    return [...byProjection].map(([projection, assets]) => ({ projection, assets: [...assets].sort() }))
      .sort((a, b) => a.projection.localeCompare(b.projection));
  }

  /** Per connector the projections its steps call: walks the flows' step data for objects with a
   *  `connector` ({ id, name, type }) and reads the projection names in that step's own text.
   *  Modules carry no connector, so their projections are returned as `unassigned`: those not
   *  already seen in a connector step. -> { connectors: [{ id, name, type, projections, assets }], unassigned } */
  function usageByConnector(pkg, namesIn) {
    const found = new Map();
    const walk = (value, assetName) => {
      if (Array.isArray(value)) return value.forEach((v) => walk(v, assetName));
      if (!value || typeof value !== "object") return;
      const c = value.connector;
      if (c && typeof c === "object" && c.id) {
        if (!found.has(c.id)) found.set(c.id, { id: c.id, name: c.name || c.id, type: c.type || null, projections: new Set(), assets: new Set() });
        const row = found.get(c.id);
        row.assets.add(assetName);
        for (const n of namesIn({ designer: { data: [value] } })) row.projections.add(n);
      }
      for (const v of Object.values(value)) walk(v, assetName);
    };
    for (const asset of Object.values(pkg.assets || {})) if (asset.designer) walk(asset.designer.data || [], asset.name);
    const connectors = [...found.values()].map((r) => ({ ...r, projections: [...r.projections].sort(), assets: [...r.assets].sort() }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const assigned = new Set(connectors.flatMap((c) => c.projections));
    const unassigned = projectionUsage(pkg, namesIn).filter((r) => !assigned.has(r.projection));
    return { connectors, unassigned };
  }

  /** Required projections against the granted ones (case-insensitive): { missing, granted }. */
  function compare(required, grantedNames) {
    const have = new Set((grantedNames || []).map((n) => String(n).toLowerCase()));
    const missing = [], granted = [];
    for (const row of required) (have.has(row.projection.toLowerCase()) ? granted : missing).push(row);
    return { missing, granted };
  }

  const api = { projectionUsage, usageByConnector, compare };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.PermissionCheck = api;
})(typeof window !== "undefined" ? window : globalThis);
