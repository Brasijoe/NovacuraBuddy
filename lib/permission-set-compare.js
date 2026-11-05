(function (global) {
  // Compares permission sets between two IFS instances, A and B, and plans the changes that make
  // them match. Pure functions; the reads and writes live in ifs-permissions.js.
  // A side's data per role: { exists, description, projections: [{ projection, level }], actions: [{ projection, action }] }

  const MODES = ["merge", "copy", "sync"];
  const other = (side) => (side === "A" ? "B" : "A");
  const empty = { exists: false, description: "", projections: [], actions: [] };
  const actionKey = (a) => `${a.projection}|${a.action}`;

  /** Difference of one permission set between the two sides. */
  function compareSet(a = empty, b = empty) {
    const byProjection = (d) => new Map(d.projections.map((p) => [p.projection, p]));
    const pa = byProjection(a), pb = byProjection(b);
    const projections = { both: [], onlyA: [], onlyB: [], level: [] };
    for (const [name, p] of pa) {
      if (!pb.has(name)) projections.onlyA.push(name);
      else {
        projections.both.push(name);
        if (p.level && pb.get(name).level && p.level !== pb.get(name).level) projections.level.push({ projection: name, A: p.level, B: pb.get(name).level });
      }
    }
    for (const name of pb.keys()) if (!pa.has(name)) projections.onlyB.push(name);
    const ka = new Map(a.actions.map((x) => [actionKey(x), x])), kb = new Map(b.actions.map((x) => [actionKey(x), x]));
    const actions = { both: [], onlyA: [], onlyB: [] };
    for (const [k, x] of ka) (kb.has(k) ? actions.both : actions.onlyA).push(x);
    for (const [k, x] of kb) if (!ka.has(k)) actions.onlyB.push(x);
    for (const list of [projections.both, projections.onlyA, projections.onlyB]) list.sort();
    const status = !a.exists ? "onlyB" : !b.exists ? "onlyA"
      : projections.onlyA.length || projections.onlyB.length || projections.level.length || actions.onlyA.length || actions.onlyB.length ? "differs" : "same";
    return { role: null, existsA: a.exists, existsB: b.exists, projections, actions, status };
  }

  /** compareSet for every role: data = { A: { role: side data }, B: { role: side data } } */
  function compareAll(roles, data) {
    return roles.map((role) => ({ ...compareSet(data.A[role], data.B[role]), role }));
  }

  /** The changes a mode would make: [{ target: "A"|"B", type: "create"|"grant"|"revoke", role, projection?, description?, access? }]
   *  merge: each side gets what only the other has. copy: the target gets what the reference has.
   *  sync: like copy, and the target loses what the reference does not have.
   *  Sets the target lacks are created first (only when createMissing). Action grants are compared but never changed. */
  function buildPlan(roles, data, { mode, reference = "A", createMissing = true, removeExtra = false } = {}) {
    if (!MODES.includes(mode)) throw new Error(`Unknown mode ${mode}`);
    const changes = [];
    const fill = (role, from, to) => {
      const src = data[from][role] || empty, dst = data[to][role] || empty;
      if (!src.exists) return;
      if (!dst.exists) {
        if (!createMissing) return;
        changes.push({ target: to, type: "create", role, description: src.description || "" });
      }
      const have = new Set(dst.projections.map((p) => p.projection));
      for (const p of src.projections) if (!have.has(p.projection)) changes.push({ target: to, type: "grant", role, projection: p.projection, access: p.level });
    };
    for (const role of roles) {
      if (mode === "merge") { fill(role, "A", "B"); fill(role, "B", "A"); continue; }
      const to = other(reference);
      fill(role, reference, to);
      if (mode === "sync" && removeExtra) {
        const src = data[reference][role] || empty, dst = data[to][role] || empty;
        if (!src.exists || !dst.exists) continue;
        const want = new Set(src.projections.map((p) => p.projection));
        for (const p of dst.projections) if (!want.has(p.projection)) changes.push({ target: to, type: "revoke", role, projection: p.projection });
      }
    }
    return changes;
  }

  const api = { MODES, compareSet, compareAll, buildPlan };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.PermissionSetCompare = api;
})(typeof window !== "undefined" ? window : globalThis);
