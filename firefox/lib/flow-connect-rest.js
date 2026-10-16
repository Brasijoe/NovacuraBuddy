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
    throw new Error(`${message} (${res.status})${text ? ": " + text : ""}`);
  }

  const api = { FLOW_CONNECT_BASE_URL, X_ORIGIN, flowFetch, throwWithResponseBody };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.FlowConnectRest = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
