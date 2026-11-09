const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { mergeCustomCode, extractBlocks, splitChunks, shortHash } = require("./module-merge.js");

const GEN = [
  "/* header */",
  "",
  "let basePath = 'api';",
  "",
  "/** A pet. */",
  "type Pet = {",
  "\tid: number? = null,",
  "}",
  "",
  "/** Gets a pet. */",
  "function getPet(id: text): text {",
  "    return GetResponse(`/pet/{id}`);",
  "}",
  "",
  "function listPets(): text =>",
  "    GetResponse('/pets');",
  ""
].join("\n");

test("splitChunks finds declarations with their doc comments", () => {
  const { chunks } = splitChunks(GEN);
  assert.deepEqual(chunks.filter((c) => c.name).map((c) => c.name), ["basePath", "Pet", "getPet", "listPets"]);
  const pet = chunks.find((c) => c.name === "Pet");
  assert.equal(pet.lines[0], "/** A pet. */");
  assert.equal(pet.lines[pet.lines.length - 1], "}");
});

test("no markers: the generated code is returned unchanged", () => {
  const { code, report } = mergeCustomCode(GEN, GEN);
  assert.equal(code, GEN);
  assert.deepEqual(report.warnings, []);
});

test("custom-add after an anchor and at the end", () => {
  const existing = GEN + [
    "",
    "// @custom-add petTypes after:Pet",
    "type PetList = { items: Pet* }",
    "// @custom-end",
    "",
    "// @custom-add helper",
    "function helper(): text => 'x';",
    "// @custom-end"
  ].join("\n");
  const { code, report } = mergeCustomCode(GEN, existing);
  assert.deepEqual(report.kept, ["petTypes", "helper"]);
  assert.ok(code.indexOf("type PetList") > code.indexOf("type Pet = {"));
  assert.ok(code.indexOf("type PetList") < code.indexOf("function getPet"));
  assert.ok(code.indexOf("function helper") > code.indexOf("function listPets"));
  assert.deepEqual(report.warnings, []);
});

test("custom-replace takes the place of the generated declaration and records its hash", () => {
  const existing = GEN.replace("function getPet(id: text): text {\n    return GetResponse(`/pet/{id}`);\n}", "// @custom-replace getPet\nfunction getPet(id: text): Pet {\n    return unsafeCast<Pet>(JSON.deserialize<{}>(GetResponse(`/pet/{id}`)));\n}\n// @custom-end");
  const first = mergeCustomCode(GEN, existing);
  assert.deepEqual(first.report.replaced, ["getPet"]);
  assert.match(first.code, /\/\/ @custom-replace getPet orig:[0-9a-f]{8}\nfunction getPet\(id: text\): Pet/);
  assert.doesNotMatch(first.code, /function getPet\(id: text\): text/);
  assert.ok(first.code.includes("/** Gets a pet. */") === false, "the generated doc comment goes with the declaration");
  // Merging the result again changes nothing and raises no warning.
  const second = mergeCustomCode(GEN, first.code);
  assert.equal(second.code, first.code);
  assert.deepEqual(second.report.warnings, []);
});

test("a changed generated declaration warns but keeps the replacement", () => {
  const existing = "// @custom-replace getPet orig:00000000\nfunction getPet(id: text): Pet { return null; }\n// @custom-end\n";
  const { code, report } = mergeCustomCode(GEN, GEN + existing);
  assert.deepEqual(report.changed, ["getPet"]);
  assert.match(code, /function getPet\(id: text\): Pet/);
  assert.equal(report.warnings.length, 1);
});

test("orphans and missing anchors are kept at the end with a warning", () => {
  const existing = [
    "// @custom-replace gone",
    "function gone(): text => 'x';",
    "// @custom-end",
    "// @custom-add a after:AlsoGone",
    "type A = { x: text }",
    "// @custom-end"
  ].join("\n");
  const { code, report } = mergeCustomCode(GEN, existing);
  assert.deepEqual(report.orphans, ["gone"]);
  assert.equal(report.warnings.length, 2);
  assert.match(code, /Custom code ---------- \*\/[\s\S]*function gone[\s\S]*type A/);
});

test("unmarked declarations that are no longer generated are reported as lost", () => {
  const existing = GEN + "\nfunction mine(): text => 'x';\n";
  const { code, report } = mergeCustomCode(GEN, existing);
  assert.deepEqual(report.lost, ["mine"]);
  assert.equal(code, GEN);
});

test("an unclosed block is read to the end and reported", () => {
  const { blocks } = extractBlocks("// @custom-add x\ntype X = { a: text }\n");
  assert.equal(blocks[0].closed, false);
});

test("works on the generated Petstore module", () => {
  const golden = fs.readFileSync(path.join(__dirname, "..", "apimodule", "fixtures", "swagger-petstore-oas3.flowscript"), "utf8").replace(/\r\n/g, "\n");
  const existing = golden + "\n// @custom-add extra after:Pet\ntype Extra = { a: text }\n// @custom-end\n";
  const { code, report } = mergeCustomCode(golden, existing);
  assert.deepEqual(report.kept, ["extra"]);
  assert.deepEqual(report.lost, []);
  assert.ok(code.indexOf("type Extra") > code.indexOf("type Pet = {"));
  // Dropping the block again returns the generated module unchanged.
  assert.equal(mergeCustomCode(golden, golden).code, golden);
  assert.equal(shortHash("a"), shortHash("a"));
});
