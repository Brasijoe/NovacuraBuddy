const test = require("node:test");
const assert = require("node:assert/strict");
const FA = require("./flow-analysis.js");

const step = (id, label, extra) => ({ type: "step-created", id, label, stepType: "machine", configuration: { command: { commandText: "a\nb\nc" } }, location: { x: 1, y: 1 }, ...extra });

test("compareAssetLists finds changed, added and removed assets", () => {
  const out = FA.compareAssetLists(
    [{ assetId: "a", assetVersion: "1" }, { assetId: "b", assetVersion: "1" }, { assetId: "c", assetVersion: "1" }],
    [{ assetId: "a", assetVersion: "1" }, { assetId: "b", assetVersion: "2", usedIndirectly: true }, { assetId: "d", assetVersion: "1" }]);
  assert.deepEqual(out.map((r) => [r.assetId, r.status]), [["b", "changed"], ["c", "removed"], ["d", "added"]]);
  assert.equal(out[0].indirect, true);
});

test("diffDesigners reports field and script changes, ignoring layout", () => {
  const a = { data: [step("s1", "Create"), step("s2", "Other")] };
  const b = { data: [step("s1", "Create", { location: { x: 9, y: 9 } }), step("s2", "Other"), { type: "step-updated", id: "s1", configuration: { command: { commandText: "a\nX\nc" } } }, step("s3", "New")] };
  const d = FA.diffDesigners(a, b);
  assert.equal(d.steps.length, 2);
  const changed = d.steps.find((s) => s.status === "changed");
  assert.equal(changed.label, "Create");
  assert.equal(changed.changes.length, 1);
  assert.equal(changed.changes[0].path, "configuration.command.commandText");
  assert.ok(changed.changes[0].lines.some((l) => l.op === "+" && l.text === "X"));
  assert.equal(d.steps.find((s) => s.id === "s3").status, "added");
});

test("collapsedDiff folds unchanged stretches", () => {
  const a = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
  const b = a.replace("l15", "changed");
  const d = FA.collapsedDiff(a, b);
  assert.deepEqual(d.filter((l) => l.op === "skip").map((l) => l.count), [13, 12]);
});

test("findDeployedVersion prefers the object naming the product and environment", () => {
  const P = "11111111-1111-1111-1111-111111111111", E = "22222222-2222-2222-2222-222222222222";
  const V1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", V2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const body = [{ productId: "other", environments: [{ id: E, versionId: V1 }] }, { productId: P, environments: [{ id: E, deployedVersionId: V2 }] }];
  assert.equal(FA.findDeployedVersion(body, P, E).id, V2);
  assert.equal(FA.findDeployedVersion({ nothing: 1 }, P, E), null);
});

test("readDeployed falls through candidates and reads the version's designer", async () => {
  const P = "11111111-1111-1111-1111-111111111111", E = "22222222-2222-2222-2222-222222222222", V = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const calls = [];
  const flowFetch = async (path, o) => {
    calls.push(path);
    const json = (b) => ({ ok: true, status: 200, json: async () => b });
    if (path.endsWith("/status")) return { ok: false, status: 404 };
    if (path.includes(`/environments/${E}`)) return json({ deployedVersionId: V, productId: P });
    if (path.endsWith(`/designer/${V}`)) return json({ assets: [{ assetId: "m", assetVersion: "7" }], data: [] });
    return { ok: false, status: 404 };
  };
  const r = await FA.readDeployed({ flowFetch, orgId: "o", packageId: "p", productId: P, env: { id: E, name: "Prod" } });
  assert.equal(r.versionId, V);
  assert.deepEqual(r.assets, [{ assetId: "m", assetVersion: "7" }]);
});
