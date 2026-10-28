const test = require("node:test");
const assert = require("node:assert/strict");
const { parseBreadcrumb, findStepCommand, versionForEnvironment, overviewVersions, resolveStepSql } = require("./flow-step-sql.js");

const designer = { data: [
  { type: "step-created", id: "1", stepType: "machine", label: "print \nbarcode", configuration: { command: { type: "database-command", commandType: "nonQuery", commandText: "begin null; end;" } } },
  { type: "step-created", id: "2", stepType: "script", label: "Other", configuration: {} }
] };

test("breadcrumb", () => {
  assert.deepEqual(parseBreadcrumb("Relocation / Check Location"), { flow: "Relocation", step: "Check Location" });
  assert.equal(parseBreadcrumb("Relocation"), null);
});

test("step command is found by name, whitespace-insensitive", () => {
  assert.equal(findStepCommand(designer, "Print barcode").sql, "begin null; end;");
  assert.equal(findStepCommand(designer, "Other"), null);
});

function fakeFetch(routes) {
  return async (path) => {
    const hit = routes[path];
    if (hit === undefined) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    return { ok: true, status: 200, json: async () => hit, text: async () => JSON.stringify(hit) };
  };
}

test("resolves from the deployed version first", async () => {
  const flowFetch = fakeFetch({
    "/admin/security/api/v3/user/whoAmI": { organizations: [{ id: "o1", name: "Org" }] },
    "/admin/application/api/v2/organisations/o1/items/app1/versions/v1/committed": designer
  });
  const r = await resolveStepSql({ flowFetch, flowName: "F", stepName: "Print barcode", versions: [{ app: "app1", version: "v1" }] });
  assert.equal(r.sql, "begin null; end;");
});

test("falls back to the flow found by name", async () => {
  const flowFetch = fakeFetch({
    "/admin/security/api/v3/user/whoAmI": { organizations: [{ id: "o1", name: "Org" }] },
    "/admin/application/api/v2/organisations/o1/packages": [{ id: "p1", name: "Pkg" }],
    "/admin/application/api/v2/organisations/o1/assets": [],
    "/admin/application/api/v2/organisations/o1/packages/p1/assets": [{ id: "f1", name: "Relocation", type: "application", mainBranch: { headVersionId: "h1" } }],
    "/admin/application/api/v2/organisations/o1/items/f1/versions/h1/committed": designer
  });
  const r = await resolveStepSql({ flowFetch, flowName: "relocation", stepName: "Print barcode", versions: [{ app: "x", version: "y" }] });
  assert.equal(r.sql, "begin null; end;");
  assert.match(r.source, /latest committed/);
});

test("reports what was tried when nothing is found", async () => {
  const flowFetch = fakeFetch({ "/admin/security/api/v3/user/whoAmI": { organizations: [{ id: "o1", name: "Org" }] } });
  const r = await resolveStepSql({ flowFetch, flowName: "F", stepName: "S", versions: [{ app: "a", version: "v" }] });
  assert.ok(r.error);
  assert.ok(r.tried.length >= 1);
});

test("the version deployed to the client's environment is preferred", async () => {
  const history = { data: [{ versionId: "v3", environments: [] }, { versionId: "v2", environments: [{ id: "e1", name: "Test", type: "test" }] }, { versionId: "v1", environments: [{ id: "e0", name: "Prod", type: "prod" }] }] };
  assert.equal(versionForEnvironment(history, "test"), "v2");
  assert.equal(versionForEnvironment(history, "Development"), null);
  const flowFetch = fakeFetch({
    "/admin/security/api/v3/user/whoAmI": { organizations: [{ id: "o1", name: "Org" }] },
    "/admin/application/api/v2/organisations/o1/packages": [{ id: "p1", name: "Pkg" }],
    "/admin/application/api/v2/organisations/o1/assets": [],
    "/admin/application/api/v2/organisations/o1/packages/p1/assets": [{ id: "f1", name: "Relocation", type: "application", mainBranch: { headVersionId: "v3" } }],
    "/admin/version/api/v2/organization/o1/item/f1/version/v3?max=30": history,
    "/admin/application/api/v2/organisations/o1/items/f1/versions/v2/committed": designer
  });
  const r = await resolveStepSql({ flowFetch, flowName: "Relocation", stepName: "Print barcode", envName: "Test" });
  assert.match(r.source, /deployed to Test/);
});

const overview = {
  products: [{ id: "f1", name: "Relocation", mainBranch: { headVersionId: "head", latestCommitted: { id: "v40" } } }],
  environments: [
    { environmentId: "e1", environmentName: "Test", environmentType: "test", deployments: [{ productId: "f1", productVersionId: "v38" }] },
    { environmentId: "e2", environmentName: "Perso", environmentType: "test", deployments: [] },
    { environmentId: "e3", environmentName: "Production", environmentType: "prod", deployments: [] }
  ]
};

test("deployment overview: latest and deployed versions", () => {
  assert.deepEqual(overviewVersions(overview, "f1", { name: "Test", type: "test" }), { latest: "v40", deployed: "v38", inEnvironment: true });
  assert.equal(overviewVersions(overview, "f1", { name: "Perso", type: "test" }).deployed, null);
  assert.equal(overviewVersions(overview, "f1", { name: "Other", type: "test" }).inEnvironment, false); // two test environments: no guess
  assert.equal(overviewVersions(overview, "f1", { name: "Development", type: "dev" }).inEnvironment, false);
  assert.equal(overviewVersions(overview, "f1", { name: "Development", type: "dev" }).latest, "v40");
});

function packageRoutes(extra) {
  return fakeFetch({
    "/admin/security/api/v3/user/whoAmI": { organizations: [{ id: "o1", name: "Org" }] },
    "/admin/application/api/v2/organisations/o1/packages": [{ id: "p1", name: "Pkg" }],
    "/admin/application/api/v2/organisations/o1/assets": [],
    "/admin/application/api/v2/organisations/o1/packages/p1/assets": [{ id: "f1", name: "Relocation", type: "application", mainBranch: { headVersionId: "head" } }],
    "/admin/application/api/v2/organisations/o1/packages/p1/deploymentoverview": overview,
    ...extra
  });
}

test("a non-development environment reads the version deployed there", async () => {
  const flowFetch = packageRoutes({ "/admin/application/api/v2/organisations/o1/items/f1/versions/v38/committed": designer });
  const r = await resolveStepSql({ flowFetch, flowName: "Relocation", stepName: "Print barcode", envName: "Test", envType: "test" });
  assert.match(r.source, /deployed to Test/);
});

test("Development reads the latest committed version", async () => {
  const flowFetch = packageRoutes({ "/admin/application/api/v2/organisations/o1/items/f1/versions/v40/committed": designer });
  const r = await resolveStepSql({ flowFetch, flowName: "Relocation", stepName: "Print barcode", envName: "Development", envType: "dev" });
  assert.match(r.source, /latest committed/);
});
