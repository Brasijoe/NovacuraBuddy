/* ============================================================
   Flow Transfer — export a flow with everything it references
   (modules, sub-flows, other assets) into one JSON package, and
   import such a package into any organisation/package the Flow
   session can reach ("copy" is export + import without a file).
   The background worker calls these with its bound flowFetch.
   ============================================================ */
(function (global) {
  const FlowConnectRest = typeof require === "function" ? require("./flow-connect-rest.js") : global.FlowConnectRest;
  const FlowModules = typeof require === "function" ? require("./flow-modules.js") : global.FlowModules;
  const FlowDesignerTab = typeof require === "function" ? require("./flow-designer-tab.js") : global.FlowDesignerTab;
  const { throwWithResponseBody } = FlowConnectRest;

  const FORMAT = "novacura-buddy-flow";
  const FORMAT_VERSION = 1;
  const API = "/admin/application/api/v2/organisations";

  const isModule = (asset) => asset.type === "module";
  /** The assets the user picked for export: `rootIds` (several flows, a whole package) or the
   *  single `rootId` of a one-flow export. */
  const rootIdsOf = (pkg) => (Array.isArray(pkg.rootIds) && pkg.rootIds.length ? pkg.rootIds : [pkg.rootId]);

  /* --- pure helpers --- */

  /** Throws unless `pkg` is a flow package this version can import. */
  function validatePackage(pkg) {
    if (!pkg || typeof pkg !== "object" || pkg.format !== FORMAT) throw new Error("This is not a NovacuraBuddy flow export (format field missing).");
    if (pkg.formatVersion > FORMAT_VERSION) throw new Error(`This flow export needs a newer NovacuraBuddy (format ${pkg.formatVersion}).`);
    if (!pkg.assets || !rootIdsOf(pkg).every((id) => pkg.assets[id])) throw new Error("The flow export is missing one of its exported flows.");
    for (const asset of Object.values(pkg.assets)) {
      if (isModule(asset) && typeof asset.source !== "string") throw new Error(`Module ${asset.name} has no source in the export.`);
      if (!isModule(asset) && !asset.designer) throw new Error(`${asset.name} has no flow data in the export.`);
    }
    return pkg;
  }

  /** Every distinct connector a flow's steps use ({ id, name, type } on `connector` keys). */
  function collectConnectors(value, out) {
    const found = out || new Map();
    if (Array.isArray(value)) {
      for (const v of value) collectConnectors(v, found);
    } else if (value && typeof value === "object") {
      for (const [key, v] of Object.entries(value)) {
        if (key === "connector" && v && typeof v === "object" && v.id) {
          if (!found.has(v.id)) found.set(v.id, { id: v.id, name: v.name || "", type: v.type || "" });
        } else {
          collectConnectors(v, found);
        }
      }
    }
    return found;
  }

  /** Deep copy of `value` with every string equal to a key of `idMap` replaced by its value, and
   *  every `connector` object whose id is in `connectorMap` replaced by the mapped connector (or
   *  null). Ids are GUIDs, so an exact-value match never hits unrelated text. */
  function remap(value, idMap, connectorMap) {
    if (typeof value === "string") return Object.prototype.hasOwnProperty.call(idMap, value) ? idMap[value] : value;
    if (Array.isArray(value)) return value.map((v) => remap(v, idMap, connectorMap));
    if (!value || typeof value !== "object") return value;
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (key === "connector" && v && typeof v === "object" && v.id && connectorMap && Object.prototype.hasOwnProperty.call(connectorMap, v.id)) {
        const target = connectorMap[v.id];
        out[key] = target ? { ...v, id: target.id, name: target.name, type: target.type || v.type } : null;
      } else {
        out[key] = remap(v, idMap, connectorMap);
      }
    }
    return out;
  }

  /** Asset ids in the order they must be created: every asset after the assets it references,
   *  the root flow last. A reference cycle is broken at the asset first reached twice. */
  function dependencyOrder(pkg) {
    const order = [];
    const state = new Map(); // id -> "visiting" | "done"
    function visit(id) {
      if (state.has(id) || !pkg.assets[id]) return;
      state.set(id, "visiting");
      const asset = pkg.assets[id];
      for (const ref of (asset.designer && asset.designer.assets) || []) visit(ref.assetId);
      state.set(id, "done");
      order.push(id);
    }
    for (const id of rootIdsOf(pkg)) visit(id);
    for (const id of Object.keys(pkg.assets)) if (!state.has(id)) order.push(id); // unreachable leftovers
    return order;
  }

  /** The IFS projection a module was generated from (its `#importSource("…/Name.svc")` header,
   *  written by FlowModules.generateModuleCode), or null for any other module. */
  function ifsProjectionOf(source) {
    const header = /^\s*\/\*[\s\S]*?\*\//.exec(String(source || ""));
    const m = header && /#importSource\("[^"]*?\/([A-Za-z0-9_]+)\.svc[^"]*"\)/.exec(header[0]);
    return m ? m[1] : null;
  }

  /** The choices one package asset offers against `existing` (its same-name, same-type match in
   *  the target, or null) and the default. "create" next to an existing asset in the target
   *  location would make a second asset of the same name there, so it is only offered when the
   *  match lives elsewhere (App Library vs. package). An IFS module can also be "regenerate"d:
   *  generated fresh from the target's IFS instance (into the existing module when there is
   *  one) — the default for an IFS module the target doesn't have yet. */
  function choicesFor({ isRoot, existing, targetLocation, ifs }) {
    const regenerate = ifs ? ["regenerate"] : [];
    if (!existing) return { options: [...regenerate, "create"], choice: ifs ? "regenerate" : "create" };
    if (isRoot) return { options: ["create", "update"], choice: "create" };
    const options = ["use", "update", ...regenerate];
    if (existing.location !== targetLocation) options.push("create");
    return { options, choice: "use" };
  }

  /** Same name and type, the target package's asset first, then the App Library's. */
  function findMatch(asset, packageAssets, libraryAssets) {
    const name = String(asset.name).toUpperCase();
    const hit = (list) => (list || []).find((a) => a.type === asset.type && String(a.name).toUpperCase() === name);
    const inPackage = hit(packageAssets);
    if (inPackage) return { ...inPackage, location: "package" };
    const inLibrary = hit(libraryAssets);
    return inLibrary ? { ...inLibrary, location: "library" } : null;
  }

  /** A free name for a copy of a flow in `assets` ("X (copy)", "X (copy 2)", ...); `taken` may be
   *  a Set of upper-cased names to also avoid (and is extended with the result). */
  function copyName(name, assets, takenNames) {
    const taken = takenNames || new Set();
    for (const a of assets || []) taken.add(String(a.name).toUpperCase());
    let candidate = name;
    for (let i = 1; taken.has(String(candidate).toUpperCase()); i++) candidate = i === 1 ? `${name} (copy)` : `${name} (copy ${i})`;
    taken.add(String(candidate).toUpperCase());
    return candidate;
  }

  /* --- Flow Connect reads --- */

  async function getJson(flowFetch, path, what) {
    const res = await flowFetch(path);
    if (!res.ok) await throwWithResponseBody(res, `Could not load ${what}`);
    return res.json();
  }

  async function listOrganisations({ flowFetch }) {
    const me = await getJson(flowFetch, "/admin/security/api/v3/user/whoAmI", "your Flow organisations");
    return (me.organizations || []).map((o) => ({ id: o.id, name: o.name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async function listPackages({ flowFetch, orgId }) {
    const packages = await getJson(flowFetch, `${API}/${orgId}/packages`, "packages");
    return (packages || []).map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A package's assets (or the App Library's, packageId null) for the export picker. */
  async function listPackageAssets({ flowFetch, orgId, packageId }) {
    const assets = await FlowModules.listAssets({ flowFetch, orgId, packageId: packageId || null });
    return assets.map((a) => ({ id: a.id, name: a.name, type: a.type })).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  }

  async function listConnectors({ flowFetch, orgId }) {
    const connectors = await getJson(flowFetch, `/admin/admin-connector/api/organisation/${orgId}/connectors`, "connectors");
    return (connectors || []).map((c) => ({ id: c.id, name: c.name, type: c.type }));
  }

  /** A module's FlowScript at a given version: the designer XML commitModuleCode writes, else the
   *  { name, source } data document. Both GETs are UNVERIFIED (only their POSTs were captured). */
  async function readModuleSource({ flowFetch, orgId, assetId, versionId }) {
    const xmlRes = await flowFetch(`${API}/${orgId}/items/${assetId}/designerXml/${versionId}`);
    if (xmlRes.ok) {
      const xml = await xmlRes.text();
      const match = xml.match(/<Source>([\s\S]*)<\/Source>/);
      if (match) return match[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
    }
    const dataRes = await flowFetch(`${API}/${orgId}/items/${assetId}/data/${versionId}`);
    if (!dataRes.ok) await throwWithResponseBody(dataRes, "Could not read module source");
    const text = await dataRes.text();
    try {
      const body = JSON.parse(text);
      if (body && typeof body.source === "string") return body.source;
    } catch (e) { /* not JSON */ }
    throw new Error("Module source not found in its designer XML or data document.");
  }

  /** Finds asset metadata by id: the flow's package, the App Library, then every other package. */
  function createAssetLocator({ flowFetch, orgId, packageId }) {
    const byId = new Map();
    let searchedAll = false;
    const add = (assets, location) => { for (const a of assets || []) if (!byId.has(a.id)) byId.set(a.id, { ...a, location }); };
    let first = null;
    return async function locate(id) {
      if (!first) {
        first = Promise.all([
          packageId ? FlowModules.listAssets({ flowFetch, orgId, packageId }) : Promise.resolve([]),
          FlowModules.listAssets({ flowFetch, orgId, packageId: null }).catch(() => [])
        ]).then(([pkgAssets, libAssets]) => { add(pkgAssets, "package"); add(libAssets, "library"); });
      }
      await first;
      if (!byId.has(id) && !searchedAll) {
        searchedAll = true;
        for (const p of await listPackages({ flowFetch, orgId }).catch(() => [])) {
          if (p.id === packageId) continue;
          add(await FlowModules.listAssets({ flowFetch, orgId, packageId: p.id }).catch(() => []), "other-package");
          if (byId.has(id)) break;
        }
      }
      return byId.get(id) || null;
    };
  }

  function designerSnapshot(designerData) {
    return {
      assets: designerData.assets || [],
      data: Array.isArray(designerData.data) ? designerData.data : [],
      parameterTypeExpression: designerData.parameterTypeExpression || "{}",
      resultTypeExpression: designerData.resultTypeExpression || "{}",
      isInbox: !!designerData.isInbox,
      hasSuitcase: !!designerData.hasSuitcase,
      architecture: designerData.architecture || "sequential"
    };
  }

  /** Reads the flow `itemId` and, recursively, every asset it references into one package. */
  function exportFlow({ flowFetch, orgId, packageId, itemId, generator, log }) {
    return exportAssets({ flowFetch, orgId, packageId, rootIds: [itemId], generator, log });
  }

  /** Reads the picked assets (flows, modules, a whole package) and, recursively, every asset they
   *  reference into one package. */
  async function exportAssets({ flowFetch, orgId, packageId, rootIds, generator, log }) {
    if (!rootIds || !rootIds.length) throw new Error("Nothing selected to export.");
    const locate = createAssetLocator({ flowFetch, orgId, packageId });
    const assets = {};
    const warnings = [];
    const pending = rootIds.map((id) => ({ id, versionId: null }));
    while (pending.length) {
      const { id, versionId } = pending.shift();
      if (assets[id]) continue;
      const meta = await locate(id);
      if (!meta && !rootIds.includes(id)) {
        warnings.push(`Referenced asset ${id} was not found in this organisation and is left out.`);
        continue;
      }
      const base = {
        id,
        name: meta ? meta.name : "Flow",
        type: meta ? meta.type : "component",
        description: (meta && meta.description) || "",
        color: (meta && meta.color) || null,
        versionId: versionId || (meta && meta.mainBranch ? meta.mainBranch.headVersionId : null)
      };
      if (log) log("Flow export: reading", base.type, base.name);
      if (isModule(base)) {
        assets[id] = { ...base, source: await readModuleSource({ flowFetch, orgId, assetId: id, versionId: base.versionId }) };
        continue;
      }
      const designer = designerSnapshot(await FlowDesignerTab.getDesignerData({ flowFetch, orgId, itemId: id }));
      assets[id] = { ...base, designer };
      for (const ref of designer.assets) pending.push({ id: ref.assetId, versionId: ref.assetVersion });
    }
    const connectors = [...collectConnectors(Object.values(assets).map((a) => a.designer || null)).values()];
    return {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      generator: generator || "NovacuraBuddy",
      source: { orgId, packageId: packageId || null },
      rootId: rootIds[0],
      rootIds: rootIds.slice(),
      assets,
      connectors,
      warnings
    };
  }

  /** What importing `pkg` into orgId/packageId would do: per asset its match in the target and
   *  the allowed choices, per connector its same-name target connector. */
  async function planImport({ flowFetch, pkg, orgId, packageId }) {
    validatePackage(pkg);
    const targetLocation = packageId ? "package" : "library";
    const [packageAssets, libraryAssets, connectors] = await Promise.all([
      packageId ? FlowModules.listAssets({ flowFetch, orgId, packageId }) : Promise.resolve([]),
      FlowModules.listAssets({ flowFetch, orgId, packageId: null }).catch(() => []),
      listConnectors({ flowFetch, orgId }).catch(() => [])
    ]);
    const rootIds = rootIdsOf(pkg);
    const takenNames = new Set();
    const assets = await Promise.all(dependencyOrder(pkg).map(async (id) => {
      const asset = pkg.assets[id];
      const isRoot = rootIds.includes(id) && !isModule(asset);
      const existing = findMatch(asset, packageId ? packageAssets : libraryAssets, packageId ? libraryAssets : []);
      let sameCode = null;
      if (existing && isModule(asset)) {
        sameCode = await readModuleSource({ flowFetch, orgId, assetId: existing.id, versionId: existing.mainBranch.headVersionId })
          .then((code) => code === asset.source)
          .catch(() => null);
      }
      const ifsProjection = isModule(asset) ? ifsProjectionOf(asset.source) : null;
      return {
        id, name: asset.name, type: asset.type, isRoot, ifsProjection,
        existing: existing ? { id: existing.id, name: existing.name, location: existing.location } : null,
        sameCode,
        ...choicesFor({ isRoot, existing, targetLocation, ifs: !!ifsProjection })
      };
    }));
    // Names for exported flows created new: free in the target, and distinct from each other.
    for (const row of assets) if (row.isRoot) row.newName = copyName(row.name, packageId ? packageAssets : libraryAssets, takenNames);
    const firstRoot = assets.find((row) => row.isRoot);
    return {
      assets,
      rootIds,
      rootName: firstRoot ? firstRoot.newName : null,
      connectors: (pkg.connectors || []).map((c) => {
        const match = connectors.find((t) => t.id === c.id) || connectors.find((t) => String(t.name).toUpperCase() === String(c.name).toUpperCase());
        return { source: c, targetId: match ? match.id : null };
      }),
      targetConnectors: connectors
    };
  }

  async function createAsset({ flowFetch, orgId, packageId, asset, name }) {
    const res = await flowFetch(FlowModules.assetsPath(orgId, packageId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name || asset.name,
        description: asset.description || "",
        color: asset.color || (isModule(asset) ? "#4031F8" : "#0A68FF"),
        type: asset.type,
        tagIds: []
      })
    });
    if (!res.ok) await throwWithResponseBody(res, `Could not create ${asset.type} ${name || asset.name}`);
    return res.json();
  }

  /** Imports `pkg` into orgId/packageId. `choices` maps a package asset id to "create" | "update"
   *  | "use" (default: planImport's); `connectorMap` maps a source connector id to a target
   *  connector id or null. Assets go in dependency order so every reference can be remapped to
   *  the target's ids. A flow's save always sends its COMPLETE data (the save replaces the flow's
   *  data), never only changes. Modules are committed; flows are not: the user reviews and commits
   *  them in the Designer. `generateCode(projectionName)` returns fresh module code from the
   *  target's IFS instance; it is required when any choice is "regenerate". */
  async function runImport({ flowFetch, pkg, orgId, packageId, choices, connectorMap, rootName, names, generateCode, log }) {
    const plan = await planImport({ flowFetch, pkg, orgId, packageId });
    for (const row of plan.assets) {
      const choice = (choices && choices[row.id]) || row.choice;
      if (!row.options.includes(choice)) throw new Error(`"${choice}" is not possible for ${row.name} in this target — nothing was changed.`);
      if (choice === "regenerate" && !generateCode) throw new Error(`Pick an IFS instance to generate ${row.name} from — nothing was changed.`);
    }
    const singleRoot = plan.assets.filter((row) => row.isRoot).length === 1;
    const newName = (row) => (names && names[row.id]) || (singleRoot && rootName) || row.newName;
    const targetConnectors = new Map(plan.targetConnectors.map((c) => [c.id, c]));
    const connectorsById = {};
    for (const row of plan.connectors) {
      const chosen = connectorMap && Object.prototype.hasOwnProperty.call(connectorMap, row.source.id) ? connectorMap[row.source.id] : row.targetId;
      connectorsById[row.source.id] = chosen ? targetConnectors.get(chosen) || null : null;
    }

    const idMap = {}; // source asset id / version id -> target's
    const target = {}; // source asset id -> { id, headVersionId }
    const results = [];
    for (const row of plan.assets) {
      const asset = pkg.assets[row.id];
      const choice = (choices && choices[row.id]) || row.choice;
      // Generated before anything is created, so an IFS failure leaves no empty module behind.
      const code = choice === "regenerate" ? await generateCode(row.ifsProjection) : asset.source;
      let assetId;
      if (choice === "use" || choice === "update" || (choice === "regenerate" && row.existing)) {
        assetId = row.existing.id;
      } else {
        const created = await createAsset({ flowFetch, orgId, packageId, asset, name: row.isRoot ? newName(row) : asset.name });
        assetId = created.id;
      }
      // Asset reads/commits go through the asset's own location: an App Library match has no package.
      const assetPackageId = choice !== "create" && row.existing && row.existing.location === "library" ? null : packageId;
      if (log) log("Flow import:", choice, asset.type, asset.name, "->", assetId);

      if (choice !== "use") {
        if (isModule(asset)) {
          await FlowModules.commitModuleCode({ flowFetch, orgId, packageId: assetPackageId, assetId, flowScriptCode: code });
        } else {
          const designerData = await FlowDesignerTab.getDesignerData({ flowFetch, orgId, itemId: assetId });
          const assetsRefs = asset.designer.assets
            .filter((ref) => target[ref.assetId])
            .map((ref) => ({ ...ref, assetId: target[ref.assetId].id, assetVersion: target[ref.assetId].headVersionId }));
          const data = remap(asset.designer.data, idMap, connectorsById);
          // data: [] so the source's full data REPLACES the target's (saveDesignerAssets appends).
          await FlowDesignerTab.saveDesignerAssets({
            flowFetch, orgId, itemId: assetId,
            designerData: { ...asset.designer, eTag: designerData.eTag, data: [] },
            assets: assetsRefs,
            events: data
          });
        }
      }
      const fresh = await FlowModules.getModuleAsset({ flowFetch, orgId, packageId: assetPackageId, assetId });
      const headVersionId = fresh.mainBranch.headVersionId;
      target[row.id] = { id: assetId, headVersionId };
      idMap[row.id] = assetId;
      if (asset.versionId) idMap[asset.versionId] = headVersionId;
      for (const parent of Object.values(pkg.assets)) {
        for (const ref of (parent.designer && parent.designer.assets) || []) if (ref.assetId === row.id && ref.assetVersion) idMap[ref.assetVersion] = headVersionId;
      }
      results.push({ id: row.id, name: row.isRoot && choice === "create" ? newName(row) : asset.name, type: asset.type, choice, targetId: assetId, isRoot: row.isRoot });
    }
    const unmapped = plan.connectors.filter((row) => !connectorsById[row.source.id]).map((row) => row.source.name || row.source.id);
    const firstRoot = plan.assets.find((row) => row.isRoot) || plan.assets.find((row) => plan.rootIds.includes(row.id));
    return { rootId: firstRoot ? target[firstRoot.id].id : null, orgId, results, unmappedConnectors: unmapped };
  }

  const api = {
    FORMAT, FORMAT_VERSION,
    validatePackage, collectConnectors, ifsProjectionOf, remap, dependencyOrder, choicesFor, findMatch, copyName,
    listOrganisations, listPackages, listConnectors, listPackageAssets, readModuleSource, exportFlow, exportAssets, planImport, runImport, rootIdsOf
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.FlowTransfer = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
