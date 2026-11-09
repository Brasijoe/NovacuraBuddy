const test = require("node:test");
const assert = require("node:assert");
const CL = require("./connector-labels.js");

const conn = (id, name, type = "Database.IFS10") => ({ id, name, type });
const data = [
  { type: "step-created", id: "s1", stepType: "database", label: "Read", configuration: { type: "database-command", connector: conn("c1", "IFS 10 LK") } },
  { type: "step-created", id: "s2", stepType: "script", label: "Script", configuration: { type: "script-step-configuration", script: "x" } },
  { type: "step-created", id: "s3", stepType: "rest", label: "Call", configuration: { rest: { connector: conn("c2", "MS Graph API", "Http.Rest") } } },
  { type: "step-created", id: "s4", stepType: "database", label: "Gone", configuration: { connector: conn("c1", "IFS 10 LK") } },
  { type: "step-deleted", id: "s4" },
  { type: "arrow-created", id: "a1", configuration: { connector: conn("c3", "Nope") } }
];

test("only steps that use a connector are listed, deleted steps and arrows are not", () => {
  const out = CL.stepConnectors({ data });
  assert.deepStrictEqual(out.map((s) => s.id), ["s1", "s3"]);
  assert.strictEqual(out[0].connectors[0].name, "IFS 10 LK");
  assert.strictEqual(out[1].connectors[0].name, "MS Graph API");
});

test("the same connector always gets the same colour", () => {
  const a = CL.stepConnectors({ data }), b = CL.stepConnectors({ data });
  assert.strictEqual(a[0].connectors[0].color, b[0].connectors[0].color);
  assert.ok(CL.PALETTE.includes(a[0].connectors[0].color));
  assert.strictEqual(CL.connectorColor({ name: "ifs 10 lk" }), CL.connectorColor({ name: "IFS 10 LK" }));
});

test("empty or missing designer data gives no steps", () => {
  assert.deepStrictEqual(CL.stepConnectors(null), []);
  assert.deepStrictEqual(CL.stepConnectors({ data: [] }), []);
});
