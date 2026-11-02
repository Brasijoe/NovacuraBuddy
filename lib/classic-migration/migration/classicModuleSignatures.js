function splitTopLevel(text, sep) {
  if (String(text).trim() === "") return [];
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === sep && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}
function escapeRegExp(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function defaultLiteralForKind(kind) {
  if (kind === "text") return '""';
  if (kind === "number") return "0";
  if (kind === "boolean") return "false";
  return null;
}
function buildEnumFromTextCall(moduleName, enumTypeName, valueExpr) {
  return `${moduleName}.${enumTypeName}.fromText(${valueExpr})`;
}
function renderConstantValue(rawValue, kind) {
  const text = rawValue == null ? "" : rawValue;
  if (kind === "boolean") {
    if (/^true$/i.test(text)) return "true";
    if (/^false$/i.test(text)) return "false";
  }
  if (kind === "number" && /^-?\d+(\.\d+)?$/.test(text)) return text;
  return JSON.stringify(text);
}
function classifyDotNetTypeKind(dotNetTypeName) {
  const raw = dotNetTypeName || "";
  const nullableMatch = /^System\.Nullable`1\[\[([^,\]]+)/.exec(raw);
  let base = (nullableMatch ? nullableMatch[1] : raw).trim();
  if (!nullableMatch) {
    const commaIdx = base.indexOf(",");
    if (commaIdx !== -1) base = base.slice(0, commaIdx).trim();
  }
  if (base === "System.Boolean") return "boolean";
  const numericTypes = /* @__PURE__ */ new Set([
    "System.Byte",
    "System.SByte",
    "System.Int16",
    "System.Int32",
    "System.Int64",
    "System.UInt16",
    "System.UInt32",
    "System.UInt64",
    "System.Single",
    "System.Double",
    "System.Decimal"
  ]);
  if (numericTypes.has(base)) return "number";
  return "text";
}
function dotNetEnumTypeName(dotNetTypeName) {
  const raw = (dotNetTypeName || "").trim();
  if (!raw) return null;
  const nullableMatch = /^System\.Nullable`1\[\[([^,\]]+)/.exec(raw);
  const base = (nullableMatch ? nullableMatch[1] : raw).trim();
  if (!base) return null;
  const lastDot = base.lastIndexOf(".");
  return lastDot === -1 ? base : base.slice(lastDot + 1);
}
function findFunctionSignature(moduleSource, functionName) {
  const marker = `function ${functionName}(`;
  const idx = (moduleSource || "").indexOf(marker);
  if (idx === -1) return null;
  const parenStart = idx + marker.length - 1;
  let depth = 0;
  let end = -1;
  for (let i = parenStart; i < moduleSource.length; i++) {
    const c = moduleSource[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  const paramsText = moduleSource.slice(parenStart + 1, end);
  const params = splitTopLevel(paramsText, ",").map((p) => p.trim()).filter(Boolean).map((paramText) => {
    const eqIdx = paramText.indexOf("=");
    const withoutDefault = eqIdx === -1 ? paramText : paramText.slice(0, eqIdx);
    const colonIdx = withoutDefault.indexOf(":");
    const name = (colonIdx === -1 ? withoutDefault : withoutDefault.slice(0, colonIdx)).trim();
    const type = colonIdx === -1 ? "" : withoutDefault.slice(colonIdx + 1).trim();
    return { name, type, hasDefault: eqIdx !== -1 };
  });
  const afterParen = moduleSource.slice(end + 1);
  const returnMatch = afterParen.match(/^\s*:\s*([^{]+?)\s*\{/);
  const returnType = returnMatch ? returnMatch[1].trim() : null;
  return { name: functionName, params, returnType };
}
function classifyFlowType(typeStr) {
  const trimmed = String(typeStr || "").trim();
  const nullable = trimmed.endsWith("?");
  const base = trimmed.replace(/\?$/, "").replace(/\*$/, "").trim();
  if (base === "number") return { kind: "number", nullable, enumType: null };
  if (base === "datetime") return { kind: "datetime", nullable, enumType: null };
  if (base === "boolean") return { kind: "boolean", nullable, enumType: null };
  const enumMatch = /^(?:\w+\.)*(\w+)\.Value$/.exec(base);
  if (enumMatch) return { kind: "enum", nullable, enumType: enumMatch[1] };
  return { kind: "text", nullable, enumType: null };
}
const QUALIFIED_ENUM_TYPE_RE = /^(\w+)\.(\w+)\.Value(\??)$/;
const BARE_ENUM_TYPE_RE = /^(\w+)\.Value(\??)$/;
function qualifyEnumTypeText(type, contextModuleName) {
  const bare = !QUALIFIED_ENUM_TYPE_RE.exec(type) && contextModuleName ? BARE_ENUM_TYPE_RE.exec(type) : null;
  return bare ? `${contextModuleName}.${type}` : type;
}
function isDroppableUnassigned(mode, isOptional) {
  return mode === "Unassigned" && isOptional;
}
function findRecordTypeFields(moduleSource, typeName) {
  const re = new RegExp(`type\\s+${escapeRegExp(typeName)}\\s*=\\s*\\{`);
  const m = re.exec(moduleSource || "");
  if (!m) return null;
  const braceStart = m.index + m[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < moduleSource.length; i++) {
    const c = moduleSource[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  const body = moduleSource.slice(braceStart + 1, end);
  return splitTopLevel(body, ",").map((f) => f.trim()).filter(Boolean).map((fieldText) => {
    const optionalMatch = fieldText.match(/^optional\s+/);
    const withoutOptional = optionalMatch ? fieldText.slice(optionalMatch[0].length) : fieldText;
    const colonIdx = withoutOptional.indexOf(":");
    const rawName = colonIdx === -1 ? withoutOptional : withoutOptional.slice(0, colonIdx);
    const name = rawName.trim().replace(/^["']|["']$/g, "");
    const afterColon = colonIdx === -1 ? "" : withoutOptional.slice(colonIdx + 1);
    const eqIdx = afterColon.indexOf("=");
    const type = (eqIdx === -1 ? afterColon : afterColon.slice(0, eqIdx)).trim();
    return { name, type, optional: !!optionalMatch };
  });
}
function deriveWriteCandidates(containerEntityName, actionName) {
  const candidates = [];
  if (containerEntityName) candidates.push(`${containerEntityName}_${actionName}`);
  candidates.push(actionName);
  if (containerEntityName) candidates.push(containerEntityName);
  return candidates;
}
function deriveArrayMutationCandidates(containerEntityName, actionName) {
  if (!containerEntityName) return [];
  const m = actionName.match(/^(AddTo|UpdateTo)[A-Za-z0-9]+_(.+)$/);
  if (!m) return [];
  const verb = m[1] === "AddTo" ? "Create" : "Update";
  return [`${containerEntityName}_${m[2]}_${verb}`];
}
function deriveGetByKeyCandidates(moduleSource, containerEntityName, actionName) {
  const name = actionName || "";
  let entityTypeVariants = [];
  if (/^GetByKey/i.test(name)) {
    if (!containerEntityName) return [];
    entityTypeVariants = [containerEntityName.replace(/Set$/, ""), containerEntityName];
  } else {
    const childShapeMatch = /^ByKey[0-9A-Fa-f]+_(.+)$/i.exec(name);
    if (!childShapeMatch) return [];
    const raw = childShapeMatch[1];
    entityTypeVariants = [raw, raw.replace(/Array$/, ""), raw.replace(/Set$/, "")];
  }
  entityTypeVariants = Array.from(new Set(entityTypeVariants.filter(Boolean)));
  if (entityTypeVariants.length === 0) return [];
  const names = [];
  for (const entityType of entityTypeVariants) {
    const re = new RegExp(`function\\s+(\\w*${escapeRegExp(entityType)}ByKey)\\s*\\(`, "g");
    let m;
    while (m = re.exec(moduleSource || "")) {
      if (!names.includes(m[1])) names.push(m[1]);
    }
  }
  return names;
}
function findFunctionOverloads(moduleSource, baseName) {
  if (!baseName) return [];
  const re = new RegExp(`function\\s+(${escapeRegExp(baseName)}(?:_\\d+)?)\\s*\\(`, "g");
  const names = /* @__PURE__ */ new Set();
  let m;
  while (m = re.exec(moduleSource || "")) {
    names.add(m[1]);
  }
  return Array.from(names).map((name) => findFunctionSignature(moduleSource, name)).filter((sig) => sig !== null);
}
function scoreOverloadMatch(signature, keyNames) {
  const declaredNames = signature.params.filter((p) => p.name !== "headers").map((p) => p.name.toLowerCase());
  const recordedNames = keyNames.map((n) => n.toLowerCase());
  return declaredNames.filter((n) => recordedNames.includes(n)).length;
}
function findBestMatchingOverload(moduleSource, candidateName, keyNames) {
  const overloads = findFunctionOverloads(moduleSource, candidateName);
  if (overloads.length === 0) return null;
  if (overloads.length === 1) return overloads[0];
  let best = overloads[0];
  let bestScore = -1;
  overloads.forEach((sig) => {
    const score = scoreOverloadMatch(sig, keyNames);
    if (score > bestScore) {
      bestScore = score;
      best = sig;
    }
  });
  return best;
}
function findQueryableVarName(moduleSource, entitySetName) {
  const re = /let\s+(\w+)\s*=\s*Queryable\.Create</g;
  let m;
  let fallback = null;
  while (m = re.exec(moduleSource || "")) {
    if (m[1] === entitySetName) return m[1];
    if (!fallback && m[1].toUpperCase() === entitySetName.toUpperCase()) fallback = m[1];
  }
  return fallback;
}
function findQueryableRowType(moduleSource, queryableVarName) {
  const re = new RegExp(`let\\s+${escapeRegExp(queryableVarName)}\\s*=\\s*Queryable\\.Create<[^,]+,\\s*([A-Za-z0-9_]+)\\s*,`);
  const m = re.exec(moduleSource || "");
  return m ? m[1] : null;
}
function enumModuleName(typeStr) {
  const base = String(typeStr || "").trim().replace(/\?$/, "");
  const match = base.match(/^(?:\w+\.)*(\w+)\.Value$/);
  return match ? match[1] : null;
}
export {
  BARE_ENUM_TYPE_RE,
  QUALIFIED_ENUM_TYPE_RE,
  buildEnumFromTextCall,
  classifyDotNetTypeKind,
  classifyFlowType,
  defaultLiteralForKind,
  deriveArrayMutationCandidates,
  deriveGetByKeyCandidates,
  deriveWriteCandidates,
  dotNetEnumTypeName,
  enumModuleName,
  escapeRegExp,
  findBestMatchingOverload,
  findFunctionOverloads,
  findFunctionSignature,
  findQueryableRowType,
  findQueryableVarName,
  findRecordTypeFields,
  isDroppableUnassigned,
  qualifyEnumTypeText,
  renderConstantValue,
  scoreOverloadMatch,
  splitTopLevel
};
