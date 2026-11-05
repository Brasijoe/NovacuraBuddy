import { whereClauseToFlowScript, needsSelfReferenceAlias } from "./classicOperationDecoder.js";
import { translateMappingExpression, translateOrRaw } from "./classicScriptTranslator.js";
import { findFunctionSignature, findRecordTypeFields, classifyFlowType, deriveWriteCandidates, deriveArrayMutationCandidates, deriveGetByKeyCandidates, findBestMatchingOverload, renderConstantValue, isDroppableUnassigned, defaultLiteralForKind, buildEnumFromTextCall } from "./classicModuleSignatures.js";
function renderInputValue(input, iteratorCtx) {
  if (input.mode === "VariableMapping" || input.mode === "IteratorMapping") {
    return translateOrRaw(
      input.mappingExpression ?? "",
      () => translateMappingExpression(input.mappingExpression ?? "", input.mode === "IteratorMapping" ? iteratorCtx ?? void 0 : void 0)
    );
  }
  if (input.mode === "Constant") {
    return JSON.stringify(input.value == null ? "" : input.value);
  }
  if (input.mode === "CustomRecordMapping") {
    const fields = input.children.map((c) => `${c.name}: ${renderInputValue(c, iteratorCtx)}`).join(", ");
    return `{${fields}}`;
  }
  return `/* TODO: unhandled Classic input mode '${input.mode}' for '${input.name}' */ null`;
}
function wrapDeclaredTypeValue(rendered, declaredType, moduleName) {
  const { kind, nullable, enumType } = classifyFlowType(declaredType);
  if (kind === "enum" && enumType) return buildEnumFromTextCall(moduleName, enumType, rendered);
  if (nullable) return rendered;
  if (kind === "number") return `val(isNull(${rendered}, 0))`;
  const fallback = defaultLiteralForKind(kind);
  if (!fallback) return rendered;
  return `isNull(${rendered}, ${fallback})`;
}
function renderTypedRecordArgument(input, recordFields, moduleName, iteratorCtx, indent = "", moduleSourceText) {
  if (input.mode !== "CustomRecordMapping") return renderInputValue(input, iteratorCtx);
  const fields = input.children.map((c) => {
    const declared = (recordFields || []).find((f) => f.name === c.name);
    if (declared && isDroppableUnassigned(c.mode, declared.optional)) return null;
    if (c.mode === "CustomRecordMapping") {
      const nestedTypeName = declared ? declared.type.replace(/\?$/, "").replace(/\*$/, "").trim() : null;
      const nestedFields = nestedTypeName && moduleSourceText ? findRecordTypeFields(moduleSourceText, nestedTypeName) : null;
      const nestedIndent = `${indent}    `;
      if (nestedFields) {
        return `${c.name}: ${renderTypedRecordArgument(c, nestedFields, moduleName, iteratorCtx, nestedIndent, moduleSourceText)}`;
      }
      const nestedRenderedFields = c.children.filter((nc) => !isDroppableUnassigned(nc.mode, true)).map((nc) => `${nc.name}: ${renderInputValue(nc, iteratorCtx)}`);
      return `${c.name}: ${formatRecordLiteral(nestedRenderedFields, nestedIndent)}`;
    }
    if (declared && c.mode === "Constant") {
      const { kind, enumType } = classifyFlowType(declared.type);
      if (kind === "enum" && enumType) return `${c.name}: ${buildEnumFromTextCall(moduleName, enumType, renderConstantValue(c.value, "text"))}`;
      return `${c.name}: ${renderConstantValue(c.value, kind)}`;
    }
    const rendered = renderInputValue(c, iteratorCtx);
    if (!declared || c.mode !== "VariableMapping" && c.mode !== "IteratorMapping") return `${c.name}: ${rendered}`;
    return `${c.name}: ${wrapDeclaredTypeValue(rendered, declared.type, moduleName)}`;
  }).filter((f) => f !== null);
  return formatRecordLiteral(fields, indent);
}
function formatRecordLiteral(fields, indent = "") {
  if (fields.length <= 1) return `{${fields.join("")}}`;
  const fieldIndent = `${indent}    `;
  return `{
${fields.map((f) => `${fieldIndent}${f}`).join(",\n")}
${indent}}`;
}
function buildQueryScript(moduleName, operation) {
  const warnings = [];
  const alias = needsSelfReferenceAlias(operation.whereClause) ? "x" : null;
  const where = whereClauseToFlowScript(operation.whereClause, moduleName, warnings, alias);
  const queryableVar = operation.entityName;
  const expandNames = (operation.expandMembers || []).map((m) => m.name).filter((n) => !!n);
  const resultFields = operation.resultFields || [];
  const selectFields = [...resultFields, ...expandNames].map((f) => alias ? `${alias}.${f}` : f);
  const selectClause = selectFields.length > 0 ? `select
    ${selectFields.join(",\n    ")}` : "select *";
  const lines = [`return ${selectClause}`, `from ${queryableVar}${alias ? ` as ${alias}` : ""}`];
  if (expandNames.length > 0) lines.push(`expand ${expandNames.join(", ")}`);
  if (where) lines.push(`where ${where}`);
  const selectLine = lines.join("\n");
  (operation.selectMembers || []).filter((m) => m.isNavigationProperty).forEach((m) => warnings.push(`Classic query selects through navigation property '${m.name}'${m.navigationTargetEntitySet ? ` (target '${m.navigationTargetEntitySet}')` : ""} \u2014 not yet supported by this translator, verify manually`));
  return { script: `open ${moduleName};
${selectLine}`, label: operation.entityName ?? null, resultKind: "sequence", verified: true, warnings };
}
function sanitizeForUnresolvedMarker(name) {
  return String(name || "Unknown").replace(/[^A-Za-z0-9_]/g, "_");
}
function formatCallExpr(callee, args, indent = "") {
  if (args.length <= 1) return `${callee}(${args.join("")})`;
  const argIndent = `${indent}    `;
  return `${callee}(
${args.map((a) => `${argIndent}${a}`).join(",\n")}
${indent})`;
}
function buildActionPlaceholderScript(moduleName, operation, reason, iteratorCtx) {
  const inputLines = (operation.inputs || []).map((input) => `//   ${input.name}: ${renderInputValue(input, iteratorCtx)}`);
  const lines = [
    `open ${moduleName};`,
    `// TODO: resolve the real Connect module function for Classic operation '${operation.name}' (${operation.operationName}).`,
    `// ${reason || "Could not verify a function name against real module source"} \u2014 inputs translated for reference:`
  ].concat(inputLines, [`return UNRESOLVED_MIGRATION_CallScript_${sanitizeForUnresolvedMarker(operation.name)}();`]);
  return { script: lines.join("\n"), label: operation.name ?? null, resultKind: "record", verified: false, warnings: [] };
}
function buildActionScript(moduleName, operation, moduleSourceText, schemaLookup) {
  const iteratorSource = operation.iterator ? operation.iterator.replace(/\.Results$/, "") : null;
  const iteratorCtx = iteratorSource ? { qualifyParam: "item", rowSchema: schemaLookup ? schemaLookup(iteratorSource) : null, schemaLookup: schemaLookup ?? void 0 } : null;
  const candidates = [
    // Real bug fix (2026-09-16, see deriveArrayMutationCandidates' own doc comment): a Classic
    // "AddTo<hash>_<ArrayName>"/"UpdateTo<hash>_<ArrayName>" operation name is an unambiguous,
    // completely different shape from GetByKey/the generic write convention -- tried first.
    ...deriveArrayMutationCandidates(operation.containerEntityName, operation.name ?? ""),
    ...deriveGetByKeyCandidates(moduleSourceText, operation.containerEntityName, operation.name ?? ""),
    ...deriveWriteCandidates(operation.containerEntityName, operation.name ?? "")
  ];
  const rawInputs = (operation.inputs || []).filter((input) => input.name !== "throwOnError");
  const keyNames = rawInputs.map((input) => input.name).filter((n) => !!n);
  let overload = null;
  let resolvedName = null;
  for (const candidate of candidates) {
    const found = findBestMatchingOverload(moduleSourceText, candidate, keyNames);
    if (found) {
      overload = found;
      resolvedName = found.name;
      break;
    }
  }
  if (!overload) {
    const namedText = candidates.length === 1 ? `'${candidates[0]}'` : `any of ${candidates.map((c) => `'${c}'`).join(", ")}`;
    return buildActionPlaceholderScript(moduleName, operation, `Checked real module source for '${moduleName}' \u2014 no function named ${namedText} found`, iteratorCtx);
  }
  const positionalParams = overload.params.filter((p) => p.name !== "headers");
  const inputs = rawInputs;
  const renderScalarArg = (input, param) => {
    const singleChild = input.mode === "CustomRecordMapping" && input.children.length === 1 ? input.children[0] : null;
    const scalarInput = singleChild ?? input;
    if (scalarInput.mode === "Constant") {
      const { kind, enumType } = classifyFlowType(param.type);
      if (kind === "enum" && enumType) return buildEnumFromTextCall(moduleName, enumType, renderConstantValue(scalarInput.value, "text"));
      return renderConstantValue(scalarInput.value, kind);
    }
    const rendered = renderInputValue(scalarInput, iteratorCtx);
    if (scalarInput.mode !== "VariableMapping" && scalarInput.mode !== "IteratorMapping") return rendered;
    return wrapDeclaredTypeValue(rendered, param.type, moduleName);
  };
  const matchCompositeKeySpread = (input, startIdx) => {
    if (input.mode !== "CustomRecordMapping" || input.children.length < 2) return null;
    const runLength = input.children.length;
    const run = positionalParams.slice(startIdx, startIdx + runLength);
    if (run.length !== runLength) return null;
    if (run.some((p) => findRecordTypeFields(moduleSourceText, p.type))) return null;
    const paramByUpperName = new Map(run.map((p) => [p.name.toUpperCase(), p]));
    const childByUpperName = new Map(input.children.map((c) => [(c.name || "").toUpperCase(), c]));
    if (paramByUpperName.size !== runLength || childByUpperName.size !== runLength) return null;
    if (![...paramByUpperName.keys()].every((n) => childByUpperName.has(n))) return null;
    return run.map((param) => renderScalarArg(childByUpperName.get(param.name.toUpperCase()), param));
  };
  const args = [];
  const droppable = [];
  let inputIdx = 0;
  for (let paramIdx = 0; paramIdx < positionalParams.length; paramIdx++) {
    const param = positionalParams[paramIdx];
    const input = inputs[inputIdx];
    if (!input) {
      args.push(`/* TODO: no Classic input available for parameter '${param.name}' */ null`);
      droppable.push(param.hasDefault);
      continue;
    }
    const recordFields = findRecordTypeFields(moduleSourceText, param.type);
    if (recordFields) {
      const next = inputs[inputIdx + 1];
      const mergedChildren = input.name === "reqRecord" && next && next.name === "optionalRecord" && next.mode === "CustomRecordMapping" ? [...input.children, ...next.children] : null;
      const recordInput = mergedChildren ? { ...input, children: mergedChildren } : input;
      const outerIndent = iteratorSource ? "    " : "";
      const recordIndent = positionalParams.length <= 1 ? outerIndent : `${outerIndent}    `;
      args.push(renderTypedRecordArgument(recordInput, recordFields, moduleName, iteratorCtx, recordIndent, moduleSourceText));
      droppable.push(false);
      inputIdx += mergedChildren ? 2 : 1;
      continue;
    }
    const spread = matchCompositeKeySpread(input, paramIdx);
    if (spread) {
      spread.forEach((value) => {
        args.push(value);
        droppable.push(false);
      });
      paramIdx += spread.length - 1;
      inputIdx++;
      continue;
    }
    const singleChild = input.mode === "CustomRecordMapping" && input.children.length === 1 ? input.children[0] : null;
    const effectiveMode = (singleChild ?? input).mode;
    args.push(renderScalarArg(input, param));
    droppable.push(isDroppableUnassigned(effectiveMode, param.hasDefault));
    inputIdx++;
  }
  while (args.length > 0 && droppable[args.length - 1]) {
    args.pop();
    droppable.pop();
  }
  const renameNote = resolvedName !== operation.name ? ` (Classic named it '${operation.name}'; the real function is '${resolvedName}')` : "";
  if (iteratorSource) {
    const returnType = overload.returnType ? `${overload.returnType}*` : "any*";
    const lines2 = [
      `open ${moduleName};`,
      `// Verified against real module source: '${resolvedName}' matches a real function; arguments matched by POSITION${renameNote}`,
      `// (Classic's own param names, e.g. '${(inputs[0] || {}).name}', don't correspond to Connect's real ones).`,
      `// Classic's own Iterator ('${operation.iterator}') runs this call once per row -- looped here the same way.`,
      `let outputTbl : ${returnType} = [];`,
      `for item in ${iteratorSource} {`,
      `    set outputTbl = outputTbl & ${formatCallExpr(resolvedName, args, "    ")};`,
      `}`,
      `return outputTbl;`
    ];
    return { script: lines2.join("\n"), label: resolvedName, resultKind: "sequence", verified: true, warnings: [] };
  }
  const lines = [
    `open ${moduleName};`,
    `// Verified against real module source: '${resolvedName}' matches a real function; arguments matched by POSITION${renameNote}`,
    `// (Classic's own param names, e.g. '${(inputs[0] || {}).name}', don't correspond to Connect's real ones).`,
    `return ${formatCallExpr(resolvedName, args)};`
  ];
  const returnsSequence = !!overload.returnType && overload.returnType.trim().endsWith("*");
  return { script: lines.join("\n"), label: resolvedName, resultKind: returnsSequence ? "sequence" : "record", verified: true, warnings: [] };
}
function renderFunctionArgumentValue(filter, declaredType, moduleName = "") {
  if (!filter) return "null";
  if (filter.mappingKind === "VariableMapping") {
    return translateOrRaw(filter.mappingExpression ?? "", () => {
      const rendered = translateMappingExpression(filter.mappingExpression ?? "");
      return declaredType ? wrapDeclaredTypeValue(rendered, declaredType, moduleName) : rendered;
    });
  }
  if (filter.mappingKind === "ConstantMapping") {
    const { kind, enumType } = declaredType ? classifyFlowType(declaredType) : { kind: "text", enumType: null };
    if (kind === "enum" && enumType) return buildEnumFromTextCall(moduleName, enumType, renderConstantValue(filter.mappingExpression, "text"));
    return renderConstantValue(filter.mappingExpression, kind);
  }
  return `/* TODO: unhandled function-argument mapping kind '${filter.mappingKind}' */ null`;
}
function buildFunctionQueryScript(moduleName, operation, moduleSourceText) {
  const functionName = operation.functionName ?? null;
  const filtersByMember = new Map((operation.functionArguments?.filters || []).map((f) => [f.memberName, f]));
  const signature = moduleSourceText ? findFunctionSignature(moduleSourceText, functionName ?? "") : null;
  if (!signature) {
    const reason = moduleSourceText ? `Checked real module source for '${moduleName}' \u2014 no function named '${functionName}' found` : "No real module source was available to verify a function name against";
    const inputLines = (operation.functionParameters || []).map((fp) => `//   ${fp.name}: ${renderFunctionArgumentValue(filtersByMember.get(fp.name), null)}`);
    const lines2 = [
      `open ${moduleName};`,
      `// TODO: resolve the real Connect module function for Classic operation '${functionName}' (${operation.operationName}).`,
      `// ${reason} \u2014 arguments translated for reference:`
    ].concat(inputLines, [`return UNRESOLVED_MIGRATION_CallScript_${sanitizeForUnresolvedMarker(functionName)}();`]);
    return { script: lines2.join("\n"), label: functionName, resultKind: "sequence", verified: false, warnings: [] };
  }
  const positionalParams = signature.params.filter((p) => p.name !== "headers");
  const args = (operation.functionParameters || []).map((fp, i) => {
    const param = positionalParams[i];
    const filter = filtersByMember.get(fp.name);
    if (!filter) return `/* TODO: no bound value found for function parameter '${fp.name}' */ null`;
    return renderFunctionArgumentValue(filter, param ? param.type : null, moduleName);
  });
  const lines = [
    `open ${moduleName};`,
    `// Verified against real module source: '${functionName}' matches a real function; arguments matched by declared parameter order`,
    `return ${formatCallExpr(functionName ?? "", args)};`
  ];
  return { script: lines.join("\n"), label: functionName, resultKind: "sequence", verified: true, warnings: [] };
}
function buildOperationScript(moduleName, operation, moduleSourceText, schemaLookup) {
  if (operation.operationName === "ODataQuery") return buildQueryScript(moduleName, operation);
  if (operation.operationName === "ODataFunctionQuery") return buildFunctionQueryScript(moduleName, operation, moduleSourceText ?? null);
  if (moduleSourceText) return buildActionScript(moduleName, operation, moduleSourceText, schemaLookup);
  return buildActionPlaceholderScript(moduleName, operation, "No real module source was available to verify a function name against");
}
export {
  buildActionPlaceholderScript,
  buildActionScript,
  buildFunctionQueryScript,
  buildOperationScript,
  buildQueryScript,
  renderFunctionArgumentValue,
  renderInputValue,
  renderTypedRecordArgument
};
