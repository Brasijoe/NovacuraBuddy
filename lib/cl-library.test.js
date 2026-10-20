const test = require("node:test");
const assert = require("node:assert/strict");
const { createClLibrary } = require("./cl-library.js");

const REPO = "team/qr-data";
const res = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
  text: async () => JSON.stringify(body ?? "")
});

/** Minimal in-memory GitHub: tree, blobs, contents PUT with GitHub's sha rules. */
function fakeGitHub(files = {}) {
  let n = 0;
  const store = new Map(Object.entries(files).map(([p, c]) => [p, { sha: `sha${++n}`, content: c }]));
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    const path = decodeURIComponent(new URL(url).pathname);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (path === `/repos/${REPO}`) return res(200, { default_branch: "main" });
    if (path === `/repos/${REPO}/git/trees/main`) return res(200, { tree: [...store].map(([p, f]) => ({ path: p, type: "blob", sha: f.sha })) });
    const blob = path.match(/\/git\/blobs\/(.+)$/);
    if (blob) return res(200, { content: Buffer.from([...store.values()].find((f) => f.sha === blob[1]).content).toString("base64") });
    const contents = path.match(new RegExp(`^/repos/${REPO}/contents/(.+)$`));
    if (contents && method === "PUT") {
      if (store.has(contents[1]) && !body.sha) return res(422, { message: "sha wasn't supplied" });
      const sha = `sha${++n}`;
      store.set(contents[1], { sha, content: Buffer.from(body.content, "base64").toString("utf8") });
      return res(201, { content: { sha } });
    }
    return res(404, { message: "Not Found" });
  };
  return { fetchImpl, store, calls };
}

const lu = {
  name: "CustomPageName",
  prompt: "Custom Page Name",
  attributes: [
    { name: "NOTE", prompt: "Note", type: "STRING", length: 100 },
    { name: "QTY", prompt: "Qty", type: "NUMBER" }
  ]
};

test("create writes one JSON file under custom-lus/<login>/ and list reads it back", async () => {
  const gh = fakeGitHub({ "quick-reports/alice/r1.json": "{}", "custom-lus/bob/x.json": JSON.stringify({ name: "BobLu", attributes: [] }) });
  const lib = createClLibrary({ token: "t", repo: REPO, fetchImpl: gh.fetchImpl });
  const saved = await lib.create("alice", lu);
  assert.equal(saved.id, "custompagename");
  assert.deepEqual(JSON.parse(gh.store.get("custom-lus/alice/custompagename.json").content), {
    name: "CustomPageName",
    prompt: "Custom Page Name",
    attributes: [
      { name: "NOTE", prompt: "Note", type: "STRING", length: 100 },
      { name: "QTY", prompt: "Qty", type: "NUMBER" }
    ]
  });
  assert.equal(gh.calls.find((c) => c.method === "PUT").body.message, "add Custom LU: CustomPageName");
  const listed = await lib.list("alice");
  assert.deepEqual(listed, [{ id: "custompagename", name: "CustomPageName", prompt: "Custom Page Name", attributes: lu.attributes }]);
});

test("create refuses a name already in my library (case-insensitive) without writing", async () => {
  const gh = fakeGitHub({ "custom-lus/alice/custompagename.json": JSON.stringify(lu) });
  const lib = createClLibrary({ token: "t", repo: REPO, fetchImpl: gh.fetchImpl });
  await assert.rejects(lib.create("alice", { ...lu, name: "CUSTOMPAGENAME" }), (err) => err.code === "EXISTS" && /already in the library/.test(err.message));
  assert.equal(gh.calls.some((c) => c.method === "PUT"), false);
});

test("a different user's LU with the same name does not block mine", async () => {
  const gh = fakeGitHub({ "custom-lus/bob/custompagename.json": JSON.stringify(lu) });
  const lib = createClLibrary({ token: "t", repo: REPO, fetchImpl: gh.fetchImpl });
  assert.equal((await lib.create("alice", lu)).id, "custompagename");
});

test("slug collision with a different name gets a numbered id", async () => {
  const gh = fakeGitHub({ "custom-lus/alice/custom-page-name.json": JSON.stringify({ ...lu, name: "Custom_Page_Name" }) });
  const lib = createClLibrary({ token: "t", repo: REPO, fetchImpl: gh.fetchImpl });
  assert.equal((await lib.create("alice", { ...lu, name: "Custom-Page-Name" })).id, "custom-page-name-2");
});

test("a file created between list and PUT surfaces the library conflict message", async () => {
  const gh = fakeGitHub({});
  const lib = createClLibrary({ token: "t", repo: REPO, fetchImpl: async (url, init = {}) => {
    if ((init.method || "GET") === "PUT") return res(422, { message: "sha wasn't supplied" });
    return gh.fetchImpl(url, init);
  } });
  await assert.rejects(lib.create("alice", lu), (err) => err.code === "CONFLICT" && err.message === "This Custom LU is already in the library.");
});
