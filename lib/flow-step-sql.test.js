const test = require("node:test");
const assert = require("node:assert/strict");
const { parseBreadcrumb, findStepCommand, resolveStepSql } = require("./flow-step-sql.js");

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
