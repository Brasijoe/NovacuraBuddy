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

  const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /** Per connector the projections it is used for. A step with a `connector` ({ id, name, type })
   *  calls projections directly (.svc URLs in the step) and through the modules its Flowscript
   *  opens or calls by name, which use that connector. Projections no connector step leads to
   *  (direct REST calls without a connector, modules no connector step opens) go to `noConnector`.
   *  -> { connectors: [{ id, name, type, projections: [{ projection, via: [..] }], assets }],
   *       noConnector: [{ projection, via }] } */
  function usageByConnector(pkg, namesIn) {
    const assets = Object.values(pkg.assets || {});
    const modules = assets.filter((a) => !a.designer && a.source).map((a) => ({ name: a.name, projections: namesIn(a), re: new RegExp(`(^|[^A-Za-z0-9_])${esc(a.name)}([^A-Za-z0-9_]|$)`) }))
      .filter((m) => m.projections.length);
    const found = new Map();
    const attributed = new Set(); // projection|via pairs that a connector step explains
    const add = (map, projection, via) => {
      if (!map.has(projection)) map.set(projection, new Set());
      map.get(projection).add(via);
    };
    const walk = (value, assetName) => {
      if (Array.isArray(value)) return value.forEach((v) => walk(v, assetName));
      if (!value || typeof value !== "object") return;
      const c = value.connector;
      if (c && typeof c === "object" && c.id) {
        if (!found.has(c.id)) found.set(c.id, { id: c.id, name: c.name || c.id, type: c.type || null, projections: new Map(), assets: new Set() });
        const row = found.get(c.id);
        row.assets.add(assetName);
        const text = JSON.stringify(value);
        for (const n of namesIn({ designer: { data: [value] } })) { add(row.projections, n, `step in ${assetName}`); attributed.add(n); }
        for (const m of modules) if (m.re.test(text)) for (const n of m.projections) { add(row.projections, n, `module ${m.name}`); attributed.add(n); }
      }
      for (const v of Object.values(value)) walk(v, assetName);
    };
    for (const asset of assets) if (asset.designer) walk(asset.designer.data || [], asset.name);
    const listOf = (map) => [...map].map(([projection, via]) => ({ projection, via: [...via].sort() })).sort((a, b) => a.projection.localeCompare(b.projection));
    const connectors = [...found.values()].map((r) => ({ ...r, projections: listOf(r.projections), assets: [...r.assets].sort() }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const rest = new Map();
    for (const asset of assets) for (const n of namesIn(asset)) if (!attributed.has(n)) add(rest, n, `${asset.designer ? "step in" : "module"} ${asset.name}`);
    return { connectors, noConnector: listOf(rest) };
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
