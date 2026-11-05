const test = require("node:test");
const assert = require("node:assert");
const { ifsObjectUrl } = require("./ifs-links.js");

test("routing address link matches the address IFS shows", () => {
  assert.equal(
    ifsObjectUrl("https://ifscloud.flowington.com/", "routingAddress", { addressName: "NcQueryParams" }),
    "https://ifscloud.flowington.com/main/ifsapplications/web/page/RoutingAddresses/RoutingAddressPage;$filter=AddressName%20eq%20'NcQueryParams'"
  );
});

test("quotes in a name are doubled, unknown types and missing data give no link", () => {
  assert.match(ifsObjectUrl("https://x", "routingAddress", { addressName: "A'B" }), /A''B'$/);
  assert.equal(ifsObjectUrl("https://x", "workflow", { processKey: "p" }), null);
  assert.equal(ifsObjectUrl("https://x", "routingAddress", {}), null);
});

test("routing rule link matches the rule page IFS shows", () => {
  assert.equal(
    ifsObjectUrl("https://ifscloud.flowington.com", "routingRule", { ruleName: "AC_ROUTING_RULE_CO-DEPLOYED" }),
    "https://ifscloud.flowington.com/main/ifsapplications/web/page/RoutingRules/RoutingRulePage;$filter=RuleName%20eq%20'AC_ROUTING_RULE_CO-DEPLOYED'"
  );
});

test("event action link filters the event action page by event id", () => {
  assert.equal(
    ifsObjectUrl("https://ifscloud.flowington.com", "eventAction", { eventId: "NOTIFY_POCO_REJECTED" }),
    "https://ifscloud.flowington.com/main/ifsapplications/web/page/EventAction/EventActionDetailsPage;$filter=%28startswith%28EventId,'NOTIFY_POCO_REJECTED'%29%29"
  );
});

test("workflow link filters the BPMN process page by process key", () => {
  assert.equal(
    ifsObjectUrl("https://ifscloud.flowington.com", "workflow", { processKey: "DemoSplitPOLinesExample" }),
    "https://ifscloud.flowington.com/main/ifsapplications/web/page/Workflow/BpmnProcessPage;$filter=ProcessKey%20eq%20'DemoSplitPOLinesExample'"
  );
});
