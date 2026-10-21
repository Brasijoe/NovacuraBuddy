const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanText, oneLine, docBlock, schemaFacts, describe, enumValueDescriptions, firstExample } = require("./flow-docs.js");

test("cleanText turns HTML and markdown into plain text with absolute links", () => {
  const base = "https://api.example.com/portal/swagger-ui/spec.json";
  assert.equal(
    cleanText("### Title\n**Bold** <a href='../codelist'>Codes</a><br>see [docs](https://x.io/d) */", base),
    "Title\nBold Codes (https://api.example.com/portal/codelist)\nsee docs (https://x.io/d) * /"
  );
  assert.equal(oneLine("a\n- b\n- c"), "a; b; c");
});

test("docBlock: one short line stays on one line, longer text wraps under ' *  '", () => {
  assert.equal(docBlock(["Hello."]), "/** Hello. */");
  assert.equal(docBlock([null, ""]), null);
  const block = docBlock(["first", "x ".repeat(60).trim()]);
  assert.match(block, /^\/\*\* first\n \*  x x/);
  assert.match(block, /\n \*\/$/);
});

test("schemaFacts lists the spec's facts in a fixed order", () => {
  assert.deepEqual(
    schemaFacts({ type: "string", format: "date", enum: ["a", "b"], maxLength: 10, default: "a", example: "b", readOnly: true }, { required: true, listEnum: true }),
    ["required", "read-only, set by the API", "date (YYYY-MM-DD)", "one of a | b", "max 10 characters", 'default "a"', 'e.g. "b"']
  );
  assert.deepEqual(schemaFacts({ type: "array", items: { type: "string", enum: ["EAN", "DMC"] }, minItems: 1 }, { listEnum: true }), ["each one of EAN | DMC", "min 1 entries"]);
  assert.deepEqual(schemaFacts({ type: "integer", minimum: 1, maximum: 9, format: "custom-x" }), ["format custom-x", "1..9"]);
  assert.equal(describe(["required"], "The <i>name</i>."), "required — The name.");
  assert.equal(describe([], ""), "");
});

test("enum value descriptions come from the common vendor extensions only", () => {
  assert.deepEqual(enumValueDescriptions({ enum: ["P", "Z"], "x-enum-descriptions": ["PDF", "ZPL"] }), ["PDF", "ZPL"]);
  assert.deepEqual(enumValueDescriptions({ enum: ["P", "Z"], "x-enumDescriptions": { Z: "ZPL" } }), ["", "ZPL"]);
  assert.deepEqual(enumValueDescriptions({ enum: ["P", "Z"] }), ["", ""]);
});

test("firstExample reads example, an examples array, then the first named example", () => {
  assert.deepEqual(firstExample({}, { example: 1 }), { value: 1 });
  assert.deepEqual(firstExample({ examples: [2, 3] }), { value: 2 });
  assert.deepEqual(firstExample({ examples: { simple: { value: { a: 1 } } } }), { value: { a: 1 } });
  assert.equal(firstExample({}), null);
});
