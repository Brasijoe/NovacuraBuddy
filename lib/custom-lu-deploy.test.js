const test = require("node:test");
const assert = require("node:assert/strict");
const { createIfsClient } = require("./ifs-client.js");
const { deployCustomLu, deployAll, listCustomLus, getCustomLuDefinition, approveAttributesBatch, checkBatchResponse } = require("./custom-lu-deploy.js");
const { normalizeLu } = require("./custom-lu-model.js");

const BASE = "https://ifs.example.com";
const res = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
  text: async () => (body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body))
});

// Captured 2026-10-20 (ApproveAttribute $batch answer), boundaries kept.
const BATCH_OK = "--batch_252648d5\r\nContent-Type: multipart/mixed; boundary=changeset_927d5c87\r\n\r\n--changeset_927d5c87\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\nContent-ID: 1\r\n\r\nHTTP/1.1 204 No Content\r\nOData-Version: 4.0\r\nContent-Length: 0\r\n\r\n\r\n--changeset_927d5c87--\r\n--batch_252648d5--\r\n";

function fakeIfs({ existingLu = false, luState = { PublishedDb: true, SynchronizedDb: true }, existingAttributes = [], override } = {}) {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    const call = { method: init.method, path: decodeURIComponent(url.replace(BASE, "")), headers: init.headers || {}, body: init.body };
    calls.push(call);
    const forced = override && override(call, calls);
    if (forced) return forced;
    const { method, path } = call;
    if (method === "GET" && /\/CustomLusSet\(Lu='[^']*',LuType=[^)]*\)\?\$select=/.test(path)) {
      return existingLu ? res(200, { Lu: "Demo", Prompt: "Demo LU", ...luState }) : res(404, { error: { code: "NOT_FOUND", message: "Not found" } });
    }
    if (method === "GET" && path.includes("/CustomFieldAttributesArray")) return res(200, { value: existingAttributes });
    if (method === "GET" && path.includes("/ValidateLu(")) return res(204);
    if (method === "GET" && path.includes("/ValidateAttributeName(")) return res(204);
    if (method === "POST" && path.includes("/CustomLusSet?select-fields=")) return res(201, { Lu: "Demo" });
    if (method === "POST" && path.endsWith("/CustomAttributesVirtuals")) { n++; return res(201, { Objkey: `OBJ${n}`, "@odata.etag": `W/"E${n}"` }); }
    if (method === "POST" && path.endsWith("/CleanDisplayTextVirtual")) return res(204);
    if (method === "PATCH" && path.includes("/CustomAttributesVirtuals(Objkey=")) return res(200, {});
    if (method === "POST" && path.endsWith("_CreateCustomAttributes")) return res(204);
    if (method === "POST" && path.endsWith("_CleanupVirtualEntity")) return res(204);
    if (method === "POST" && path.endsWith("/$batch")) return res(200, BATCH_OK);
    if (method === "POST" && (path.endsWith("/Approve") || path.endsWith("/Publish"))) return res(204);
    if (method === "POST" && path.endsWith("/GrantProjections")) return res(204);
    throw new Error(`unexpected ${method} ${path}`);
  };
  const client = createIfsClient({ baseUrl: BASE, getToken: async () => "tok", clearToken: () => {}, fetchImpl });
  return { client, calls };
}

/** "POST CustomAttributesVirtuals(OBJ)/…_CreateCustomAttributes" style labels for order checks. */
function label(c) {
  const p = c.path.replace(/^.*\.svc\//, "").replace(/\?.*$/, "").replace(/\(Objkey='[^']+'\)/, "(OBJ)").replace(/^CustomLusSet\([^/]*\)/, "CustomLusSet(key)").replace("IfsApp.EntityConfigHandling.CustomAttributesVirtual", "…");
  return `${c.method} ${p}`;
}

const uuid = (() => { let i = 0; return () => `u${++i}`; });
const demo = (attributes) => normalizeLu({ name: "Demo", prompt: "Demo LU", attributes });

test("new LU with one String attribute: full captured sequence, then grant", async () => {
  const { client, calls } = fakeIfs();
  const outcome = await deployCustomLu(client, { lu: demo([{ name: "NOTE", prompt: "Note", type: "STRING", length: 4000 }]), permissionSetIds: ["SALES"], uuid: uuid() });
  assert.deepEqual(calls.map(label), [
    "GET CustomLusSet(key)",
    "GET ValidateLu(Lu='Demo')",
    "POST CustomLusSet",
    "GET ValidateAttributeName(AttributeName='NOTE')",
    "POST CustomAttributesVirtuals",
    "POST CleanDisplayTextVirtual",
    "PATCH CustomAttributesVirtuals(OBJ)",
    "PATCH CustomAttributesVirtuals(OBJ)",
    "PATCH CustomAttributesVirtuals(OBJ)",
    "PATCH CustomAttributesVirtuals(OBJ)",
    "POST CustomAttributesVirtuals(OBJ)/…_CreateCustomAttributes",
    "POST CustomAttributesVirtuals(OBJ)/…_CleanupVirtualEntity",
    "POST $batch",
    "POST Approve",
    "POST Publish",
    "POST GrantProjections"
  ]);
  const create = calls.find((c) => label(c) === "POST CustomLusSet");
  assert.equal(create.body, '{"Lu":"Demo","Module":"CONFIG","Prompt":"Demo LU","UsedDb":false,"SynchronizedDb":false,"EnabledRowkey":false,"CreateProjectionDb":true,"PublishedDb":false}');
  assert.match(create.path, /\?select-fields=Lu,LuType,Objgrants,Prompt,Module,UsedDb,PublishedDb,SynchronizedDb,EnabledRowkey,LogicalUnitType,CreateProjectionDb,PackgName,TimestampTzRef,SiteTimeZoneRef,Excluded,RowkeyInEntity,CountAttributes,LuTypeName,HasTranslatableText,HasUnusedData,HasUnusedTable,AddedToPackage,luname,keyref$/);
  const virtual = calls.find((c) => label(c) === "POST CustomAttributesVirtuals");
  assert.equal(virtual.body, '{"Swap":false,"Insertable":true,"Updatable":true,"Queryable":true,"EnabledOnReports":false,"EnabledOnOutboundMsgs":false,"Private":false,"IsValidName":false,"Multiline":false,"ClickableHyperlink":false,"TempRefTypeOne":false,"TempRefTypeTwo":false,"TempRefTypeThree":false,"EnableOk":true,"EditMode":false,"HasVirtualUpdated":false,"HasEnumUpdated":true,"Lu":"Demo","LuType":"CUSTOM_LU","DataType":"STRING","DefaultValueType":"NO_DEFAULT_VALUE","DataLength":"100","HasChanged":"FALSE","HasNewItem":"FALSE"}');
  const patches = calls.filter((c) => c.method === "PATCH");
  assert.deepEqual(patches.map((c) => c.body), ['{"CustomAttributeType":"PERSISTENT_FIELD"}', '{"TextFormat":"UNFORMATTED"}', '{"DataLength":"4000"}', '{"AttributeName":"NOTE","Prompt":"Note"}']);
  for (const c of [...patches, ...calls.filter((x) => /_(Create|Cleanup)/.test(x.path))]) assert.equal(c.headers["If-Match"], 'W/"E1"');
  assert.equal(calls.find((c) => label(c) === "POST Approve").body, '{"Lu":"Demo","LuType":"CUSTOM_LU"}');
  assert.equal(calls.find((c) => label(c) === "POST GrantProjections").body, '{"Projections":"PROJECTION_NAME=Demo^","Role":"SALES"}');
  assert.deepEqual(outcome, { name: "Demo", createdLu: true, created: ["NOTE"], skipped: [], mismatches: [], approved: ["NOTE"], published: true, granted: ["SALES"], grantErrors: [] });
});

test("type PATCHes for Number, Date and DateTime", async () => {
  const { client, calls } = fakeIfs();
  await deployCustomLu(client, { lu: demo([{ name: "QTY", type: "NUMBER" }, { name: "DUE", type: "DATE" }, { name: "STAMP", type: "DATETIME" }]), permissionSetIds: [], uuid: uuid() });
  const byObj = {};
  for (const c of calls.filter((x) => x.method === "PATCH")) (byObj[c.path] = byObj[c.path] || []).push(c.body);
  assert.deepEqual(Object.values(byObj), [
    ['{"CustomAttributeType":"PERSISTENT_FIELD"}', '{"TextFormat":"UNFORMATTED"}', '{"DataType":"NUMBER","Indexed":false}', '{"AttributeName":"QTY","Prompt":"Qty"}'],
    ['{"CustomAttributeType":"PERSISTENT_FIELD"}', '{"TextFormat":"UNFORMATTED"}', '{"DataType":"DATE","Indexed":false}', '{"DateFormat":"DATE"}', '{"AttributeName":"DUE","Prompt":"Due"}'],
    ['{"CustomAttributeType":"PERSISTENT_FIELD"}', '{"TextFormat":"UNFORMATTED"}', '{"DataType":"DATE","Indexed":false}', '{"DateFormat":"DATETIME"}', '{"AttributeName":"STAMP","Prompt":"Stamp"}']
  ]);
});

test("ApproveAttribute $batch body matches the captured web-client request", () => {
  const { boundary, text } = approveAttributesBatch("CustomPageName", ["CUSTOMATTRNAME"], uuid());
  assert.equal(boundary, "u1");
  assert.equal(text,
    "--u1\r\nContent-Type: multipart/mixed;boundary=u2\r\n\r\n--u2\r\nContent-Type: application/http\r\nContent-Transfer-Encoding:binary\r\nContent-Id: 1\r\n\r\n" +
    "POST ApproveAttribute HTTP/1.1\r\nAccept:application/json;odata.metadata=full;IEEE754Compatible=true\r\nContent-Type: application/json;IEEE754Compatible=true\r\n\r\n" +
    '{"Lu":"CustomPageName","LuType":"CUSTOM_LU","AttributeName":"CUSTOMATTRNAME"}\r\n\r\n--u2--\r\n--u1--\r\n');
});

test("one $batch approves several attributes with numbered parts", () => {
  const { text } = approveAttributesBatch("Lu", ["A", "B"], uuid());
  assert.equal((text.match(/POST ApproveAttribute/g) || []).length, 2);
  assert.match(text, /Content-Id: 2\r\n/);
});

test("checkBatchResponse: ok, no status, failing part with IFS message", () => {
  checkBatchResponse(BATCH_OK);
  assert.throws(() => checkBatchResponse("garbage"), /no part status/);
  const failing = "--b\r\nHTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\n\r\n{\"error\":{\"code\":\"X\",\"message\":\"m\",\"details\":[{\"message\":\"ORA-1: nope\"}]}}\r\n--b--";
  assert.throws(() => checkBatchResponse(failing), (err) => /\(400\)/.test(err.message) && JSON.parse(err.body).error.details[0].message === "ORA-1: nope");
});

test("a failing part inside a 200 $batch fails the approve step with the IFS text", async () => {
  const failing = "--b\r\nHTTP/1.1 400 Bad Request\r\n\r\n{\"error\":{\"details\":[{\"message\":\"ORA-2: cannot approve\"}]}}\r\n--b--";
  const { client, calls } = fakeIfs({ override: (c) => (c.path.endsWith("/$batch") ? res(200, failing) : null) });
  await assert.rejects(deployCustomLu(client, { lu: demo([{ name: "A", type: "NUMBER" }]), permissionSetIds: [], uuid: uuid() }), /^Error: Approve attributes failed — ORA-2: cannot approve$/);
  assert.equal(calls.some((c) => c.path.endsWith("/Approve")), false);
});

test("IFS rejecting an attribute name stops before creating a draft", async () => {
  const { client, calls } = fakeIfs({ override: (c) => (c.path.includes("ValidateAttributeName(") ? res(200, { value: "The value of [Name] is invalid. First letter should be an uppercase alpha character" }) : null) });
  await assert.rejects(deployCustomLu(client, { lu: demo([{ name: "A", type: "NUMBER" }]), permissionSetIds: [], uuid: uuid() }), /^Error: Attribute A: validate name failed — The value of \[Name\] is invalid/);
  assert.equal(calls.some((c) => c.path.endsWith("/CustomAttributesVirtuals")), false);
});

test("a failing PATCH still cleans up the draft and reports the PATCH error", async () => {
  const { client, calls } = fakeIfs({ override: (c) => (c.method === "PATCH" && c.body.includes("TextFormat") ? res(400, { error: { message: "bad format" } }) : null) });
  await assert.rejects(deployCustomLu(client, { lu: demo([{ name: "A", type: "NUMBER" }]), permissionSetIds: [], uuid: uuid() }), /^Error: Attribute A: set TextFormat failed — bad format$/);
  assert.ok(calls.some((c) => c.path.endsWith("_CleanupVirtualEntity")));
  assert.equal(calls.some((c) => c.path.endsWith("_CreateCustomAttributes")), false);
});

test("a failing cleanup after a failure does not hide the original error", async () => {
  const { client } = fakeIfs({ override: (c) => {
    if (c.method === "PATCH") return res(400, { error: { message: "first" } });
    if (c.path.endsWith("_CleanupVirtualEntity")) return res(500, { error: { message: "cleanup" } });
    return null;
  } });
  await assert.rejects(deployCustomLu(client, { lu: demo([{ name: "A", type: "NUMBER" }]), permissionSetIds: [], uuid: uuid() }), /set CustomAttributeType failed — first$/);
});

test("Approve LU error shows the ORA text verbatim", async () => {
  const body = { error: { code: "DATABASE_ERROR", message: "Database error occurred. Contact administrator.", details: [{ code: 20105, message: "ORA-20105: CustomLus.CFLU_NO_PERS_APPROV: There must be at least one persistent attribute in order to approve \"Demo\"." }] } };
  const { client } = fakeIfs({ override: (c) => (c.path.endsWith("/Approve") ? res(500, body) : null) });
  await assert.rejects(deployCustomLu(client, { lu: demo([{ name: "A", type: "NUMBER" }]), permissionSetIds: [], uuid: uuid() }),
    /^Error: Approve LU failed — ORA-20105: CustomLus\.CFLU_NO_PERS_APPROV: There must be at least one persistent attribute in order to approve "Demo"\.$/);
});

test("existing LU: skips LU creation and existing attributes, warns on mismatch, approves leftovers", async () => {
  const { client, calls } = fakeIfs({ existingLu: true, existingAttributes: [
    { AttributeName: "NOTE", DataType: "STRING", DataLength: "100", Published: true },
    { AttributeName: "QTY", DataType: "STRING", DataLength: "100", Published: false }
  ] });
  const outcome = await deployCustomLu(client, { lu: demo([{ name: "NOTE", type: "STRING" }, { name: "QTY", type: "NUMBER" }, { name: "DUE", type: "DATE" }]), permissionSetIds: [], uuid: uuid() });
  assert.equal(calls.some((c) => c.path.includes("ValidateLu(") || c.path.includes("select-fields=")), false);
  assert.deepEqual(outcome.created, ["DUE"]);
  assert.deepEqual(outcome.skipped, ["NOTE", "QTY"]);
  assert.deepEqual(outcome.mismatches.map((m) => m.name), ["QTY"]);
  assert.deepEqual(outcome.approved, ["DUE", "QTY"]);
  assert.equal(outcome.createdLu, false);
  const batch = calls.find((c) => c.path.endsWith("/$batch")).body;
  assert.match(batch, /"AttributeName":"DUE"/);
  assert.match(batch, /"AttributeName":"QTY"/);
});

test("existing LU with nothing new and nothing unapproved only grants", async () => {
  const { client, calls } = fakeIfs({ existingLu: true, existingAttributes: [{ AttributeName: "NOTE", DataType: "STRING", DataLength: "100", Published: true }] });
  const outcome = await deployCustomLu(client, { lu: demo([{ name: "NOTE", type: "STRING" }]), permissionSetIds: ["SALES"], uuid: uuid() });
  assert.deepEqual(calls.map(label), ["GET CustomLusSet(key)", "GET CustomLusSet(key)/CustomFieldAttributesArray", "POST GrantProjections"]);
  assert.equal(outcome.published, false);
  assert.ok(calls[0].path.includes("$select=Lu,LuType,Prompt,PublishedDb,SynchronizedDb"));
});

test("existing LU out of sync with nothing new re-runs Approve and Publish", async () => {
  const { client, calls } = fakeIfs({ existingLu: true, luState: { PublishedDb: true, SynchronizedDb: false }, existingAttributes: [{ AttributeName: "NOTE", DataType: "STRING", DataLength: "100", Published: true }] });
  const outcome = await deployCustomLu(client, { lu: demo([{ name: "NOTE", type: "STRING" }]), permissionSetIds: [], uuid: uuid() });
  assert.deepEqual(calls.map(label), ["GET CustomLusSet(key)", "GET CustomLusSet(key)/CustomFieldAttributesArray", "POST Approve", "POST Publish"]);
  assert.equal(outcome.published, true);
  assert.deepEqual(outcome.approved, []);
});

test("never-published existing LU re-runs Approve and Publish", async () => {
  const { client, calls } = fakeIfs({ existingLu: true, luState: { PublishedDb: false, SynchronizedDb: false }, existingAttributes: [{ AttributeName: "NOTE", DataType: "STRING", DataLength: "100", Published: true }] });
  const outcome = await deployCustomLu(client, { lu: demo([{ name: "NOTE", type: "STRING" }]), permissionSetIds: [], uuid: uuid() });
  assert.deepEqual(calls.map(label), ["GET CustomLusSet(key)", "GET CustomLusSet(key)/CustomFieldAttributesArray", "POST Approve", "POST Publish"]);
  assert.equal(outcome.published, true);
  assert.deepEqual(outcome.approved, []);
});

test("an invalid definition is refused before any IFS call", async () => {
  const { client, calls } = fakeIfs();
  await assert.rejects(deployCustomLu(client, { lu: demo([{ name: "1A", type: "STRING" }]), permissionSetIds: [], uuid: uuid() }), /First letter should be an uppercase alpha character/);
  assert.equal(calls.length, 0);
});

test("deployAll isolates failures per LU", async () => {
  const { client } = fakeIfs({ override: (c) => (c.path.includes("ValidateLu(Lu='Bad')") ? res(500, { error: { message: "nope" } }) : null) });
  const results = await deployAll(client, [normalizeLu({ name: "Bad", attributes: [{ name: "A", type: "NUMBER" }] }), demo([{ name: "B", type: "NUMBER" }])], { permissionSetIds: [], uuid: uuid() });
  assert.deepEqual(results.map((r) => [r.name, r.ok]), [["Bad", false], ["Demo", true]]);
  assert.equal(results[0].error, "Validate LU name failed — nope");
});

test("listCustomLus pages through CustomLusSet and keeps CUSTOM_LU rows", async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ Lu: `Lu${String(i).padStart(3, "0")}`, LuType: "CUSTOM_LU" }));
  const { client, calls } = fakeIfs({ override: (c) => {
    if (!c.path.includes("/CustomLusSet?$select=")) return null;
    return c.path.includes("$skip=0") ? res(200, { value: page1 }) : res(200, { value: [{ Lu: "Zed", LuType: "CUSTOM_LU" }, { Lu: "Other", LuType: "CUSTOM_PAGE" }] });
  } });
  const lus = await listCustomLus(client);
  assert.equal(lus.length, 101);
  assert.equal(lus[100].name, "Zed");
  assert.equal(calls.length, 2);
  assert.match(calls[0].path, /CustomLusSet\?\$select=Lu,LuType,Objgrants,luname,keyref&use-timezone-filter=false&\$skip=0&\$top=100$/);
});

test("getCustomLuDefinition maps IFS attribute rows", async () => {
  const { client } = fakeIfs({ existingLu: true, existingAttributes: [
    { AttributeName: "NOTE", DataType: "STRING", DataLength: "4000", Prompt: "Note", Published: true },
    { AttributeName: "QWE", DataType: "NUMBER", DataLength: null, Prompt: "Qwe", Published: false }
  ] });
  assert.deepEqual(await getCustomLuDefinition(client, "Demo"), {
    name: "Demo", prompt: "Demo LU",
    attributes: [
      { name: "NOTE", prompt: "Note", type: "STRING", length: 4000, published: true },
      { name: "QWE", prompt: "Qwe", type: "NUMBER", published: false }
    ]
  });
});

test("getCustomLuDefinition on a missing LU says so", async () => {
  const { client } = fakeIfs();
  await assert.rejects(getCustomLuDefinition(client, "Demo"), /Custom LU "Demo" was not found on this instance\./);
});

test("deployAll reports each step before it runs, per LU", async () => {
  const { client } = fakeIfs();
  const seen = [];
  await deployAll(client, [demo([{ name: "QTY", type: "NUMBER" }])], { permissionSetIds: ["SALES"], uuid: uuid(), onProgress: (p) => seen.push(p) });
  assert.ok(seen.every((p) => p.name === "Demo" && p.index === 0 && p.total === 1));
  assert.deepEqual(seen.map((p) => p.step), [
    "Check for an existing LU", "Validate LU name", "Create LU",
    "Attribute QTY: validate name", "Attribute QTY: create draft", "Attribute QTY: prepare draft",
    "Attribute QTY: set CustomAttributeType", "Attribute QTY: set TextFormat", "Attribute QTY: set DataType, Indexed", "Attribute QTY: set AttributeName, Prompt",
    "Attribute QTY: save", "Attribute QTY: clean up draft",
    "Approve attributes", "Approve LU", "Publish LU", "Grant to permission set SALES"
  ]);
});

test("a failed grant keeps the LU deployed and is reported per permission set", async () => {
  const { client } = fakeIfs({ override: (c) => (c.path.endsWith("/GrantProjections") && c.body.includes("BAD") ? res(500, { error: { message: "The Fnd Projection does not exist." } }) : null) });
  const outcome = await deployCustomLu(client, { lu: demo([{ name: "NOTE", type: "STRING" }]), permissionSetIds: ["BAD", "SALES"], uuid: uuid() });
  assert.equal(outcome.published, true);
  assert.deepEqual(outcome.granted, ["SALES"]);
  assert.deepEqual(outcome.grantErrors.map((g) => g.role), ["BAD"]);
  assert.match(outcome.grantErrors[0].message, /Grant to permission set BAD failed .*The Fnd Projection does not exist/);
});
