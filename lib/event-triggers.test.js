const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const EventTriggers = require("./event-triggers.js");
const XmlToJsonFlat = require("./xml-to-json-flat.js");

/** A fake IFS client that records every write; `existing` names what plan() finds. */
function fakeClient({ existing = [], failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    get: async (path) => ({ value: existing.some((n) => path.includes(`'${n}'`)) ? [{}] : [] }),
    post: async (path, body) => {
      calls.push(["POST", path.split("projection/v1/")[1].replace(/\(Objkey='\w+'\)/, "(K)"), body]);
      if (failOn && path.includes(failOn)) throw Object.assign(new Error("boom"), { status: 400 });
      return /VirtualSet$/.test(path) ? { Objkey: "ABC123" } : undefined;
    },
    getOData: async () => ({ "@odata.etag": 'W/"E"' }),
    postOData: async (path, body) => {
      calls.push(["POST", path.split("projection/v1/")[1].replace(/\(Objkey='\w+'\)/, "(K)"), body]);
      return /NewConnectorVirtualSet$/.test(path) ? { Objkey: "ABC123" } : undefined;
    },
    patchText: async (path, text, etag, headers) => { calls.push(["PATCHTEXT", path.split("projection/v1/")[1].replace(/\(Objkey='\w+'\)/, "(K)"), { text, etag, headers }]); },
    patchJson: async (path, body) => { calls.push(["PATCH", path.split("projection/v1/")[1].replace(/\(Objkey='\w+'\)/, "(K)"), body]); }
  };
}

const input = {
  automationName: "send order mail", endpoint: "https://run.novacura.com/env/abc12345", method: "post", accessKey: "SECRET",
  eventLuName: "CustomerOrder", eventId: "CO_RELEASED", queue: "NOTIFICATIONS"
};

test("objectName: Nc + CamelCase, cut to the maximum", () => {
  assert.equal(EventTriggers.objectName("send order mail"), "NcSendOrderMail");
  assert.equal(EventTriggers.objectName("my-automation_name 2"), "NcMyAutomationName2");
  assert.equal(EventTriggers.objectName("send order mail", 8), "NcSendOr");
  assert.equal(EventTriggers.objectName("", 20), "Nc");
});

test("maxLengthOf reads the column length from $metadata", () => {
  const xml = `<EntityType Name="RoutingAddress"><Property Name="AddressName" Type="Edm.String" MaxLength="30"/></EntityType>`;
  assert.equal(EventTriggers.maxLengthOf(xml, "RoutingAddress", "AddressName"), 30);
  assert.equal(EventTriggers.maxLengthOf(xml, "RoutingAddress", "Missing"), null);
});

test("headersText: one NAME=VALUE per line, Accept */*", () => {
  assert.equal(EventTriggers.headersText("x-api-key", "K"), "x-api-key=K\r\nAccept=*/*");
});

test("link creates address, rule and event action in the captured order", async () => {
  const c = fakeClient();
  const results = await EventTriggers.link(c, input);
  assert.deepEqual(results.map((r) => r.status), ["created", "created", "created", "created"]);
  const paths = c.calls.map(([m, p]) => `${m} ${p.split("/").slice(1).join("/")}`);
  assert.deepEqual(paths, [
    "POST NewConnectorVirtualSet",
    "POST ValidateFileType",
    "PATCHTEXT NewConnectorVirtualSet(K)/FileContent",
    "POST NewConnectorVirtualSet(K)/IfsApp.ConnectConfigurationHandling.NewConnectorVirtual_NewConnector",
    "POST NewConnectorVirtualSet(K)/IfsApp.ConnectConfigurationHandling.NewConnectorVirtual_CleanupVirtualEntity",
    "POST RoutingAddressVirtualSet",
    "PATCH RoutingAddressVirtualSet(K)",
    "POST RoutingAddressVirtualSet(K)/IfsApp.RoutingAddressesHandling.RoutingAddressVirtual_NewRoutingAddress",
    "POST RoutingAddressVirtualSet(K)/IfsApp.RoutingAddressesHandling.RoutingAddressVirtual_SaveTransformers",
    "POST RoutingAddressVirtualSet(K)/IfsApp.RoutingAddressesHandling.RoutingAddressVirtual_CleanupVirtualEntity",
    "POST TransformersVirtualSet",
    "POST TransformersVirtualSet(K)/IfsApp.RoutingAddressesHandling.TransformersVirtual_CleanupVirtualEntity",
    "POST SaveTransformer",
    "POST RoutingRuleSet",
    "POST SaveContentBasedCondition",
    "POST SaveDestinationAddresses",
    "POST NewEventActionVirtualSet",
    "POST GetId",
    "PATCH NewEventActionVirtualSet(K)", "PATCH NewEventActionVirtualSet(K)", "PATCH NewEventActionVirtualSet(K)", "PATCH NewEventActionVirtualSet(K)", "PATCH NewEventActionVirtualSet(K)",
    "POST CreateNewEventAction",
    "POST NewEventActionVirtualSet(K)/IfsApp.NewEventActionHandling.NewEventActionVirtual_CleanupVirtualEntity"
  ]);
  const tcreate = c.calls[0][2];
  assert.deepEqual(tcreate, { InstanceName: "C_XML_TO_JSON_FLAT", ConnectGroup: "Transformers", TransformerInstanceTypes: "XslTransformer", FileName: "C_XML_TO_JSON_FLAT.xsl" });
  const upload = c.calls[2][2];
  assert.equal(upload.text, XmlToJsonFlat.XSLT);
  assert.equal(upload.headers["x-ifs-content-disposition"], "filename=Q19YTUxfVE9fSlNPTl9GTEFULnhzbA==");
  const patch = c.calls.find(([m, p]) => m === "PATCH" && /RoutingAddressVirtualSet/.test(p))[2];
  assert.equal(patch.SenderInstance, "REST_SENDER1");
  assert.equal(patch.AuthenticationMethod, "None");
  assert.equal(patch.RestHttpMethod, "POST");
  assert.equal(patch.AdditionalHeaders, "x-api-key=SECRET\r\nAccept=*/*");
  const rule = c.calls.find(([, p]) => /RoutingRuleSet/.test(p))[2];
  assert.deepEqual(rule, { RuleName: "NcSendOrderMail", Direction: "Outbound", RouteType: "APPLICATION_MESSAGE", Enabled: true, Queue: "NOTIFICATIONS" });
  const cond = c.calls.find(([, p]) => /SaveContentBasedCondition/.test(p))[2];
  assert.equal(cond.SearchPath, "MESSAGE_FUNCTION");
  assert.equal(cond.MatchQueryExpr, "CO_RELEASED");
});

test("existing address and rule are reused, never recreated", async () => {
  const c = fakeClient({ existing: ["NcSendOrderMail"] });
  const results = await EventTriggers.link(c, input);
  assert.deepEqual(results.map((r) => r.status), ["created", "exists", "exists", "created"]);
  assert.ok(!c.calls.some(([, p]) => /RoutingRuleSet|RoutingAddressVirtualSet$/.test(p)));
});

test("an existing transformer is reused, never recreated", async () => {
  const c = fakeClient({ existing: ["C_XML_TO_JSON_FLAT"] });
  const results = await EventTriggers.link(c, input);
  assert.deepEqual(results.map((r) => r.status), ["exists", "created", "created", "created"]);
  assert.ok(!c.calls.some(([, p]) => /NewConnectorVirtualSet|ValidateFileType/.test(p)));
});

test("the bundled XSLT string equals the .xslt file, and the routing address uses that transformer", () => {
  assert.equal(XmlToJsonFlat.XSLT, fs.readFileSync(__dirname + "/xml-to-json-flat.xslt", "utf8"));
  assert.equal(EventTriggers.DEFAULTS.transformer, "C_XML_TO_JSON_FLAT");
});

test("link stops at the first failing step", async () => {
  const c = fakeClient({ failOn: "RoutingRuleSet" });
  const results = await EventTriggers.link(c, input);
  assert.deepEqual(results.map((r) => r.status), ["created", "created", "failed"]);
  assert.ok(!c.calls.some(([, p]) => /NewEventAction/.test(p)));
});

test("listAutomations keeps automations with an enabled webhook and names the environments", async () => {
  const responses = {
    "/products": [{ id: "a1", name: "Delay automation", type: "automation" }, { id: "a2", name: "Some app", type: "application" }, { id: "a3", name: "No hook", type: "automation" }],
    "/apps/a1/settings": { E1: { webHook: { url: "https://run.novacura.com/E1/a1", isEnabled: true } }, E2: { webHook: { url: "https://run.novacura.com/E2/a1", isEnabled: false } } },
    "/apps/a3/settings": { E1: { webHook: { url: "https://run.novacura.com/E1/a3", isEnabled: false } } }
  };
  const flowFetch = async (path, options) => {
    // the settings call is refused without the X-EnvId header
    if (/settings$/.test(path) && !path.startsWith("https://api.novacura.com/automations//api/v1/")) return { ok: false, status: 404, text: async () => "<!doctype html>", json: async () => ({}) };
    if (/settings$/.test(path) && !(options && options.headers && options.headers["X-EnvId"])) return { ok: false, json: async () => ({}) };
    const key = Object.keys(responses).find((k) => path.endsWith(k));
    return { ok: !!key, status: key ? 200 : 404, text: async () => JSON.stringify(responses[key]), json: async () => responses[key] };
  };
  const { automations: list, checked, failures } = await EventTriggers.listAutomations({ flowFetch, orgId: "O", packages: [{ id: "P", name: "Pack" }], environments: [{ id: "E1", name: "Test", type: "test" }, { id: "E2", name: "Prod", type: "prod" }] });
  assert.equal(checked, 2);
  assert.deepEqual(failures, []);
  assert.deepEqual(list, [{ id: "a1", name: "Delay automation", packageId: "P", packageName: "Pack", endpoints: [{ envId: "E1", envName: "Test", envType: "test", url: "https://run.novacura.com/E1/a1" }] }]);
});

test("listAutomations reports settings reads that fail instead of hiding them", async () => {
  const flowFetch = async (path) => (/products$/.test(path) ? { ok: true, json: async () => [{ id: "a1", name: "Broken", type: "automation" }] } : { ok: true, status: 200, text: async () => "<!doctype html><html>" });
  const r = await EventTriggers.listAutomations({ flowFetch, orgId: "O", packages: [{ id: "P", name: "Pack" }], environments: [{ id: "E1", name: "Test", type: "test" }] });
  assert.equal(r.automations.length, 0);
  assert.equal(r.checked, 1);
  assert.match(r.failures[0], /Broken: not JSON: <!doctype html>/);
});

test("listAutomations merges the answers of every environment (the answer depends on X-EnvId)", async () => {
  const flowFetch = async (path, options) => {
    if (/products$/.test(path)) return { ok: true, json: async () => [{ id: "a1", name: "Auto", type: "automation" }] };
    const env = options.headers["X-EnvId"];
    const body = env === "E1" ? { E1: { webHook: { url: "u1", isEnabled: false } } } : { E2: { webHook: { url: "u2", isEnabled: true } } };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const r = await EventTriggers.listAutomations({ flowFetch, orgId: "O", packages: [{ id: "P", name: "Pack" }], environments: [{ id: "E1", name: "Dev", type: "dev" }, { id: "E2", name: "Test", type: "test" }] });
  assert.deepEqual(r.automations[0].endpoints, [{ envId: "E2", envName: "Test", envType: "test", url: "u2" }]);
});

test("listEvents pages until a short page", async () => {
  let calls = 0;
  const client = { get: async () => ({ value: calls++ ? [{ EventLuName: "A", EventId: "B" }] : [{ EventLuName: "C", EventId: "D" }, { EventLuName: "A", EventId: "A" }] }) };
  const events = await EventTriggers.listEvents(client, 2);
  assert.deepEqual(events.map((e) => e.luName + "." + e.id), ["A.A", "A.B", "C.D"]);
});

test("plan reads the name limits from the IFS metadata", async () => {
  const meta = (type, prop) => `<EntityType Name="${type}"><Property Name="${prop}" MaxLength="12"/></EntityType>`;
  const client = { get: async () => ({ value: [] }), getText: async (p) => (/RoutingAddressesHandling/.test(p) ? meta("RoutingAddress", "AddressName") : meta("RoutingRule", "RuleName")) };
  const p = await EventTriggers.plan(client, { automationName: "send order mail" });
  assert.equal(p.addressName, "NcSendOrderM");
});

test("parseInputVariables reads the single top-level variables of a record type", () => {
  const v = EventTriggers.parseInputVariables("{ orderNo: text, optional qty: number, lines: { a: text, b: number }*, note: text }");
  assert.deepEqual(v.map((x) => [x.name, x.optional]), [["orderNo", false], ["qty", true], ["lines", false], ["note", false]]);
  assert.equal(v[2].type, "{ a: text, b: number }*");
  assert.deepEqual(EventTriggers.parseInputVariables("{}"), []);
  assert.deepEqual(EventTriggers.parseInputVariables("text"), []);
});

test("suggestColumn matches camelCase variables to IFS columns", () => {
  const cols = [{ name: "CUSTOMS_DECLARATION_DATE" }, { name: "SHIPMENT_ID" }, { name: "SHIP_VIA_CODE" }];
  assert.equal(EventTriggers.suggestColumn("customsDeclarationDate", cols), "CUSTOMS_DECLARATION_DATE");
  assert.equal(EventTriggers.suggestColumn("shipmentId", cols), "SHIPMENT_ID");
  assert.equal(EventTriggers.suggestColumn("somethingElse", cols), null);
});

function eventClient({ columns, parameters = [] }) {
  const calls = [];
  return {
    calls,
    get: async (path) => ({ value: /DictionarySysColumnsArray/.test(path) ? columns : parameters }),
    postOData: async (path, body) => { calls.push([path.split("projection/v1/")[1], body]); }
  };
}

test("applyEventParameters activates only what is off, then creates the parameter", async () => {
  const c = eventClient({ columns: [
    { ColumnName: "CUSTOMS_DECLARATION_DATE", OldValue: true, NewValue: false, DataType: "DATE" },
    { ColumnName: "SHIPMENT_ID", OldValue: false, NewValue: true, DataType: "NUMBER" }
  ] });
  await EventTriggers.applyEventParameters(c, { eventLuName: "Shipment", eventId: "E1", mappings: [
    { id: "customsDate", column: "CUSTOMS_DECLARATION_DATE", which: "OLD" },
    { id: "shipmentId", column: "SHIPMENT_ID", which: "NEW" }
  ] });
  const paths = c.calls.map(([p]) => p.replace("CustomEventHandling.svc/", ""));
  // OLD of the first column is on already, NEW of the second too: no activation call at all.
  assert.deepEqual(paths, ["FndEvents(EventLuName='Shipment',EventId='E1')/FndEventParameterArray", "FndEvents(EventLuName='Shipment',EventId='E1')/FndEventParameterArray"]);
  assert.equal(c.calls[0][1].PlsqlMethod, "&OLD:CUSTOMS_DECLARATION_DATE");
  assert.equal(c.calls[1][1].PlsqlMethod, "&NEW:SHIPMENT_ID");
  assert.equal(c.calls[0][1].IdType, "STRING");
});

test("applyEventParameters switches a flag on without turning the other one off", async () => {
  const c = eventClient({ columns: [{ ColumnName: "X", OldValue: true, NewValue: false, DataType: "DATE" }] });
  await EventTriggers.applyEventParameters(c, { eventLuName: "L", eventId: "E", mappings: [{ id: "x", column: "X", which: "NEW" }] });
  assert.match(c.calls[0][0], /UpdateDetailsOnFndEventParameter$/);
  assert.deepEqual(c.calls[0][1], { EventLuName: "L", EventId: "E", ColumnName: "X", OldValue: true, NewValue: true, DataType: "DATE" });
});

test("applyEventParameters never changes an existing parameter and reports a different method", async () => {
  const c = eventClient({ columns: [{ ColumnName: "X", OldValue: true, NewValue: true, DataType: "TEXT" }], parameters: [{ Id: "same", PlsqlMethod: "&NEW:X" }, { Id: "other", PlsqlMethod: "&OLD:X" }] });
  await assert.rejects(EventTriggers.applyEventParameters(c, { eventLuName: "L", eventId: "E", mappings: [{ id: "same", column: "X", which: "NEW" }, { id: "other", column: "X", which: "NEW" }] }), /other already exists with &OLD:X, not changed/);
  assert.equal(c.calls.length, 0);
});

test("link adds an Event variables step when variables are mapped", async () => {
  const c = fakeClient();
  c.get = async (path) => ({ value: /DictionarySysColumnsArray/.test(path) ? [{ ColumnName: "X", OldValue: true, NewValue: true, DataType: "TEXT" }] : [] });
  const results = await EventTriggers.link(c, { ...input, mappings: [{ id: "x", column: "X", which: "NEW" }] });
  assert.deepEqual(results.map((r) => r.step), ["Transformer C_XML_TO_JSON_FLAT", "Routing address", "Routing rule", "Event action", "Event variables"]);
  assert.equal(results[4].status, "created");
});
