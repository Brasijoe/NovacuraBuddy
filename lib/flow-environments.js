/* ============================================================
   Flow Environments — the environments an organisation deploys flow
   versions to, for "deploy after sync" in the Linked Flows tab.

   From the Flow Connect swagger specs (read 2026-10-22, not yet tried
   live):
     GET  /admin/security/api/v3/environment/organization/{org}
          -> [{ id, name, type (0 dev, 1 test, 2 prod, -1 unknown), typeName, kind, accessType, order }]
     POST /admin/application/api/v2/organisations/{org}/packages/{pkg}/assets/{asset}/status
          body { environments: [EnvLite] } -> [{ productId, environments: [EnvLite] }]
     POST /admin/application/api/v2/organisations/{org}/packages/{pkg}/products/{flow}/versions/{version}/environments/{env}/deploy
          body { assets: [{ assetId, assetVersion, usedIndirectly }] } -> DeployResult
          ("creates a new release for the environment containing the product version, then deploys")
   A product is a flow of the package; its version is the committed
   head version, and `assets` are that version's designer references.
   ============================================================ */
(function (global) {
  const FlowConnectRest = typeof require === "function" ? require("./flow-connect-rest.js") : global.FlowConnectRest;
  const FlowDesignerTab = typeof require === "function" ? require("./flow-designer-tab.js") : global.FlowDesignerTab;
  const { throwWithResponseBody } = FlowConnectRest;

  const APP = "/admin/application/api/v2/organisations";
  const TYPE_NAMES = { 0: "dev", 1: "test", 2: "prod", "-1": "unknown" };

  const typeOf = (e) => (typeof e.type === "number" ? TYPE_NAMES[e.type] || "unknown" : String(e.type || e.typeName || "unknown").toLowerCase());

  /** Production by type, or by a name such as PROD, Production or ACME-PRD when the type is unknown. */
  const isProduction = (env) => typeOf(env) === "prod" || /(^|[^a-z])(prod|production|prd|live)([^a-z]|$)/i.test(String(env.name || ""));

  function normalizeEnvironments(body) {
    const list = Array.isArray(body) ? body : (body && (body.items || body.environments)) || [];
    return list
      .filter((e) => e && e.id)
      .map((e) => ({
        id: String(e.id), name: String(e.name || e.typeName || "Environment"), type: typeOf(e),
        kind: e.kind || "Cloud", accessType: e.accessType || "Authorized", order: Number(e.order) || 0,
        isProduction: isProduction(e)
      }))
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  }

  // The application API's EnvLite: the type as its string enum.
  const envLite = (e) => ({ id: e.id, name: e.name, type: e.type, kind: e.kind, accessType: e.accessType, order: e.order });

  async function listEnvironments({ flowFetch, orgId }) {
    const res = await flowFetch(`/admin/security/api/v3/environment/organization/${orgId}`);
    if (!res.ok) await throwWithResponseBody(res, "Could not list the environments");
    return normalizeEnvironments(await res.json());
  }

  /** Ids of the environments where the flow `assetId` is deployed as a product of its package. */
  async function deployedIn({ flowFetch, orgId, packageId, assetId, environments }) {
    if (!packageId || !environments.length) return [];
    const res = await flowFetch(`${APP}/${orgId}/packages/${packageId}/assets/${assetId}/status`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ environments: environments.map(envLite) })
    });
    if (!res.ok) return [];
    const body = await res.json().catch(() => []);
    const own = (Array.isArray(body) ? body : []).find((p) => p.productId === assetId);
    return own ? (own.environments || []).map((e) => String(e.id)) : [];
  }

  /** Deploys the committed head version of each flow ({ id, packageId, headVersionId }) to
   *  environment `envId`: [{ id, ok, error }]. App Library flows have no package to deploy from. */
  async function deploy({ flowFetch, orgId, envId, flows }) {
    const results = [];
    for (const flow of flows) {
      try {
        if (!flow.packageId) throw new Error("App Library flows are deployed with the package that uses them.");
        if (!flow.headVersionId) throw new Error("No committed version to deploy.");
        const designer = await FlowDesignerTab.getDesignerData({ flowFetch, orgId, itemId: flow.id });
        const assets = (designer.assets || []).map((r) => ({ assetId: r.assetId, assetVersion: r.assetVersion, usedIndirectly: !!r.usedIndirectly }));
        const url = `${APP}/${orgId}/packages/${flow.packageId}/products/${flow.id}/versions/${flow.headVersionId}/environments/${envId}/deploy`;
        const res = await flowFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assets }) });
        if (!res.ok) await throwWithResponseBody(res, "Deploy failed");
        results.push({ id: flow.id, ok: true });
      } catch (e) {
        results.push({ id: flow.id, ok: false, error: e.message });
      }
    }
    return results;
  }

  const api = { listEnvironments, deployedIn, deploy, isProduction, normalizeEnvironments };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.FlowEnvironments = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
