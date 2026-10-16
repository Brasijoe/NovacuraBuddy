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

  const EXPIRY_SAFETY_MS = 60 * 1000;

  /** The token's own expiry (JWT `exp`, minus a minute of safety), or null if it isn't a
   *  readable JWT. */
  function jwtExpiresAt(token) {
    try {
      const payload = String(token).split(".")[1];
      const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
      const { exp } = JSON.parse(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)));
      return typeof exp === "number" ? exp * 1000 - EXPIRY_SAFETY_MS : null;
    } catch {
      return null;
    }
  }

  /** Caches the sniffed Connect token until its real JWT expiry; `fallbackTtlMs` applies only to
   *  a token whose expiry can't be read. */
  function createTokenCache(fallbackTtlMs, now) {
    const nowFn = now || Date.now;
    let token = null;
    let expiresAt = 0;
    return {
      get() {
        return token && nowFn() < expiresAt ? token : null;
      },
      set(newToken) {
        token = newToken;
        expiresAt = jwtExpiresAt(newToken) || nowFn() + fallbackTtlMs;
      },
      expiresAt() {
        return expiresAt;
      },
      clear() {
        token = null;
        expiresAt = 0;
      }
    };
  }

  const api = { extractBearerToken, createTokenCache, jwtExpiresAt };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.FlowToken = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
