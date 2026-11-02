import { describeFetchFailure } from "../net/fetchErrors.js";
function resolveIfsUrl(ifsBaseUrl, urlOrPath) {
  return urlOrPath.startsWith("http") ? urlOrPath : ifsBaseUrl + urlOrPath;
}
function dirnameOfPath(path) {
  const parts = String(path || "").split("/");
  return parts.slice(0, -1).join("/");
}
async function ifsFetch(ifsBaseUrl, path, token) {
  const url = ifsBaseUrl + path;
  try {
    return await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    throw describeFetchFailure(err, url);
  }
}
async function fetchIfsText(url, token) {
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    throw describeFetchFailure(err, url);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Fetch failed for ${url} (${res.status})${text ? ": " + text : ""}`);
  }
  return res.text();
}
function parseCategoryList(categoriesText) {
  return String(categoriesText || "").split(",").map((c) => c.trim()).filter(Boolean);
}
async function queryProjectionMeta(ifsBaseUrl, token, projectionName) {
  const lower = projectionName.toLowerCase().replace(/'/g, "");
  const path = `/main/ifsapplications/projection/v1/ProjectionExplorer.svc/ProjExplorerQuerySet?$filter=startswith(tolower(ProjectionName),'${lower}')&$select=ProjectionName,Component,ApiClass,Active,Deprecated,Categories`;
  const res = await ifsFetch(ifsBaseUrl, path, token);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ProjectionExplorer query failed (${res.status})${text ? ": " + text : ""}`);
  }
  const data = await res.json();
  const rows = data.value || [];
  return rows.find((p) => p.ProjectionName.toUpperCase() === projectionName.toUpperCase()) || null;
}
async function callProjectionExplorerFunction(ifsBaseUrl, token, functionName, projectionName) {
  const clean = projectionName.replace(/'/g, "");
  const res = await ifsFetch(
    ifsBaseUrl,
    `/main/ifsapplications/projection/v1/ProjectionExplorer.svc/${functionName}(ProjectionName='${clean}')`,
    token
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${functionName} failed (${res.status})${text ? ": " + text : ""}`);
  }
  const data = await res.json();
  return data.value || null;
}
async function resolveCategorizedProjectionUrl(ifsBaseUrl, token, projectionName, categoriesText, functionPrefix) {
  const categories = parseCategoryList(categoriesText);
  const isIntegration = categories.includes("Integration");
  const isExternalB2B = categories.includes("ExternalB2B");
  const call = (suffix) => callProjectionExplorerFunction(ifsBaseUrl, token, `${functionPrefix}${suffix}`, projectionName);
  if (isIntegration && !isExternalB2B) return call("Int");
  if (isExternalB2B && !isIntegration) return call("B2b");
  const mainUrl = await call("Main");
  if (mainUrl) return mainUrl;
  if (isIntegration) return call("Int");
  if (isExternalB2B) return call("B2b");
  return null;
}
async function getServiceUrl(ifsBaseUrl, token, projectionName, categoriesText) {
  return resolveCategorizedProjectionUrl(ifsBaseUrl, token, projectionName, categoriesText, "GetServiceUrl");
}
async function getOpenApiUrl(ifsBaseUrl, token, projectionName, categoriesText) {
  return resolveCategorizedProjectionUrl(ifsBaseUrl, token, projectionName, categoriesText, "GetOpenApiV3Url");
}
async function fetchProjectionCodegenInputs(ifsBaseUrl, token, projectionName) {
  const meta = await queryProjectionMeta(ifsBaseUrl, token, projectionName);
  const serviceUrl = await getServiceUrl(ifsBaseUrl, token, projectionName, meta && meta.Categories);
  if (!serviceUrl) {
    throw new Error(`No Main, Integration, or ExternalB2B service URL found for projection '${projectionName}'.`);
  }
  const csdl = await fetchIfsText(resolveIfsUrl(ifsBaseUrl, serviceUrl) + "/$metadata", token);
  const openApiUrl = await getOpenApiUrl(ifsBaseUrl, token, projectionName, meta && meta.Categories);
  const openApiJson = openApiUrl ? await fetchIfsText(resolveIfsUrl(ifsBaseUrl, openApiUrl), token) : "";
  const projectionSubPath = serviceUrl.startsWith("http") ? new URL(serviceUrl).pathname : serviceUrl;
  const codeGenSubPath = dirnameOfPath(projectionSubPath);
  return { csdl, openApiJson, projectionSubPath, codeGenSubPath };
}
async function generateModuleCode(rest, csdlXml, openApiJson, codeGenSubPath, importSourcePath, comment) {
  const res = await rest.post("/admin/code-gen/api/v1/flowscript/generate/Queryable", {
    csdlXml,
    openApiJson,
    projectionSubPath: codeGenSubPath
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401) {
      throw new Error(
        `Flow Connect rejected this request as unauthorized (401) generating module code for "${importSourcePath}". Your Flow Connect sign-in (or manual token) is missing or has expired -- sign in to Flow Connect again and retry.`
      );
    }
    throw new Error(`Code generation failed (${res.status})${text ? ": " + text : ""}`);
  }
  const generatedCode = await res.text();
  const buildRes = await rest.get("/admin/code-gen/build-number");
  const buildNo = buildRes.ok ? await buildRes.text() : "unknown";
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 19).replace("T", " ");
  let header = `/*\r
#importSource("${importSourcePath}")\r
Auto generated code: ${timestamp} (build ${buildNo})\r
`;
  if (comment) header += comment + "\r\n";
  header += "*/\r\n";
  return header + generatedCode;
}
async function generateModuleSource(ifsBaseUrl, ifsToken, rest, moduleName, serviceUrl) {
  const { csdl, openApiJson, codeGenSubPath } = await fetchProjectionCodegenInputs(ifsBaseUrl, ifsToken, moduleName);
  return generateModuleCode(rest, csdl, openApiJson, codeGenSubPath, serviceUrl, void 0);
}
export {
  dirnameOfPath,
  fetchIfsText,
  fetchProjectionCodegenInputs,
  generateModuleCode,
  generateModuleSource,
  getOpenApiUrl,
  getServiceUrl,
  ifsFetch,
  parseCategoryList,
  queryProjectionMeta,
  resolveCategorizedProjectionUrl,
  resolveIfsUrl
};
