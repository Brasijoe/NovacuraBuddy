const test = require("node:test");
const assert = require("node:assert/strict");
const { createPublisher } = require("./doc-publish.js");

function setup() {
  const store = {};
  const storage = { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) };
  const calls = [];
  let time = Date.parse("2026-10-23T08:00:00Z");
  const fetchImpl = async (url, opts) => {
    calls.push([opts.method, url, opts.body && JSON.parse(opts.body)]);
    if (opts.method === "POST") return { ok: true, json: async () => ({ id: "g1", html_url: "https://gist.github.com/u/g1", files: { "llm-context.md": { raw_url: "https://gist.githubusercontent.com/u/g1/raw/x/llm-context.md" } } }) };
    return { ok: true, status: 204, text: async () => "" };
  };
  return { p: createPublisher({ storage, fetchImpl, now: () => time }), calls, store, advance: (h) => { time += h * 3600e3; } };
}

test("publish creates a secret gist and records its expiry", async () => {
  const { p, calls } = setup();
  const e = await p.publish({ token: "t", name: "Order", files: { "llm-context.md": "hi" } });
  assert.equal(calls[0][2].public, false);
  assert.equal(e.rawUrl, "https://gist.githubusercontent.com/u/g1/raw/x/llm-context.md");
  assert.equal(e.expiresAt, "2026-10-23T16:00:00.000Z");
});

test("sweep deletes only expired gists", async () => {
  const { p, calls, advance } = setup();
  await p.publish({ token: "t", name: "Order", files: { "llm-context.md": "hi" } });
  advance(7);
  assert.deepEqual(await p.sweep({ token: "t" }), { removed: 0, failed: [] });
  advance(2);
  assert.deepEqual(await p.sweep({ token: "t" }), { removed: 1, failed: [] });
  assert.equal(calls.at(-1)[0], "DELETE");
  assert.deepEqual(await p.list(), []);
});

test("a rejected token explains the missing gist permission", async () => {
  const p = createPublisher({ storage: { get: async () => ({}), set: async () => {} }, fetchImpl: async () => ({ ok: false, status: 404, text: async () => "Not Found" }) });
  await assert.rejects(p.publish({ token: "t", name: "x", files: { a: "b" } }), /gist/);
});
