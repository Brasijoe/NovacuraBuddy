const test = require("node:test");
const assert = require("node:assert/strict");
const {
  findUnmappedSlots,
  groupUnmappedByValue,
  groupByInsertionPoint,
  earliestStepIndex,
  variableNameFor,
  uniqueVariableName,
  controlLabelFor
} = require("./flow-user-input.js");

test("findUnmappedSlots excludes slots covered by an applied candidate", () => {
  const stepContexts = [
    { label: "A", valueSlots: [{ path: "input.CustomerNo", value: "16789", literal: '"16789"', kind: "text", nullable: false }] },
    { label: "B", valueSlots: [{ path: "QuotationNo", value: "Q1", literal: '"Q1"', kind: "text", nullable: false }] }
  ];
  const applied = [{ stepIndex: 0, slotPath: "input.CustomerNo" }];
  const unmapped = findUnmappedSlots(stepContexts, applied);
  assert.equal(unmapped.length, 1);
  assert.equal(unmapped[0].slotPath, "QuotationNo");
  assert.equal(unmapped[0].stepIndex, 1);
});

test("findUnmappedSlots returns everything when nothing was applied", () => {
  const stepContexts = [{ label: "A", valueSlots: [{ path: "X", value: 1, literal: "1", kind: "number", nullable: false }] }];
  assert.equal(findUnmappedSlots(stepContexts, []).length, 1);
});

test("findUnmappedSlots carries a slot's wrapKind through per-occurrence", () => {
  const stepContexts = [{
    label: "A",
    valueSlots: [{ path: "filter.QuotationNo", value: "1100463", literal: '"1100463%"', kind: "text", nullable: false, wrapKind: "start" }]
  }];
  const unmapped = findUnmappedSlots(stepContexts, []);
  assert.equal(unmapped[0].wrapKind, "start");
});

test("findUnmappedSlots omits wrapKind entirely for slots that don't have one", () => {
  const stepContexts = [{ label: "A", valueSlots: [{ path: "X", value: 1, literal: "1", kind: "number", nullable: false }] }];
  assert.equal("wrapKind" in findUnmappedSlots(stepContexts, [])[0], false);
});

test("findUnmappedSlots excludes enum-typed slots entirely (regression)", () => {
  // Enum fields (e.g. CSystem: CHimaSys.Value) are structurally-typed records, not plain
  // strings — offering one as a text-input user step produced a real type mismatch (500,
  // no response body) confirmed live. Until there's a confirmed-safe way to build an enum
  // value, they must stay hardcoded rather than become a "user input" candidate.
  const stepContexts = [{
    label: "A",
    valueSlots: [
      { path: "input.CSystem", value: "X1", literal: '"X1"', kind: "enum", nullable: false },
      { path: "input.Note", value: "hi", literal: '"hi"', kind: "text", nullable: true }
    ]
  }];
  const unmapped = findUnmappedSlots(stepContexts, []);
  assert.equal(unmapped.length, 1);
  assert.equal(unmapped[0].slotPath, "input.Note");
});

test("groupUnmappedByValue groups the same value used in two places into one group", () => {
  const unmapped = [
    { stepIndex: 0, stepLabel: "A", slotPath: "input.CustomerNo", slotLiteral: '"16789"', value: "16789", kind: "text", nullable: false },
    { stepIndex: 2, stepLabel: "C", slotPath: "input.CustNo", slotLiteral: '"16789"', value: "16789", kind: "text", nullable: false }
  ];
  const groups = groupUnmappedByValue(unmapped);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].occurrences.length, 2);
  assert.equal(groups[0].fieldName, "CustomerNo"); // from the first occurrence
});

test("groupUnmappedByValue keeps distinct values in separate groups even with the same field name", () => {
  const unmapped = [
    { stepIndex: 0, stepLabel: "A", slotPath: "input.Note", slotLiteral: '"hi"', value: "hi", kind: "text", nullable: true },
    { stepIndex: 1, stepLabel: "B", slotPath: "input.Note", slotLiteral: '"bye"', value: "bye", kind: "text", nullable: true }
  ];
  assert.equal(groupUnmappedByValue(unmapped).length, 2);
});

test("groupUnmappedByValue distinguishes values by type, not just string form", () => {
  const unmapped = [
    { stepIndex: 0, stepLabel: "A", slotPath: "input.Flag", slotLiteral: "true", value: true, kind: "boolean", nullable: false },
    { stepIndex: 1, stepLabel: "B", slotPath: "input.Code", slotLiteral: '"true"', value: "true", kind: "text", nullable: false }
  ];
  assert.equal(groupUnmappedByValue(unmapped).length, 2);
});

test("groupUnmappedByValue sorts groups by earliest occurrence", () => {
  const unmapped = [
    { stepIndex: 3, stepLabel: "D", slotPath: "X", slotLiteral: "1", value: "later", kind: "text", nullable: false },
    { stepIndex: 1, stepLabel: "B", slotPath: "Y", slotLiteral: "2", value: "earlier", kind: "text", nullable: false }
  ];
  const groups = groupUnmappedByValue(unmapped);
  assert.equal(groups[0].value, "earlier");
  assert.equal(groups[1].value, "later");
});

test("earliestStepIndex returns the minimum stepIndex across occurrences", () => {
  const group = { occurrences: [{ stepIndex: 5 }, { stepIndex: 2 }, { stepIndex: 8 }] };
  assert.equal(earliestStepIndex(group), 2);
});

test("groupByInsertionPoint clusters groups that share the same earliest target step", () => {
  const groups = [
    { occurrences: [{ stepIndex: 2 }] },
    { occurrences: [{ stepIndex: 2 }] },
    { occurrences: [{ stepIndex: 5 }] }
  ];
  const byPoint = groupByInsertionPoint(groups);
  assert.equal(byPoint.length, 2);
  assert.equal(byPoint[0].stepIndex, 2);
  assert.equal(byPoint[0].groups.length, 2);
  assert.equal(byPoint[1].stepIndex, 5);
  assert.equal(byPoint[1].groups.length, 1);
});

test("variableNameFor produces a lowerCamelCase identifier", () => {
  assert.equal(variableNameFor("CustomerNo"), "customerNo");
  assert.equal(variableNameFor("Note"), "note");
});

test("variableNameFor prefixes a purely-numeric or digit-starting field name — real bug, 2026-08-10: \"variablename 0 is also not allowed\", most commonly hit via a $batch sub-request's positional key index leaking through as a \"field name\" when the value went unmapped", () => {
  assert.equal(variableNameFor("0"), "value0");
  assert.equal(variableNameFor("123"), "value123");
});

test("uniqueVariableName disambiguates against already-used names", () => {
  const used = new Set(["customerNo"]);
  assert.equal(uniqueVariableName("customerNo", used), "customerNo2");
  assert.equal(uniqueVariableName("customerNo", used), "customerNo3");
});

test("controlLabelFor splits PascalCase into spaced words", () => {
  assert.equal(controlLabelFor("CustomerNo"), "Customer No");
});
