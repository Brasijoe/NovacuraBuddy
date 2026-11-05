import { findChild, findChildren, childText } from "./xmlLite.js";
import { translateAssignmentTemplate, translateOrRaw } from "./classicScriptTranslator.js";
import { renderInputValue } from "./classicCallScriptDecoder.js";
import { isDroppableUnassigned } from "./classicModuleSignatures.js";
function adaptMethodParameter(param) {
  const mode = param.mode === "Constant" ? "Constant" : param.mappingExpression ? "VariableMapping" : param.children.length > 0 ? "CustomRecordMapping" : "Unassigned";
  return {
    mode,
    name: param.identifier,
    mappingExpression: param.mappingExpression || null,
    value: param.value ?? null,
    // A whole-mapped container (real mappingExpression present) stops recursion right there —
    // explicit instruction (2026-08-07): "If in Flow we have mapped a table there is not need to
    // map it on a deeper level again." Only recurse when there's no own mapping expression.
    children: mode === "CustomRecordMapping" ? param.children.map(adaptMethodParameter) : []
  };
}
function decodeMethodParameter(node) {
  const complexContents = findChild(node, "ComplexContents");
  const itemsContainer = complexContents ? findChild(complexContents, "_items") : null;
  const rawChildren = itemsContainer ? findChildren(itemsContainer, "MethodParameterDescription") : [];
  const realChildren = rawChildren.filter((c) => c.children.length > 0);
  const runtimeValue = findChild(node, "RuntimeValue");
  return {
    identifier: childText(node, "Identifier") || childText(node, "DisplayName"),
    type: childText(node, "Type"),
    dotNetTypeName: childText(node, "DotNetTypeName"),
    isMandatory: childText(node, "IsMandatory") === "true",
    isExplicitlyOptional: childText(node, "IsMandatory") === "false",
    mappingExpression: runtimeValue ? childText(runtimeValue, "MappingExpression") || "" : "",
    mode: runtimeValue ? childText(runtimeValue, "Mode") : null,
    value: runtimeValue ? childText(runtimeValue, "Value") : null,
    children: realChildren.map(decodeMethodParameter)
  };
}
function decodeRealTopInputs(amd) {
  const inputsContainer = findChild(amd, "Inputs");
  const inputItems = inputsContainer ? findChild(inputsContainer, "_items") : null;
  const rawTopInputs = inputItems ? findChildren(inputItems, "InputParameterDescription") : [];
  return rawTopInputs.filter((n) => n.children.length > 0);
}
function decodeRealTopOutputs(amd) {
  const outputsContainer = findChild(amd, "Outputs");
  const outputItems = outputsContainer ? findChild(outputsContainer, "_items") : null;
  const rawTopOutputs = outputItems ? findChildren(outputItems, "OutputParamterDescription") : [];
  return rawTopOutputs.filter((n) => n.children.length > 0);
}
function decodeMethodCallOperation(methodCallTagNode) {
  const operation = findChild(methodCallTagNode, "Operation");
  const amd = operation ? findChild(operation, "AssemblyMethodDescription") : null;
  if (!amd) return null;
  const realTopInputs = decodeRealTopInputs(amd);
  const realTopOutputs = decodeRealTopOutputs(amd);
  const parentNodesContainer = findChild(amd, "ParentNodes");
  const parentNodes = parentNodesContainer ? findChildren(parentNodesContainer, "ParentNode") : [];
  return {
    identifier: childText(amd, "Identifier"),
    displayName: childText(amd, "DisplayName"),
    description: childText(amd, "Description"),
    input: realTopInputs.length > 0 ? decodeMethodParameter(realTopInputs[0]) : null,
    inputs: realTopInputs.map(decodeMethodParameter),
    output: realTopOutputs.length > 0 ? decodeMethodParameter(realTopOutputs[0]) : null,
    declaringCategory: parentNodes.length > 0 ? childText(parentNodes[parentNodes.length - 1], "Identifier") : null
  };
}
function decodeMethodCallConnectorRef(itemTagNode) {
  const cmdElement = findChild(itemTagNode, "CommandElement");
  const command = cmdElement ? findChild(cmdElement, "command") : null;
  const methodCallNode = command ? findChild(command, "MethodCallTaskConfiguration") : null;
  if (!methodCallNode) return null;
  const rawName = command.attrs && command.attrs["connector"];
  return {
    connectorName: rawName ? rawName.trim() : null,
    connectorTypeName: childText(itemTagNode, "ConnectorTypeName") || null
  };
}
function buildMethodCallInputJson(node) {
  return buildMethodCallInputJsonAt(node, true);
}
function bodyNodeMode(node, isRoot) {
  const mode = adaptMethodParameter(node).mode;
  return isRoot && mode === "Constant" ? "Unassigned" : mode;
}
function buildMethodCallInputJsonAt(node, isRoot) {
  if (!node) return "null";
  const adapted = adaptMethodParameter(node);
  const mode = bodyNodeMode(node, isRoot);
  if (mode === "CustomRecordMapping") {
    const fieldsText = node.children.map((c) => ({ c, adaptedChild: adaptMethodParameter(c) })).filter(({ c, adaptedChild }) => !isDroppableUnassigned(adaptedChild.mode, c.isExplicitlyOptional === true)).map(({ c }) => `${c.identifier}: ${buildMethodCallInputJsonAt(c, false)}`).join(", ");
    return `{${fieldsText}}`;
  }
  if (mode === "Unassigned") {
    return `/* TODO: no bound value found for REST input field '${node.identifier}' */ null`;
  }
  return renderInputValue(adapted);
}
function buildRestCallBodyTemplate(node) {
  const warnings = [];
  function walk(n, indent) {
    if (!n) return "null";
    const adapted = adaptMethodParameter(n);
    if (bodyNodeMode(n, n === node) === "Unassigned") {
      warnings.push(`REST input field '${n.identifier}' has no bound value \u2014 defaulted to null in the request body, fix manually`);
      return "null";
    }
    if (adapted.mode === "Constant") {
      return renderInputValue(adapted);
    }
    if (adapted.mode !== "CustomRecordMapping") {
      return translateOrRaw(n.mappingExpression, () => translateAssignmentTemplate(n.mappingExpression));
    }
    const innerIndent = `${indent}    `;
    const fieldsText = n.children.filter((c) => !isDroppableUnassigned(adaptMethodParameter(c).mode, c.isExplicitlyOptional === true)).map((c) => `${innerIndent}${JSON.stringify(c.identifier)}: ${walk(c, innerIndent)}`).join(",\n");
    return `{
${fieldsText}
${indent}}`;
  }
  const template = walk(node, "");
  return { template, warnings };
}
export {
  adaptMethodParameter,
  buildMethodCallInputJson,
  buildRestCallBodyTemplate,
  decodeMethodCallConnectorRef,
  decodeMethodCallOperation
};
