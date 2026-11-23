const test = require("node:test");
const assert = require("node:assert");
const EC = require("./entity-check.js");

test("namesInText finds .svc projections once", () => {
  assert.deepEqual(EC.namesInText("a /main/x/CustomerOrderHandling.svc/Foo and /int/CustomerOrderHandling.svc/Bar /PartHandling.svc"), ["CustomerOrderHandling", "PartHandling"]);
});

test("buildRows states and sorting", () => {
  const usage = EC.addUsage(new Map(), ["B", "A", "C"], "Flow 1");
  EC.addUsage(usage, ["A"], "Flow 2");
  const rows = EC.buildRows(usage, { a: { Active: true, Component: "ORDER" }, b: { Active: false, Deprecated: true } });
  assert.deepEqual(rows.map((r) => [r.projection, r.state]), [["A", "enabled"], ["B", "disabled"], ["C", "missing"]]);
  assert.deepEqual(rows[0].usedIn, ["Flow 1", "Flow 2"]);
  assert.equal(rows[1].deprecated, true);
});

test("matches needs every word", () => {
  const row = { projection: "PartHandling", component: "PARTCA", state: "disabled", usedIn: ["Flow X"] };
  assert.ok(EC.matches(row, "part disabled"));
  assert.ok(!EC.matches(row, "part enabled"));
  assert.ok(EC.matches(row, ""));
});

test("setActive patches and reads back", async () => {
  let active = false; const calls = [];
  const client = {
    getOData: async () => ({ "@odata.etag": "W/\"1\"" }),
    patchOData: async (p, body, etag) => { calls.push([p, body, etag]); active = body.Active; },
    get: async () => ({ value: [{ ProjectionName: "X", Active: active }] })
  };
  await EC.setActive(client, "X", true);
  assert.deepEqual(calls[0][1], { Active: true });
  client.patchOData = async () => {};
  await assert.rejects(() => EC.setActive(client, "X", false), /still enabled/);
});
