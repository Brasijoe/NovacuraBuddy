(function (global) {
  /** In-memory fuzzy search over Quick Reports — same Fuse options as the Electron app's
   *  searchIndex.ts. `FuseCtor` is injected: the page passes its vendored global `Fuse`, tests
   *  pass the required module. */
  function createQrSearch(reports, FuseCtor) {
    const fuse = new FuseCtor(reports, { keys: ["name", "content"], threshold: 0.35, ignoreLocation: true });
    return {
      search(term) {
        if (!term || !term.trim()) return reports;
        return fuse.search(term).map((result) => result.item);
      }
    };
  }

  const api = { createQrSearch };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.QrSearch = api;
})(typeof window !== "undefined" ? window : globalThis);
