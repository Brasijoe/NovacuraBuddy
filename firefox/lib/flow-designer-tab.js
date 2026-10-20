(function (global) {
  const FlowConnectRest = typeof require === "function" ? require("./flow-connect-rest.js") : global.FlowConnectRest;
  const { throwWithResponseBody } = FlowConnectRest;

  const DESIGNER_URL_RE = /\/admin\/design\/designer\/organizations\/([^/]+)\/items\/([^/?#]+)/;

  function parseDesignerTabUrl(url) {
    const m = DESIGNER_URL_RE.exec(String(url || ""));
    if (!m) return null;
    return { orgId: m[1], itemId: m[2] };
  }

  // The Designer's own by-id read carries `packageInfo` — one call instead of searching every
  // package's listings, and the only way to recognize a package-less (global) item, which appears
  // in no listing. Returns the package id, or null for a global item.
  async function resolvePackageId({ flowFetch, orgId, itemId }) {
    const designerData = await getDesignerData({ flowFetch, orgId, itemId });
    const info = designerData.packageInfo;
    if (info == null) return null;
    const packageId = info.id || info.packageId;
    if (!packageId) {
      throw new Error(`The open flow's packageInfo has no package id (fields: ${Object.keys(info).join(", ") || "none"}).`);
    }
    return packageId;
  }

  async function getDesignerData({ flowFetch, orgId, itemId }) {
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${itemId}/designer`);
    if (!res.ok) await throwWithResponseBody(res, "Could not load designer data");
    const body = await res.json();
    // The save lock (If-Match) is the `etag` RESPONSE HEADER — that's what the Designer itself
    // sends back (captured live 2026-10-16). The body's eTag field is the fallback.
    const headerETag = res.headers && typeof res.headers.get === "function" ? res.headers.get("etag") : null;
    return { ...body, eTag: headerETag || body.eTag };
  }

  // Shape and key order of the Designer's own assets[] entry (captured live 2026-10-16).
  function buildAssetRef({ assetId, headVersionId }) {
    return { assetId, assetVersion: headVersionId, usedIndirectly: false, offeredParameterType: "any", requiredResultType: "any" };
  }

  function patchAssetsList(existingAssets, ref) {
    const idx = (existingAssets || []).findIndex((a) => a.assetId === ref.assetId);
    if (idx === -1) {
      return { assets: [...(existingAssets || []), ref], changed: true, added: true };
    }
    if (existingAssets[idx].assetVersion === ref.assetVersion) {
      return { assets: existingAssets, changed: false, added: false };
    }
    const next = existingAssets.slice();
    next[idx] = { ...existingAssets[idx], assetVersion: ref.assetVersion };
    return { assets: next, changed: true, added: false };
  }

  function computeModuleStatus(moduleAsset, flowAssets) {
    if (!moduleAsset) return "not_created";
    const ref = (flowAssets || []).find((a) => a.assetId === moduleAsset.id);
    if (!ref) return "created";
    return ref.assetVersion === moduleAsset.mainBranch.headVersionId ? "activated" : "activated_stale";
  }

  /** Adds (or re-versions) a module in a flow exactly the way the Designer does it — captured live
   *  2026-10-16: POST .../designer with `If-Match: <etag header>`, the full assets[] list, and in
   *  `data` ONLY the new events (the server appends them to the flow's event log — sending the
   *  whole log back would duplicate every step). Adding a module is one
   *  { type: "module-added", name, moduleId } event. No commit: the Designer doesn't commit on
   *  adding a module either, and committing would also commit the user's unfinished changes. */
  async function activateModule({ flowFetch, orgId, itemId, assetId, headVersionId, moduleName }) {
    const designerData = await getDesignerData({ flowFetch, orgId, itemId });
    const ref = buildAssetRef({ assetId, headVersionId });
    const { assets, changed, added } = patchAssetsList(designerData.assets, ref);
    if (!changed) return;

    const payload = {
      assets,
      parameterTypeExpression: designerData.parameterTypeExpression || "{}",
      resultTypeExpression: designerData.resultTypeExpression || "{}",
      errors: 0, // the Designer sends its own live validation count here; we can't compute it
      isInbox: !!designerData.isInbox,
      hasSuitcase: !!designerData.hasSuitcase,
      architecture: designerData.architecture || "sequential",
      // A version bump of an already-added module carries no event — UNVERIFIED, only the
      // first-time add was captured.
      data: added ? [{ type: "module-added", name: moduleName, moduleId: assetId }] : []
    };
    const postRes = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${itemId}/designer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(designerData.eTag ? { "If-Match": designerData.eTag } : {}) },
      body: JSON.stringify(payload)
    });
    if (!postRes.ok) await throwWithResponseBody(postRes, "Could not save designer data");
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
