const test = require("node:test");
const assert = require("node:assert/strict");
const Fuse = require("./vendor/fuse.min.js");
const { createQrSearch } = require("./qr-search.js");

const reports = [
  { id: "open-orders", name: "Open customer orders", content: "SELECT * FROM customer_order WHERE state = 'Released'" },
  { id: "stock", name: "Stock per site", content: "SELECT contract, SUM(qty_onhand) FROM inventory_part_in_stock GROUP BY contract" }
];

test("empty or blank term returns every report in original order", () => {
  const search = createQrSearch(reports, Fuse);
  assert.deepEqual(search.search("").map((r) => r.id), ["open-orders", "stock"]);
  assert.deepEqual(search.search("   ").map((r) => r.id), ["open-orders", "stock"]);
});

test("matches on name and on SQL body, fuzzily", () => {
  const search = createQrSearch(reports, Fuse);
  assert.deepEqual(search.search("custmer").map((r) => r.id), ["open-orders"]);
  assert.deepEqual(search.search("qty_onhand").map((r) => r.id), ["stock"]);
});
