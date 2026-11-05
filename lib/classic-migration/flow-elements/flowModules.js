async function throwWithResponseBody(res, message) {
  const text = await res.text().catch(() => "");
  throw new Error(`${message} (${res.status})${text ? ": " + text : ""}`);
}
async function findExistingModule(rest, orgId, packageId, name) {
  const res = await rest.get(`/admin/application/api/v2/organisations/${orgId}/packages/${packageId}/assets`);
  if (!res.ok) await throwWithResponseBody(res, "Could not list assets");
  const assets = await res.json();
  const upperName = name.toUpperCase();
  return assets.find((a) => a.type === "module" && a.name.toUpperCase() === upperName) ?? null;
}
async function createModuleAsset(rest, orgId, packageId, name) {
  const res = await rest.post(`/admin/application/api/v2/organisations/${orgId}/packages/${packageId}/assets`, {
    name,
    description: "Auto generated module.",
    color: "#4031F8",
    type: "module",
    tagIds: []
  });
  if (!res.ok) await throwWithResponseBody(res, "Could not create module");
  return res.json();
}
async function getModuleAsset(rest, orgId, packageId, assetId) {
  const res = await rest.get(`/admin/application/api/v2/organisations/${orgId}/packages/${packageId}/assets/${assetId}`);
  if (!res.ok) await throwWithResponseBody(res, "Could not load module");
  return res.json();
}
function escapeXmlText(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
const TEXT_PLAIN_IF_MATCH = { "Content-Type": "text/plain", "If-Match": "*" };
async function setModuleDesignerXml(rest, orgId, assetId, moduleName, versionId, flowScriptCode) {
  const xml = `<Module><Name>${escapeXmlText(moduleName)}</Name><Source>${escapeXmlText(flowScriptCode)}</Source></Module>`;
  const res = await rest.postRaw(
    `/admin/application/api/v2/organisations/${orgId}/items/${assetId}/designerXml/${versionId}`,
    xml,
    TEXT_PLAIN_IF_MATCH
  );
  if (!res.ok) await throwWithResponseBody(res, "Could not set module designer XML");
}
async function setModuleTasks(rest, orgId, assetId, versionId) {
  const tasks = '@{"$t":"NovaCura.Flow.Engine.Model.ConnectorTaskCollection","$v":1,"d":{}}';
  const res = await rest.postRaw(
    `/admin/application/api/v2/organisations/${orgId}/items/${assetId}/tasks/${versionId}`,
    tasks,
    TEXT_PLAIN_IF_MATCH
  );
  if (!res.ok) await throwWithResponseBody(res, "Could not set module tasks");
}
async function setModuleData(rest, orgId, assetId, versionId, moduleName, code) {
  const body = JSON.stringify({ name: moduleName, source: code });
  const res = await rest.postRaw(
    `/admin/application/api/v2/organisations/${orgId}/items/${assetId}/data/${versionId}`,
    body,
    TEXT_PLAIN_IF_MATCH
  );
  if (!res.ok) await throwWithResponseBody(res, "Could not set module data");
}
async function commitModule(rest, orgId, packageId, name, flowScriptSource) {
  const existing = await findExistingModule(rest, orgId, packageId, name);
  const created = existing ?? await createModuleAsset(rest, orgId, packageId, name);
  const asset = await getModuleAsset(rest, orgId, packageId, created.id);
  if (asset.type !== "module") throw new Error("Asset is not a module.");
  const moduleName = asset.name;
  const headVersionId = asset.mainBranch.headVersionId;
  const branchId = asset.mainBranch.id;
  await setModuleDesignerXml(rest, orgId, asset.id, moduleName, headVersionId, flowScriptSource);
  await setModuleTasks(rest, orgId, asset.id, headVersionId);
  await setModuleData(rest, orgId, asset.id, headVersionId, moduleName, flowScriptSource);
  const validateRes = await rest.post(
    `/admin/application/api/v2/organisations/${orgId}/items/${asset.id}/branches/${branchId}/validate`,
    { assets: [] }
  );
  if (!validateRes.ok) await throwWithResponseBody(validateRes, "Module validation failed");
  const validation = await validateRes.json();
  const updateRes = await rest.put(
    `/admin/application/api/v2/organisations/${orgId}/items/${asset.id}/branches/${branchId}`,
    {
      headVersionId,
      parameterType: "{}",
      resultType: "{}",
      isInbox: false,
      snapshotToken: validation.snapshot,
      numberOfErrors: 0
    }
  );
  if (!updateRes.ok) await throwWithResponseBody(updateRes, "Module branch update failed");
  const commitRes = await rest.post(
    `/admin/application/api/v2/organisations/${orgId}/items/${asset.id}/branches/${branchId}/commit`,
    { headVersionId, commitMessage: "Auto generated version." }
  );
  if (!commitRes.ok) await throwWithResponseBody(commitRes, "Module commit failed");
  const newBranch = await commitRes.json();
  await setModuleDesignerXml(rest, orgId, asset.id, moduleName, newBranch.headVersionId, flowScriptSource);
  return { assetId: asset.id, assetVersion: newBranch.headVersionId };
}
export {
  commitModule,
  getModuleAsset
};
