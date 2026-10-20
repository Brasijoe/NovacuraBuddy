const test = require("node:test");
const assert = require("node:assert/strict");
const { createQrLibrary, slugify } = require("./qr-library.js");

const REPO = "team/qr-data";

function res(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (body === undefined ? "" : JSON.stringify(body))
  };
}

/** In-memory GitHub: tree, blobs and the contents API with real sha checks. */
function fakeGitHub({ login = "alice", files = {}, failPut, respond } = {}) {
  let n = 0;
  const store = new Map();
  for (const [p, c] of Object.entries(files)) store.set(p, { sha: `sha${++n}`, content: c });
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    const path = decodeURIComponent(new URL(url).pathname);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body, headers: init.headers });
    if (respond) { const r = respond(method, path); if (r) return r; }
    if (path === "/user") return res(200, { login });
    if (path === `/repos/${REPO}`) return res(200, { default_branch: "main" });
    if (path === `/repos/${REPO}/git/trees/main`) {
      return res(200, { truncated: false, tree: [...store].map(([p, f]) => ({ path: p, type: "blob", sha: f.sha })) });
    }
    const blob = path.match(new RegExp(`^/repos/${REPO}/git/blobs/(.+)$`));
    if (blob) {
      const f = [...store.values()].find((x) => x.sha === blob[1]);
      if (!f) return res(404, { message: "Not Found" });
      const b64 = Buffer.from(f.content, "utf8").toString("base64").replace(/(.{60})/g, "$1\n");
      return res(200, { encoding: "base64", content: b64 });
    }
    const contents = path.match(new RegExp(`^/repos/${REPO}/contents/(.+)$`));
    if (contents) {
      const p = contents[1];
      const cur = store.get(p);
      if (failPut && failPut(p, method)) return res(500, { message: "boom" });
      if (method === "PUT") {
        if (cur && !body.sha) return res(422, { message: "\"sha\" wasn't supplied." });
        if (cur && body.sha !== cur.sha) return res(409, { message: "does not match" });
        const sha = `sha${++n}`;
        store.set(p, { sha, content: Buffer.from(body.content, "base64").toString("utf8") });
        return res(cur ? 200 : 201, { content: { path: p, sha } });
      }
      if (method === "DELETE") {
        if (!cur || body.sha !== cur.sha) return res(409, { message: "does not match" });
        store.delete(p);
        return res(200, { commit: {} });
      }
    }
    return res(404, { message: "Not Found" });
  };
  return { fetchImpl, calls, store };
}

const meta = (id, name) => JSON.stringify({ id, name, tags: ["t"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" }, null, 2);
const lib = (gh) => createQrLibrary({ token: "ghp_x", repo: REPO, fetchImpl: gh.fetchImpl });

test("whoAmI returns the token's login and sends the token as a bearer header", async () => {
  const gh = fakeGitHub();
  assert.equal(await lib(gh).whoAmI(), "alice");
  assert.equal(gh.calls[0].headers.Authorization, "Bearer ghp_x");
});

test("checkAccess explains a missing repo; a rejected token and the rate limit get their own text", async () => {
  await assert.rejects(lib(fakeGitHub({ respond: (m, p) => (p === `/repos/${REPO}` ? res(404, {}) : null) })).checkAccess(), /No access to team\/qr-data/);
  await assert.rejects(lib(fakeGitHub({ respond: () => res(401, {}) })).whoAmI(), /GitHub token rejected/);
  await assert.rejects(
    lib(fakeGitHub({ respond: () => res(403, {}, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1760000000" }) })).whoAmI(),
    /rate limit/
  );
});

test("list returns only the user's own folder, with content and shas", async () => {
  const gh = fakeGitHub({ files: {
    "quick-reports/alice/a.sql": "SELECT 'Größe €' FROM dual",
    "quick-reports/alice/a.json": meta("a", "Ärger-Report"),
    "quick-reports/bob/b.sql": "SELECT 2 FROM dual",
    "quick-reports/bob/b.json": meta("b", "B"),
    "quick-reports/c.sql": "SELECT 3 FROM dual",
    "quick-reports/c.json": meta("c", "C")
  } });
  const reports = await lib(gh).list("alice");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].id, "a");
  assert.equal(reports[0].name, "Ärger-Report");
  assert.equal(reports[0].content, "SELECT 'Größe €' FROM dual");
  assert.deepEqual(reports[0].tags, ["t"]);
  assert.equal(reports[0].sqlSha, gh.store.get("quick-reports/alice/a.sql").sha);
  assert.equal(reports[0].jsonSha, gh.store.get("quick-reports/alice/a.json").sha);
});

test("save of a new report writes .sql then .json in the user's folder, non-ASCII intact", async () => {
  const gh = fakeGitHub();
  const saved = await lib(gh).save("alice", { id: null, name: "Größe Report", content: "SELECT 'ü' FROM dual", tags: ["x"] }, []);
  assert.equal(saved.id, "gr-e-report");
  const puts = gh.calls.filter((c) => c.method === "PUT");
  assert.deepEqual(puts.map((c) => c.path), [
    `/repos/${REPO}/contents/quick-reports/alice/gr-e-report.sql`,
    `/repos/${REPO}/contents/quick-reports/alice/gr-e-report.json`
  ]);
  assert.equal(puts[0].body.message, "add QR: Größe Report");
  assert.equal(puts[0].body.branch, "main");
  assert.equal(puts[0].body.sha, undefined);
  const json = JSON.parse(gh.store.get("quick-reports/alice/gr-e-report.json").content);
  assert.deepEqual(Object.keys(json), ["id", "name", "tags", "createdAt", "updatedAt"]);
  assert.equal(json.name, "Größe Report");
  const again = await lib(gh).list("alice");
  assert.equal(again[0].content, "SELECT 'ü' FROM dual");
  assert.equal(saved.sqlSha, gh.store.get("quick-reports/alice/gr-e-report.sql").sha);
});

test("a new report whose slug is taken gets -2", async () => {
  const gh = fakeGitHub({ files: { "quick-reports/alice/my-report.sql": "x", "quick-reports/alice/my-report.json": meta("my-report", "My Report") } });
  const saved = await lib(gh).save("alice", { id: null, name: "my report!", content: "y", tags: [] }, [{ id: "my-report", name: "My Report" }]);
  assert.equal(saved.id, "my-report-2");
});

test("same name in different case is a collision; renaming to itself is not", async () => {
  const gh = fakeGitHub();
  const known = [{ id: "my-report", name: "My Report" }];
  await assert.rejects(lib(gh).save("alice", { id: null, name: " my report ", content: "y", tags: [] }, known), /A Quick Report named "my report" already exists/);
  assert.equal(gh.calls.filter((c) => c.method === "PUT").length, 0);
});

test("update sends the loaded shas, keeps createdAt, uses the update message", async () => {
  const gh = fakeGitHub({ files: { "quick-reports/alice/a.sql": "old", "quick-reports/alice/a.json": meta("a", "A") } });
  const [loaded] = await lib(gh).list("alice");
  const saved = await lib(gh).save("alice", { ...loaded, content: "new" }, [loaded]);
  assert.equal(saved.createdAt, "2026-01-01T00:00:00.000Z");
  assert.notEqual(saved.updatedAt, loaded.updatedAt);
  const puts = gh.calls.filter((c) => c.method === "PUT");
  assert.equal(puts[0].body.message, "update QR: A");
  assert.equal(puts[0].body.sha, loaded.sqlSha);
  assert.equal(gh.store.get("quick-reports/alice/a.sql").content, "new");
});

test("a stale sha is a CONFLICT and nothing is overwritten", async () => {
  const gh = fakeGitHub({ files: { "quick-reports/alice/a.sql": "theirs", "quick-reports/alice/a.json": meta("a", "A") } });
  const [loaded] = await lib(gh).list("alice");
  await assert.rejects(lib(gh).save("alice", { ...loaded, sqlSha: "stale", content: "mine" }, [loaded]), (err) => {
    assert.equal(err.code, "CONFLICT");
    assert.match(err.message, /changed on GitHub/);
    return true;
  });
  assert.equal(gh.store.get("quick-reports/alice/a.sql").content, "theirs");
});

test(".sql saved but .json failed: PARTIAL_SAVE, and a save after reloading succeeds", async () => {
  let failJson = true;
  const gh = fakeGitHub({
    files: { "quick-reports/alice/a.sql": "v1", "quick-reports/alice/a.json": meta("a", "A") },
    failPut: (p) => failJson && p.endsWith(".json")
  });
  const [loaded] = await lib(gh).list("alice");
  await assert.rejects(lib(gh).save("alice", { ...loaded, content: "v2" }, [loaded]), (err) => {
    assert.equal(err.code, "PARTIAL_SAVE");
    assert.match(err.message, /reload/i);
    return true;
  });
  failJson = false;
  const [reloaded] = await lib(gh).list("alice");
  const saved = await lib(gh).save("alice", { ...reloaded, content: "v3" }, [reloaded]);
  assert.equal(saved.content, "v3");
});

test("moveUnowned moves flat reports into the user's folder and skips slugs already there", async () => {
  const gh = fakeGitHub({ files: {
    "quick-reports/a.sql": "flat a", "quick-reports/a.json": meta("a", "A flat"),
    "quick-reports/c.sql": "flat c", "quick-reports/c.json": meta("c", "C"),
    "quick-reports/alice/a.sql": "mine", "quick-reports/alice/a.json": meta("a", "A mine")
  } });
  const result = await lib(gh).moveUnowned("alice");
  assert.deepEqual(result, { moved: ["c"], skipped: ["a"] });
  assert.equal(gh.store.get("quick-reports/alice/c.sql").content, "flat c");
  assert.ok(!gh.store.has("quick-reports/c.sql"));
  assert.ok(!gh.store.has("quick-reports/c.json"));
  assert.equal(gh.store.get("quick-reports/alice/a.sql").content, "mine");
  assert.ok(gh.store.has("quick-reports/a.sql"));
  assert.ok(gh.calls.some((c) => c.method === "PUT" && c.body.message === "move QR to alice: c"));
});

test("slugify matches the Electron app's rule", () => {
  assert.equal(slugify("  My Report! "), "my-report");
  assert.equal(slugify("!!!"), "report");
});
