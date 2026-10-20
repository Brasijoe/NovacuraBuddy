const test = require("node:test");
const assert = require("node:assert/strict");
const { extractBearerToken, createTokenCache, jwtExpiresAt } = require("./flow-token.js");

function fakeJwt(payload) {
  const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64url({ alg: "none" })}.${b64url(payload)}.sig`;
}

test("jwtExpiresAt reads exp (seconds) minus a minute of safety; null for a non-JWT", () => {
  assert.equal(jwtExpiresAt(fakeJwt({ exp: 2000 })), 2000 * 1000 - 60 * 1000);
  assert.equal(jwtExpiresAt("not-a-jwt"), null);
  assert.equal(jwtExpiresAt(fakeJwt({ sub: "x" })), null);
});

test("createTokenCache uses the JWT's own expiry over the fallback TTL, and reports it", () => {
  let now = 0;
  const cache = createTokenCache(45 * 60 * 1000, () => now);
  cache.set(fakeJwt({ exp: 3600 }));
  assert.equal(cache.expiresAt(), 3600 * 1000 - 60 * 1000);
  now = 3600 * 1000 - 60 * 1000 - 1;
  assert.ok(cache.get(), "still valid just before the real expiry, well past the 45-minute fallback");
  now += 2;
  assert.equal(cache.get(), null);
});

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
