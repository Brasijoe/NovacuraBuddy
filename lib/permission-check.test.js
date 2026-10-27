const test = require("node:test");
const assert = require("node:assert/strict");
const PC = require("./permission-check.js");
const FD = require("./flow-documentation.js");

const pkg = { assets: {
  a: { name: "Flow A", designer: { data: [{ configuration: { url: "https://x/main/ifsapplications/projection/v1/CustomerOrderHandling.svc/Entity" } }] } },
  b: { name: "Module B", source: "#importSource /main/ifsapplications/projection/v1/CustomerOrderHandling.svc\n" },
  c: { name: "Module C", source: "x /int/ifsapplications/projection/v1/ShopOrdHandling.svc" }
} };

test("projectionUsage lists each projection once with the assets that use it", () => {
  const rows = PC.projectionUsage(pkg, FD.projectionNamesIn);
  assert.deepEqual(rows, [
    { projection: "CustomerOrderHandling", assets: ["Flow A", "Module B"] },
    { projection: "ShopOrdHandling", assets: ["Module C"] }
  ]);
});

test("compare splits required projections into missing and granted, ignoring case", () => {
  const rows = PC.projectionUsage(pkg, FD.projectionNamesIn);
  const r = PC.compare(rows, ["customerorderhandling"]);
  assert.deepEqual(r.missing.map((x) => x.projection), ["ShopOrdHandling"]);
  assert.deepEqual(r.granted.map((x) => x.projection), ["CustomerOrderHandling"]);
});
