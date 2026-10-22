/* ============================================================
   Flow Tree — the dependency tree of a flow export package, for
   the Import/Export tab: each exported flow with the modules,
   sub-flows and connectors it uses, nested. An asset used in
   several places is expanded at its first place only; later
   places are marked `repeat`.
   ============================================================ */
(function (global) {
  const rootIdsOf = (pkg) => (Array.isArray(pkg.rootIds) && pkg.rootIds.length ? pkg.rootIds : [pkg.rootId]);

  /** Distinct connectors on `connector` keys anywhere in `value`. */
  function connectorsIn(value, found) {
    const out = found || new Map();
    if (Array.isArray(value)) {
      for (const v of value) connectorsIn(v, out);
    } else if (value && typeof value === "object") {
      for (const [key, v] of Object.entries(value)) {
        if (key === "connector" && v && typeof v === "object" && v.id) {
          if (!out.has(v.id)) out.set(v.id, v.name || v.id);
        } else {
          connectorsIn(v, out);
        }
      }
    }
    return out;
  }

  /** [{ id, name, type, repeat, children }] — flows first, then any exported asset not already
   *  shown inside a flow (e.g. a package's unused modules). Connector leaves carry type
   *  "connector". */
  function dependencyTree(pkg) {
    const seen = new Set();
    function node(id, path) {
      const asset = pkg.assets[id];
      if (!asset) return null;
      const base = { id, name: asset.name, type: asset.type, repeat: false, children: [] };
      if (seen.has(id) || path.has(id)) return { ...base, repeat: true };
      seen.add(id);
      if (asset.designer) {
        const nextPath = new Set(path).add(id);
        // Sorted before expanding, so a shared asset is expanded where it is shown first.
        const refs = (asset.designer.assets || []).map((ref) => pkg.assets[ref.assetId] && { id: ref.assetId, ...pkg.assets[ref.assetId] }).filter(Boolean);
        refs.sort((a, b) => order(a) - order(b) || String(a.name).localeCompare(String(b.name)));
        const kids = refs.map((ref) => node(ref.id, nextPath));
        const connectors = [...connectorsIn(asset.designer.data).entries()].map(([cid, name]) => ({ id: `connector:${cid}`, name, type: "connector", repeat: false, children: [] }));
        base.children = [...kids, ...connectors];
      }
      return base;
    }
    const roots = rootIdsOf(pkg).filter((id) => pkg.assets[id]);
    const flowsFirst = [...roots.filter((id) => pkg.assets[id].designer), ...roots.filter((id) => !pkg.assets[id].designer)];
    const tree = [];
    for (const id of flowsFirst) {
      if (seen.has(id)) continue; // already shown inside an earlier flow
      tree.push(node(id, new Set()));
    }
    return tree;
  }

  /** Sub-flows before modules before anything else, inside one flow. */
  function order(n) {
    return n.type === "module" ? 1 : n.type === "connector" ? 2 : 0;
  }

  /** Counts per kind for a one-line summary. */
  function summarize(pkg) {
    const all = Object.values(pkg.assets || {});
    const modules = all.filter((a) => a.type === "module").length;
    const flows = all.filter((a) => a.designer).length;
    return { flows, modules, other: all.length - modules - flows };
  }

  /** A file-system-safe export name from the selected items' names: as many whole names as fit in
   *  `max` characters (default 60), then "+N other(s)" (e.g. "JOSTDE IVSTDE +5 others"). */
  function exportName(names, max) {
    const limit = max || 60;
    const clean = (names || []).map((n) => String(n).replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim()).filter(Boolean);
    if (!clean.length) return "Flow export";
    const tail = (rest) => (rest ? ` +${rest} other${rest === 1 ? "" : "s"}` : "");
    let taken = 0;
    let name = "";
    for (let i = 0; i < clean.length; i++) {
      const next = name ? `${name} ${clean[i]}` : clean[i];
      if (next.length > limit && taken > 0) break;
      name = next;
      taken++;
    }
    if (name.length > limit) name = name.slice(0, limit - 1).trimEnd() + "…"; // a single over-long name
    return name + tail(clean.length - taken);
  }

  const api = { dependencyTree, summarize, rootIdsOf, exportName };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.FlowTree = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
