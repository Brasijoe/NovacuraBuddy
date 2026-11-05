import { childText } from "./xmlLite.js";
import { findQueryableVarName, findQueryableRowType, findRecordTypeFields, findFunctionSignature, classifyFlowType, classifyDotNetTypeKind, enumModuleName, deriveGetByKeyCandidates, deriveWriteCandidates, findBestMatchingOverload } from "./classicModuleSignatures.js";
import { extractMapAsShapes, parseExpression, schemaLookupKeyOf, flattenConcatChain, unwrapToSourceIdentifier, inferScriptReturnRowSchema } from "./classicScriptTranslator.js";
import { decodeAssignmentConfiguration } from "./classicDecisionDecoder.js";
import { isODataFunctionQueryOperationName } from "./classicOperationDecoder.js";
import { decodeIncludedWorkflow } from "./classicDecoder.js";
const UNKNOWN_TYPE = { kind: "unknown", enumType: null };
function newRowSchema() {
  return /* @__PURE__ */ new Map();
}
function mergeInto(rowSchema, fieldName, fieldType) {
  if (!rowSchema.has(fieldName)) rowSchema.set(fieldName, fieldType);
}
function resolveQueryRowFieldsByVar(items, operationConfigs, moduleSources, resolveModuleName) {
  const queryRowFieldsByVar = /* @__PURE__ */ new Map();
  items.forEach((item) => {
    if (item.tagKind !== "MachineStepConfiguration" || !item.id) return;
    const operation = operationConfigs.get(item.id);
    if (!operation || operation.operationName !== "ODataQuery") return;
    const targetVar = childText(item.tagNode, "TargetVariableName");
    if (!targetVar) return;
    const moduleName = resolveModuleName(operation.serviceUrl ?? null);
    const moduleSourceText = moduleSources.get(moduleName);
    if (!moduleSourceText) return;
    const queryableVar = findQueryableVarName(moduleSourceText, operation.entityName ?? "") || operation.entityName || "";
    const rowType = findQueryableRowType(moduleSourceText, queryableVar);
    const fields = rowType ? findRecordTypeFields(moduleSourceText, rowType) : null;
    const expandFields = (operation.expandMembers || []).map((member) => {
      if (!member.name) return null;
      const signature = findFunctionSignature(moduleSourceText, `${member.name}_From${queryableVar}`);
      if (!signature || !signature.returnType) return null;
      return { name: member.name, type: `${signature.returnType}?`, optional: true };
    }).filter((f) => f !== null);
    const allFields = [...fields || [], ...expandFields];
    if (allFields.length > 0 && !queryRowFieldsByVar.has(targetVar)) queryRowFieldsByVar.set(targetVar, { moduleName, fields: allFields });
  });
  return queryRowFieldsByVar;
}
function resolveActionCallReturnFieldsByVar(items, operationConfigs, moduleSources, resolveModuleName) {
  const fieldsByVar = /* @__PURE__ */ new Map();
  items.forEach((item) => {
    if (item.tagKind !== "MachineStepConfiguration" || !item.id) return;
    const operation = operationConfigs.get(item.id);
    if (!operation || !operation.serviceUrl || operation.iterator) return;
    if (operation.operationName === "ODataQuery" || isODataFunctionQueryOperationName(operation.operationName)) return;
    const targetVar = childText(item.tagNode, "TargetVariableName");
    if (!targetVar || fieldsByVar.has(targetVar)) return;
    const moduleName = resolveModuleName(operation.serviceUrl ?? null);
    const moduleSourceText = moduleSources.get(moduleName);
    if (!moduleSourceText) return;
    const candidates = [
      ...deriveGetByKeyCandidates(moduleSourceText, operation.containerEntityName ?? null, operation.name ?? ""),
      ...deriveWriteCandidates(operation.containerEntityName ?? null, operation.name ?? "")
    ];
    const keyNames = (operation.inputs || []).map((i) => i.name).filter((n) => !!n);
    let overload = null;
    for (const candidate of candidates) {
      const found = findBestMatchingOverload(moduleSourceText, candidate, keyNames);
      if (found) {
        overload = found;
        break;
      }
    }
    if (!overload || !overload.returnType) return;
    const fields = findRecordTypeFields(moduleSourceText, overload.returnType);
    if (!fields) return;
    fieldsByVar.set(targetVar, { moduleName, fields });
  });
  return fieldsByVar;
}
function registerNestedMethodOutputFields(variableSchemas, pathPrefix, fields) {
  const rowSchema = newRowSchema();
  fields.forEach((f) => {
    if (!f.identifier) return;
    const isRecordShaped = (f.type === "Record" || f.type === "Table") && f.children.length > 0;
    mergeInto(rowSchema, f.identifier, isRecordShaped ? { kind: "record", enumType: null } : { kind: classifyDotNetTypeKind(f.dotNetTypeName), enumType: null });
    if (isRecordShaped) registerNestedMethodOutputFields(variableSchemas, `${pathPrefix}.${f.identifier}`, f.children);
  });
  if (!variableSchemas.has(pathPrefix)) variableSchemas.set(pathPrefix, rowSchema);
}
function resolveMethodCallOutputFieldsByVar(items, operationConfigs) {
  const variableSchemas = /* @__PURE__ */ new Map();
  items.forEach((item) => {
    if (item.tagKind !== "MachineStepConfiguration" || !item.id) return;
    const operation = operationConfigs.get(item.id);
    if (!operation || operation.kind !== "methodcall" || !operation.output) return;
    const targetVar = childText(item.tagNode, "TargetVariableName");
    if (!targetVar) return;
    const okChild = operation.output.children.find((c) => (c.identifier || "").toLowerCase() === "ok");
    if (okChild && okChild.identifier) registerNestedMethodOutputFields(variableSchemas, `${targetVar}.${okChild.identifier}`, okChild.children);
    else registerNestedMethodOutputFields(variableSchemas, targetVar, operation.output.children);
  });
  return variableSchemas;
}
function fieldTypeFromRawField(rawField, moduleName, moduleSourceText) {
  const classified = classifyFlowType(rawField.type);
  if (classified.kind === "enum") {
    const enumName = enumModuleName(rawField.type);
    return { kind: "enum", enumType: enumName ? `${moduleName}.${enumName}` : null, optional: classified.nullable };
  }
  if (classified.kind === "text" && moduleSourceText) {
    const bareTypeName = String(rawField.type || "").trim().replace(/\?$/, "").replace(/\*$/, "").trim();
    const recordFields = bareTypeName ? findRecordTypeFields(moduleSourceText, bareTypeName) : null;
    if (recordFields) {
      return { kind: "record", enumType: null, optional: classified.nullable, hasKeyrefField: recordFields.some((f) => f.name === "keyref") };
    }
  }
  return { kind: classified.kind, enumType: null, optional: classified.nullable };
}
function fieldTypeFromFlowScriptTypeText(typeText) {
  const base = String(typeText || "").trim().replace(/\?$/, "");
  if (base === "text") return { kind: "text", enumType: null };
  if (base === "number") return { kind: "number", enumType: null };
  if (base === "boolean") return { kind: "boolean", enumType: null };
  if (base === "datetime") return { kind: "datetime", enumType: null };
  return UNKNOWN_TYPE;
}
function parseFlowScriptTypeText(typeText) {
  const text = String(typeText || "").trim();
  if (!text.startsWith("{")) return null;
  let pos = 0;
  function skipWs() {
    while (pos < text.length && /\s/.test(text[pos])) pos++;
  }
  function parseIdentifier() {
    skipWs();
    const start = pos;
    while (pos < text.length && /[A-Za-z0-9_]/.test(text[pos])) pos++;
    return text.slice(start, pos);
  }
  function parseTypeText() {
    skipWs();
    const start = pos;
    let depth = 0;
    while (pos < text.length) {
      const c = text[pos];
      if (c === "{") depth++;
      else if (c === "}") {
        if (depth === 0) break;
        depth--;
      } else if (c === "," && depth === 0) break;
      pos++;
    }
    return text.slice(start, pos).trim();
  }
  function parseNestedRecordFromText(rawType) {
    const braceStart = rawType.indexOf("{");
    const braceEnd = rawType.lastIndexOf("}");
    if (braceStart === -1 || braceEnd === -1 || braceEnd <= braceStart) return null;
    const inner = rawType.slice(braceStart, braceEnd + 1);
    const subParser = parseFlowScriptTypeText(inner);
    return subParser ? subParser.fields : null;
  }
  function parseRecord() {
    skipWs();
    if (text[pos] !== "{") return null;
    pos++;
    const fields = [];
    skipWs();
    while (pos < text.length && text[pos] !== "}") {
      const name = parseIdentifier();
      skipWs();
      if (text[pos] !== ":") return null;
      pos++;
      const rawType = parseTypeText();
      const isTable = /\}\s*\*\??$/.test(rawType);
      fields.push({ name, type: rawType, isTable, nestedFields: isTable ? parseNestedRecordFromText(rawType) : null });
      skipWs();
      if (text[pos] === ",") {
        pos++;
        skipWs();
        continue;
      }
      break;
    }
    skipWs();
    if (text[pos] === "}") pos++;
    return { fields };
  }
  try {
    return parseRecord();
  } catch (e) {
    return null;
  }
}
function registerComponentResultFields(variableSchemas, targetVariable, resultTypeText) {
  const parsed = parseFlowScriptTypeText(resultTypeText);
  if (!parsed) return;
  parsed.fields.forEach((f) => {
    if (!f.isTable || !f.nestedFields) return;
    const rowSchema = newRowSchema();
    f.nestedFields.forEach((nf) => mergeInto(rowSchema, nf.name, fieldTypeFromFlowScriptTypeText(nf.type)));
    const key = `${targetVariable}.${f.name}`;
    if (!variableSchemas.has(key)) variableSchemas.set(key, rowSchema);
  });
}
function registerMapAsFields(variableSchemas, items) {
  items.forEach((item) => {
    if (item.stepType === "ScriptTaskItem") {
      const scriptText = childText(item.tagNode, "Script");
      extractMapAsShapes(scriptText).forEach((shape) => {
        if (shape.kind !== "named") return;
        if (variableSchemas.has(shape.name)) return;
        const rowSchema = newRowSchema();
        shape.fields.forEach((name) => mergeInto(rowSchema, name, UNKNOWN_TYPE));
        variableSchemas.set(shape.name, rowSchema);
      });
    } else if (item.stepType === "AssignmentItem" && item.tagNode) {
      const { assignments } = decodeAssignmentConfiguration(item.tagNode);
      assignments.forEach((a) => {
        if (!a.targetVariable || variableSchemas.has(a.targetVariable)) return;
        const trimmed = String(a.classicExpression || "").trim();
        const braced = trimmed.match(/^\{([\s\S]*)\}$/);
        const exprText = braced ? braced[1] : trimmed;
        let node;
        try {
          node = parseExpression(exprText);
        } catch (e) {
          return;
        }
        if (!node) return;
        const leaves = [];
        flattenConcatChain(node, leaves);
        const rowSchema = newRowSchema();
        let contributed = false;
        leaves.forEach((leaf) => {
          if (leaf.type === "mapAs") {
            contributed = true;
            const sourceKey = schemaLookupKeyOf(leaf.source);
            const sourceRowSchema = sourceKey ? variableSchemas.get(sourceKey) : void 0;
            leaf.fields.forEach((f) => {
              const inherited = f.expr.type === "identifier" && !f.expr.name.includes(".") && sourceRowSchema ? sourceRowSchema.get(f.expr.name) : void 0;
              mergeInto(rowSchema, f.name, inherited ?? UNKNOWN_TYPE);
            });
          } else {
            const leafKey = schemaLookupKeyOf(leaf);
            const leafRowSchema = leafKey ? variableSchemas.get(leafKey) : void 0;
            if (leafRowSchema) {
              contributed = true;
              leafRowSchema.forEach((fieldType, fieldName) => mergeInto(rowSchema, fieldName, fieldType));
            }
          }
        });
        if (contributed) variableSchemas.set(a.targetVariable, rowSchema);
      });
    }
  });
}
function registerFilterPassthroughFields(variableSchemas, items) {
  const assignmentExprsByTarget = /* @__PURE__ */ new Map();
  items.forEach((item) => {
    if (item.stepType !== "AssignmentItem" || !item.tagNode) return;
    const { assignments } = decodeAssignmentConfiguration(item.tagNode);
    assignments.forEach((a) => {
      if (!a.targetVariable || !a.classicExpression) return;
      const existing = assignmentExprsByTarget.get(a.targetVariable);
      if (existing) existing.push(a.classicExpression);
      else assignmentExprsByTarget.set(a.targetVariable, [a.classicExpression]);
    });
  });
  if (assignmentExprsByTarget.size === 0) return;
  let changed = true;
  let passesLeft = items.length + 1;
  while (changed && passesLeft-- > 0) {
    changed = false;
    assignmentExprsByTarget.forEach((exprTexts, targetVar) => {
      if (variableSchemas.has(targetVar)) return;
      for (const exprText of exprTexts) {
        const resolved = resolvePassthroughSchema(variableSchemas, exprText);
        if (resolved) {
          variableSchemas.set(targetVar, resolved);
          changed = true;
          return;
        }
      }
    });
  }
}
function resolvePassthroughSchema(variableSchemas, exprText) {
  const trimmed = exprText.trim();
  const braced = trimmed.match(/^\{([\s\S]*)\}$/);
  let node;
  try {
    node = parseExpression(braced ? braced[1] : trimmed);
  } catch (e) {
    return null;
  }
  const sourceIdentifier = unwrapToSourceIdentifier(node);
  if (sourceIdentifier) {
    const sourceKey = schemaLookupKeyOf(sourceIdentifier);
    const sourceSchema = sourceKey ? variableSchemas.get(sourceKey) : void 0;
    return sourceSchema || null;
  }
  const selectNode = unwrapToSelectNode(node);
  if (!selectNode) return null;
  const fromIdentifier = unwrapToSourceIdentifier(selectNode.source);
  if (!fromIdentifier) return null;
  const fromKey = schemaLookupKeyOf(fromIdentifier);
  const fromSchema = fromKey ? variableSchemas.get(fromKey) : void 0;
  if (!fromSchema) return null;
  const rowSchema = newRowSchema();
  let contributed = false;
  selectNode.fields.forEach((f) => {
    if (f.expr.type !== "identifier" || f.expr.name.includes(".")) return;
    const fieldType = fromSchema.get(f.expr.name);
    if (!fieldType) return;
    mergeInto(rowSchema, f.alias || f.expr.name, fieldType);
    contributed = true;
  });
  return contributed ? rowSchema : null;
}
function unwrapToSelectNode(node) {
  if (node.type === "select") return node;
  if (node.type === "where") return unwrapToSelectNode(node.source);
  return null;
}
function registerScriptReturnFields(variableSchemas, items) {
  const scripts = [];
  items.forEach((item) => {
    if (item.stepType !== "ScriptTaskItem" || !item.tagNode) return;
    const targetVar = childText(item.tagNode, "TargetVariableName");
    const scriptText = childText(item.tagNode, "Script");
    if (targetVar && scriptText) scripts.push({ targetVar, scriptText });
  });
  if (scripts.length === 0) return;
  const schemaLookup = (key) => variableSchemas.get(key) ?? null;
  let changed = true;
  let passesLeft = scripts.length + 1;
  while (changed && passesLeft-- > 0) {
    changed = false;
    scripts.forEach(({ targetVar, scriptText }) => {
      if (variableSchemas.has(targetVar)) return;
      const resolved = inferScriptReturnRowSchema(scriptText, { schemaLookup });
      if (resolved) {
        variableSchemas.set(targetVar, resolved);
        changed = true;
      }
    });
  }
}
function resolveVariableFieldSchemas(items, operationConfigs, moduleSources, resolveModuleName, componentResultTypesByStep) {
  const variableSchemas = /* @__PURE__ */ new Map();
  const queryRowFieldsByVar = resolveQueryRowFieldsByVar(items, operationConfigs, moduleSources, resolveModuleName);
  queryRowFieldsByVar.forEach(({ moduleName, fields: rawFields }, targetVar) => {
    const rowSchema = newRowSchema();
    rawFields.forEach((rf) => mergeInto(rowSchema, rf.name, fieldTypeFromRawField(rf, moduleName, moduleSources.get(moduleName))));
    variableSchemas.set(targetVar, rowSchema);
  });
  const actionCallFieldsByVar = resolveActionCallReturnFieldsByVar(items, operationConfigs, moduleSources, resolveModuleName);
  actionCallFieldsByVar.forEach(({ moduleName, fields: rawFields }, targetVar) => {
    if (variableSchemas.has(targetVar)) return;
    const rowSchema = newRowSchema();
    rawFields.forEach((rf) => mergeInto(rowSchema, rf.name, fieldTypeFromRawField(rf, moduleName, moduleSources.get(moduleName))));
    variableSchemas.set(targetVar, rowSchema);
  });
  const methodCallOutputFieldsByVar = resolveMethodCallOutputFieldsByVar(items, operationConfigs);
  methodCallOutputFieldsByVar.forEach((rowSchema, key) => {
    if (!variableSchemas.has(key)) variableSchemas.set(key, rowSchema);
  });
  registerFilterPassthroughFields(variableSchemas, items);
  registerScriptReturnFields(variableSchemas, items);
  if (componentResultTypesByStep) {
    items.forEach((item) => {
      if (!item.id) return;
      const resultTypeText = componentResultTypesByStep.get(item.id);
      if (!resultTypeText) return;
      const targetVar = item.stepType === "IncludedWorkflowItem" ? item.tagNode ? decodeIncludedWorkflow(item.tagNode).outputRecord : null : childText(item.tagNode, "TargetVariableName");
      if (!targetVar) return;
      registerComponentResultFields(variableSchemas, targetVar, resultTypeText);
    });
  }
  registerMapAsFields(variableSchemas, items);
  return variableSchemas;
}
export {
  fieldTypeFromFlowScriptTypeText,
  fieldTypeFromRawField,
  parseFlowScriptTypeText,
  resolveActionCallReturnFieldsByVar,
  resolveMethodCallOutputFieldsByVar,
  resolveQueryRowFieldsByVar,
  resolveVariableFieldSchemas
};
