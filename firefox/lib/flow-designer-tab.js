(function (global) {
  const FlowConnectRest = typeof require === "function" ? require("./flow-connect-rest.js") : global.FlowConnectRest;
  const { throwWithResponseBody } = FlowConnectRest;

  const DESIGNER_URL_RE = /\/admin\/design\/designer\/organizations\/([^/]+)\/items\/([^/?#]+)/;

  function parseDesignerTabUrl(url) {
    const m = DESIGNER_URL_RE.exec(String(url || ""));
    if (!m) return null;
    return { orgId: m[1], itemId: m[2] };
  }

  async function resolvePackageId({ flowFetch, orgId, itemId }) {
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/packages`);
    if (!res.ok) await throwWithResponseBody(res, "Could not list packages");
    const packages = await res.json();

    for (const pkg of packages) {
      for (const kind of ["assets", "products"]) {
        const listRes = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/packages/${pkg.id}/${kind}`);
        if (!listRes.ok) continue;
        const items = await listRes.json();
        if ((items || []).some((item) => item.id === itemId)) return pkg.id;
      }
    }
    return null;
  }

  async function getDesignerData({ flowFetch, orgId, itemId }) {
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${itemId}/designer`);
    if (!res.ok) await throwWithResponseBody(res, "Could not load designer data");
    return res.json();
  }

  function buildAssetRef({ assetId, headVersionId }) {
    return { assetId, assetVersion: headVersionId, offeredParameterType: "{}" };
  }

  function patchAssetsList(existingAssets, ref) {
    const idx = (existingAssets || []).findIndex((a) => a.assetId === ref.assetId);
    if (idx === -1) {
      return { assets: [...(existingAssets || []), ref], changed: true };
    }
    const current = existingAssets[idx];
    if (current.assetVersion === ref.assetVersion && current.offeredParameterType === ref.offeredParameterType) {
      return { assets: existingAssets, changed: false };
    }
    const next = existingAssets.slice();
    next[idx] = ref;
    return { assets: next, changed: true };
  }

  function computeModuleStatus(moduleAsset, flowAssets) {
    if (!moduleAsset) return "not_created";
    const ref = (flowAssets || []).find((a) => a.assetId === moduleAsset.id);
    if (!ref) return "created";
    return ref.assetVersion === moduleAsset.mainBranch.headVersionId ? "activated" : "activated_stale";
  }

  async function activateModule({ flowFetch, orgId, itemId, assetId, headVersionId }) {
    const designerData = await getDesignerData({ flowFetch, orgId, itemId });
    const ref = buildAssetRef({ assetId, headVersionId });
    const { assets, changed } = patchAssetsList(designerData.assets, ref);
    if (!changed) return;

    const payload = {
      assets,
      parameterTypeExpression: designerData.parameterTypeExpression || "{}",
      resultTypeExpression: designerData.resultTypeExpression || "{}",
      errors: 0,
      isInbox: !!designerData.isInbox,
      hasSuitcase: !!designerData.hasSuitcase,
      architecture: designerData.architecture || "sequential",
      data: designerData.data
    };
    const postRes = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${itemId}/designer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!postRes.ok) await throwWithResponseBody(postRes, "Could not save designer data");

    const commitRes = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${itemId}/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Activated by IFS Projection Tracker", eTag: designerData.eTag })
    });
    if (!commitRes.ok) await throwWithResponseBody(commitRes, "Could not commit activation");
  }

  const api = {
    parseDesignerTabUrl, resolvePackageId, getDesignerData, buildAssetRef,
    patchAssetsList, computeModuleStatus, activateModule
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.FlowDesignerTab = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
