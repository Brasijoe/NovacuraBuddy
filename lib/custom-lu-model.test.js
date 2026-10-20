const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("./custom-lu-model.js");

test("toProperCase matches what IFS ToProperCase returned in the captures", () => {
  assert.equal(M.toProperCase("CUSTOMATTRNAME"), "Customattrname");
  assert.equal(M.toProperCase("VDSF311DCXYVC"), "Vdsf311dcxyvc");
  assert.equal(M.toProperCase(""), "");
});

test("normalizeLu trims, upper-cases attribute names, defaults prompts and String length", () => {
  assert.deepEqual(M.normalizeLu({
    name: "  Demo ", prompt: "",
    attributes: [
      { name: " note ", prompt: "", type: "string" },
      { name: "qty", prompt: "Quantity", type: "NUMBER", length: 50 },
      { name: "due", type: "DATETIME" },
      { name: "big", type: "STRING", length: "4000" }
    ]
  }), {
    name: "Demo", prompt: "Demo",
    attributes: [
      { name: "NOTE", prompt: "Note", type: "STRING", length: 100 },
      { name: "QTY", prompt: "Quantity", type: "NUMBER" },
      { name: "DUE", prompt: "Due", type: "DATETIME" },
      { name: "BIG", prompt: "Big", type: "STRING", length: 4000 }
    ]
  });
});

test("validateLu accepts a clean LU", () => {
  assert.deepEqual(M.validateLu(M.normalizeLu({ name: "CustomPageName", attributes: [{ name: "A1", type: "DATE" }] })), []);
});

test("validateLu caps the LU name at IFS's 30-character entity ID limit", () => {
  const messages = (name) => M.validateLu(M.normalizeLu({ name, attributes: [{ name: "A", type: "STRING" }] })).map((p) => p.message);
  assert.deepEqual(messages("L".repeat(30)), []);
  assert.deepEqual(messages("L".repeat(31)), ["LU name: at most 30 characters (has 31)."]);
  assert.deepEqual(messages(`  ${"L".repeat(30)}  `), [], "surrounding spaces are trimmed before counting");
});

test("validateLu flags names that would break OData keys or PROJECTION_NAME", () => {
  const messages = (lu) => M.validateLu(M.normalizeLu(lu)).map((p) => p.message);
  assert.deepEqual(messages({ name: "", attributes: [{ name: "A", type: "STRING" }] }), ["LU name can't be empty."]);
  for (const bad of ["My LU", "O'Brien", "Müller", "1Lu", "Lu^X"]) {
    assert.deepEqual(messages({ name: bad, attributes: [{ name: "A", type: "STRING" }] }), ["LU name: letters, digits and _ only, starting with a letter."], bad);
  }
  assert.deepEqual(messages({ name: "Lu", attributes: [{ name: "1231", type: "STRING" }] }), ["1231: First letter should be an uppercase alpha character."]);
  assert.deepEqual(messages({ name: "Lu", attributes: [{ name: "API ENDPOINT", type: "STRING" }] }), ["API ENDPOINT: letters, digits and _ only."]);
  assert.deepEqual(messages({ name: "Lu", attributes: [{ name: "ÄRGER", type: "STRING" }] }), ["ÄRGER: First letter should be an uppercase alpha character."]);
  assert.deepEqual(messages({ name: "Lu", attributes: [{ name: "", type: "STRING" }] }), ["Row 1: Attribute name can't be empty."]);
});

test("validateLu flags empty attribute list, duplicates, bad type and bad length", () => {
  const problems = (lu) => M.validateLu(M.normalizeLu(lu));
  assert.deepEqual(problems({ name: "Lu", attributes: [] }).map((p) => p.message), ["Add at least one attribute."]);
  assert.deepEqual(problems({ name: "Lu", attributes: [{ name: "A", type: "STRING" }, { name: "a", type: "NUMBER" }] }).map((p) => [p.index, p.message]), [[1, "A: used twice."]]);
  assert.deepEqual(problems({ name: "Lu", attributes: [{ name: "A", type: "BLOB" }] }).map((p) => p.field), ["type"]);
  for (const length of [0, 4001, 2.5, "abc"]) {
    assert.deepEqual(problems({ name: "Lu", attributes: [{ name: "A", type: "STRING", length }] }).map((p) => p.message), ["A: length must be a whole number from 1 to 4000."], String(length));
  }
});

test("diffAttributes creates only missing attributes and warns on type/length differences", () => {
  const desired = M.normalizeLu({ name: "Lu", attributes: [
    { name: "NOTE", type: "STRING", length: 100 },
    { name: "QTY", type: "STRING" },
    { name: "DUE", type: "DATETIME" },
    { name: "LONG", type: "STRING", length: 200 },
    { name: "NEW1", type: "NUMBER" }
  ] }).attributes;
  const rows = [
    { AttributeName: "NOTE", DataType: "STRING", DataLength: "100", Published: true },
    { AttributeName: "QTY", DataType: "NUMBER", DataLength: null, Published: true },
    { AttributeName: "DUE", DataType: "DATE", DataLength: null, Published: true },
    { AttributeName: "LONG", DataType: "STRING", DataLength: "4000", Published: false },
    { AttributeName: "OTHER", DataType: "STRING", DataLength: "10", Published: false }
  ];
  const diff = M.diffAttributes(desired, rows);
  assert.deepEqual(diff.toCreate.map((a) => a.name), ["NEW1"]);
  assert.deepEqual(diff.skipped, ["NOTE", "QTY", "DUE", "LONG"]);
  assert.deepEqual(diff.mismatches, [
    { name: "QTY", message: "QTY exists as NUMBER, not String — left unchanged." },
    { name: "LONG", message: "LONG exists with length 4000, not 200 — left unchanged." }
  ]);
  assert.deepEqual(diff.unapproved, ["LONG", "OTHER"]);
});
