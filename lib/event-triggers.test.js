const test = require("node:test");
const assert = require("node:assert");
const EventTriggers = require("./event-triggers.js");

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
  assert.deepEqual(results.map((r) => r.status), ["created", "created", "created"]);
  const paths = c.calls.map(([m, p]) => `${m} ${p.split("/").slice(1).join("/")}`);
  assert.deepEqual(paths, [
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
  const patch = c.calls[1][2];
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
  assert.deepEqual(results.map((r) => r.status), ["exists", "exists", "created"]);
  assert.ok(!c.calls.some(([, p]) => /RoutingRuleSet|RoutingAddressVirtualSet$/.test(p)));
});

test("link stops at the first failing step", async () => {
  const c = fakeClient({ failOn: "RoutingRuleSet" });
  const results = await EventTriggers.link(c, input);
  assert.deepEqual(results.map((r) => r.status), ["created", "failed"]);
  assert.ok(!c.calls.some(([, p]) => /NewEventAction/.test(p)));
});
