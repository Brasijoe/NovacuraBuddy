const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const EXCLUDED_ROOT_DIRS = new Set(["node_modules", "docs", "firefox", "scripts", "dist"]);
const EXCLUDED_ROOT_FILES = new Set(["package.json", "package-lock.json"]);
const EXCLUDED_DIRS = new Set(["apimodule/fixtures"]); // test-only data

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
        if (EXCLUDED_DIRS.has(relPath)) continue;
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
// Entries are written one by one with "/" separators: Windows PowerShell 5.1's Compress-Archive
// stores "panels\common.js", which Mac/Linux/7-Zip unpack as a single flat file of that name.
function zipDirectoryContents(stageDir, zipPath) {
  const command = [
    "Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem",
    `$stage = (Resolve-Path -LiteralPath ${psQuote(stageDir)}).Path.TrimEnd('\\')`,
    `$zip = ${psQuote(zipPath)}`,
    "if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }",
    "$archive = [IO.Compression.ZipFile]::Open($zip, 'Create')",
    "try { Get-ChildItem -LiteralPath $stage -Recurse -File | ForEach-Object {",
    "  $name = $_.FullName.Substring($stage.Length + 1).Replace('\\', '/')",
    "  [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $name, 'Optimal') } }",
    "finally { $archive.Dispose() }"
  ].join("\n");
  execFileSync("powershell", ["-NoProfile", "-Command", command], { stdio: "inherit" });
}

module.exports = { collectReleaseFiles, zipDirectoryContents };
