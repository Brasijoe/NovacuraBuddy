const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("./permission-set-compare.js");

const set = (projections, extra = {}) => ({ exists: true, description: "Desc", projections: projections.map((p) => (typeof p === "string" ? { projection: p, level: "Full" } : p)), actions: [], ...extra });

test("compareSet splits projections into shared, only A, only B and different level", () => {
  const r = C.compareSet(set(["X", "Y", { projection: "L", level: "Full" }]), set(["Y", "Z", { projection: "L", level: "ReadOnly" }]));
  assert.deepEqual(r.projections.onlyA, ["X"]);
  assert.deepEqual(r.projections.onlyB, ["Z"]);
  assert.deepEqual(r.projections.both, ["L", "Y"]);
  assert.deepEqual(r.projections.level, [{ projection: "L", A: "Full", B: "ReadOnly" }]);
  assert.equal(r.status, "differs");
});

test("compareSet status: same, or the set exists on one side only", () => {
  assert.equal(C.compareSet(set(["X"]), set(["X"])).status, "same");
  assert.equal(C.compareSet(set(["X"]), undefined).status, "onlyA");
  assert.equal(C.compareSet(undefined, set(["X"])).status, "onlyB");
});

test("compareSet compares action grants", () => {
  const a = set(["X"], { actions: [{ projection: "X", action: "Go" }] });
  const b = set(["X"], { actions: [{ projection: "X", action: "Stop" }] });
  const r = C.compareSet(a, b);
  assert.deepEqual(r.actions.onlyA, [{ projection: "X", action: "Go" }]);
  assert.deepEqual(r.actions.onlyB, [{ projection: "X", action: "Stop" }]);
});

test("copy creates a missing set on the target and grants what the reference has", () => {
  const data = { A: { S: set(["X", "Y"], { description: "Sales" }) }, B: {} };
  assert.deepEqual(C.buildPlan(["S"], data, { mode: "copy", reference: "A" }), [
    { target: "B", type: "create", role: "S", description: "Sales" },
    { target: "B", type: "grant", role: "S", projection: "X", access: "Full" },
    { target: "B", type: "grant", role: "S", projection: "Y", access: "Full" }
  ]);
  assert.deepEqual(C.buildPlan(["S"], data, { mode: "copy", reference: "A", createMissing: false }), []);
});

test("copy with B as reference writes to A", () => {
  const data = { A: { S: set(["X"]) }, B: { S: set(["X", "Y"]) } };
  assert.deepEqual(C.buildPlan(["S"], data, { mode: "copy", reference: "B" }).map((c) => [c.target, c.type, c.projection]), [["A", "grant", "Y"]]);
});

test("merge adds missing grants on both sides, sync also removes extras only when asked", () => {
  const data = { A: { S: set(["X", "Y"]) }, B: { S: set(["Y", "Z"]) } };
  assert.deepEqual(C.buildPlan(["S"], data, { mode: "merge" }).map((c) => [c.target, c.type, c.projection]), [["B", "grant", "X"], ["A", "grant", "Z"]]);
  assert.deepEqual(C.buildPlan(["S"], data, { mode: "sync", reference: "A" }).map((c) => [c.target, c.type, c.projection]), [["B", "grant", "X"]]);
  assert.deepEqual(C.buildPlan(["S"], data, { mode: "sync", reference: "A", removeExtra: true }).map((c) => [c.target, c.type, c.projection]), [["B", "grant", "X"], ["B", "revoke", "Z"]]);
});

test("buildPlan rejects an unknown mode", () => {
  assert.throws(() => C.buildPlan([], { A: {}, B: {} }, { mode: "x" }));
});
