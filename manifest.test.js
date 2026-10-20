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
  for (const p of ["debugger", "alarms", "unlimitedStorage", "tabs"]) assert.ok(manifest.permissions.includes(p), p);
  assert.ok(manifest.host_permissions.includes("https://build.novacura.com/*"));
  assert.ok(manifest.optional_host_permissions.includes("https://*/*"));
  assert.equal(manifest.content_scripts[0].js[0], "content/designer.js");
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://build.novacura.com/*"]);
});

const fs = require("node:fs");
const path = require("node:path");

test("manifest grants what Quick Reports and the update check need", () => {
  assert.ok(manifest.permissions.includes("downloads"));
  assert.ok(manifest.host_permissions.includes("https://api.github.com/*"));
});

test("every script background.js imports exists", () => {
  const src = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
  const block = src.match(/importScripts\(([\s\S]*?)\);/)[1];
  const files = [...block.matchAll(/"([^"]+\.js)"/g)].map((m) => m[1]);
  for (const f of ["lib/ifs-client.js", "lib/ifs-permissions.js", "lib/qr-deploy.js", "lib/qr-history.js", "lib/gh-library.js", "lib/qr-library.js", "lib/cl-library.js", "lib/custom-lu-model.js", "lib/github-settings.js", "lib/qr-service.js", "lib/update-check.js"]) {
    assert.ok(files.includes(f), `importScripts is missing ${f}`);
  }
  for (const f of files) assert.ok(fs.existsSync(path.join(__dirname, f)), `${f} does not exist`);
});

test("importScripts loads the IFS client before its users", () => {
  const src = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
  const block = src.match(/importScripts\(([\s\S]*?)\);/)[1];
  const files = [...block.matchAll(/"([^"]+\.js)"/g)].map((m) => m[1]);
  const at = (f) => files.indexOf(f);
  assert.ok(at("lib/ifs-client.js") < at("lib/ifs-permissions.js"));
  assert.ok(at("lib/gh-library.js") < at("lib/qr-library.js"));
  assert.ok(at("lib/gh-library.js") < at("lib/cl-library.js"));
  assert.ok(at("lib/ifs-permissions.js") < at("lib/qr-deploy.js"));
});

test("every <script src> in the extension pages exists", () => {
  for (const page of ["sidepanel.html", "qr-editor.html"]) {
    const html = fs.readFileSync(path.join(__dirname, page), "utf8");
    for (const m of html.matchAll(/<script src="([^"]+)"/g)) assert.ok(fs.existsSync(path.join(__dirname, m[1])), `${page}: ${m[1]} does not exist`);
  }
});
