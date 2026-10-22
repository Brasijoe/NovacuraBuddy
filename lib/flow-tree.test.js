const test = require("node:test");
const assert = require("node:assert/strict");
const { dependencyTree, summarize, exportName } = require("./flow-tree.js");

const pkg = {
  rootIds: ["order", "unused", "shop"],
  assets: {
    order: { name: "Order", type: "component", designer: { assets: [{ assetId: "shop" }, { assetId: "pick" }], data: [{ configuration: { connector: { id: "c1", name: "IFS" } } }] } },
    pick: { name: "Pick", type: "component", designer: { assets: [{ assetId: "shop" }, { assetId: "order" }], data: [] } },
    shop: { name: "Shop", type: "module", source: "" },
    unused: { name: "Unused", type: "module", source: "" }
  }
};

test("dependencyTree nests what each flow uses, expands shared assets once, and survives cycles", () => {
  const tree = dependencyTree(pkg);
  assert.deepEqual(tree.map((n) => n.name), ["Order", "Unused"], "Shop is shown inside Order, not again at the top");
  const [order] = tree;
  assert.deepEqual(order.children.map((n) => [n.name, n.type, n.repeat]), [["Pick", "component", false], ["Shop", "module", true], ["IFS", "connector", false]]);
  const pick = order.children[0];
  assert.deepEqual(pick.children.map((n) => [n.name, n.repeat]), [["Order", true], ["Shop", false]], "Shop is expanded where it shows first: inside Pick, which comes before Shop in Order");
  assert.equal(order.children[1].repeat, true);
});

test("summarize counts flows, modules and other assets", () => {
  assert.deepEqual(summarize(pkg), { flows: 2, modules: 2, other: 0 });
});

test("exportName keeps whole names that fit, then counts the rest", () => {
  assert.equal(exportName(["JOSTDE", "IVSTDE", "A", "B", "C", "D", "E"], 14), "JOSTDE IVSTDE +5 others");
  assert.equal(exportName(["Order Picking"], 60), "Order Picking");
  assert.equal(exportName(["A", "B"], 60), "A B");
  assert.equal(exportName(["x".repeat(80), "B"], 30), "x".repeat(29) + "… +1 other");
  assert.equal(exportName(["a/b:c"], 60), "a_b_c");
  assert.equal(exportName([], 60), "Flow export");
});
