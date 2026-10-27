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

  const WRITE_CALL = /\b(Post|Patch|Put|Delete)Response(Binary)?\b/;
  const WRITE_METHOD = /"method"\s*:\s*"(POST|PATCH|PUT|DELETE)"/i;

  /** "write" when a module function the text uses (or anything it calls) sends POST/PATCH/PUT/DELETE,
   *  else "read". `mc` is ModuleCompare. A text that names no function of the module counts every
   *  declaration (the module is opened but called in ways the name match cannot see). */
  function moduleAccess(mc, moduleAsset, text) {
    const decls = mc.parseDeclarations(moduleAsset.source);
    const used = text === null ? [] : mc.usedDeclarations(moduleAsset.name, decls, text).map((u) => u.key);
    const keys = used.length ? mc.closureOf(used, mc.buildGraph([decls])) : new Set(decls.map((d) => d.key));
    return decls.some((d) => keys.has(d.key) && WRITE_CALL.test(d.text)) ? "write" : "read";
  }

  const maxAccess = (a, b) => (a === "write" || b === "write" ? "write" : "read");

  /** All string values of a step, one per line (JSON escaping would glue "\n" to the next word). */
  function stringsOf(value, out = []) {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) value.forEach((v) => stringsOf(v, out));
    else if (value && typeof value === "object") Object.values(value).forEach((v) => stringsOf(v, out));
    return out.join("\n");
  }

  const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /** Per connector the projections it is used for. A step with a `connector` ({ id, name, type })
   *  calls projections directly (.svc URLs in the step) and through the modules its Flowscript
   *  opens or calls by name, which use that connector. Projections no connector step leads to
   *  (direct REST calls without a connector, modules no connector step opens) go to `noConnector`.
   *  -> { connectors: [{ id, name, type, projections: [{ projection, via: [..] }], assets }],
   *       noConnector: [{ projection, via }] } */
  function usageByConnector(pkg, namesIn, mc) {
    const assets = Object.values(pkg.assets || {});
    const modules = assets.filter((a) => !a.designer && a.source).map((a) => ({ asset: a, name: a.name, projections: namesIn(a), re: new RegExp(`(^|[^A-Za-z0-9_])${esc(a.name)}([^A-Za-z0-9_]|$)`) }))
      .filter((m) => m.projections.length);
    const found = new Map();
    const attributed = new Set(); // projection|via pairs that a connector step explains
    const add = (map, projection, via, access = "read") => {
      if (!map.has(projection)) map.set(projection, { via: new Set(), access: "read" });
      const r = map.get(projection);
      r.via.add(via);
      r.access = maxAccess(r.access, access);
    };
    const walk = (value, assetName) => {
      if (Array.isArray(value)) return value.forEach((v) => walk(v, assetName));
      if (!value || typeof value !== "object") return;
      const c = value.connector;
      if (c && typeof c === "object" && c.id) {
        if (!found.has(c.id)) found.set(c.id, { id: c.id, name: c.name || c.id, type: c.type || null, projections: new Map(), assets: new Set() });
        const row = found.get(c.id);
        row.assets.add(assetName);
        const text = stringsOf(value);
        const direct = WRITE_METHOD.test(JSON.stringify(value)) ? "write" : "read";
        for (const n of namesIn({ designer: { data: [value] } })) { add(row.projections, n, `step in ${assetName}`, direct); attributed.add(n); }
        for (const m of modules) if (m.re.test(text)) {
          const access = mc ? moduleAccess(mc, m.asset, text) : "read";
          for (const n of m.projections) { add(row.projections, n, `module ${m.name}`, access); attributed.add(n); }
        }
      }
      for (const v of Object.values(value)) walk(v, assetName);
    };
    for (const asset of assets) if (asset.designer) walk(asset.designer.data || [], asset.name);
    const listOf = (map) => [...map].map(([projection, r]) => ({ projection, via: [...r.via].sort(), access: r.access })).sort((a, b) => a.projection.localeCompare(b.projection));
    const connectors = [...found.values()].map((r) => ({ ...r, projections: listOf(r.projections), assets: [...r.assets].sort() }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const rest = new Map();
    for (const asset of assets) for (const n of namesIn(asset)) if (!attributed.has(n)) add(rest, n, `${asset.designer ? "step in" : "module"} ${asset.name}`, asset.designer ? "read" : mc ? moduleAccess(mc, asset, null) : "read");
    return { connectors, noConnector: listOf(rest) };
  }

  /** Required projections against the granted ones (case-insensitive): { missing, granted }. */
  function compare(required, grantedNames) {
    const have = new Set((grantedNames || []).map((n) => String(n).toLowerCase()));
    const missing = [], granted = [];
    for (const row of required) (have.has(row.projection.toLowerCase()) ? granted : missing).push(row);
    return { missing, granted };
  }

  /** Required projections that are granted, but read-only while the flow writes. `grants`:
   *  [{ projection, level }] with the IFS access level (Full / ReadOnly / Custom / None). */
  function tooLow(required, grants) {
    const level = new Map();
    for (const g of grants || []) {
      const key = g.projection.toLowerCase();
      const best = level.get(key);
      if (!best || g.level === "Full") level.set(key, g.level); // any Full grant wins
    }
    return required.filter((r) => r.access === "write" && ["ReadOnly", "None"].includes(level.get(r.projection.toLowerCase())));
  }

  const api = { projectionUsage, usageByConnector, compare, tooLow, moduleAccess };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.PermissionCheck = api;
})(typeof window !== "undefined" ? window : globalThis);
