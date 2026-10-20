const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseDesignerTabUrl, resolvePackageId, getDesignerData, buildAssetRef,
  patchAssetsList, computeModuleStatus, activateModule, deactivateModule
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

test("resolvePackageId reads packageInfo from the Designer's own by-id read, with one call", async () => {
  const paths = [];
  const flowFetch = async (path) => {
    paths.push(path);
    return jsonResponse({ name: "Flow", packageInfo: { id: "pkg-2", name: "Pkg" }, assets: [] });
  };
  assert.equal(await resolvePackageId({ flowFetch, orgId: "org-1", itemId: "item-123" }), "pkg-2");
  assert.deepEqual(paths, ["/admin/application/api/v2/organisations/org-1/items/item-123/designer"]);
});

test("resolvePackageId returns null for a global flow (packageInfo null, live-verified shape)", async () => {
  const flowFetch = async () => jsonResponse({ name: "TesT123", packageInfo: null, assets: [] });
  assert.equal(await resolvePackageId({ flowFetch, orgId: "org-1", itemId: "item-123" }), null);
});

test("resolvePackageId accepts packageInfo.packageId as the id field too", async () => {
  const flowFetch = async () => jsonResponse({ packageInfo: { packageId: "pkg-9" } });
  assert.equal(await resolvePackageId({ flowFetch, orgId: "org-1", itemId: "item-123" }), "pkg-9");
});

test("resolvePackageId throws, naming the fields, when packageInfo has no recognizable id", async () => {
  const flowFetch = async () => jsonResponse({ packageInfo: { name: "Pkg" } });
  await assert.rejects(resolvePackageId({ flowFetch, orgId: "org-1", itemId: "item-123" }), /fields: name/);
});

test("buildAssetRef shapes the designer assets[] entry", () => {
  assert.deepEqual(buildAssetRef({ assetId: "a1", headVersionId: "v1" }), { assetId: "a1", assetVersion: "v1", usedIndirectly: false, offeredParameterType: "any", requiredResultType: "any" });
  assert.deepEqual(Object.keys(buildAssetRef({ assetId: "a1", headVersionId: "v1" })),
    ["assetId", "assetVersion", "usedIndirectly", "offeredParameterType", "requiredResultType"], "Designer's key order");
});

test("patchAssetsList appends a new ref when the assetId isn't present", () => {
  const { assets, changed } = patchAssetsList([], { assetId: "a1", assetVersion: "v1", offeredParameterType: "any" });
  assert.equal(changed, true);
  assert.deepEqual(assets, [{ assetId: "a1", assetVersion: "v1", offeredParameterType: "any" }]);
});

test("patchAssetsList bumps an existing ref's version in place, never appends a duplicate", () => {
  const existing = [{ assetId: "a1", assetVersion: "v1", offeredParameterType: "any" }];
  const { assets, changed } = patchAssetsList(existing, { assetId: "a1", assetVersion: "v2", offeredParameterType: "any" });
  assert.equal(changed, true);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].assetVersion, "v2");
});

test("patchAssetsList is a no-op when the ref already matches exactly", () => {
  const existing = [{ assetId: "a1", assetVersion: "v1", offeredParameterType: "any" }];
  const { assets, changed } = patchAssetsList(existing, { assetId: "a1", assetVersion: "v1", offeredParameterType: "any" });
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

test("activateModule saves exactly like the Designer: If-Match from the etag header, full assets, ONLY the module-added event, no commit", async () => {
  const calls = [];
  const existing = { assetId: "other", assetVersion: "v0", usedIndirectly: false, offeredParameterType: "any", requiredResultType: "any" };
  const designerBody = {
    data: [{ type: "step-created" }],
    assets: [existing],
    parameterTypeExpression: "{}",
    resultTypeExpression: "{}",
    eTag: "\"body-etag\""
  };
  const flowFetch = async (path, options) => {
    calls.push({ path, method: (options && options.method) || "GET", body: options && options.body, headers: options && options.headers });
    if (path.endsWith("/designer") && (!options || !options.method)) {
      return { ok: true, headers: { get: (h) => (h === "etag" ? "\"header-etag\"" : null) }, json: async () => designerBody };
    }
    if (path.endsWith("/designer")) return { ok: true };
    throw new Error("unexpected call " + path);
  };
  await activateModule({ flowFetch, orgId: "org-1", itemId: "item-1", assetId: "a1", headVersionId: "v1", moduleName: "CustomerHandling" });

  assert.deepEqual(calls.map((c) => c.method), ["GET", "POST"], "no commit");
  assert.equal(calls[1].headers["If-Match"], "\"header-etag\"", "If-Match is the etag response header");
  const posted = JSON.parse(calls[1].body);
  assert.deepEqual(Object.keys(posted), ["assets", "parameterTypeExpression", "resultTypeExpression", "errors", "isInbox", "hasSuitcase", "architecture", "data"]);
  assert.deepEqual(posted.assets, [existing, { assetId: "a1", assetVersion: "v1", usedIndirectly: false, offeredParameterType: "any", requiredResultType: "any" }]);
  assert.deepEqual(posted.data, [{ type: "module-added", name: "CustomerHandling", moduleId: "a1" }], "only the new event, never the existing log");
});

test("activateModule re-versions an already-added module without a module-added event", async () => {
  let posted;
  const designerBody = { data: [{ type: "module-added" }], assets: [{ ...{ assetId: "a1", assetVersion: "v1", usedIndirectly: false, offeredParameterType: "any", requiredResultType: "any" }, assetVersion: "v0" }], eTag: "\"e\"" };
  const flowFetch = async (path, options) => {
    if (!options || !options.method) return { ok: true, json: async () => designerBody };
    posted = JSON.parse(options.body);
    return { ok: true };
  };
  await activateModule({ flowFetch, orgId: "o", itemId: "i", assetId: "a1", headVersionId: "v1", moduleName: "X" });
  assert.equal(posted.assets[0].assetVersion, "v1");
  assert.deepEqual(posted.data, []);
});

test("getDesignerData failure includes the real response body text", async () => {
  const flowFetch = async () => ({ ok: false, status: 404, text: async () => "Item not found." });
  await assert.rejects(
    () => getDesignerData({ flowFetch, orgId: "org-1", itemId: "item-1" }),
    (err) => { assert.equal(err.message, "Could not load designer data (404): Item not found."); return true; }
  );
});

test("activateModule's designer-save failure includes the real response body text", async () => {
  const designerBody = { data: [], assets: [], parameterTypeExpression: "{}", resultTypeExpression: "{}", eTag: "\"etag\"" };
  const flowFetch = async (path, options) => {
    if (path.endsWith("/designer") && (!options || !options.method)) return { ok: true, json: async () => designerBody };
    if (path.endsWith("/designer")) return { ok: false, status: 400, text: async () => "Assets[0].OfferedParameterType is required." };
    throw new Error("unexpected call " + path);
  };
  await assert.rejects(
    () => activateModule({ flowFetch, orgId: "org-1", itemId: "item-1", assetId: "a1", headVersionId: "v1" }),
    (err) => { assert.equal(err.message, "Could not save designer data (400): Assets[0].OfferedParameterType is required."); return true; }
  );
});

test("activateModule skips the save entirely when the ref already matches (no-op)", async () => {
  const calls = [];
  const designerBody = {
    data: [], assets: [{ assetId: "a1", assetVersion: "v1", usedIndirectly: false, offeredParameterType: "any", requiredResultType: "any" }],
    parameterTypeExpression: "{}", resultTypeExpression: "{}", eTag: "\"etag-abc\""
  };
  const flowFetch = async (path, options) => {
    calls.push({ path, method: (options && options.method) || "GET" });
    return { ok: true, json: async () => designerBody };
  };
  await activateModule({ flowFetch, orgId: "org-1", itemId: "item-1", assetId: "a1", headVersionId: "v1" });
  assert.equal(calls.length, 1, "only the initial GET should happen when nothing changed");
});

test("deactivateModule removes only that module from assets[] and saves like activate (If-Match, no event, no commit)", async () => {
  const calls = [];
  const keep = { assetId: "other", assetVersion: "v0", usedIndirectly: false, offeredParameterType: "any", requiredResultType: "any" };
  const drop = { assetId: "a1", assetVersion: "v1", usedIndirectly: false, offeredParameterType: "any", requiredResultType: "any" };
  const designerBody = { data: [{ type: "module-added" }], assets: [keep, drop], parameterTypeExpression: "{}", resultTypeExpression: "{}" };
  const flowFetch = async (path, options) => {
    calls.push({ method: (options && options.method) || "GET", body: options && options.body, headers: options && options.headers });
    if (!options || !options.method) return { ok: true, headers: { get: (h) => (h === "etag" ? "\"e1\"" : null) }, json: async () => designerBody };
    return { ok: true };
  };
  await deactivateModule({ flowFetch, orgId: "o", itemId: "i", assetId: "a1" });
  assert.deepEqual(calls.map((c) => c.method), ["GET", "POST"]);
  assert.equal(calls[1].headers["If-Match"], "\"e1\"");
  const posted = JSON.parse(calls[1].body);
  assert.deepEqual(Object.keys(posted), ["assets", "parameterTypeExpression", "resultTypeExpression", "errors", "isInbox", "hasSuitcase", "architecture", "data"]);
  assert.deepEqual(posted.assets, [keep]);
  assert.deepEqual(posted.data, []);
});

test("deactivateModule skips the save when the module isn't in the flow", async () => {
  const calls = [];
  const flowFetch = async (path, options) => {
    calls.push((options && options.method) || "GET");
    return { ok: true, json: async () => ({ data: [], assets: [] }) };
  };
  await deactivateModule({ flowFetch, orgId: "o", itemId: "i", assetId: "a1" });
  assert.deepEqual(calls, ["GET"]);
});
