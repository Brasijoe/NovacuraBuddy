/* ============================================================
   Flow Links — linked copies of one flow in several packages of an
   organisation (Flow Classic menus are per package, so a flow that
   several menus need exists once per package). All copies of a link
   group are equal: any of them can be edited and pushed to the
   others (user, 2026-10-22). A push replaces the target's steps with
   the source's and points every reference at the target package's
   own asset (a flow can only use its own package's assets and the
   App Library), then commits the target as a new version.

   The link lives in each flow's description as a visible tag:
     ⛓ Linked with copies in other packages. Push changes with Novacura Buddy. [nb-link id=7f3a1c rev=7 h=9c41e0a1b2c3d4e5 src=<flow id> at=2026-10-22T12:30Z]
   id  = link group id, the same in every copy
   rev = push counter; the highest rev in the group is the latest version
   h   = fingerprint of the copy's steps right after its last push or
         pull, with package-specific references replaced by names, so a
         copy whose steps no longer hash to it was changed there
   src = the flow that version was pushed from; at = when
   ============================================================ */
(function (global) {
  const FlowConnectRest = typeof require === "function" ? require("./flow-connect-rest.js") : global.FlowConnectRest;
  const FlowModules = typeof require === "function" ? require("./flow-modules.js") : global.FlowModules;
  const FlowDesignerTab = typeof require === "function" ? require("./flow-designer-tab.js") : global.FlowDesignerTab;
  const FlowTransfer = typeof require === "function" ? require("./flow-transfer.js") : global.FlowTransfer;
  const { throwWithResponseBody } = FlowConnectRest;

  const TAG_SENTENCE = "⛓ Linked with copies in other packages. Push changes with Novacura Buddy.";
  // The tag (and the sentence in front of it, when there) at the end of a description.
  const TAG_RE = /\s*(?:⛓[^[\n]*)?\[nb-link ([^\]]*)\]\s*$/;
  const LIBRARY_NAME = "App Library";
  const isFlow = (asset) => asset && asset.type !== "module";

  /* --- link tag --- */

  /** { id, rev, h, at } from a description, or null when it carries no link tag. */
  function parseLinkTag(description) {
    const m = TAG_RE.exec(String(description || ""));
    if (!m) return null;
    const fields = {};
    for (const part of m[1].trim().split(/\s+/)) {
      const eq = part.indexOf("=");
      if (eq > 0) fields[part.slice(0, eq)] = part.slice(eq + 1);
    }
    if (!fields.id) return null;
    const rev = parseInt(fields.rev, 10);
    return { id: fields.id, rev: Number.isFinite(rev) ? rev : 0, h: fields.h || "", src: fields.src || "", at: fields.at || "" };
  }

  function formatLinkTag(tag) {
    return `[nb-link id=${tag.id} rev=${tag.rev} h=${tag.h}${tag.src ? ` src=${tag.src}` : ""}${tag.at ? ` at=${tag.at}` : ""}]`;
  }

  /** The description with its link tag replaced by `tag` (null removes it). The rest of the text
   *  stays as the user wrote it. */
  function withLinkTag(description, tag) {
    const text = String(description || "").replace(TAG_RE, "").replace(/\s+$/, "");
    if (!tag) return text;
    return `${text}${text ? "\n\n" : ""}${TAG_SENTENCE} ${formatLinkTag(tag)}`;
  }

  function newLinkId() {
    const bytes = new Uint8Array(3);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  const nowStamp = () => new Date().toISOString().slice(0, 16) + "Z";

  /* --- steps, fingerprint, diff --- */

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

  // Layout and bookkeeping that differ between copies without being a change of the flow.
  const IGNORED_KEYS = new Set(["location", "joints", "attribution", "eTag", "type", "kind"]);

  /** Deep copy for comparing copies of a flow: ids of referenced assets/versions become their
   *  names (`refNames`), a connector becomes its name, layout keys are dropped. */
  function normalize(value, refNames, nested) {
    if (typeof value === "string") return Object.prototype.hasOwnProperty.call(refNames, value) ? refNames[value] : value;
    if (Array.isArray(value)) return value.map((v) => normalize(v, refNames, true));
    if (!value || typeof value !== "object") return value;
    const out = {};
    for (const key of Object.keys(value).sort()) {
      // Only the event's own layout keys: a "type" inside a step's configuration is content.
      if (!nested && IGNORED_KEYS.has(key)) continue;
      const v = value[key];
      if (key === "connector" && v && typeof v === "object") out[key] = { name: String(v.name || "").toUpperCase() };
      else out[key] = normalize(v, refNames, true);
    }
    return out;
  }

  /** Asset id -> "@type:NAME" and version id -> "@version" for every asset `designer` references,
   *  using `index` (asset id -> { name, type }). */
  function refNamesFor(designer, index) {
    const names = {};
    for (const ref of (designer && designer.assets) || []) {
      const asset = index && (index.get ? index.get(ref.assetId) : index[ref.assetId]);
      names[ref.assetId] = asset ? `@${asset.type}:${String(asset.name).toUpperCase()}` : `@missing:${ref.assetId}`;
      if (ref.assetVersion) names[ref.assetVersion] = "@version";
    }
    return names;
  }

  // 64-bit FNV-1a as two 32-bit halves; enough to tell edited copies apart, not a security hash.
  function hash(text) {
    let h1 = 0x811c9dc5, h2 = 0xcbf29ce4;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c ^ (i & 0xff), 0x01000193) >>> 0;
    }
    return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
  }

  const entityLabel = (e) => e.label || e.name || (e.configuration && e.configuration.label) || e.stepType || e.kind;
  const ENTITY_ID_KEYS = ["id", "stepId", "arrowId"];
  const withoutIds = (e) => { const out = { ...e }; for (const k of ENTITY_ID_KEYS) delete out[k]; return out; };

  /** Entity id -> a key that does not depend on the ids Flow generated, so copies whose steps got
   *  new ids (copied in Flow itself, or rebuilt) still line up: "kind:LABEL" for steps (with "#n"
   *  for repeated labels, in creation order), and for arrows their content with the step keys of
   *  both ends. `prefer` (id -> key) keeps an already matched entity's key. */
  function entityKeys(items, refNames, prefer) {
    const keys = {}, seen = new Map();
    const unique = (base) => { const n = (seen.get(base) || 0) + 1; seen.set(base, n); return n === 1 ? base : `${base}#${n}`; };
    const entries = [...items.entries()];
    for (const [id, e] of entries) if (e.kind !== "arrow") keys[id] = prefer && prefer[id] ? unique(prefer[id]) : unique(`${e.kind}:${String(entityLabel(e)).toUpperCase()}`);
    const names = { ...refNames, ...keys };
    for (const [id, e] of entries) if (e.kind === "arrow") keys[id] = unique(`arrow:${JSON.stringify(normalize(withoutIds(e), names))}`);
    return keys;
  }

  /** The fingerprint of a flow's content: its entities, referenced assets and type expressions,
   *  without anything package-specific or generated ids. Equal copies in different packages hash
   *  the same. */
  function fingerprint(designer, refNames) {
    const items = materialize(designer.data);
    const keys = entityKeys(items, refNames);
    const names = { ...refNames, ...keys };
    const entities = [...items.entries()]
      .map(([id, e]) => [keys[id], normalize(withoutIds(e), names)])
      .sort((a, b) => a[0].localeCompare(b[0]));
    const refs = ((designer && designer.assets) || []).map((r) => refNames[r.assetId] || r.assetId).sort();
    // Every event too, in order, so a change in an event the replay above doesn't model (its id
    // under another key, a new event type) still counts. Pure layout events carry nothing here.
    const data = (Array.isArray(designer.data) ? designer.data : []).filter((e) => e && typeof e === "object");
    // Entities deleted since get a stable name too, so copies with other generated ids still match.
    let gone = 0;
    for (const e of data) {
      const id = e.id || e.stepId || e.arrowId;
      if (id && !Object.prototype.hasOwnProperty.call(names, id)) names[id] = `@gone#${++gone}`;
    }
    const events = data
      .map((e) => [String(e.type || ""), normalize(withoutIds(e), names)])
      .filter(([, n]) => Object.keys(n).length);
    return hash(JSON.stringify({
      entities, refs, events,
      parameterType: designer.parameterTypeExpression || "{}",
      resultType: designer.resultTypeExpression || "{}"
    }));
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

  /** What pushing `source` over `target` changes in the target ({ designer, refNames } each):
   *  per step (and any other entity but arrows) "same" | "changed" | "added" | "removed" in the
   *  source's order, the target's own steps last, plus how many arrows change. A changed step
   *  with a script carries a line diff (target -> source). */
  function diffSteps(source, target) {
    const s = materialize(source.designer.data), t = materialize(target.designer.data);
    // Pair target steps with source steps: by id when the copy kept the ids, else by label.
    const sKeys = entityKeys(s, source.refNames);
    const byKey = new Map(Object.entries(sKeys).map(([id, key]) => [key, id]));
    const prefer = {};
    for (const [id, e] of t) if (e.kind !== "arrow" && s.has(id) && s.get(id).kind !== "arrow") prefer[id] = sKeys[id];
    const tKeys = entityKeys(t, target.refNames, prefer);
    const match = new Map(); // target id -> source id
    for (const [id, key] of Object.entries(tKeys)) if (byKey.has(key)) match.set(id, byKey.get(key));
    const matchedSource = new Set(match.values());
    const sNames = { ...source.refNames, ...sKeys }, tNames = { ...target.refNames, ...tKeys };
    const same = (a, b) => JSON.stringify(normalize(withoutIds(a), sNames)) === JSON.stringify(normalize(withoutIds(b), tNames));
    const targetOf = new Map([...match].map(([tid, sid]) => [sid, tid]));
    const rows = [];
    let arrows = 0;
    for (const [id, e] of s) {
      const other = targetOf.has(id) ? t.get(targetOf.get(id)) : null;
      if (e.kind === "arrow") { if (!other) arrows++; continue; }
      const row = { id, kind: e.kind, label: entityLabel(e), stepType: e.stepType || e.kind };
      if (!other) row.change = "added";
      else if (same(e, other)) row.change = "same";
      else {
        row.change = "changed";
        const a = other.configuration && other.configuration.script, b = e.configuration && e.configuration.script;
        if (typeof a === "string" && typeof b === "string" && a !== b) row.script = lineDiff(a, b);
      }
      rows.push(row);
    }
    for (const [id, e] of t) {
      if (match.has(id) && matchedSource.has(match.get(id))) continue;
      if (e.kind === "arrow") { arrows++; continue; }
      rows.push({ id, kind: e.kind, label: entityLabel(e), stepType: e.stepType || e.kind, change: "removed" });
    }
    const count = (c) => rows.filter((r) => r.change === c).length;
    return { rows, arrows, changed: count("changed"), added: count("added"), removed: count("removed") };
  }

  /** A copy's status against its group: "in_sync", "changed" (edited after its last push or
   *  pull), "behind" (another copy pushed a newer version), "conflict" (both), "differs" (linked
   *  with different steps and never pushed or pulled since), or "unknown" (unreadable). */
  function memberStatus(tag, fp, maxRev) {
    if (!tag) return "unlinked";
    if (!fp) return "unknown";
    if (tag.rev === 0) return "differs";
    const changed = fp !== tag.h;
    const behind = tag.rev < maxRev;
    return changed && behind ? "conflict" : changed ? "changed" : behind ? "behind" : "in_sync";
  }

  /** Link groups in a scan: link id -> members (flows carrying that id), by package name. */
  function groupsOf(assets) {
    const groups = new Map();
    for (const a of assets || []) {
      if (!a.tag || !isFlow(a)) continue;
      if (!groups.has(a.tag.id)) groups.set(a.tag.id, []);
      groups.get(a.tag.id).push(a);
    }
    for (const list of groups.values()) list.sort((a, b) => String(a.packageName).localeCompare(String(b.packageName)));
    return groups;
  }

  const maxRevOf = (members) => members.reduce((m, a) => Math.max(m, a.tag ? a.tag.rev : 0), 0);

  /** Where a target package gets each asset the source references: the App Library asset itself,
   *  the target package's own asset of the same name and type ("own"), a same-named App Library
   *  asset, a fresh copy of a package module ("copy-in"), or nothing ("missing": a sub-flow or
   *  other asset the target package lacks). */
  function mapReferences(sourceDesigner, index, targetPackageId, assets) {
    const byKey = (pkgId, asset) => (assets || []).find((a) => a.packageId === pkgId && a.type === asset.type && String(a.name).toUpperCase() === String(asset.name).toUpperCase());
    return ((sourceDesigner && sourceDesigner.assets) || []).map((ref) => {
      const asset = index.get(ref.assetId);
      if (!asset) return { ref, name: ref.assetId, type: "unknown", mode: "missing" };
      const base = { ref, name: asset.name, type: asset.type, sourcePackageId: asset.packageId };
      if (asset.packageId === null) return { ...base, mode: "library", targetId: asset.id, targetPackageId: null };
      if (asset.packageId === targetPackageId) return { ...base, mode: "own", targetId: asset.id, targetPackageId };
      const own = byKey(targetPackageId, asset);
      if (own) return { ...base, mode: "own", targetId: own.id, targetPackageId };
      const lib = byKey(null, asset);
      if (lib) return { ...base, mode: "library", targetId: lib.id, targetPackageId: null };
      if (asset.type === "module") return { ...base, mode: "copy-in" };
      return { ...base, mode: "missing" };
    });
  }

  /* --- Flow Connect --- */

  async function pool(items, size, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
    await Promise.all(Array.from({ length: Math.min(size, items.length) || 1 }, worker));
    return out;
  }

  /** Every asset of the organisation (App Library and every package) with its link tag. */
  async function scan({ flowFetch, orgId }) {
    const packages = await FlowTransfer.listPackages({ flowFetch, orgId });
    const locations = [{ id: null, name: LIBRARY_NAME }, ...packages];
    // One retry: a package missing from the scan would turn its assets into unknown references.
    const list = (loc) => FlowModules.listAssets({ flowFetch, orgId, packageId: loc.id });
    const lists = await pool(locations, 3, (loc) => list(loc).catch(() => list(loc)).catch(() => []));
    const assets = [];
    locations.forEach((loc, i) => {
      for (const a of lists[i]) {
        assets.push({
          id: a.id, name: a.name, type: a.type, description: a.description || "", color: a.color || null,
          tagIds: a.tagIds || [], mainBranch: a.mainBranch || null,
          packageId: loc.id, packageName: loc.name, tag: parseLinkTag(a.description)
        });
      }
    });
    return { orgId, packages, assets, scannedAt: new Date().toISOString() };
  }

  const indexOf = (scanResult) => new Map(scanResult.assets.map((a) => [a.id, a]));

  /** A flow's designer data, ref names and fingerprint. */
  async function readState({ flowFetch, orgId, asset, index }) {
    const designer = await FlowDesignerTab.getDesignerData({ flowFetch, orgId, itemId: asset.id });
    const refNames = refNamesFor(designer, index);
    return { asset, designer, refNames, fp: fingerprint(designer, refNames) };
  }

  /** Fingerprint and status of every member of the given groups (all groups when `linkIds` is
   *  empty): { [assetId]: { fp, status } }. */
  async function statuses({ flowFetch, orgId, scanResult, linkIds }) {
    const index = indexOf(scanResult);
    const groups = groupsOf(scanResult.assets);
    const wanted = linkIds && linkIds.length ? linkIds.filter((id) => groups.has(id)) : [...groups.keys()];
    const out = {};
    for (const linkId of wanted) {
      const members = groups.get(linkId);
      const maxRev = maxRevOf(members);
      const fps = await pool(members, 3, (m) => readState({ flowFetch, orgId, asset: m, index }).then((s) => s.fp).catch(() => null));
      members.forEach((m, i) => { out[m.id] = { fp: fps[i], status: memberStatus(m.tag, fps[i], maxRev) }; });
    }
    return out;
  }

  /** UNVERIFIED: writes an asset's description. Only the asset create POST and the GETs are
   *  captured, so this tries a PUT of the asset's editable fields on its own URL, then a PATCH. */
  async function setDescription({ flowFetch, orgId, asset, description }) {
    const url = `${FlowModules.assetsPath(orgId, asset.packageId)}/${asset.id}`;
    const body = JSON.stringify({ name: asset.name, description, color: asset.color || "#0A68FF", tagIds: asset.tagIds || [] });
    const headers = { "Content-Type": "application/json" };
    let res = await flowFetch(url, { method: "PUT", headers, body });
    if (!res.ok && (res.status === 404 || res.status === 405)) res = await flowFetch(url, { method: "PATCH", headers, body });
    if (!res.ok) await throwWithResponseBody(res, `Could not update the description of ${asset.name}`);
    asset.description = description;
    asset.tag = parseLinkTag(description);
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
  async function saveAndCommit({ flowFetch, orgId, asset, snapshot, message }) {
    const current = await FlowDesignerTab.getDesignerData({ flowFetch, orgId, itemId: asset.id });
    // data: [] so the snapshot's full data REPLACES the flow's (saveDesignerAssets appends events).
    const saved = { ...snapshot, eTag: current.eTag, data: [] };
    await FlowDesignerTab.saveDesignerAssets({ flowFetch, orgId, itemId: asset.id, designerData: saved, assets: snapshot.assets, events: snapshot.data });
    const fresh = await FlowModules.getModuleAsset({ flowFetch, orgId, packageId: asset.packageId, assetId: asset.id });
    const branch = await FlowDesignerTab.commitFlow({ flowFetch, orgId, itemId: asset.id, branch: fresh.mainBranch, designerData: { ...saved, assets: snapshot.assets }, message });
    return { previous: designerSnapshot(current), branch };
  }

  /** Writes `source`'s content into the flow `target` (both readState results; target may be a
   *  just-created empty flow), mapping references with `refs` (mapReferences) and copying
   *  missing package modules in first. Returns the target's previous content for Undo. */
  async function pushInto({ flowFetch, orgId, source, target, refs, scanResult, log }) {
    const idMap = {};
    const assetsRefs = [];
    for (const r of refs) {
      let targetId = r.targetId, targetPackageId = r.targetPackageId;
      if (r.mode === "missing") throw new Error(`${r.name} is not in ${target.packageName || "the target package"}. Link or copy it there first.`);
      if (r.mode === "copy-in") {
        const code = await FlowTransfer.readModuleSource({ flowFetch, orgId, assetId: r.ref.assetId, versionId: r.ref.assetVersion || source.index.get(r.ref.assetId).mainBranch.headVersionId });
        const created = await FlowModules.createModuleAsset({ flowFetch, orgId, packageId: target.packageId, projectionName: r.name });
        await FlowModules.commitModuleCode({ flowFetch, orgId, packageId: target.packageId, assetId: created.id, flowScriptCode: code });
        if (log) log("Flow links: copied module", r.name, "into", target.packageName);
        targetId = created.id;
        targetPackageId = target.packageId;
        scanResult.assets.push({ ...created, packageId: target.packageId, packageName: target.packageName, tag: null });
      }
      const meta = await FlowModules.getModuleAsset({ flowFetch, orgId, packageId: targetPackageId, assetId: targetId });
      idMap[r.ref.assetId] = targetId;
      if (r.ref.assetVersion) idMap[r.ref.assetVersion] = meta.mainBranch.headVersionId;
      assetsRefs.push({ ...r.ref, assetId: targetId, assetVersion: meta.mainBranch.headVersionId });
    }
    const snapshot = { ...designerSnapshot(source.designer), assets: assetsRefs, data: FlowTransfer.remap(source.designer.data, idMap, null) };
    return saveAndCommit({ flowFetch, orgId, asset: target, snapshot, message: `Pushed from ${source.asset.packageName} by Novacura Buddy.` });
  }

  /** What pushing the flow `sourceId` to its group (or the given `targetIds`) would do. */
  async function planPush({ flowFetch, orgId, sourceId, targetIds, scanResult }) {
    const index = indexOf(scanResult);
    const sourceAsset = index.get(sourceId);
    if (!sourceAsset || !sourceAsset.tag) throw new Error("This flow is not linked.");
    const members = groupsOf(scanResult.assets).get(sourceAsset.tag.id);
    const maxRev = maxRevOf(members);
    const source = await readState({ flowFetch, orgId, asset: sourceAsset, index });
    const others = members.filter((m) => m.id !== sourceId && (!targetIds || !targetIds.length || targetIds.includes(m.id)));
    const targets = await pool(others, 3, async (m) => {
      const target = await readState({ flowFetch, orgId, asset: m, index }).catch((e) => ({ asset: m, error: e.message }));
      const refs = mapReferences(source.designer, index, m.packageId, scanResult.assets);
      if (target.error) return { asset: m, status: "unknown", refs, blocked: target.error };
      const status = memberStatus(m.tag, target.fp, maxRev);
      const sameSteps = target.fp === source.fp;
      // Pushing loses work when the target has changes of its own, or is newer than the source.
      const losesWork = !sameSteps && (status === "changed" || status === "conflict" || status === "differs" || m.tag.rev > sourceAsset.tag.rev);
      const missing = refs.filter((r) => r.mode === "missing");
      return {
        asset: m, status, refs, sameSteps, losesWork,
        diff: sameSteps ? null : diffSteps(source, target),
        blocked: missing.length ? `${missing.map((r) => r.name).join(", ")} ${missing.length === 1 ? "is" : "are"} not in ${m.packageName}. Link or copy ${missing.length === 1 ? "it" : "them"} there first.` : null
      };
    });
    return {
      linkId: sourceAsset.tag.id, sourceId, sourceName: sourceAsset.name, sourcePackage: sourceAsset.packageName,
      sourceStatus: memberStatus(sourceAsset.tag, source.fp, maxRev), sourceFp: source.fp, sourceETag: source.designer.eTag || null,
      maxRev, newRev: maxRev + 1, targets
    };
  }

  /** Pushes `sourceId` to `targets` ([{ id, overwrite }]). Re-reads the group first and stops
   *  when anyone pushed since the preview (`expectedMaxRev`) or the source changed
   *  (`expectedSourceFp`). A target that would lose its own changes is only overwritten with
   *  `overwrite: true`, otherwise skipped. Pushed targets are committed. */
  async function runPush({ flowFetch, orgId, sourceId, targets, expectedMaxRev, expectedSourceFp, expectedSourceETag, log }) {
    const scanResult = await scan({ flowFetch, orgId });
    const plan = await planPush({ flowFetch, orgId, sourceId, targetIds: targets.map((t) => t.id), scanResult });
    if (plan.maxRev !== expectedMaxRev) throw new Error("Another copy was pushed since the preview. Nothing was changed. Open the preview again to see the new state.");
    // A save changes the etag, so it is the sure sign of an edit; the fingerprint is the fallback.
    const sourceChanged = expectedSourceETag && plan.sourceETag ? plan.sourceETag !== expectedSourceETag : expectedSourceFp && plan.sourceFp !== expectedSourceFp;
    if (sourceChanged) throw new Error("This flow was saved since the preview (by someone in the Designer, or by a sync that already ran). Nothing was changed now. Rescan and open the preview again.");
    const index = indexOf(scanResult);
    const sourceAsset = index.get(sourceId);
    const source = { ...(await readState({ flowFetch, orgId, asset: sourceAsset, index })), index };
    const tag = { id: plan.linkId, rev: plan.newRev, h: plan.sourceFp, src: sourceId, at: nowStamp() };
    const results = [];
    for (const t of plan.targets) {
      const wanted = targets.find((x) => x.id === t.asset.id) || {};
      const row = { id: t.asset.id, name: t.asset.name, packageName: t.asset.packageName, packageId: t.asset.packageId };
      if (t.blocked) { results.push({ ...row, outcome: "failed", reason: t.blocked }); continue; }
      if (t.losesWork && !wanted.overwrite) { results.push({ ...row, outcome: "skipped", reason: "has its own changes" }); continue; }
      try {
        const description = t.asset.description;
        let previous = null;
        if (!t.sameSteps) {
          const pushed = await pushInto({ flowFetch, orgId, source, target: t.asset, refs: t.refs, scanResult, log });
          previous = pushed.previous;
        }
        await setDescription({ flowFetch, orgId, asset: t.asset, description: withLinkTag(t.asset.description, tag) });
        results.push({ ...row, outcome: "pushed", overwrote: t.losesWork, unchanged: t.sameSteps, undo: previous ? { previous, description } : null, copiedIn: t.refs.filter((r) => r.mode === "copy-in").map((r) => r.name) });
      } catch (e) {
        results.push({ ...row, outcome: "failed", reason: e.message });
      }
    }
    if (results.some((r) => r.outcome === "pushed")) {
      // The source's own edits become a version too, so every copy has the same committed state.
      // Not when no copy got new steps: then there is nothing new to commit.
      if (results.some((r) => r.outcome === "pushed" && !r.unchanged)) try {
        const fresh = await FlowModules.getModuleAsset({ flowFetch, orgId, packageId: sourceAsset.packageId, assetId: sourceId });
        await FlowDesignerTab.commitFlow({ flowFetch, orgId, itemId: sourceId, branch: fresh.mainBranch, designerData: source.designer, message: "Pushed to linked copies by Novacura Buddy." });
      } catch (e) {
        if (log) log("Flow links: committing the source failed:", e.message);
      }
      await setDescription({ flowFetch, orgId, asset: sourceAsset, description: withLinkTag(sourceAsset.description, tag) });
    }
    return { linkId: plan.linkId, rev: plan.newRev, sourceName: sourceAsset.name, sourcePackage: sourceAsset.packageName, results };
  }

  /** The newest copy of a group: the one the latest version was pushed from, when it still has
   *  those steps, else one at the group's highest rev whose steps still match its tag. */
  async function latestOf({ flowFetch, orgId, scanResult, linkId, exceptId }) {
    const index = indexOf(scanResult);
    const members = groupsOf(scanResult.assets).get(linkId) || [];
    const maxRev = maxRevOf(members);
    const top = members.filter((m) => m.tag.rev === maxRev && m.id !== exceptId)
      .sort((a, b) => (b.id === b.tag.src) - (a.id === a.tag.src));
    for (const m of top) {
      const s = await readState({ flowFetch, orgId, asset: m, index }).catch(() => null);
      if (s && s.fp === m.tag.h) return m;
    }
    return top[0] || null;
  }

  /** What linking would do: the flow `sourceId` with existing flows `adoptIds`, and new copies in
   *  `newPackageIds` (copy and link in one run). */
  async function planLink({ flowFetch, orgId, sourceId, adoptIds, newPackageIds, scanResult }) {
    const index = indexOf(scanResult);
    const sourceAsset = index.get(sourceId);
    if (!sourceAsset || !isFlow(sourceAsset)) throw new Error("Pick a flow to link.");
    const groups = groupsOf(scanResult.assets);
    const group = sourceAsset.tag ? groups.get(sourceAsset.tag.id) : null;
    const source = await readState({ flowFetch, orgId, asset: sourceAsset, index });
    const sourceStatus = sourceAsset.tag ? memberStatus(sourceAsset.tag, source.fp, maxRevOf(group)) : "unlinked";
    const adopt = await pool((adoptIds || []).filter((id) => id !== sourceId), 3, async (id) => {
      const a = index.get(id);
      if (!a) return { id, name: id, blocked: "Not found." };
      const row = { id, name: a.name, packageId: a.packageId, packageName: a.packageName };
      if (a.tag && sourceAsset.tag && a.tag.id === sourceAsset.tag.id) return { ...row, blocked: "Already in this group." };
      if (a.tag) return { ...row, blocked: `Already linked in group ${a.tag.id}. Unlink it there first.` };
      if (a.packageId === sourceAsset.packageId) return { ...row, blocked: "Is in the same package. Linked copies live in different packages." };
      const s = await readState({ flowFetch, orgId, asset: a, index }).catch(() => null);
      return { ...row, sameSteps: !!s && s.fp === source.fp };
    });
    const usedPackages = new Set([sourceAsset.packageId, ...(group || []).map((m) => m.packageId), ...adopt.filter((a) => !a.blocked).map((a) => a.packageId)]);
    const fresh = (newPackageIds || []).map((packageId) => {
      const pkg = packageId === null ? { id: null, name: LIBRARY_NAME } : scanResult.packages.find((p) => p.id === packageId);
      const row = { packageId, packageName: pkg ? pkg.name : packageId, name: sourceAsset.name };
      if (usedPackages.has(packageId)) return { ...row, blocked: "Already has a copy in this group." };
      const refs = mapReferences(source.designer, index, packageId, scanResult.assets);
      const missing = refs.filter((r) => r.mode === "missing");
      const clash = scanResult.assets.find((a) => a.packageId === packageId && isFlow(a) && String(a.name).toUpperCase() === String(sourceAsset.name).toUpperCase());
      return {
        ...row, refs,
        existingId: clash ? clash.id : null,
        blocked: missing.length ? `${missing.map((r) => r.name).join(", ")} not in ${row.packageName}. Link or copy ${missing.length === 1 ? "it" : "them"} there first.` : null
      };
    });
    const blockedSource = sourceAsset.tag && sourceStatus !== "in_sync" && (fresh.length || adopt.length)
      ? "Push or pull this flow first, so new copies start from the group's latest version." : null;
    return {
      sourceId, sourceName: sourceAsset.name, sourcePackage: sourceAsset.packageName, linkId: sourceAsset.tag ? sourceAsset.tag.id : null,
      sourceStatus, sourceFp: source.fp, adopt, fresh, blocked: blockedSource
    };
  }

  /** Links `sourceId` with `adoptIds` and creates linked copies in `newPackageIds`. A new group
   *  starts at rev 1 from the source; an adopted flow with other steps gets rev 0 ("differs")
   *  until someone pushes or pulls. New copies are created, filled and committed. */
  async function runLink({ flowFetch, orgId, sourceId, adoptIds, newPackageIds, log }) {
    const scanResult = await scan({ flowFetch, orgId });
    const plan = await planLink({ flowFetch, orgId, sourceId, adoptIds, newPackageIds, scanResult });
    if (plan.blocked) throw new Error(plan.blocked);
    const index = indexOf(scanResult);
    const sourceAsset = index.get(sourceId);
    const source = { ...(await readState({ flowFetch, orgId, asset: sourceAsset, index })), index };
    const tag = sourceAsset.tag ? { ...sourceAsset.tag } : { id: newLinkId(), rev: 1, h: source.fp, src: sourceId, at: nowStamp() };
    const results = [];
    if (!sourceAsset.tag) {
      await setDescription({ flowFetch, orgId, asset: sourceAsset, description: withLinkTag(sourceAsset.description, tag) });
      results.push({ id: sourceId, name: sourceAsset.name, packageName: sourceAsset.packageName, outcome: "linked" });
    }
    for (const a of plan.adopt) {
      const row = { id: a.id, name: a.name, packageName: a.packageName };
      if (a.blocked) { results.push({ ...row, outcome: "failed", reason: a.blocked }); continue; }
      try {
        const asset = index.get(a.id);
        const own = a.sameSteps ? tag : { id: tag.id, rev: 0, h: (await readState({ flowFetch, orgId, asset, index })).fp, src: tag.src, at: nowStamp() };
        await setDescription({ flowFetch, orgId, asset, description: withLinkTag(asset.description, own) });
        results.push({ ...row, outcome: "linked", differs: !a.sameSteps });
      } catch (e) {
        results.push({ ...row, outcome: "failed", reason: e.message });
      }
    }
    for (const f of plan.fresh) {
      const row = { name: f.name, packageName: f.packageName, packageId: f.packageId };
      if (f.blocked) { results.push({ ...row, outcome: "failed", reason: f.blocked }); continue; }
      try {
        const res = await flowFetch(FlowModules.assetsPath(orgId, f.packageId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: sourceAsset.name, description: withLinkTag(sourceAsset.description, tag), color: sourceAsset.color || "#0A68FF", type: sourceAsset.type, tagIds: [] })
        });
        if (!res.ok) await throwWithResponseBody(res, `Could not create ${sourceAsset.name} in ${f.packageName}`);
        const created = await res.json();
        const target = { ...created, packageId: f.packageId, packageName: f.packageName, tag };
        scanResult.assets.push(target);
        await pushInto({ flowFetch, orgId, source, target, refs: f.refs, scanResult, log });
        results.push({ ...row, id: created.id, outcome: "created", copiedIn: f.refs.filter((r) => r.mode === "copy-in").map((r) => r.name) });
      } catch (e) {
        results.push({ ...row, outcome: "failed", reason: e.message });
      }
    }
    return { linkId: tag.id, results };
  }

  /** Removes the link tag from one flow; the flow itself stays as it is. */
  async function unlink({ flowFetch, orgId, assetId }) {
    const scanResult = await scan({ flowFetch, orgId });
    const asset = indexOf(scanResult).get(assetId);
    if (!asset) throw new Error("Flow not found.");
    await setDescription({ flowFetch, orgId, asset, description: withLinkTag(asset.description, null) });
  }

  /** Puts a pushed copy back to what it was before the push (content and tag), as a new version. */
  async function undoPush({ flowFetch, orgId, assetId, undo }) {
    const scanResult = await scan({ flowFetch, orgId });
    const asset = indexOf(scanResult).get(assetId);
    if (!asset) throw new Error("Flow not found.");
    await saveAndCommit({ flowFetch, orgId, asset, snapshot: undo.previous, message: "Push undone by Novacura Buddy." });
    await setDescription({ flowFetch, orgId, asset, description: undo.description });
  }

  const api = {
    TAG_SENTENCE, parseLinkTag, formatLinkTag, withLinkTag, newLinkId, materialize, normalize, refNamesFor, fingerprint,
    lineDiff, diffSteps, memberStatus, groupsOf, maxRevOf, mapReferences,
    scan, statuses, setDescription, designerSnapshot, saveAndCommit, planPush, runPush, latestOf, planLink, runLink, unlink, undoPush
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.FlowLinks = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
