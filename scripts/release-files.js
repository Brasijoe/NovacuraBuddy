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

module.exports = { collectReleaseFiles };
