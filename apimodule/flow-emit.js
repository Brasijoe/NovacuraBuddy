/* ============================================================
   Flow Emit — the generated REST module:

     header comment (source, API title, timestamp)
     runtime preamble (flow-runtime.js)
     enum modules + record types (flow-types.js)
     record mappers
     Queryables          a list GET whose rows are records:
                           let FindPetsByStatusSet = Queryable.Create<...>(restTranslation(), getFindPetsByStatusSetRows);
                         or, when the path needs values first, a function returning one:
                           function OwnerPetsSet(ownerId: number) { return Queryable.Create<...>(...(ownerId, _)); }
     functions           one per selected operation, OData-style:
                           function getPetById(petId: number, headers: Header* = []): Pet { ... }
   ============================================================ */
(function (global) {
  const SpecModel = typeof require === "function" ? require("./spec-model.js") : global.ApiSpecModel;
  const FlowTypes = typeof require === "function" ? require("./flow-types.js") : global.ApiFlowTypes;
  const FlowRuntime = typeof require === "function" ? require("./flow-runtime.js") : global.ApiFlowRuntime;
  const { toIdentifier } = FlowTypes;

  const RUNTIME_NAMES = [
    "basePath", "restTranslation", "restOp", "restIsNode", "restLiteral", "restGet", "restOpOf", "restFieldName", "restFilter", "restParamName",
    "restParams", "restRequire", "restMember", "restValueOf", "restCompare", "restLike", "restTest", "restKeep", "restOrder", "restShape", "restText",
    "restPath", "restQueryString", "restHeaders", "restRemap", "restJsonBody", "restFormBody", "whenNotNull", "enumMapping",
    "mappingFinderFunction", "recordMappingFunction", "fromTextFunction", "renamerFunction", "HandleHeaders",
    "MergeHeaders", "HandleFailedRequest", "HandleHTTPResponse", "addBasePath", "GetResponse", "PostResponse",
    "PatchResponse", "PutResponse", "DeleteResponse", "HandleHTTPResponseBinary", "PostResponseBinary",
    "PatchResponseBinary", "PutResponseBinary", "headers", "input", "body"
  ];

  // Standard-library names: Flow rejects a parameter that shadows one ("The identifier 'left' is
  // already declared", live 2026-10-21), so an API parameter called `filter` becomes `filter_`.
  const STDLIB_NAMES = new Set([
    "upper", "lower", "len", "left", "right", "mid", "trim", "instr", "replace", "split", "join", "chr", "str",
    "regexmatch", "regexmatches", "regexreplace", "urlencode", "urldecode", "guid", "ceil", "floor", "round", "max",
    "min", "pow", "val", "isnumber", "isnan", "random", "isnull", "isnullorempty", "identity", "unsafecast", "now",
    "date", "todate", "format", "first", "firstornull", "firstordefault", "last", "lastornull", "count", "any", "take",
    "skip", "eval", "flatten", "range", "sum", "map", "filter", "collect", "choose", "fold", "scan", "tolookup",
    "groupby", "orderby", "orderbydescending", "distinctby", "zip", "reverse", "indexed", "exists", "forall",
    "contains", "concat", "append", "prepend", "takewhile", "skipwhile", "memoize", "uncurry", "seq", "record",
    "json", "http", "text", "math", "datetime", "try", "q", "condition", "params", "raw"
  ]);

  const isJson = (contentType) => !!contentType && /^application\/json\b|[/+]json\b/i.test(contentType);
  const quote = (s) => `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  const docText = (s) => String(s || "").replace(/\*\//g, "* /").replace(/\s+/g, " ").trim();
  /** One line for a doc comment: the summary, or the description's first sentence, capped. */
  const docLine = (op) => {
    const text = docText(op.summary || String(op.description || "").split(/(?<=\.)\s|\n/)[0]);
    return text.length > 200 ? text.slice(0, 197) + "..." : text;
  };

  /** Flowscript type of a parameter: scalars and sequences of scalars; enums are passed as text. */
  function paramType(schema, deref) {
    const s = deref(schema || {});
    const t = Array.isArray(s.type) ? s.type.find((x) => x !== "null") : s.type;
    if (t === "array") return `${paramType(s.items, deref)}*`;
    if (t === "integer" || t === "number") return "number";
    if (t === "boolean") return "boolean";
    return "text";
  }

  /** Path template -> Flowscript template literal text, each `{param}` URL-encoded. */
  function pathExpr(pathKey, argNames) {
    const escaped = pathKey.split(/(\{[^}]+\})/).map((part) => {
      const m = part.match(/^\{([^}]+)\}$/);
      return m ? `{restPath(${argNames.get(m[1]) || toIdentifier(m[1])})}` : part.replace(/`/g, "\\`");
    });
    return escaped.join("");
  }

  function paramsExpr(queryParams, argNames, deref) {
    if (!queryParams.length) return "[]";
    const parts = queryParams.map((p) => {
      const arg = argNames.get(p.name);
      const isArray = paramType(p.schema, deref).endsWith("*");
      if (!isArray) return `[new RestParam { name: ${quote(p.name)}, value: restText(${arg}) }]`;
      if (p.explode === false) {
        return `(case when ${arg}.any() then [new RestParam { name: ${quote(p.name)}, value: ${arg}.map(restText).join(',') }] else [] end)`;
      }
      return `${arg}.map(v => new RestParam { name: ${quote(p.name)}, value: restText(v) }).eval()`;
    });
    return parts.join(" & ");
  }

  function generateModule(model, options = {}) {
    const moduleName = toIdentifier(options.moduleName || model.title);
    const selected = options.selectedIds ? new Set(options.selectedIds) : null;
    const ops = model.operations.filter((o) => !selected || selected.has(o.id));
    const deref = model.deref;
    const registry = FlowTypes.createTypeRegistry(model, { namespace: moduleName, reserved: RUNTIME_NAMES });
    const warnings = [...model.warnings];

    // Function names first, so types never take an operation's name.
    const fnNames = new Map(ops.map((op) => [op.id, registry.claimName(op.id)]));

    const queryables = [];
    const functions = [];

    for (const op of ops) {
      const fnName = fnNames.get(op.id);
      const pathParams = op.params.filter((p) => p.in === "path");
      const queryParams = op.params.filter((p) => p.in === "query");
      const headerParams = op.params.filter((p) => p.in === "header");
      const argNames = new Map();
      const usedArgs = new Set(["headers", "input", "body", ...STDLIB_NAMES]);
      for (const p of [...pathParams, ...queryParams, ...headerParams]) {
        let a = toIdentifier(p.name);
        for (let i = 2; usedArgs.has(a.toLowerCase()); i++) a = `${toIdentifier(p.name)}_${i}`;
        usedArgs.add(a.toLowerCase());
        argNames.set(p.name, a);
      }
      const argDecl = (p, optional) => {
        const t = paramType(p.schema, deref);
        if (!optional) return `${argNames.get(p.name)}: ${t}`;
        return t.endsWith("*") ? `${argNames.get(p.name)}: ${t} = []` : `${argNames.get(p.name)}: ${t}? = null`;
      };

      const headerExpr = headerParams.length
        ? `MergeHeaders(restHeaders([${headerParams.map((p) => `{ Name: ${quote(p.name)}, Value: restText(${argNames.get(p.name)}) }`).join(", ")}]), headers)`
        : "headers";

      // ---- request body ----
      let bodyArg = null;
      let bodyExpr = null;
      let bodyHeaders = headerExpr;
      let binaryBody = false;
      if (op.body) {
        const ct = op.body.contentType;
        if (isJson(ct)) {
          bodyArg = `input: ${registry.typeOf(op.body.schema, `${fnName}_Input`, "request")}`;
          bodyExpr = "restJsonBody(input)";
        } else if (/x-www-form-urlencoded/i.test(ct)) {
          const t = registry.typeOf(op.body.schema, `${fnName}_Input`, "request");
          bodyArg = `input: ${t === "any" ? "{}" : t}`;
          bodyExpr = "restFormBody(input)";
        } else if (/^text\//i.test(ct)) {
          bodyArg = "body: text";
          bodyExpr = "body";
        } else {
          bodyArg = "body: binary";
          bodyExpr = "body";
          binaryBody = true;
        }
        if (!/^application\/json$/i.test(ct)) {
          bodyHeaders = `MergeHeaders([{ Name: 'Content-Type', Value: ${quote(ct)} }], ${headerExpr})`;
        }
      }

      // ---- response ----
      const resp = op.response;
      const jsonResponse = resp && resp.schema && isJson(resp.contentType);
      const respType = jsonResponse ? registry.typeOf(resp.schema, `${fnName}_Result`) : null;

      // ---- arguments: path, required query, body, optional query, headers ----
      const requiredQuery = queryParams.filter((p) => p.required);
      const optionalQuery = queryParams.filter((p) => !p.required);
      const args = [
        ...pathParams.map((p) => argDecl(p, false)),
        ...requiredQuery.map((p) => argDecl(p, false)),
        ...(bodyArg ? [bodyArg] : []),
        ...optionalQuery.map((p) => argDecl(p, true)),
        ...headerParams.map((p) => argDecl(p, !p.required)),
        "headers: Header* = []"
      ];
      const url = `\`${pathExpr(op.path, argNames)}${queryParams.length ? `{restQueryString(${paramsExpr(queryParams, argNames, deref)})}` : ""}\``;
      const doc = `/** ${op.method.toUpperCase()} ${op.path}${docLine(op) ? ` — ${docLine(op)}` : ""}${op.deprecated ? " (deprecated)" : ""} */`;

      let call;
      if (op.method === "get") call = `GetResponse(${url}, ${bodyHeaders})`;
      else if (op.method === "delete") call = `DeleteResponse(${url}, ${bodyHeaders})`;
      else {
        const helper = { post: "Post", put: "Put", patch: "Patch" }[op.method] + "Response" + (binaryBody ? "Binary" : "");
        call = `${helper}(${url}, ${bodyExpr || (binaryBody ? "body" : "''")}, ${bodyHeaders})`;
      }

      let body;
      let returnType = "";
      if (op.method === "delete" && !jsonResponse) {
        body = `    return ${call};`;
      } else if (binaryBody || !jsonResponse || respType === "any" || /^(text|number|boolean|datetime|binary)\*?$/.test(respType)) {
        body = `    return ${call};`;
        if (!binaryBody) returnType = ": text";
      } else if (respType.endsWith("*")) {
        const mapper = registry.recordMapperName(respType.slice(0, -1));
        body = [
          `    let __raw = JSON.deserialize<{}*>(${call});`,
          mapper ? `    return unsafeCast<${respType}>(__raw.map(r => Record.mapValues(r, ${mapper})).eval());` : `    return unsafeCast<${respType}>(__raw);`
        ].join("\n");
        returnType = `: ${respType}`;
      } else {
        const mapper = registry.isRecord(respType) ? registry.recordMapperName(respType) : null;
        body = [
          `    let __raw = JSON.deserialize<{}>(${call});`,
          mapper ? `    return unsafeCast<${respType}>(Record.mapValues(__raw, ${mapper}));` : `    return unsafeCast<${respType}>(__raw);`
        ].join("\n");
        returnType = `: ${respType}`;
      }
      functions.push(`${doc}\nfunction ${fnName}(${args.join(", ")})${returnType} {\n${body}\n}`);

      // ---- Queryable for a list GET of records ----
      if (op.method !== "get" || !jsonResponse) continue;
      const shape = SpecModel.listShape(resp.schema, deref);
      if (!shape) continue;
      const rowType = registry.typeOf(shape.item, `${fnName}_Row`);
      if (!registry.isRecord(rowType)) continue;
      const setName = registry.claimName(`${SpecModel.pascal(op.id)}Set`);
      const rowsName = registry.claimName(`get${setName}Rows`);
      // Only path parameters (and required headers) make it a function; every query parameter,
      // required ones included, is set from `where`, so a plain list GET stays a `let` data source
      // the Designer lists (live 2026-10-21: function-shaped ones didn't show up).
      const fixedArgs = pathParams;
      const rowHeaderParams = headerParams.filter((p) => p.required);
      const whereParams = queryParams;
      const rowMapper = registry.recordMapperName(rowType);
      const rowsHeaders = rowHeaderParams.length
        ? `MergeHeaders(restHeaders([${rowHeaderParams.map((p) => `{ Name: ${quote(p.name)}, Value: restText(${argNames.get(p.name)}) }`).join(", ")}]), headers)`
        : "[]";
      const rowsUrl = `\`${pathExpr(op.path, argNames)}{restQueryString(params)}\``;
      const raw = shape.wrapper
        ? `unsafeCast<{}*>(restMember(JSON.deserialize<{}>(GetResponse(${rowsUrl}, ${rowsHeaders})), ${quote(shape.wrapper)}))`
        : `JSON.deserialize<{}*>(GetResponse(${rowsUrl}, ${rowsHeaders}))`;
      const whereList = `[${whereParams.map((p) => quote(p.name)).join(", ")}]`;
      const requiredList = `[${requiredQuery.map((p) => quote(p.name)).join(", ")}]`;
      const fnArgs = [
        ...fixedArgs.map((p) => argDecl(p, false)),
        ...rowHeaderParams.map((p) => argDecl(p, false)),
        ...(rowHeaderParams.length ? ["headers: Header*"] : [])
      ];
      const rowsFn = [
        `private function ${rowsName}(${[...fnArgs, "q: Queryable.QuerySpec<text>"].join(", ")}): {}* {`,
        "    let condition = restFilter(q);",
        requiredQuery.length
          ? `    let params = restRequire(restParams(condition, ${whereList}), ${requiredList});`
          : `    let params = restParams(condition, ${whereList});`,
        `    let raw = ${raw};`,
        `    return restShape(restKeep(raw, condition, ${whereList}), q, ${rowMapper ? `r => Record.mapValues(r, ${rowMapper})` : "identity"});`,
        "}"
      ].join("\n");
      const create = `Queryable.Create<RestQueryTranslation, ${rowType}, text>(restTranslation()`;
      const sent = whereParams.map((p) => p.name + (p.required ? " (required)" : ""));
      const doc2 = `/** ${op.method.toUpperCase()} ${op.path} as a data source: \`where\` on ${sent.length ? sent.join(", ") : "nothing"} is sent to the API, everything else is filtered in memory. */`;
      if (!fnArgs.length) {
        queryables.push(`${rowsFn}\n\n${doc2}\nlet ${setName} = ${create}, ${rowsName});`);
      } else {
        const outerArgs = [...fnArgs.slice(0, -1), ...(rowHeaderParams.length ? ["headers: Header* = []"] : fnArgs.slice(-1))];
        const passArgs = [...fixedArgs, ...rowHeaderParams].map((p) => argNames.get(p.name)).concat(rowHeaderParams.length ? ["headers"] : []);
        queryables.push(`${rowsFn}\n\n${doc2}\nfunction ${setName}(${outerArgs.join(", ")}) {\n    return ${create}, ${rowsName}(${passArgs.join(", ")}, _));\n}`);
      }
    }

    warnings.push(...registry.warnings());
    const now = options.now || new Date();
    const stamp = now.toISOString().slice(0, 19).replace("T", " ");
    const header = [
      "/*",
      `Source: ${docText(options.source || "")}`,
      `API: ${docText(model.title)} ${docText(model.version)}${options.specVersion ? ` (${options.specVersion})` : ""}`,
      `Auto generated code: ${stamp} (NovacuraBuddy${options.generatorVersion ? " " + options.generatorVersion : ""})`,
      "Base URL and authentication come from the connector; this module only adds the base path below.",
      "*/"
    ].join("\r\n");

    const decls = registry.declarations();
    const sections = [
      header,
      FlowRuntime.runtimePreamble(model.basePath),
      "/* ---------- Enumerations ---------- */",
      ...decls.filter((d) => d.kind === "enum").map((d) => d.text),
      "/* ---------- Types ---------- */",
      ...decls.filter((d) => d.kind === "record").map((d) => d.text),
      ...(registry.mapperDeclarations().length ? ["/* ---------- Enum mappings ---------- */", ...registry.mapperDeclarations()] : []),
      ...(queryables.length ? ["/* ---------- Data sources ---------- */", ...queryables] : []),
      "/* ---------- Operations ---------- */",
      ...functions
    ];
    return {
      code: sections.join("\n\n") + "\n",
      moduleName,
      warnings,
      queryableCount: queryables.length,
      functionCount: functions.length
    };
  }

  /** Which operations would become Queryables (for the picker's badge), without emitting. */
  function queryableIds(model) {
    const registry = FlowTypes.createTypeRegistry(model, { reserved: RUNTIME_NAMES });
    return model.operations.filter((op) => {
      const r = op.response;
      if (op.method !== "get" || !r || !r.schema || !isJson(r.contentType)) return false;
      const shape = SpecModel.listShape(r.schema, model.deref);
      return !!shape && registry.isRecord(registry.typeOf(shape.item, `${op.id}_Row`));
    }).map((op) => op.id);
  }

  const api = { generateModule, queryableIds, paramType, pathExpr };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.ApiFlowEmit = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
