const test = require("node:test");
const assert = require("node:assert/strict");
const { parseExcludedList } = require("./projection-filter.js");
const { shouldTrackUrl, upsertTrackedProjection } = require("./tracking.js");

test("shouldTrackUrl is false while tracking is disabled, even for a trackable .svc URL", () => {
  const set = parseExcludedList("");
  assert.equal(shouldTrackUrl("https://ifs.example.com/.../SalesQuotationHandling.svc/Rows", false, set), false);
});

test("shouldTrackUrl is false for a non-.svc URL", () => {
  const set = parseExcludedList("");
  assert.equal(shouldTrackUrl("https://ifs.example.com/static/app.js", true, set), false);
});

test("shouldTrackUrl is false for an excluded .svc", () => {
  const set = parseExcludedList("UserProfileService.svc");
  assert.equal(shouldTrackUrl("https://ifs.example.com/.../UserProfileService.svc/Rows", true, set), false);
});

test("shouldTrackUrl is true for a non-excluded .svc while tracking is enabled", () => {
  const set = parseExcludedList("UserProfileService.svc");
  assert.equal(shouldTrackUrl("https://ifs.example.com/.../SalesQuotationHandling.svc/Rows", true, set), true);
});

test("upsertTrackedProjection adds a new row with hitCount 1", () => {
  const list = upsertTrackedProjection([], "SalesQuotationHandling", 1000);
  assert.deepEqual(list, [{ projectionName: "SalesQuotationHandling", firstSeenAt: 1000, hitCount: 1 }]);
});

test("upsertTrackedProjection increments hitCount on a repeat hit instead of duplicating the row", () => {
  let list = upsertTrackedProjection([], "SalesQuotationHandling", 1000);
  list = upsertTrackedProjection(list, "SalesQuotationHandling", 2000);
  assert.equal(list.length, 1);
  assert.equal(list[0].hitCount, 2);
  assert.equal(list[0].firstSeenAt, 1000, "firstSeenAt must not change on a repeat hit");
});

test("upsertTrackedProjection matches an existing row case-insensitively", () => {
  let list = upsertTrackedProjection([], "SalesQuotationHandling", 1000);
  list = upsertTrackedProjection(list, "saleSQuotationHandling", 2000);
  assert.equal(list.length, 1);
  assert.equal(list[0].hitCount, 2);
});

test("disabling tracking leaves an already-recorded list untouched, it only gates new upserts", () => {
  const set = parseExcludedList("");
  const url = "https://ifs.example.com/.../SalesQuotationHandling.svc/Rows";
  let list = upsertTrackedProjection([], "SalesQuotationHandling", 1000);

  // background.js's real call site: only upsert when shouldTrackUrl says to.
  if (shouldTrackUrl(url, /* trackingEnabled */ false, set)) {
    list = upsertTrackedProjection(list, "SalesQuotationHandling", 2000);
  }

  assert.deepEqual(list, [{ projectionName: "SalesQuotationHandling", firstSeenAt: 1000, hitCount: 1 }]);
});
