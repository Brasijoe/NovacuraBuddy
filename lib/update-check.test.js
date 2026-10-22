const test = require("node:test");
const assert = require("node:assert/strict");
const { compareVersions, checkForUpdate, isCheckDue, RELEASES_URL } = require("./update-check.js");

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const release = (tag, assets = []) => ({ tag_name: tag, html_url: `https://github.com/Brasijoe/NovacuraBuddy/releases/tag/${tag}`, assets });

test("compareVersions is numeric and ignores a leading v", () => {
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("v1.2.0", "1.2"), 0);
  assert.equal(compareVersions("1.2.3", "1.3.0"), -1);
});

test("newer release: available, with the zip asset's download url", async () => {
  let url;
  const info = await checkForUpdate("0.1.0", async (u) => { url = u; return res(200, release("v0.2.0", [
    { name: "other.zip", browser_download_url: "https://x/other.zip" },
    { name: "NovacuraBuddy-v0.2.0.zip", browser_download_url: "https://x/nb.zip" }
  ])); });
  assert.equal(url, RELEASES_URL);
  assert.deepEqual(info, {
    available: true, currentVersion: "0.1.0", version: "0.2.0", zipUrl: "https://x/nb.zip",
    htmlUrl: "https://github.com/Brasijoe/NovacuraBuddy/releases/tag/v0.2.0"
  });
});

test("release without the zip asset falls back to the release page", async () => {
  const info = await checkForUpdate("0.1.0", async () => res(200, release("v0.2.0")));
  assert.equal(info.available, true);
  assert.equal(info.zipUrl, null);
});

test("same or older release: not available (covers the just-installed update)", async () => {
  assert.equal((await checkForUpdate("0.2.0", async () => res(200, release("v0.2.0")))).available, false);
  assert.equal((await checkForUpdate("0.3.0", async () => res(200, release("v0.2.0")))).available, false);
});

test("no releases yet (404) and network errors are quiet", async () => {
  assert.deepEqual(await checkForUpdate("0.1.0", async () => res(404, {})), { available: false, currentVersion: "0.1.0", reason: "HTTP 404" });
  const err = await checkForUpdate("0.1.0", async () => { throw new Error("offline"); });
  assert.equal(err.available, false);
  assert.equal(err.reason, "offline");
});

test("isCheckDue: never checked, stale, or clock went backwards → due; recent → not due", () => {
  const hour = 60 * 60 * 1000;
  assert.equal(isCheckDue(undefined, 10 * hour, 6 * hour), true);
  assert.equal(isCheckDue(1 * hour, 10 * hour, 6 * hour), true);
  assert.equal(isCheckDue(5 * hour, 10 * hour, 6 * hour), false);
  assert.equal(isCheckDue(20 * hour, 10 * hour, 6 * hour), true);
});
