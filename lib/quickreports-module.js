(function (global) {
  // The org-level "QuickReports" Flow module: Flow's code generator output for the IFS projection
  // QuickReports (one `Structure_<id>` type and one `QuickReport_<id>` function per public Quick
  // Report, then GetColumnNames/GetParameters/...). "Only created reports" drops the blocks of
  // every id that was not deployed through NovacuraBuddy to the chosen instance.
  const MODULE_NAME = "QuickReports";
  const PROJECTION_NAME = "QuickReports";

  const TYPE_HEAD = /^type Structure_(\d+)\s*=/;
  const FUNCTION_HEAD = /^function QuickReport_(\d+)\s*\(/;

  const normalize = (code) => String(code).replace(/\r\n?/g, "\n");

  /** Ids (as strings) of the Quick Reports a module's code contains, in file order. */
  function reportIds(code) {
    const ids = [];
    for (const line of normalize(code).split("\n")) {
      const m = line.match(FUNCTION_HEAD);
      if (m) ids.push(m[1]);
    }
    return ids;
  }

  /** Removes the type and the function of every report whose id is not in `keepIds`. A block runs
   *  from its head line to the next line that is exactly "}"; the blank line after it goes too. */
  function keepOnly(code, keepIds) {
    const keep = new Set([...keepIds].map((id) => String(id).replace(/\.0+$/, "")));
    const out = [];
    let skipping = false;
    let dropBlank = false;
    for (const line of normalize(code).split("\n")) {
      if (skipping) {
        if (line === "}") { skipping = false; dropBlank = true; }
        continue;
      }
      const m = line.match(TYPE_HEAD) || line.match(FUNCTION_HEAD);
      if (m && !keep.has(m[1])) {
        // Comment lines directly above the dropped block belong to it.
        while (out.length && /^\s*(\/\/|\/\*\*|\*)/.test(out[out.length - 1])) out.pop();
        // A single-line block (head and closing brace on one line) has no body to skip.
        if (line.trim() !== "}" && !/\}\s*$/.test(line)) skipping = true;
        else dropBlank = true;
        continue;
      }
      if (dropBlank && line.trim() === "") { dropBlank = false; continue; }
      dropBlank = false;
      out.push(line);
    }
    return out.join("\n");
  }

  /** How the new module compares with the one in Flow. `existingCode` null = no module yet. */
  function compare(newCode, existingCode) {
    const next = reportIds(newCode);
    const nextSet = new Set(next);
    const current = existingCode ? reportIds(existingCode) : [];
    const currentSet = new Set(current);
    return {
      total: next.length,
      added: next.filter((id) => !currentSet.has(id)).length,
      existing: current.length,
      lost: current.filter((id) => !nextSet.has(id))
    };
  }

  /** Generates (or takes) the full code, filters it, and compares with the existing module.
   *  deps: generate() -> code, readExisting() -> {asset, source} | null,
   *  commit(code, asset|null) -> asset, deployedIds: string[] | null (null = full module) */
  async function updateQuickReportsModule({ generate, readExisting, commit, deployedIds, force }) {
    const full = await generate();
    const code = deployedIds ? keepOnly(full, deployedIds) : full;
    const existing = await readExisting();
    const diff = compare(code, existing && existing.source);
    if (diff.lost.length && !force) return { status: "needsConfirmation", ...diff };
    const asset = await commit(code, existing && existing.asset);
    return { status: "done", assetId: asset && asset.id, ...diff, fullCount: reportIds(full).length };
  }

  const api = { MODULE_NAME, PROJECTION_NAME, reportIds, keepOnly, compare, updateQuickReportsModule };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.QuickReportsModule = api;
})(typeof window !== "undefined" ? window : globalThis);
