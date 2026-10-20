const test = require("node:test");
const assert = require("node:assert/strict");
const {
  queryProjectionMeta, searchProjections, parseCategoryList, resolveCategorizedProjectionUrl,
  getServiceUrl, getOpenApiUrl, fetchProjectionCodegenInputs, dirnameOfPath
} = require("./projection-search.js");

function jsonResponse(body) {
  return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
}

test("queryProjectionMeta queries with tolower + lowercased term and matches case-insensitively", async () => {
  let requestedUrl = null;
  const fakeFetch = async (url) => {
    requestedUrl = url;
    return jsonResponse({ value: [{ ProjectionName: "SalesQuotationHandling", Categories: "" }] });
  };
  const meta = await queryProjectionMeta("https://ifs.example.com", "tok", "SalesQuotationHandling", fakeFetch);
  assert.ok(requestedUrl.includes("startswith(tolower(ProjectionName),'salesquotationhandling')"));
  assert.equal(meta.ProjectionName, "SalesQuotationHandling");
});

test("searchProjections strips a trailing slash from baseUrl so the request never doubles up", async () => {
  let requestedUrl = null;
  const fakeFetch = async (url) => {
    requestedUrl = url;
    return jsonResponse({ value: [] });
  };
  await searchProjections("https://ifs.example.com/", "tok", "X", fakeFetch);
  assert.ok(requestedUrl.startsWith("https://ifs.example.com/main/"), requestedUrl);
  assert.ok(!requestedUrl.includes("//main/"), requestedUrl);
});

test("searchProjections returns every row matching the prefix, not just an exact match", async () => {
  let requestedUrl = null;
  const fakeFetch = async (url) => {
    requestedUrl = url;
    return jsonResponse({ value: [
      { ProjectionName: "SalesQuotation", Categories: "" },
      { ProjectionName: "SalesQuotationHandling", Categories: "" },
      { ProjectionName: "SalesQuotationLine", Categories: "" }
    ] });
  };
  const rows = await searchProjections("https://ifs.example.com", "tok", "SalesQuot", fakeFetch);
  assert.ok(requestedUrl.includes("startswith(tolower(ProjectionName),'salesquot')"));
  assert.deepEqual(rows.map((r) => r.ProjectionName), ["SalesQuotation", "SalesQuotationHandling", "SalesQuotationLine"]);
});

test("searchProjections returns an empty array when nothing matches, not null", async () => {
  const fakeFetch = async () => jsonResponse({ value: [] });
  assert.deepEqual(await searchProjections("https://ifs.example.com", "tok", "Nope", fakeFetch), []);
});

test("dirnameOfPath strips the trailing .svc filename segment", () => {
  assert.equal(dirnameOfPath("/main/ifsapplications/projection/v1/SalesQuotationHandling.svc"), "/main/ifsapplications/projection/v1");
});

test("resolveCategorizedProjectionUrl calls the Int function for an Integration-only projection", async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return jsonResponse({ value: "/int/some/url" });
  };
  const url = await resolveCategorizedProjectionUrl("https://ifs.example.com", "tok", "CustomerOrderAddressEntity", "Integration", "GetServiceUrl", fakeFetch);
  assert.equal(url, "/int/some/url");
  assert.ok(calls[0].includes("GetServiceUrlInt("));
});

test("resolveCategorizedProjectionUrl tries Main first for an uncategorized projection", async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return jsonResponse({ value: "/main/some/url" });
  };
  const url = await resolveCategorizedProjectionUrl("https://ifs.example.com", "tok", "SalesQuotationHandling", "", "GetServiceUrl", fakeFetch);
  assert.equal(url, "/main/some/url");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("GetServiceUrlMain("));
});

test("resolveCategorizedProjectionUrl falls back to Int only when Main returns empty for a dual-category projection", async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    if (url.includes("Main")) return jsonResponse({ value: null });
    return jsonResponse({ value: "/int/fallback" });
  };
  const url = await resolveCategorizedProjectionUrl("https://ifs.example.com", "tok", "X", "Integration,ExternalB2B", "GetServiceUrl", fakeFetch);
  assert.equal(url, "/int/fallback");
  assert.equal(calls.length, 2);
});

test("fetchProjectionCodegenInputs assembles csdl + openApiJson + sub-paths", async () => {
  const fakeFetch = async (url) => {
    if (url.includes("ProjExplorerQuerySet")) return jsonResponse({ value: [{ ProjectionName: "SalesQuotationHandling", Categories: "" }] });
    if (url.includes("GetServiceUrlMain")) return jsonResponse({ value: "/main/ifsapplications/projection/v1/SalesQuotationHandling.svc" });
    if (url.includes("GetOpenApiV3UrlMain")) return jsonResponse({ value: "/main/ifsapplications/projection/v1/SalesQuotationHandling.svc/openapi.json" });
    if (url.includes("$metadata")) return { ok: true, text: async () => "<csdl/>" };
    if (url.includes("openapi.json")) return { ok: true, text: async () => "{}" };
    throw new Error("unexpected url " + url);
  };
  const result = await fetchProjectionCodegenInputs("https://ifs.example.com", "tok", "SalesQuotationHandling", fakeFetch);
  assert.equal(result.csdl, "<csdl/>");
  assert.equal(result.openApiJson, "{}");
  assert.equal(result.projectionSubPath, "/main/ifsapplications/projection/v1/SalesQuotationHandling.svc");
  assert.equal(result.codeGenSubPath, "/main/ifsapplications/projection/v1");
  assert.equal(result.projectionName, "SalesQuotationHandling");
});

test("fetchProjectionCodegenInputs returns IFS's spelling of the name, whatever case was asked for", async () => {
  const fakeFetch = async (url) => {
    if (url.includes("ProjExplorerQuerySet")) return jsonResponse({ value: [{ ProjectionName: "QuickReport397794", Categories: "" }] });
    if (url.includes("GetServiceUrlMain")) return jsonResponse({ value: "/main/ifsapplications/projection/v1/QuickReport397794.svc" });
    if (url.includes("GetOpenApiV3UrlMain")) return jsonResponse({ value: null });
    if (url.includes("$metadata")) return { ok: true, text: async () => "<csdl/>" };
    throw new Error("unexpected url " + url);
  };
  const result = await fetchProjectionCodegenInputs("https://ifs.example.com", "tok", "quickreport397794", fakeFetch);
  assert.equal(result.projectionName, "QuickReport397794");
});
