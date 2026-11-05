import { buildRestCallBodyTemplate } from "./classicMethodCallDecoder.js";
import { resolveRestCallUrl, buildRestCallResultTypeExpression } from "./classicRestProjectDecoder.js";
import { classifyDotNetTypeKind, qualifyEnumTypeText } from "./classicModuleSignatures.js";
function methodOutputFieldTypeText(field) {
  if ((field.type === "Record" || field.type === "Table") && field.children.length > 0) {
    const recordText = buildMethodOutputRecordText(field.children);
    return field.type === "Table" ? `${recordText}*` : recordText;
  }
  return qualifyEnumTypeText(classifyDotNetTypeKind(field.dotNetTypeName), null);
}
function buildMethodOutputRecordText(fields) {
  const fieldsText = fields.map((f) => `    ${f.identifier}: ${methodOutputFieldTypeText(f)}`).join(",\n");
  return `{
${fieldsText}
}`;
}
function buildResultTypeExpressionFromMethodOutput(output) {
  const okChild = output.children.find((c) => (c.identifier || "").toLowerCase() === "ok");
  const bodyNode = okChild ?? output;
  const recordText = buildMethodOutputRecordText(bodyNode.children);
  return bodyNode.type === "Table" ? `${recordText}*` : recordText;
}
function buildRestCall(methodCallOperation, restProjectOperation, connector, connectorEnvironments, targetVariableName) {
  const warnings = [];
  const { template: bodyExpression, warnings: bodyWarnings } = buildRestCallBodyTemplate(methodCallOperation ? methodCallOperation.input : null);
  warnings.push(...bodyWarnings);
  const { url: urlExpression, warning: urlWarning } = resolveRestCallUrl(
    restProjectOperation.resourcePath,
    restProjectOperation.isAbsolutePath,
    connectorEnvironments
  );
  if (urlWarning) warnings.push(urlWarning);
  let resultTypeExpression;
  if (methodCallOperation && methodCallOperation.output) {
    resultTypeExpression = buildResultTypeExpressionFromMethodOutput(methodCallOperation.output);
  } else {
    const okResponse = (restProjectOperation.responses || []).find((r) => r.httpStatusCode === "200");
    if (!okResponse) {
      warnings.push("No '200' response defined in the REST project (and Classic's own method-call config has no real output description either) \u2014 resultTypeExpression defaulted to an empty shape, verify manually");
    }
    if (okResponse && okResponse.transformName) {
      warnings.push(
        `REST project's "200" response has a Classic-side Transform '${okResponse.transformName}' \u2014 its custom logic (e.g. field parsing/derivation) has no Connect equivalent and is NOT reproduced here; resultTypeExpression reflects only the raw pre-transform response. Any field the transform added must be hand-written as FlowScript in this flow, verify manually`
      );
    }
    resultTypeExpression = buildRestCallResultTypeExpression(okResponse ? okResponse.fields : []);
  }
  const restCall = {
    connector,
    method: String(restProjectOperation.httpMethod || "").toLowerCase(),
    urlExpression,
    bodyExpression,
    targetVariableName,
    resultTypeExpression
  };
  return { restCall, warnings };
}
export {
  buildRestCall,
  buildResultTypeExpressionFromMethodOutput
};
