(function (global) {
  // The PL/SQL of a Database step of a running flow, for the web client's Diagnostic panel: the
  // client does not carry the step's SQL (and the trace log does not show it), so it is read from
  // the flow's committed designer data. Read-only: only GETs.
  const FlowConnectRest = typeof require === "function" ? require("./flow-connect-rest.js") : global.FlowConnectRest;

  const APP = "/admin/application/api/v2/organisations";
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

  /** "Relocation / Check Location" -> { flow: "Relocation", step: "Check Location", path: [] }; a step inside called
   *  assets ("Flow / Sub flow / Step") keeps the called ones in `path`; a lone name is a flow without a current step. */
  function parseBreadcrumb(text) {
    const parts = String(text || "").split("/").map((p) => p.trim()).filter(Boolean);
    if (!parts.length) return null;
    return parts.length >= 2 ? { flow: parts[0], step: parts[parts.length - 1], path: parts.slice(1, -1) } : { flow: parts[0], step: null, path: [] };
  }

  /** The command text of the step with this name anywhere in designer data (last one wins). */
  function findStepCommand(designer, stepName) {
    const want = norm(stepName);
    let found = null;
    const walk = (o, depth) => {
      if (!o || typeof o !== "object" || depth > 40) return;
      if (Array.isArray(o)) { o.forEach((x) => walk(x, depth + 1)); return; }
      const cmd = o.configuration && o.configuration.command;
      if (typeof o.label === "string" && cmd && typeof cmd.commandText === "string" && norm(o.label) === want) {
        found = { sql: cmd.commandText, commandType: cmd.commandType || null };
      }
      for (const v of Object.values(o)) walk(v, depth + 1);
    };
    walk(designer, 0);
    return found;
  }

  /** A short description of a document's shape, for the lookup details when no step was found in it. */
  function describeShape(body) {
    const keys = (o) => (o && typeof o === "object" ? Object.keys(o).slice(0, 14).join(",") : typeof o);
    if (Array.isArray(body)) return `array(${body.length}) first: ${keys(body[0])}`;
    const parts = [`keys: ${keys(body)}`];
    for (const k of Object.keys(body || {}).slice(0, 14)) {
      const v = body[k];
      if (Array.isArray(v) && v.length) parts.push(`${k}[${v.length}] first: ${keys(v[0])}${v[0] && v[0].configuration ? ` configuration: ${keys(v[0].configuration)}` : ""}`);
    }
    return parts.join("; ").slice(0, 600);
  }

  async function getJson(flowFetch, path) {
    const res = await flowFetch(path);
    if (!res.ok) return { ok: false, status: res.status };
    try { return { ok: true, body: await res.json() }; } catch { return { ok: false, status: res.status, notJson: true }; }
  }

  /** The steps of designer data ({ data: [events] }, or the events themselves) with their final fields:
   *  a step's label and its command can come from different events. */
  function designerSteps(designer) {
    const events = Array.isArray(designer) ? designer : (designer && designer.data) || [];
    const items = new Map();
    for (const e of events) {
      if (!e || typeof e !== "object") continue;
      const id = e.id || e.stepId;
      const type = String(e.type || "");
      if (!id) continue;
      if (/-(deleted|removed)$/.test(type)) { items.delete(id); continue; }
      const prev = items.get(id) || {};
      const cfg = e.configuration && prev.configuration ? { ...prev.configuration, ...e.configuration } : e.configuration || prev.configuration;
      items.set(id, { ...prev, ...e, ...(cfg ? { configuration: cfg } : {}) });
    }
    return [...items.values()];
  }

  /** The asset references (flow's own calls first, then indirect ones, flat) of the product's latest committed
   *  version; `exact` when that is the version the client runs. */
  function versionAssets({ product, appVersion }) {
    const branch = product && product.mainBranch;
    const latest = branch && branch.latestCommitted;
    if (latest && latest.versionInfo && (latest.id === appVersion || !appVersion)) return { refs: orderRefs(latest.versionInfo.assets), exact: true };
    if (latest && latest.versionInfo) return { refs: orderRefs(latest.versionInfo.assets), exact: false };
    return null;
  }
  /** The asset references of one version from the version history ({ data: [{ versionId, assets }] }, newest
   *  first): the record of that version, else the first one. Field names vary: assetId|id, assetVersion|versionId. */
  function historyAssets(history, versionId) {
    const list = Array.isArray(history) ? history : (history && history.data) || [];
    const rec = list.find((v) => v && v.versionId === versionId) || list[0];
    if (!rec || !Array.isArray(rec.assets)) return null;
    return orderRefs(rec.assets.map((a) => a && ({ assetId: a.assetId || a.id, assetVersion: a.assetVersion || a.versionId || a.version, usedIndirectly: !!a.usedIndirectly })));
  }
  const orderRefs = (refs) => {
    const list = (refs || []).filter((r) => r && r.assetId);
    return [...list.filter((r) => !r.usedIndirectly), ...list.filter((r) => r.usedIndirectly)];
  };

  /** Looks up the SQL of Database steps by name for the app the client runs, in the org, package and
   *  environment it runs in (ids from the client's own requests; the app id is the flow's item id):
   *  the committed version the client runs, or on Development, where the client runs the latest saved
   *  version, the flow's current designer data. Then the assets it calls, all read at once.
   *  Returns { steps: { name: { sql, source } }, tried, flowFound }. Steps that are not Database steps are absent. */
  async function resolveSteps({ flowFetch, orgId, packageId, apps = [], flowName = "", stepNames }) {
    const tried = [];
    const steps = {};
    const wanted = [...new Set(stepNames)];
    let app = apps[0];
    if (!app && orgId && packageId && flowName) {
      // The client's requests did not name the flow: find the product by its name in the client's package.
      const list = await getJson(flowFetch, `${APP}/${orgId}/packages/${packageId}/products`);
      const product = list.ok && (Array.isArray(list.body) ? list.body : list.body.data || []).find((p) => norm(p.name) === norm(flowName));
      tried.push(`flow "${flowName}" by name in the package: ${product ? "found" : list.ok ? "not found" : list.status}`);
      if (product) app = { app: product.id, version: product.mainBranch && product.mainBranch.latestCommitted ? product.mainBranch.latestCommitted.id : null };
    }
    if (!orgId || !app) {
      tried.push(`The client's org or app is not known (org ${orgId || "-"}, app ${app ? app.app : "-"}). Run the flow once more and press again.`);
      return { steps, tried, flowFound: false };
    }
    const item = (id) => `${APP}/${orgId}/items/${id}`;
    // The flow itself: the committed version the client runs, else (Development) the latest saved one.
    let flow = await getJson(flowFetch, `${item(app.app)}/versions/${app.version}/committed`);
    let flowLabel = "committed version the client runs";
    tried.push(`flow ${app.app} version ${app.version} (committed): ${flow.ok ? "ok" : flow.status}`);
    let refs = null;
    if (flow.ok) {
      // The version's own record in the version history lists the asset versions it uses.
      const h = await getJson(flowFetch, `/admin/version/api/v2/organization/${orgId}/item/${app.app}/version/${app.version}?max=1`);
      refs = h.ok ? historyAssets(h.body, app.version) : null;
      tried.push(`called assets from the version history: ${!h.ok ? h.status : refs ? refs.length : "none listed"}`);
      if (!refs && packageId) {
        const p = await getJson(flowFetch, `${APP}/${orgId}/packages/${packageId}/products/${app.app}`);
        const v = p.ok ? versionAssets({ product: p.body, appVersion: app.version }) : null;
        refs = v && v.refs;
        tried.push(`called assets: ${!p.ok ? "product " + p.status : !v ? "none listed" : v.exact ? "from this version" : "from the latest committed version (an older version runs here)"}`);
      }
    } else {
      flow = await getJson(flowFetch, `${item(app.app)}/designer`);
      flowLabel = "latest saved version (Development)";
      tried.push(`flow ${app.app} latest saved version: ${flow.ok ? "ok" : flow.status}`);
      if (!flow.ok) return { steps, tried, flowFound: false };
      refs = orderRefs(flow.body.assets);
    }
    const docs = [{ id: app.app, label: `flow (${flowLabel})`, body: flow.body }];
    // Called assets (any depth: indirect ones are listed flat): the version the flow uses, else the latest saved one.
    const read = async (ref) => {
      const c = await getJson(flowFetch, `${item(ref.assetId)}/versions/${ref.assetVersion}/committed`);
      if (c.ok) return { id: ref.assetId, label: `called asset ${ref.assetId}`, body: c.body };
      const d = await getJson(flowFetch, `${item(ref.assetId)}/designer`);
      if (d.ok) return { id: ref.assetId, label: `called asset ${ref.assetId} (latest saved)`, body: d.body };
      tried.push(`called asset ${ref.assetId}: ${c.status} / ${d.status}`);
      return null;
    };
    const calls = (refs || []).filter((r) => r.assetId !== app.app).slice(0, 60);
    docs.push(...(await Promise.all(calls.map(read))).filter(Boolean));
    let databaseSteps = 0;
    for (const doc of docs) {
      for (const st of designerSteps(doc.body)) {
        const cmd = st.configuration && st.configuration.command;
        if (!cmd || typeof cmd.commandText !== "string" || typeof st.label !== "string") continue;
        databaseSteps++;
        const name = wanted.find((n) => norm(n) === norm(st.label));
        if (name && !steps[name]) steps[name] = { sql: cmd.commandText, commandType: cmd.commandType || null, source: doc.label };
      }
    }
    tried.push(`read the flow and ${docs.length - 1} of ${calls.length} called asset(s): ${databaseSteps} Database step(s), matched ${Object.keys(steps).length} of ${wanted.length} logged step(s)`);
    if (!databaseSteps) tried.push(`  flow data: ${describeShape(flow.body)}`);
    return { steps, tried, flowFound: true };
  }

  const api = { parseBreadcrumb, findStepCommand, designerSteps, versionAssets, historyAssets, resolveSteps };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.FlowStepSql = api;
})(typeof window !== "undefined" ? window : globalThis);
