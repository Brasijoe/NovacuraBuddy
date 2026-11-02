import { adaptMethodParameter } from "./classicMethodCallDecoder.js";
import { renderInputValue } from "./classicCallScriptDecoder.js";
import { usesSeqModule } from "./classicScriptTranslator.js";
const DIRECTORY_CATEGORY_SUFFIX = "+DirectoryMethods";
const FILE_CATEGORY_SUFFIX = "+FileMethods";
function renderScalar(param) {
  if (!param) return null;
  const adapted = adaptMethodParameter(param);
  if (adapted.mode === "Unassigned" || adapted.mode === "CustomRecordMapping") return null;
  return renderInputValue(adapted);
}
function renderLinesSequence(param) {
  const base = renderScalar(param);
  if (!base || !param) return base;
  const hasValueProjection = param.children.some((c) => c.mappingExpression.trim() === "{Value}");
  return hasValueProjection ? `${base}.map(x => isNull(x.Value, ""))` : base;
}
function paramsByIdentifier(inputs) {
  const map = /* @__PURE__ */ new Map();
  for (const p of inputs) {
    if (p.identifier) map.set(p.identifier, p);
  }
  return map;
}
function codePageToEncoding(param, warnings, context) {
  if (!param || param.mode !== "Constant" || param.value == null) return null;
  if (param.value === "65001") return "UTF-8";
  warnings.push(`${context}: unrecognized Classic codePage '${param.value}' -- no FlowScript encoding was set (Connect's own default applies); fix manually if this file isn't UTF-8`);
  return null;
}
function buildSearchOptions(params) {
  const fields = [];
  const pattern = renderScalar(params.get("pattern"));
  if (pattern) fields.push(`pattern: ${pattern}`);
  const recursive = renderScalar(params.get("recursive"));
  if (recursive) fields.push(`recursive: ${recursive}`);
  return fields.length > 0 ? `, {${fields.join(", ")}}` : "";
}
const DIRECTORY_FUNCTIONS = {
  Exists: {
    flowScriptName: "directoryExists",
    confirmed: true,
    build: (params) => {
      const path = renderScalar(params.get("path"));
      return path ? `FileSystem.directoryExists(${path})` : null;
    }
  },
  CreateDirectory: {
    flowScriptName: "createDirectory",
    confirmed: false,
    build: (params) => {
      const path = renderScalar(params.get("path"));
      return path ? `FileSystem.createDirectory(${path})` : null;
    }
  },
  Delete: {
    flowScriptName: "deleteDirectory",
    confirmed: false,
    build: (params) => {
      const path = renderScalar(params.get("path"));
      if (!path) return null;
      const recursive = renderScalar(params.get("recursive"));
      return `FileSystem.deleteDirectory(${path}, {deleteSubdirectories: ${recursive ?? "false"}})`;
    }
  },
  GetDirectories: {
    flowScriptName: "getDirectories",
    confirmed: false,
    build: (params) => {
      const path = renderScalar(params.get("path"));
      return path ? `FileSystem.getDirectories(${path}${buildSearchOptions(params)})` : null;
    }
  },
  GetFiles: {
    flowScriptName: "getFiles",
    confirmed: false,
    build: (params) => {
      const path = renderScalar(params.get("path"));
      return path ? `FileSystem.getFiles(${path}${buildSearchOptions(params)})` : null;
    }
  },
  GetFileNames: {
    flowScriptName: "getFileNames",
    confirmed: false,
    build: (params) => {
      const path = renderScalar(params.get("path"));
      return path ? `FileSystem.getFileNames(${path}${buildSearchOptions(params)})` : null;
    }
  },
  GetSubDirectoryNames: {
    flowScriptName: "getSubDirectoryNames",
    confirmed: false,
    build: (params) => {
      const path = renderScalar(params.get("path"));
      return path ? `FileSystem.getSubDirectoryNames(${path}${buildSearchOptions(params)})` : null;
    }
  }
};
const FILE_FUNCTIONS = {
  WriteAllLines: {
    flowScriptName: "writeText",
    confirmed: true,
    build: (params, warnings) => {
      const path = renderScalar(params.get("path"));
      const lines = renderLinesSequence(params.get("lines"));
      if (!path || !lines) return null;
      const encoding = codePageToEncoding(params.get("codePage"), warnings, "FileSystem.writeText");
      const opts = encoding ? `{encoding: ${JSON.stringify(encoding)}, overwriteIfExist: true}` : "{overwriteIfExist: true}";
      return `FileSystem.writeText(${path}, ${lines}, ${opts})`;
    }
  },
  WriteAllText: {
    flowScriptName: "writeText",
    // Real confirmed (2026-09-13, real customer file "HPHG-05 AEB Sanction List.wap", flow "Log
    // File", item 24 "Write Log Files"): real Classic input identifiers are "path" ({LogFilepath})
    // and "text" ({LogString}) -- NOT "value" as this entry originally guessed by extending the
    // WriteAllLines/other-entries' shared "path"/"value" convention. That guess was wrong (real
    // bug: params.get("value") always missed, build() always returned null, producing a real
    // UNRESOLVED_MIGRATION_MethodCall_* marker for every real WriteAllText call). AppendAllText
    // below still uses the unconfirmed "value" guess -- NOT changed here, since there's no real
    // evidence for it either way; it may turn out to need "text" too, but that's for a real
    // AppendAllText sample to confirm, not to assume from this one.
    confirmed: true,
    build: (params, warnings) => {
      const path = renderScalar(params.get("path"));
      const value = renderScalar(params.get("text"));
      if (!path || !value) return null;
      const encoding = codePageToEncoding(params.get("codePage"), warnings, "FileSystem.writeText");
      const opts = encoding ? `{encoding: ${JSON.stringify(encoding)}, overwriteIfExist: true}` : "{overwriteIfExist: true}";
      return `FileSystem.writeText(${path}, ${value}, ${opts})`;
    }
  },
  AppendAllText: {
    flowScriptName: "appendText",
    confirmed: false,
    build: (params, warnings) => {
      const path = renderScalar(params.get("path"));
      const value = renderScalar(params.get("value"));
      if (!path || !value) return null;
      const encoding = codePageToEncoding(params.get("codePage"), warnings, "FileSystem.appendText");
      return encoding ? `FileSystem.appendText(${path}, ${value}, {encoding: ${JSON.stringify(encoding)}})` : `FileSystem.appendText(${path}, ${value}, {})`;
    }
  },
  AppendAllLines: {
    flowScriptName: "appendText",
    confirmed: false,
    build: (params, warnings) => {
      const path = renderScalar(params.get("path"));
      const lines = renderLinesSequence(params.get("lines"));
      if (!path || !lines) return null;
      const encoding = codePageToEncoding(params.get("codePage"), warnings, "FileSystem.appendText");
      return encoding ? `FileSystem.appendText(${path}, ${lines}, {encoding: ${JSON.stringify(encoding)}})` : `FileSystem.appendText(${path}, ${lines}, {})`;
    }
  },
  ReadAllText: {
    flowScriptName: "readText",
    confirmed: false,
    build: (params) => {
      const path = renderScalar(params.get("path"));
      return path ? `FileSystem.readText(${path})` : null;
    }
  },
  ReadAllLines: {
    flowScriptName: "readLines",
    confirmed: false,
    build: (params) => {
      const path = renderScalar(params.get("path"));
      return path ? `FileSystem.readLines(${path})` : null;
    }
  },
  ReadAllBytes: {
    flowScriptName: "readBinary",
    confirmed: false,
    build: (params) => {
      const path = renderScalar(params.get("path"));
      return path ? `FileSystem.readBinary(${path})` : null;
    }
  },
  WriteAllBytes: {
    flowScriptName: "writeBinary",
    confirmed: false,
    build: (params) => {
      const path = renderScalar(params.get("path"));
      const value = renderScalar(params.get("value"));
      if (!path || !value) return null;
      return `FileSystem.writeBinary(${path}, ${value}, {overwriteIfExist: true})`;
    }
  },
  Exists: {
    flowScriptName: "fileExists",
    confirmed: false,
    build: (params) => {
      const path = renderScalar(params.get("path"));
      return path ? `FileSystem.fileExists(${path})` : null;
    }
  },
  Delete: {
    flowScriptName: "deleteFile",
    confirmed: false,
    build: (params) => {
      const path = renderScalar(params.get("path"));
      return path ? `FileSystem.deleteFile(${path})` : null;
    }
  },
  Copy: {
    flowScriptName: "copyFile",
    confirmed: false,
    build: (params) => {
      const source = renderScalar(params.get("source"));
      const destination = renderScalar(params.get("destination"));
      return source && destination ? `FileSystem.copyFile(${source}, ${destination}, {overwriteIfExist: true})` : null;
    }
  },
  Move: {
    flowScriptName: "moveFile",
    confirmed: false,
    build: (params) => {
      const source = renderScalar(params.get("source"));
      const destination = renderScalar(params.get("destination"));
      return source && destination ? `FileSystem.moveFile(${source}, ${destination}, {overwriteIfExist: true})` : null;
    }
  }
};
function lookupFileSystemFunctionName(identifier, declaringCategory) {
  if (!identifier || !declaringCategory) return null;
  if (declaringCategory.endsWith(DIRECTORY_CATEGORY_SUFFIX)) return DIRECTORY_FUNCTIONS[identifier]?.flowScriptName ?? null;
  if (declaringCategory.endsWith(FILE_CATEGORY_SUFFIX)) return FILE_FUNCTIONS[identifier]?.flowScriptName ?? null;
  return null;
}
function buildFileSystemCallScript(identifier, declaringCategory, inputs) {
  if (!identifier || !declaringCategory) return null;
  const table = declaringCategory.endsWith(DIRECTORY_CATEGORY_SUFFIX) ? DIRECTORY_FUNCTIONS : declaringCategory.endsWith(FILE_CATEGORY_SUFFIX) ? FILE_FUNCTIONS : null;
  if (!table) return null;
  const spec = table[identifier];
  if (!spec) return null;
  const warnings = [];
  const call = spec.build(paramsByIdentifier(inputs), warnings);
  if (!call) return null;
  const openLine = usesSeqModule(call) ? "open Seq;\n" : "";
  return { script: `${openLine}return ${call};`, warnings };
}
export {
  buildFileSystemCallScript,
  lookupFileSystemFunctionName
};
