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

test("zipDirectoryContents puts the directory's contents at the zip root, with no wrapper folder", { skip: process.platform !== "win32" && "Windows-only (PowerShell)" }, () => {
  const { execFileSync } = require("node:child_process");
  const { zipDirectoryContents } = require("./release-files.js");
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "nb-stage-"));
  fs.mkdirSync(path.join(stage, "lib"), { recursive: true });
  fs.writeFileSync(path.join(stage, "manifest.json"), "{}");
  fs.writeFileSync(path.join(stage, "lib", "a.js"), "x");
  const zipPath = path.join(os.tmpdir(), `nb-zip-${process.pid}-${Date.now()}.zip`);
  zipDirectoryContents(stage, zipPath);
  const names = execFileSync("powershell", ["-NoProfile", "-Command",
    `Add-Type -A System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::OpenRead('${zipPath}').Entries | ForEach-Object { $_.FullName }`],
    { encoding: "utf8" }).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  fs.rmSync(zipPath, { force: true });
  fs.rmSync(stage, { recursive: true, force: true });
  assert.ok(names.includes("manifest.json"), `manifest.json not at zip root; entries: ${names}`);
  // Entry names must use "/": Windows PowerShell 5.1's Compress-Archive writes "lib\a.js", which
  // Mac/Linux/7-Zip unpack as one flat file named "lib\a.js".
  assert.ok(names.includes("lib/a.js"), `lib/a.js missing; entries: ${names}`);
  assert.ok(names.every((n) => !n.startsWith(path.basename(stage) + "/")), `wrapper folder found; entries: ${names}`);
});
