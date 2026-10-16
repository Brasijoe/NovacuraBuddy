const test = require("node:test");
const assert = require("node:assert/strict");
global.FlowDependencyTracer = require("./flow-dependency-tracer.js");
const {
  looksLikeKeyRef,
  parseKeyRefSegments,
  dbNameToApiName,
  isEnumShapedValue,
  stringifyFieldValue,
  findMatchingRecord,
  buildReconstructionExpression,
  tryReconstructKeyRef
} = require("./flow-keyref.js");

// Real recorded value, IFS_Session_12_8_2026_10_59.json, call #7 (PrepareSelectedPickListLines).
const REAL_KEYREF =
  "ACTIVITY_SEQ=100128618^CONFIGURATION_ID=*^CONTRACT=SLC1^ENG_CHG_LEVEL=1^HANDLING_UNIT_ID=0^" +
  "LINE_ITEM_NO=5^LOCATION_NO=MS1^LOT_BATCH_NO=*^ORDER_NO=4039240^PART_NO=10000000004548^" +
  "PICK_LIST_NO=629819^RELEASE_NO=*^SEQUENCE_NO=*^SERIAL_NO=*^WAIV_DEV_REJ_NO=*^";

test("looksLikeKeyRef recognizes the real composite shape", () => {
  assert.equal(looksLikeKeyRef(REAL_KEYREF), true);
  assert.equal(looksLikeKeyRef("ACTIVITY_SEQ=100128618^"), true);
});

test("looksLikeKeyRef requires at least one ^ delimiter — a bare \"NAME=value\" with no delimiter at all isn't the composite shape this fallback exists for (normal dependency matching already handles a genuinely single-field value)", () => {
  assert.equal(looksLikeKeyRef("ACTIVITY_SEQ=100128618"), false);
});

test("looksLikeKeyRef rejects ordinary strings, non-strings, and strings that merely contain a ^", () => {
  assert.equal(looksLikeKeyRef("58C2CFF998C30482E0630A3165647DC8"), false); // no ^ at all
  assert.equal(looksLikeKeyRef("some^text^without^equals"), false); // ^-delimited but no NAME= shape
  assert.equal(looksLikeKeyRef("lowercase_field=x^"), false); // not SCREAMING_SNAKE_CASE
  assert.equal(looksLikeKeyRef(123), false);
  assert.equal(looksLikeKeyRef(null), false);
  assert.equal(looksLikeKeyRef(""), false);
});

test("parseKeyRefSegments splits the real string into ordered {dbName, value} pairs, dropping the trailing empty segment", () => {
  const segments = parseKeyRefSegments(REAL_KEYREF);
  assert.equal(segments.length, 15);
  assert.deepEqual(segments[0], { dbName: "ACTIVITY_SEQ", value: "100128618" });
  assert.deepEqual(segments[2], { dbName: "CONTRACT", value: "SLC1" });
  assert.deepEqual(segments[14], { dbName: "WAIV_DEV_REJ_NO", value: "*" });
});

test("parseKeyRefSegments splits each segment on the FIRST = only", () => {
  assert.deepEqual(parseKeyRefSegments("FOO=a=b^"), [{ dbName: "FOO", value: "a=b" }]);
});

test("dbNameToApiName converts real IFS DB column names to their real PascalCase API field names", () => {
  assert.equal(dbNameToApiName("ACTIVITY_SEQ"), "ActivitySeq");
  assert.equal(dbNameToApiName("CONTRACT"), "Contract");
  assert.equal(dbNameToApiName("ENG_CHG_LEVEL"), "EngChgLevel");
  assert.equal(dbNameToApiName("HANDLING_UNIT_ID"), "HandlingUnitId");
  assert.equal(dbNameToApiName("WAIV_DEV_REJ_NO"), "WaivDevRejNo");
});

test("isEnumShapedValue / stringifyFieldValue recognize FlowScript's real enum wire shape", () => {
  const enumVal = { enumerationNamespace: "IfsApp.CustomerOrderHandling.GenYesNo", name: "No" };
  assert.equal(isEnumShapedValue(enumVal), true);
  assert.equal(stringifyFieldValue(enumVal), "No");
  assert.equal(isEnumShapedValue("plain text"), false);
  assert.equal(isEnumShapedValue(null), false);
  assert.equal(isEnumShapedValue({ name: "x" }), false); // missing enumerationNamespace — not enum-shaped
  assert.equal(stringifyFieldValue(123), "123");
  assert.equal(stringifyFieldValue(null), "null");
});

test("findMatchingRecord finds a RECORD-kind step whose real fields (after DB-name conversion) cover every segment with matching values", () => {
  const segments = parseKeyRefSegments("CONTRACT=SLC1^ORDER_NO=4039240^");
  const stepContexts = [
    { resultKind: "sequence", stepVarName: "GetSomeArray", responseBody: JSON.stringify({ value: [{ Contract: "OTHER" }] }) },
    { resultKind: "record", stepVarName: "GetOrderQuotationSet", responseBody: JSON.stringify({ Contract: "SLC1", OrderNo: "4039240", OtherField: "x" }) }
  ];
  const match = findMatchingRecord(segments, stepContexts);
  assert.ok(match);
  assert.equal(match.stepIndex, 1);
  assert.equal(match.stepVarName, "GetOrderQuotationSet");
  assert.deepEqual(match.fieldsByDbName, { CONTRACT: "Contract", ORDER_NO: "OrderNo" });
});

test("findMatchingRecord requires ALL segments to match the SAME record — no partial matches", () => {
  const segments = parseKeyRefSegments("CONTRACT=SLC1^ORDER_NO=4039240^");
  const stepContexts = [
    // Contract matches here, but OrderNo doesn't — must NOT be treated as a match.
    { resultKind: "record", stepVarName: "GetX", responseBody: JSON.stringify({ Contract: "SLC1", OrderNo: "DIFFERENT" }) }
  ];
  assert.equal(findMatchingRecord(segments, stepContexts), null);
});

test("findMatchingRecord ignores SEQUENCE/array-kind results entirely — Case 2, not built yet", () => {
  const segments = parseKeyRefSegments("CONTRACT=SLC1^");
  const stepContexts = [
    { resultKind: "sequence", stepVarName: "GetArray", responseBody: JSON.stringify({ value: [{ Contract: "SLC1" }] }) }
  ];
  assert.equal(findMatchingRecord(segments, stepContexts), null);
});

test("findMatchingRecord stringifies the candidate's own field value before comparing (real Edm.Decimal-as-string OData convention, and enum-shaped values via .name)", () => {
  const segments = parseKeyRefSegments("LINE_ITEM_NO=5^ORDER_CONF_FLAG=No^");
  const stepContexts = [{
    resultKind: "record",
    stepVarName: "GetX",
    responseBody: JSON.stringify({
      LineItemNo: 5, // real number, key-ref's own value is always text
      OrderConfFlag: { enumerationNamespace: "IfsApp.CustomerOrderHandling.GenYesNo", name: "No" }
    })
  }];
  const match = findMatchingRecord(segments, stepContexts);
  assert.ok(match);
});

test("buildReconstructionExpression rebuilds the exact original literal text/delimiters, wrapping each matched field in str(...)", () => {
  const segments = parseKeyRefSegments("CONTRACT=SLC1^ORDER_NO=4039240^");
  const match = {
    stepVarName: "GetOrderQuotationSet",
    resultKind: "record",
    row: { Contract: "SLC1", OrderNo: "4039240" },
    fieldsByDbName: { CONTRACT: "Contract", ORDER_NO: "OrderNo" }
  };
  const expr = buildReconstructionExpression(segments, match);
  assert.equal(
    expr,
    '"CONTRACT=" & str(GetOrderQuotationSet.Contract) & "^" & "ORDER_NO=" & str(GetOrderQuotationSet.OrderNo) & "^"'
  );
});

test("buildReconstructionExpression uses firstOrNull(...) for a SEQUENCE-kind match and .name (not str()) for an enum-shaped field", () => {
  const segments = parseKeyRefSegments("ADDR_FLAG=No^");
  const match = {
    stepVarName: "GetCustomerOrder",
    resultKind: "sequence",
    row: { AddrFlag: { enumerationNamespace: "IfsApp.CustomerOrderHandling.GenYesNo", name: "No" } },
    fieldsByDbName: { ADDR_FLAG: "AddrFlag" }
  };
  const expr = buildReconstructionExpression(segments, match);
  assert.equal(expr, '"ADDR_FLAG=" & firstOrNull(GetCustomerOrder).AddrFlag.name & "^"');
});

test("tryReconstructKeyRef returns null for a value that isn't key-ref-shaped at all, or that doesn't match any prior record", () => {
  assert.equal(tryReconstructKeyRef("58C2CFF998C30482E0630A3165647DC8", []), null);
  const segmentsUnmatched = "CONTRACT=NOWHERE^";
  assert.equal(tryReconstructKeyRef(segmentsUnmatched, [
    { resultKind: "record", stepVarName: "GetX", responseBody: JSON.stringify({ Contract: "SLC1" }) }
  ]), null);
});

test("tryReconstructKeyRef end-to-end: real DB-named fields/values from the real PickListSelection example, matched against a synthetic RECORD-kind prior step (Case 1 shape — the real recording's own source was actually an array/Case 2, not yet built, so this uses realistic values in a record-kind shape to verify Case 1 specifically)", () => {
  const stepContexts = [
    {
      resultKind: "record",
      stepVarName: "GetShopMaterialPickLine",
      responseBody: JSON.stringify({
        ActivitySeq: "100128618",
        ConfigurationId: "*",
        Contract: "SLC1",
        EngChgLevel: "1",
        HandlingUnitId: "0",
        LineItemNo: "5",
        LocationNo: "MS1",
        LotBatchNo: "*",
        OrderNo: "4039240",
        PartNo: "10000000004548",
        PickListNo: "629819",
        ReleaseNo: "*",
        SequenceNo: "*",
        SerialNo: "*",
        WaivDevRejNo: "*"
      })
    }
  ];
  const result = tryReconstructKeyRef(REAL_KEYREF, stepContexts);
  assert.ok(result);
  assert.equal(result.stepVarName, "GetShopMaterialPickLine");
  assert.match(result.expression, /"ACTIVITY_SEQ=" & str\(GetShopMaterialPickLine\.ActivitySeq\) & "\^"/);
  assert.match(result.expression, /"WAIV_DEV_REJ_NO=" & str\(GetShopMaterialPickLine\.WaivDevRejNo\) & "\^"/);
});
