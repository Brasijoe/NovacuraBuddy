/* ============================================================
   Offline heuristic: summarize a recording's POST activity into
   a short, approximate natural-language description. No network,
   no DOM — works under Node (for tests) and in the browser.
   ============================================================ */
(function (global) {
  function splitPascalCase(str) {
    return String(str || "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .trim();
  }

  function extractEntityOrAction(url) {
    let path;
    try {
      path = new URL(url).pathname;
    } catch (e) {
      path = String(url || "");
    }
    const segments = path.split("/").filter(Boolean);
    const last = segments[segments.length - 1] || "";
    const noKey = last.replace(/\(.*\)$/, "");
    const dotIdx = noKey.lastIndexOf(".");
    const raw = dotIdx !== -1 ? noKey.slice(dotIdx + 1) : noKey;
    const clean = raw.replace(/\.svc$/i, "");
    return splitPascalCase(clean || "Unknown");
  }

  function distinctProjectionNames(calls) {
    const names = [];
    const seen = new Set();
    calls.forEach((c) => {
      const m = String((c && c.url) || "").match(/([A-Za-z0-9_]+)\.svc/);
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        names.push(m[1]);
      }
    });
    return names;
  }

  function summarizePostActivity(calls) {
    calls = Array.isArray(calls) ? calls : [];
    if (calls.length === 0) return "";

    const postCalls = calls.filter((c) => c && c.method === "POST");

    if (postCalls.length === 0) {
      const projections = distinctProjectionNames(calls);
      if (projections.length === 0) return "";
      return `Recorded ${calls.length} call${calls.length === 1 ? "" : "s"} to ${projections.join(", ")}.`;
    }

    const phrases = [];
    const seen = new Set();
    postCalls.forEach((c) => {
      const phrase = extractEntityOrAction(c.url);
      const key = phrase.toLowerCase();
      if (phrase && !seen.has(key)) {
        seen.add(key);
        phrases.push(phrase);
      }
    });

    return `Creates a new ${phrases.join(", ")}.`;
  }

  const api = { splitPascalCase, extractEntityOrAction, summarizePostActivity, distinctProjectionNames };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.FlowAssetHeuristic = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
