// Cuts a NovacuraBuddy release: bump manifest version, test, zip, commit, tag, push, and publish a
// GitHub Release with the zip — the asset the in-extension update banner downloads.
// Usage: npm run release -- 0.2.0 [--dry-run]
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { collectReleaseFiles } = require("./release-files.js");
const { compareVersions } = require("../lib/update-check.js");

const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}
const run = (cmd, cmdArgs, opts = {}) => execFileSync(cmd, cmdArgs, { cwd: root, stdio: "inherit", ...opts });
const out = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { cwd: root, encoding: "utf8" }).trim();

if (!/^\d+\.\d+\.\d+$/.test(version || "")) fail("usage: npm run release -- <x.y.z> [--dry-run]");

const manifestPath = path.join(root, "manifest.json");
const manifestText = fs.readFileSync(manifestPath, "utf8");
const current = JSON.parse(manifestText).version;
if (compareVersions(version, current) <= 0) fail(`version ${version} must be newer than the current ${current}.`);

const files = collectReleaseFiles(root);
const zipName = `NovacuraBuddy-v${version}.zip`;
if (dryRun) {
  console.log(files.join("\n"));
  console.log(`\n${files.length} files would go into ${zipName} (current version ${current}).`);
  process.exit(0);
}

if (out("git", ["branch", "--show-current"]) !== "master") fail("releases are cut from master — switch to master first.");
if (out("git", ["status", "--porcelain"])) fail("working tree isn't clean — commit or stash first.");

run("npm", ["test"], { shell: true });

fs.writeFileSync(manifestPath, manifestText.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`));

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "nb-release-"));
for (const f of files) {
  const dest = path.join(stage, f);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(root, f), dest);
}
const zipPath = path.join(root, zipName);
run("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${stage}\*' -DestinationPath '${zipPath}' -Force`]);

run("git", ["commit", "-am", `chore: release v${version}`]);
run("git", ["tag", `v${version}`]);
run("git", ["push", "origin", "master", `v${version}`]);
run("gh", ["release", "create", `v${version}`, zipPath, "--title", `v${version}`, "--generate-notes"]);

fs.rmSync(zipPath, { force: true });
fs.rmSync(stage, { recursive: true, force: true });
console.log(`Released v${version}.`);
