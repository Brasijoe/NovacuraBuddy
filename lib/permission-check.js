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

  /** Required projections against the granted ones (case-insensitive): { missing, granted }. */
  function compare(required, grantedNames) {
    const have = new Set((grantedNames || []).map((n) => String(n).toLowerCase()));
    const missing = [], granted = [];
    for (const row of required) (have.has(row.projection.toLowerCase()) ? granted : missing).push(row);
    return { missing, granted };
  }

  const api = { projectionUsage, compare };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.PermissionCheck = api;
})(typeof window !== "undefined" ? window : globalThis);
