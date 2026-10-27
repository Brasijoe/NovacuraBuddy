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

test("usageByConnector gives a connector its steps' projections and those of the modules its step opens", () => {
  const p = { assets: {
    f: { name: "Flow", designer: { data: [
      { id: "1", configuration: { connector: { id: "c1", name: "IFS user", type: "rest" }, url: "/main/ifsapplications/projection/v1/CustomerOrderHandling.svc/X" } },
      { id: "2", configuration: { connector: { id: "c2", name: "IFS iam", type: "rest" }, script: "open ShopMod;\nShopMod.getOrders()" } },
      { id: "3", configuration: { url: "/main/ifsapplications/projection/v1/DirectHandling.svc/Z" } }
    ] } },
    shop: { name: "ShopMod", source: "x /main/ifsapplications/projection/v1/ShopOrdHandling.svc" },
    other: { name: "OtherMod", source: "/main/ifsapplications/projection/v1/OtherHandling.svc" }
  } };
  const r = PC.usageByConnector(p, FD.projectionNamesIn);
  assert.deepEqual(r.connectors.map((c) => [c.name, c.projections.map((x) => x.projection), c.projections.map((x) => x.via[0])]),
    [["IFS iam", ["ShopOrdHandling"], ["module ShopMod"]], ["IFS user", ["CustomerOrderHandling"], ["step in Flow"]]]);
  assert.deepEqual(r.noConnector.map((x) => x.projection), ["DirectHandling", "OtherHandling"]);
});
