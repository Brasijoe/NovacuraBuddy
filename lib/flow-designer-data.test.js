const test = require("node:test");
const assert = require("node:assert/strict");
const { materialize, lineDiff, designerSnapshot } = require("./flow-designer-data.js");

test("materialize replays created, updated and deleted events", () => {
  const items = materialize([
    { type: "step-created", id: "a", label: "A" },
    { type: "step-created", id: "b", label: "B" },
    { type: "step-updated", id: "a", label: "A2" },
    { type: "step-deleted", id: "b" },
    { type: "module-added", moduleId: "m" }
  ]);
  assert.deepEqual([...items.keys()], ["a"]);
  assert.equal(items.get("a").label, "A2");
});

test("lineDiff keeps common lines", () => {
  assert.deepEqual(lineDiff("x\ny", "x\ny\nz").map((l) => l.op), ["=", "=", "+"]);
});

test("designerSnapshot fills the defaults of a flow's designer data", () => {
  const snap = designerSnapshot({ assets: [{ assetId: "x" }], data: [{ type: "step-created", id: "a" }] });
  assert.equal(snap.architecture, "sequential");
  assert.equal(snap.parameterTypeExpression, "{}");
  assert.equal(snap.data.length, 1);
});
