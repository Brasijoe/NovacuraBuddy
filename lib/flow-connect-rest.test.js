const test = require("node:test");
const assert = require("node:assert/strict");
const { flowFetch, throwWithResponseBody } = require("./flow-connect-rest.js");

test("flowFetch prefixes the base URL and sends Authorization + X-Origin", async () => {
  let seenUrl, seenHeaders;
  const fakeFetch = async (url, options) => {
    seenUrl = url;
    seenHeaders = options.headers;
    return { ok: true };
  };
  await flowFetch("tok-123", "/admin/security/api/v3/user/whoAmI", {}, fakeFetch);
  assert.equal(seenUrl, "https://build.novacura.com/admin/security/api/v3/user/whoAmI");
  assert.equal(seenHeaders.Authorization, "Bearer tok-123");
  assert.equal(seenHeaders["X-Origin"], "HubWebApp");
});

test("flowFetch preserves caller-supplied headers alongside the required ones", async () => {
  let seenHeaders;
  const fakeFetch = async (url, options) => { seenHeaders = options.headers; return { ok: true }; };
  await flowFetch("tok", "/path", { headers: { "Content-Type": "text/plain", "If-Match": "*" } }, fakeFetch);
  assert.equal(seenHeaders["Content-Type"], "text/plain");
  assert.equal(seenHeaders["If-Match"], "*");
  assert.equal(seenHeaders.Authorization, "Bearer tok");
});

test("throwWithResponseBody reads and appends the real response body text", async () => {
  const res = { status: 400, text: async () => "Assets[0].OfferedParameterType is required." };
  await assert.rejects(
    () => throwWithResponseBody(res, "Could not save designer data"),
    (err) => {
      assert.equal(err.message, "Could not save designer data (400): Assets[0].OfferedParameterType is required.");
      return true;
    }
  );
});

test("throwWithResponseBody tolerates an unreadable body", async () => {
  const res = { status: 500, text: async () => { throw new Error("stream closed"); } };
  await assert.rejects(
    () => throwWithResponseBody(res, "Commit failed"),
    (err) => { assert.equal(err.message, "Commit failed (500)"); return true; }
  );
});
