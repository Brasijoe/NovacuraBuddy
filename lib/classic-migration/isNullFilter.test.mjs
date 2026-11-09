import test from "node:test";
import assert from "node:assert/strict";
import { whereClauseToFlowScript } from "./migration/classicOperationDecoder.js";

const f = (isNegative, extra = {}) => ({
  kind: "And", childOperators: [],
  filters: [{ filterKind: "IsNullFilter", isNegative, memberName: "ReceiptReference", memberTypeName: "System.String", mappingKind: "ConstantMapping", mappingExpression: "", innerFilter: null, ...extra }]
});

test("IsNullFilter translates to = null", () => {
  assert.equal(whereClauseToFlowScript(f(false), null, []), "(ReceiptReference = null)");
});
test("negative IsNullFilter translates to != null", () => {
  assert.equal(whereClauseToFlowScript(f(true), null, []), "(ReceiptReference != null)");
});
test("IsNullFilter without mapping and with alias", () => {
  assert.equal(whereClauseToFlowScript(f(true, { mappingKind: null, mappingExpression: null }), null, [], "x"), "(x.ReceiptReference != null)");
});
