import { findChild, findChildren, childText } from "./xmlLite.js";
import { registerPhrase, isPhraseReference } from "./classicPhrasebook.js";
import { translateExpression, translateMappingTemplate, translateAssignmentTemplate, translateOrRaw, unwrapBracedExpression } from "./classicScriptTranslator.js";
const KNOWN_OPERATORS = {
  Equals: "=",
  NotEquals: "!=",
  GreaterThan: ">",
  LessThan: "<",
  GreaterThanOrEquals: ">=",
  LessThanOrEquals: "<="
};
const UNARY_TABLE_OPERATORS = {
  IsEmpty: (l) => `not any(${l})`,
  IsNotEmpty: (l) => `any(${l})`
};
const LOWCODE_OPERATORS = {
  IsNotEmpty: "isNotEmpty",
  // Confirmed real (2026-08-06, real captured configuration-changed event, "Customer Id
  // Exists?" decision, AEB Sanction Check - Customer): { type: "lowcode",
  // lhsExpression: "CustomerId", operator: "isNull", rhsTemplate: "" }.
  IsNull: "isNull",
  // Confirmed real (2026-08-06) — each seen as its own real Classic SimplifiedRule operator
  // name in a real decision's TODO placeholder, cross-referenced against Connect's own
  // lowcode-operator dropdown (screenshot, same date) which lists exactly: =, !=, >, >=, <,
  // <=, is null, is not null, is empty, is not empty, is empty text, is not empty text, is
  // true, is false, is single. The symbol operators are already handled by KNOWN_OPERATORS
  // above (confirmed separately to compile as flattened expressions); every "is ..." one maps
  // here.
  IsTrue: "isTrue",
  // real: "Expire Customers?" decision, SetExpireDate IsTrue
  IsEmpty: "isEmpty",
  // real: "Address Tbl Empty?" decision, AddressTbl IsEmpty
  IsNotNull: "isNotNull",
  // real: "Customer Order Exists?" decision, OrderRef1 IsNotNull
  // The remaining four from the dropdown (IsFalse/IsSingle/IsEmptyText/IsNotEmptyText) have not
  // been seen yet as a real Classic operator name — included here on the strength of the
  // otherwise-unbroken IsX -> isX naming convention above (5-for-5 confirmed), but NOT
  // independently confirmed. Safe to include speculatively either way: an actual Classic
  // operator name that doesn't match one of these simply misses this lookup and falls back to
  // the existing TODO-flagged flattened emission below, unchanged — it can't silently produce
  // wrong output, only miss the nicer native shape until confirmed for real.
  IsFalse: "isFalse",
  IsSingle: "isSingle",
  IsEmptyText: "isEmptyText",
  IsNotEmptyText: "isNotEmptyText"
};
function stripPathPrefix(path) {
  const m = /^[A-Za-z]+:(.*)$/.exec(path || "");
  return m ? m[1] : path;
}
function decodeOperand(node, side) {
  const variableUsage = findChild(node, `${side}OperandVariableUsage`);
  if (variableUsage) {
    const path = stripPathPrefix(childText(variableUsage, "Path"));
    return { kind: "variable", path, flowScript: path ?? "" };
  }
  const literal = childText(node, `${side}OperandLiteral`);
  if (literal !== null) {
    const isNumericLiteral = /^-?\d+(\.\d+)?$/.test(literal);
    return { kind: "literal", value: literal, flowScript: isNumericLiteral ? literal : JSON.stringify(literal) };
  }
  return null;
}
const NULL_CHECK_TO_EMPTY_TEXT = { IsNull: "isEmptyText", IsNotNull: "isNotEmptyText" };
const NULLABLE_TRUE_CHECK_OPERATORS = /* @__PURE__ */ new Set(["IsTrue", "IsFalse"]);
function stripEntitySegmentForLookup(path, recordPopulatedVars) {
  if (!recordPopulatedVars || recordPopulatedVars.size === 0) return path;
  for (const name of recordPopulatedVars) {
    const prefix = `${name}.Entity.`;
    if (path.startsWith(prefix)) return `${name}.${path.slice(prefix.length)}`;
  }
  return path;
}
const BOOLEAN_LITERAL_SPELLING_RE = /^(true|false)$/i;
function decodeSimplifiedRule(ruleNode, nonNullableTextVars, nullableBooleanVars, recordPopulatedVars, booleanVars) {
  let left = decodeOperand(ruleNode, "Left");
  let right = decodeOperand(ruleNode, "Right");
  if (left && left.kind === "variable" && left.path === "clientType" && right && right.kind === "literal" && right.value === "Designer") {
    left = { kind: "variable", path: "environmentType", flowScript: "environmentType" };
    right = { kind: "literal", value: "dev", flowScript: JSON.stringify("dev") };
  }
  const classicOperator = childText(ruleNode, "Operator");
  const flowOperator = classicOperator ? KNOWN_OPERATORS[classicOperator] : void 0;
  const comparison = `${left ? left.flowScript : "null"} ${flowOperator || classicOperator} ${right ? right.flowScript : "null"}`;
  const lookupPath = left && left.kind === "variable" && left.path ? stripEntitySegmentForLookup(left.path, recordPopulatedVars) : null;
  const isConfirmedNonNullableText = !!(classicOperator && lookupPath && nonNullableTextVars && nonNullableTextVars.has(lookupPath));
  const lowcodeOperator = classicOperator ? isConfirmedNonNullableText && NULL_CHECK_TO_EMPTY_TEXT[classicOperator] || LOWCODE_OPERATORS[classicOperator] : void 0;
  const isConfirmedNullableBoolean = !!(classicOperator && NULLABLE_TRUE_CHECK_OPERATORS.has(classicOperator) && lookupPath && nullableBooleanVars && nullableBooleanVars.has(lookupPath));
  const isConfirmedBooleanEqualityLiteral = !!((classicOperator === "Equals" || classicOperator === "NotEquals") && lookupPath && booleanVars && booleanVars.has(lookupPath) && right && right.kind === "literal" && BOOLEAN_LITERAL_SPELLING_RE.test(right.value));
  const unaryTableOperator = classicOperator ? UNARY_TABLE_OPERATORS[classicOperator] : void 0;
  const defaultFlowScript = flowOperator ? comparison : unaryTableOperator && left ? unaryTableOperator(left.flowScript) : `/* TODO: verify Connect operator for Classic SimplifiedRule operator '${classicOperator}' */ ${comparison}`;
  const defaultLowcode = lowcodeOperator && left ? { lhsExpression: left.flowScript, operator: lowcodeOperator, rhsTemplate: right ? right.flowScript : "" } : null;
  if (isConfirmedNullableBoolean && left) {
    return {
      kind: "simplified",
      left,
      right,
      classicOperator,
      flowScript: `isNull(${left.flowScript}, false) = ${classicOperator === "IsFalse" ? "false" : "true"}`,
      lowcode: null
    };
  }
  if (isConfirmedBooleanEqualityLiteral && left && right && right.kind === "literal") {
    return {
      kind: "simplified",
      left,
      right,
      classicOperator,
      flowScript: `${left.flowScript} ${flowOperator} ${right.value.toLowerCase()}`,
      lowcode: null
    };
  }
  return {
    kind: "simplified",
    left,
    right,
    classicOperator,
    flowScript: defaultFlowScript,
    lowcode: defaultLowcode
  };
}
function decodeScriptExpressionRule(ruleNode, schemaLookup, declaredVariableNames) {
  const classicExpression = childText(ruleNode, "Expression");
  const flowScript = translateOrRaw(
    classicExpression ?? "",
    () => translateExpression(unwrapBracedExpression(classicExpression ?? ""), {
      noSeqAvailable: true,
      schemaLookup: schemaLookup ?? void 0,
      // See classicEmitter.ts's collectDeclaredVariableNames own doc comment -- a real
      // ScriptExpressionRule filter can reference an outer-scope flow variable the same way an
      // AssignmentItem's own expression can (e.g. "InvPartInStockTbl where SerialNo = SelSerialNo").
      protectedNames: declaredVariableNames ?? void 0
    })
  );
  return { kind: "script", classicExpression, flowScript };
}
function decodeFlowRule(ruleNode, nonNullableTextVars, nullableBooleanVars, recordPopulatedVars, booleanVars, schemaLookup, declaredVariableNames) {
  const ruleKind = ruleNode.attrs["xsi:type"];
  if (ruleKind === "ScriptExpressionRule") return decodeScriptExpressionRule(ruleNode, schemaLookup, declaredVariableNames);
  if (ruleKind === "SimplifiedRule") return decodeSimplifiedRule(ruleNode, nonNullableTextVars, nullableBooleanVars, recordPopulatedVars, booleanVars);
  return { kind: "unknown", tagKind: ruleKind, flowScript: `/* TODO: unrecognized Classic FlowRule kind '${ruleKind}' */ true` };
}
function decodeRuleCollection(node, nonNullableTextVars, nullableBooleanVars, recordPopulatedVars, booleanVars, schemaLookup, declaredVariableNames) {
  const rulesContainer = findChild(node, "Rules");
  const rules = findChildren(rulesContainer, "FlowRule").map((r) => decodeFlowRule(r, nonNullableTextVars, nullableBooleanVars, recordPopulatedVars, booleanVars, schemaLookup, declaredVariableNames));
  return { relation: childText(node, "Relation"), rules };
}
function ruleCollectionToFlowScript(ruleCollection) {
  if (ruleCollection.rules.length === 0) return "true";
  const combinator = ruleCollection.relation === "Any" ? " or " : " and ";
  return ruleCollection.rules.map((r) => `(${r.flowScript})`).join(combinator);
}
function decodeAssignmentConfiguration(tagNode, ctx) {
  const assignmentsContainer = findChild(tagNode, "Assignments");
  const assignments = findChildren(assignmentsContainer, "Assignment").map((a) => {
    const classicExpression = childText(a, "Expression");
    const flowScript = translateOrRaw(classicExpression ?? "", () => translateAssignmentTemplate(classicExpression ?? "", ctx));
    return { targetVariable: childText(a, "TargetVariable"), classicExpression, flowScript };
  });
  return { assignments };
}
function decodeLanguageTextFromContainer(container, label, preferredLangCode, flowDefaultLangCode, warnings, ctx) {
  const strings = findChild(container, "Strings");
  const items = findChildren(strings, "LanguageString");
  if (items.length === 0) return null;
  if (ctx?.phrasebook) {
    const rawTexts = {};
    for (const i of items) {
      const code = childText(i, "LanguageCode");
      if (code) rawTexts[code] = childText(i, "Text") || "";
    }
    const ref = registerPhrase(ctx.phrasebook, rawTexts, (expr) => translateOrRaw(expr, () => translateExpression(expr, ctx)));
    if (ref) return ref;
  }
  const hasText = (i) => !!(childText(i, "Text") || "").trim();
  const byCode = (code) => items.find((i) => childText(i, "LanguageCode") === code && hasText(i));
  const chosen = (preferredLangCode ? byCode(preferredLangCode) : void 0) || (flowDefaultLangCode ? byCode(flowDefaultLangCode) : void 0) || byCode("en") || items.find(hasText) || items[0];
  const chosenText = childText(chosen, "Text");
  if (warnings) {
    const chosenCode = childText(chosen, "LanguageCode");
    const dropped = items.filter((i) => childText(i, "LanguageCode") !== chosenCode).filter((i) => {
      const t = childText(i, "Text");
      return t && t.trim() && t.trim() !== (chosenText || "").trim();
    }).map((i) => childText(i, "LanguageCode"));
    if (dropped.length > 0) {
      warnings.push(`${label}: dropped non-'${chosenCode}' text for language(s): ${dropped.join(", ")}`);
    }
  }
  return chosenText;
}
function decodeLanguageText(tagNode, containerName, preferredLangCode, flowDefaultLangCode, warnings, ctx) {
  const container = findChild(tagNode, containerName);
  return decodeLanguageTextFromContainer(container, containerName, preferredLangCode, flowDefaultLangCode, warnings, ctx);
}
function decodeLocalizedTextNode(node, label, preferredLangCode, flowDefaultLangCode, warnings, ctx) {
  return decodeLanguageTextFromContainer(node, label, preferredLangCode, flowDefaultLangCode, warnings, ctx);
}
function decodeAssertion(tagNode, ctx) {
  const errorMessageRaw = decodeLanguageText(tagNode, "ErrorMessage", "en", null, null, ctx);
  const errorMessage = !errorMessageRaw ? "" : ctx?.phrasebook && isPhraseReference(ctx.phrasebook, errorMessageRaw) ? errorMessageRaw.slice(1, -1) : translateOrRaw(errorMessageRaw, () => translateMappingTemplate(errorMessageRaw));
  const ruleCollection = decodeRuleCollection(findChild(tagNode, "Rules"));
  return { errorMessage, ruleCollection };
}
export {
  decodeAssertion,
  decodeAssignmentConfiguration,
  decodeFlowRule,
  decodeLanguageText,
  decodeLocalizedTextNode,
  decodeRuleCollection,
  ruleCollectionToFlowScript,
  stripPathPrefix
};
