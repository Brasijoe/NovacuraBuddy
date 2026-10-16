(function (global) {
  function extractBearerToken(headers) {
    for (const h of headers || []) {
      if (String(h.name).toLowerCase() === "authorization") {
        const m = /^bearer\s+(.+)$/i.exec(h.value || "");
        if (m) return m[1];
      }
    }
    return null;
  }

  function createTokenCache(ttlMs, now) {
    const nowFn = now || Date.now;
    let token = null;
    let expiresAt = 0;
    return {
      get() {
        return token && nowFn() < expiresAt ? token : null;
      },
      set(newToken) {
        token = newToken;
        expiresAt = nowFn() + ttlMs;
      },
      clear() {
        token = null;
        expiresAt = 0;
      }
    };
  }

  const api = { extractBearerToken, createTokenCache };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.FlowToken = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
