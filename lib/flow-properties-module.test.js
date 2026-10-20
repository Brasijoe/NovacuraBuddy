const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const M = require("./flow-properties-module.js");

// Flow's code generator output for CustomProjectionShopRepairPickingLocat (user capture 2026-10-20,
// a few write functions left out).
const GENERATED = fs.readFileSync(path.join(__dirname, "fixtures", "codegen-shop-repair-picking-locat.flowscript"), "utf8");
const names = (code) => M.splitDeclarations(code).map((c) => c.name).filter(Boolean);

test("extractReadSet keeps the shared prelude and only what the readable Set needs", () => {
  const { prelude, code } = M.extractReadSet(GENERATED, "ShopRepairPickingLocatSet");
  assert.deepEqual(names(code), ["ShopRepairPickingLocat", "getShopRepairPickingLocatSetRows", "ShopRepairPickingLocatSet"]);
  assert.match(code, /Cf_Locationno: text\? = null,/);
  assert.match(code, /^let ShopRepairPickingLocatSet = Queryable\.Create<ODataQueryTranslation, ShopRepairPickingLocat, text>/m);
  assert.doesNotMatch(code, /Reference_|_Create|_Delete|ByKey|ConfigEntityDec|_Keys/);

  assert.match(prelude, /^let basePath = 'b2b\/ifsapplications\/projection\/v1';\n\nopen Seq;/);
  for (const shared of ["ODataQueryTranslation", "IFSError", "Header", "getTranslation", "buildQueryString", "renamerFunction", "GetResponse", "HandleHTTPResponse", "GetTypeMismatchErrorMessage"]) {
    assert.ok(names(prelude).includes(shared), shared);
  }
  assert.doesNotMatch(prelude, /#importSource|ShopRepairPickingLocat/);
});

test("comment lines stay with the declaration below them", () => {
  const chunks = M.splitDeclarations("type A = {}\n\n// about b\nfunction b() => 1\n/** doc */\nlet c = 2");
  assert.deepEqual(chunks.map((c) => [c.name, c.text]), [["A", "type A = {}"], ["b", "// about b\nfunction b() => 1"], ["c", "/** doc */\nlet c = 2"]]);
});

test("extractReadSet fails plainly when the generator output looks different", () => {
  assert.throws(() => M.extractReadSet("let x = 1", "XSet"), /no GetTypeMismatchErrorMessage/);
  assert.throws(() => M.extractReadSet(GENERATED, "OtherSet"), /^Error: The generated module has no OtherSet\.$/);
});

const block = (lu, extra = "") => ({ lu, code: `${extra}type ${lu}Row = { Objkey: text }\n\nlet ${lu}Set = 1` });

test("mergeModule builds a new module with one marked block per LU", () => {
  const { source, included, conflicts, lus } = M.mergeModule({ existingSource: null, prelude: "let basePath = 'x';", blocks: [block("A"), block("B")], stamp: "2026-10-20 22:00" });
  assert.deepEqual([included, conflicts, lus], [["A", "B"], [], ["A", "B"]]);
  assert.ok(M.isOurs(source));
  assert.match(source, /\*\/\nlet basePath = 'x';\n\n\/\/ >>> FlowProperties: A\ntype ARow/);
  assert.deepEqual(M.parseBlocks(source).map((b) => b.lu), ["A", "B"]);
});

test("mergeModule keeps earlier LUs, replaces re-imported ones in place, appends new ones", () => {
  const first = M.mergeModule({ existingSource: null, prelude: "let basePath = 'old';", blocks: [block("A"), block("B")], stamp: "1" }).source;
  const changedB = { lu: "B", code: "let BSet = 2" };
  const { source, lus } = M.mergeModule({ existingSource: first.replace(/\n/g, "\r\n"), prelude: "let basePath = 'new';", blocks: [changedB, block("C")], stamp: "2" });
  assert.deepEqual(lus, ["A", "B", "C"]);
  assert.equal(M.parseBlocks(source).find((b) => b.lu === "B").code, "let BSet = 2");
  assert.match(source, /basePath = 'new'/);
  assert.doesNotMatch(source, /basePath = 'old'/);
});

test("a declaration shared with another LU is kept once; a different one with the same name rejects that LU", () => {
  const shared = "type Common = { a: text }\n\n";
  const first = M.mergeModule({ existingSource: null, prelude: "", blocks: [block("A", shared)], stamp: "1" }).source;
  const same = M.mergeModule({ existingSource: first, prelude: "", blocks: [block("B", shared)], stamp: "2" });
  assert.deepEqual(same.included, ["B"]);
  assert.equal(same.source.match(/type Common/g).length, 1);

  const other = M.mergeModule({ existingSource: first, prelude: "", blocks: [block("C", "type Common = { b: number }\n\n")], stamp: "3" });
  assert.deepEqual(other.included, []);
  assert.deepEqual(other.conflicts, [{ lu: "C", message: "Common is already declared differently by another LU in FlowProperties." }]);
});

test("a FlowProperties module someone else wrote is never overwritten", () => {
  assert.throws(() => M.mergeModule({ existingSource: "let mine = 1", prelude: "", blocks: [block("A")], stamp: "1" }),
    /^Error: A FlowProperties module exists but was not made by NovacuraBuddy/);
});

test("updateFlowPropertiesModule commits once with the LUs that generated; failures are reported", async () => {
  const commits = [];
  const result = await M.updateFlowPropertiesModule({
    luNames: ["ShopRepairPickingLocation", "Broken"],
    generate: async (lu) => {
      if (lu === "Broken") throw new Error("No Main, Integration, or ExternalB2B service URL found for projection 'CustomProjectionBroken'.");
      return { code: GENERATED, setName: "ShopRepairPickingLocatSet" };
    },
    readExisting: async () => null,
    commit: async (source, asset) => { commits.push({ source, asset }); return { id: "m1" }; },
    now: () => "2026-10-20 22:00"
  });
  assert.deepEqual(result.included, ["ShopRepairPickingLocation"]);
  assert.deepEqual(result.failed.map((f) => f.lu), ["Broken"]);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].asset, null);
  assert.deepEqual(M.parseBlocks(commits[0].source).map((b) => b.lu), ["ShopRepairPickingLocation"]);
});

test("updateFlowPropertiesModule commits nothing when no LU could be generated", async () => {
  let committed = false;
  const result = await M.updateFlowPropertiesModule({
    luNames: ["A"], generate: async () => { throw new Error("nope"); },
    readExisting: async () => { throw new Error("must not be read"); }, commit: async () => { committed = true; }, now: () => ""
  });
  assert.deepEqual(result, { included: [], failed: [{ lu: "A", message: "nope" }], lus: [] });
  assert.equal(committed, false);
});

test("assertOurs accepts empty or NovacuraBuddy modules and refuses foreign ones", () => {
  assert.doesNotThrow(() => M.assertOurs(""));
  assert.doesNotThrow(() => M.assertOurs(null));
  assert.doesNotThrow(() => M.assertOurs(M.mergeModule({ existingSource: null, prelude: "", blocks: [block("A")], stamp: "1" }).source));
  assert.throws(() => M.assertOurs("let mine = 1"), /not made by NovacuraBuddy/);
});
