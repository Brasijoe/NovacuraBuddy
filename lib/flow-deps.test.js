const test = require("node:test");
const assert = require("node:assert");
const FlowDeps = require("./flow-deps.js");

const BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:camunda="http://camunda.org/schema/1.0/bpmn">
  <bpmn:process id="CSendOrder">
    <bpmn:serviceTask id="Task_1" name="Call Flow via address">
      <bpmn:extensionElements>
        <camunda:inputOutput>
          <camunda:inputParameter name="ifsBpaProjectionName">RoutingAddressesHandling</camunda:inputParameter>
          <camunda:inputParameter name="ifsBpaProjectionParameters">
            <camunda:map><camunda:entry key="AddressName">FLOW_ORDERS</camunda:entry></camunda:map>
          </camunda:inputParameter>
        </camunda:inputOutput>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:serviceTask id="Task_2" name="Direct">
      <bpmn:extensionElements>
        <camunda:inputOutput>
          <camunda:inputParameter name="ifsBpaHttpConnectionUrl">https://run.novacura.com/acme/api/orders?x=1&amp;y=2</camunda:inputParameter>
        </camunda:inputOutput>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:serviceTask id="Task_3" name="Other">
      <bpmn:extensionElements><camunda:inputOutput>
        <camunda:inputParameter name="ifsBpaHttpConnectionUrl">https://example.com/x</camunda:inputParameter>
      </camunda:inputOutput></bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:scriptTask id="Script_1"><bpmn:script>call('https://app.novacura.com/acme/hook')</bpmn:script></bpmn:scriptTask>
  </bpmn:process>
</bpmn:definitions>`;

test("matchedHosts finds both Flow hosts, case-insensitive", () => {
  assert.deepStrictEqual(FlowDeps.matchedPatterns("HTTPS://RUN.novacura.com/x"), ["run.novacura.com"]);
  assert.deepStrictEqual(FlowDeps.matchedPatterns({ a: "app.novacura.com" }), ["app.novacura.com"]);
  assert.deepStrictEqual(FlowDeps.matchedPatterns("https://flintit.novacura.com"), []);
  assert.deepStrictEqual(FlowDeps.matchedPatterns(null), []);
});

test("findUrls extracts URLs as written", () => {
  assert.deepStrictEqual(
    FlowDeps.findUrls("x := 'run.novacura.com/acme/api'; y := \"https://app.novacura.com/b?q=1\"."),
    ["run.novacura.com/acme/api", "https://app.novacura.com/b?q=1"]
  );
});

test("endpointKey drops scheme, query and trailing slash", () => {
  assert.strictEqual(FlowDeps.endpointKey("https://Run.Novacura.com/Acme/api/?a=1"), "run.novacura.com/acme/api");
});

test("parseBpmnDiagram finds indirect, direct and loose Flow calls", () => {
  const parsed = FlowDeps.parseBpmnDiagram(BPMN, ["FLOW_ORDERS"]);
  assert.deepStrictEqual(parsed.serviceTasks.map((t) => t.id), ["Task_1", "Task_2", "Task_3"]);
  assert.deepStrictEqual(parsed.indirectMatches, [{ taskId: "Task_1", taskName: "Call Flow via address", addressName: "FLOW_ORDERS" }]);
  assert.strictEqual(parsed.directMatches.length, 2);
  assert.strictEqual(parsed.directMatches[0].url, "https://run.novacura.com/acme/api/orders?x=1&y=2");
  assert.strictEqual(parsed.directMatches[0].taskId, "Task_2");
  assert.strictEqual(parsed.directMatches[1].url, "https://app.novacura.com/acme/hook");
  assert.strictEqual(parsed.directMatches[1].taskId, null);
});

test("parseBpmnDiagram ignores a routing address that did not match", () => {
  assert.deepStrictEqual(FlowDeps.parseBpmnDiagram(BPMN, []).indirectMatches, []);
});

test("extractWorkflowNameFromDataId keeps the full ProcessKey", () => {
  assert.strictEqual(FlowDeps.extractWorkflowNameFromDataId("command:CPEGEN_Form_Workflow_CSendOrder_2"), "CSendOrder");
  assert.strictEqual(FlowDeps.extractWorkflowNameFromDataId("page:Something"), null);
});

function fakeIfs(responses) {
  const calls = [];
  const lookup = (path) => {
    calls.push(path);
    const key = Object.keys(responses).find((k) => path.includes(k));
    if (!key) throw new Error(`unexpected ${path}`);
    const value = responses[key];
    if (value instanceof Error) throw value;
    return value;
  };
  return { calls, ifs: { get: async (p) => lookup(p), getText: async (p) => lookup(p) } };
}

test("runScan builds all chain shapes and groups them per Flow endpoint", async () => {
  const { ifs, calls } = fakeIfs({
    "RoutingAddressSet": { value: [
      { keyref: "k1", AddressName: "FLOW_ORDERS", RestRootEndPoint: "https://run.novacura.com/acme/api/orders" },
      { keyref: "k2", AddressName: "FLOW_UNUSED", RestRootEndPoint: "https://app.novacura.com/acme/unused" },
      { keyref: "k3", AddressName: "OTHER", RestRootEndPoint: "https://example.com" }
    ] },
    "ProcessKey='CSendOrder'": BPMN,
    "BpmnVersionSet": { value: [
      { ProcessKey: "CSendOrder", Version: "1", DeployStatus: "Active", Description: "Send order" },
      { ProcessKey: "COld", Version: "1", DeployStatus: "Undeployed" }
    ] },
    "FndEventActions": { value: [
      { FndEventActionType: "BPA", EventLuName: "CustomerOrder", EventId: "ORDER_RELEASED", ActionNumber: 1, BpaKey: "CSendOrder",
        EventIdRef: { EventLuName: "CustomerOrder", EventId: "ORDER_RELEASED", EventType: "CUSTOM" } },
      { FndEventActionType: "PL/SQL", EventLuName: "Part", EventId: "PART_NEW", ActionNumber: 2,
        SqlStatement: "x := http_post('https://app.novacura.com/acme/parts');" },
      { FndEventActionType: "PL/SQL", EventLuName: "Part", EventId: "PART_NEW", ActionNumber: 3, SqlStatement: "null;" }
    ] },
    "ConfigModelData": { value: [{ ModelId: "ClientMetadata.client:Order", DataId: "command:CPEGEN_Form_Workflow_CSendOrder", Name: "Send" }] }
  });
  const progress = [];
  const result = await FlowDeps.runScan({ ifs, onProgress: (s, c, t) => progress.push(`${s} ${c}/${t}`) });

  assert.ok(calls.every((c) => !/COld/.test(c)), "only Active workflows are fetched");
  assert.deepStrictEqual(result.counts, { routingAddresses: 2, workflowsScanned: 1, workflows: 3, eventActions: 2, pageCommands: 1 });
  const shapes = result.chains.map((c) => c.nodes.map((n) => n.type).join(">"));
  assert.ok(shapes.includes("event>eventAction>workflow>routingAddress>endpoint"));
  assert.ok(shapes.includes("event>eventAction>workflow>endpoint"));
  assert.ok(shapes.includes("eventAction>endpoint"));
  assert.ok(shapes.includes("pageCommand>workflow>routingAddress>endpoint"));
  assert.ok(shapes.includes("routingAddress>endpoint"), "an unused routing address is still shown");
  assert.deepStrictEqual(Object.keys(result.grouped.groups).sort(), [
    "app.novacura.com/acme/hook", "app.novacura.com/acme/parts", "app.novacura.com/acme/unused",
    "run.novacura.com/acme/api/orders"
  ]);
  assert.deepStrictEqual(result.grouped.unknown, []);
  assert.ok(progress.includes("Workflows 1/1"));
});

test("runScan skips a diagram that fails and reports it", async () => {
  const { ifs } = fakeIfs({
    "RoutingAddressSet": { value: [] },
    "ProcessKey='CBroken'": new Error("GET failed (500)"),
    "BpmnVersionSet": { value: [{ ProcessKey: "CBroken", Version: "2", DeployStatus: "Active" }] },
    "FndEventActions": { value: [] },
    "ConfigModelData": { value: [] }
  });
  const result = await FlowDeps.runScan({ ifs });
  assert.deepStrictEqual(result.chains, []);
  assert.deepStrictEqual(result.errors, [{ step: "Workflows", item: "CBroken v2", message: "GET failed (500)" }]);
});

test("custom addresses replace the defaults", () => {
  assert.deepStrictEqual(FlowDeps.matchedPatterns("call http://10.49.101.98/api", [" 10.49.101.98 ", "x.example.com"]), ["10.49.101.98"]);
  assert.deepStrictEqual(FlowDeps.findUrls("u := 'http://10.49.101.98/api/v1'; run.novacura.com", ["10.49.101.98"]), ["http://10.49.101.98/api/v1"]);
  assert.strictEqual(FlowDeps.endpointKey("10.49.101.98/api/"), "10.49.101.98/api");
});

test("runScan searches only the given addresses", async () => {
  const { ifs } = fakeIfs({
    "RoutingAddressSet": { value: [
      { keyref: "k1", AddressName: "ONPREM", RestRootEndPoint: "http://flow.internal.local/api" },
      { keyref: "k2", AddressName: "CLOUD", RestRootEndPoint: "https://run.novacura.com/acme" }
    ] },
    "BpmnVersionSet": { value: [] },
    "FndEventActions": { value: [{ FndEventActionType: "PL/SQL", EventLuName: "Part", EventId: "P", ActionNumber: 1, SqlStatement: "post('http://flow.internal.local/api/parts')" }] },
    "ConfigModelData": { value: [] }
  });
  const result = await FlowDeps.runScan({ ifs, patterns: ["flow.internal.local"] });
  assert.deepStrictEqual(result.patterns, ["flow.internal.local"]);
  assert.deepStrictEqual(Object.keys(result.grouped.groups).sort(), ["flow.internal.local/api", "flow.internal.local/api/parts"]);
  await assert.rejects(FlowDeps.runScan({ ifs, patterns: [" "] }), /No address/);
});

const FLOW_INDEX = {
  packages: [{ id: "pkg-sales-1111", name: "Sales" }, { id: "pkg-hr-2222", name: "HR" }],
  assets: [
    { id: "aaaa-1111-bbbb", name: "SendOrder", type: "workflow", packageId: "pkg-sales-1111", packageName: "Sales" },
    { id: "cccc-2222-dddd", name: "Onboard", type: "workflow", packageId: "pkg-hr-2222", packageName: "HR" },
    { id: "eeee-3333-ffff", name: "Shared", type: "workflow", packageId: "pkg-sales-1111", packageName: "Sales" },
    { id: "gggg-4444-hhhh", name: "Shared", type: "workflow", packageId: "pkg-hr-2222", packageName: "HR" }
  ]
};

test("flowTargetForUrl finds the asset by id, package id or a unique name", () => {
  assert.strictEqual(FlowDeps.flowTargetForUrl("https://run.novacura.com/acme/AAAA-1111-BBBB/run", FLOW_INDEX).packageName, "Sales");
  const byPackage = FlowDeps.flowTargetForUrl("https://app.novacura.com/acme/pkg-hr-2222/x", FLOW_INDEX);
  assert.deepStrictEqual([byPackage.packageName, byPackage.assetId], ["HR", null]);
  assert.strictEqual(FlowDeps.flowTargetForUrl("https://run.novacura.com/acme/automations/onboard?x=1", FLOW_INDEX).assetName, "Onboard");
  assert.ok(FlowDeps.flowTargetForUrl("https://run.novacura.com/acme/Shared", FLOW_INDEX).ambiguous);
  assert.strictEqual(FlowDeps.flowTargetForUrl("https://run.novacura.com/acme/unknown", FLOW_INDEX), null);
  assert.strictEqual(FlowDeps.flowTargetForUrl("http://10.0.0.1/SendOrder", FLOW_INDEX), null, "only Novacura Flow URLs have a package");
});

test("groupChainsByPackage buckets per package, not found and not Flow", () => {
  const chain = (url) => ({ id: url, nodes: [{ type: "endpoint", data: { url } }] });
  const chains = [
    chain("https://run.novacura.com/acme/aaaa-1111-bbbb"), chain("https://run.novacura.com/acme/SendOrder"),
    chain("https://run.novacura.com/acme/Onboard"), chain("https://run.novacura.com/acme/nope"),
    chain("http://10.0.0.1/api"), { id: "x", nodes: [{ type: "endpoint", data: { url: null } }] }
  ];
  const grouped = FlowDeps.groupChainsByPackage(chains, FLOW_INDEX);
  assert.deepStrictEqual(Object.fromEntries(Object.entries(grouped.groups).map(([k, v]) => [k, v.length])), { Sales: 2, HR: 1 });
  assert.strictEqual(grouped.notFound.length, 1);
  assert.strictEqual(grouped.notFlow.length, 2);
});
