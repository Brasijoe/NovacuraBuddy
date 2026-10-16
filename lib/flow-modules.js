(function (global) {
  function escapeXmlText(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  async function findExistingModule({ flowFetch, orgId, packageId, projectionName }) {
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/packages/${packageId}/assets`);
    if (!res.ok) throw new Error(`Could not list assets (${res.status})`);
    const assets = await res.json();
    const upper = projectionName.toUpperCase();
    return (assets || []).find((a) => a.type === "module" && a.name.toUpperCase() === upper) || null;
  }

  async function createModuleAsset({ flowFetch, orgId, packageId, projectionName }) {
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/packages/${packageId}/assets`, {
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
    if (!res.ok) throw new Error(`Could not create module (${res.status})`);
    return res.json();
  }

  async function findOrCreateModule({ flowFetch, orgId, packageId, projectionName }) {
    const existing = await findExistingModule({ flowFetch, orgId, packageId, projectionName });
    if (existing) return existing;
    return createModuleAsset({ flowFetch, orgId, packageId, projectionName });
  }

  async function getModuleAsset({ flowFetch, orgId, packageId, assetId }) {
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/packages/${packageId}/assets/${assetId}`);
    if (!res.ok) throw new Error(`Could not load module (${res.status})`);
    return res.json();
  }

  async function setModuleDesignerXml({ flowFetch, orgId, assetId, moduleName, versionId, flowScriptCode }) {
    const xml = `<Module><Name>${escapeXmlText(moduleName)}</Name><Source>${escapeXmlText(flowScriptCode)}</Source></Module>`;
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${assetId}/designerXml/${versionId}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "If-Match": "*" },
      body: xml
    });
    if (!res.ok) throw new Error(`Could not set designer XML (${res.status})`);
  }

  async function setModuleTasks({ flowFetch, orgId, assetId, versionId }) {
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${assetId}/tasks/${versionId}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "If-Match": "*" },
      body: '@{"$t":"NovaCura.Flow.Engine.Model.ConnectorTaskCollection","$v":1,"d":{}}'
    });
    if (!res.ok) throw new Error(`Could not set module tasks (${res.status})`);
  }

  async function setModuleData({ flowFetch, orgId, assetId, versionId, moduleName, code }) {
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${assetId}/data/${versionId}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "If-Match": "*" },
      body: JSON.stringify({ name: moduleName, source: code })
    });
    if (!res.ok) throw new Error(`Could not set module data (${res.status})`);
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
    if (!validateRes.ok) throw new Error(`Branch validation failed (${validateRes.status})`);
    const validation = await validateRes.json();

    const updateRes = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${assetId}/branches/${branchId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        headVersionId, parameterType: "{}", resultType: "{}",
        isInbox: false, snapshotToken: validation.snapshot, numberOfErrors: 0
      })
    });
    if (!updateRes.ok) throw new Error(`Branch update failed (${updateRes.status})`);

    const commitRes = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${assetId}/branches/${branchId}/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ headVersionId, commitMessage: "Auto generated version." })
    });
    if (!commitRes.ok) throw new Error(`Commit failed (${commitRes.status})`);
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
    if (!res.ok) throw new Error(`Code generation failed (${res.status})`);
    const generatedCode = await res.text();

    const buildRes = await flowFetch("/admin/code-gen/build-number");
    const buildNo = buildRes.ok ? await buildRes.text() : "unknown";

    const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
    const header = `/*\r\n#importSource("${importSourcePath}")\r\nAuto generated code: ${timestamp} (build ${buildNo})\r\n*/\r\n`;
    return header + generatedCode;
  }

  const api = { findExistingModule, createModuleAsset, findOrCreateModule, getModuleAsset, commitModuleCode, generateModuleCode };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.FlowModules = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
