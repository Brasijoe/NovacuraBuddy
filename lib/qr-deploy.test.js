const test = require("node:test");
const assert = require("node:assert/strict");
const { createIfsClient, deployQuickReport, listPermissionSets, quickReportProjectionName } = require("./qr-deploy.js");

const BASE_URL = "https://ifs.example.com";
const PREFIX = "/main/ifsapplications/projection/v1/";
const report = { id: "my-report", name: "My Report", content: "SELECT 1 FROM DUAL" };

function res(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body))
  };
}

/** Fake IFS: answers the confirmed QuickReportHandling / PermissionSetHandling calls.
 *  `override(call)` may return a response to replace the default for one call. */
function fakeIfs({ existing = [], newId = "516435.0", override } = {}) {
  const calls = [];
  let lob = 0;
  const fetchImpl = async (url, init) => {
    const call = { method: init.method, path: url.replace(BASE_URL, ""), headers: init.headers, body: init.body };
    calls.push(call);
    const forced = override && override(call, calls);
    if (forced) return forced;
    const { method, path } = call;
    if (method === "GET" && path.includes("QuickReportSet?$select")) return res(200, { value: existing });
    if (method === "POST" && path.endsWith("/FndTempLobs")) { lob++; return res(201, { LobId: `LOB-${lob}`, "@odata.etag": `ETAG-${lob}` }); }
    if (method === "PATCH" && path.endsWith("/ClobData")) return res(204);
    if (method === "POST" && path.endsWith("/CheckSqlExpressionAction")) return res(204);
    if (method === "POST" && path.endsWith("/QuickReportVirtualSet")) return res(201, { Objkey: "OBJ-1" });
    if (method === "POST" && path.endsWith("/SaveNewAction")) return res(200, { value: newId });
    if (method === "POST" && path.includes("CleanupVirtualEntity")) return res(204);
    if (method === "GET" && /QuickReportSet\(QuickReportId=\d+\)$/.test(path)) return res(200, { "@odata.etag": "QR-ETAG" });
    if (method === "PATCH" && path.includes("QuickReportSet(QuickReportId=")) return res(200, { QuickReportId: "900" });
    if (method === "POST" && path.endsWith("/GrantProjections")) return res(204);
    if (method === "GET" && path.includes("PermissionSets?")) {
      return res(200, { value: [
        { Role: "SALES", Description: "Sales users", FndRoleDeliveryType: null },
        { Role: "FND_ADMIN", Description: "IFS admin", FndRoleDeliveryType: "IFSManaged" },
        { Role: "NODESC", Description: null, FndRoleDeliveryType: "Customer" }
      ] });
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { fetchImpl, calls };
}

const sig = (c) => `${c.method} ${c.path.replace(PREFIX, "").split("?")[0]}`;

function clientFor(fake, tokens = ["T1"]) {
  let i = 0;
  const state = { cleared: 0 };
  const client = createIfsClient({
    baseUrl: BASE_URL,
    getToken: async () => tokens[Math.min(i++, tokens.length - 1)],
    clearToken: () => { state.cleared++; },
    fetchImpl: fake.fetchImpl
  });
  return { client, state };
}

test("first deploy runs the confirmed create sequence, then one grant per permission set", async () => {
  const fake = fakeIfs();
  const { client } = clientFor(fake);
  const outcome = await deployQuickReport(client, { report, permissionSetIds: ["SALES", "NODESC"] });
  assert.deepEqual(outcome, { status: "deployed", quickReportId: "516435" });
  assert.deepEqual(fake.calls.map(sig), [
    "GET QuickReportHandling.svc/QuickReportSet",
    "POST QuickReportHandling.svc/FndTempLobs",
    "PATCH QuickReportHandling.svc/FndTempLobs(LobId='LOB-1')/ClobData",
    "POST QuickReportHandling.svc/CheckSqlExpressionAction",
    "POST QuickReportHandling.svc/QuickReportVirtualSet",
    "POST QuickReportHandling.svc/FndTempLobs",
    "PATCH QuickReportHandling.svc/FndTempLobs(LobId='LOB-2')/ClobData",
    "POST QuickReportHandling.svc/CheckSqlExpressionAction",
    "POST QuickReportHandling.svc/SaveNewAction",
    "POST QuickReportHandling.svc/QuickReportVirtualSet(Objkey='OBJ-1')/IfsApp.QuickReportHandling.QuickReportVirtual_CleanupVirtualEntity",
    "POST PermissionSetHandling.svc/GrantProjections",
    "POST PermissionSetHandling.svc/GrantProjections"
  ]);
  const clob = fake.calls[2];
  assert.equal(clob.body, "SELECT 1 FROM DUAL");
  assert.equal(clob.headers["If-Match"], "ETAG-1");
  assert.equal(clob.headers["Content-Type"], "application/octet-stream");
  assert.equal(clob.headers.Authorization, "Bearer T1");
  assert.deepEqual(JSON.parse(fake.calls[4].body), { Description: "My Report", QrType: "SQLStatement", SqlExpression: "SELECT 1 FROM DUAL" });
  assert.deepEqual(JSON.parse(fake.calls[10].body), { Projections: "PROJECTION_NAME=QuickReport516435^", Role: "SALES" });
  assert.deepEqual(JSON.parse(fake.calls[11].body), { Projections: "PROJECTION_NAME=QuickReport516435^", Role: "NODESC" });
});

test("a same-named report on the instance asks for confirmation and writes nothing", async () => {
  const fake = fakeIfs({ existing: [{ QuickReportId: "42.0", Description: "My Report" }] });
  const { client } = clientFor(fake);
  const outcome = await deployQuickReport(client, { report, permissionSetIds: ["SALES"] });
  assert.deepEqual(outcome, { status: "needsConfirmation", existingQuickReportId: "42", existingDescription: "My Report" });
  assert.deepEqual(fake.calls.map((c) => c.method), ["GET"]);
});

test("the name lookup escapes single quotes in the OData filter", async () => {
  const fake = fakeIfs();
  const { client } = clientFor(fake);
  await deployQuickReport(client, { report: { ...report, name: "Bob's report" }, permissionSetIds: [] });
  assert.ok(decodeURIComponent(fake.calls[0].path).includes("Description eq 'Bob''s report'"));
});

test("forceQuickReportId updates that record via GET etag + PATCH, no name lookup", async () => {
  const fake = fakeIfs();
  const { client } = clientFor(fake);
  const outcome = await deployQuickReport(client, { report, forceQuickReportId: "900", permissionSetIds: [] });
  assert.deepEqual(outcome, { status: "deployed", quickReportId: "900" });
  assert.deepEqual(fake.calls.map(sig), [
    "POST QuickReportHandling.svc/FndTempLobs",
    "PATCH QuickReportHandling.svc/FndTempLobs(LobId='LOB-1')/ClobData",
    "POST QuickReportHandling.svc/CheckSqlExpressionAction",
    "GET QuickReportHandling.svc/QuickReportSet(QuickReportId=900)",
    "PATCH QuickReportHandling.svc/QuickReportSet(QuickReportId=900)"
  ]);
  const patch = fake.calls[4];
  assert.equal(patch.headers["If-Match"], "QR-ETAG");
  assert.equal(patch.headers["Content-Type"], "application/json;IEEE754Compatible=true");
  assert.ok(patch.path.includes("?select-fields=Description,QuickReportId"));
  assert.deepEqual(JSON.parse(patch.body), { Description: "My Report", SqlExpression: "SELECT 1 FROM DUAL" });
});

test("a prior deployment id takes the update path too", async () => {
  const fake = fakeIfs();
  const { client } = clientFor(fake);
  await deployQuickReport(client, { report, priorQuickReportId: "900", permissionSetIds: [] });
  assert.ok(!fake.calls.some((c) => c.path.includes("$filter")));
});

test("a validation failure names the step and carries IFS's error text", async () => {
  const fake = fakeIfs({ override: (c) => (c.path.endsWith("/CheckSqlExpressionAction") ? res(400, "ORA-00942: table or view does not exist") : null) });
  const { client } = clientFor(fake);
  await assert.rejects(deployQuickReport(client, { report, permissionSetIds: [] }), (err) => {
    assert.equal(err.step, "Validate SQL");
    assert.match(err.message, /^Validate SQL failed — /);
    assert.match(err.message, /ORA-00942/);
    return true;
  });
});

test("a SaveNewAction failure still cleans up the draft, and the save error wins", async () => {
  const fake = fakeIfs({ override: (c) => (c.path.endsWith("/SaveNewAction") ? res(409, "FND_RECORD_EXIST") : null) });
  const { client } = clientFor(fake);
  await assert.rejects(deployQuickReport(client, { report, permissionSetIds: [] }), (err) => err.step === "Save new report");
  assert.ok(fake.calls.some((c) => c.path.includes("CleanupVirtualEntity")));
});

test("a 401 clears the cached token and retries once with a fresh one", async () => {
  const fake = fakeIfs({ override: (c, calls) => (calls.length === 1 ? res(401, "expired") : null) });
  const { client, state } = clientFor(fake, ["OLD", "NEW"]);
  await deployQuickReport(client, { report, permissionSetIds: [] });
  assert.equal(state.cleared, 1);
  assert.equal(fake.calls[0].headers.Authorization, "Bearer OLD");
  assert.equal(fake.calls[1].headers.Authorization, "Bearer NEW");
});

test("a second 401 in a row is an error, not a loop", async () => {
  const fake = fakeIfs({ override: () => res(401, "nope") });
  const { client } = clientFor(fake, ["A", "B", "C"]);
  await assert.rejects(deployQuickReport(client, { report, permissionSetIds: [] }), /401/);
  assert.equal(fake.calls.length, 2);
});

test("listPermissionSets drops IFS-managed sets and falls back to Role for a missing name", async () => {
  const { client } = clientFor(fakeIfs());
  assert.deepEqual(await listPermissionSets(client), [
    { id: "SALES", name: "Sales users" },
    { id: "NODESC", name: "NODESC" }
  ]);
});

test("quickReportProjectionName builds the IFS projection name from a (possibly .0) id", () => {
  assert.equal(quickReportProjectionName("397794"), "QuickReport397794");
  assert.equal(quickReportProjectionName("397794.0"), "QuickReport397794");
  assert.equal(quickReportProjectionName(397794), "QuickReport397794");
});
