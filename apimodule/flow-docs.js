/* ============================================================
   Flow Docs — the comments of a generated module, for people and
   for an AI reading the module. Deterministic: every word comes
   from a fixed field of the spec (descriptions, formats, enums,
   examples, constraints, responses), never from guessing.

     /** … *\/   above a declaration (OData style)
     // …       after a field's comma, on the same line
   ============================================================ */
(function (global) {
  const MAX_DESCRIPTION = 1500; // one description in a doc block
  const MAX_FIELD = 400; // one field's trailing comment
  const MAX_EXAMPLE = 300;
  const WIDTH = 100;

  const FORMAT_HINTS = {
    date: "date (YYYY-MM-DD)",
    "date-time": "ISO 8601 date-time",
    time: "time (hh:mm:ss)",
    int32: "whole number",
    int64: "whole number",
    float: "decimal number",
    double: "decimal number",
    byte: "Base64 text",
    binary: "binary",
    email: "e-mail address",
    uri: "URL",
    url: "URL",
    uuid: "UUID",
    "iso-3166": "2-letter country code (ISO 3166)",
    "iso-639": "language code (ISO 639)",
    "iso-4217": "currency code (ISO 4217)"
  };

  /** A relative link in a description, resolved against the spec's own URL. */
  function absolute(url, baseUrl) {
    if (!baseUrl || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("#")) return url;
    try {
      return new URL(url, baseUrl).href;
    } catch (e) {
      return url;
    }
  }

  /** HTML and markdown -> plain text, paragraphs kept as "\n", relative links made absolute. */
  function cleanText(raw, baseUrl) {
    let s = String(raw == null ? "" : raw);
    s = s.replace(/<a\s[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, text) => `${text.trim()} (${absolute(href, baseUrl)})`);
    s = s.replace(/<br\s*\/?>|<\/p>|<\/li>|<hr\s*\/?>|<\/h\d>/gi, "\n").replace(/<li[^>]*>/gi, "\n- ").replace(/<[^>]+>/g, "");
    s = s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    s = s.replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, (m, text, href) => `${text} (${absolute(href, baseUrl)})`);
    s = s.replace(/\*\*|__/g, "").replace(/^\s{0,3}#{1,6}\s*/gm, "");
    s = s.replace(/\*\//g, "* /").replace(/\/\*/g, "/ *");
    return s.split(/\n/).map((l) => l.replace(/[ \t\r\f\v]+/g, " ").trim()).join("\n").replace(/\n{2,}/g, "\n").trim();
  }

  function cap(s, max) {
    return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
  }

  /** One line (for a `//` comment): newlines become spaces. */
  function oneLine(raw, baseUrl, max = MAX_FIELD) {
    return cap(cleanText(raw, baseUrl).replace(/\n- /g, "; ").replace(/\n/g, " "), max);
  }

  function wrap(text, width = WIDTH) {
    const out = [];
    for (const para of String(text).split("\n")) {
      let line = "";
      for (const word of para.split(" ").filter(Boolean)) {
        if (line && line.length + 1 + word.length > width) {
          out.push(line);
          line = word;
        } else line = line ? `${line} ${word}` : word;
      }
      out.push(line);
    }
    return out;
  }

  /** `/** … *\/` from lines (each wrapped); null when there is nothing to say. */
  function docBlock(lines, indent = "") {
    const body = lines.filter((l) => l != null && String(l).trim() !== "").flatMap((l) => wrap(l));
    if (!body.length) return null;
    if (body.length === 1 && body[0].length <= WIDTH) return `${indent}/** ${body[0]} */`;
    return [`${indent}/** ${body[0]}`, ...body.slice(1).map((l) => `${indent} *  ${l}`), `${indent} */`].join("\n");
  }

  function compactJson(value, max = MAX_EXAMPLE) {
    let text;
    try {
      text = JSON.stringify(value);
    } catch (e) {
      return null;
    }
    if (text == null) return null;
    return cap(text.replace(/\*\//g, "* /"), max);
  }

  const literal = (v) => (typeof v === "string" ? JSON.stringify(v) : compactJson(v, 80));

  /** The first example a schema/parameter/media object carries: `example`, then `examples`. */
  function firstExample(...sources) {
    for (const src of sources) {
      if (!src) continue;
      if (src.example !== undefined) return { value: src.example };
      if (Array.isArray(src.examples) && src.examples.length) return { value: src.examples[0] };
      if (src.examples && typeof src.examples === "object") {
        const first = Object.values(src.examples)[0];
        if (first && typeof first === "object" && first.value !== undefined) return { value: first.value };
      }
    }
    return null;
  }

  /** Per-value descriptions from the common vendor extensions, in enum order. */
  function enumValueDescriptions(schema) {
    const values = schema.enum || [];
    const pick = (ext) => {
      if (Array.isArray(ext)) return values.map((v, i) => (ext[i] != null ? String(ext[i]) : ""));
      if (ext && typeof ext === "object") return values.map((v) => (ext[v] != null ? String(ext[v]) : ""));
      return null;
    };
    return pick(schema["x-enum-descriptions"]) || pick(schema["x-enumDescriptions"])
      || pick(schema["x-enumNames"]) || pick(schema["x-enum-names"]) || values.map(() => "");
  }

  /** The facts of one schema as short phrases, in a fixed order. `listEnum`: write the allowed
   *  values (for values Flow only knows as text/number, not for enum-module types). */
  function schemaFacts(schema, { required = false, listEnum = false, readOnlyNote = true } = {}) {
    const s = schema || {};
    const items = s.items || {};
    const facts = [];
    if (required) facts.push("required");
    if (s.deprecated) facts.push("DEPRECATED");
    if (readOnlyNote && s.readOnly) facts.push("read-only, set by the API");
    if (s.writeOnly) facts.push("input only, never returned");
    if (s.nullable) facts.push("may be null");
    const format = s.format || (s.type === "array" && items.format);
    if (format) facts.push(FORMAT_HINTS[format] || `format ${format}`);
    const enumValues = s.enum || (s.type === "array" && items.enum);
    if (listEnum && Array.isArray(enumValues) && enumValues.length) {
      facts.push(`${s.type === "array" ? "each one of" : "one of"} ${enumValues.map((v) => (v === null ? "null" : String(v))).join(" | ")}`);
    }
    if (s.minLength != null && s.maxLength != null) facts.push(`${s.minLength}..${s.maxLength} characters`);
    else if (s.maxLength != null) facts.push(`max ${s.maxLength} characters`);
    else if (s.minLength != null) facts.push(`min ${s.minLength} characters`);
    if (s.minItems != null && s.maxItems != null) facts.push(`${s.minItems}..${s.maxItems} entries`);
    else if (s.maxItems != null) facts.push(`max ${s.maxItems} entries`);
    else if (s.minItems != null) facts.push(`min ${s.minItems} entries`);
    if (s.uniqueItems) facts.push("no duplicates");
    const range = (lo, hi, exLo, exHi) => {
      if (lo != null && hi != null) return `${lo}${exLo ? " (exclusive)" : ""}..${hi}${exHi ? " (exclusive)" : ""}`;
      if (lo != null) return `${exLo ? ">" : ">="} ${lo}`;
      if (hi != null) return `${exHi ? "<" : "<="} ${hi}`;
      return null;
    };
    const r = range(s.minimum, s.maximum, s.exclusiveMinimum === true, s.exclusiveMaximum === true);
    if (r) facts.push(r);
    if (typeof s.exclusiveMinimum === "number") facts.push(`> ${s.exclusiveMinimum}`);
    if (typeof s.exclusiveMaximum === "number") facts.push(`< ${s.exclusiveMaximum}`);
    if (s.multipleOf != null) facts.push(`multiple of ${s.multipleOf}`);
    if (s.pattern) facts.push(`pattern ${s.pattern}`);
    if (s.default !== undefined) facts.push(`default ${literal(s.default)}`);
    const ex = firstExample(s);
    if (ex) facts.push(`e.g. ${literal(ex.value)}`);
    return facts;
  }

  /** "facts — description", or "" when neither is there. */
  function describe(facts, description, baseUrl, max = MAX_FIELD) {
    const text = description ? oneLine(description, baseUrl, max) : "";
    const head = facts.join("; ");
    if (head && text) return cap(`${head} — ${text}`, max);
    return head || text;
  }

  const api = {
    FORMAT_HINTS, MAX_DESCRIPTION, absolute, cleanText, oneLine, cap, wrap, docBlock, compactJson,
    firstExample, enumValueDescriptions, schemaFacts, describe
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.ApiFlowDocs = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
