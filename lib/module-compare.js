(function (global) {
  // Module compare after an IFS upgrade: the FlowScript a module holds now against the code Flow's
  // code generator makes from the upgraded IFS projection. Pure functions only — the background
  // reads Flow and IFS, this splits both sources into their top-level declarations (functions,
  // types, lets), diffs them per declaration, rates each change and works out which of the
  // functions and types the flows actually use are hit (including the sub-functions and types
  // they depend on).

  const SEVERITIES = ["critical", "major", "minor", "info"];
  const rank = (s) => (s ? SEVERITIES.indexOf(s) : SEVERITIES.length);
  const worst = (list) => (list || []).reduce((w, s) => (rank(s) < rank(w) ? s : w), null);

  /** The source without its generated header comment (import source, timestamp, build number),
   *  which changes on every generation. */
  function stripHeader(source) {
    return String(source || "").replace(/^\s*\/\*[\s\S]*?\*\/\s*/, (m) => (/#importSource|Auto generated code/.test(m) ? "" : m));
  }

  const DECL_RE = /^(private\s+)?(function|type|let)\s+([A-Za-z_][A-Za-z0-9_]*)/;

  /** Top-level declarations in source order: [{ key, name, kind, private, text }]. A declaration
   *  starts at a line (column 0) with function/type/let and runs to the next one; the comment
   *  lines right above it belong to it. Generated modules are written this way. */
  function parseDeclarations(source) {
    const lines = stripHeader(source).split(/\r?\n/);
    const decls = [];
    let current = null, pendingComment = [];
    let inBlockComment = false;
    for (const line of lines) {
      const m = !inBlockComment && DECL_RE.exec(line);
      if (m) {
        while (pendingComment.length && !pendingComment[0].trim()) pendingComment.shift();
        current = { name: m[3], kind: m[2], private: !!m[1], lines: [...pendingComment, line] };
        decls.push(current);
        pendingComment = [];
        continue;
      }
      // Comment and blank lines wait: above a declaration they are its doc comment, otherwise
      // they belong to the declaration they sit in.
      const trimmed = line.trim();
      const isComment = inBlockComment || trimmed.startsWith("//") || trimmed.startsWith("/*");
      if (trimmed.startsWith("/*") && !trimmed.includes("*/")) inBlockComment = true;
      else if (inBlockComment && trimmed.includes("*/")) inBlockComment = false;
      if (isComment || !trimmed) {
        if (isComment || pendingComment.length) pendingComment.push(line);
        else if (current) current.lines.push(line);
      } else if (current) {
        current.lines.push(...pendingComment, line);
        pendingComment = [];
      } else {
        pendingComment = [];
      }
    }
    const seen = new Map();
    return decls.map((d) => {
      const base = `${d.kind}:${d.name}`;
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      while (d.lines.length && !d.lines[d.lines.length - 1].trim()) d.lines.pop();
      return { key: n > 1 ? `${base}#${n}` : base, name: d.name, kind: d.kind, private: d.private, text: d.lines.join("\n") };
    });
  }

  /** The text without comments and with whitespace collapsed: what decides "changed". */
  function normalize(text) {
    return String(text || "")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1")
      .replace(/\s+/g, " ")
      .replace(/\s*([,;:(){}[\]=<>|*?])\s*/g, "$1")
      .replace(/,([}\])])/g, "$1")
      .replace(/;$/, "")
      .trim();
  }

  /** Splits at top-level commas/newlines (outside (), {}, [] and strings). */
  function splitTop(text, separators = ",") {
    const parts = [];
    let depth = 0, quote = null, start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quote) { if (c === quote && text[i - 1] !== "\\") quote = null; continue; }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") depth--;
      else if (depth === 0 && separators.includes(c)) { parts.push(text.slice(start, i)); start = i + 1; }
    }
    parts.push(text.slice(start));
    return parts.map((p) => p.trim()).filter(Boolean);
  }

  /** The text between the bracket at `open` and its partner, or null. */
  function balanced(text, open) {
    const pairs = { "(": ")", "{": "}", "[": "]" };
    const close = pairs[text[open]];
    let depth = 0, quote = null;
    for (let i = open; i < text.length; i++) {
      const c = text[i];
      if (quote) { if (c === quote && text[i - 1] !== "\\") quote = null; continue; }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === text[open]) depth++;
      else if (c === close && --depth === 0) return { inner: text.slice(open + 1, i), end: i };
    }
    return null;
  }

  const stripComments = (text) => String(text || "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

  /** A function's parameters [{ name, type, optional }] and return type. */
  function parseFunction(text) {
    const src = stripComments(text);
    const head = /function\s+[A-Za-z_][A-Za-z0-9_]*\s*(<[^>(]*>)?\s*/.exec(src);
    if (!head) return null;
    const open = head.index + head[0].length;
    if (src[open] !== "(") return null;
    const b = balanced(src, open);
    if (!b) return null;
    const params = splitTop(b.inner).map((p) => {
      const eq = /=(?!>)/.exec(p);
      const decl = (eq ? p.slice(0, eq.index) : p).trim();
      const colon = decl.indexOf(":");
      return {
        name: (colon >= 0 ? decl.slice(0, colon) : decl).trim(),
        type: colon >= 0 ? normalize(decl.slice(colon + 1)) : "",
        optional: !!eq
      };
    });
    const rest = src.slice(b.end + 1);
    const ret = /^\s*:\s*([\s\S]*?)\s*(=>|\{)/.exec(rest);
    return { params, returnType: ret ? normalize(ret[1]) : "" };
  }

  /** A record type's fields [{ name, type, optional }], or null when the type is not a record. */
  function parseRecordType(text) {
    const src = stripComments(text);
    const eq = /type\s+[A-Za-z_][A-Za-z0-9_]*\s*(<[^>]*>)?\s*=\s*/.exec(src);
    if (!eq) return null;
    const open = eq.index + eq[0].length;
    if (src[open] !== "{") return null;
    const b = balanced(src, open);
    if (!b) return null;
    return splitTop(b.inner, ",\n").map((f) => {
      let rest = f.trim();
      const optionalKw = /^optional\s+/.test(rest);
      if (optionalKw) rest = rest.replace(/^optional\s+/, "");
      const m = /^("[^"]*"|'[^']*'|[A-Za-z_$@][\w$@.]*)\s*:?\s*([\s\S]*)$/.exec(rest);
      if (!m) return null;
      const name = m[1].replace(/^["']|["']$/g, "");
      let type = m[2], hasDefault = false;
      const d = /=(?!>)/.exec(type);
      if (d) { hasDefault = true; type = type.slice(0, d.index); }
      type = normalize(type);
      return { name, type, optional: optionalKw || hasDefault || /\?$/.test(type) };
    }).filter(Boolean);
  }

  /** Identifiers a declaration mentions (outside comments). */
  function identifiersIn(text) {
    return new Set(stripComments(text).match(/[A-Za-z_][A-Za-z0-9_]*/g) || []);
  }

  /* --- Diff --- */

  /** Line diff [{ op: "=" | "+" | "-", text }] with the common head and tail trimmed first; null
   *  when the middle is too big to compare line by line. */
  function lineDiff(a, b) {
    const x = String(a || "").split(/\r?\n/), y = String(b || "").split(/\r?\n/);
    let head = 0;
    while (head < x.length && head < y.length && x[head] === y[head]) head++;
    let tail = 0;
    while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
    const xm = x.slice(head, x.length - tail), ym = y.slice(head, y.length - tail);
    const out = x.slice(0, head).map((text) => ({ op: "=", text }));
    if (xm.length * ym.length > 4000000) return null;
    const L = Array.from({ length: xm.length + 1 }, () => new Uint32Array(ym.length + 1));
    for (let i = xm.length - 1; i >= 0; i--) for (let j = ym.length - 1; j >= 0; j--) {
      L[i][j] = xm[i] === ym[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
    let i = 0, j = 0;
    while (i < xm.length && j < ym.length) {
      if (xm[i] === ym[j]) { out.push({ op: "=", text: xm[i] }); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: "-", text: xm[i++] });
      else out.push({ op: "+", text: ym[j++] });
    }
    while (i < xm.length) out.push({ op: "-", text: xm[i++] });
    while (j < ym.length) out.push({ op: "+", text: ym[j++] });
    for (const text of x.slice(x.length - tail)) out.push({ op: "=", text });
    return out;
  }

  /* --- Severity --- */

  /** What changed in one declaration, each finding with a severity. `ctx` says how the flows use
   *  it: { inputType } (a record passed into a used function: a new mandatory field breaks
   *  callers) and `fieldUsed(name)` (a field name the flows mention). */
  function rateChange(oldDecl, newDecl, ctx = {}) {
    const fieldUsed = ctx.fieldUsed || (() => false);
    const findings = [];
    const add = (severity, text) => findings.push({ severity, text });
    if (!newDecl) {
      add("critical", `${oldDecl.kind === "type" ? "Type" : oldDecl.kind === "let" ? "Data source" : "Function"} ${oldDecl.name} was removed.`);
      return findings;
    }
    if (!oldDecl) { add("info", `New ${newDecl.kind === "type" ? "type" : newDecl.kind === "let" ? "data source" : "function"} ${newDecl.name}.`); return findings; }
    if (oldDecl.kind === "function") {
      const a = parseFunction(oldDecl.text), b = parseFunction(newDecl.text);
      if (a && b) {
        const before = new Map(a.params.map((p) => [p.name, p]));
        const after = new Map(b.params.map((p) => [p.name, p]));
        for (const p of b.params) {
          const o = before.get(p.name);
          if (!o) add(p.optional ? "info" : "critical", p.optional ? `New optional parameter ${p.name}.` : `New mandatory parameter ${p.name}${p.type ? `: ${p.type}` : ""}.`);
          else {
            if (o.type !== p.type) add("major", `Parameter ${p.name} changed type: ${o.type || "any"} → ${p.type || "any"}.`);
            if (o.optional && !p.optional) add("critical", `Parameter ${p.name} is now mandatory.`);
            if (!o.optional && p.optional) add("info", `Parameter ${p.name} is now optional.`);
          }
        }
        for (const o of a.params) if (!after.has(o.name)) add("major", `Parameter ${o.name} was removed.`);
        const order = (ps) => ps.filter((p) => before.has(p.name) && after.has(p.name)).map((p) => p.name).join(",");
        if (order(a.params) !== order(b.params)) add("major", "Parameter order changed.");
        if (a.returnType !== b.returnType) add("major", `Return type changed: ${a.returnType || "inferred"} → ${b.returnType || "inferred"}.`);
      }
    } else if (oldDecl.kind === "type") {
      const a = parseRecordType(oldDecl.text), b = parseRecordType(newDecl.text);
      if (a && b) {
        const before = new Map(a.map((f) => [f.name, f]));
        const after = new Map(b.map((f) => [f.name, f]));
        for (const f of b) {
          const o = before.get(f.name);
          if (!o) {
            if (f.optional) add("info", `New optional field ${f.name}.`);
            else add(ctx.inputType ? "critical" : "info", ctx.inputType ? `New mandatory field ${f.name}: ${f.type} — callers must now send it.` : `New field ${f.name} in the result.`);
          } else {
            if (o.type.replace(/\?$/, "") !== f.type.replace(/\?$/, "")) add(fieldUsed(f.name) ? "major" : "minor", `Field ${f.name} changed type: ${o.type} → ${f.type}${fieldUsed(f.name) ? " (used in flows)" : ""}.`);
            if (o.optional && !f.optional) add(ctx.inputType ? "critical" : "minor", `Field ${f.name} is now mandatory.`);
            if (!o.optional && f.optional) add(ctx.inputType ? "info" : "minor", ctx.inputType ? `Field ${f.name} is now optional.` : `Field ${f.name} can now be empty.`);
          }
        }
        for (const o of a) if (!after.has(o.name)) add(fieldUsed(o.name) ? "major" : "minor", `Field ${o.name} was removed${fieldUsed(o.name) ? " and is used in flows" : " (not used in flows)"}.`);
      }
    }
    if (!findings.length && normalize(oldDecl.text) !== normalize(newDecl.text)) {
      add("minor", oldDecl.kind === "type" ? "Type definition changed." : oldDecl.kind === "let" ? "Data source definition changed." : "Implementation changed (signature unchanged).");
    }
    return findings;
  }

  /* --- Usage in flows --- */

  /** Which of a module's public declarations a flow's text uses: `Module.name`, or the bare
   *  name as a whole word (a data source in a step, or an opened module). */
  function usedDeclarations(moduleName, decls, flowText) {
    const text = String(flowText || "");
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const out = [];
    for (const d of decls) {
      if (d.private) continue;
      if (new RegExp(`\\b${esc(moduleName)}\\s*\\.\\s*${esc(d.name)}\\b`).test(text)) out.push({ key: d.key, how: "qualified" });
      else if (d.name.length >= 4 && new RegExp(`(^|[^A-Za-z0-9_.])${esc(d.name)}\\b`).test(text)) out.push({ key: d.key, how: "name" });
    }
    return out;
  }

  /** Every declaration `key` depends on (itself included): the functions it calls and the types
   *  it uses, at any depth, in both the old and new source. */
  function closureOf(keys, graph) {
    const seen = new Set();
    const stack = [...keys];
    while (stack.length) {
      const k = stack.pop();
      if (seen.has(k)) continue;
      seen.add(k);
      for (const next of graph.get(k) || []) stack.push(next);
    }
    return seen;
  }

  function buildGraph(declLists) {
    const byName = new Map();
    for (const list of declLists) for (const d of list) {
      if (!byName.has(d.name)) byName.set(d.name, new Set());
      byName.get(d.name).add(d.key);
    }
    const graph = new Map();
    for (const list of declLists) for (const d of list) {
      const edges = graph.get(d.key) || new Set();
      for (const id of identifiersIn(d.text)) if (id !== d.name && byName.has(id)) for (const k of byName.get(id)) edges.add(k);
      graph.set(d.key, edges);
    }
    return graph;
  }

  /** The types a used function takes in (its parameter types and what they contain). */
  function inputTypesOf(usedKeys, oldByKey, graph) {
    const roots = new Set();
    for (const key of usedKeys) {
      const d = oldByKey.get(key);
      const sig = d && d.kind === "function" ? parseFunction(d.text) : null;
      if (!sig) continue;
      for (const p of sig.params) for (const id of identifiersIn(p.type)) if (oldByKey.has(`type:${id}`)) roots.add(`type:${id}`);
    }
    return new Set([...closureOf([...roots], graph)].filter((k) => k.startsWith("type:")));
  }

  /** The full comparison of one module.
   *  `usages`: [{ flowId, flowName, packageName, text }] — the flows that reference the module,
   *  with their step data as text. Returns { status, headerOnly, changes, usage, impactedCount,
   *  changedUsedCount, maxSeverity, counts }. */
  function analyzeModule({ name, oldSource, newSource, usages }) {
    const oldDecls = parseDeclarations(oldSource), newDecls = parseDeclarations(newSource);
    const oldByKey = new Map(oldDecls.map((d) => [d.key, d]));
    const newByKey = new Map(newDecls.map((d) => [d.key, d]));
    const graph = buildGraph([oldDecls, newDecls]);
    const flows = (usages || []).map((u) => ({ ...u, used: usedDeclarations(name, oldDecls, u.text) }));
    const allUsed = new Set(flows.flatMap((f) => f.used.map((u) => u.key)));
    const inputTypes = inputTypesOf(allUsed, oldByKey, graph);
    const flowText = flows.map((f) => f.text).join("\n");
    const fieldUsed = (field) => field.length >= 2 && new RegExp(`(^|[^A-Za-z0-9_])${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(flowText);
    const usedClosure = closureOf([...allUsed], graph);

    const changes = [];
    const keys = [...oldDecls.map((d) => d.key), ...newDecls.filter((d) => !oldByKey.has(d.key)).map((d) => d.key)];
    for (const key of keys) {
      const o = oldByKey.get(key) || null, n = newByKey.get(key) || null;
      if (o && n && normalize(o.text) === normalize(n.text)) continue;
      const findings = rateChange(o, n, { inputType: inputTypes.has(key), fieldUsed });
      const d = o || n;
      changes.push({
        key, name: d.name, kind: d.kind, private: d.private,
        status: !o ? "added" : !n ? "removed" : "changed",
        findings, severity: worst(findings.map((f) => f.severity)),
        used: usedClosure.has(key),
        diff: lineDiff(o ? o.text : "", n ? n.text : "")
      });
    }
    const changeByKey = new Map(changes.map((c) => [c.key, c]));

    // Per flow and used declaration: the changes in it and everything it depends on.
    const impacted = new Set(), touched = new Set();
    const usage = flows.filter((f) => f.used.length).map((f) => ({
      flowId: f.flowId, flowName: f.flowName, packageName: f.packageName || null,
      used: f.used.map(({ key, how }) => {
        const d = oldByKey.get(key);
        const hits = [...closureOf([key], graph)].map((k) => changeByKey.get(k)).filter(Boolean)
          // a new optional thing nobody calls yet can't break the caller
          .filter((c) => c.key === key || c.status !== "added");
        const severity = worst(hits.map((c) => c.severity));
        const breaking = hits.some((c) => rank(c.severity) <= rank("major"));
        if (breaking) impacted.add(key);
        else if (hits.length && rank(severity) <= rank("minor")) touched.add(key);
        return {
          key, name: d.name, kind: d.kind, how,
          status: !hits.length ? "unchanged" : breaking ? "impacted" : "changed",
          severity, changes: hits.map((c) => c.key)
        };
      }).sort((a, b) => rank(a.severity) - rank(b.severity) || a.name.localeCompare(b.name))
    })).sort((a, b) => a.flowName.localeCompare(b.flowName));

    const counts = {};
    for (const c of changes) if (c.severity) counts[c.severity] = (counts[c.severity] || 0) + 1;
    return {
      status: changes.length ? "changed" : "same",
      headerOnly: !changes.length && String(oldSource || "") !== String(newSource || ""),
      changes: changes.sort((a, b) => (b.used - a.used) || rank(a.severity) - rank(b.severity) || a.name.localeCompare(b.name)),
      usage,
      impactedCount: impacted.size, // used functions/types/data sources hit by a major or critical change
      changedUsedCount: [...touched].filter((k) => !impacted.has(k)).length, // ... by minor changes only
      maxSeverity: worst(changes.filter((c) => c.used).map((c) => c.severity)),
      counts
    };
  }

  /** Every string in a flow's step data, one per line: the text searched for module calls. */
  function flowText(designerData) {
    const out = [];
    const walk = (v) => {
      if (typeof v === "string") out.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk((designerData && designerData.data) || []);
    return out.join("\n");
  }


  /* --- Scan (reads only: Flow GETs, IFS metadata GETs and Flow's code generator) --- */

  async function pool(items, concurrency, fn) {
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  }

  /** Compares every module of an organisation (packageId null = all packages) or of one package
   *  plus the App Library with fresh code from the IFS instance, and finds where the flows of the
   *  same scope use them. `flow` = { listPackages(), listAssets(packageId|null), readSource(asset),
   *  readDesigner(flowId) }; `generateCode(projectionName)` returns the regenerated module code.
   *  A module without an `#importSource` header (not generated from IFS) is listed as skipped. */
  async function runScan({ flow, packageId, generateCode, ifsProjectionOf, onProgress, concurrency = 3 }) {
    const progress = (step, current, total) => onProgress && onProgress(step, current, total);
    progress("Reading packages", 0, 1);
    const packages = await flow.listPackages();
    const scope = packageId ? packages.filter((p) => p.id === packageId) : packages;
    if (packageId && !scope.length) throw new Error("The chosen package was not found in this organisation.");
    const locations = [{ id: null, name: "App Library" }, ...scope];
    const modules = [], flows = [], errors = [];
    await pool(locations, concurrency, async (loc) => {
      try {
        for (const a of await flow.listAssets(loc.id)) {
          const row = { id: a.id, name: a.name, type: a.type, packageId: loc.id, packageName: loc.name, versionId: a.mainBranch ? a.mainBranch.headVersionId : null };
          (a.type === "module" ? modules : flows).push(row);
        }
      } catch (e) { errors.push(`${loc.name}: ${e.message}`); }
    });
    modules.sort((a, b) => a.name.localeCompare(b.name));

    let done = 0;
    const generated = new Map(); // projection -> Promise of code (one module per projection is usual, but not required)
    await pool(modules, concurrency, async (m) => {
      try {
        m.oldSource = await flow.readSource(m);
        m.projection = ifsProjectionOf(m.oldSource);
        if (m.projection) {
          if (!generated.has(m.projection)) generated.set(m.projection, generateCode(m.projection));
          m.newSource = await generated.get(m.projection);
        }
      } catch (e) { m.error = e.message; }
      progress("Generating modules from IFS", ++done, modules.length);
    });

    const moduleIds = new Set(modules.map((m) => m.id));
    const usages = new Map(); // module id -> [{ flowId, flowName, packageName, text }]
    done = 0;
    await pool(flows, concurrency + 1, async (f) => {
      try {
        const d = await flow.readDesigner(f.id);
        const refs = (d.assets || []).filter((r) => !r.usedIndirectly && moduleIds.has(r.assetId));
        if (refs.length) {
          const text = flowText(d);
          for (const r of refs) {
            if (!usages.has(r.assetId)) usages.set(r.assetId, []);
            usages.get(r.assetId).push({ flowId: f.id, flowName: f.name, flowType: f.type, packageId: f.packageId, packageName: f.packageName, text });
          }
        }
      } catch (e) { errors.push(`Flow ${f.name}: ${e.message}`); }
      progress("Reading flows", ++done, flows.length);
    });

    const results = modules.map((m) => {
      const base = { id: m.id, name: m.name, packageId: m.packageId, packageName: m.packageName, projection: m.projection || null, usedBy: (usages.get(m.id) || []).length };
      if (m.error) return { ...base, status: "error", error: m.error };
      if (!m.projection) return { ...base, status: "skipped", error: "Not generated from IFS (no #importSource header)." };
      const r = analyzeModule({ name: m.name, oldSource: m.oldSource, newSource: m.newSource, usages: usages.get(m.id) || [] });
      return { ...base, ...r, oldSource: r.status === "changed" ? m.oldSource : undefined, newSource: r.status === "same" ? undefined : m.newSource };
    });
    return { scannedAt: new Date().toISOString(), modules: results, flowCount: flows.length, errors };
  }

  const api = { runScan, SEVERITIES, stripHeader, parseDeclarations, normalize, parseFunction, parseRecordType, lineDiff, rateChange, usedDeclarations, analyzeModule, flowText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.ModuleCompare = api;
})(typeof window !== "undefined" ? window : globalThis);
