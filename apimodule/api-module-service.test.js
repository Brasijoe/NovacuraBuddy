const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchSpec, saveModule } = require("./api-module-service.js");

function fakeStore() {
  const calls = [];
  return {
    calls,
    listInstances: async () => [{ name: "UAT", baseUrl: "https://ifs-uat.example.com" }],
    getIfsAuthToken: async (baseUrl, key) => { calls.push([baseUrl, key]); return "ifs-token"; }
  };
}

const okText = (text, extra = {}) => ({ ok: true, status: 200, text: async () => text, headers: { get: () => "application/json" }, ...extra });

test("a spec on a Basic Data IFS instance is fetched with that instance's token", async () => {
  const store = fakeStore();
  let seen;
  const result = await fetchSpec({
    url: "https://ifs-uat.example.com/main/ifsapplications/projection/v1/X.svc/openapi.json",
    instanceStore: store,
    getMasterKey: async () => "mk",
    fetchImpl: async (url, init) => { seen = { url, init }; return okText("{}"); }
  });
  assert.deepEqual(store.calls, [["https://ifs-uat.example.com", "mk"]]);
  assert.equal(seen.init.headers.Authorization, "Bearer ifs-token");
  assert.equal(seen.init.credentials, "omit");
  assert.equal(result.instanceName, "UAT");
  assert.equal(result.text, "{}");
  assert.equal(result.contentType, "application/json");
});

test("any other https spec goes out with the browser's cookies and no token; the master password is not needed", async () => {
  const store = fakeStore();
  let seen;
  const result = await fetchSpec({
    url: "https://api.vendor.test/openapi.yaml",
    instanceStore: store,
    getMasterKey: async () => { throw new Error("must not unlock"); },
    fetchImpl: async (url, init) => { seen = init; return okText("openapi: 3.0.0", { url: "https://api.vendor.test/v2/openapi.yaml" }); }
  });
  assert.equal(seen.headers.Authorization, undefined);
  assert.equal(seen.credentials, "include");
  assert.equal(result.url, "https://api.vendor.test/v2/openapi.yaml");
  assert.equal(result.instanceName, null);
});

test("http, bad URLs and failed responses give a readable error", async () => {
  const base = { instanceStore: fakeStore(), getMasterKey: async () => "mk" };
  await assert.rejects(fetchSpec({ ...base, url: "http://x.test/a.json", fetchImpl: async () => okText("") }), /Only https/);
  await assert.rejects(fetchSpec({ ...base, url: "not a url", fetchImpl: async () => okText("") }), /Not a valid URL/);
  await assert.rejects(
    fetchSpec({ ...base, url: "https://x.test/a.json", fetchImpl: async () => ({ ok: false, status: 404, text: async () => "Not here" }) }),
    /HTTP 404\): Not here/
  );
});

test("saveModule refuses an invalid module name or empty code before touching Flow", async () => {
  const flowFetch = async () => { throw new Error("must not be called"); };
  await assert.rejects(saveModule({ flowFetch, orgId: "o", packageId: "p", moduleName: "1bad", code: "x" }), /not a valid module name/);
  await assert.rejects(saveModule({ flowFetch, orgId: "o", packageId: "p", moduleName: "Good", code: "  " }), /No module code/);
});
