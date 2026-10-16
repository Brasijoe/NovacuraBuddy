const test = require("node:test");
const assert = require("node:assert/strict");
const {
  splitPascalCase,
  extractEntityOrAction,
  summarizePostActivity,
  distinctProjectionNames
} = require("./flow-asset-heuristic.js");

test("splitPascalCase splits multi-word PascalCase", () => {
  assert.equal(splitPascalCase("SalesQuotationLine"), "Sales Quotation Line");
  assert.equal(splitPascalCase("CustomerOrders"), "Customer Orders");
});

test("splitPascalCase handles acronym runs", () => {
  assert.equal(splitPascalCase("IFSAppService"), "IFS App Service");
});

test("extractEntityOrAction reads the entity set name from a plain projection URL", () => {
  const url = "https://x.example.com/main/ifsapplications/projection/v1/SalesQuotationHandling.svc/CustomerOrders";
  assert.equal(extractEntityOrAction(url), "Customer Orders");
});

test("extractEntityOrAction strips an OData key suffix", () => {
  const url = "https://x.example.com/main/ifsapplications/projection/v1/SalesQuotationHandling.svc/CustomerOrders(1)";
  assert.equal(extractEntityOrAction(url), "Customer Orders");
});

test("extractEntityOrAction reads a bound action name after the last dot", () => {
  const url = "https://x.example.com/main/ifsapplications/projection/v1/SalesQuotationHandling.svc/CustomerOrders(1)/Enterprise.CreateInvoice";
  assert.equal(extractEntityOrAction(url), "Create Invoice");
});

test("summarizePostActivity builds a sentence from unique POST targets", () => {
  const calls = [
    { method: "GET", url: "https://x.example.com/main/ifsapplications/projection/v1/A.svc/Foo" },
    { method: "POST", url: "https://x.example.com/main/ifsapplications/projection/v1/A.svc/CustomerOrders" },
    { method: "POST", url: "https://x.example.com/main/ifsapplications/projection/v1/A.svc/CustomerOrders" },
    { method: "POST", url: "https://x.example.com/main/ifsapplications/projection/v1/A.svc/SalesQuotationLine" }
  ];
  assert.equal(
    summarizePostActivity(calls),
    "Creates a new Customer Orders, Sales Quotation Line."
  );
});

test("summarizePostActivity falls back to a generic sentence when there are no POST calls", () => {
  const calls = [
    { method: "GET", url: "https://x.example.com/main/ifsapplications/projection/v1/A.svc/CustomerOrders" },
    { method: "GET", url: "https://x.example.com/main/ifsapplications/projection/v1/B.svc/Foo" }
  ];
  assert.equal(
    summarizePostActivity(calls),
    "Recorded 2 calls to A, B."
  );
});

test("summarizePostActivity returns empty string for no calls", () => {
  assert.equal(summarizePostActivity([]), "");
});

test("summarizePostActivity uses singular 'call' for a single-call session with no POSTs", () => {
  const calls = [
    { method: "GET", url: "https://x.example.com/main/ifsapplications/projection/v1/A.svc/CustomerOrders" }
  ];
  assert.equal(summarizePostActivity(calls), "Recorded 1 call to A.");
});

test("summarizePostActivity returns empty string for non-array input", () => {
  assert.equal(summarizePostActivity(null), "");
  assert.equal(summarizePostActivity(undefined), "");
  assert.equal(summarizePostActivity("not an array"), "");
});

test("distinctProjectionNames returns unique .svc names in first-seen order", () => {
  const calls = [
    { method: "GET", url: "https://x.example.com/main/ifsapplications/projection/v1/A.svc/Foo" },
    { method: "POST", url: "https://x.example.com/main/ifsapplications/projection/v1/B.svc/Bar" },
    { method: "GET", url: "https://x.example.com/main/ifsapplications/projection/v1/A.svc/Baz" }
  ];
  assert.deepEqual(distinctProjectionNames(calls), ["A", "B"]);
});
