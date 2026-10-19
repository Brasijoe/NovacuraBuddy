const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { collectReleaseFiles } = require("./release-files.js");

test("ships the extension, never tests, docs, firefox, scripts, dot-files or package files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nb-files-"));
  const files = [
    "manifest.json", "background.js", "sidepanel.html", "qr-editor.html",
    "lib/qr-deploy.js", "lib/qr-deploy.test.js", "lib/vendor/fuse.min.js", "lib/vendor/VENDOR.md",
    "recorder/viewer.js", "icons/icon16.png",
    "docs/superpowers/specs/x.md", "firefox/manifest.json", "scripts/release.js", "node_modules/a/index.js",
    ".git/HEAD", ".gitignore", "package.json", "package-lock.json", "manifest.test.js", "NovacuraBuddy-v0.1.0.zip"
  ];
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), "x");
  }
  assert.deepEqual(collectReleaseFiles(root), [
    "background.js", "icons/icon16.png", "lib/qr-deploy.js", "lib/vendor/VENDOR.md", "lib/vendor/fuse.min.js",
    "manifest.json", "qr-editor.html", "recorder/viewer.js", "sidepanel.html"
  ]);
});
