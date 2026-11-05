const test = require("node:test");
const assert = require("node:assert");
const { buildLlmExport } = require("./flow-deps-export.js");

const chain = [
  { type: "event", data: { eventId: "CO_RELEASED", eventLuName: "CustomerOrder" } },
  { type: "eventAction", data: { actionType: "ApplicationMessage", enabled: false, published: true, raw: { secret: "x" } } },
  { type: "routingRule", data: { ruleName: "NcQuery", queue: "NOTIFICATIONS", messageFunctions: ["CO_RELEASED"], enabled: true } },
  { type: "routingAddress", data: { addressName: "NcQuery", restRootEndPoint: "https://run.novacura.com/E/abc12345" } },
  { type: "endpoint", data: { url: "https://run.novacura.com/E/abc12345" } }
];
const flowIndex = { packages: [], assets: [], products: [], webhooks: [{ url: "https://run.novacura.com/E/abc12345", automationId: "a", automationName: "QueryParams", packageId: "P", packageName: "ALLUSE" }] };

test("export names package and automation and flags disabled objects", () => {
  const md = buildLlmExport({ result: { chains: [{ nodes: chain }], scannedAt: 0, patterns: ["run.novacura.com"], errors: [] }, flowIndex, instanceName: "TEST" });
  assert.match(md, /source data/);
  assert.match(md, /### Package: ALLUSE/);
  assert.match(md, /Automation: QueryParams/);
  assert.match(md, /Event action ApplicationMessage \[NOT ENABLED\]/);
  assert.match(md, /Routing rule NcQuery \(queue NOTIFICATIONS, message function CO_RELEASED\)/);
  assert.ok(!md.includes("secret"));
  assert.match(md, /```json/);
});
