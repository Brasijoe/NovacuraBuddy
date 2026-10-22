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
    // No "update available" state: Flow updates a flow's assets to their latest version on
    // refresh (user, 2026-10-20), so any reference counts as active.
    return ref ? "activated" : "created";
  }

  /** Saves a flow's module list: POST .../designer with `If-Match: <etag header>`, the full
   *  assets[] list, and in `data` the flow's FULL existing data followed by the new events. The
   *  save replaces the flow's data — sending only the new events wiped every step (user,
   *  2026-10-21; this overrides the 2026-10-16 capture that read it as append-only). No commit:
   *  the Designer doesn't commit module changes either, and committing would also commit the
   *  user's unfinished changes. Activate and deactivate both save through here. */
  async function saveDesignerAssets({ flowFetch, orgId, itemId, designerData, assets, events }) {
    const payload = {
      assets,
      parameterTypeExpression: designerData.parameterTypeExpression || "{}",
      resultTypeExpression: designerData.resultTypeExpression || "{}",
      errors: 0, // the Designer sends its own live validation count here; we can't compute it
      isInbox: !!designerData.isInbox,
      hasSuitcase: !!designerData.hasSuitcase,
      architecture: designerData.architecture || "sequential",
      data: [...(Array.isArray(designerData.data) ? designerData.data : []), ...events]
    };
    const postRes = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${itemId}/designer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(designerData.eTag ? { "If-Match": designerData.eTag } : {}) },
      body: JSON.stringify(payload)
    });
    if (!postRes.ok) await throwWithResponseBody(postRes, "Could not save designer data");
  }

  /** Commits a flow's head version as a new version, with the same validate → branch update →
   *  commit sequence commitModuleCode runs for modules (UNVERIFIED for flows: only the module
   *  sequence was captured live). `branch` is the asset's mainBranch { id, headVersionId };
   *  `designerData` is what was just saved (its type expressions and assets[]). Returns the new
   *  mainBranch. Import/Export and linked copies commit right away (user, 2026-10-22). */
  async function commitFlow({ flowFetch, orgId, itemId, branch, designerData, message }) {
    const base = `/admin/application/api/v2/organisations/${orgId}/items/${itemId}/branches/${branch.id}`;
    const validateRes = await flowFetch(`${base}/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assets: designerData.assets || [] })
    });
    if (!validateRes.ok) await throwWithResponseBody(validateRes, "Flow validation failed");
    const validation = await validateRes.json();

    const updateRes = await flowFetch(base, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        headVersionId: branch.headVersionId,
        parameterType: designerData.parameterTypeExpression || "{}",
        resultType: designerData.resultTypeExpression || "{}",
        isInbox: !!designerData.isInbox, snapshotToken: validation.snapshot, numberOfErrors: 0
      })
    });
    if (!updateRes.ok) await throwWithResponseBody(updateRes, "Flow branch update failed");

    const commitRes = await flowFetch(`${base}/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ headVersionId: branch.headVersionId, commitMessage: message || "Auto generated version." })
    });
    if (!commitRes.ok) await throwWithResponseBody(commitRes, "Flow commit failed");
    return commitRes.json();
  }

  /** Adds (or re-versions) a module in a flow. Adding is one { type: "module-added", name,
   *  moduleId } event (captured live); a version bump of an already-added module carries no
   *  event — UNVERIFIED, only the first-time add was captured. */
  async function activateModule({ flowFetch, orgId, itemId, assetId, headVersionId, moduleName }) {
    const designerData = await getDesignerData({ flowFetch, orgId, itemId });
    const ref = buildAssetRef({ assetId, headVersionId });
    const { assets, changed, added } = patchAssetsList(designerData.assets, ref);
    if (!changed) return;
    const events = added ? [{ type: "module-added", name: moduleName, moduleId: assetId }] : [];
    await saveDesignerAssets({ flowFetch, orgId, itemId, designerData, assets, events });
  }

  /** Takes a module out of a flow the way the Designer does (captured live 2026-10-20): the module
   *  leaves assets[] and `data` carries one { type: "module-removed", moduleId } event. */
  async function deactivateModule({ flowFetch, orgId, itemId, assetId }) {
    const designerData = await getDesignerData({ flowFetch, orgId, itemId });
    const existing = designerData.assets || [];
    const assets = existing.filter((a) => a.assetId !== assetId);
    if (assets.length === existing.length) return;
    await saveDesignerAssets({ flowFetch, orgId, itemId, designerData, assets, events: [{ type: "module-removed", moduleId: assetId }] });
  }

  const api = {
    parseDesignerTabUrl, resolvePackageId, getDesignerData, buildAssetRef,
    patchAssetsList, computeModuleStatus, saveDesignerAssets, commitFlow, activateModule, deactivateModule
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.FlowDesignerTab = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
