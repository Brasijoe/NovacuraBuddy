import { findChild, findChildren, childText } from "./xmlLite.js";
import { qualifyEnumTypeText } from "./classicModuleSignatures.js";
function findById(node, id) {
  if (node.attrs && node.attrs["z:Id"] === id) return node;
  for (const child of node.children) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}
function resolveRef(root, node) {
  if (!node) return null;
  const refId = node.attrs && node.attrs["z:Ref"];
  if (!refId) return node;
  return findById(root, refId);
}
function decodeModelMembers(root, modelNode) {
  const resolved = resolveRef(root, modelNode);
  if (!resolved) return [];
  const members = findChild(resolved, "Members");
  if (!members) return [];
  return findChildren(members, "ModelParameter").map((m) => ({
    name: childText(m, "Name"),
    type: childText(m, "ParameterType"),
    isArray: childText(m, "IsArray") === "true"
  }));
}
function decodeRestOperationNode(root, opNode) {
  const input = findChild(opNode, "Input");
  const allParameters = input ? findChild(input, "AllParameters") : null;
  const requestParam = allParameters ? findChild(allParameters, "Parameter") : null;
  const requestModel = requestParam ? findChild(requestParam, "Model") : null;
  const resolvedRequestModel = requestModel ? resolveRef(root, requestModel) : null;
  const output = findChild(opNode, "Output");
  const outputParamsContainer = output ? findChild(output, "OutputParameters") : null;
  const outputParams = outputParamsContainer ? findChildren(outputParamsContainer, "OutputParameter") : [];
  const responses = outputParams.map((p) => {
    const model = findChild(p, "Model");
    const resolvedModel = model ? resolveRef(root, model) : null;
    const transformNode = findChild(p, "Transform");
    const resolvedTransform = transformNode ? resolveRef(root, transformNode) : null;
    const rawTransformName = resolvedTransform ? childText(resolvedTransform, "Name") : null;
    return {
      httpStatusCode: childText(p, "HttpStatusCode"),
      modelName: resolvedModel ? childText(resolvedModel, "Name") : null,
      fields: model ? decodeModelMembers(root, model) : [],
      transformName: rawTransformName && rawTransformName !== "None" ? rawTransformName : null
    };
  });
  const entityHeaders = findChild(opNode, "EntityHeaders");
  const contentTypeNode = entityHeaders ? findChild(entityHeaders, "ContentType") : null;
  return {
    displayName: childText(opNode, "DisplayName"),
    description: childText(opNode, "Description"),
    httpMethod: childText(opNode, "HttpMethod"),
    resourcePath: childText(opNode, "Resource"),
    isAbsolutePath: childText(opNode, "AbsoultePath") === "true",
    contentType: contentTypeNode ? childText(contentTypeNode, "Value") : null,
    requestModelName: resolvedRequestModel ? childText(resolvedRequestModel, "Name") : null,
    requestFields: requestModel ? decodeModelMembers(root, requestModel) : [],
    responses
  };
}
function decodeRestOperations(root) {
  const operations = findChild(root, "Operations");
  if (!operations) return [];
  return findChildren(operations, "Operation").map((opNode) => decodeRestOperationNode(root, opNode));
}
function findRestProjectOperationByDisplayName(operations, displayName) {
  if (!displayName) return null;
  const target = displayName.trim().toLowerCase();
  return (operations || []).find((op) => (op.displayName || "").trim().toLowerCase() === target) || null;
}
function decodeRestProject(root) {
  return {
    connectorId: childText(root, "ConnectorId"),
    connectorName: childText(root, "ConnectorName"),
    connectorDescription: childText(root, "ConnectorDescription"),
    basePath: childText(root, "BasePath"),
    operations: decodeRestOperations(root)
  };
}
function resolveRestCallUrl(resourcePath, isAbsolutePath, connectorEnvironments) {
  if (!isAbsolutePath) return { url: resourcePath, warning: null };
  const envs = connectorEnvironments || [];
  for (const env of envs) {
    const baseUrl = env.fields && env.fields.baseUrl;
    if (baseUrl && resourcePath.indexOf(baseUrl) === 0) {
      const stripped = resourcePath.slice(baseUrl.length);
      return { url: stripped.charAt(0) === "/" ? stripped : `/${stripped}`, warning: null };
    }
  }
  return {
    url: resourcePath,
    warning: `Could not find a connector environment whose base URL matches '${resourcePath}' \u2014 left as the full absolute URL, verify manually`
  };
}
function mapRestFieldTypeToFlowScript(fieldType) {
  if (fieldType === "String") return "text";
  if (fieldType === "Boolean") return "boolean";
  if (fieldType === "Integer" || fieldType === "Long" || fieldType === "Double" || fieldType === "Decimal") return "number";
  return "text?";
}
function buildRestCallResultTypeExpression(fields) {
  const fieldsText = (fields || []).map((f) => `    ${f.name}: ${qualifyEnumTypeText(mapRestFieldTypeToFlowScript(f.type), null)}${f.isArray ? "*" : ""}`).join(",\n");
  return `{
${fieldsText}
}*`;
}
export {
  buildRestCallResultTypeExpression,
  decodeModelMembers,
  decodeRestOperations,
  decodeRestProject,
  findById,
  findRestProjectOperationByDisplayName,
  mapRestFieldTypeToFlowScript,
  resolveRef,
  resolveRestCallUrl
};
