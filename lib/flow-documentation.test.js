const test = require("node:test");
const assert = require("node:assert/strict");
const FD = require("./flow-documentation.js");

const pkg = {
  source: { orgId: "org1" },
  connectors: [{ name: "IFS", type: "rest" }],
  warnings: [],
  assets: {
    order: { id: "order", name: "Order", type: "component", description: "Takes an order", packageId: "p1", designer: {
      assets: [{ assetId: "pick" }, { assetId: "shop" }], parameterTypeExpression: "{id:text}", resultTypeExpression: "{}",
      data: [
        { type: "step-created", id: "a", label: "Start", stepType: "start" },
        { type: "step-created", id: "b", label: "Pick", stepType: "flow", configuration: { assetId: "pick" } },
        { type: "arrow-created", id: "x", from: "a", to: "b" }
      ] } },
    pick: { id: "pick", name: "Pick", type: "component", designer: { assets: [{ assetId: "shop" }, { assetId: "order" }], data: [], parameterTypeExpression: "{}", resultTypeExpression: "{}" } },
    shop: { id: "shop", name: "Shop", type: "module", source: "function a() {}" }
  }
};

test("computeUsedBy lists the flows that reference an asset", () => {
  const assets = [{ id: "order", name: "Order", type: "component", packageName: "P" }, { id: "pick", name: "Pick", type: "component", packageName: "P" }];
  const usedBy = FD.computeUsedBy(assets, { order: ["pick", "shop"], pick: ["shop", "shop"] });
  assert.deepEqual(usedBy.shop.map((u) => u.name), ["Order", "Pick"]);
  assert.deepEqual(usedBy.pick.map((u) => u.name), ["Order"]);
});

test("orderAssets walks the dependencies depth first, once each, despite cycles", () => {
  assert.deepEqual(FD.orderAssets(pkg, "order"), ["order", "pick", "shop"]);
});

test("describeFlow reads steps and arrows; mermaid is built from them", () => {
  const d = FD.describeFlow(pkg.assets.order.designer);
  assert.deepEqual(d.steps.map((s) => s.label), ["Start", "Pick"]);
  assert.match(FD.mermaidFor(d), /s0\["Start"\]\n.*\n.*s0 --> s1/s);
  assert.equal(FD.mermaidFor({ steps: d.steps, arrows: [] }), null);
});

test("buildDocs documents every used asset, where-used and IFS callers", () => {
  const chain = { nodes: [{ type: "eventAction", data: { eventId: "EV1" } }, { type: "endpoint", data: { url: "https://run.novacura.com/x/y" } }] };
  const files = FD.buildDocs({
    pkg, rootId: "order", usedBy: { order: [{ id: "m", name: "Menu", type: "component", packageName: "P" }] },
    ifs: { instanceName: "TEST", scannedAt: "2026-10-23", chains: { order: [chain] } }, expiresAt: "2026-10-23T16:00Z", notes: "Be careful."
  });
  const llm = files["llm-context.md"];
  for (const needle of ["## Order (flow)", "### Pick (flow)", "### Shop (module)", "function a() {}", "Menu (component, package P)", "eventAction EV1 → endpoint", "expires: 2026-10-23T16:00Z", "Be careful.", "flowchart TD"]) {
    assert.ok(llm.includes(needle), needle);
  }
  assert.ok(!files["README.md"].includes("function a() {}"), "README leaves out module source");
  assert.equal(JSON.parse(files["flow.json"]).rootId, undefined);
});

test("without where-used or IFS the docs say so instead of claiming nothing was found", () => {
  const llm = FD.buildDocs({ pkg, rootId: "order", usedBy: null, ifs: null })["llm-context.md"];
  assert.match(llm, /Where-used: not read/);
  assert.match(llm, /IFS dependencies: not included/);
});

test("the LLM document carries instructions, org name, visualisation help, resolved names and design guidance", () => {
  const chain = { nodes: [{ type: "eventAction", data: { eventId: "EV1" } }, { type: "endpoint", data: { url: "u" } }] };
  const files = FD.buildDocs({ pkg, rootId: "order", usedBy: {}, ifs: { instanceName: "TEST", scannedAt: "d", chains: { order: [chain] } }, orgName: "Acme" });
  const llm = files["llm-context.md"];
  for (const needle of ["## Instructions for LLMs", "### How to visualise the dependencies", "## Dependency map", "Flow organisation: Acme", "Pick (flow)", "## Novacura design guidance", "#0c65f4", "classDef ifs"]) assert.ok(llm.includes(needle), needle);
  assert.ok(!llm.includes("Flow organisation: org1"));
  assert.ok(!FD.buildDocs({ pkg, rootId: "order", usedBy: null, ifs: null, design: false })["llm-context.md"].includes("design guidance"));
});
