const test = require("node:test");
const assert = require("node:assert/strict");
global.FlowConnectRest = require("./flow-connect-rest.js");
const FlowEnvironments = require("./flow-environments.js");

const res = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });

test("environments are sorted by order and PROD is told apart by type or name", () => {
  const envs = FlowEnvironments.normalizeEnvironments([
    { id: "p", name: "Live", type: 2, order: 3 },
    { id: "d", name: "Development", type: 0, order: 1 },
    { id: "t", name: "ACME-PRD", type: -1, order: 2 }
  ]);
  assert.deepEqual(envs.map((e) => [e.id, e.type, e.isProduction]), [["d", "dev", false], ["t", "unknown", true], ["p", "prod", true]]);
});

test("deploy posts the head version with the flow's asset references", async () => {
  const calls = [];
  const flowFetch = async (path, options = {}) => {
    calls.push({ path, method: options.method || "GET", body: options.body && JSON.parse(options.body) });
    if (path.endsWith("/designer")) return res(200, { assets: [{ assetId: "m1", assetVersion: "v1" }], data: [] });
    return res(200, { id: "r1" });
  };
  const out = await FlowEnvironments.deploy({ flowFetch, orgId: "org", envId: "e1", flows: [{ id: "f1", packageId: "p1", headVersionId: "h1" }, { id: "f2", packageId: null, headVersionId: "h2" }] });
  assert.deepEqual(out.map((r) => r.ok), [true, false]);
  const post = calls.find((c) => c.method === "POST");
  assert.equal(post.path, "/admin/application/api/v2/organisations/org/packages/p1/products/f1/versions/h1/environments/e1/deploy");
  assert.deepEqual(post.body, { assets: [{ assetId: "m1", assetVersion: "v1", usedIndirectly: false }] });
});
