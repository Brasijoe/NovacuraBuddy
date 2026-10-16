(function (global) {
  function resolveIfsUrl(baseUrl, urlOrPath) {
    return urlOrPath.startsWith("http") ? urlOrPath : baseUrl + urlOrPath;
  }

  function dirnameOfPath(path) {
    const parts = String(path || "").split("/");
    return parts.slice(0, -1).join("/");
  }

  async function ifsFetch(baseUrl, path, token, fetchImpl) {
    return (fetchImpl || fetch)(baseUrl + path, { headers: { Authorization: `Bearer ${token}` } });
  }

  async function fetchIfsText(url, token, fetchImpl) {
    const res = await (fetchImpl || fetch)(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Fetch failed for ${url} (${res.status})${text ? ": " + text : ""}`);
    }
    return res.text();
  }

  function parseCategoryList(categoriesText) {
    return String(categoriesText || "").split(",").map((c) => c.trim()).filter(Boolean);
  }

  /** Every ProjExplorerQuerySet row whose ProjectionName starts with `term` (case-insensitive) —
   *  what a search box needs. `queryProjectionMeta` below layers the exact-match narrowing this
   *  module's other callers (module codegen) actually need on top of this same request. */
  async function searchProjections(baseUrl, token, term, fetchImpl) {
    const lower = term.toLowerCase().replace(/'/g, "");
    const path = `/main/ifsapplications/projection/v1/ProjectionExplorer.svc/ProjExplorerQuerySet?$filter=startswith(tolower(ProjectionName),'${lower}')&$select=ProjectionName,Component,ApiClass,Active,Deprecated,Categories`;
    const res = await ifsFetch(baseUrl, path, token, fetchImpl);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ProjectionExplorer query failed (${res.status})${text ? ": " + text : ""}`);
    }
    const data = await res.json();
    return data.value || [];
  }

  async function queryProjectionMeta(baseUrl, token, projectionName, fetchImpl) {
    const rows = await searchProjections(baseUrl, token, projectionName, fetchImpl);
    return rows.find((p) => p.ProjectionName.toUpperCase() === projectionName.toUpperCase()) || null;
  }

  async function callProjectionExplorerFunction(baseUrl, token, functionName, projectionName, fetchImpl) {
    const clean = projectionName.replace(/'/g, "");
    const res = await ifsFetch(baseUrl, `/main/ifsapplications/projection/v1/ProjectionExplorer.svc/${functionName}(ProjectionName='${clean}')`, token, fetchImpl);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${functionName} failed (${res.status})${text ? ": " + text : ""}`);
    }
    const data = await res.json();
    return data.value || null;
  }

  async function resolveCategorizedProjectionUrl(baseUrl, token, projectionName, categoriesText, functionPrefix, fetchImpl) {
    const categories = parseCategoryList(categoriesText);
    const isIntegration = categories.includes("Integration");
    const isExternalB2B = categories.includes("ExternalB2B");
    const call = (suffix) => callProjectionExplorerFunction(baseUrl, token, `${functionPrefix}${suffix}`, projectionName, fetchImpl);

    if (isIntegration && !isExternalB2B) return call("Int");
    if (isExternalB2B && !isIntegration) return call("B2b");

    const mainUrl = await call("Main");
    if (mainUrl) return mainUrl;
    if (isIntegration) return call("Int");
    if (isExternalB2B) return call("B2b");
    return null;
  }

  async function getServiceUrl(baseUrl, token, projectionName, categoriesText, fetchImpl) {
    return resolveCategorizedProjectionUrl(baseUrl, token, projectionName, categoriesText, "GetServiceUrl", fetchImpl);
  }

  async function getOpenApiUrl(baseUrl, token, projectionName, categoriesText, fetchImpl) {
    return resolveCategorizedProjectionUrl(baseUrl, token, projectionName, categoriesText, "GetOpenApiV3Url", fetchImpl);
  }

  async function fetchProjectionCodegenInputs(baseUrl, token, projectionName, fetchImpl) {
    const meta = await queryProjectionMeta(baseUrl, token, projectionName, fetchImpl);
    const serviceUrl = await getServiceUrl(baseUrl, token, projectionName, meta && meta.Categories, fetchImpl);
    if (!serviceUrl) throw new Error(`No Main, Integration, or ExternalB2B service URL found for projection '${projectionName}'.`);

    const csdl = await fetchIfsText(resolveIfsUrl(baseUrl, serviceUrl) + "/$metadata", token, fetchImpl);

    const openApiUrl = await getOpenApiUrl(baseUrl, token, projectionName, meta && meta.Categories, fetchImpl);
    const openApiJson = openApiUrl ? await fetchIfsText(resolveIfsUrl(baseUrl, openApiUrl), token, fetchImpl) : "";

    const projectionSubPath = serviceUrl.startsWith("http") ? new URL(serviceUrl).pathname : serviceUrl;
    const codeGenSubPath = dirnameOfPath(projectionSubPath);

    return { csdl, openApiJson, projectionSubPath, codeGenSubPath };
  }

  const api = {
    resolveIfsUrl, dirnameOfPath, ifsFetch, fetchIfsText, parseCategoryList,
    searchProjections, queryProjectionMeta, resolveCategorizedProjectionUrl, getServiceUrl, getOpenApiUrl,
    fetchProjectionCodegenInputs
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.ProjectionSearch = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
