const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const EXCLUDED_ROOT_DIRS = new Set(["node_modules", "docs", "firefox", "scripts", "dist"]);
const EXCLUDED_ROOT_FILES = new Set(["package.json", "package-lock.json"]);

/** Files that make up the installable extension, relative to `rootDir`, sorted. */
function collectReleaseFiles(rootDir) {
  const out = [];
  (function walk(rel) {
    for (const entry of fs.readdirSync(path.join(rootDir, rel), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const atRoot = !rel;
      if (entry.isDirectory()) {
        if (atRoot && EXCLUDED_ROOT_DIRS.has(entry.name)) continue;
        walk(relPath);
        continue;
      }
      if (entry.name.endsWith(".test.js")) continue;
      if (atRoot && (EXCLUDED_ROOT_FILES.has(entry.name) || entry.name.endsWith(".zip") || entry.name.endsWith(".md"))) continue;
      out.push(relPath);
    }
  })("");
  return out.sort();
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Zips the CONTENTS of stageDir into zipPath (no wrapper folder), so manifest.json sits at the zip root.
 * Windows PowerShell only (Compress-Archive).
 */
function zipDirectoryContents(stageDir, zipPath) {
  const command = `Compress-Archive -Path (Join-Path ${psQuote(stageDir)} '*') -DestinationPath ${psQuote(zipPath)} -Force`;
  execFileSync("powershell", ["-NoProfile", "-Command", command], { stdio: "inherit" });
}

module.exports = { collectReleaseFiles, zipDirectoryContents };
