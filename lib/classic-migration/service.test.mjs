import test from "node:test";
import assert from "node:assert/strict";
import { createRest, pushFlow } from "./service.js";

function fakeFlow({ dropSteps } = {}) {
  const calls = [];
  let saved = null;
  let ifMatch = null;
  const res = (body, status = 200, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
  const fetchImpl = async (url, opt = {}) => {
    const path = url.replace("https://build.novacura.com", "");
    calls.push(`${opt.method || "GET"} ${path}`);
    if (opt.method === "POST" && /\/(products|assets)$/.test(path)) return res({ id: "item-1" });
    if (opt.method === "POST" && /\/designer$/.test(path)) { saved = JSON.parse(opt.body); ifMatch = opt.headers["If-Match"]; return res("", 200, { etag: '"e2"' }); }
    if (/\/designer$/.test(path)) return res({ eTag: "e1", data: dropSteps ? [] : saved ? saved.data : [] });
    if (/\/assets\/[^/]+$/.test(path)) return res({ id: "x", type: "component", name: "n", mainBranch: { headVersionId: "v9", id: "b1" } });
    return res({});
  };
  return { rest: createRest("tok", fetchImpl), calls, saved: () => saved, ifMatch: () => ifMatch };
}

const emitted = {
  data: [{ type: "step-created", id: "s1" }, { type: "step-created", id: "s2" }, { type: "arrow-created", id: "a1" }],
  resultTypeExpression: "{}",
  startParametersExpression: null,
  isInbox: false,
  componentAssetsUsed: [{ assetId: "c1", assetVersion: "v1", name: "Sub" }]
};

test("pushFlow creates the flow, saves the full data and never commits", async () => {
  const f = fakeFlow();
  const result = await pushFlow({ rest: f.rest }, { orgId: "o", packageId: "p", name: "Flow A", kind: "application" }, emitted);
  assert.equal(result.itemId, "item-1");
  assert.equal(result.assetVersion, "v9");
  assert.equal(result.steps, 2);
  assert.equal(f.saved().data.length, 3);
  assert.equal(f.ifMatch(), "e1");
  assert.deepEqual(f.saved().updates, []);
  assert.deepEqual(f.saved().assets, [{ assetId: "c1", assetVersion: "v9", offeredParameterType: "{}" }]);
  assert.ok(f.calls.some((c) => c.endsWith("/packages/p/products")));
  assert.ok(!f.calls.some((c) => c.includes("/commit")));
});

test("pushFlow fails when the steps did not survive the save", async () => {
  const f = fakeFlow({ dropSteps: true });
  await assert.rejects(pushFlow({ rest: f.rest }, { orgId: "o", packageId: "p", name: "Flow A", kind: "component" }, emitted), /only 0 of 2 steps/);
});
