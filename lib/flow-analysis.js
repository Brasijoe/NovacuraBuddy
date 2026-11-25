/* ============================================================
   Flow Analysis — what changed in a flow, and everything it uses,
   since the version deployed on an environment. READ-ONLY: only GETs
   (and the read-only asset "status" POST that lists where a product is
   deployed, already used by Commit Dependencies).

   A flow's designer data lists ALL assets it uses, at any depth, with
   the version each one is at (assets[] with usedIndirectly; the deploy
   call sends exactly this list). So the deployed side is: the product
   version deployed on the environment -> its assets[]; the current side
   is the open flow's head designer assets[]. Assets whose version
   differs are read at both versions and diffed.

   UNVERIFIED live (no Flow access when written): which endpoint names
   the version deployed on an environment, and the by-version designer
   read. Each is tried over several likely candidates and the attempts are
   returned in `tried`, so a failure can be reported and fixed.
   ============================================================ */
(function (global) {
  const FlowDesignerData = typeof require === "function" ? require("./flow-designer-data.js") : global.FlowDesignerData;
  const FlowDesignerTab = typeof require === "function" ? require("./flow-designer-tab.js") : global.FlowDesignerTab;

  const APP = "/admin/application/api/v2/organisations";
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // Layout and bookkeeping that is not a change of the flow.
  const IGNORED = new Set(["location", "joints", "attribution", "eTag", "type", "kind", "id", "stepId", "arrowId", "x", "y", "width", "height"]);

  const initialsOf = (name) => String(name || "").split(/[\s._@-]+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("");

  /** { number, date, by } from whatever a version record carries (field names are guesses). */
  function describeVersion(v) {
    if (!v || typeof v !== "object") return { number: null, date: null, by: "" };
    const pick = (...keys) => { for (const k of keys) if (v[k] !== undefined && v[k] !== null && v[k] !== "") return v[k]; return null; };
    const by = pick("createdBy", "author", "committedBy", "userName", "user", "createdByName");
    return {
      number: pick("versionNumber", "number", "version", "revision", "sequence", "order"),
      date: pick("committedAt", "createdAt", "created", "date", "timestamp", "commitDate", "createdDate"),
      by: typeof by === "object" && by ? String(by.name || by.displayName || by.userName || by.email || "") : String(by || "")
    };
  }

  /** The version id the environment runs, from the body of a deployment lookup: the value of a
   *  version-like key, in the object that names the product (and environment) when there is one. */
  function findDeployedVersion(body, productId, envId) {
    const hits = [];
    const lower = (x) => String(x || "").toLowerCase();
    // Score: the product and the environment named by this object or an ancestor (scalar values only).
    const walk = (o, depth, up) => {
      if (!o || typeof o !== "object" || depth > 12) return;
      if (Array.isArray(o)) { o.forEach((x) => walk(x, depth + 1, up)); return; }
      const scalars = Object.values(o).filter((v) => typeof v === "string").map(lower);
      const here = { p: up.p || scalars.includes(lower(productId)), e: up.e || scalars.includes(lower(envId)), d: up.d };
      const score = (here.p ? 2 : 0) + (here.e ? 1 : 0) + (here.d ? 1 : 0);
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === "string" && UUID.test(v) && /^(deployed|release|product)?version(id)?$/i.test(k)) hits.push({ id: v, score: score + (/^deployed/i.test(k) ? 1 : 0), key: k });
        else if (v && typeof v === "object") walk(v, depth + 1, { ...here, d: here.d || /deployed|current|release/i.test(k) });
      }
    };
    walk(body, 0, {});
    hits.sort((a, b) => b.score - a.score);
    return hits.length ? hits[0] : null;
  }

  async function tryJson(flowFetch, path, tried, options) {
    try {
      const res = await flowFetch(path, options);
      tried.push(`${options && options.method ? options.method : "GET"} ${path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, (m) => m.slice(0, 8))} -> ${res.status}`);
      if (!res.ok) return null;
      return await res.json().catch(() => null);
    } catch (e) { tried.push(`${path} -> ${e.message}`); return null; }
  }

  /** The version of product `productId` deployed on environment `env`, with the assets that
   *  version uses: { versionId, assets, tried } (versionId null when none could be found). */
  async function readDeployed({ flowFetch, orgId, packageId, productId, env, versionOverride }) {
    const tried = [];
    let found = versionOverride ? { id: versionOverride, key: "given" } : null;
    const lite = { id: env.id, name: env.name, type: env.type, kind: env.kind, accessType: env.accessType, order: env.order };
    const candidates = [
      [`${APP}/${orgId}/packages/${packageId}/assets/${productId}/status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ environments: [lite] }) }],
      [`${APP}/${orgId}/packages/${packageId}/products/${productId}/environments/${env.id}`],
      [`${APP}/${orgId}/packages/${packageId}/products/${productId}/deploymentoverview`],
      [`${APP}/${orgId}/packages/${packageId}/deploymentoverview`],
      [`${APP}/${orgId}/packages/${packageId}/products/${productId}`]
    ];
    for (const [path, options] of candidates) {
      if (found) break;
      const body = await tryJson(flowFetch, path, tried, options);
      // The plain product record only names its head version: that is not what is deployed.
      if (body && !/\/products\/[^/]+$/.test(path)) found = findDeployedVersion(body, productId, env.id);
    }
    if (!found) return { versionId: null, assets: [], tried };
    const designer = await readVersionDesigner({ flowFetch, orgId, itemId: productId, versionId: found.id, tried });
    return { versionId: found.id, assets: designer ? designer.assets || [] : [], designer, tried };
  }

  /** The designer data of an item at one version. `headVersionId` (when known and equal) uses the
   *  ordinary head read. Otherwise the by-version variants are tried (the Designer's own reads of
   *  designerXml/{version}, data/{version} suggest designer/{version}). */
  async function readVersionDesigner({ flowFetch, orgId, itemId, versionId, headVersionId, tried = [] }) {
    if (versionId && versionId === headVersionId) return FlowDesignerTab.getDesignerData({ flowFetch, orgId, itemId });
    const base = `${APP}/${orgId}/items/${itemId}`;
    for (const path of [`${base}/designer/${versionId}`, `${base}/versions/${versionId}/designer`, `${base}/designer?versionId=${versionId}`, `${base}/versions/${versionId}`]) {
      const body = await tryJson(flowFetch, path, tried);
      if (body && (Array.isArray(body.data) || Array.isArray(body.assets))) return body;
    }
    return null;
  }

  /** A module's code at one version (designerXml/{version}, the read Module Compare uses). */
  async function readModuleCode({ flowFetch, orgId, itemId, versionId }) {
    const res = await flowFetch(`${APP}/${orgId}/items/${itemId}/designerXml/${versionId}`);
    if (!res.ok) throw new Error(`Could not read the module (${res.status})`);
    const text = await res.text();
    try { const j = JSON.parse(text); if (typeof j === "string") return j; if (j && typeof j.data === "string") return j.data; } catch { /* plain text */ }
    return text;
  }

  /** Optional: the version records of an item, for numbers, dates and initials. */
  async function readVersionInfos({ flowFetch, orgId, itemId, versionIds }) {
    const tried = [];
    const body = await tryJson(flowFetch, `${APP}/${orgId}/items/${itemId}/versions`, tried);
    const list = Array.isArray(body) ? body : (body && (body.items || body.versions)) || [];
    const out = {};
    for (const v of list) if (v && v.id && (!versionIds || versionIds.includes(v.id))) out[v.id] = describeVersion(v);
    return out;
  }

  /* --- diffing --- */

  function flatten(value, path, out) {
    if (Array.isArray(value)) {
      if (!value.length) out.set(path, "[]");
      value.forEach((v, i) => flatten(v, `${path}[${i}]`, out));
    } else if (value && typeof value === "object") {
      const keys = Object.keys(value);
      if (!keys.length) out.set(path, "{}");
      for (const k of keys) flatten(value[k], path ? `${path}.${k}` : k, out);
    } else out.set(path, value === undefined ? "" : value);
    return out;
  }

  /** Line diff of two texts with the unchanged stretches collapsed to "N unchanged lines". */
  function collapsedDiff(a, b, context = 2) {
    const full = FlowDesignerData.lineDiff(a, b);
    if (!full) return null;
    const keep = full.map((l) => l.op !== "=");
    const near = keep.map((_, i) => { for (let d = -context; d <= context; d++) if (keep[i + d]) return true; return false; });
    const out = [];
    let skipped = 0;
    full.forEach((l, i) => {
      if (near[i]) { if (skipped) { out.push({ op: "skip", count: skipped }); skipped = 0; } out.push(l); } else skipped++;
    });
    if (skipped) out.push({ op: "skip", count: skipped });
    return out;
  }

  const isScript = (a, b) => [a, b].some((s) => typeof s === "string" && (s.includes("\n") || s.length > 120));

  function fieldChanges(before, after) {
    const a = before ? flatten(before, "", new Map()) : new Map();
    const b = after ? flatten(after, "", new Map()) : new Map();
    const out = [];
    for (const path of new Set([...a.keys(), ...b.keys()])) {
      const x = a.get(path), y = b.get(path);
      if (a.has(path) && b.has(path) && String(x) === String(y)) continue;
      const row = { path, before: a.has(path) ? x : undefined, after: b.has(path) ? y : undefined };
      if (typeof x === "string" && typeof y === "string" && isScript(x, y)) row.lines = collapsedDiff(x, y);
      out.push(row);
    }
    return out;
  }

  const strip = (e) => { const o = {}; for (const [k, v] of Object.entries(e)) if (!IGNORED.has(k)) o[k] = v; return o; };
  const stepLabel = (e, id) => String(e.label || e.name || (e.configuration && e.configuration.label) || e.stepType || e.kind || id);

  /** Steps added, removed and changed between two designer documents, field by field. Arrows only
   *  count. `type` is the step kind (the designer's own name for it). */
  function diffDesigners(oldDesigner, newDesigner) {
    const a = FlowDesignerData.materialize(oldDesigner && oldDesigner.data), b = FlowDesignerData.materialize(newDesigner && newDesigner.data);
    const steps = [];
    let arrows = 0;
    for (const id of new Set([...a.keys(), ...b.keys()])) {
      const x = a.get(id), y = b.get(id);
      const kind = (y || x).kind;
      if (kind === "arrow") { if (!x || !y || JSON.stringify(strip(x)) !== JSON.stringify(strip(y))) arrows++; continue; }
      if (!x || !y) { steps.push({ id, label: stepLabel(y || x, id), kind, stepType: (y || x).stepType || null, status: x ? "removed" : "added", changes: [] }); continue; }
      const changes = fieldChanges(strip(x), strip(y));
      if (changes.length) steps.push({ id, label: stepLabel(y, id), kind, stepType: y.stepType || x.stepType || null, status: "changed", changes });
    }
    const root = [];
    for (const k of ["parameterTypeExpression", "resultTypeExpression"]) {
      const x = (oldDesigner || {})[k] || "{}", y = (newDesigner || {})[k] || "{}";
      if (x !== y) root.push({ path: k, before: x, after: y, lines: isScript(x, y) ? collapsedDiff(x, y) : undefined });
    }
    return { steps, arrows, root };
  }

  /** Compares two asset lists ([{ assetId, assetVersion }]): added, removed and re-versioned assets. */
  function compareAssetLists(deployed, current) {
    const d = new Map((deployed || []).map((r) => [r.assetId, r])), c = new Map((current || []).map((r) => [r.assetId, r]));
    const out = [];
    for (const id of new Set([...d.keys(), ...c.keys()])) {
      const x = d.get(id), y = c.get(id);
      if (x && y && x.assetVersion === y.assetVersion) continue;
      out.push({ assetId: id, status: !x ? "added" : !y ? "removed" : "changed", fromVersion: x ? x.assetVersion : null, toVersion: y ? y.assetVersion : null, indirect: !!((y || x).usedIndirectly) });
    }
    return out;
  }

  const api = { initialsOf, describeVersion, findDeployedVersion, readDeployed, readVersionDesigner, readModuleCode, readVersionInfos, collapsedDiff, fieldChanges, diffDesigners, compareAssetLists };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.FlowAnalysis = api;
})(typeof window !== "undefined" ? window : globalThis);
