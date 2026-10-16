(function (global) {
  const ProjectionFilter = typeof require === "function" ? require("./projection-filter.js") : global.ProjectionFilter;

  function shouldTrackUrl(url, trackingEnabled, excludedSet) {
    if (!trackingEnabled) return false;
    if (!ProjectionFilter.extractSvcName(url)) return false;
    return !ProjectionFilter.isExcludedUrl(url, excludedSet);
  }

  function upsertTrackedProjection(list, projectionName, now) {
    const upper = projectionName.toUpperCase();
    const idx = list.findIndex((row) => row.projectionName.toUpperCase() === upper);
    if (idx === -1) {
      return [...list, { projectionName, firstSeenAt: now, hitCount: 1 }];
    }
    const next = list.slice();
    next[idx] = { ...next[idx], hitCount: next[idx].hitCount + 1 };
    return next;
  }

  const api = { shouldTrackUrl, upsertTrackedProjection };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.Tracking = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
