import test from "node:test";
import assert from "node:assert/strict";
import { applyBundleExpansionShifts } from "./migration/classicEmitter.js";

const step = (id, x, y) => ({ type: "step-created", id, stepType: "script", location: { x, y } });

test("bundle shift cuts all rows, moves joints and annotations, keeps y and the left side", () => {
  const data = [
    step("a", 0, 0), step("s1", 300, 0), step("s2", 500, 0), step("other", 400, 300), step("right", 700, 0),
    { type: "arrow-created", id: "ar", fromStep: "s2", toStep: "right", joints: [{ x: 100, y: 0 }, { x: 600, y: 50 }] },
    { type: "annotation-created", id: "n", location: { x: 650, y: 10 } }
  ];
  const out = applyBundleExpansionShifts(data, [{ x: 300, y: 0, width: 200, stepIds: ["s1", "s2"] }]);
  const loc = (id) => out.find((e) => e.id === id).location;
  assert.deepEqual(loc("a"), { x: 0, y: 0 });
  assert.deepEqual(loc("s1"), { x: 300, y: 0 });
  assert.deepEqual(loc("s2"), { x: 500, y: 0 });
  assert.deepEqual(loc("other"), { x: 600, y: 300 });
  assert.deepEqual(loc("right"), { x: 900, y: 0 });
  assert.deepEqual(out.find((e) => e.id === "ar").joints, [{ x: 100, y: 0 }, { x: 800, y: 50 }]);
  assert.deepEqual(loc("n"), { x: 850, y: 10 });
});
