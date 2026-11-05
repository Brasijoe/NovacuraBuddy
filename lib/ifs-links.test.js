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
