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

  const fileName = (stepLabel) => (String(stepLabel || "").replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "") || "step") + ".tst";

  const api = { extractBinds, buildTst, fileName, codeOnly };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.PlsqlTestScript = api;
})(typeof window !== "undefined" ? window : globalThis);
