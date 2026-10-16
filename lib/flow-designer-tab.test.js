const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseDesignerTabUrl, resolvePackageId, getDesignerData, buildAssetRef,
  patchAssetsList, computeModuleStatus, activateModule
} = require("./flow-designer-tab.js");

test("parseDesignerTabUrl extracts orgId and itemId from a real Designer URL", () => {
  const url = "https://build.novacura.com/admin/design/designer/organizations/09b7b161-907a-4e6f-bfb4-6c6ea6f9b794/items/7cb1cbab-0849-4e16-925f-14623f6ec5df";
  assert.deepEqual(parseDesignerTabUrl(url), {
    orgId: "09b7b161-907a-4e6f-bfb4-6c6ea6f9b794",
    itemId: "7cb1cbab-0849-4e16-925f-14623f6ec5df"
  });
});

test("parseDesignerTabUrl returns null for an unrelated URL", () => {
  assert.equal(parseDesignerTabUrl("https://build.novacura.com/admin/other/page"), null);
});

function jsonResponse(body) { return { ok: true, json: async () => body }; }

test("resolvePackageId finds the package whose assets[] contains the itemId", async () => {
  const flowFetch = async (path) => {
    if (path.endsWith("/packages")) return jsonResponse([{ id: "pkg-1" }, { id: "pkg-2" }]);
    if (path.includes("pkg-1/assets")) return jsonResponse([{ id: "other-item" }]);
    if (path.includes("pkg-1/products")) return jsonResponse([]);
    if (path.includes("pkg-2/assets")) return jsonResponse([{ id: "item-123" }]);
    if (path.includes("pkg-2/products")) return jsonResponse([]);
    throw new Error("unexpected path " + path);
  };
  const packageId = await resolvePackageId({ flowFetch, orgId: "org-1", itemId: "item-123" });
  assert.equal(packageId, "pkg-2");
});

test("resolvePackageId also checks products[] (top-level flows), not just assets[]", async () => {
  const flowFetch = async (path) => {
    if (path.endsWith("/packages")) return jsonResponse([{ id: "pkg-1" }]);
    if (path.includes("/assets")) return jsonResponse([]);
    if (path.includes("/products")) return jsonResponse([{ id: "item-123" }]);
    throw new Error("unexpected path " + path);
  };
  const packageId = await resolvePackageId({ flowFetch, orgId: "org-1", itemId: "item-123" });
  assert.equal(packageId, "pkg-1");
});

test("resolvePackageId returns null when no package contains the itemId", async () => {
  const flowFetch = async (path) => {
    if (path.endsWith("/packages")) return jsonResponse([{ id: "pkg-1" }]);
    return jsonResponse([]);
  };
  assert.equal(await resolvePackageId({ flowFetch, orgId: "org-1", itemId: "missing" }), null);
});

test("buildAssetRef shapes the designer assets[] entry", () => {
  assert.deepEqual(buildAssetRef({ assetId: "a1", headVersionId: "v1" }), {
    assetId: "a1", assetVersion: "v1", offeredParameterType: "{}"
  });
});

test("patchAssetsList appends a new ref when the assetId isn't present", () => {
  const { assets, changed } = patchAssetsList([], { assetId: "a1", assetVersion: "v1", offeredParameterType: "{}" });
  assert.equal(changed, true);
  assert.deepEqual(assets, [{ assetId: "a1", assetVersion: "v1", offeredParameterType: "{}" }]);
});

test("patchAssetsList bumps an existing ref's version in place, never appends a duplicate", () => {
  const existing = [{ assetId: "a1", assetVersion: "v1", offeredParameterType: "{}" }];
  const { assets, changed } = patchAssetsList(existing, { assetId: "a1", assetVersion: "v2", offeredParameterType: "{}" });
  assert.equal(changed, true);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].assetVersion, "v2");
});

test("patchAssetsList is a no-op when the ref already matches exactly", () => {
  const existing = [{ assetId: "a1", assetVersion: "v1", offeredParameterType: "{}" }];
  const { assets, changed } = patchAssetsList(existing, { assetId: "a1", assetVersion: "v1", offeredParameterType: "{}" });
  assert.equal(changed, false);
  assert.deepEqual(assets, existing);
});

test("computeModuleStatus reports not_created when no module asset exists", () => {
  assert.equal(computeModuleStatus(null, []), "not_created");
});

test("computeModuleStatus reports created when the module asset exists but isn't referenced by the flow", () => {
  const moduleAsset = { id: "a1", mainBranch: { headVersionId: "v1" } };
  assert.equal(computeModuleStatus(moduleAsset, [{ assetId: "other" }]), "created");
});

test("computeModuleStatus reports activated when the flow references the current version", () => {
  const moduleAsset = { id: "a1", mainBranch: { headVersionId: "v1" } };
  assert.equal(computeModuleStatus(moduleAsset, [{ assetId: "a1", assetVersion: "v1" }]), "activated");
});

test("computeModuleStatus reports activated_stale when the flow references an older version", () => {
  const moduleAsset = { id: "a1", mainBranch: { headVersionId: "v2" } };
  assert.equal(computeModuleStatus(moduleAsset, [{ assetId: "a1", assetVersion: "v1" }]), "activated_stale");
});

test("activateModule GETs designer data, patches assets[], POSTs it back, and commits with the body's eTag", async () => {
  const calls = [];
  const designerBody = {
    data: [{ type: "step-created" }],
    assets: [],
    parameterTypeExpression: "{}",
    resultTypeExpression: "{}",
    eTag: "\"etag-abc\""
  };
  const flowFetch = async (path, options) => {
    calls.push({ path, method: (options && options.method) || "GET", body: options && options.body });
    if (path.endsWith("/designer") && (!options || !options.method)) {
      return { ok: true, json: async () => designerBody };
    }
    if (path.endsWith("/designer")) return { ok: true };
    if (path.endsWith("/commit")) return { ok: true };
    throw new Error("unexpected call " + path);
  };
  await activateModule({ flowFetch, orgId: "org-1", itemId: "item-1", assetId: "a1", headVersionId: "v1" });

  assert.equal(calls[0].path, "/admin/application/api/v2/organisations/org-1/items/item-1/designer");
  assert.equal(calls[0].method, "GET");

  const postedBody = JSON.parse(calls[1].body);
  assert.deepEqual(postedBody.assets, [{ assetId: "a1", assetVersion: "v1", offeredParameterType: "{}" }]);
  assert.deepEqual(postedBody.data, designerBody.data);

  const commitBody = JSON.parse(calls[2].body);
  assert.equal(commitBody.eTag, "\"etag-abc\"");
  assert.equal(calls[2].path, "/admin/application/api/v2/organisations/org-1/items/item-1/commit");
});

test("activateModule skips the POST+commit entirely when the ref already matches (no-op)", async () => {
  const calls = [];
  const designerBody = {
    data: [], assets: [{ assetId: "a1", assetVersion: "v1", offeredParameterType: "{}" }],
    parameterTypeExpression: "{}", resultTypeExpression: "{}", eTag: "\"etag-abc\""
  };
  const flowFetch = async (path, options) => {
    calls.push({ path, method: (options && options.method) || "GET" });
    return { ok: true, json: async () => designerBody };
  };
  await activateModule({ flowFetch, orgId: "org-1", itemId: "item-1", assetId: "a1", headVersionId: "v1" });
  assert.equal(calls.length, 1, "only the initial GET should happen when nothing changed");
});
