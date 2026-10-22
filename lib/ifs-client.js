(function (global) {
  // The one IFS REST client. Moved out of qr-deploy.js so Quick Reports and Custom LUs share it.
  // The OData helpers send what the IFS web client sends to EntityConfigHandling (captured
  // 2026-10-20): IEEE754Compatible JSON, full metadata, Prefer: wait=99999.
  const ODATA_JSON = "application/json;IEEE754Compatible=true";
  const ODATA_ACCEPT = "application/json;odata.metadata=full;IEEE754Compatible=true";

  function createIfsClient({ baseUrl, getToken, clearToken, fetchImpl }) {
    const doFetch = fetchImpl || ((...args) => fetch(...args));

    async function request(path, init, retried) {
      const token = await getToken();
      const res = await doFetch(baseUrl + path, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
      // A cached token can expire mid-session; one fresh token, never a loop.
      if (res.status === 401 && !retried) {
        clearToken();
        return request(path, init, true);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw Object.assign(new Error(`IFS request failed (${path.split("?")[0]}, ${res.status})${text ? ": " + text : ""}`), { status: res.status, body: text });
      }
      return res;
    }
    const bodyOf = async (res) => (res.status === 204 ? undefined : res.json());
    const odataHeaders = (etag) => ({ "Content-Type": ODATA_JSON, Accept: ODATA_ACCEPT, Prefer: "wait=99999", ...(etag ? { "If-Match": etag } : {}) });

    return {
      get: async (path) => (await request(path, { method: "GET" })).json(),
      getText: async (path) => (await request(path, { method: "GET" })).text(),
      post: async (path, body) =>
        bodyOf(await request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })),
      patchText: async (path, text, etag) => {
        await request(path, { method: "PATCH", headers: { "Content-Type": "application/octet-stream", "If-Match": etag }, body: text });
      },
      patchJson: async (path, body, etag) =>
        bodyOf(await request(path, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json;IEEE754Compatible=true",
            Accept: "application/json;odata.metadata=full;IEEE754Compatible=true",
            "If-Match": etag
          },
          body: JSON.stringify(body)
        })),
      getOData: async (path) => bodyOf(await request(path, { method: "GET", headers: { Accept: ODATA_ACCEPT, Prefer: "wait=99999" } })),
      postOData: async (path, body, etag) => bodyOf(await request(path, { method: "POST", headers: odataHeaders(etag), body: JSON.stringify(body) })),
      patchOData: async (path, body, etag) => bodyOf(await request(path, { method: "PATCH", headers: odataHeaders(etag), body: JSON.stringify(body) })),
      postBatch: async (path, boundary, text) =>
        (await request(path, {
          method: "POST",
          headers: { "Content-Type": `multipart/mixed;boundary=${boundary}`, Accept: "application/json, text/plain, */*", Prefer: "wait=99999" },
          body: text
        })).text()
    };
  }

  /** The message IFS put in an error body (details first — that is where the ORA- text is). */
  function ifsErrorMessage(err) {
    if (!err || !err.body) return null;
    try {
      const e = JSON.parse(err.body).error || {};
      const details = (e.details || []).map((d) => d && d.message).filter(Boolean);
      return details.length ? details.join(" ") : e.message || null;
    } catch {
      return null;
    }
  }

  /** Runs one named deploy step; a failure is re-labelled so the user sees which step broke. */
  async function step(name, fn, { preferIfsMessage } = {}) {
    try {
      return await fn();
    } catch (err) {
      if (!err.step) {
        err.step = name;
        err.message = `${name} failed — ${(preferIfsMessage && ifsErrorMessage(err)) || err.message}`;
      }
      throw err;
    }
  }

  /** A client for a Basic Data instance: its origin, its stored client-credentials token. */
  function forInstance({ instanceStore, baseUrl, masterKey, fetchImpl }) {
    return createIfsClient({
      baseUrl: new URL(String(baseUrl).trim()).origin,
      getToken: () => instanceStore.getIfsAuthToken(baseUrl, masterKey, fetchImpl),
      clearToken: () => instanceStore.clearIfsAuthToken(baseUrl),
      fetchImpl
    });
  }

  const api = { createIfsClient, step, ifsErrorMessage, forInstance };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.IfsClient = api;
})(typeof window !== "undefined" ? window : globalThis);
