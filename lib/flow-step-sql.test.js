const test = require("node:test");
const assert = require("node:assert/strict");
const { parseBreadcrumb, findStepCommand, designerSteps, resolveSteps } = require("./flow-step-sql.js");

const designer = { data: [
  { type: "step-created", id: "1", stepType: "machine", label: "print \nbarcode", configuration: { command: { type: "database-command", commandType: "nonQuery", commandText: "begin null; end;" } } },
  { type: "step-created", id: "2", stepType: "script", label: "Other", configuration: {} }
] };

test("breadcrumb", () => {
  assert.deepEqual(parseBreadcrumb("Relocation / Check Location"), { flow: "Relocation", step: "Check Location", path: [] });
  assert.deepEqual(parseBreadcrumb("Relocation / Sub flow / Check Location"), { flow: "Relocation", step: "Check Location", path: ["Sub flow"] });
  assert.deepEqual(parseBreadcrumb("Relocation"), { flow: "Relocation", step: null, path: [] });
  assert.equal(parseBreadcrumb(""), null);
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

const A = "/admin/application/api/v2/organisations/o1";
const split = { data: [ // label and command arrive in different events, as the Designer saves them
  { type: "step-created", id: "s1", stepType: "machine", label: "Check Location" },
  { type: "step-updated", id: "s1", configuration: { command: { commandType: "nonQuery", commandText: "begin :Loc := 1; end;" } } },
  { type: "step-created", id: "s2", label: "Gone", configuration: { command: { commandText: "x" } } },
  { type: "step-deleted", id: "s2" }
] };

test("designer steps merge the events of a step and drop deleted ones", () => {
  const steps = designerSteps(split);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].label, "Check Location");
  assert.equal(steps[0].configuration.command.commandText, "begin :Loc := 1; end;");
});

test("Development: the client runs the latest saved version, read from the flow's designer data with its assets", async () => {
  const flowFetch = fakeFetch({
    [`${A}/items/app1/designer`]: { ...split, assets: [{ assetId: "c1", assetVersion: "cv", usedIndirectly: false }] },
    [`${A}/items/c1/designer`]: designer
  });
  const r = await resolveSteps({ flowFetch, orgId: "o1", packageId: "p1", apps: [{ app: "app1", version: "head1" }], stepNames: ["Check Location", "Print barcode", "Other"] });
  assert.deepEqual(Object.keys(r.steps).sort(), ["Check Location", "Print barcode"]);
  assert.match(r.steps["Check Location"].source, /latest saved/);
  assert.ok(r.flowFound);
});

test("a committed version is read as such, its called assets at the versions it uses", async () => {
  const calls = [];
  const base = fakeFetch({
    [`${A}/items/app1/versions/v1/committed`]: { data: [] },
    [`${A}/packages/p1/products/app1`]: { id: "app1", mainBranch: { latestCommitted: { id: "v1", versionInfo: { assets: [{ assetId: "c2", assetVersion: "x", usedIndirectly: true }, { assetId: "c1", assetVersion: "cv", usedIndirectly: false }] } } } },
    [`${A}/items/c1/versions/cv/committed`]: designer,
    [`${A}/items/c2/versions/x/committed`]: split
  });
  const flowFetch = (path) => { calls.push(path); return base(path); };
  const r = await resolveSteps({ flowFetch, orgId: "o1", packageId: "p1", apps: [{ app: "app1", version: "v1" }], stepNames: ["Print barcode", "Check Location"] });
  assert.equal(r.steps["Print barcode"].sql, "begin null; end;");
  assert.equal(r.steps["Check Location"].sql, "begin :Loc := 1; end;");
  assert.ok(!calls.some((c) => /organisations\/(?!o1)/.test(c)), "only the client's org is read");
  assert.ok(calls.length <= 5);
});

test("without the client's ids nothing is fetched and the reason is given", async () => {
  let n = 0;
  const r = await resolveSteps({ flowFetch: async () => { n++; return { ok: false, status: 404 }; }, orgId: null, apps: [], stepNames: ["S"] });
  assert.equal(n, 0);
  assert.equal(r.flowFound, false);
  assert.match(r.tried[0], /not known/);
});

test("a committed version takes its called assets from its own version history record", async () => {
  const flowFetch = fakeFetch({
    [`${A}/items/app1/versions/v1/committed`]: { data: [] },
    "/admin/version/api/v2/organization/o1/item/app1/version/v1?max=1": { data: [{ versionId: "v1", assets: [{ assetId: "c1", assetVersion: "old" }] }] },
    [`${A}/items/c1/versions/old/committed`]: designer
  });
  const r = await resolveSteps({ flowFetch, orgId: "o1", packageId: "p1", apps: [{ app: "app1", version: "v1" }], stepNames: ["Print barcode"] });
  assert.equal(r.steps["Print barcode"].source, "called asset c1");
});

test("REST steps are returned with their command for the Postman copy", async () => {
  const rest = { data: [{ type: "step-created", id: "r1", label: "Get Invoice Rows", configuration: { command: { type: "rest-call", method: "post", urlExpression: "x", resultTypeExpression: "{}" } } }] };
  const flowFetch = fakeFetch({ [`${A}/items/app1/designer`]: { ...rest, assets: [] } });
  const r = await resolveSteps({ flowFetch, orgId: "o1", packageId: "p1", apps: [{ app: "app1", version: "h" }], stepNames: ["Get Invoice Rows"] });
  assert.equal(r.steps["Get Invoice Rows"].kind, "rest");
  assert.equal(r.steps["Get Invoice Rows"].command.method, "post");
  assert.equal(r.steps["Get Invoice Rows"].command.resultTypeExpression, undefined);
});
