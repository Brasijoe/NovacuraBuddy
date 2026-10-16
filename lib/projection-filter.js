(function (global) {
  function parseExcludedList(text) {
    const set = new Set();
    for (const rawLine of String(text || "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      set.add(line.replace(/\.svc$/i, "").toUpperCase());
    }
    return set;
  }

  function extractSvcName(url) {
    const m = String(url || "").match(/([A-Za-z0-9_]+)\.svc/i);
    return m ? m[1] : null;
  }

  function isExcludedUrl(url, excludedSet) {
    if (!excludedSet || excludedSet.size === 0) return false;
    const name = extractSvcName(url);
    return !!name && excludedSet.has(name.toUpperCase());
  }

  const api = { parseExcludedList, extractSvcName, isExcludedUrl };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.ProjectionFilter = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
