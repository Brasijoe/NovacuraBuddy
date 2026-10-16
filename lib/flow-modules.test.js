const test = require("node:test");
const assert = require("node:assert/strict");
const {
  findExistingModule, createModuleAsset, findOrCreateModule, getModuleAsset,
  generateModuleCode, commitModuleCode
} = require("./flow-modules.js");

function jsonResponse(body) { return { ok: true, json: async () => body }; }

test("findExistingModule matches an existing module asset by name, case-insensitively", async () => {
  const flowFetch = async () => jsonResponse([
    { id: "a1", type: "module", name: "SalesQuotationHandling" },
    { id: "a2", type: "component", name: "Other" }
  ]);
  const found = await findExistingModule({ flowFetch, orgId: "org-1", packageId: "pkg-1", projectionName: "salesquotationhandling" });
  assert.equal(found.id, "a1");
});

test("findExistingModule returns null when no module asset matches", async () => {
  const flowFetch = async () => jsonResponse([]);
  assert.equal(await findExistingModule({ flowFetch, orgId: "org-1", packageId: "pkg-1", projectionName: "X" }), null);
});

test("createModuleAsset POSTs with the module color/type and description", async () => {
  let posted;
  const flowFetch = async (path, options) => {
    posted = { path, body: JSON.parse(options.body) };
    return jsonResponse({ id: "a1", type: "module", name: "SalesQuotationHandling" });
  };
  const asset = await createModuleAsset({ flowFetch, orgId: "org-1", packageId: "pkg-1", projectionName: "SalesQuotationHandling" });
  assert.equal(asset.id, "a1");
  assert.equal(posted.body.type, "module");
  assert.equal(posted.body.color, "#4031F8");
  assert.equal(posted.body.name, "SalesQuotationHandling");
});

test("findOrCreateModule reuses an existing module instead of creating a duplicate", async () => {
  let createCalled = false;
  const flowFetch = async (path, options) => {
    if (options && options.method === "POST") { createCalled = true; return jsonResponse({ id: "new" }); }
    return jsonResponse([{ id: "existing", type: "module", name: "SalesQuotationHandling" }]);
  };
  const asset = await findOrCreateModule({ flowFetch, orgId: "org-1", packageId: "pkg-1", projectionName: "SalesQuotationHandling" });
  assert.equal(asset.id, "existing");
  assert.equal(createCalled, false);
});

test("generateModuleCode posts csdl+openApiJson and prefixes a generated-header comment", async () => {
  const flowFetch = async (path, options) => {
    if (path.includes("generate/Queryable")) {
      const body = JSON.parse(new TextDecoder().decode(options.body));
      assert.equal(body.csdlXml, "<csdl/>");
      assert.equal(body.projectionSubPath, "/main/ifsapplications/projection/v1");
      return { ok: true, text: async () => "function Foo(): text { return \"\"; }" };
    }
    if (path.includes("build-number")) return { ok: true, text: async () => "42" };
    throw new Error("unexpected " + path);
  };
  const code = await generateModuleCode({
    flowFetch, csdlXml: "<csdl/>", openApiJson: "{}",
    codeGenSubPath: "/main/ifsapplications/projection/v1",
    importSourcePath: "/main/ifsapplications/projection/v1/SalesQuotationHandling.svc"
  });
  assert.ok(code.includes("build 42"));
  assert.ok(code.includes("function Foo(): text"));
});

test("commitModuleCode runs the full write/validate/update/commit/re-push sequence keyed on branchId vs headVersionId", async () => {
  const calls = [];
  const asset = { id: "a1", type: "module", name: "SalesQuotationHandling", mainBranch: { id: "branch-1", headVersionId: "v1" } };
  const flowFetch = async (path, options) => {
    calls.push({ path, method: (options && options.method) || "GET" });
    if (path.endsWith("/assets/a1")) return jsonResponse(asset);
    if (path.includes("/designerXml/")) return { ok: true, text: async () => "" };
    if (path.includes("/tasks/")) return { ok: true };
    if (path.includes("/data/")) return { ok: true };
    if (path.includes("/validate")) return jsonResponse({ snapshot: "snap-1" });
    if (path.includes("/branches/branch-1") && options.method === "PUT") return { ok: true };
    if (path.endsWith("/commit")) return jsonResponse({ headVersionId: "v2" });
    throw new Error("unexpected call " + path);
  };

  const result = await commitModuleCode({ flowFetch, orgId: "org-1", packageId: "pkg-1", assetId: "a1", flowScriptCode: "function Foo() {}" });
  assert.equal(result.headVersionId, "v2");

  const designerXmlCalls = calls.filter((c) => c.path.includes("/designerXml/"));
  assert.equal(designerXmlCalls.length, 2, "designerXml must be written once pre-commit (v1) and once post-commit (v2)");
  assert.ok(designerXmlCalls[0].path.endsWith("/designerXml/v1"));
  assert.ok(designerXmlCalls[1].path.endsWith("/designerXml/v2"));

  const validateCall = calls.find((c) => c.path.includes("/validate"));
  assert.ok(validateCall.path.includes("/branches/branch-1/validate"), "validate is keyed on branchId, not headVersionId");
});

test("getModuleAsset returns whatever asset is at that id, without itself checking its type", async () => {
  const flowFetch = async () => jsonResponse({ id: "a1", type: "component" });
  const asset = await getModuleAsset({ flowFetch, orgId: "org-1", packageId: "pkg-1", assetId: "a1" });
  assert.equal(asset.type, "component"); // the type check is commitModuleCode's job, asserted below
});

test("commitModuleCode throws if the asset at assetId isn't a module", async () => {
  const flowFetch = async () => jsonResponse({ id: "a1", type: "component", mainBranch: { id: "b1", headVersionId: "v1" } });
  await assert.rejects(
    () => commitModuleCode({ flowFetch, orgId: "org-1", packageId: "pkg-1", assetId: "a1", flowScriptCode: "function F() {}" }),
    /Asset is not a module/
  );
});

test("findExistingModule failure includes the real response body text, not just the status", async () => {
  const flowFetch = async () => ({ ok: false, status: 400, text: async () => "Organisation not found." });
  await assert.rejects(
    () => findExistingModule({ flowFetch, orgId: "org-1", packageId: "pkg-1", projectionName: "X" }),
    (err) => { assert.equal(err.message, "Could not list assets (400): Organisation not found."); return true; }
  );
});

test("createModuleAsset failure includes the real response body text", async () => {
  const flowFetch = async () => ({ ok: false, status: 400, text: async () => "Name already in use." });
  await assert.rejects(
    () => createModuleAsset({ flowFetch, orgId: "org-1", packageId: "pkg-1", projectionName: "X" }),
    (err) => { assert.equal(err.message, "Could not create module (400): Name already in use."); return true; }
  );
});

test("commitModuleCode's branch update failure includes the real response body text", async () => {
  const asset = { id: "a1", type: "module", name: "X", mainBranch: { id: "branch-1", headVersionId: "v1" } };
  const flowFetch = async (path, options) => {
    if (path.endsWith("/assets/a1")) return jsonResponse(asset);
    if (path.includes("/designerXml/") || path.includes("/tasks/") || path.includes("/data/")) return { ok: true, text: async () => "" };
    if (path.includes("/validate")) return jsonResponse({ snapshot: "snap-1" });
    if (path.includes("/branches/branch-1") && options.method === "PUT") {
      return { ok: false, status: 400, text: async () => "Assets[0].OfferedParameterType is required." };
    }
    throw new Error("unexpected call " + path);
  };
  await assert.rejects(
    () => commitModuleCode({ flowFetch, orgId: "org-1", packageId: "pkg-1", assetId: "a1", flowScriptCode: "function F() {}" }),
    (err) => { assert.equal(err.message, "Branch update failed (400): Assets[0].OfferedParameterType is required."); return true; }
  );
});
