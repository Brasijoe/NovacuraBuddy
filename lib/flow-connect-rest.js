(function (global) {
  const FLOW_CONNECT_BASE_URL = "https://build.novacura.com";
  const X_ORIGIN = "HubWebApp";

  async function flowFetch(token, path, options, fetchImpl) {
    options = options || {};
    const headers = Object.assign({}, options.headers, { Authorization: `Bearer ${token}`, "X-Origin": X_ORIGIN });
    return (fetchImpl || fetch)(FLOW_CONNECT_BASE_URL + path, Object.assign({}, options, { headers }));
  }

  async function throwWithResponseBody(res, message) {
    const text = await res.text().catch(() => "");
    const err = new Error(`${message} (${res.status})${text ? ": " + text : ""}`);
    // Tagged so callers can tell a Flow Connect 401 (session token expired) from any other 401,
    // e.g. the IFS token endpoint's, which must never invalidate the Connect session token.
    err.service = "connect";
    err.status = res.status;
    throw err;
  }

  const api = { FLOW_CONNECT_BASE_URL, X_ORIGIN, flowFetch, throwWithResponseBody };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.FlowConnectRest = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
