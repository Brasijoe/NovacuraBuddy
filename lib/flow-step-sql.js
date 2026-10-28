(function (global) {
  // The PL/SQL of a Database step of a running flow, for the web client's Diagnostic panel: the
  // client does not carry the step's SQL (and the trace log does not show it), so it is read from
  // the flow's committed designer data. Read-only: only GETs.
  const FlowConnectRest = typeof require === "function" ? require("./flow-connect-rest.js") : global.FlowConnectRest;
  const FlowModules = typeof require === "function" ? require("./flow-modules.js") : global.FlowModules;
  const FlowTransfer = typeof require === "function" ? require("./flow-transfer.js") : global.FlowTransfer;

  const APP = "/admin/application/api/v2/organisations";
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

  /** "Relocation / Check Location" -> { flow: "Relocation", step: "Check Location" }; a step inside called
   *  assets ("Flow / Sub flow / Step") keeps the called ones in `path`. */
  function parseBreadcrumb(text) {
    const parts = String(text || "").split("/").map((p) => p.trim()).filter(Boolean);
    return parts.length >= 2 ? { flow: parts[0], step: parts[parts.length - 1], path: parts.slice(1, -1) } : null;
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

  async function getJson(flowFetch, path) {
    const res = await flowFetch(path);
    if (!res.ok) return { ok: false, status: res.status };
    try { return { ok: true, body: await res.json() }; } catch { return { ok: false, status: res.status, notJson: true }; }
  }

  /** The version of a flow that runs in an environment (by name, id or type, e.g. "Development" / "dev"):
   *  from the version history (newest first, each version lists the environments it is deployed to),
   *  else null. envName "" matches nothing. */
  function versionForEnvironment(history, envName) {
    const want = norm(envName);
    if (!want) return null;
    for (const v of (history && history.data) || []) {
      const envs = Array.isArray(v.environments) ? v.environments : [];
      if (envs.some((e) => [e && e.name, e && e.id, e && e.type, e && e.typeName].some((x) => x !== undefined && x !== null && norm(x) === want))) return v.versionId;
    }
    return null;
  }

  /** From the package's deployment overview ({ products: [{ id, mainBranch: { latestCommitted: { id } } }],
   *  environments: [{ environmentId, environmentName, environmentType, deployments: [{ productId, productVersionId }] }] }):
   *  { latest: latest committed version, deployed: version running in the environment (by name, else a unique type),
   *    inEnvironment: whether the environment is listed }. */
  function overviewVersions(overview, flowId, env) {
    const product = ((overview && overview.products) || []).find((p) => p.id === flowId);
    const latest = (product && product.mainBranch && product.mainBranch.latestCommitted && product.mainBranch.latestCommitted.id) || null;
    const envs = (overview && overview.environments) || [];
    const byName = envs.filter((e) => [e.environmentName, e.environmentId].some((x) => x && env && norm(x) === norm(env.name)));
    const byType = envs.filter((e) => env && env.type && norm(e.environmentType) === norm(env.type));
    const found = byName[0] || (byType.length === 1 ? byType[0] : null);
    const dep = found && (found.deployments || []).find((d) => d.productId === flowId);
    const refs = (list) => (list || []).filter((r) => r && r.assetId && r.assetVersion).map((r) => ({ assetId: r.assetId, assetVersion: r.assetVersion }));
    const latestAssets = refs(product && product.mainBranch && product.mainBranch.latestCommitted && product.mainBranch.latestCommitted.versionInfo && product.mainBranch.latestCommitted.versionInfo.assets);
    return { latest, deployed: dep ? dep.productVersionId : null, inEnvironment: !!found, latestAssets, deployedAssets: dep ? refs(dep.assets) : [] };
  }

  const isDevelopment = (env) => /^dev(elopment)?$/i.test(String(env && env.type || "").trim()) || /^dev(elopment)?$/i.test(String(env && env.name || "").trim());

  /** Looks up the step's SQL: first the exact version the client runs (ids from its own requests),
   *  then the flow found by name in the organisations' packages (committed head version).
   *  Returns { sql, source } or { error, tried }. */
  async function resolveStepSql({ flowFetch, flowName, stepName, versions = [], envName = "", envType = "" }) {
    const tried = [];
    const orgs = await FlowTransfer.listOrganisations({ flowFetch });
    const check = async (label, path) => {
      const r = await getJson(flowFetch, path);
      tried.push(`${label}: ${r.ok ? "ok" : r.status + (r.notJson ? " (not JSON)" : "")}`);
      if (!r.ok) return null;
      const hit = findStepCommand(r.body, stepName);
      return hit ? { ...hit, source: label } : { notFound: true };
    };
    let sawFlow = false;
    for (const org of orgs) {
      for (const v of versions) {
        const hit = await check(`deployed version in ${org.name}`, `${APP}/${org.id}/items/${v.app}/versions/${v.version}/committed`);
        if (hit && hit.sql !== undefined) return hit;
        if (hit) sawFlow = true;
      }
      const lists = [{ id: null, name: "App Library" }, ...(await FlowTransfer.listPackages({ flowFetch, orgId: org.id }).catch(() => []))];
      for (const pkg of lists) {
        const assets = await FlowModules.listAssets({ flowFetch, orgId: org.id, packageId: pkg.id }).catch(() => []);
        for (const a of assets) {
          if (!/^(application|automation|workflow|page)$/i.test(a.type || "") || norm(a.name) !== norm(flowName)) continue;
          const head = a.mainBranch && a.mainBranch.headVersionId;
          if (!head) continue;
          let version = head, label = `latest committed version of "${a.name}" (${pkg.name}, ${org.name})`;
          const env = { name: envName, type: envType };
          const wanted = envName || envType;
          let overview = null;
          if (pkg.id) {
            const o = await getJson(flowFetch, `${APP}/${org.id}/packages/${pkg.id}/deploymentoverview`);
            tried.push(`deployment overview of ${pkg.name}: ${o.ok ? "ok" : o.status}`);
            if (o.ok) overview = overviewVersions(o.body, a.id, env);
          }
          if (overview && overview.latest) { version = overview.latest; label = `latest committed version of "${a.name}" (${pkg.name}, ${org.name})`; }
          if (wanted && !isDevelopment(env)) { // Development always runs the latest version; the others the deployed one
            let deployed = overview && overview.deployed;
            if (!deployed && !(overview && overview.inEnvironment)) {
              const history = await getJson(flowFetch, `/admin/version/api/v2/organization/${org.id}/item/${a.id}/version/${head}?max=30`);
              tried.push(`version history of "${a.name}": ${history.ok ? "ok" : history.status}`);
              deployed = history.ok ? versionForEnvironment(history.body, wanted) : null;
            }
            if (deployed) { version = deployed; label = `version of "${a.name}" deployed to ${wanted} (${org.name})`; }
            else tried.push(`"${a.name}" is not deployed to ${wanted}: using the latest committed version`);
          }
          const hit = await check(label, `${APP}/${org.id}/items/${a.id}/versions/${version}/committed`);
          if (hit && hit.sql !== undefined) return hit;
          if (hit) {
            sawFlow = true;
            // The step may belong to an asset the flow calls (flows, components; several levels deep are
            // listed flat in the version's asset references): search those at the versions the flow uses.
            const useDeployed = version !== (overview && overview.latest) && overview && overview.deployedAssets.length;
            const refs = (overview ? (useDeployed ? overview.deployedAssets : overview.latestAssets) : []).slice(0, 60);
            for (const ref of refs) {
              const sub = await check(`called asset ${ref.assetId} (${label})`, `${APP}/${org.id}/items/${ref.assetId}/versions/${ref.assetVersion}/committed`);
              if (sub && sub.sql !== undefined) return sub;
            }
          }
        }
      }
    }
    return sawFlow ? { error: "That step is not a Database step with a command.", notDatabase: true, tried } : { error: "The flow's SQL could not be found (the flow's designer data could not be read).", tried };
  }

  const api = { parseBreadcrumb, findStepCommand, versionForEnvironment, overviewVersions, resolveStepSql };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.FlowStepSql = api;
})(typeof window !== "undefined" ? window : globalThis);
