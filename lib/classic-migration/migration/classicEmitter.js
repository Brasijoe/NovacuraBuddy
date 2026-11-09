import { childText, findChild, findChildren } from "./xmlLite.js";
import {
  addAssignmentStep,
  addAssertionStep,
  addScriptStep,
  addModule,
  addComponentStep,
  addDecisionStep,
  addRestCallStep,
  addDatabaseCommandStep,
  addEmailStep,
  addAnnotation,
  connectIncoming,
  addStartStep,
  addEndStep,
  addOutputVariables,
  beginDeterministicIds,
  endDeterministicIds,
  addUserTaskStep,
  addCheckpointStep,
  addTableStep,
  addSplitStep,
  newGuid
} from "../flow-elements/flowElements.js";
import { decodeTableCreation } from "./classicTableDecoder.js";
import { decodeUserStep, decodeUserStepButton } from "./classicUserStepDecoder.js";
import { createPhrasebook, phrasebookEntries } from "./classicPhrasebook.js";
import { decodeAssignmentConfiguration, decodeAssertion, decodeRuleCollection, decodeLanguageText, stripPathPrefix } from "./classicDecisionDecoder.js";
import {
  translateScript,
  usesSeqModule,
  matchTableCall,
  buildTableDeclaration,
  requiredEnumOpens,
  hoistMapAsForAssignmentValue,
  translateMappingExpression,
  translateMappingTemplate,
  translateOrRaw,
  translateControlField,
  inferDottedFieldKindsFromScriptUsage
} from "./classicScriptTranslator.js";
import { buildOperationScript } from "./classicCallScriptDecoder.js";
import { decodeIncludedWorkflow, decodeSubworkflowItems, collectAllItems, narrowItemKeyedMapForSubworkflow } from "./classicDecoder.js";
import { buildRestCall } from "./classicRestCallDecoder.js";
import { findRestProjectOperationByDisplayName } from "./classicRestProjectDecoder.js";
import { resolveQueryRowFieldsByVar, resolveVariableFieldSchemas } from "./classicSchema.js";
import { buildFileSystemCallScript, lookupFileSystemFunctionName } from "./classicFileSystemMapping.js";
import { buildHtml2PdfScript } from "./classicHtml2PdfTranslator.js";
import {
  isGetCustomPropertiesOperation,
  matchEnvironmentPropertyLookup,
  buildEnvironmentPropertyTemplate
} from "./classicFlowEnvironmentMapping.js";
import {
  escapeRegExp,
  deriveWriteCandidates,
  deriveGetByKeyCandidates,
  findBestMatchingOverload,
  findRecordTypeFields,
  classifyFlowType,
  qualifyEnumTypeText
} from "./classicModuleSignatures.js";
function extractSvcName(url) {
  const m = String(url || "").match(/([A-Za-z0-9_]+)\.svc/i);
  return m ? m[1] : null;
}
const IFS10_CONNECTOR_TYPE = "Database.IFS10";
function buildControlFlowGraph(items, arrows) {
  const sequenceArrows = arrows.filter((a) => a.arrowType === "Sequence");
  const outgoing = /* @__PURE__ */ new Map();
  const incoming = /* @__PURE__ */ new Map();
  items.forEach((it) => {
    outgoing.set(it.id, []);
    incoming.set(it.id, []);
  });
  sequenceArrows.forEach((a) => {
    if (outgoing.has(a.sinkItemId)) outgoing.get(a.sinkItemId).push(a);
    if (incoming.has(a.targetItemId)) incoming.get(a.targetItemId).push(a);
  });
  return { outgoing, incoming };
}
function topologicalOrder(items, outgoing, incoming) {
  const indegree = new Map(items.map((it) => [it.id, (incoming.get(it.id) || []).length]));
  const queue = items.filter((it) => indegree.get(it.id) === 0).map((it) => it.id);
  const visited = /* @__PURE__ */ new Set();
  const order = [];
  const forcedEntries = [];
  function drainQueue() {
    while (queue.length > 0) {
      const id = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      order.push(id);
      (outgoing.get(id) || []).forEach((arrow) => {
        const t = arrow.targetItemId;
        if (!indegree.has(t) || visited.has(t)) return;
        indegree.set(t, indegree.get(t) - 1);
        if (indegree.get(t) === 0) queue.push(t);
      });
    }
  }
  drainQueue();
  while (order.length < items.length) {
    const remaining = items.filter((it) => !visited.has(it.id));
    if (remaining.length === 0) break;
    const entry = remaining.find((it) => (incoming.get(it.id) || []).some((a) => visited.has(a.sinkItemId))) || remaining[0];
    forcedEntries.push(entry.id);
    visited.add(entry.id);
    order.push(entry.id);
    (outgoing.get(entry.id) || []).forEach((arrow) => {
      const t = arrow.targetItemId;
      if (!indegree.has(t) || visited.has(t)) return;
      indegree.set(t, indegree.get(t) - 1);
      if (indegree.get(t) === 0) queue.push(t);
    });
    drainQueue();
  }
  return { order, unresolved: [], forcedEntries };
}
function computeReachableFromStart(startItemId, outgoing) {
  const reachable = /* @__PURE__ */ new Set();
  const queue = [startItemId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (reachable.has(id)) continue;
    reachable.add(id);
    (outgoing.get(id) || []).forEach((arrow) => {
      if (!reachable.has(arrow.targetItemId)) queue.push(arrow.targetItemId);
    });
  }
  return reachable;
}
function escapeForRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function stripTrackedResultsSuffix(text, selectPopulatedVars) {
  if (typeof text !== "string" || !selectPopulatedVars || selectPopulatedVars.size === 0) return text;
  let result = text;
  selectPopulatedVars.forEach((name) => {
    const re = new RegExp(`\\b${escapeForRegExp(name)}\\.Results\\b`, "g");
    result = result.replace(re, name);
  });
  return result;
}
function stripTrackedEntitySegment(text, recordPopulatedVars) {
  if (typeof text !== "string" || !recordPopulatedVars || recordPopulatedVars.size === 0) return text;
  let result = text;
  recordPopulatedVars.forEach((name) => {
    const re = new RegExp(`\\b${escapeForRegExp(name)}\\.Entity\\.`, "g");
    result = result.replace(re, `${name}.`);
  });
  return result;
}
function stripTrackedRestOkSuffix(text, restCallPopulatedVars) {
  if (typeof text !== "string" || !restCallPopulatedVars || restCallPopulatedVars.size === 0) return text;
  let result = text;
  restCallPopulatedVars.forEach((name) => {
    const re = new RegExp(`\\b${escapeForRegExp(name)}\\.[Oo][Kk]\\b`, "g");
    result = result.replace(re, `${name}.contents`);
  });
  return result;
}
function deepStripResults(value, selectPopulatedVars, recordPopulatedVars, restCallPopulatedVars) {
  if (typeof value === "string") {
    return stripTrackedRestOkSuffix(
      stripTrackedEntitySegment(stripTrackedResultsSuffix(value, selectPopulatedVars), recordPopulatedVars),
      restCallPopulatedVars
    );
  }
  if (Array.isArray(value)) return value.map((v) => deepStripResults(v, selectPopulatedVars, recordPopulatedVars, restCallPopulatedVars));
  if (value && typeof value === "object") {
    const out = {};
    Object.keys(value).forEach((k) => {
      out[k] = deepStripResults(value[k], selectPopulatedVars, recordPopulatedVars, restCallPopulatedVars);
    });
    return out;
  }
  return value;
}
function collectDataDependencyEdges(items, arrows) {
  const edges = /* @__PURE__ */ new Map();
  arrows.filter((a) => a.arrowType === "Data").forEach((a) => {
    if (!edges.has(a.targetItemId)) edges.set(a.targetItemId, []);
    const sources = edges.get(a.targetItemId);
    if (!sources.includes(a.sinkItemId)) sources.push(a.sinkItemId);
  });
  return edges;
}
const COORDINATE_SCALE = 1.5;
const BUNDLE_FOLLOW_UP_OFFSET = 300;
const BUNDLE_DOWNSTREAM_CLEARANCE = 224;
function toConnectLocation(classicLocation) {
  if (!classicLocation) return null;
  return { x: Math.round(classicLocation.x * COORDINATE_SCALE), y: Math.round(classicLocation.y * COORDINATE_SCALE) };
}
function toConnectJoints(classicJoints) {
  if (!classicJoints || classicJoints.length === 0) return void 0;
  return classicJoints.map((p) => ({ x: Math.round(p.x * COORDINATE_SCALE), y: Math.round(p.y * COORDINATE_SCALE) }));
}
function stripOuterBraces(text) {
  const m = String(text || "").match(/^\{([\s\S]*)\}$/);
  return m ? m[1] : String(text || "");
}
function renderBundledFieldValue(classicExpression, template) {
  const isComputed = /^\{[\s\S]*\}$/.test(String(classicExpression || "").trim());
  if (isComputed) return stripOuterBraces(template);
  const trimmed = String(template || "").trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed) || trimmed === "true" || trimmed === "false") return trimmed;
  return JSON.stringify(trimmed);
}
function buildSchemaFieldsText(entries, lookupType, indent, contextModuleName) {
  return entries.map((entry) => {
    if (entry.fields) {
      const inner = buildSchemaFieldsText(entry.fields, lookupType, `${indent}    `, contextModuleName);
      const suffix = entry.isTable ? "*" : "";
      return `${indent}${entry.name}: {
${inner}
${indent}}${suffix}`;
    }
    const type = lookupType(entry.name);
    return `${indent}${entry.name}: ${qualifyEnumTypeText(type || "text?", contextModuleName)}`;
  }).join(",\n");
}
function buildResultTypeExpression(outputVariableNames, outputVariableSchema, tableDeclarationTypes, contextModuleName) {
  if (!outputVariableNames || outputVariableNames.length === 0) return "{}";
  const schemaEntriesByName = new Map(parseSchemaEntries(outputVariableSchema).map((e) => [e.name, e]));
  const fields = outputVariableNames.map((name) => {
    const schemaEntry = schemaEntriesByName.get(name);
    const entryFields = schemaEntry && schemaEntry.fields || [];
    const isTable = schemaEntry ? schemaEntry.isTable : true;
    const realFields = tableDeclarationTypes ? tableDeclarationTypes.get(name) : null;
    const realByUpperName = new Map((realFields || []).map((f) => [f.name.toUpperCase(), f]));
    const lookupType = (fieldName) => {
      const real = realByUpperName.get(fieldName.toUpperCase());
      return real ? real.type : null;
    };
    const fieldsText = buildSchemaFieldsText(entryFields, lookupType, "        ", contextModuleName);
    return `    ${name}: {
${fieldsText}
    }${isTable ? "*" : ""}`;
  }).join(",\n");
  return `{
${fields}
}`;
}
function variableSchemaKeyForConcatOperand(raw) {
  if (raw.endsWith(".Results")) return raw.slice(0, -".Results".length);
  if (raw.endsWith(".Ok")) return `${raw.slice(0, -".Ok".length)}.contents`;
  return raw;
}
function recordFieldsFromRowSchema(rowSchema) {
  const fields = [];
  rowSchema.forEach((ft, name) => {
    const suffix = ft.optional ? "?" : "";
    if (ft.kind === "enum" && ft.enumType) {
      fields.push({ name, type: `${ft.enumType}.Value${suffix}`, optional: false });
      return;
    }
    if (ft.kind === "text" || ft.kind === "number" || ft.kind === "boolean" || ft.kind === "datetime") {
      fields.push({ name, type: `${ft.kind}${suffix}`, optional: false });
    }
  });
  return fields;
}
function resolveTableDeclarationTypes(items, operationConfigs, moduleSources, resolveModuleName, variableSchemas) {
  const queryRowFieldsByVar = resolveQueryRowFieldsByVar(items, operationConfigs, moduleSources, resolveModuleName);
  const tableVarNames = /* @__PURE__ */ new Set();
  items.forEach((item) => {
    if (item.stepType !== "AssignmentItem" || !item.tagNode) return;
    const { assignments } = decodeAssignmentConfiguration(item.tagNode);
    assignments.forEach((a) => {
      if (matchTableCall(a.classicExpression || "") && a.targetVariable) tableVarNames.add(a.targetVariable);
    });
  });
  const CONCAT_RE = /^\{?\(?\s*([A-Za-z_]\w*(?:\.\w+)?)\s*&\s*([A-Za-z_]\w*(?:\.\w+)?)\s*\)?\}?$/;
  const result = /* @__PURE__ */ new Map();
  items.forEach((item) => {
    if (item.stepType !== "AssignmentItem" || !item.tagNode) return;
    const { assignments } = decodeAssignmentConfiguration(item.tagNode);
    assignments.forEach((a) => {
      const m = CONCAT_RE.exec(String(a.classicExpression || "").trim());
      if (!m) return;
      const [, rawLeft, rawRight] = m;
      const left = variableSchemaKeyForConcatOperand(rawLeft);
      const right = variableSchemaKeyForConcatOperand(rawRight);
      const tableVar = tableVarNames.has(rawLeft) ? rawLeft : tableVarNames.has(rawRight) ? rawRight : null;
      if (!tableVar) return;
      const otherKey = tableVar === rawLeft ? right : left;
      const queryFields = queryRowFieldsByVar.get(otherKey);
      if (queryFields) {
        result.set(tableVar, queryFields);
        return;
      }
      const rowSchema = variableSchemas.get(otherKey);
      if (!rowSchema || rowSchema.size === 0) return;
      const fields = recordFieldsFromRowSchema(rowSchema);
      if (fields.length > 0) result.set(tableVar, { moduleName: "", fields });
    });
  });
  return result;
}
function straightenAlignedArrowJoints(data) {
  const locationById = /* @__PURE__ */ new Map();
  data.forEach((entry) => {
    if (entry.type === "step-created") locationById.set(entry.id, entry.location);
  });
  return data.map((entry) => {
    if (entry.type !== "arrow-created" || entry.joints.length !== 1) return entry;
    const from = locationById.get(entry.fromStep);
    const to = entry.toStep ? locationById.get(entry.toStep) : void 0;
    if (!from || !to) return entry;
    if (from.x !== to.x && from.y !== to.y) return entry;
    return { ...entry, joints: [] };
  });
}
const STEP_ICON_SIZE = 160;
function alignChainedSteps(data) {
  const steps = data.filter((e) => e.type === "step-created");
  const stepById = new Map(steps.map((s) => [s.id, s]));
  const outgoingSeq = /* @__PURE__ */ new Map();
  const incomingSeqCount = /* @__PURE__ */ new Map();
  data.forEach((e) => {
    if (e.type === "arrow-created" && e.arrowKind === "sequence") {
      if (!outgoingSeq.has(e.fromStep)) outgoingSeq.set(e.fromStep, []);
      outgoingSeq.get(e.fromStep).push(e.toStep);
      incomingSeqCount.set(e.toStep, (incomingSeqCount.get(e.toStep) || 0) + 1);
    }
  });
  const locationById = new Map(steps.map((s) => [s.id, s.location]));
  const visited = /* @__PURE__ */ new Set();
  const roots = steps.filter((s) => (incomingSeqCount.get(s.id) || 0) === 0).map((s) => s.id);
  const queue = [...roots];
  while (steps.length > visited.size) {
    if (queue.length === 0) {
      const next = steps.find((s) => !visited.has(s.id));
      if (!next) break;
      queue.push(next.id);
    }
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    const children = outgoingSeq.get(id) || [];
    const isAnchor = (s) => stepById.get(s)?.stepType === "start" || stepById.get(s)?.stepType === "end";
    children.forEach((c) => {
      if (!isAnchor(id) && !isAnchor(c) && (incomingSeqCount.get(c) || 0) === 1 && !visited.has(c)) {
        const from = locationById.get(id);
        const to = locationById.get(c);
        if (from.x !== to.x && from.y !== to.y) {
          const dx = Math.abs(to.x - from.x);
          const dy = Math.abs(to.y - from.y);
          locationById.set(c, dx >= dy ? { x: to.x, y: from.y } : { x: from.x, y: to.y });
        }
      }
    });
    children.forEach((c) => {
      if (!visited.has(c)) queue.push(c);
    });
  }
  return data.map((e) => {
    if (e.type !== "step-created") return e;
    const loc = locationById.get(e.id);
    if (!loc || loc.x === e.location.x && loc.y === e.location.y) return e;
    return { ...e, location: loc };
  });
}
function resolveStepOverlaps(data) {
  const steps = data.filter((e) => e.type === "step-created");
  const ids = steps.filter((s) => s.stepType !== "start" && s.stepType !== "end").map((s) => s.id);
  const locationById = new Map(steps.map((s) => [s.id, s.location]));
  const MAX_PASSES = 25;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let moved = false;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = locationById.get(ids[i]);
        const b = locationById.get(ids[j]);
        const dx = Math.abs(a.x - b.x);
        const dy = Math.abs(a.y - b.y);
        if (dx >= STEP_ICON_SIZE || dy >= STEP_ICON_SIZE) continue;
        moved = true;
        const pushX = () => locationById.set(ids[j], { x: a.x + STEP_ICON_SIZE * (b.x - a.x >= 0 ? 1 : -1), y: b.y });
        const pushY = () => locationById.set(ids[j], { x: b.x, y: a.y + STEP_ICON_SIZE * (b.y - a.y >= 0 ? 1 : -1) });
        if (a.x === b.x) pushY();
        else if (a.y === b.y) pushX();
        else if (dx <= dy) pushX();
        else pushY();
      }
    }
    if (!moved) break;
  }
  return data.map((e) => {
    if (e.type !== "step-created") return e;
    const loc = locationById.get(e.id);
    if (!loc || loc.x === e.location.x && loc.y === e.location.y) return e;
    return { ...e, location: loc };
  });
}
function addOrthogonalJoints(data) {
  const locationById = /* @__PURE__ */ new Map();
  const stepTypeById = /* @__PURE__ */ new Map();
  data.forEach((e) => {
    if (e.type === "step-created") {
      locationById.set(e.id, e.location);
      stepTypeById.set(e.id, e.stepType);
    }
  });
  return data.map((entry) => {
    if (entry.type !== "arrow-created" || entry.arrowKind !== "sequence" || entry.joints.length > 0) return entry;
    if (stepTypeById.get(entry.fromStep) === "start" || stepTypeById.get(entry.fromStep) === "end") return entry;
    if (entry.toStep && (stepTypeById.get(entry.toStep) === "start" || stepTypeById.get(entry.toStep) === "end")) return entry;
    const from = locationById.get(entry.fromStep);
    const to = entry.toStep ? locationById.get(entry.toStep) : void 0;
    if (!from || !to) return entry;
    if (from.x === to.x || from.y === to.y) return entry;
    const dx = Math.abs(to.x - from.x);
    const dy = Math.abs(to.y - from.y);
    const bend = dx >= dy ? { x: to.x, y: from.y } : { x: from.x, y: to.y };
    return { ...entry, joints: [bend] };
  });
}
function applyBundleExpansionShifts(data, bundleExpansions) {
  const ROW_BUCKET = 50 * COORDINATE_SCALE;
  const rowKeyFor = (y) => Math.round(y / ROW_BUCKET);
  let result = data;
  [...bundleExpansions].sort((a, b) => a.x - b.x).forEach((exp) => {
    const rowKey = rowKeyFor(exp.y);
    const shiftedStepIds = /* @__PURE__ */ new Set();
    result = result.map((entry) => {
      if (entry.type !== "step-created") return entry;
      if (exp.stepIds.includes(entry.id)) return entry;
      if (entry.location.x <= exp.x) return entry;
      if (rowKeyFor(entry.location.y) !== rowKey) return entry;
      shiftedStepIds.add(entry.id);
      return { ...entry, location: { x: entry.location.x + exp.width, y: entry.location.y } };
    });
    result = result.map((entry) => {
      if (entry.type !== "arrow-created" || entry.joints.length === 0) return entry;
      const toShifted = shiftedStepIds.has(entry.toStep);
      const fromShifted = shiftedStepIds.has(entry.fromStep);
      if (!toShifted && !fromShifted) return entry;
      const joints = entry.joints.map((j) => ({ ...j }));
      if (joints.length === 1) {
        joints[0] = { ...joints[0], x: joints[0].x + exp.width };
      } else {
        if (fromShifted) joints[0] = { ...joints[0], x: joints[0].x + exp.width };
        if (toShifted) joints[joints.length - 1] = { ...joints[joints.length - 1], x: joints[joints.length - 1].x + exp.width };
      }
      return { ...entry, joints };
    });
  });
  return result;
}
function withClassicScriptStepLabel(data, stepId, label) {
  if (!label) return data;
  return data.map((d) => d.type === "step-created" && d.id === stepId && d.stepType === "script" ? { ...d, label } : d);
}
function emitAssignmentItem(data, item, userId, fromStepId, tableDeclarationTypes, incomingJoints, schemaLookup, environmentPropertyTableVars, dataFromStepIds, declaredVariableNames) {
  const { assignments } = decodeAssignmentConfiguration(item.tagNode, { schemaLookup, protectedNames: declaredVariableNames });
  const mapped = assignments.length > 0 ? assignments.map((a) => {
    const propertyName = matchEnvironmentPropertyLookup(a.classicExpression, environmentPropertyTableVars);
    const template = propertyName !== null ? buildEnvironmentPropertyTemplate(propertyName) : a.flowScript;
    return { targetVariableName: a.targetVariable || "", template, classicExpression: propertyName !== null ? null : a.classicExpression };
  }) : [{ targetVariableName: `classicStep_${item.id}`, template: "null", classicExpression: null }];
  const location = toConnectLocation(item.location);
  const tableColumnsByVar = /* @__PURE__ */ new Map();
  mapped.forEach((a) => {
    const columnNames = matchTableCall(a.classicExpression || "");
    if (columnNames) tableColumnsByVar.set(a.targetVariableName, columnNames);
  });
  const needsSeq = mapped.some((a) => !tableColumnsByVar.has(a.targetVariableName) && usesSeqModule(a.template));
  const hoistByVar = /* @__PURE__ */ new Map();
  mapped.forEach((a) => {
    if (tableColumnsByVar.has(a.targetVariableName)) return;
    if (!/^\{[\s\S]*\}$/.test(String(a.classicExpression || "").trim())) return;
    try {
      const result = hoistMapAsForAssignmentValue(stripOuterBraces(a.classicExpression), { schemaLookup, protectedNames: declaredVariableNames });
      if (result.hoistedLines.length > 0) hoistByVar.set(a.targetVariableName, result);
    } catch {
    }
  });
  const needsMapAsHoist = hoistByVar.size > 0;
  const needsScriptStep = needsSeq || needsMapAsHoist;
  if (tableColumnsByVar.size === 0 && !needsScriptStep) {
    return addAssignmentStep(data, mapped, item.label || "Assignment", userId, fromStepId, location ?? void 0, incomingJoints, dataFromStepIds);
  }
  if (mapped.length === 1 && needsScriptStep && tableColumnsByVar.size === 0) {
    const hoist = hoistByVar.get(mapped[0].targetVariableName);
    const exprText = hoist ? hoist.expr : stripOuterBraces(mapped[0].template);
    const hoistedPreamble = hoist && hoist.hoistedLines.length > 0 ? hoist.hoistedLines.join("\n") + "\n" : "";
    const seqOpenLine2 = needsSeq ? "open Seq;\n" : "";
    const script = `${seqOpenLine2}${hoistedPreamble}return ${exprText};`;
    return addScriptStep(data, script, mapped[0].targetVariableName, null, "", userId, "", "", fromStepId, location ?? void 0, incomingJoints, dataFromStepIds);
  }
  if (mapped.length === 1 && tableColumnsByVar.size === 1) {
    const [columnNames] = [...tableColumnsByVar.values()];
    const realQueryFields = tableDeclarationTypes.get(mapped[0].targetVariableName);
    const realFields = realQueryFields ? realQueryFields.fields : null;
    const contextModuleName = realQueryFields ? realQueryFields.moduleName : null;
    const enumOpenLines2 = requiredEnumOpens(realFields, contextModuleName).map((m) => `open ${m};
`).join("");
    const script = `${enumOpenLines2}${buildTableDeclaration(mapped[0].targetVariableName, columnNames, realFields, contextModuleName)}
return ${mapped[0].targetVariableName};`;
    return addScriptStep(data, script, mapped[0].targetVariableName, null, "", userId, "", "", fromStepId, location ?? void 0, incomingJoints, dataFromStepIds);
  }
  const declarations = [];
  const enumOpenModules = /* @__PURE__ */ new Set();
  const fields = mapped.map((a) => {
    const columnNames = tableColumnsByVar.get(a.targetVariableName);
    if (columnNames) {
      const realQueryFields = tableDeclarationTypes.get(a.targetVariableName);
      const realFields = realQueryFields ? realQueryFields.fields : null;
      const contextModuleName = realQueryFields ? realQueryFields.moduleName : null;
      requiredEnumOpens(realFields, contextModuleName).forEach((m) => enumOpenModules.add(m));
      declarations.push(buildTableDeclaration(a.targetVariableName, columnNames, realFields, contextModuleName));
      return `${a.targetVariableName}: ${a.targetVariableName}`;
    }
    const hoist = hoistByVar.get(a.targetVariableName);
    if (hoist) {
      declarations.push(...hoist.hoistedLines);
      return `${a.targetVariableName}: ${hoist.expr}`;
    }
    return `${a.targetVariableName}: ${renderBundledFieldValue(a.classicExpression, a.template)}`;
  }).join(", ");
  const recordVar = `classicStep_${item.id}_bundle`;
  const enumOpenLines = [...enumOpenModules].map((m) => `open ${m};
`).join("");
  const seqOpenLine = needsSeq ? "open Seq;\n" : "";
  const declarationLines = declarations.length > 0 ? declarations.join("\n") + "\n" : "";
  const bundleScript = `${enumOpenLines}${seqOpenLine}${declarationLines}return { ${fields} };`;
  const scriptResult = addScriptStep(data, bundleScript, recordVar, null, "", userId, "", "", fromStepId, location ?? void 0, incomingJoints, dataFromStepIds);
  const followUp = mapped.map((a) => ({ targetVariableName: a.targetVariableName, template: `{${scriptResult.stepId ? recordVar : recordVar}.${a.targetVariableName}}` }));
  const followUpLocation = location ? { x: location.x + BUNDLE_FOLLOW_UP_OFFSET, y: location.y } : void 0;
  const followUpResult = addAssignmentStep(scriptResult.data, followUp, item.label || "Assignment", userId, scriptResult.stepId, followUpLocation);
  return location ? { ...followUpResult, bundleExpansion: { x: location.x, y: location.y, width: BUNDLE_FOLLOW_UP_OFFSET + BUNDLE_DOWNSTREAM_CLEARANCE, stepIds: [scriptResult.stepId, followUpResult.stepId] } } : followUpResult;
}
function toConnectCondition(r) {
  return "lowcode" in r && r.lowcode ? { type: "lowcode", lhsExpression: r.lowcode.lhsExpression, operator: r.lowcode.operator, rhsTemplate: r.lowcode.rhsTemplate } : { expression: r.flowScript };
}
function emitAssertTaskItem(data, item, userId, fromStepId, incomingJoints, dataFromStepIds, phrasebook) {
  const { errorMessage, ruleCollection } = decodeAssertion(item.tagNode, phrasebook ? { phrasebook } : void 0);
  const conditions = ruleCollection.rules.map(toConnectCondition);
  const relation = ruleCollection.relation === "Any" ? "any" : "all";
  return addAssertionStep(data, conditions, relation, errorMessage, item.label || "Assertion", userId, fromStepId, toConnectLocation(item.location) ?? void 0, incomingJoints, dataFromStepIds);
}
function emitScriptTaskItem(data, item, fromStepId, connector, userId, warnings, incomingJoints, schemaLookup, dataFromStepIds, declaredVariableNames) {
  const scriptText = childText(item.tagNode, "Script");
  const targetVar = childText(item.tagNode, "TargetVariableName") || `classicStep_${item.id}`;
  let flowScript;
  try {
    const { script, warnings: scriptWarnings } = translateScript(scriptText || "", { schemaLookup, protectedNames: declaredVariableNames });
    flowScript = script;
    for (const w of scriptWarnings) warnings.push(`ScriptTaskItem ${item.id} (${item.label || ""}): ${w}`);
  } catch (e) {
    flowScript = scriptText || "";
  }
  return addScriptStep(data, flowScript, targetVar, connector, "", userId, "", "", fromStepId, toConnectLocation(item.location) ?? void 0, incomingJoints, dataFromStepIds);
}
function renderCustomHttpTemplate(template, parameters, schemaLookup) {
  const byPlaceholder = /* @__PURE__ */ new Map();
  parameters.forEach((p) => {
    if (p.name && p.mappingExpression) {
      const translated = translateOrRaw(p.mappingExpression, () => translateMappingExpression(p.mappingExpression, { schemaLookup }));
      byPlaceholder.set(`{${p.name}}`, translated);
    }
  });
  if (byPlaceholder.size === 0) return JSON.stringify(template);
  const placeholderRe = new RegExp(`(${[...byPlaceholder.keys()].map(escapeRegExp).join("|")})`, "g");
  const parts = template.split(placeholderRe).filter((s) => s !== "");
  return parts.map((part) => byPlaceholder.has(part) ? byPlaceholder.get(part) : JSON.stringify(part)).join(" & ");
}
function buildCustomHttpFlowScript(operation, schemaLookup) {
  const params = operation.customParameters || [];
  const urlExpr = renderCustomHttpTemplate(operation.customUrl || "", params, schemaLookup);
  const method = (operation.customHttpMethod || "GET").toUpperCase();
  const hasBody = !!(operation.customBody && operation.customBody.trim().length > 0);
  const optionLines = [`method: ${JSON.stringify(method)}`];
  if (hasBody) {
    optionLines.push(`body: ${renderCustomHttpTemplate(operation.customBody, params, schemaLookup)}`);
    optionLines.push(`headers: { "Content-Type": ${JSON.stringify(operation.customContentType || "application/json")} }`);
  }
  return [
    `let response = HTTP.request(${urlExpr}, {`,
    optionLines.map((l) => `    ${l}`).join(",\n"),
    `});`,
    `return { StatusCode: response.statusCode, ErrorMessage: response.reasonPhrase, HasFailed: not response.ok };`
  ].join("\n");
}
function emitMethodCallOperation(data, item, targetVar, fromStepId, connector, userId, operation, restResolutions, warnings, location, incomingJoints, restCallPopulatedVars, dataFromStepIds) {
  const resolution = operation.connectorName ? restResolutions.get(operation.connectorName) : null;
  const methodLabel = operation.displayName || operation.identifier || "";
  const connectorLabel = operation.connectorName ? ` on connector '${operation.connectorName}'${operation.connectorTypeName ? ` (${operation.connectorTypeName})` : ""}` : "";
  const restProjectOperations = resolution ? resolution.restProjectOperations : null;
  const matchedRestOperation = restProjectOperations ? findRestProjectOperationByDisplayName(restProjectOperations, operation.displayName ?? null) : null;
  if (resolution && resolution.connector && matchedRestOperation) {
    const { restCall, warnings: restWarnings } = buildRestCall(
      operation,
      matchedRestOperation,
      resolution.connector,
      resolution.connectorEnvironments,
      targetVar
    );
    for (const w of restWarnings) warnings.push(`MachineTaskItem ${item.id} (${item.label || ""}): ${w}`);
    const restTargetVar = restCall.targetVariableName ?? targetVar;
    restCallPopulatedVars.add(restTargetVar);
    return addRestCallStep(data, { ...restCall, targetVariableName: restTargetVar }, item.label || methodLabel, userId, fromStepId, location ?? void 0, incomingJoints, dataFromStepIds);
  }
  if (isGetCustomPropertiesOperation(operation.connectorTypeName, operation.identifier)) {
    warnings.push(
      `MachineTaskItem ${item.id} (${item.label || ""}) is Classic's Flow Environment 'Get properties' call \u2014 has no Connect equivalent, left as an empty placeholder; every direct property lookup from its result found in this flow was rewritten to Connect's real environment.* syntax instead \u2014 check manually if anything else still reads from its result variable`
    );
    return addScriptStep(data, "return [];", targetVar, connector, "", userId, "", "", fromStepId, location ?? void 0, incomingJoints, dataFromStepIds);
  }
  if (operation.connectorTypeName === "filesystem") {
    const fileSystemCall = buildFileSystemCallScript(operation.identifier ?? null, operation.declaringCategory ?? null, operation.methodCallInputs ?? []);
    if (fileSystemCall) {
      for (const w of fileSystemCall.warnings) warnings.push(`MachineTaskItem ${item.id} (${item.label || ""}): ${w}`);
      warnings.push(
        `MachineTaskItem ${item.id} (${item.label || ""}): FileSystem step connector binding: ${resolution?.connector ? `${resolution.connector.name} (id=${resolution.connector.id}, type=${resolution.connector.type})` : "NONE -- resolution.connector was not set for this step"}`
      );
      return addScriptStep(
        data,
        fileSystemCall.script,
        targetVar,
        resolution?.connector ?? null,
        "",
        userId,
        "",
        "",
        fromStepId,
        location ?? void 0,
        incomingJoints,
        dataFromStepIds
      );
    }
  }
  let reason;
  if (resolution && resolution.connector && restProjectOperations && restProjectOperations.length > 0) {
    const available = restProjectOperations.map((o) => `'${o.displayName}'`).join(", ");
    reason = operation.displayName ? `matched to Connect connector '${resolution.connector.name}' with an uploaded REST project, but none of its ${restProjectOperations.length} endpoint(s) (${available}) match this method's display name ('${operation.displayName}')` : `matched to Connect connector '${resolution.connector.name}' with an uploaded REST project (${restProjectOperations.length} endpoint(s): ${available}), but this Classic method has no DisplayName to match against \u2014 cannot pick the right one automatically`;
  } else if (operation.connectorTypeName === "filesystem") {
    const fnName = lookupFileSystemFunctionName(operation.identifier ?? null, operation.declaringCategory ?? null);
    reason = fnName ? `recognized as FlowScript's FileSystem.${fnName}, but its real Classic parameters didn't match what that mapping expects \u2014 needs a one-off manual fix (see classicFileSystemMapping.ts)` : `not yet mapped to a real FlowScript FileSystem.* function${operation.declaringCategory ? ` (category: ${operation.declaringCategory})` : ""}`;
  } else if (resolution && resolution.connector) {
    reason = operation.connectorTypeName === "rest" ? `matched to Connect connector '${resolution.connector.name}' but still needs a REST connector project (.ncrcp) upload before it can be translated into a real step` : `matched to Connect connector '${resolution.connector.name}' (${operation.connectorTypeName || "unknown type"}) \u2014 no step builder exists yet for this connector type`;
  } else {
    reason = "needs a matched Connect connector before it can be translated, not yet resolved";
  }
  warnings.push(`MachineTaskItem ${item.id} (${item.label || ""}) is a Classic method call ('${methodLabel}')${connectorLabel} \u2014 ${reason}`);
  const script = `return UNRESOLVED_MIGRATION_MethodCall_${item.id}();`;
  return addScriptStep(data, script, targetVar, connector, "", userId, "", "UnknownModule", fromStepId, location ?? void 0, incomingJoints, dataFromStepIds);
}
function emitDatabaseCommandOperation(data, item, targetVar, fromStepId, userId, operation, restResolutions, warnings, location, incomingJoints, dataFromStepIds, translateCtx) {
  const resolution = operation.connectorName ? restResolutions.get(operation.connectorName) : null;
  const connector = resolution && resolution.connector ? resolution.connector : null;
  if (operation.connectorName && !resolution) {
    warnings.push(`MachineTaskItem ${item.id} (${item.label || ""}) is a Classic database command on connector '${operation.connectorName}' \u2014 not matched to a real Connect connector yet, emitted with no connector bound`);
  }
  let runAsTemplate = operation.runAsTemplate ? translateControlField(operation.runAsTemplate, "template", translateCtx) : "";
  if (connector && connector.type === IFS10_CONNECTOR_TYPE && !runAsTemplate) {
    if (resolution?.runAsUser) {
      runAsTemplate = "{userId}";
    } else if (resolution?.runAsUser === void 0) {
      const warning = `Classic connector '${operation.connectorName}' is mapped to IFS Applications 10 connector '${connector.name}' but its Classic 'Run as User' setting is unknown \u2014 database steps without their own runAs will run as the connector user`;
      if (!warnings.includes(warning)) warnings.push(warning);
    }
  }
  return addDatabaseCommandStep(
    data,
    {
      targetVariableName: targetVar,
      commandType: operation.commandType,
      commandText: operation.commandText,
      iteratorExpression: operation.iteratorExpression ? translateControlField(operation.iteratorExpression, "expression", translateCtx) : "",
      runAsTemplate,
      // Always false for a migrated step (user-confirmed 2026-10-05): true would require the runAs
      // variables to be assigned as signed variables, which migration never does.
      isRunAsSigned: false,
      connector
    },
    item.label || "Database",
    userId,
    fromStepId,
    location ?? void 0,
    incomingJoints,
    dataFromStepIds
  );
}
function emitEmailOperation(data, item, targetVar, fromStepId, userId, operation, restResolutions, warnings, location, incomingJoints, translateCtx) {
  const resolution = operation.connectorName ? restResolutions.get(operation.connectorName) : null;
  const connector = resolution && resolution.connector ? resolution.connector : null;
  if (operation.connectorName && !resolution) {
    warnings.push(`MachineTaskItem ${item.id} (${item.label || ""}) is a Classic email step on connector '${operation.connectorName}' \u2014 not matched to a real Connect connector yet, emitted with no connector bound`);
  }
  const field = (raw) => raw ? translateControlField(raw, "template", translateCtx) : "";
  return addEmailStep(
    data,
    {
      targetVariableName: targetVar,
      from: field(operation.from),
      to: field(operation.to),
      cc: field(operation.cc),
      bcc: field(operation.bcc),
      subject: field(operation.subject),
      body: field(operation.body),
      isHtml: operation.isHtml,
      attachmentScript: field(operation.attachmentScript),
      connector
    },
    item.label || "Email",
    userId,
    fromStepId,
    location ?? void 0,
    incomingJoints
  );
}
function emitHtml2PdfOperation(data, targetVar, fromStepId, connector, userId, operation, location, incomingJoints, dataFromStepIds) {
  const { script } = buildHtml2PdfScript(operation);
  return addScriptStep(data, script, targetVar, connector, "", userId, "", "", fromStepId, location ?? void 0, incomingJoints, dataFromStepIds);
}
function emitMachineTaskItem(data, item, fromStepId, connector, userId, operationConfigs, resolveModuleName, modulesAdded, warnings, moduleSources, moduleAssetIds, selectPopulatedVars, recordPopulatedVars, restResolutions, restCallPopulatedVars, incomingJoints, schemaLookup, dataFromStepIds) {
  const operation = operationConfigs.get(item.id ?? "");
  const targetVar = childText(item.tagNode, "TargetVariableName") || `classicStep_${item.id}`;
  const location = toConnectLocation(item.location);
  if (operation && operation.kind === "methodcall") {
    return emitMethodCallOperation(data, item, targetVar, fromStepId, connector, userId, operation, restResolutions, warnings, location, incomingJoints, restCallPopulatedVars, dataFromStepIds);
  }
  if (operation && operation.kind === "database") {
    return emitDatabaseCommandOperation(data, item, targetVar, fromStepId, userId, operation, restResolutions, warnings, location, incomingJoints, dataFromStepIds, { schemaLookup });
  }
  if (operation && operation.kind === "email") {
    return emitEmailOperation(data, item, targetVar, fromStepId, userId, operation, restResolutions, warnings, location, incomingJoints, { schemaLookup });
  }
  if (operation && operation.kind === "html2pdf") {
    return emitHtml2PdfOperation(data, targetVar, fromStepId, connector, userId, operation, location, incomingJoints, dataFromStepIds);
  }
  const odataConnector = operation && operation.connectorName ? restResolutions.get(operation.connectorName) : null;
  const resolvedConnector = odataConnector && odataConnector.connector ? odataConnector.connector : connector;
  if (!operation || !operation.serviceUrl) {
    if (operation && operation.operationName === "ODataCustomHttp" && operation.customUrl) {
      const script3 = buildCustomHttpFlowScript(operation, schemaLookup);
      return addScriptStep(data, script3, targetVar, resolvedConnector, "", userId, "", "", fromStepId, location ?? void 0, incomingJoints, dataFromStepIds);
    }
    const reason = !operation ? `MachineTaskItem ${item.id} (${item.label || ""}) has no decoded operation config` : `MachineTaskItem ${item.id} (${item.label || ""}) is a Classic '${operation.operationName}' operation with no OData service reference and no Custom Request URL either \u2014 no Connect equivalent yet.`;
    warnings.push(reason);
    const script2 = `return UNRESOLVED_MIGRATION_MethodCall_${item.id}();`;
    return addScriptStep(data, script2, targetVar, resolvedConnector, "", userId, "", "UnknownModule", fromStepId, location ?? void 0, incomingJoints, dataFromStepIds);
  }
  const moduleName = resolveModuleName(operation.serviceUrl);
  let tempData = data;
  if (!modulesAdded.has(moduleName)) {
    const moduleId = moduleAssetIds && moduleAssetIds.get(moduleName) || "";
    tempData = addModule(tempData, moduleName, moduleId);
    modulesAdded.add(moduleName);
  }
  const moduleSourceText = moduleSources.get(moduleName);
  const { script, resultKind, verified, warnings: scriptWarnings } = buildOperationScript(moduleName, operation, moduleSourceText, schemaLookup);
  if (scriptWarnings) {
    for (const w of scriptWarnings) warnings.push(`MachineTaskItem ${item.id} (${item.label || ""}): ${w}`);
  }
  if (resultKind === "sequence") selectPopulatedVars.add(targetVar);
  if (resultKind === "record" && verified) recordPopulatedVars.add(targetVar);
  return addScriptStep(tempData, script, targetVar, resolvedConnector, "", userId, "", moduleName, fromStepId, location ?? void 0, incomingJoints, dataFromStepIds);
}
function buildIncludedWorkflowParameterExpression(variableMappingsNode) {
  if (!variableMappingsNode) return "{}";
  const container = findChild(variableMappingsNode, "__Mappings");
  const mappings = container ? findChildren(container, "SerializableVariableMapping") : [];
  const fields = [];
  for (const mapping of mappings) {
    const variableName = childText(mapping, "VariableName");
    const mappingText = childText(mapping, "Mapping");
    if (!variableName || !mappingText || !mappingText.trim()) continue;
    fields.push(`${variableName}: ${translateOrRaw(mappingText, () => translateMappingTemplate(mappingText))}`);
  }
  return fields.length > 0 ? `{${fields.join(", ")}}` : "{}";
}
function emitIncludedWorkflowItem(data, item, fromStepId, userId, includedWorkflows, componentAssetsUsed, incomingJoints, warnings, dataFromStepIds) {
  const ref = decodeIncludedWorkflow(item.tagNode);
  const targetVar = ref.outputRecord || `classicStep_${item.id}`;
  const target = ref.versionIdentifier ? includedWorkflows.get(ref.versionIdentifier) : null;
  const location = toConnectLocation(item.location);
  if (target && target.assetId && target.assetVersion) {
    componentAssetsUsed.push({ assetId: target.assetId, assetVersion: target.assetVersion, name: target.name });
    return addComponentStep(data, {
      componentId: target.assetId,
      componentName: target.name,
      targetVariableName: targetVar,
      parameterExpression: buildIncludedWorkflowParameterExpression(ref.variableMappingsNode)
    }, item.label || target.name, userId, fromStepId, location ?? void 0, incomingJoints, dataFromStepIds);
  }
  const targetDescription = target ? `"${target.name}" (not yet created as a Connect asset)` : `versionIdentifier ${ref.versionIdentifier} (not resolved \u2014 target flow wasn't supplied)`;
  warnings.push(`IncludedWorkflowItem ${item.id} (${item.label || ""}) could not emit a real "component" step \u2014 ${targetDescription}. If this flow includes other fragments, create/include those first (or use "Process entire archive" instead of a single-flow creation) so this reference can resolve.`);
  const script = `return UNRESOLVED_MIGRATION_IncludedWorkflow_${item.id}();`;
  return addScriptStep(data, script, targetVar, null, "", userId, "", "", fromStepId, location ?? void 0, incomingJoints, dataFromStepIds);
}
function parseSchemaEntries(schemaText) {
  if (!schemaText) return [];
  const entries = [];
  const len = schemaText.length;
  let i = 0;
  while (i < len) {
    while (i < len && /[\s,]/.test(schemaText[i])) i++;
    if (i >= len) break;
    const nameStart = i;
    while (i < len && /[A-Za-z0-9_]/.test(schemaText[i])) i++;
    const name = schemaText.slice(nameStart, i);
    if (!name) {
      i++;
      continue;
    }
    while (i < len && /\s/.test(schemaText[i])) i++;
    const isTableForm = schemaText[i] === "*" && schemaText[i + 1] === "(";
    const isRecordForm = schemaText[i] === "(";
    if (isTableForm || isRecordForm) {
      i += isTableForm ? 2 : 1;
      const fieldsStart = i;
      let depth = 1;
      while (i < len && depth > 0) {
        if (schemaText[i] === "(") depth++;
        else if (schemaText[i] === ")") depth--;
        if (depth > 0) i++;
      }
      const fields = parseSchemaEntries(schemaText.slice(fieldsStart, i));
      i++;
      entries.push({ name, fields, isTable: isTableForm });
    } else {
      entries.push({ name, fields: null, isTable: false });
    }
  }
  return entries;
}
function inferFlowScriptType(dotNetTypeName) {
  if (!dotNetTypeName) return null;
  if (/System\.String\b/.test(dotNetTypeName)) return "text";
  if (/System\.Boolean\b/.test(dotNetTypeName)) return "boolean";
  if (/System\.(Decimal|Byte|Int16|Int32|Int64|Single|Double)\b/.test(dotNetTypeName)) return "number";
  if (/System\.DateTime\b|Microsoft\.OData\.Edm\.Date(TimeOffset)?\b/.test(dotNetTypeName)) return "datetime";
  return null;
}
function collectWhereClauseTypedRefs(operator, out) {
  if (!operator) return;
  (operator.filters || []).forEach((f) => {
    if (f.mappingExpression) out.push({ expression: f.mappingExpression, dotNetTypeName: f.memberTypeName, isComplex: false });
  });
  (operator.childOperators || []).forEach((child) => collectWhereClauseTypedRefs(child, out));
}
function collectOperationInputTypedRefs(inputsRuntime, inputsMetadata, out) {
  const metaByIdentifier = /* @__PURE__ */ new Map();
  (function indexMeta(nodes) {
    (nodes || []).forEach((m) => {
      metaByIdentifier.set(m.identifier, m);
      indexMeta(m.children);
    });
  })(inputsMetadata);
  (function walk(nodes) {
    (nodes || []).forEach((n) => {
      if (n.mode === "VariableMapping" && n.mappingExpression) {
        const bare = n.mappingExpression.replace(/^\{|\}$/g, "");
        const meta = metaByIdentifier.get(n.identifier);
        if (meta) {
          const isComplex = meta.type === "Record" || meta.type === "Table";
          out.push({ expression: bare, dotNetTypeName: isComplex ? null : meta.dotNetTypeName, isComplex });
        }
      }
      walk(n.children);
    });
  })(inputsRuntime);
}
function recordFieldKindEvidence(target, disagreed, dotted, kind) {
  if (disagreed.has(dotted)) return;
  const existing = target.get(dotted);
  if (existing && existing !== kind) {
    target.delete(dotted);
    disagreed.add(dotted);
    return;
  }
  target.set(dotted, kind);
}
function collectModuleCallFieldKindEvidence(items, operationConfigs, moduleSources, resolveModuleName, paramNames) {
  const result = /* @__PURE__ */ new Map();
  const disagreed = /* @__PURE__ */ new Set();
  const dottedKeyOf = (mappingExpression) => {
    const bare = String(mappingExpression || "").replace(/^\{|\}$/g, "");
    const dotIdx = bare.indexOf(".");
    if (dotIdx < 0 || !paramNames.has(bare.slice(0, dotIdx))) return null;
    return bare;
  };
  items.forEach((item) => {
    const operation = operationConfigs.get(item.id ?? "");
    if (!operation || operation.kind === "methodcall" || !operation.serviceUrl) return;
    if (operation.operationName !== "ODataAction" && operation.operationName !== "ODataAssemblyOperation") return;
    const moduleName = resolveModuleName(operation.serviceUrl);
    const moduleSourceText = moduleSources.get(moduleName);
    if (!moduleSourceText) return;
    const keyNames = (operation.inputs || []).map((i) => i.name).filter((n) => !!n);
    const candidates = [
      ...deriveGetByKeyCandidates(moduleSourceText, operation.containerEntityName, operation.name ?? ""),
      ...deriveWriteCandidates(operation.containerEntityName, operation.name ?? "")
    ];
    let overload = null;
    for (const candidate of candidates) {
      const found = findBestMatchingOverload(moduleSourceText, candidate, keyNames);
      if (found) {
        overload = found;
        break;
      }
    }
    if (!overload) return;
    const positionalParams = overload.params.filter((p) => p.name !== "headers");
    const inputs = operation.inputs || [];
    positionalParams.forEach((param, i) => {
      const input = inputs[i];
      if (!input) return;
      const recordFields = findRecordTypeFields(moduleSourceText, param.type);
      if (recordFields) {
        (input.children || []).forEach((c) => {
          if (c.mode !== "VariableMapping" && c.mode !== "IteratorMapping") return;
          const dotted2 = dottedKeyOf(c.mappingExpression);
          const declared = recordFields.find((f) => f.name === c.name);
          if (!dotted2 || !declared) return;
          const { kind: kind2 } = classifyFlowType(declared.type);
          if (kind2 === "text" || kind2 === "number" || kind2 === "boolean") recordFieldKindEvidence(result, disagreed, dotted2, kind2);
        });
        return;
      }
      const singleChild = input.mode === "CustomRecordMapping" && input.children.length === 1 ? input.children[0] : null;
      const scalarInput = singleChild ?? input;
      if (scalarInput.mode !== "VariableMapping" && scalarInput.mode !== "IteratorMapping") return;
      const dotted = dottedKeyOf(scalarInput.mappingExpression);
      if (!dotted) return;
      const { kind } = classifyFlowType(param.type);
      if (kind === "text" || kind === "number" || kind === "boolean") recordFieldKindEvidence(result, disagreed, dotted, kind);
    });
  });
  return result;
}
function collectDeclaredVariableNames(items) {
  const names = /* @__PURE__ */ new Set();
  const walk = (node) => {
    if (!node) return;
    if ((node.localName === "TargetVariable" || node.localName === "TargetVariableName" || node.localName === "Target") && node.text && node.text.trim()) {
      names.add(node.text.trim());
    }
    node.children.forEach(walk);
  };
  items.forEach((item) => walk(item.tagNode));
  return names;
}
function collectScriptBodyFieldKindEvidence(items, paramNames) {
  const result = /* @__PURE__ */ new Map();
  const disagreed = /* @__PURE__ */ new Set();
  items.forEach((item) => {
    if (item.stepType !== "ScriptTaskItem") return;
    const script = childText(item.tagNode, "Script");
    if (!script) return;
    inferDottedFieldKindsFromScriptUsage(script, paramNames).forEach((kind, dotted) => recordFieldKindEvidence(result, disagreed, dotted, kind));
  });
  return result;
}
function inferStartParameterTypes(entries, operationConfigs, scriptFieldKinds) {
  const refs = [];
  (operationConfigs ? [...operationConfigs.values()] : []).forEach((op) => {
    if (op && "whereClause" in op && op.whereClause) collectWhereClauseTypedRefs(op.whereClause, refs);
    if (op && "inputs" in op && op.inputs) collectOperationInputTypedRefs(op.inputs, op.inputsMetadata, refs);
  });
  const result = /* @__PURE__ */ new Map();
  entries.forEach(({ name, fields }) => {
    if (fields) {
      const columnTypes = /* @__PURE__ */ new Map();
      fields.forEach((field) => {
        if (field.fields) return;
        const dotted = `${name}.${field.name}`;
        const matches2 = refs.filter((r) => r.expression === dotted);
        const uniqueTypes2 = new Set(matches2.map((m) => inferFlowScriptType(m.dotNetTypeName)).filter((t) => !!t));
        const scriptKind = scriptFieldKinds ? scriptFieldKinds.get(dotted) : null;
        if (scriptKind) uniqueTypes2.add(scriptKind);
        if (uniqueTypes2.size === 1) columnTypes.set(field.name, [...uniqueTypes2][0]);
      });
      result.set(name, { type: null, isComplex: true, columnTypes });
      return;
    }
    const matches = refs.filter((r) => r.expression === name);
    const isComplex = matches.some((m) => m.isComplex);
    const uniqueTypes = new Set(matches.map((m) => inferFlowScriptType(m.dotNetTypeName)).filter((t) => !!t));
    result.set(name, { type: uniqueTypes.size === 1 ? [...uniqueTypes][0] : null, isComplex, columnTypes: null });
  });
  return result;
}
function buildStartParametersExpression(entries, inferenceByName) {
  if (!entries || entries.length === 0) return null;
  const fields = entries.map(({ name, fields: entryFields, isTable }) => {
    const info = inferenceByName ? inferenceByName.get(name) : null;
    if (entryFields) {
      const lookupType = (fieldName) => info && info.columnTypes ? info.columnTypes.get(fieldName) : null;
      const fieldsText = buildSchemaFieldsText(entryFields, lookupType, "        ");
      return `    ${name}: {
${fieldsText}
    }${isTable ? "*" : ""}`;
    }
    if (info && info.type) return `    ${name}: ${info.type}`;
    if (info && info.isComplex) return `    ${name}`;
    return `    ${name}: primitive`;
  });
  return `{
${fields.join(",\n")}
}`;
}
function buildBareStartParametersExpression(entries) {
  if (!entries || entries.length === 0) return null;
  return `{
${entries.map((e) => `    ${e.name}`).join(",\n")}
}`;
}
function nonNullableTextVarsFromStartParams(startParamEntries, startParamTypes) {
  const names = startParamEntries.filter((e) => e.fields === null).map((e) => e.name).filter((name) => startParamTypes.get(name)?.type === "text");
  return new Set(names);
}
function nullableBooleanVarsFromSchema(variableSchemas) {
  const names = /* @__PURE__ */ new Set();
  variableSchemas.forEach((rowSchema, varName) => {
    rowSchema.forEach((fieldType, fieldName) => {
      if (fieldType.kind === "boolean" && fieldType.optional === true) names.add(`${varName}.${fieldName}`);
    });
  });
  return names;
}
function booleanVarsFromSchema(variableSchemas) {
  const names = /* @__PURE__ */ new Set();
  variableSchemas.forEach((rowSchema, varName) => {
    rowSchema.forEach((fieldType, fieldName) => {
      if (fieldType.kind === "boolean") names.add(`${varName}.${fieldName}`);
    });
  });
  return names;
}
function emitDecisionTaskItem(data, item, fromStepId, userId, outgoing, pendingDecisionRoutes, incomingJoints, nonNullableTextVars, dataFromStepIds, nullableBooleanVars, recordPopulatedVars, booleanVars, schemaLookup, declaredVariableNames) {
  const decodedOutArrows = outgoing.get(item.id) || [];
  // Decision conditions cannot open modules, so a condition that needs the Seq module (any, filter,
  // count over a sequence ...) is computed in a script step in front of the decision and the route
  // just reads the result (classicStep_<id>_cond.c<n>).
  const seqConditions = [];
  const condVar = `classicStep_${item.id}_cond`;
  const decodedRoutes = decodedOutArrows.map((arrow) => {
    const rc = arrow.tagKind === "FlowRuleCollection" && arrow.tagNode ? decodeRuleCollection(arrow.tagNode, nonNullableTextVars, nullableBooleanVars, recordPopulatedVars, booleanVars, schemaLookup, declaredVariableNames) : { relation: "All", rules: [] };
    return {
      label: arrow.text || "Route",
      relation: rc.relation === "Any" ? "any" : "all",
      conditions: rc.rules.map((r) => {
        if (!("lowcode" in r && r.lowcode) && usesSeqModule(r.flowScript)) {
          const field = `c${seqConditions.length}`;
          seqConditions.push(`${field}: ${r.flowScript}`);
          return { expression: `${condVar}.${field}` };
        }
        return toConnectCondition(r);
      }),
      toStep: null,
      // patched in the second pass, see file header
      // This route's own real Classic arrow's routing.
      joints: toConnectJoints(arrow.joints)
    };
  });
  const zipped = decodedRoutes.map((route, i) => ({ route, arrow: decodedOutArrows[i] }));
  const guarded = zipped.filter((z) => (z.route.conditions ?? []).length > 0);
  const unguarded = zipped.filter((z) => (z.route.conditions ?? []).length === 0);
  const reordered = [...guarded, ...unguarded];
  const routes = reordered.map((z) => z.route);
  const outArrows = reordered.map((z) => z.arrow);
  const decisionLocation = toConnectLocation(item.location) ?? void 0;
  let result;
  let bundleExpansion;
  if (seqConditions.length > 0) {
    const script = `open Seq;\nreturn { ${seqConditions.join(", ")} };`;
    const scriptResult = addScriptStep(data, script, condVar, null, "", userId, "", "", fromStepId, decisionLocation, incomingJoints, dataFromStepIds);
    const followLocation = decisionLocation ? { x: decisionLocation.x + BUNDLE_FOLLOW_UP_OFFSET, y: decisionLocation.y } : void 0;
    result = addDecisionStep(scriptResult.data, routes, item.label || "Decision", userId, scriptResult.stepId, followLocation);
    if (decisionLocation) bundleExpansion = { x: decisionLocation.x, y: decisionLocation.y, width: BUNDLE_FOLLOW_UP_OFFSET + BUNDLE_DOWNSTREAM_CLEARANCE, stepIds: [scriptResult.stepId, result.stepId] };
  } else {
    result = addDecisionStep(data, routes, item.label || "Decision", userId, fromStepId, decisionLocation, incomingJoints, dataFromStepIds);
  }
  const decisionStep = result.data.find((d) => "id" in d && d.id === result.stepId);
  decisionStep.configuration.routes.forEach((route, i) => {
    pendingDecisionRoutes.push({ arrowId: route.arrowId, decisionStepId: result.stepId, routeIndex: i, targetClassicId: outArrows[i].targetItemId, sourceClassicId: item.id });
  });
  return bundleExpansion ? { ...result, bundleExpansion } : result;
}
function buildGridColumnConfiguration(c) {
  switch (c.columnType) {
    case "checkbox":
      return { type: "checkbox", isEditable: c.isEditable, defaultValueExpr: c.defaultValueExpr, onlyEditableForNewRows: c.onlyEditableForNewRows, mergeBehavior: "keepMyChanges", title: c.title, sizeMode: c.sizeMode, size: c.size, cellColorExpr: "" };
    case "value-list":
      return { type: "value-list", sourceExpr: c.sourceExpr, itemTextExpr: c.itemTextExpr, itemValueExpr: c.itemValueExpr, selectValueOnly: c.selectValueOnly, onlyEditableForNewRows: c.onlyEditableForNewRows, matchWhenScanningBarcode: c.matchWhenScanningBarcode, mergeBehavior: "keepMyChanges", title: c.title, sizeMode: c.sizeMode, size: c.size, cellColorExpr: "" };
    case "computed":
      return { type: "computed", valueExpr: c.valueExpr, hidden: c.hidden, matchWhenScanningBarcode: c.matchWhenScanningBarcode, title: c.title, sizeMode: c.sizeMode, size: c.size, cellColorExpr: "" };
    case "numeric":
      return { type: "numeric", isEditable: c.isEditable, defaultValueExpr: c.defaultValueExpr, onlyEditableForNewRows: c.onlyEditableForNewRows, mergeBehavior: "keepMyChanges", formatString: c.formatString, hidden: c.hidden, matchWhenScanningBarcode: c.matchWhenScanningBarcode, title: c.title, sizeMode: c.sizeMode, size: c.size, cellColorExpr: "" };
    case "text":
      return { type: "text", isEditable: c.isEditable, defaultValueExpr: c.defaultValueExpr, onlyEditableForNewRows: c.onlyEditableForNewRows, mergeBehavior: "keepMyChanges", hidden: c.hidden, matchWhenScanningBarcode: c.matchWhenScanningBarcode, title: c.title, sizeMode: c.sizeMode, size: c.size, cellColorExpr: "" };
  }
}
function toRealUserControl(decoded) {
  const id = newGuid();
  switch (decoded.kind) {
    case "text-input":
      return { type: "text-input", targetVariableName: decoded.targetVariableName, label: decoded.label, defaultText: decoded.defaultText, multiline: decoded.multiline, allowEmpty: decoded.allowEmpty, forceUppercase: decoded.forceUppercase, enableCorrection: decoded.enableCorrection, autoTrim: decoded.autoTrim, passwordMask: decoded.passwordMask, keyboardType: decoded.keyboardType, mergeBehavior: "keepMyChanges", id, hideIfExpr: decoded.hideIfExpr };
    case "numeric-input":
    case "date-input":
    case "time-input":
      return { type: decoded.kind, targetVariableName: decoded.targetVariableName, label: decoded.label, defaultValue: decoded.defaultValue, allowEmpty: decoded.allowEmpty, mergeBehavior: "keepMyChanges", id, hideIfExpr: decoded.hideIfExpr };
    case "list-selection":
      return { type: "list-selection", targetVariableName: decoded.targetVariableName, source: { type: "variable", path: decoded.sourcePath }, label: decoded.label, largeRowText: decoded.largeRowText, smallRowText: decoded.smallRowText, imageExpr: "", itemStyleExpr: decoded.itemStyleExpr, groupByMember: decoded.groupByMember, defaultSelectionExpr: decoded.defaultSelectionExpr, resultTransformationExpr: decoded.resultTransformationExpr, allowEmpty: decoded.allowEmpty, inline: "auto", showAutomatically: false, barcodeMatchStrategy: "rowText", barcodeMatchColumns: [], mergeBehavior: "keepMyChanges", id, hideIfExpr: decoded.hideIfExpr };
    case "multi-list-selection":
      return { type: "multi-list-selection", targetVariableName: decoded.targetVariableName, source: { type: "variable", path: decoded.sourcePath }, defaultSelectionExpression: decoded.defaultSelectionExpression, label: decoded.label, largeRowText: decoded.largeRowText, smallRowText: decoded.smallRowText, imageExpr: "", itemStyleExpr: decoded.itemStyleExpr, groupByMember: decoded.groupByMember, inline: "auto", showAutomatically: false, mergeBehavior: "keepMyChanges", id, hideIfExpr: decoded.hideIfExpr };
    case "header":
    case "static-text":
      return { type: decoded.kind, text: decoded.text, fontSizing: "medium", textAlignment: "left", isBold: false, isItalic: false, isUnderline: false, id, hideIfExpr: decoded.hideIfExpr };
    case "labelled-static-text":
      return { type: "labelled-static-text", label: decoded.label, text: decoded.text, useLargeFont: decoded.useLargeFont, id, hideIfExpr: decoded.hideIfExpr };
    case "list-presentation":
      return { type: "list-presentation", source: { type: "variable", path: decoded.sourcePath }, largeText: decoded.largeText, smallText: decoded.smallText, hyperlinkTemplate: decoded.hyperlinkTemplate, itemStyleExpr: decoded.itemStyleExpr, groupByMember: decoded.groupByMember, imageExpr: "", label: decoded.label, id, hideIfExpr: decoded.hideIfExpr };
    case "checkbox":
      return { type: "checkbox", targetVariableName: decoded.targetVariableName, label: decoded.label, defaultValue: decoded.defaultValue, mustBeChecked: decoded.mustBeChecked, mergeBehavior: "keepMyChanges", id, hideIfExpr: decoded.hideIfExpr };
    case "binary-option":
      return { type: "binary-option", targetVariableName: decoded.targetVariableName, defaultValue: decoded.defaultValue, refuseNegativeAnswer: decoded.refuseNegativeAnswer, option1Text: decoded.option1Text, option2Text: decoded.option2Text, option1Value: decoded.option1Value, option2Value: decoded.option2Value, mergeBehavior: "keepMyChanges", id, hideIfExpr: decoded.hideIfExpr };
    case "menu-selection":
      return { type: "menu-selection", targetVariableName: decoded.targetVariableName, source: { type: "variable", path: decoded.sourcePath }, label: decoded.label, defaultValue: decoded.defaultValue, rowText: decoded.rowText, keyFieldId: decoded.keyFieldId, hasEmptyOption: decoded.hasEmptyOption, emptyOptionText: decoded.emptyOptionText, allowEmptyOption: decoded.allowEmptyOption, mergeBehavior: "keepMyChanges", id, hideIfExpr: decoded.hideIfExpr };
    case "signature":
      return { type: "signature", targetVariableName: decoded.targetVariableName, label: decoded.label, mergeBehavior: "keepMyChanges", id, hideIfExpr: decoded.hideIfExpr };
    case "file-gallery":
      return { type: "file-gallery", targetVariableName: decoded.targetVariableName, label: decoded.label, source: { type: "variable", path: decoded.sourcePath }, groupByMember: "", showAutomatically: decoded.showAutomatically, mode: decoded.mode, imageSize: decoded.imageSize, allowedUploadFileSuffixes: null, mergeBehavior: "keepMyChanges", id, hideIfExpr: decoded.hideIfExpr };
    case "single-item":
      return { type: "single-item", targetVariableName: decoded.targetVariableName, subworkflowId: decoded.subworkflowId, label: decoded.label, iconString: decoded.iconString, badges: decoded.badges, allowMultipleInvokes: decoded.allowMultipleInvokes, mergeBehavior: "keepMyChanges", id, hideIfExpr: decoded.hideIfExpr };
    case "grid":
      return {
        type: "grid",
        targetVariableName: decoded.targetVariableName,
        label: decoded.label,
        sourcePath: decoded.sourcePath,
        allowAdd: decoded.allowAdd,
        allowDelete: decoded.allowDelete,
        useChangeTracking: decoded.useChangeTracking,
        mergeBehavior: "keepMyChanges",
        rowStyleExpr: decoded.rowStyleExpr,
        rowHeight: decoded.rowHeight,
        selectionMode: decoded.selectionMode,
        columns: decoded.columns.map((c) => ({
          id: newGuid(),
          outputName: c.outputName,
          includeInOutput: c.includeInOutput,
          sourceColumn: c.sourceColumn,
          configuration: buildGridColumnConfiguration(c)
        })),
        uniqueIdColumn: "",
        id,
        hideIfExpr: decoded.hideIfExpr
      };
    case "unmapped":
      return null;
  }
}
function emitCheckpointItem(data, item, fromStepId, userId, warnings, incomingJoints, dataFromStepIds, flowDefaultLangCode, phrasebook) {
  const stepWarnings = [];
  const langCtx = phrasebook ? { phrasebook } : void 0;
  const title = item.tagNode ? decodeLanguageText(item.tagNode, "Title", null, flowDefaultLangCode ?? null, stepWarnings, langCtx) || "" : "";
  const text = item.tagNode ? decodeLanguageText(item.tagNode, "Text", null, flowDefaultLangCode ?? null, stepWarnings, langCtx) || "" : "";
  for (const w of stepWarnings) warnings.push(`CheckpointItem ${item.id} (${item.label || ""}): ${w}`);
  const result = addCheckpointStep(data, title, text, userId, fromStepId, toConnectLocation(item.location) ?? void 0, incomingJoints, dataFromStepIds);
  if (item.label) {
    const patched = result.data.map((d) => d.type === "step-created" && d.id === result.stepId ? { ...d, label: item.label } : d);
    return { data: patched, stepId: result.stepId };
  }
  return result;
}
function emitTableItem(data, item, fromStepId, userId, warnings, incomingJoints) {
  const table = decodeTableCreation(item.tagNode);
  if (table.columns.length === 0 && item.tagNode && findChild(item.tagNode, "Data")) {
    warnings.push(`TableItem ${item.id} (${item.label || ""}): decoded with no columns -- emitted as an empty table (verify the original wasn't carrying data in an unrecognized shape)`);
  }
  return addTableStep(
    data,
    { targetVariableName: table.target || `classicTable_${item.id}`, columns: table.columns, rows: table.rows },
    item.label || table.target || "Table",
    userId,
    fromStepId,
    toConnectLocation(item.location) ?? void 0,
    incomingJoints
  );
}
function emitUserTaskItem(data, item, fromStepId, userId, outgoing, pendingUserStepButtons, warnings, incomingJoints, dataFromStepIds, schemaLookup, flowDefaultLangCode, subworkflowIds, declaredVariableNames, phrasebook) {
  if (!item.tagNode) {
    warnings.push(`UserTaskItem ${item.id} has no UserInstructionCollection Tag -- emitting as unresolved`);
    const script = `return UNRESOLVED_MIGRATION_UnhandledStepType_${item.id}();`;
    return addScriptStep(data, script, `classicStep_${item.id}`, null, "", userId, "", "", fromStepId, toConnectLocation(item.location) ?? void 0, incomingJoints, dataFromStepIds);
  }
  const stepWarnings = [];
  const lang = flowDefaultLangCode ?? null;
  const translateCtx = schemaLookup || subworkflowIds || declaredVariableNames || phrasebook ? { schemaLookup: schemaLookup ?? void 0, subworkflowIds: subworkflowIds ?? void 0, protectedNames: declaredVariableNames ?? void 0, phrasebook } : void 0;
  const decoded = decodeUserStep(item.tagNode, lang, stepWarnings, translateCtx);
  decoded.controls.forEach((c) => {
    if (c.kind === "unmapped") stepWarnings.push(c.description);
  });
  if (decoded.stepConfig.allowAutoForward && decoded.stepConfig.autoForwardDelay !== "Instant") {
    stepWarnings.push(`Classic auto-forward settings (delay '${decoded.stepConfig.autoForwardDelay}') are not migrated -- the user step auto-forwards instantly, review manually`);
  }
  const realControls = decoded.controls.map(toRealUserControl).filter((c) => c !== null);
  const newIndexByOldIndex = /* @__PURE__ */ new Map();
  decoded.controls.forEach((c, i) => {
    if (c.kind !== "unmapped") newIndexByOldIndex.set(i, newIndexByOldIndex.size);
  });
  const positionsForRealControls = decoded.layout.map((row) => row.map((oldIndex) => newIndexByOldIndex.get(oldIndex)).filter((n) => n !== void 0)).filter((row) => row.length > 0);
  const decodedOutArrows = outgoing.get(item.id) || [];
  const zipped = decodedOutArrows.map((arrow) => {
    const decodedButton = arrow.tagKind === "UserStepExitConfiguration" && arrow.tagNode ? decodeUserStepButton(arrow.tagNode, lang, stepWarnings, translateCtx) : { label: arrow.text || "Next", isPrimary: false, isAlwaysEnabled: false, availableIf: "", priority: 0 };
    return { decoded: decodedButton, arrow };
  });
  zipped.sort((a, b) => a.decoded.priority - b.decoded.priority);
  const buttonInputs = zipped.map((z) => ({
    label: z.decoded.label,
    isPrimary: z.decoded.isPrimary,
    isAlwaysEnabled: z.decoded.isAlwaysEnabled,
    availableIf: z.decoded.availableIf,
    toStep: ""
    // patched in the second pass, via pendingUserStepButtons/applyPendingUserStepButtons
  }));
  const result = addUserTaskStep(
    data,
    realControls,
    positionsForRealControls,
    {
      allowReloading: decoded.stepConfig.allowReloading,
      isPinned: decoded.stepConfig.isPinned,
      backgroundColorIndex: decoded.stepConfig.backgroundColorIndex,
      preventUserBack: decoded.stepConfig.preventUserBack,
      allowAutoForward: decoded.stepConfig.allowAutoForward,
      autoForwardDelay: "instant",
      autoForwardCondition: ""
    },
    buttonInputs,
    item.label || "User Step",
    userId,
    fromStepId,
    toConnectLocation(item.location) ?? void 0,
    incomingJoints,
    dataFromStepIds
  );
  for (const w of stepWarnings) warnings.push(`UserTaskItem ${item.id} (${item.label || ""}): ${w}`);
  zipped.forEach((z, i) => {
    pendingUserStepButtons.push({ arrowId: result.buttonArrowIds[i], userStepId: result.stepId, targetClassicId: z.arrow.targetItemId, sourceClassicId: item.id });
  });
  return { data: result.data, stepId: result.stepId };
}
function applyPendingDataEdges(data, pendingDataEdges, classicToConnect, warnings) {
  let result = data;
  pendingDataEdges.forEach((p) => {
    const fromStep = classicToConnect.get(p.sourceItemId);
    const toStep = classicToConnect.get(p.targetItemId);
    if (!fromStep || !toStep) {
      warnings.push(`Could not resolve a Data arrow from Classic item ${p.sourceItemId} to ${p.targetItemId}`);
      return;
    }
    result = connectIncoming(result, toStep, void 0, void 0, [fromStep]);
  });
  return result;
}
function applyPendingBackEdges(data, pendingBackEdges, classicToConnect, warnings, bundleEntryStepId) {
  let result = data;
  pendingBackEdges.forEach((p) => {
    const fromStep = classicToConnect.get(p.sourceItemId);
    const toStep = p.targetItemId && bundleEntryStepId.get(p.targetItemId) || classicToConnect.get(p.targetItemId);
    if (!fromStep || !toStep) {
      warnings.push(`Could not resolve a loop-back arrow from Classic item ${p.sourceItemId} to ${p.targetItemId}`);
      return;
    }
    result = connectIncoming(result, toStep, fromStep);
  });
  return result;
}
function resolvePendingArrowTargets(pending, classicToConnect, warnings, reachableFromStart, bundleEntryStepId, warnLabel) {
  const targetByArrowId = /* @__PURE__ */ new Map();
  const droppedArrowIds = /* @__PURE__ */ new Set();
  pending.forEach((p) => {
    const sourceIsDead = !reachableFromStart.has(p.sourceClassicId);
    const targetIsLive = reachableFromStart.has(p.targetClassicId);
    if (sourceIsDead && targetIsLive) {
      droppedArrowIds.add(p.arrowId);
      return;
    }
    const targetConnectId = p.targetClassicId && bundleEntryStepId.get(p.targetClassicId) || classicToConnect.get(p.targetClassicId) || null;
    if (!targetConnectId) {
      warnings.push(`${warnLabel} from step ${p.sourceStepId} could not resolve its target (Classic item ${p.targetClassicId})`);
    }
    targetByArrowId.set(p.arrowId, targetConnectId);
  });
  return { targetByArrowId, droppedArrowIds };
}
function applyPendingDecisionRoutes(data, pendingDecisionRoutes, classicToConnect, warnings, reachableFromStart, bundleEntryStepId) {
  const { targetByArrowId, droppedArrowIds } = resolvePendingArrowTargets(
    pendingDecisionRoutes.map((p) => ({ arrowId: p.arrowId, sourceStepId: p.decisionStepId, sourceClassicId: p.sourceClassicId, targetClassicId: p.targetClassicId })),
    classicToConnect,
    warnings,
    reachableFromStart,
    bundleEntryStepId,
    "Decision route"
  );
  const routeIndexByDecisionStep = /* @__PURE__ */ new Map();
  const droppedRouteIndicesByDecisionStep = /* @__PURE__ */ new Map();
  pendingDecisionRoutes.forEach((p) => {
    if (droppedArrowIds.has(p.arrowId)) {
      if (!droppedRouteIndicesByDecisionStep.has(p.decisionStepId)) droppedRouteIndicesByDecisionStep.set(p.decisionStepId, /* @__PURE__ */ new Set());
      droppedRouteIndicesByDecisionStep.get(p.decisionStepId).add(p.routeIndex);
      return;
    }
    if (!routeIndexByDecisionStep.has(p.decisionStepId)) routeIndexByDecisionStep.set(p.decisionStepId, /* @__PURE__ */ new Map());
    routeIndexByDecisionStep.get(p.decisionStepId).set(p.routeIndex, targetByArrowId.get(p.arrowId) ?? null);
  });
  const decisionRouteArrowIds = new Set(pendingDecisionRoutes.map((p) => p.arrowId));
  const reordered = [];
  const movedArrows = [];
  data.forEach((d) => {
    if (d.type === "arrow-created" && droppedArrowIds.has(d.id)) return;
    if (d.type === "arrow-created" && targetByArrowId.has(d.id)) {
      const patched = { ...d, toStep: targetByArrowId.get(d.id) };
      if (decisionRouteArrowIds.has(d.id)) {
        movedArrows.push(patched);
      } else {
        reordered.push(patched);
      }
      return;
    }
    if (d.type === "step-created" && d.stepType === "decision" && (routeIndexByDecisionStep.has(d.id) || droppedRouteIndicesByDecisionStep.has(d.id))) {
      const patches = routeIndexByDecisionStep.get(d.id) || /* @__PURE__ */ new Map();
      const droppedIndices = droppedRouteIndicesByDecisionStep.get(d.id) || /* @__PURE__ */ new Set();
      const decisionStep = d;
      reordered.push({
        ...decisionStep,
        configuration: {
          ...decisionStep.configuration,
          routes: decisionStep.configuration.routes.map((route, i) => patches.has(i) ? { ...route, toStep: patches.get(i) } : route).filter((_route, i) => !droppedIndices.has(i))
        }
      });
      return;
    }
    reordered.push(d);
  });
  return [...reordered, ...movedArrows];
}
function applyPendingUserStepButtons(data, pendingButtons, classicToConnect, warnings, reachableFromStart, bundleEntryStepId) {
  const { targetByArrowId, droppedArrowIds } = resolvePendingArrowTargets(
    pendingButtons.map((p) => ({ arrowId: p.arrowId, sourceStepId: p.userStepId, sourceClassicId: p.sourceClassicId, targetClassicId: p.targetClassicId })),
    classicToConnect,
    warnings,
    reachableFromStart,
    bundleEntryStepId,
    "User-step button"
  );
  const droppedArrowIdsByUserStep = /* @__PURE__ */ new Map();
  pendingButtons.forEach((p) => {
    if (!droppedArrowIds.has(p.arrowId)) return;
    if (!droppedArrowIdsByUserStep.has(p.userStepId)) droppedArrowIdsByUserStep.set(p.userStepId, /* @__PURE__ */ new Set());
    droppedArrowIdsByUserStep.get(p.userStepId).add(p.arrowId);
  });
  const patchedArrowIds = new Set(pendingButtons.map((p) => p.arrowId));
  const reordered = [];
  const movedArrows = [];
  data.forEach((d) => {
    if (d.type === "arrow-created" && droppedArrowIds.has(d.id)) return;
    if (d.type === "arrow-created" && targetByArrowId.has(d.id)) {
      const patched = { ...d, toStep: targetByArrowId.get(d.id) };
      if (patchedArrowIds.has(d.id)) {
        movedArrows.push(patched);
      } else {
        reordered.push(patched);
      }
      return;
    }
    if (d.type === "step-created" && d.stepType === "user" && droppedArrowIdsByUserStep.has(d.id)) {
      const dropped = droppedArrowIdsByUserStep.get(d.id);
      const userStep = d;
      reordered.push({
        ...userStep,
        configuration: {
          ...userStep.configuration,
          buttons: userStep.configuration.buttons.filter((b) => !dropped.has(b.arrowId))
        }
      });
      return;
    }
    reordered.push(d);
  });
  return [...reordered, ...movedArrows];
}
function stepKindOwnsDeferredOutgoingArrows(stepType) {
  return stepType === "DecisionTaskItem" || stepType === "UserTaskItem";
}
function predecessorInfoFor(itemId, incoming, itemsById, classicToConnect, dataDependencyEdges, pendingBackEdges, reachableFromStart, pendingDataEdges) {
  const targetIsReachable = reachableFromStart.has(itemId);
  const arrows = (incoming.get(itemId) || []).filter((a) => !(targetIsReachable && !reachableFromStart.has(a.sinkItemId)));
  const connectIds = [];
  const joints = [];
  arrows.forEach((a) => {
    const sourceItem = itemsById.get(a.sinkItemId);
    if (sourceItem && stepKindOwnsDeferredOutgoingArrows(sourceItem.stepType)) return;
    const connectId = classicToConnect.get(a.sinkItemId);
    if (connectId !== void 0 && connectId !== null) {
      connectIds.push(connectId);
      joints.push(a.joints || []);
    } else {
      pendingBackEdges.push({ sourceItemId: a.sinkItemId, targetItemId: itemId });
    }
  });
  const dataConnectIds = [];
  const dataSourceItemIds = dataDependencyEdges.get(itemId) || [];
  dataSourceItemIds.forEach((sourceItemId) => {
    const connectId = classicToConnect.get(sourceItemId);
    if (connectId !== void 0 && connectId !== null && !connectIds.includes(connectId) && !dataConnectIds.includes(connectId)) {
      dataConnectIds.push(connectId);
    } else if (connectId === void 0) {
      pendingDataEdges.push({ sourceItemId, targetItemId: itemId });
    }
  });
  const hasAnyPredecessor = arrows.length > 0 || connectIds.length > 0 || dataConnectIds.length > 0 || dataSourceItemIds.length > 0;
  return { nonDecisionConnectIds: connectIds, nonDecisionJoints: joints, dataConnectIds, hasAnyPredecessor };
}
function emitSubworkflowItem(data, item, options, subworkflowDepth, modulesAdded, warnings, componentAssetsUsed, flowDefaultLangCode, subworkflowIds) {
  const subId = item.tagNode ? childText(item.tagNode, "SubworkflowIdentifier") : null;
  const subGraph = item.tagNode ? decodeSubworkflowItems(item.tagNode) : null;
  if (!subId || !subGraph) {
    warnings.push(`SubworkflowItem ${item.id} (${item.label || ""}) carries no decodable inner graph \u2014 skipped`);
    return { data };
  }
  if (data.some((ev) => ev.type === "subworkflow-created" && ev.id === subId)) {
    warnings.push(`SubworkflowItem ${item.id} (${item.label || ""}) references SubworkflowIdentifier ${subId}, already emitted by another SubworkflowItem in this flow -- skipped (duplicate)`);
    return { data };
  }
  if (subworkflowDepth >= 5) {
    warnings.push(`SubworkflowItem ${item.id} (${item.label || ""}) exceeds the nesting-depth guard (5) \u2014 skipped`);
    return { data };
  }
  const subInitial = subGraph.items.find((it) => it.stepType === "InitialStepItem");
  const subSchema = subInitial && subInitial.tagNode ? childText(findChild(subInitial.tagNode, "StartParameters"), "Schema") : null;
  const subHeader = {
    id: null,
    versionId: null,
    languageCodes: [],
    defaultLanguageCode: flowDefaultLangCode,
    startParametersSchema: subSchema,
    workflowOutputType: null,
    outputVariableNames: [],
    outputVariableSchema: null,
    propertiesType: null
  };
  const subResult = emitConnectStepsImpl(
    { items: subGraph.items, arrows: subGraph.arrows, annotations: subGraph.annotations, header: subHeader },
    {
      ...options,
      subworkflowDepth: subworkflowDepth + 1,
      subworkflowIds,
      operationConfigs: narrowItemKeyedMapForSubworkflow(options.operationConfigs, item.id),
      componentResultTypesByStep: narrowItemKeyedMapForSubworkflow(options.componentResultTypesByStep, item.id)
    }
  );
  subResult.warnings.forEach((w) => warnings.push(`Subworkflow "${item.label || subId}": ${w}`));
  subResult.componentAssetsUsed.forEach((a) => componentAssetsUsed.push(a));
  const batchEvents = [];
  let newData = data;
  subResult.data.forEach((ev) => {
    if (ev.type === "module-added") {
      if (!modulesAdded.has(ev.name)) {
        modulesAdded.add(ev.name);
        newData = addModule(newData, ev.name, ev.moduleId);
      }
      return;
    }
    batchEvents.push(ev);
  });
  newData = newData.concat([
    { type: "subworkflow-created", id: subId },
    { type: "subworkflow-changed", id: subId, event: { type: "batch", events: batchEvents } }
  ]);
  return { data: newData };
}
function emitConnectSteps(classicFlow, options) {
  beginDeterministicIds();
  try {
    return emitConnectStepsImpl(classicFlow, options);
  } finally {
    endDeterministicIds();
  }
}
function emitConnectStepsImpl(classicFlow, options) {
  const ownsPhrasebook = !options.phrasebook;
  if (ownsPhrasebook) options = { ...options, phrasebook: createPhrasebook(classicFlow.header?.defaultLanguageCode) };
  const items = classicFlow.items || [];
  const arrows = classicFlow.arrows || [];
  const annotations = classicFlow.annotations || [];
  const userId = options.userId;
  const connector = options.connector || null;
  const operationConfigs = options.operationConfigs || /* @__PURE__ */ new Map();
  const moduleSources = options.moduleSources || /* @__PURE__ */ new Map();
  const moduleAssetIds = options.moduleAssetIds || /* @__PURE__ */ new Map();
  const includedWorkflows = options.includedWorkflows || /* @__PURE__ */ new Map();
  const restResolutions = options.restResolutions || /* @__PURE__ */ new Map();
  const resolveModuleName = options.moduleNameForServiceUrl || ((url) => extractSvcName(url) || "UnknownModule");
  const subworkflowIds = options.subworkflowIds ?? new Set(
    collectAllItems(items).filter((it) => it.stepType === "SubworkflowItem" && it.tagNode).map((it) => childText(it.tagNode, "SubworkflowIdentifier")).filter((id) => !!id)
  );
  const subworkflowDepth = options.subworkflowDepth || 0;
  const { outgoing, incoming } = buildControlFlowGraph(items, arrows);
  const { order, forcedEntries } = topologicalOrder(items, outgoing, incoming);
  const itemsById = new Map(items.map((it) => [it.id, it]));
  const dataDependencyEdges = collectDataDependencyEdges(items, arrows);
  const initialStepItem = items.find((it) => it.stepType === "InitialStepItem");
  const reachableFromStart = computeReachableFromStart(initialStepItem ? initialStepItem.id : null, outgoing);
  const startParamEntries = parseSchemaEntries(classicFlow.header && classicFlow.header.startParametersSchema);
  const startParamNames = new Set(startParamEntries.map((e) => e.name));
  const scriptFieldKinds = /* @__PURE__ */ new Map();
  const scriptFieldKindsDisagreed = /* @__PURE__ */ new Set();
  collectScriptBodyFieldKindEvidence(items, startParamNames).forEach((kind, dotted) => recordFieldKindEvidence(scriptFieldKinds, scriptFieldKindsDisagreed, dotted, kind));
  collectModuleCallFieldKindEvidence(items, operationConfigs, moduleSources, resolveModuleName, startParamNames).forEach((kind, dotted) => recordFieldKindEvidence(scriptFieldKinds, scriptFieldKindsDisagreed, dotted, kind));
  const startParamTypes = inferStartParameterTypes(startParamEntries, operationConfigs, scriptFieldKinds);
  const nonNullableTextVars = nonNullableTextVarsFromStartParams(startParamEntries, startParamTypes);
  const seedTableSource = initialStepItem ? stripPathPrefix(childText(findChild(initialStepItem.tagNode, "SeedTableSourceOrNull"), "Path")) : null;
  const seedTableKey = initialStepItem ? stripPathPrefix(childText(findChild(initialStepItem.tagNode, "SeedTableKeyOrNull"), "Path")) : null;
  const inboxConfig = seedTableSource && seedTableKey ? { sourceTable: seedTableSource, itemKey: seedTableKey } : null;
  const autoStartParamEntries = inboxConfig ? parseSchemaEntries(childText(findChild(initialStepItem.tagNode, "AutoStartParameters"), "Schema")) : null;
  const startParametersExpression = inboxConfig ? buildBareStartParametersExpression(autoStartParamEntries) : buildStartParametersExpression(startParamEntries, startParamTypes);
  const startResult = addStartStep(userId, startParametersExpression, toConnectLocation(initialStepItem && initialStepItem.location) ?? void 0, inboxConfig);
  let data = startResult.data;
  const startStepId = startResult.stepId;
  const classicToConnect = /* @__PURE__ */ new Map();
  items.forEach((it) => {
    if (it.stepType === "InitialStepItem") classicToConnect.set(it.id, startStepId);
  });
  const pendingDecisionRoutes = [];
  const pendingUserStepButtons = [];
  const pendingBackEdges = [];
  const pendingDataEdges = [];
  const modulesAdded = /* @__PURE__ */ new Set();
  const componentAssetsUsed = [];
  const bundleExpansions = [];
  const bundleEntryStepId = /* @__PURE__ */ new Map();
  const warnings = [];
  const selectPopulatedVars = /* @__PURE__ */ new Set();
  const recordPopulatedVars = /* @__PURE__ */ new Set();
  const restCallPopulatedVars = /* @__PURE__ */ new Set();
  const variableSchemas = resolveVariableFieldSchemas(
    items,
    operationConfigs,
    moduleSources,
    resolveModuleName,
    options.componentResultTypesByStep
  );
  const schemaLookup = (key) => variableSchemas.get(key) || null;
  const declaredVariableNames = collectDeclaredVariableNames(items);
  const flowDefaultLangCode = classicFlow.header && classicFlow.header.defaultLanguageCode || null;
  const tableDeclarationTypes = resolveTableDeclarationTypes(items, operationConfigs, moduleSources, resolveModuleName, variableSchemas);
  const nullableBooleanVars = nullableBooleanVarsFromSchema(variableSchemas);
  const booleanVars = booleanVarsFromSchema(variableSchemas);
  const environmentPropertyTableVars = /* @__PURE__ */ new Set();
  items.forEach((it) => {
    if (it.stepType !== "MachineTaskItem" || !it.tagNode) return;
    const op = operationConfigs.get(it.id ?? "");
    if (!op || op.kind !== "methodcall" || !isGetCustomPropertiesOperation(op.connectorTypeName, op.identifier)) return;
    const targetVariableName = childText(it.tagNode, "TargetVariableName");
    if (targetVariableName) environmentPropertyTableVars.add(targetVariableName);
  });
  order.forEach((itemId) => {
    const item = itemsById.get(itemId);
    if (item.stepType === "InitialStepItem") return;
    if (item.stepType === "SubworkflowItem") {
      const subResult = emitSubworkflowItem(data, item, options, subworkflowDepth, modulesAdded, warnings, componentAssetsUsed, flowDefaultLangCode, subworkflowIds);
      data = subResult.data;
      return;
    }
    const { nonDecisionConnectIds, nonDecisionJoints, dataConnectIds, hasAnyPredecessor } = predecessorInfoFor(itemId, incoming, itemsById, classicToConnect, dataDependencyEdges, pendingBackEdges, reachableFromStart, pendingDataEdges);
    let fromStepId;
    if (!hasAnyPredecessor) {
      fromStepId = [];
    } else if (nonDecisionConnectIds.length === 0) {
      fromStepId = [];
    } else {
      fromStepId = nonDecisionConnectIds.length === 1 ? nonDecisionConnectIds[0] : nonDecisionConnectIds;
    }
    const incomingJoints = !Array.isArray(fromStepId) && nonDecisionJoints.length === 1 ? toConnectJoints(nonDecisionJoints[0]) : void 0;
    const dataFromStepIds = dataConnectIds.length > 0 ? dataConnectIds : void 0;
    let result;
    if (item.stepType === "EndItem") {
      result = addEndStep(data, fromStepId, toConnectLocation(item.location) ?? void 0, incomingJoints, dataFromStepIds);
    } else if (item.stepType === "MachineTaskItem") {
      result = emitMachineTaskItem(data, item, fromStepId, connector, userId, operationConfigs, resolveModuleName, modulesAdded, warnings, moduleSources, moduleAssetIds, selectPopulatedVars, recordPopulatedVars, restResolutions, restCallPopulatedVars, incomingJoints, schemaLookup, dataFromStepIds);
    } else if (item.stepType === "AssignmentItem") {
      const assignResult = emitAssignmentItem(data, item, userId, fromStepId, tableDeclarationTypes, incomingJoints, schemaLookup, environmentPropertyTableVars, dataFromStepIds, declaredVariableNames);
      if (assignResult.bundleExpansion) {
        bundleExpansions.push(assignResult.bundleExpansion);
        bundleEntryStepId.set(itemId, assignResult.bundleExpansion.stepIds[0]);
      }
      result = { data: assignResult.data, stepId: assignResult.stepId };
    } else if (item.stepType === "AssertTaskItem") {
      result = emitAssertTaskItem(data, item, userId, fromStepId, incomingJoints, dataFromStepIds, options.phrasebook);
    } else if (item.stepType === "ScriptTaskItem") {
      result = emitScriptTaskItem(data, item, fromStepId, connector, userId, warnings, incomingJoints, schemaLookup, dataFromStepIds, declaredVariableNames);
    } else if (item.stepType === "CheckpointItem") {
      result = emitCheckpointItem(data, item, fromStepId, userId, warnings, incomingJoints, dataFromStepIds, flowDefaultLangCode, options.phrasebook);
    } else if (item.stepType === "TableItem") {
      result = emitTableItem(data, item, fromStepId, userId, warnings, incomingJoints);
    } else if (item.stepType === "SplitTaskItem") {
      result = addSplitStep(data, item.label || "", userId, fromStepId, toConnectLocation(item.location) ?? void 0, incomingJoints);
    } else if (item.stepType === "UserTaskItem") {
      result = emitUserTaskItem(data, item, fromStepId, userId, outgoing, pendingUserStepButtons, warnings, incomingJoints, dataFromStepIds, schemaLookup, flowDefaultLangCode, subworkflowIds, declaredVariableNames, options.phrasebook);
    } else if (item.stepType === "DecisionTaskItem") {
      result = emitDecisionTaskItem(data, item, fromStepId, userId, outgoing, pendingDecisionRoutes, incomingJoints, nonNullableTextVars, dataFromStepIds, nullableBooleanVars, recordPopulatedVars, booleanVars, schemaLookup, declaredVariableNames);
      if (result.bundleExpansion) {
        bundleExpansions.push(result.bundleExpansion);
        bundleEntryStepId.set(itemId, result.bundleExpansion.stepIds[0]);
      }
    } else if (item.stepType === "IncludedWorkflowItem") {
      result = emitIncludedWorkflowItem(data, item, fromStepId, userId, includedWorkflows, componentAssetsUsed, incomingJoints, warnings, dataFromStepIds);
    } else {
      warnings.push(`Unhandled Classic step type '${item.stepType}' (tagKind '${item.tagKind}') for item ${itemId}`);
      const script = `return UNRESOLVED_MIGRATION_UnhandledStepType_${itemId}();`;
      result = addScriptStep(data, script, `classicStep_${itemId}`, connector, "", userId, "", "", fromStepId, toConnectLocation(item.location) ?? void 0, incomingJoints, dataFromStepIds);
    }
    data = withClassicScriptStepLabel(result.data, result.stepId, item.label);
    classicToConnect.set(itemId, result.stepId);
  });
  data = applyPendingDecisionRoutes(data, pendingDecisionRoutes, classicToConnect, warnings, reachableFromStart, bundleEntryStepId);
  data = applyPendingUserStepButtons(data, pendingUserStepButtons, classicToConnect, warnings, reachableFromStart, bundleEntryStepId);
  data = applyPendingBackEdges(data, pendingBackEdges, classicToConnect, warnings, bundleEntryStepId);
  data = applyPendingDataEdges(data, pendingDataEdges, classicToConnect, warnings);
  data = applyBundleExpansionShifts(data, bundleExpansions);
  data = alignChainedSteps(data);
  data = resolveStepOverlaps(data);
  data = straightenAlignedArrowJoints(data);
  data = addOrthogonalJoints(data);
  if (forcedEntries.length > 0) {
    warnings.push(`Flow contains a loop (a route leads back to an earlier step): ${forcedEntries.length} step(s) affected \u2014 ${forcedEntries.join(", ")}. All steps and arrows were still created; verify the loop behaves as expected in Connect's designer.`);
  }
  if (selectPopulatedVars.size > 0 || recordPopulatedVars.size > 0 || restCallPopulatedVars.size > 0) {
    data = deepStripResults(data, selectPopulatedVars, recordPopulatedVars, restCallPopulatedVars);
  }
  for (const a of annotations) {
    data = addAnnotation(data, a.text, a.location || { x: 0, y: 0 }, a.size || { width: 200, height: 54 });
  }
  const outputVariableNames = classicFlow.header && classicFlow.header.outputVariableNames || [];
  data = addOutputVariables(data, outputVariableNames);
  const outputVariableModuleNames = new Set(
    outputVariableNames.map((name) => tableDeclarationTypes.get(name)).filter((v) => !!(v && v.moduleName)).map((v) => v.moduleName)
  );
  const outputResultContextModuleName = outputVariableModuleNames.size === 1 ? [...outputVariableModuleNames][0] : null;
  const resultTypeExpression = buildResultTypeExpression(
    outputVariableNames,
    classicFlow.header && classicFlow.header.outputVariableSchema,
    new Map([...tableDeclarationTypes].map(([k, v]) => [k, v.fields])),
    outputResultContextModuleName
  );
  const unreachableStepIds = [];
  for (const [classicId, connectId] of classicToConnect) {
    if (classicId !== null && !reachableFromStart.has(classicId)) unreachableStepIds.push(connectId);
  }
  for (const [classicId, bundleStepId] of bundleEntryStepId) {
    if (classicId !== null && !reachableFromStart.has(classicId)) unreachableStepIds.push(bundleStepId);
  }
  if (ownsPhrasebook && options.phrasebook) {
    const entries = phrasebookEntries(options.phrasebook);
    const outputIdx = data.findIndex((d) => d.type === "output-variables-modified");
    data = outputIdx === -1 ? data.concat(entries) : [...data.slice(0, outputIdx), ...entries, ...data.slice(outputIdx)];
  }
  return { data, warnings, classicToConnect, componentAssetsUsed, resultTypeExpression, unreachableStepIds, startParametersExpression, isInbox: !!inboxConfig };
}
export {
  IFS10_CONNECTOR_TYPE,
  addOrthogonalJoints,
  alignChainedSteps,
  applyBundleExpansionShifts,
  applyPendingUserStepButtons,
  buildControlFlowGraph,
  buildResultTypeExpression,
  buildStartParametersExpression,
  collectDataDependencyEdges,
  computeReachableFromStart,
  deepStripResults,
  emitConnectSteps,
  extractSvcName,
  inferFlowScriptType,
  inferStartParameterTypes,
  parseSchemaEntries,
  resolveStepOverlaps,
  stepKindOwnsDeferredOutgoingArrows,
  straightenAlignedArrowJoints,
  stripTrackedEntitySegment,
  stripTrackedRestOkSuffix,
  stripTrackedResultsSuffix,
  toConnectLocation,
  topologicalOrder
};
