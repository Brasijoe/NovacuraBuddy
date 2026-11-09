/* ============================================================
   Module Merge — keeps hand-made changes when a module is
   generated again (API modules and IFS projection modules).

   Two kinds of block in the module code, written as `//` comments
   (module search only reads doc comments, so they add no noise):

     // @custom-add <id> [after:<Name>]
     ...your own types / functions...
     // @custom-end

     // @custom-replace <Name> [orig:<hash>]
     ...your version of the declaration <Name>...
     // @custom-end

   On regeneration: every custom-add block is copied back (after the
   declaration named in `after:`, else at the end); a custom-replace
   block takes the place of the generated declaration with that name.
   Anything outside the markers that is not generated is dropped, and
   the report says so.
   ============================================================ */
(function (global) {
  const BEGIN = /^\s*\/\/\s*@custom-(add|replace)\s+(\S+)(.*)$/;
  const END = /^\s*\/\/\s*@custom-end\b/;
  const DECL = /^(?:private\s+)?(?:function|type|let|module)\s+"?([A-Za-z_][A-Za-z0-9_]*)/;

  /** FNV-1a over the text, 8 hex digits: only a change detector, not security. */
  function shortHash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  /** Per line: bracket depth after the line, ignoring strings, template text and comments. */
  function lineDepths(lines) {
    const out = [];
    let depth = 0;
    let inBlock = false;
    let inTemplate = 0; // template literals nest through {…}; only the simple case is tracked
    let quote = null;
    for (const line of lines) {
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        const n = line[i + 1];
        if (inBlock) {
          if (c === "*" && n === "/") { inBlock = false; i++; }
          continue;
        }
        if (quote) {
          if (c === "\\") i++;
          else if (c === quote) quote = null;
          continue;
        }
        if (inTemplate) {
          if (c === "\\") i++;
          else if (c === "`") inTemplate = 0;
          continue;
        }
        if (c === "/" && n === "*") { inBlock = true; i++; continue; }
        if (c === "/" && n === "/") break;
        if (c === "'" || c === '"') { quote = c; continue; }
        if (c === "`") { inTemplate = 1; continue; }
        if (c === "{" || c === "(" || c === "[") depth++;
        else if (c === "}" || c === ")" || c === "]") depth--;
      }
      quote = null; // a plain string never spans lines
      out.push({ depth, inBlock, inTemplate: !!inTemplate });
    }
    return out;
  }

  /** Splits code into top-level chunks. A chunk is a declaration with the comment lines directly
   *  above it, or a run of other lines (`name: null`). */
  function splitChunks(code) {
    const lines = String(code).replace(/\r\n/g, "\n").split("\n");
    const depths = lineDepths(lines);
    const chunks = [];
    let i = 0;
    while (i < lines.length) {
      if (!lines[i].trim()) { i++; continue; }
      let start = i;
      // Comment lines directly above (no blank line) belong to the next declaration.
      let j = i;
      let inDoc = false;
      while (j < lines.length) {
        const t = lines[j].trim();
        if (inDoc) { if (t.includes("*/")) inDoc = false; j++; continue; }
        if (t.startsWith("/*")) { inDoc = !t.includes("*/"); j++; continue; }
        if (t.startsWith("//")) { j++; continue; }
        break;
      }
      const m = j < lines.length ? lines[j].match(DECL) : null;
      if (!m) {
        // Not a declaration: a loose run up to the next blank line at depth 0.
        let k = i;
        while (k < lines.length && (lines[k].trim() || depths[k - 1] && depths[k - 1].depth > 0)) k++;
        chunks.push({ name: null, start, end: Math.max(k, i + 1), lines: lines.slice(start, Math.max(k, i + 1)) });
        i = Math.max(k, i + 1);
        continue;
      }
      let k = j;
      for (; k < lines.length; k++) {
        const d = depths[k];
        const t = lines[k].trim();
        if (d.depth <= 0 && !d.inBlock && !d.inTemplate && (t.endsWith(";") || t.endsWith("}"))) { k++; break; }
      }
      if (k > lines.length) k = lines.length;
      chunks.push({ name: m[1], start, end: k, bodyStart: j, lines: lines.slice(start, k), body: lines.slice(j, k).join("\n") });
      i = k;
    }
    return { lines, chunks };
  }

  /** Reads the custom blocks of a module's code. Their lines (markers included) are returned as
   *  `text`; `rest` is the code without them. */
  function extractBlocks(code) {
    const lines = String(code || "").replace(/\r\n/g, "\n").split("\n");
    const blocks = [];
    const rest = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(BEGIN);
      if (!m) { rest.push(lines[i]); continue; }
      let j = i + 1;
      while (j < lines.length && !END.test(lines[j])) j++;
      const body = lines.slice(i + 1, j);
      const attrs = {};
      for (const a of (m[3] || "").trim().split(/\s+/).filter(Boolean)) {
        const kv = a.match(/^(after|orig):(.+)$/);
        if (kv) attrs[kv[1]] = kv[2];
      }
      blocks.push({ kind: m[1], key: m[2], attrs, body, closed: j < lines.length });
      i = j; // skip the end marker
    }
    return { blocks, rest: rest.join("\n") };
  }

  function renderBlock(b, extra) {
    const attrs = [];
    if (b.kind === "add" && b.attrs.after) attrs.push(`after:${b.attrs.after}`);
    if (b.kind === "replace" && (extra && extra.orig || b.attrs.orig)) attrs.push(`orig:${(extra && extra.orig) || b.attrs.orig}`);
    return [`// @custom-${b.kind} ${b.key}${attrs.length ? " " + attrs.join(" ") : ""}`, ...b.body, "// @custom-end"].join("\n");
  }

  /** Merges the custom blocks of `existing` into the freshly `generated` code.
   *  Returns { code, report: { kept: [ids], replaced: [names], orphans: [names], changed: [names],
   *  lost: [names], warnings: [text] } }. Without any block the generated code is returned as is. */
  function mergeCustomCode(generated, existing) {
    const report = { kept: [], replaced: [], orphans: [], changed: [], lost: [], warnings: [] };
    const gen = String(generated || "");
    const { blocks, rest } = extractBlocks(existing);
    for (const b of blocks) if (!b.closed) report.warnings.push(`Block "${b.key}" has no "// @custom-end" and was taken up to the end of the module.`);

    // Declarations outside the markers that the generator no longer produces would silently vanish.
    if (existing && String(existing).trim()) {
      const generatedNames = new Set(splitChunks(gen).chunks.map((c) => c.name).filter(Boolean));
      const customNames = new Set(blocks.flatMap((b) => splitChunks(b.body.join("\n")).chunks.map((c) => c.name).filter(Boolean)));
      for (const c of splitChunks(rest).chunks) {
        if (c.name && !generatedNames.has(c.name) && !customNames.has(c.name)) report.lost.push(c.name);
      }
      if (report.lost.length) {
        report.warnings.push(`Not generated and not inside a custom block, so removed: ${report.lost.join(", ")}. Wrap hand-made code in // @custom-add … // @custom-end to keep it.`);
      }
    }
    if (!blocks.length) return { code: gen, report };

    const { lines, chunks } = splitChunks(gen);
    const replaceByName = new Map();
    const adds = [];
    for (const b of blocks) {
      if (b.kind === "replace") {
        if (chunks.some((c) => c.name === b.key)) { replaceByName.set(b.key, b); continue; }
        report.orphans.push(b.key);
        report.warnings.push(`Replacement of "${b.key}" has no generated declaration of that name any more; the block was kept at the end.`);
        adds.push({ ...b, kind: "replace", orphan: true });
      } else {
        adds.push(b);
      }
    }

    const out = [];
    const afterAnchor = new Map(); // name -> blocks to place after that declaration
    const tail = [];
    for (const b of adds) {
      const anchor = b.kind === "add" && b.attrs.after;
      if (anchor && chunks.some((c) => c.name === anchor)) {
        if (!afterAnchor.has(anchor)) afterAnchor.set(anchor, []);
        afterAnchor.get(anchor).push(b);
      } else {
        if (anchor) report.warnings.push(`Block "${b.key}" was meant to follow "${anchor}", which is not generated any more; it was kept at the end.`);
        tail.push(b);
      }
    }

    let pos = 0;
    for (const c of chunks) {
      out.push(...lines.slice(pos, c.start));
      pos = c.end;
      const rep = c.name && replaceByName.get(c.name);
      if (rep) {
        const orig = shortHash(c.body);
        if (rep.attrs.orig && rep.attrs.orig !== orig) {
          report.changed.push(c.name);
          report.warnings.push(`The generated "${c.name}" changed since you replaced it. Your version was kept: check that it still fits.`);
        }
        out.push(renderBlock(rep, { orig }));
        report.replaced.push(c.name);
      } else {
        out.push(...c.lines);
      }
      for (const b of afterAnchor.get(c.name) || []) {
        out.push("", renderBlock(b));
        report.kept.push(b.key);
      }
    }
    out.push(...lines.slice(pos));
    if (tail.length) {
      while (out.length && !out[out.length - 1].trim()) out.pop();
      out.push("", "/* ---------- Custom code ---------- */");
      for (const b of tail) {
        out.push("", renderBlock(b));
        if (b.kind === "add") report.kept.push(b.key);
      }
    }
    return { code: out.join("\n").replace(/\n*$/, "\n"), report };
  }

  /** One short line for the notice after saving. */
  function describeReport(report) {
    if (!report) return "";
    const parts = [];
    if (report.kept.length) parts.push(`${report.kept.length} added block${report.kept.length === 1 ? "" : "s"} kept`);
    if (report.replaced.length) parts.push(`${report.replaced.length} replaced declaration${report.replaced.length === 1 ? "" : "s"} applied`);
    if (report.warnings.length) parts.push(`${report.warnings.length} warning${report.warnings.length === 1 ? "" : "s"}`);
    return parts.join(", ");
  }

  const api = { mergeCustomCode, extractBlocks, splitChunks, describeReport, shortHash };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.ModuleMerge = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
