(function (global) {
  const FlowConnectRest = typeof require === "function" ? require("./flow-connect-rest.js") : global.FlowConnectRest;
  const { throwWithResponseBody } = FlowConnectRest;

  function escapeXmlText(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // A flow outside any package (Designer packageInfo null) is a global asset; its modules live in
  // the org-level App Library, which is the same endpoint without the /packages/{id} segment —
  // the exact switch Novacura's own HubAPI module makes (getAssets/getAsset/createModule).
  function assetsPath(orgId, packageId) {
    const org = `/admin/application/api/v2/organisations/${orgId}`;
    return packageId ? `${org}/packages/${packageId}/assets` : `${org}/assets`;
  }

  /** One GET of a package's full asset list — the expensive part of finding a module. Callers
   *  checking many projection names in one pass (the side panel refreshing its whole tracked
   *  list) should call this ONCE and match every name against it with `findModuleInList`,
   *  rather than each name re-fetching the same list via `findExistingModule`. */
  async function listAssets({ flowFetch, orgId, packageId }) {
    const res = await flowFetch(assetsPath(orgId, packageId));
    if (!res.ok) await throwWithResponseBody(res, "Could not list assets");
    return (await res.json()) || [];
  }

  function findModuleInList(assets, projectionName) {
    const upper = projectionName.toUpperCase();
    return (assets || []).find((a) => a.type === "module" && a.name.toUpperCase() === upper) || null;
  }

  async function findExistingModule({ flowFetch, orgId, packageId, projectionName }) {
    return findModuleInList(await listAssets({ flowFetch, orgId, packageId }), projectionName);
  }

  async function createModuleAsset({ flowFetch, orgId, packageId, projectionName }) {
    const res = await flowFetch(assetsPath(orgId, packageId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: projectionName,
        description: "Auto generated module.",
        color: "#4031F8",
        type: "module",
        tagIds: []
      })
    });
    if (!res.ok) await throwWithResponseBody(res, "Could not create module");
    return res.json();
  }

  async function findOrCreateModule({ flowFetch, orgId, packageId, projectionName }) {
    const existing = await findExistingModule({ flowFetch, orgId, packageId, projectionName });
    if (existing) return existing;
    return createModuleAsset({ flowFetch, orgId, packageId, projectionName });
  }

  async function getModuleAsset({ flowFetch, orgId, packageId, assetId }) {
    const res = await flowFetch(`${assetsPath(orgId, packageId)}/${assetId}`);
    if (!res.ok) await throwWithResponseBody(res, "Could not load module");
    return res.json();
  }

  async function setModuleDesignerXml({ flowFetch, orgId, assetId, moduleName, versionId, flowScriptCode }) {
    const xml = `<Module><Name>${escapeXmlText(moduleName)}</Name><Source>${escapeXmlText(flowScriptCode)}</Source></Module>`;
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${assetId}/designerXml/${versionId}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "If-Match": "*" },
      body: xml
    });
    if (!res.ok) await throwWithResponseBody(res, "Could not set designer XML");
  }

  async function setModuleTasks({ flowFetch, orgId, assetId, versionId }) {
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${assetId}/tasks/${versionId}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "If-Match": "*" },
      body: '@{"$t":"NovaCura.Flow.Engine.Model.ConnectorTaskCollection","$v":1,"d":{}}'
    });
    if (!res.ok) await throwWithResponseBody(res, "Could not set module tasks");
  }

  async function setModuleData({ flowFetch, orgId, assetId, versionId, moduleName, code }) {
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${assetId}/data/${versionId}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "If-Match": "*" },
      body: JSON.stringify({ name: moduleName, source: code })
    });
    if (!res.ok) await throwWithResponseBody(res, "Could not set module data");
  }

  /** A module's current FlowScript, from the designer XML commitModuleCode writes to the head version.
   *  UNCONFIRMED: GET on the designerXml endpoint (only its POST is captured). */
  async function getModuleSource({ flowFetch, orgId, packageId, assetId }) {
    const asset = await getModuleAsset({ flowFetch, orgId, packageId, assetId });
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${assetId}/designerXml/${asset.mainBranch.headVersionId}`);
    if (!res.ok) await throwWithResponseBody(res, "Could not read module source");
    const xml = await res.text();
    const match = xml.match(/<Source>([\s\S]*)<\/Source>/);
    if (!xml.trim()) return "";
    if (!match) throw new Error("Module designer XML has no <Source> element.");
    return match[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  }

  async function commitModuleCode({ flowFetch, orgId, packageId, assetId, flowScriptCode }) {
    const asset = await getModuleAsset({ flowFetch, orgId, packageId, assetId });
    if (asset.type !== "module") throw new Error("Asset is not a module.");
    const moduleName = asset.name;
    const headVersionId = asset.mainBranch.headVersionId;
    const branchId = asset.mainBranch.id;

    await setModuleDesignerXml({ flowFetch, orgId, assetId, moduleName, versionId: headVersionId, flowScriptCode });
    await setModuleTasks({ flowFetch, orgId, assetId, versionId: headVersionId });
    await setModuleData({ flowFetch, orgId, assetId, versionId: headVersionId, moduleName, code: flowScriptCode });

    const validateRes = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${assetId}/branches/${branchId}/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assets: [] })
    });
    if (!validateRes.ok) await throwWithResponseBody(validateRes, "Branch validation failed");
    const validation = await validateRes.json();

    const updateRes = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${assetId}/branches/${branchId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        headVersionId, parameterType: "{}", resultType: "{}",
        isInbox: false, snapshotToken: validation.snapshot, numberOfErrors: 0
      })
    });
    if (!updateRes.ok) await throwWithResponseBody(updateRes, "Branch update failed");

    const commitRes = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${assetId}/branches/${branchId}/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ headVersionId, commitMessage: "Auto generated version." })
    });
    if (!commitRes.ok) await throwWithResponseBody(commitRes, "Commit failed");
    const newBranch = await commitRes.json();

    await setModuleDesignerXml({ flowFetch, orgId, assetId, moduleName, versionId: newBranch.headVersionId, flowScriptCode });
    return newBranch;
  }

  async function generateModuleCode({ flowFetch, csdlXml, openApiJson, codeGenSubPath, importSourcePath }) {
    const payloadBytes = new TextEncoder().encode(JSON.stringify({ csdlXml, openApiJson, projectionSubPath: codeGenSubPath }));
    const res = await flowFetch("/admin/code-gen/api/v1/flowscript/generate/Queryable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payloadBytes
    });
    if (!res.ok) await throwWithResponseBody(res, "Code generation failed");
    const generatedCode = await res.text();

    const buildRes = await flowFetch("/admin/code-gen/build-number");
    const buildNo = buildRes.ok ? await buildRes.text() : "unknown";

    const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
    const header = `/*\r\n#importSource("${importSourcePath}")\r\nAuto generated code: ${timestamp} (build ${buildNo})\r\n*/\r\n`;
    return header + generatedCode;
  }

  const api = {
    assetsPath, findExistingModule, listAssets, findModuleInList, createModuleAsset, findOrCreateModule,
    getModuleAsset, getModuleSource, commitModuleCode, generateModuleCode
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.FlowModules = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
