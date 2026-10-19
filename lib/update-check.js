(function (global) {
  const RELEASES_URL = "https://api.github.com/repos/Brasijoe/NovacuraBuddy/releases/latest";

  const parts = (v) => String(v).trim().replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);

  function compareVersions(a, b) {
    const pa = parts(a);
    const pb = parts(b);
    for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  }

  /** Latest GitHub Release vs the installed version. Never throws: a failed check just means
   *  "no banner". `currentVersion` is echoed so a stored result can be recognised as stale once
   *  the user has installed the update. */
  async function checkForUpdate(currentVersion, fetchImpl) {
    const doFetch = fetchImpl || ((...args) => fetch(...args));
    try {
      const res = await doFetch(RELEASES_URL, { headers: { Accept: "application/vnd.github+json" } });
      if (!res.ok) return { available: false, currentVersion, reason: `HTTP ${res.status}` };
      const rel = await res.json();
      const version = String(rel.tag_name || "").replace(/^v/i, "");
      if (!version || compareVersions(version, currentVersion) <= 0) return { available: false, currentVersion };
      const asset = (rel.assets || []).find((a) => a.name === `NovacuraBuddy-v${version}.zip`);
      return { available: true, currentVersion, version, zipUrl: asset ? asset.browser_download_url : null, htmlUrl: rel.html_url };
    } catch (e) {
      return { available: false, currentVersion, reason: e.message };
    }
  }

  const api = { RELEASES_URL, compareVersions, checkForUpdate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.UpdateCheck = api;
})(typeof window !== "undefined" ? window : globalThis);
