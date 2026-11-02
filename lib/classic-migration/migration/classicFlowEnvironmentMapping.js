function isGetCustomPropertiesOperation(connectorTypeName, identifier) {
  return connectorTypeName === "flow" && identifier === "GetCustomProperties";
}
const ENVIRONMENT_PROPERTY_LOOKUP_RE = /^\{?\s*FirstOrEmpty\(\s*([A-Za-z_]\w*)\s+where\s+Name\s*=\s*(?:'([^']*)'|"([^"]*)")\s*\)\.Value\s*\}?$/;
function matchEnvironmentPropertyLookup(classicExpression, environmentPropertyTableVars) {
  if (!classicExpression) return null;
  const m = ENVIRONMENT_PROPERTY_LOOKUP_RE.exec(classicExpression.trim());
  if (!m) return null;
  const [, tableVar, singleQuoted, doubleQuoted] = m;
  if (!environmentPropertyTableVars.has(tableVar)) return null;
  return singleQuoted ?? doubleQuoted ?? "";
}
function buildEnvironmentPropertyTemplate(propertyName) {
  return `{environment.${propertyName}}`;
}
export {
  buildEnvironmentPropertyTemplate,
  isGetCustomPropertiesOperation,
  matchEnvironmentPropertyLookup
};
