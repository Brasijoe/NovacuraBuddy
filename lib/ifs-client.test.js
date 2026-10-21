const test = require("node:test");
const assert = require("node:assert/strict");
const { createIfsClient, step, ifsErrorMessage, forInstance } = require("./ifs-client.js");

const BASE = "https://ifs.example.com";
const res = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
  text: async () => (body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body))
});

function recorder(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, ...init }); return responder(url, init, calls); };
  return { calls, client: createIfsClient({ baseUrl: BASE, getToken: async () => "tok", clearToken: () => {}, fetchImpl }) };
}

test("postOData sends the EntityConfigHandling headers, bearer token and If-Match", async () => {
  const { calls, client } = recorder(() => res(200, { ok: 1 }));
  const out = await client.postOData("/x", { A: 1 }, 'W/"E1"');
  assert.deepEqual(out, { ok: 1 });
  assert.equal(calls[0].url, BASE + "/x");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].body, '{"A":1}');
  assert.deepEqual(calls[0].headers, {
    "Content-Type": "application/json;IEEE754Compatible=true",
    Accept: "application/json;odata.metadata=full;IEEE754Compatible=true",
    Prefer: "wait=99999",
    "If-Match": 'W/"E1"',
    Authorization: "Bearer tok"
  });
});

test("postOData without an etag sends no If-Match", async () => {
  const { calls, client } = recorder(() => res(204));
  assert.equal(await client.postOData("/x", {}), undefined);
  assert.equal("If-Match" in calls[0].headers, false);
});

test("patchOData sends PATCH with If-Match", async () => {
  const { calls, client } = recorder(() => res(200, {}));
  await client.patchOData("/v", { B: 2 }, "E");
  assert.equal(calls[0].method, "PATCH");
  assert.equal(calls[0].headers["If-Match"], "E");
});

test("getOData returns undefined on 204 and the JSON on 200", async () => {
  const { client } = recorder((url) => (url.endsWith("/a") ? res(204) : res(200, { value: "x" })));
  assert.equal(await client.getOData("/a"), undefined);
  assert.deepEqual(await client.getOData("/b"), { value: "x" });
});

test("postBatch sends multipart and returns the raw text", async () => {
  const { calls, client } = recorder(() => res(200, "--batch_1\r\nHTTP/1.1 204 No Content\r\n"));
  const text = await client.postBatch("/$batch", "B1", "BODY");
  assert.equal(text, "--batch_1\r\nHTTP/1.1 204 No Content\r\n");
  assert.equal(calls[0].headers["Content-Type"], "multipart/mixed;boundary=B1");
  assert.equal(calls[0].body, "BODY");
});

test("a failed request carries status and body", async () => {
  const body = { error: { code: "DATABASE_ERROR", message: "Database error occurred.", details: [{ code: 20105, message: "ORA-20105: no attribute" }] } };
  const { client } = recorder(() => res(500, body));
  await assert.rejects(client.postOData("/Approve", {}), (err) => {
    assert.equal(err.status, 500);
    assert.equal(err.body, JSON.stringify(body));
    assert.match(err.message, /^IFS request failed \(\/Approve, 500\)/);
    return true;
  });
});

test("ifsErrorMessage prefers details, then message, else null", () => {
  assert.equal(ifsErrorMessage({ body: JSON.stringify({ error: { message: "m", details: [{ message: "d1" }, { message: "d2" }] } }) }), "d1 d2");
  assert.equal(ifsErrorMessage({ body: JSON.stringify({ error: { message: "only" } }) }), "only");
  assert.equal(ifsErrorMessage({ body: "not json" }), null);
  assert.equal(ifsErrorMessage(new Error("x")), null);
});

test("step labels the failure; preferIfsMessage uses the IFS text", async () => {
  const err = Object.assign(new Error("IFS request failed (/Approve, 500): {...}"), { body: JSON.stringify({ error: { details: [{ message: "ORA-20105: no attribute" }] } }) });
  await assert.rejects(step("Approve LU", async () => { throw err; }, { preferIfsMessage: true }), /^Error: Approve LU failed — ORA-20105: no attribute$/);
  await assert.rejects(step("Other", async () => { throw new Error("plain"); }), /^Error: Other failed — plain$/);
});

test("step keeps the first label when nested", async () => {
  await assert.rejects(step("Outer", () => step("Inner", async () => { throw new Error("x"); })), /^Error: Inner failed — x$/);
});

test("forInstance targets the instance origin and uses the store's token", async () => {
  const calls = [];
  const instanceStore = {
    getIfsAuthToken: async (baseUrl, masterKey) => { calls.push(["token", baseUrl, masterKey]); return "T"; },
    clearIfsAuthToken: () => {}
  };
  const fetchImpl = async (url, init) => { calls.push(["fetch", url, init.headers.Authorization]); return res(200, {}); };
  const client = forInstance({ instanceStore, baseUrl: " https://ifs.example.com/main/ ", masterKey: "K", fetchImpl });
  await client.get("/p");
  assert.deepEqual(calls, [["token", " https://ifs.example.com/main/ ", "K"], ["fetch", "https://ifs.example.com/p", "Bearer T"]]);
});
