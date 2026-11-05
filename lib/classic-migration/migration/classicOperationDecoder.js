import { parseXml, findChild, findChildren, childText, stripPrefix } from "./xmlLite.js";
import { translateMappingExpression, translateOrRaw } from "./classicScriptTranslator.js";
import { renderConstantValue, classifyDotNetTypeKind, dotNetEnumTypeName, buildEnumFromTextCall } from "./classicModuleSignatures.js";
function decodeInputValueNode(node) {
  const complexContent = findChild(node, "ComplexContent");
  return {
    identifier: childText(node, "Identifier"),
    name: childText(node, "Name"),
    mode: childText(node, "Mode"),
    mappingExpression: childText(node, "MappingExpression"),
    value: childText(node, "Value"),
    children: complexContent ? complexContent.children.map(decodeInputValueNode) : []
  };
}
function decodeInputRuntimeValues(root) {
  const container = findChild(root, "InputRuntimeValues");
  return container ? container.children.map(decodeInputValueNode) : [];
}
function decodeParamMetadataNode(node) {
  const complexContents = findChild(node, "ComplexContents");
  return {
    identifier: childText(node, "Identifier"),
    name: childText(node, "Name"),
    type: childText(node, "Type"),
    dotNetTypeName: childText(node, "DotNetTypeName"),
    isMandatory: childText(node, "IsMandatory") === "true",
    children: complexContents ? complexContents.children.map(decodeParamMetadataNode) : []
  };
}
function decodeInputsMetadata(operationNode) {
  const container = findChild(operationNode, "Inputs");
  return container ? container.children.map(decodeParamMetadataNode) : [];
}
function decodeEntityFilter(filterNode) {
  const mapping = findChild(filterNode, "Mapping");
  const innerFilterNode = findChild(filterNode, "InnerFilter");
  return {
    filterKind: stripPrefix(filterNode.attrs["i:type"]),
    isNegative: childText(filterNode, "IsNegative") === "true",
    memberName: childText(filterNode, "MemberName"),
    memberTypeName: childText(filterNode, "MemberTypeName"),
    mappingKind: mapping ? stripPrefix(mapping.attrs["i:type"]) : null,
    mappingExpression: mapping ? childText(mapping, "MappingExpression") : null,
    innerFilter: innerFilterNode ? decodeEntityFilter(innerFilterNode) : null
  };
}
function decodeOperatorNode(operatorNode) {
  const childOperatorsContainer = findChild(operatorNode, "ChildOperators");
  const filtersContainer = findChild(operatorNode, "Filters");
  return {
    kind: stripPrefix(operatorNode.attrs["i:type"]),
    childOperators: findChildren(childOperatorsContainer, "Operator").map(decodeOperatorNode),
    filters: findChildren(filtersContainer, "EntityFilter").map(decodeEntityFilter)
  };
}
function decodeWhereClause(operationNode) {
  const whereClause = findChild(operationNode, "WhereClause");
  const operatorNode = whereClause ? findChild(whereClause, "Operator") : null;
  return operatorNode ? decodeOperatorNode(operatorNode) : null;
}
const KNOWN_FILTER_OPERATORS = {
  EqualsFilter: "=",
  EnumEqualsFilter: "=",
  NotEqualsFilter: "!=",
  GreaterThanFilter: ">",
  LessThanFilter: "<",
  // Real bug fix (2026-09-13, real customer file "HPHG-05 AEB Sanction List.wap", real Designer
  // TODO fallthrough: "verify Connect operator for Classic EntityFilter kind
  // 'LessThanOrEqualFilter'" -- downstream symptom: "SuppliersGetData: Expected a 'boolean', but
  // the term has type 'datetime?'" once the malformed unresolved-passthrough left three bare
  // identifiers where a real comparison should be): the real Classic xsi:type is
  // "LessThanOrEqualFilter" -- NO "s" after "Equal" (an adjective phrase, "less than or equal",
  // unlike the verb-form "Equals"/"NotEquals" which genuinely do have one) -- this table's own
  // entry had a guessed extra "s" ("LessThanOrEqualsFilter") that never matched real data.
  // GreaterThanOrEqualFilter (below) follows the exact same grammar and is fixed the same way,
  // though not independently confirmed against a second real live example the way this one is.
  LessThanOrEqualFilter: "<=",
  GreaterThanOrEqualFilter: ">=",
  InFilter: "In"
};
const INVERSE_OPERATORS = {
  "=": "!=",
  "!=": "=",
  ">": "<=",
  "<": ">=",
  ">=": "<",
  "<=": ">="
};
function emitEntityFilter(filter, moduleName, warnings, alias) {
  if (filter.filterKind === "NavigationPropertyFilter" && filter.innerFilter) {
    const qualifiedInner = { ...filter.innerFilter, memberName: `${filter.memberName}.${filter.innerFilter.memberName}` };
    return emitEntityFilter(qualifiedInner, moduleName, warnings, alias);
  }
  const op = filter.filterKind ? KNOWN_FILTER_OPERATORS[filter.filterKind] : void 0;
  let value;
  if (filter.filterKind === "EnumEqualsFilter" && filter.mappingKind === "ConstantMapping" && moduleName) {
    const enumTypeName = dotNetEnumTypeName(filter.memberTypeName) ?? filter.memberName ?? "";
    value = buildEnumFromTextCall(moduleName, enumTypeName, JSON.stringify(filter.mappingExpression == null ? "" : filter.mappingExpression));
  } else if (filter.filterKind !== "EnumEqualsFilter" && filter.mappingKind === "ConstantMapping") {
    value = renderConstantValue(filter.mappingExpression, classifyDotNetTypeKind(filter.memberTypeName));
  } else if (filter.mappingKind === "VariableMapping") {
    value = translateOrRaw(filter.mappingExpression ?? "", () => translateMappingExpression(filter.mappingExpression ?? ""));
    if (warnings && value === filter.memberName && !alias) {
      warnings.push(`Filter on '${filter.memberName}' compares the entity field against a flow variable of the SAME bare name \u2014 likely a self-referential tautology in Connect (real example: "AEB Sanction Check - Customer", fixed by introducing a distinctly-named copy variable upstream, e.g. "TempCustomerId") \u2014 verify and rename manually.`);
    }
  } else {
    value = `/* TODO: unhandled WhereClause mapping kind '${filter.mappingKind}' */ null`;
  }
  const memberRef = alias ? `${alias}.${filter.memberName}` : filter.memberName;
  const invertedOp = filter.isNegative && op ? INVERSE_OPERATORS[op] : void 0;
  const comparison = `${memberRef} ${invertedOp ?? op ?? filter.filterKind} ${value}`;
  const flagged = op ? comparison : `/* TODO: verify Connect operator for Classic EntityFilter kind '${filter.filterKind}' */ ${comparison}`;
  return filter.isNegative && !invertedOp ? `not (${flagged})` : flagged;
}
function emitOperatorNode(node, moduleName, warnings, alias) {
  const parts = node.filters.map((f) => emitEntityFilter(f, moduleName, warnings, alias)).concat(node.childOperators.map((child) => `(${emitOperatorNode(child, moduleName, warnings, alias)})`));
  if (parts.length === 0) return "true";
  const combinator = node.kind === "Or" ? " or " : node.kind === "And" ? " and " : ` /* TODO: unrecognized WhereClause Operator kind '${node.kind}' */ and `;
  return parts.map((p) => `(${p})`).join(combinator);
}
function needsSelfReferenceAlias(node) {
  if (!node) return false;
  const selfReferential = node.filters.some((f) => {
    if (f.mappingKind !== "VariableMapping") return false;
    try {
      return translateMappingExpression(f.mappingExpression ?? "") === f.memberName;
    } catch (e) {
      return false;
    }
  });
  return selfReferential || node.childOperators.some(needsSelfReferenceAlias);
}
function operatorNodeIsEmpty(node) {
  if (!node) return true;
  if (node.filters.length > 0) return false;
  return node.childOperators.every(operatorNodeIsEmpty);
}
function whereClauseToFlowScript(whereClauseNode, moduleName, warnings, alias) {
  if (!whereClauseNode || operatorNodeIsEmpty(whereClauseNode)) return null;
  return emitOperatorNode(whereClauseNode, moduleName, warnings, alias);
}
function extractContainerEntityName(inputsMetadata) {
  const pattern = /\+Entities\+([A-Za-z0-9]+?)Operations\+/;
  function scan(nodes) {
    for (const node of nodes || []) {
      if (node.dotNetTypeName) {
        const m = pattern.exec(node.dotNetTypeName);
        if (m) return m[1];
      }
      const found = scan(node.children);
      if (found) return found;
    }
    return null;
  }
  return scan(inputsMetadata);
}
function decodeSelectMembers(operationNode) {
  const container = findChild(operationNode, "SelectMembers");
  if (!container) return [];
  return findChildren(container, "EntityProperty").map((node) => ({
    name: childText(node, "Name"),
    isNavigationProperty: childText(node, "IsNavigationProperty") === "true",
    navigationTargetEntitySet: childText(node, "NavigationPropertyTargetEntitySet") || null
  }));
}
function decodeResultRowShape(operationNode) {
  const outputVariable = findChild(operationNode, "OutputVariable");
  const outerChildren = outputVariable ? findChild(outputVariable, "Children") : null;
  if (!outerChildren) return { plainFields: [], expandMembers: [] };
  const resultsTable = findChildren(outerChildren, "WorkflowVariable").find((n) => n.attrs["i:type"] === "TableWorkflowVariable");
  const rowChildren = resultsTable ? findChild(resultsTable, "Children") : null;
  if (!rowChildren) return { plainFields: [], expandMembers: [] };
  const rowVars = findChildren(rowChildren, "WorkflowVariable");
  const plainFields = rowVars.filter((n) => n.attrs["i:type"] === "SimpleWorkflowVariable").map((n) => childText(n, "Name")).filter((n) => !!n);
  const expandMembers = rowVars.filter((n) => n.attrs["i:type"] === "RecordWorkflowVariable" || n.attrs["i:type"] === "TableWorkflowVariable").map((n) => {
    const fieldsContainer = findChild(n, "Children");
    const fields = fieldsContainer ? findChildren(fieldsContainer, "WorkflowVariable").map((f) => ({ name: childText(f, "Name"), dotNetTypeName: childText(f, "TypeName") })) : [];
    return { name: childText(n, "Name"), kind: n.attrs["i:type"] === "TableWorkflowVariable" ? "table" : "record", fields };
  });
  return { plainFields, expandMembers };
}
function decodeFunctionParameters(parametersNode) {
  const container = parametersNode ? findChild(parametersNode, "FunctionParameters") : null;
  if (!container) return [];
  return findChildren(container, "string").map((node) => {
    const text = node.text || "";
    const idx = text.indexOf(";");
    return idx === -1 ? { name: text, dotNetTypeName: null } : { name: text.slice(0, idx), dotNetTypeName: text.slice(idx + 1) };
  });
}
function decodeCustomHttpParameters(operationNode) {
  const container = findChild(operationNode, "Parameters");
  if (!container) return [];
  return findChildren(container, "ODataCustomHttpParameter").map((p) => {
    const mapping = findChild(p, "Mapping");
    const mappingKind = mapping ? stripPrefix(mapping.attrs["i:type"] || "") : null;
    return {
      name: childText(p, "Name"),
      kind: stripPrefix(p.attrs["i:type"] || "") || null,
      mappingExpression: mapping && mappingKind === "VariableMapping" ? childText(mapping, "MappingExpression") : null
    };
  });
}
function isODataFunctionQueryOperationName(operationName) {
  return operationName === "ODataFunctionQuery" || operationName === "ODataFunction";
}
function decodeOperationConfig(taskConfigXmlText) {
  const root = parseXml(taskConfigXmlText);
  const operationNode = findChild(root, "Operation");
  if (!operationNode) throw new Error("FlowClassicOperation: TaskConfig has no <Operation> element");
  const endpoint = findChild(operationNode, "ODataEndpoint");
  const inputsMetadata = decodeInputsMetadata(operationNode);
  const parametersNode = findChild(operationNode, "Parameters");
  const functionAndOperator = parametersNode ? findChild(parametersNode, "AndOperator") : null;
  const resultRowShape = decodeResultRowShape(operationNode);
  return {
    operationName: childText(operationNode, "OperationName"),
    name: childText(operationNode, "Name"),
    serviceUrl: endpoint ? childText(endpoint, "ServiceUrl") : null,
    entityName: childText(operationNode, "EntityName"),
    whereClause: decodeWhereClause(operationNode),
    selectMembers: decodeSelectMembers(operationNode),
    resultFields: resultRowShape.plainFields,
    expandMembers: resultRowShape.expandMembers,
    inputs: decodeInputRuntimeValues(root),
    inputsMetadata,
    containerEntityName: extractContainerEntityName(inputsMetadata),
    functionName: childText(operationNode, "FunctionName"),
    functionParameters: decodeFunctionParameters(parametersNode),
    functionArguments: functionAndOperator ? decodeOperatorNode(functionAndOperator) : null,
    customHttpMethod: childText(operationNode, "HttpMethod"),
    customUrl: childText(operationNode, "Url"),
    customBody: childText(operationNode, "Body"),
    customContentType: childText(operationNode, "ContentType"),
    customParameters: decodeCustomHttpParameters(operationNode),
    iterator: childText(root, "Iterator")
  };
}
export {
  decodeFunctionParameters,
  decodeInputRuntimeValues,
  decodeInputsMetadata,
  decodeOperationConfig,
  decodeResultRowShape,
  decodeSelectMembers,
  decodeWhereClause,
  extractContainerEntityName,
  isODataFunctionQueryOperationName,
  needsSelfReferenceAlias,
  whereClauseToFlowScript
};
