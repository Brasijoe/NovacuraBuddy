(function (global) {
  // The org-level "QuickReports" Flow module: Flow's code generator output for the IFS projection
  // QuickReports (one `Structure_<id>` type and one `QuickReport_<id>` function per public Quick
  // Report, then GetColumnNames/GetParameters/...). "Only used reports" drops the blocks of
  // every id that no flow of the org calls (found by the Quick Report usage scan).
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

  // IFS names every column of a Quick Report "C<n>_<NAME>" (C1_FA_NUMMER). The module hides that prefix:
  // the Structure_<id> fields and the JSON keys the functions read lose it, and GetColumnNames returns the
  // plain names. A report whose names would clash (or not be valid identifiers) once cut keeps IFS's names.
  const FIELD_LINE = /^(\s*)C\d+_([^:\s]*)(\s*:.*)$/;
  const KEYWORDS = new Set(["let", "type", "function", "case", "when", "then", "else", "end", "not", "and", "or", "in", "is", "true", "false", "null", "new", "return", "if", "where", "open", "with", "as", "from", "private", "any", "text", "number", "datetime", "boolean"]);
  // Cuts everything up to and including the first "_" from the labels of every result record.
  const HELPER = `private function RemoveColumnPrefixes(rows: {}*): {}* =>
    Seq.map(rows, row =>
        Record.mapLabels(row, label => regexReplace(label, "^[^_]*_", ""))
    )
`;
  const NAME_RE = `'(?<![A-Za-z0-9_])C[0-9]+_'`;

  /** Strips the "C<n>_" prefix from the column names of every Quick Report in the module code. */
  function stripColumnPrefixes(code) {
    const lines = normalize(code).split("\n");
    // 1. which reports can lose the prefix
    const safe = new Set();
    for (let i = 0; i < lines.length; i++) {
      const head = lines[i].match(TYPE_HEAD);
      if (!head) continue;
      const names = [];
      let ok = true;
      for (let j = i + 1; j < lines.length && lines[j] !== "}"; j++) {
        const f = lines[j].match(FIELD_LINE);
        if (!f) { ok = false; break; }
        names.push(f[2]);
      }
      const lower = names.map((n) => n.toLowerCase());
      if (ok && names.length && names.every((n) => /^[\p{L}_][\p{L}\p{N}_]*$/u.test(n) && !KEYWORDS.has(n)) && new Set(lower).size === lower.length) safe.add(head[1]);
    }
    // 2. rewrite them
    let typeId = null, fnId = null, columnNames = false;
    const out = lines.map((line) => {
      const th = line.match(TYPE_HEAD);
      if (th) typeId = th[1];
      else if (line === "}") typeId = null;
      else if (typeId && safe.has(typeId)) { const f = line.match(FIELD_LINE); if (f) return `${f[1]}${f[2]}${f[3]}`; }
      const fh = line.match(FUNCTION_HEAD);
      if (fh) fnId = fh[1];
      columnNames = /^function GetColumnNames\(/.test(line) ? true : line === "}" ? false : columnNames;
      if (fnId && safe.has(fnId) && /^\s*return unsafeCast<Structure_\d+\*>\(__result\);\s*$/.test(line)) return line.replace(/\(__result\)/, "(RemoveColumnPrefixes(__result))");
      if (columnNames && /return JSON\.deserialize<\{value: text\?\}>\(.*, headers\)\)\.value;\s*$/.test(line)) {
        return line.replace(/^(\s*)return (.*, headers\)\)\.value);\s*$/, (_, ind, expr) => `${ind}let __names = ${expr.replace(/\.value$/, ".value")};\n${ind}return case when __names != null then __names.regexReplace(${NAME_RE}, '') else __names end;`);
      }
      if (line === "}") fnId = null;
      return line;
    });
    const text = out.join("\n");
    // the helper goes in front of GetColumnNames, once
    return text.includes("RemoveColumnPrefixes(__result)") && !text.includes("function RemoveColumnPrefixes")
      ? text.replace(/^function GetColumnNames\(/m, `${HELPER}\nfunction GetColumnNames(`) : text;
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
    const code = stripColumnPrefixes(deployedIds ? keepOnly(full, deployedIds) : full);
    const existing = await readExisting();
    const diff = compare(code, existing && existing.source);
    if (diff.lost.length && !force) return { status: "needsConfirmation", ...diff };
    const asset = await commit(code, existing && existing.asset);
    return { status: "done", assetId: asset && asset.id, ...diff, fullCount: reportIds(full).length };
  }

  const api = { MODULE_NAME, PROJECTION_NAME, reportIds, keepOnly, compare, stripColumnPrefixes, updateQuickReportsModule };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.QuickReportsModule = api;
})(typeof window !== "undefined" ? window : globalThis);
