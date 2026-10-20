const test = require("node:test");
const assert = require("node:assert/strict");
const CredentialCrypto = require("./credential-crypto.js");
const { createGithubSettings, DEFAULT_REPO } = require("./github-settings.js");

function fakeStorage() {
  const data = {};
  return { data, get: async (k) => ({ [k]: data[k] }), set: async (o) => { Object.assign(data, o); } };
}
const key = () => CredentialCrypto.deriveKey("pw", CredentialCrypto.generateSalt());

test("defaults: shared data repo, no login, no token", async () => {
  assert.equal(DEFAULT_REPO, "Brasijoe/ifs-quick-report-deployer-data");
  assert.deepEqual(await createGithubSettings(fakeStorage()).get(), { repo: DEFAULT_REPO, login: null, hasToken: false });
});

test("save verifies first, trims, stores the login and only an encrypted token", async () => {
  const storage = fakeStorage();
  const s = createGithubSettings(storage);
  const k = await key();
  const seen = [];
  const result = await s.save({ token: "  ghp_secret \n", repo: " team/qr-data " }, k, async (t, r) => { seen.push([t, r]); return "alice"; });
  assert.deepEqual(seen, [["ghp_secret", "team/qr-data"]]);
  assert.deepEqual(result, { repo: "team/qr-data", login: "alice" });
  assert.ok(!JSON.stringify(storage.data).includes("ghp_secret"));
  assert.deepEqual(await s.get(), { repo: "team/qr-data", login: "alice", hasToken: true });
  assert.equal(await s.getToken(k), "ghp_secret");
});

test("a bad repo name is refused before any check", async () => {
  const s = createGithubSettings(fakeStorage());
  let called = false;
  await assert.rejects(s.save({ token: "t", repo: "not a repo" }, await key(), async () => { called = true; return "x"; }), /owner\/name/);
  assert.equal(called, false);
});

test("a failed check stores nothing", async () => {
  const storage = fakeStorage();
  const s = createGithubSettings(storage);
  await assert.rejects(s.save({ token: "t", repo: "a/b" }, await key(), async () => { throw new Error("GitHub token rejected"); }),
    /GitHub check failed, settings not saved — GitHub token rejected/);
  assert.deepEqual(storage.data, {});
});

test("getToken without a saved token says where to add one", async () => {
  await assert.rejects(createGithubSettings(fakeStorage()).getToken(await key()), (err) => err.code === "GITHUB_NOT_CONFIGURED" && /Basic Data/.test(err.message));
});
