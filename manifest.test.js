const test = require("node:test");
const assert = require("node:assert/strict");
const manifest = require("./manifest.json");

test("manifest declares MV3 with the required surfaces", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, "background.js");
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  assert.ok(manifest.permissions.includes("storage"));
  assert.ok(manifest.permissions.includes("sidePanel"));
  assert.ok(manifest.permissions.includes("webRequest"));
  assert.ok(manifest.host_permissions.includes("https://build.novacura.com/*"));
  assert.ok(manifest.optional_host_permissions.includes("https://*/*"));
  assert.equal(manifest.content_scripts[0].js[0], "content/designer.js");
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://build.novacura.com/*"]);
});
