const test = require("node:test");
const assert = require("node:assert/strict");
const CredentialCrypto = require("./credential-crypto.js");
const { createGithubSettings } = require("./github-settings.js");
const { createQrHistory } = require("./qr-history.js");
const { createQrService } = require("./qr-service.js");

const IFS = "https://ifs.example.com";

function fakeStorage() {
  const data = {};
  return { data, get: async (k) => ({ [k]: data[k] }), set: async (o) => { Object.assign(data, o); } };
}
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body ?? "") });

/** One fetch for both hosts: a tiny GitHub (alice, one report) and a tiny IFS. */
function fakeNet({ ifsExisting = [] } = {}) {
  const calls = [];
  const files = new Map([
    ["quick-reports/alice/r1.sql", { sha: "s1", content: "SELECT 1 FROM dual" }],
    ["quick-reports/alice/r1.json", { sha: "s2", content: JSON.stringify({ id: "r1", name: "Report One", tags: [], createdAt: "c", updatedAt: "u" }) }]
  ]);
  let lob = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const path = decodeURIComponent(u.pathname) + u.search;
    calls.push({ host: u.host, method, path });
    if (u.host === "api.github.com") {
      if (path === "/user") return res(200, { login: "alice" });
      if (path === "/repos/team/qr-data") return res(200, { default_branch: "main" });
      if (path.startsWith("/repos/team/qr-data/git/trees/main")) return res(200, { tree: [...files].map(([p, f]) => ({ path: p, type: "blob", sha: f.sha })) });
      const blob = path.match(/git\/blobs\/(.+)$/);
      if (blob) { const f = [...files.values()].find((x) => x.sha === blob[1]); return res(200, { content: Buffer.from(f.content).toString("base64") }); }
      if (method === "PUT") return res(201, { content: { sha: `new-${calls.length}` } });
    }
    if (u.host === "ifs.example.com") {
      if (method === "GET" && path.includes("QuickReportSet?$select")) return res(200, { value: ifsExisting });
      if (method === "GET" && path.includes("PermissionSets?")) return res(200, { value: [{ Role: "SALES", Description: "Sales", FndRoleDeliveryType: null }] });
      if (method === "POST" && path.endsWith("/FndTempLobs")) { lob++; return res(201, { LobId: `L${lob}`, "@odata.etag": `E${lob}` }); }
      if (method === "PATCH" && path.endsWith("/ClobData")) return res(204);
      if (method === "POST" && path.endsWith("/CheckSqlExpressionAction")) return res(204);
      if (method === "POST" && path.endsWith("/QuickReportVirtualSet")) return res(201, { Objkey: "O1" });
      if (method === "POST" && path.endsWith("/SaveNewAction")) return res(200, { value: "77" });
      if (method === "POST" && path.includes("CleanupVirtualEntity")) return res(204);
      if (method === "GET" && /QuickReportSet\(QuickReportId=77\)$/.test(path)) return res(200, { "@odata.etag": "QE" });
      if (method === "PATCH" && path.includes("QuickReportSet(QuickReportId=77)")) return res(200, { QuickReportId: "77" });
      if (method === "POST" && path.endsWith("/GrantProjections")) return res(204);
    }
    throw new Error(`unexpected ${method} ${u.host}${path}`);
  };
  return { fetchImpl, calls };
}

async function setup(netOpts) {
  const net = fakeNet(netOpts);
  const local = fakeStorage();
  const settings = createGithubSettings(local);
  const masterKey = await CredentialCrypto.deriveKey("pw", CredentialCrypto.generateSalt());
  const instanceStore = { getIfsAuthToken: async () => "IFS-T", clearIfsAuthToken: () => {} };
  const service = createQrService({ instanceStore, settings, history: createQrHistory(local), cacheStorage: local, fetchImpl: net.fetchImpl });
  return { net, local, service, masterKey };
}

const report = { id: "r1", name: "Report One", content: "SELECT 1 FROM dual" };

test("without a GitHub token, listing explains where to add one", async () => {
  const { service, masterKey } = await setup();
  await assert.rejects(service.listReports(masterKey), (e) => e.code === "GITHUB_NOT_CONFIGURED");
});

test("saveGithubSettings checks repo access and the login, then lists that user's reports and caches them", async () => {
  const { service, masterKey } = await setup();
  assert.deepEqual(await service.saveGithubSettings({ token: "ghp", repo: "team/qr-data" }, masterKey), { repo: "team/qr-data", login: "alice" });
  const { reports } = await service.listReports(masterKey);
  assert.deepEqual(reports.map((r) => r.id), ["r1"]);
  const cache = await service.getCachedReports();
  assert.equal(cache.login, "alice");
  assert.deepEqual(cache.reports.map((r) => r.id), ["r1"]);
});

test("changing the repo with the same login invalidates the cached list", async () => {
  const { service, masterKey } = await setup();
  await service.saveGithubSettings({ token: "ghp", repo: "team/qr-data" }, masterKey);
  await service.listReports(masterKey);
  assert.ok(await service.getCachedReports());
  // same login, different configured repo, same stored cache
  const cache = await service.getCachedReports();
  const other = createQrService({ instanceStore: {}, settings: { get: async () => ({ login: "alice", repo: "other/repo" }) }, history: {}, cacheStorage: { get: async () => ({ qrCache: cache }), set: async () => {} }, fetchImpl: null });
  assert.equal(await other.getCachedReports(), null);
  assert.equal(cache.repo, "team/qr-data");
});

test("saveReport checks names against the cached list", async () => {
  const { service, masterKey } = await setup();
  await service.saveGithubSettings({ token: "ghp", repo: "team/qr-data" }, masterKey);
  await service.listReports(masterKey);
  await assert.rejects(service.saveReport(masterKey, { id: null, name: "report one", content: "x", tags: [] }), /already exists/);
  const saved = await service.saveReport(masterKey, { id: null, name: "Report Two", content: "x", tags: [] });
  assert.equal(saved.id, "report-two");
  assert.deepEqual((await service.getCachedReports()).reports.map((r) => r.id), ["r1", "report-two"]);
});

test("deploy records history + memory; the next deploy updates the same IFS record without a name lookup", async () => {
  const { service, masterKey, net } = await setup();
  const first = await service.deploy(masterKey, { baseUrl: `${IFS}/`, report, permissionSetIds: ["SALES"] });
  assert.deepEqual(first, { status: "deployed", quickReportId: "77" });
  const [entry] = await service.historyForReport("r1");
  assert.equal(entry.instanceKey, IFS);
  assert.equal(entry.quickReportId, "77");
  assert.deepEqual((await service.listPermissionSets(IFS, masterKey)).remembered, ["SALES"]);

  net.calls.length = 0;
  await service.deploy(masterKey, { baseUrl: IFS, report, permissionSetIds: [] });
  assert.ok(!net.calls.some((c) => c.path.includes("$filter")));
  assert.ok(net.calls.some((c) => c.method === "PATCH" && c.path.includes("QuickReportSet(QuickReportId=77)")));
});

test("needsConfirmation and failures write no history", async () => {
  const { service, masterKey } = await setup({ ifsExisting: [{ QuickReportId: "5", Description: "Report One" }] });
  const outcome = await service.deploy(masterKey, { baseUrl: IFS, report, permissionSetIds: [] });
  assert.equal(outcome.status, "needsConfirmation");
  assert.deepEqual(await service.historyForInstance(IFS), []);
});

test("listPermissionSets returns the sets and an empty memory at first", async () => {
  const { service, masterKey } = await setup();
  assert.deepEqual(await service.listPermissionSets(IFS, masterKey), { sets: [{ id: "SALES", name: "Sales" }], remembered: [] });
});
