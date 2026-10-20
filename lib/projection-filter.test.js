const test = require("node:test");
const assert = require("node:assert/strict");
const { parseExcludedList, extractSvcName, isExcludedUrl } = require("./projection-filter.js");

test("parseExcludedList skips comments and blank lines", () => {
  const text = "# comment\n\nUserProfileService.svc\n  FrameworkServices.svc  \n";
  const set = parseExcludedList(text);
  assert.equal(set.size, 2);
  assert.ok(set.has("USERPROFILESERVICE"));
  assert.ok(set.has("FRAMEWORKSERVICES"));
});

test("parseExcludedList strips .svc suffix case-insensitively", () => {
  const set = parseExcludedList("FooBar.SVC");
  assert.ok(set.has("FOOBAR"));
});

test("extractSvcName reads the service name from a projection URL", () => {
  const url = "https://x.example.com/main/ifsapplications/projection/v1/UserProfileService.svc/Users";
  assert.equal(extractSvcName(url), "UserProfileService");
});

test("extractSvcName returns null when no .svc segment present", () => {
  assert.equal(extractSvcName("https://x.example.com/foo/bar"), null);
});

test("isExcludedUrl matches an excluded service case-insensitively", () => {
  const set = parseExcludedList("UserProfileService.svc");
  const url = "https://x.example.com/main/ifsapplications/projection/v1/userprofileservice.svc/Users";
  assert.equal(isExcludedUrl(url, set), true);
});

test("isExcludedUrl returns false for a non-excluded service", () => {
  const set = parseExcludedList("UserProfileService.svc");
  const url = "https://x.example.com/main/ifsapplications/projection/v1/CustomerOrders.svc/Orders";
  assert.equal(isExcludedUrl(url, set), false);
});

test("isExcludedUrl returns false when the exclusion set is empty", () => {
  assert.equal(isExcludedUrl("https://x.example.com/UserProfileService.svc", new Set()), false);
});
