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

test("the LLM document carries instructions, org name, visualisation help, resolved names and the design system", () => {
  const chain = { nodes: [{ type: "eventAction", data: { eventId: "EV1" } }, { type: "endpoint", data: { url: "u" } }] };
  const files = FD.buildDocs({ pkg, rootId: "order", usedBy: {}, ifs: { instanceName: "TEST", scannedAt: "d", chains: { order: [chain] } }, orgName: "Acme" });
  const llm = files["llm-context.md"];
  for (const needle of ["## Instructions for LLMs", "### How to visualise the dependencies", "### Dependency map", "Flow organisation: Acme", "Pick (flow)", "## Data H — Novacura design system", "#0C65F4", "Montserrat", "classDef ifs"]) assert.ok(llm.includes(needle), needle);
  assert.ok(!llm.includes("Flow organisation: org1"));
  assert.ok(!FD.buildDocs({ pkg, rootId: "order", usedBy: null, ifs: null, design: false })["llm-context.md"].includes("Data H"));
});

test("the LLM file tells the LLM what to create: eight chapters, trigger, SIPOC, participants, dependencies", () => {
  const designer = { data: [{ type: "step-created", id: "e", label: "Every hour", stepType: "event", configuration: { triggerConfiguration: { interval: 1, unit: "hours" } } }], parameterTypeExpression: "{}", resultTypeExpression: "{}", assets: [] };
  const p = { source: { orgId: "o" }, connectors: [{ name: "ERP", type: "rest" }], assets: { r: { id: "r", name: "Nightly", type: "component", designer } } };
  const llm = FD.buildDocs({ pkg: p, rootId: "r", usedBy: null, ifs: null, products: [{ type: "automation", name: "Nightly job" }], contributors: [] })["llm-context.md"];
  for (const needle of ["**1. Name**", "**2. Type**", "**3. Business purpose**", "**4. Systems involved**", "**5. Trigger**", "**6. Process / flow**", "SIPOC", "**7. Participants**", "**8. Known dependencies**", "date format of the user's settings", "look at the file and follow its instructions", "Suggested trigger: **Scheduled**", "every 1 hours", "Kind: Automation \"Nightly job\"", "Connector **ERP**", "BPM mode: **detailed**", "Continue into the fragments", "selected from"]) assert.ok(llm.includes(needle), needle);
  assert.ok(llm.indexOf("## Instructions for LLMs") < llm.indexOf("# SOURCE DATA"));
});

test("customObjects lists each IFS custom object once, with the assets using it", () => {
  const p = { source: { orgId: "o" }, assets: {
    f: { id: "f", name: "F", type: "component", designer: { data: [{ configuration: { sql: "select CF$_COLOR, cf_size from PART_CATALOG_CFV" } }] } },
    m: { id: "m", name: "M", type: "module", source: "x PART_CATALOG_CFV y ORDER_CFP /p/QuickReport123.svc /p/CustomThing.svc /main/Std.svc" }
  } };
  const found = FD.customObjects(p, { CustomThing: "CustomEntity", Std: "" });
  const names = found.map((o) => `${o.kind}|${o.name}|${o.usedIn.join("+")}`);
  assert.deepEqual(names, [
    "custom field|cf_size|F", "custom field|CF$_COLOR|F", "custom LU projection|CustomThing|M",
    "custom package|ORDER_CFP|M", "custom view|PART_CATALOG_CFV|F+M", "quick report projection|QuickReport123|M"
  ]);
  assert.equal(found.filter((o) => o.name === "PART_CATALOG_CFV").length, 1);
  assert.deepEqual(found.find((o) => o.name === "CF$_COLOR").selectedFrom, ["PART_CATALOG_CFV"]);
  assert.match(FD.buildDocs({ pkg: p, rootId: "f", usedBy: null, ifs: null })["llm-context.md"], /## IFS custom objects/);
});

test("contributorsOf lists last committers and savers, the root's committer first", async () => {
  const scanAssets = [
    { id: "a", name: "A", mainBranch: { lastSaveUserId: "u2", latestCommitted: { lastSaveUserId: "u1", timestamp: "2026-01-02" } } },
    { id: "b", name: "B", mainBranch: { lastSaveUserId: "u2", latestCommitted: { lastSaveUserId: "u2", timestamp: "2026-01-01" } } }
  ];
  const list = FD.contributorsOf({ scanAssets, assetIds: ["a", "b"], rootId: "a", users: { u1: { name: "Zed", email: "z@x" }, u2: { name: "Amy", email: "" } } });
  assert.deepEqual(list.map((p) => p.name), ["Zed", "Amy"]);
  assert.deepEqual(list[1].saved, ["A"]);
  assert.deepEqual(list[1].committed, ["B"]);
  const users = await FD.readUsers({ orgId: "o", flowFetch: async () => ({ ok: true, json: async () => [{ id: "u1", name: "Zed", email: "z@x" }] }) });
  assert.equal(users.u1.name, "Zed");
});
