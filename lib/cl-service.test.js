const test = require("node:test");
const assert = require("node:assert/strict");
const { createQrHistory } = require("./qr-history.js");
const { createClService } = require("./cl-service.js");

const IFS = "https://ifs.example.com";
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body ?? "")) });

function setup({ ifs } = {}) {
  const data = {};
  const storage = { get: async (k) => ({ [k]: data[k] }), set: async (o) => { Object.assign(data, o); } };
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ host: u.host, method: init.method || "GET", path: decodeURIComponent(u.pathname) + u.search });
    if (u.host === "api.github.com") {
      if (u.pathname === "/repos/team/qr-data") return res(200, { default_branch: "main" });
      if (u.pathname.startsWith("/repos/team/qr-data/git/trees/")) return res(200, { tree: [] });
      if (init.method === "PUT") return res(201, { content: { sha: "s" } });
    }
    if (u.host === "ifs.example.com" && ifs) return ifs(init.method || "GET", decodeURIComponent(u.pathname) + u.search);
    throw new Error(`unexpected ${init.method} ${url}`);
  };
  const service = createClService({
    instanceStore: { getIfsAuthToken: async () => "T", clearIfsAuthToken: () => {} },
    settings: { getToken: async () => "gh", get: async () => ({ repo: "team/qr-data", login: "alice" }) },
    history: createQrHistory(storage),
    fetchImpl,
    uuid: () => "b"
  });
  return { service, calls, history: createQrHistory(storage) };
}

test("createInLibrary normalizes and saves under my login", async () => {
  const { service, calls } = setup();
  const saved = await service.createInLibrary("K", { name: " Demo ", attributes: [{ name: "note", type: "STRING" }] });
  assert.deepEqual(saved, { id: "demo", name: "Demo", prompt: "Demo", attributes: [{ name: "NOTE", prompt: "Note", type: "STRING", length: 100 }] });
  assert.ok(calls.some((c) => c.method === "PUT" && c.path === "/repos/team/qr-data/contents/custom-lus/alice/demo.json"));
});

test("createInLibrary refuses an invalid LU before calling GitHub", async () => {
  const { service, calls } = setup();
  await assert.rejects(service.createInLibrary("K", { name: "My LU", attributes: [{ name: "A", type: "STRING" }] }), /LU name: letters, digits and _ only/);
  assert.equal(calls.length, 0);
});

test("deploy remembers permission sets only when an LU deployed", async () => {
  const ok = (m, p) => {
    if (m === "GET" && p.includes("?$select=Lu,LuType,Prompt")) return res(404, {});
    if (m === "GET") return res(204);
    if (p.endsWith("/CustomAttributesVirtuals")) return res(201, { Objkey: "O", "@odata.etag": "E" });
    if (p.endsWith("/$batch")) return res(200, "HTTP/1.1 204 No Content");
    return res(204);
  };
  const good = setup({ ifs: ok });
  const results = await good.service.deploy("K", { baseUrl: IFS + "/main", lus: [{ name: "Demo", attributes: [{ name: "a", type: "NUMBER" }] }], permissionSetIds: ["SALES"] });
  assert.deepEqual(results.map((r) => r.ok), [true]);
  assert.deepEqual(await good.history.getPermissionSetMemory(IFS), ["SALES"]);

  const bad = setup({ ifs: () => res(500, { error: { message: "down" } }) });
  const failed = await bad.service.deploy("K", { baseUrl: IFS, lus: [{ name: "Demo", attributes: [{ name: "A", type: "NUMBER" }] }], permissionSetIds: ["SALES"] });
  assert.equal(failed[0].ok, false);
  assert.deepEqual(await bad.history.getPermissionSetMemory(IFS), []);
});

test("listEnvironment and getEnvironmentLu read the instance", async () => {
  const { service } = setup({ ifs: (m, p) => {
    if (p.includes("/CustomLusSet?$select=")) return res(200, { value: [{ Lu: "Demo", LuType: "CUSTOM_LU" }] });
    if (p.includes("?$select=Lu,LuType,Prompt")) return res(200, { Lu: "Demo", Prompt: "Demo" });
    if (p.includes("/CustomFieldAttributesArray")) return res(200, { value: [{ AttributeName: "A", DataType: "NUMBER", Prompt: "A", Published: true }] });
    throw new Error(p);
  } });
  assert.deepEqual(await service.listEnvironment(IFS, "K"), [{ name: "Demo" }]);
  assert.equal((await service.getEnvironmentLu(IFS, "K", "Demo")).attributes[0].type, "NUMBER");
});
