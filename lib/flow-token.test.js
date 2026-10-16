const test = require("node:test");
const assert = require("node:assert/strict");
const { extractBearerToken, createTokenCache } = require("./flow-token.js");

test("extractBearerToken reads the Authorization header from a webRequest-style header list", () => {
  const headers = [{ name: "Content-Type", value: "application/json" }, { name: "Authorization", value: "Bearer abc123" }];
  assert.equal(extractBearerToken(headers), "abc123");
});

test("extractBearerToken is case-insensitive on both header name and the Bearer prefix", () => {
  const headers = [{ name: "authorization", value: "bearer xyz" }];
  assert.equal(extractBearerToken(headers), "xyz");
});

test("extractBearerToken returns null when no Authorization header is present", () => {
  assert.equal(extractBearerToken([{ name: "Content-Type", value: "application/json" }]), null);
});

test("extractBearerToken returns null for a non-Bearer Authorization header", () => {
  assert.equal(extractBearerToken([{ name: "Authorization", value: "Basic xyz" }]), null);
});

test("createTokenCache returns the token until the TTL elapses", () => {
  let now = 1000;
  const cache = createTokenCache(45 * 60 * 1000, () => now);
  cache.set("tok-1");
  assert.equal(cache.get(), "tok-1");
  now += 45 * 60 * 1000 - 1;
  assert.equal(cache.get(), "tok-1");
  now += 2;
  assert.equal(cache.get(), null, "expired token must not be returned");
});

test("createTokenCache.clear() forces the next get() to return null", () => {
  const cache = createTokenCache(1000, () => 0);
  cache.set("tok-1");
  cache.clear();
  assert.equal(cache.get(), null);
});
