(function (global) {
  // PL/SQL Developer test script (.tst) from the code of a Flow "Database" step. Flow binds
  // (":MyVar", ":shopOrder1__partNo") stay in the code exactly as written; they become the test
  // window's variables, pre-filled with the test values. Pure text work: nothing is sent anywhere.

  const HEADER = "PL/SQL Developer Test script 3.0";
  const TYPE_STRING = 5; // PL/SQL Developer variable type "String"; numbers and dates convert implicitly

  /** The code with comments and string literals blanked out (same length), so binds are only found in real code. */
  function codeOnly(sql) {
    return String(sql).replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'/g, (m) => m.replace(/[^\n]/g, " "));
  }

  /** Bind names used in the code, in order of first use, without duplicates (":=" is no bind). */
  function extractBinds(sql) {
    const seen = new Map();
    for (const m of codeOnly(sql).matchAll(/(^|[^:\w$#]):([A-Za-z_][\w$#]*)/g)) {
      const key = m[2].toLowerCase();
      if (!seen.has(key)) seen.set(key, m[2]);
    }
    return [...seen.values()];
  }

  /** The .tst text. values: { bindName: value } (case-insensitive names); a missing value stays empty (NULL). */
  function buildTst(sql, values) {
    const lookup = new Map(Object.entries(values || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const code = String(sql).replace(/\r\n?/g, "\n").replace(/\s+$/, "").split("\n");
    const binds = extractBinds(sql);
    const lines = [HEADER, String(code.length), ...code, String(binds.length)];
    for (const name of binds) {
      const v = lookup.get(name.toLowerCase());
      lines.push(name, String(TYPE_STRING), v === undefined || v === null ? "" : String(v).replace(/\r?\n/g, " "));
    }
    lines.push("0");
    return lines.join("\r\n") + "\r\n";
  }

  /** A value as the Designer's test panel writes it, as PL/SQL: "text" -> 'text', 12 -> 12, null -> NULL,
   *  true/false -> 1/0, Date("2020-01-31T10:00:00...") -> TO_DATE(...). Unknown text is quoted as a string. */
  function toLiteral(raw) {
    const t = raw === undefined || raw === null ? "null" : String(raw).trim();
    if (t === "null" || t === "") return "NULL";
    let m = /^"([\s\S]*)"$/.exec(t);
    if (m) return `'${m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(/'/g, "''")}'`;
    if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return t;
    if (t === "true") return "1";
    if (t === "false") return "0";
    m = /^Date\("(\d{4}-\d\d-\d\d)(?:T(\d\d:\d\d:\d\d))?[^"]*"\)$/.exec(t);
    if (m) return `TO_DATE('${m[1]} ${m[2] || "00:00:00"}', 'YYYY-MM-DD HH24:MI:SS')`;
    return `'${t.replace(/'/g, "''")}'`;
  }

  /** The code with every bind replaced by its value as a PL/SQL literal (rawValues: { bind: test-panel text }).
   *  Binds in comments and strings stay as they are; a bind without a value becomes NULL. */
  function inlineBinds(sql, rawValues) {
    const lookup = new Map(Object.entries(rawValues || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const text = String(sql), masked = codeOnly(text);
    let out = "", last = 0;
    for (const m of masked.matchAll(/(^|[^:\w$#]):([A-Za-z_][\w$#]*)/g)) {
      const start = m.index + m[1].length;
      out += text.slice(last, start) + toLiteral(lookup.get(m[2].toLowerCase()));
      last = start + 1 + m[2].length;
    }
    return out + text.slice(last);
  }

  const fileName = (stepLabel) => (String(stepLabel || "").replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "") || "step") + ".tst";

  const api = { extractBinds, buildTst, fileName, codeOnly, toLiteral, inlineBinds };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.PlsqlTestScript = api;
})(typeof window !== "undefined" ? window : globalThis);
