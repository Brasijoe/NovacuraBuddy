import test from "node:test";
import assert from "node:assert/strict";
import { classifyWarning, groupWarningsBySeverity, summarizeEmitted } from "./warningSeverity.js";

test("known non-blocking shapes are FYI, anything else is a blocker", () => {
  assert.equal(classifyWarning('"Flow A": Flow contains a loop (a route leads back to an earlier step)'), "fyi");
  assert.equal(classifyWarning("unrecognized Classic codePage 123"), "fyi");
  assert.equal(classifyWarning("UNRESOLVED_MIGRATION_X could not be translated"), "blocker");
});

test("grouping keeps order and splits by severity", () => {
  const g = groupWarningsBySeverity(["a", "unrecognized Classic codePage 1", "b"]);
  assert.deepEqual(g.blockers, ["a", "b"]);
  assert.equal(g.fyis.length, 1);
});

test("summarizeEmitted counts steps, arrows and modules", () => {
  const s = summarizeEmitted([{ type: "step-created", stepType: "Script" }, { type: "step-created", stepType: "Script" }, { type: "step-created", stepType: "Assign" }, { type: "arrow-created" }, { type: "module-added" }]);
  assert.equal(s.steps, 3);
  assert.equal(s.arrows, 1);
  assert.equal(s.modules, 1);
  assert.deepEqual(s.stepsByType, [["Assign", 1], ["Script", 2]]);
});
