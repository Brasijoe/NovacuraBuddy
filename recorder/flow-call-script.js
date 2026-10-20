/* ============================================================
   Flow Call Script — turns one recorded IFS Cloud call into the
   FlowScript body of a script step, calling into the matching
   auto-generated module function.

   GET  -> "open Module;\nreturn select * from EntitySet"
   write -> resolve a candidate module function by name (verified
            against the module's own generated source, never guessed
            blind), declare a typed `input` from the recorded request
            body, and call it. Values are hardcoded as recorded —
            no variables, no dependency mapping (later phases).
   ============================================================ */
(function (global) {
  /** Strips the scheme+host off an absolute URL, leaving the relative path+query (no leading
   *  slash) — e.g. "https://host/main/ifsapplications/projection/v1/X.svc/$batch" ->
   *  "main/ifsapplications/projection/v1/X.svc/$batch". Real bug, live, 2026-08-10: "You can not
   *  set an absolute url in Flow Developer when Base url exists" — buildBatchCallIfs hands
   *  batchEndpoint straight to HTTP.request (unlike every other GET/write call in this codebase,
   *  which goes through the module's own request()/addBasePath), so it needs the same relative
   *  form addBasePath produces for every other call, not the recorded call's absolute URL as-is.
   *  Returns the input unchanged if it isn't a parseable absolute URL (defensive). */
  function stripUrlOrigin(url) {
    try {
      const u = new URL(url);
      return u.pathname.replace(/^\//, "") + u.search;
    } catch (e) {
      return url;
    }
  }

  function extractSvcName(url) {
    const m = String(url || "").match(/([A-Za-z0-9_]+)\.svc/i);
    return m ? m[1] : null;
  }

  function pathAfterSvc(url) {
    const m = String(url || "").match(/\.svc(\/[^?]*)?/i);
    if (!m) return "";
    return (m[1] || "").replace(/^\//, "");
  }

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

  function parseFirstSegment(segment) {
    const m = segment.match(/^([^(]+)(?:\((.*)\))?$/);
    return { entitySetName: m[1], keyLiteral: m[2] || null };
  }

  function splitKeyValues(keyLiteral) {
    return splitTopLevel(keyLiteral, ",").map((seg) => {
      const trimmed = seg.trim();
      const m = trimmed.match(/^[A-Za-z0-9_]+=(.*)$/);
      return m ? m[1] : trimmed;
    });
  }

  /** Safe percent-decode for a key-segment string — IFS occasionally embeds a literal "%" that
   *  isn't part of a real escape (e.g. a percentage value), which would otherwise throw. */
  function safeDecodeURIComponent(text) {
    try {
      return decodeURIComponent(text);
    } catch (e) {
      return text;
    }
  }

  /** Un-escapes OData's doubled-single-quote string escaping (`O''Brien` -> `O'Brien`) after
   *  percent-decoding — percent-encoding is the URL transport layer, doubled-quote escaping is
   *  OData's own layer underneath it, so undo transport first. */
  function decodeODataString(text) {
    return safeDecodeURIComponent(text).replace(/''/g, "'");
  }

  /** Case-insensitive header lookup — real captures vary header-name casing (Content-Type vs
   *  content-type) depending on capture layer. */
  function getHeader(headers, name) {
    if (!headers) return null;
    const lower = String(name).toLowerCase();
    const key = Object.keys(headers).find((k) => k.toLowerCase() === lower);
    return key ? headers[key] : null;
  }

  /** Extracts the MIME boundary from a multipart Content-Type header value, e.g.
   *  "multipart/mixed;boundary=fa842d2d-..." -> "fa842d2d-...". null if the header isn't a
   *  multipart Content-Type at all. */
  function extractBatchBoundary(contentTypeHeaderValue) {
    const value = String(contentTypeHeaderValue || "");
    if (!/^multipart\/mixed/i.test(value.trim())) return null;
    const m = value.match(/boundary=([^;]+)/i);
    return m ? m[1].trim() : null;
  }

  /** True for a recorded OData batch call: POST to a path whose only segment is "$batch", with a
   *  multipart/mixed Content-Type. IFS Connect modules don't support batch calls via generated
   *  module functions (yet) — buildCallScript routes this to buildBatchCallScript instead of the
   *  normal per-call function-resolution path. */
  function isBatchCall(call) {
    if (String(call.method || "").toUpperCase() !== "POST") return false;
    const segments = pathAfterSvc(call.url).split("/").filter(Boolean);
    if (segments.length !== 1 || segments[0] !== "$batch") return false;
    return extractBatchBoundary(getHeader(call.requestHeaders, "Content-Type")) !== null;
  }

  /** Splits a multipart/mixed body into each part's raw text (MIME headers + blank line +
   *  request-line + sub-headers + optional body). The closing "--boundary--" and any
   *  empty/whitespace-only fragments are dropped. */
  function splitMultipartParts(body, boundary) {
    if (!body || !boundary) return [];
    const delimiter = `--${boundary}`;
    return body.split(delimiter)
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk && chunk !== "--");
  }

  /** Extracts the inner HTTP request line from one multipart part's raw text, e.g.
   *  "...\n\nGET CustomerOrderSet(OrderNo='%2A1103')?$select=... HTTP/1.1\nAccept:..." ->
   *  {method: "GET", pathAndQuery: "CustomerOrderSet(OrderNo='%2A1103')?$select=..."}. null if no
   *  recognizable request-line is found (defensive — the caller falls back to a TODO placeholder
   *  for that one part). Note: pathAndQuery can contain embedded spaces (e.g. in a $filter query
   *  parameter like `CustomerNo eq 'ABC'`), so the regex uses non-greedy matching (.+?) to capture
   *  up to the final " HTTP/1.<digit>" sequence rather than stopping at the first space. */
  function parseBatchPartRequestLine(partText) {
    // Use .+? (non-greedy) instead of \S+ to tolerate spaces in path/query (e.g., $filter values).
    // A space-containing path like "CustomerOrderSet?$filter=CustomerNo eq 'ABC'" must match as a
    // whole, not stop at the first space after "CustomerOrderSet".
    const m = String(partText || "").match(/^([A-Z]+)\s+(.+?)\s+HTTP\/1\.\d/m);
    return m ? { method: m[1], pathAndQuery: m[2] } : null;
  }

  /** Same simple-quoted-string recognition as keyValueToLiteral/keyValueToJs, but returns the RAW
   *  (still percent-encoded) inner text instead of decoding it — a batch sub-request's key value
   *  is embedded as literal wire text (built by hand via string concatenation), not decoded and
   *  re-encoded by a module function's own URL-building the way a normal call's key value is. Only
   *  the OData '' quote-doubling is undone (wire syntax, not data encoding) — see
   *  buildBatchIfsFunctionExpr for how this feeds into a substitutable concatenation piece. null
   *  for anything that isn't a simple quoted string — a bare null/numeric/namespace-qualified enum
   *  literal key value isn't split into a substitutable piece in v1 (see the design spec's scope
   *  note). */
  function rawQuotedODataValue(raw) {
    const trimmed = String(raw || "").trim();
    const quoted = trimmed.match(/^'(.*)'$/);
    return quoted ? quoted[1].replace(/''/g, "'") : null;
  }

  /** Builds a batch sub-request's ifsFunction as a FlowScript string expression: a single
   *  JSON.stringify'd literal if no key value is a simple quoted string, otherwise a
   *  &-concatenation with each such value as its own standalone piece (never embedded mid-string
   *  — that's what lets the existing bare-literal substitution search, and wrapLikeReference's new
   *  "urlEncode" case, work unchanged). Pushes a value slot per substitutable value onto
   *  valueSlots in place. */
  /** Like splitKeyNames, but keeps a null placeholder for an unnamed segment instead of
   *  dropping it — needed wherever a name must stay positionally aligned with splitKeyValues'
   *  own output (splitKeyNames' own filtering is fine for its one caller, function-overload
   *  scoring, which only cares which names exist, never their position). */
  function splitKeyNamesPositional(keyLiteral) {
    return splitTopLevel(keyLiteral, ",").map((seg) => {
      const m = seg.trim().match(/^([A-Za-z0-9_]+)=/);
      return m ? m[1] : null;
    });
  }

  function buildBatchIfsFunctionExpr(pathAndQuery, keyLiteral, partIndex, valueSlots) {
    let remaining = pathAndQuery;
    const pieces = [];
    const keyNames = splitKeyNamesPositional(keyLiteral);
    splitKeyValues(keyLiteral).forEach((raw, i) => {
      const rawInner = rawQuotedODataValue(raw);
      if (rawInner === null) return; // bare null/numeric/enum-literal - not split in v1
      const quotedForm = `'${rawInner}'`;
      const idx = remaining.indexOf(quotedForm);
      if (idx === -1) return; // defensive - shouldn't happen for a value just parsed out of this same string
      const before = remaining.slice(0, idx);
      pieces.push(JSON.stringify(`${before}'`));
      // Real bug, live, 2026-08-10: a bare positional index ("batch[0].0") became a
      // classify-modal field name/variable name of literally "0" when this value went unmapped
      // — invalid as a Flow variable name, meaningless as a label. Use the segment's real key
      // NAME when it has one (the common real-world case — a batch sub-request's OData key
      // segment is typically named, e.g. "OrderNo=..."), falling back to the index only for a
      // genuinely unnamed positional key. Doesn't affect substitution — a batch call's script
      // text never has a "FieldName: literal" record shape for the qualified search to match
      // regardless, so this is a display-only improvement.
      const fieldNameHint = keyNames[i] || i;
      valueSlots.push({
        path: `batch[${partIndex}].${fieldNameHint}`,
        value: safeDecodeURIComponent(rawInner),
        literal: JSON.stringify(rawInner),
        kind: "text",
        nullable: false,
        valueNullable: false,
        wrapKind: "urlEncode"
      });
      pieces.push(JSON.stringify(rawInner));
      remaining = `'${remaining.slice(idx + quotedForm.length)}`;
    });
    pieces.push(JSON.stringify(remaining));
    return pieces.length === 1 ? pieces[0] : pieces.join(" & ");
  }

  /** Builds one batch sub-request's {functionMethod, ifsFunction, jsonBody} content entry (v1:
   *  only a bodyless GET with a (...)  key segment gets substitutable pieces — see the design
   *  spec's scope note for what falls back to an opaque literal and why). */
  function buildBatchPart(partIndex, partText, valueSlots) {
    const requestLine = parseBatchPartRequestLine(partText);
    if (!requestLine) {
      return { functionMethod: "GET", ifsFunctionExpr: JSON.stringify("/* TODO: could not parse batch part */"), jsonBody: '""' };
    }
    const { method, pathAndQuery } = requestLine;

    // A part's own sub-request body (if any) is whatever follows the SECOND blank-line-separated
    // block in the part text — the first blank line separates the outer MIME headers
    // (Content-Type: application/http) from the request-line + its own headers, the second
    // separates those headers from the sub-request's actual body.
    const blankLines = [...partText.matchAll(/\r?\n\r?\n/g)];
    const hasBody = blankLines.length >= 2 && partText.slice(blankLines[1].index + blankLines[1][0].length).trim().length > 0;

    if (method !== "GET" || hasBody) {
      return {
        functionMethod: method,
        ifsFunctionExpr: JSON.stringify(pathAndQuery),
        jsonBody: hasBody ? JSON.stringify("/* TODO: batch write body not yet supported */") : '""'
      };
    }

    const qIdx = pathAndQuery.indexOf("?");
    const pathOnly = qIdx === -1 ? pathAndQuery : pathAndQuery.slice(0, qIdx);
    const { keyLiteral } = parseFirstSegment(pathOnly);
    if (!keyLiteral) {
      return { functionMethod: method, ifsFunctionExpr: JSON.stringify(pathAndQuery), jsonBody: '""' };
    }

    return {
      functionMethod: method,
      ifsFunctionExpr: buildBatchIfsFunctionExpr(pathAndQuery, keyLiteral, partIndex, valueSlots),
      jsonBody: '""'
    };
  }

  /** Real bug, 2026-08-07 (`ValidateClassificationDefaults(Param1=null,Param2=null,...)`): OData
   *  represents an absent/null function parameter as the BARE (unquoted) keyword `null` in the
   *  URL — not the same as a real string that happens to spell "null" (that would come quoted,
   *  `'null'`). Only `raw === undefined` (a key segment missing entirely) was treated as null;
   *  the literal text "null" fell through to the generic branch and got quoted into the 4-char
   *  string `"null"` instead of the FlowScript `null` keyword. Checked before the quoted-string
   *  match so a genuinely-quoted `'null'` still renders as the text literal, unaffected. */
  function keyValueToLiteral(raw) {
    if (raw === undefined) return "null";
    const trimmed = raw.trim();
    if (trimmed === "null") return "null";
    // Same bare-keyword class of bug as null above, just for booleans: OData represents a
    // boolean key value as the bare (unquoted) keyword true/false — a genuinely-quoted 'true'
    // (checked first via the fallthrough below, not here) still means the literal text. Real
    // bug, 2026-08-08 (ValidateAddressNo(...,DeliveryAddress=true,...)): never hit until a call
    // with a bare boolean key value came up — "true" fell through to the generic branch and got
    // quoted as 4-char text instead of the FlowScript boolean keyword.
    if (trimmed === "true" || trimmed === "false") return trimmed;
    const quoted = trimmed.match(/^'(.*)'$/);
    if (quoted) return JSON.stringify(decodeODataString(quoted[1]));
    // OData enum/complex-type literal: Namespace.Path.TypeName'Value' — e.g.
    // IfsApp.SalesQuotationHandling.Lookup_IsoCountry'US'. Real bug, 2026-08-07: unrecognized by
    // the plain-quoted check above (that one requires the string to START with a quote — this
    // format has a namespace path before it), fell through to the generic branch and got
    // embedded WHOLE (namespace, type name, quotes and all) as the fromText(...) argument
    // instead of just the value ("US").
    const enumLiteral = trimmed.match(/^[\w.]+'(.*)'$/);
    if (enumLiteral) return JSON.stringify(decodeODataString(enumLiteral[1]));
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;
    // Real bug, 2026-08-07 ('NC%20LABS' rendered literally instead of "NC LABS"): key segments
    // are URL path text and stay percent-encoded until explicitly decoded.
    return JSON.stringify(safeDecodeURIComponent(trimmed));
  }

  /** Same parsing as keyValueToLiteral, but returns the real JS value (string/number) instead
   *  of FlowScript literal text — used so the dependency tracer can compare key values against
   *  JSON response/request bodies by actual value, not by source-text form. Same OData bare-null/
   *  enum-literal/percent-decoding handling as keyValueToLiteral. */
  function keyValueToJs(raw) {
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    if (trimmed === "null") return null;
    if (trimmed === "true" || trimmed === "false") return trimmed === "true";
    const quoted = trimmed.match(/^'(.*)'$/);
    if (quoted) return decodeODataString(quoted[1]);
    const enumLiteral = trimmed.match(/^[\w.]+'(.*)'$/);
    if (enumLiteral) return decodeODataString(enumLiteral[1]);
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    return safeDecodeURIComponent(trimmed);
  }

  /** depth: nesting level, 0 at the top (matches buildRecordLiteral's own top-level 2-space
   *  indent — a nested object/array one level in lines up one indent step further). Requested
   *  2026-08-10: a nested record/array (e.g. ValidationRec) used to render single-line/compact
   *  regardless of size — real write records routinely nest a 10+ field structure the same way
   *  the top level already got line-broken for (see buildRecordLiteral's own comment), so nested
   *  values get the same one-entry-per-line treatment now, indented one step deeper per level. */
  function toFlowScriptLiteral(value, depth) {
    depth = depth || 0;
    const pad = "  ".repeat(depth + 1);
    const closePad = "  ".repeat(depth);
    if (value === null || value === undefined) return "null";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) {
      if (value.length === 0) return "[]";
      const entries = value.map((v) => `${pad}${toFlowScriptLiteral(v, depth + 1)}`);
      return `[\n${entries.join(",\n")}\n${closePad}]`;
    }
    if (typeof value === "object") {
      const keys = Object.keys(value);
      if (keys.length === 0) return "{}";
      const entries = keys.map((k) => `${pad}${k}: ${toFlowScriptLiteral(value[k], depth + 1)}`);
      return `{\n${entries.join(",\n")}\n${closePad}}`;
    }
    return JSON.stringify(String(value));
  }

  /** Extracts the enum module name from a declared field type, e.g. "CHimaSys.Value" -> "CHimaSys",
   *  "CHimaSys.Value?" -> "CHimaSys". Returns null for non-enum types. Confirmed live: a plain
   *  string literal satisfies an enum-typed field in a `where`-clause comparison (the query
   *  translator is lenient at runtime) but NOT as a record-literal field value (statically
   *  type-checked) — that call must go through the enum module's own `fromText` conversion
   *  function instead (verified present in every enum module in this codebase's generated source). */
  function enumModuleName(typeStr) {
    const base = String(typeStr || "").trim().replace(/\?$/, "");
    const m = base.match(/^(\w+)\.Value$/);
    return m ? m[1] : null;
  }

  /** Renders a JS value as a FlowScript literal, routing enum-typed fields through their
   *  module's fromText(...) conversion instead of a bare string (see enumModuleName). Confirmed
   *  live: the enum module reference needs the containing service module's name prefixed
   *  (`SalesQuotationHandling.CHimaSys.fromText(...)`, not just `CHimaSys.fromText(...)`) even
   *  though CHimaSys/CPackageType are declared top-level in the same generated source file —
   *  `open X;` alone doesn't put them in scope by short name. */
  /** Real confirmed bug (2026-08-07, real recorded "create Part" session — StdNameId/
   *  FreightFactor both real number-typed fields, both recorded by OData as JSON STRINGS
   *  "0"/"1", the standard OData serialization convention for Decimal/Int64): a number-typed
   *  field whose recorded VALUE happens to be a JS string fell all the way through to
   *  toFlowScriptLiteral's own `typeof value === "string"` branch, which always quotes it as a
   *  TEXT literal — Connect statically type-checks a record literal's field values (same
   *  "record literal vs where-clause" distinction already confirmed for enum fields, see
   *  enumModuleName's own doc comment above), so a quoted "1" for a real `number`-typed field
   *  is a genuine type mismatch. Same fix shape as the enum case: detect the declared type
   *  (via classifyFlowType) and convert BEFORE falling through to the generic renderer. Only
   *  converts a string that parses cleanly to a real number — an unparseable string is left to
   *  the generic (quoted-text) fallback rather than emit an invalid bare token. */
  /** moduleSource (optional): when the declared type is itself another record type — not
   *  enum/number/text/boolean/datetime — recurse into ITS OWN declared fields (findRecordTypeFields)
   *  instead of falling to the generic (type-blind) renderer. Real bug, live, 2026-08-10:
   *  ValidationRec's OWN type now resolves correctly (CustOrdLineValidation, synthesized by
   *  applyAnyTypedFieldWorkaround) but this lookup only ever went one level deep before — a
   *  NESTED field inside it (Identity4, a real number field) still rendered as quoted text since
   *  nothing ever looked up Identity4's own declared type. Bounded/proportional fix: ONE
   *  findRecordTypeFields call per actual nesting level actually encountered in the recorded
   *  data, not a whole-module scan per field — a different, much narrower fix than the reverted
   *  findFieldTypeAnywhere approach (see that bug's own note for why the scan-everything version
   *  caused a real perf regression). Without moduleSource (existing callers), behaves exactly as
   *  before — nested records still fall to the generic renderer. */
  function formatValueForType(jsValue, typeStr, moduleName, depth, moduleSource) {
    // A declared type can be a SEQUENCE ("text*") or a SINGULAR value ("text?"/"text") —
    // classifyFlowType's own kind classification strips the "*" and can't tell them apart, but
    // the raw type string still carries it here. toFlowScriptLiteral's array branch doesn't know
    // about declared types at all, so a recorded JS array value assigned into a field declared
    // SINGULAR always rendered as a real FlowScript array literal regardless — real bug, live,
    // 2026-08-11: PrepareSelectedPickListLines_Input.PickListSelection, recorded as a one-element
    // JSON array (IFS's own convention for a "selection" field, even for a single pick), got
    // rendered as `[value]` even though the function's own declared parameter is singular text? —
    // server rejected it, "has type text* but expected text?". Fixed: when the declared type is
    // positively singular (no trailing "*") and the recorded value is a JS array, unwrap to its
    // first element before any further rendering. A multi-element array assigned to a genuinely
    // singular field is a real data-shape conflict no amount of guessing fixes cleanly — same
    // "best-effort, no safe generic answer" residual risk already accepted elsewhere in this
    // file; taking the first element is still strictly better than a guaranteed type error.
    if (Array.isArray(jsValue) && !String(typeStr || "").trim().endsWith("*")) {
      return formatValueForType(jsValue.length > 0 ? jsValue[0] : null, typeStr, moduleName, depth, moduleSource);
    }
    const enumType = enumModuleName(typeStr);
    if (enumType && typeof jsValue === "string") {
      return `${moduleName}.${enumType}.fromText(${JSON.stringify(jsValue)})`;
    }
    if (classifyFlowType(typeStr).kind === "number" && typeof jsValue === "string" && jsValue.trim() !== "" && !isNaN(Number(jsValue))) {
      return String(Number(jsValue));
    }
    if (moduleSource && jsValue && typeof jsValue === "object" && !Array.isArray(jsValue)) {
      const baseType = String(typeStr || "").trim().replace(/[?*]+$/, "");
      const nestedFields = findRecordTypeFields(moduleSource, baseType);
      if (nestedFields) return buildRecordLiteral(jsValue, nestedFields, moduleName, moduleSource, depth);
    }
    return toFlowScriptLiteral(jsValue, depth);
  }

  /** One field per line, 2-space indented, closing brace on its own line — readability for
   *  real write records, which routinely carry 10-30+ fields (e.g. OrderQuotationInsertRequest).
   *  Nested records/arrays get the same line-broken treatment, one indent step deeper per
   *  nesting level (requested 2026-08-10 — a nested structure can carry just as many fields as
   *  the top level does); a nested field whose OWN declared type is resolvable (moduleSource
   *  given) recurses back into this same function via formatValueForType, so type-aware
   *  rendering (enum fromText, number unquoting) isn't limited to the top level either — real
   *  bug fixed by this, live: ValidationRec.Identity4 (real number field) rendering as quoted
   *  text. depth: nesting level for recursive calls (0 at the top — matches the original
   *  hardcoded 2-space/no-trailing-indent top-level output exactly). Field-name-qualified
   *  substitution search (applyDependency/substituteLiteral's "FieldName: literal" match) is a
   *  plain substring search, unaffected by the added leading whitespace/newlines. */
  function buildRecordLiteral(value, recordFields, moduleName, moduleSource, depth) {
    depth = depth || 0;
    const pad = "  ".repeat(depth + 1);
    const closePad = "  ".repeat(depth);
    if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
      return toFlowScriptLiteral(value, depth);
    }
    const entries = Object.keys(value).map((k) => {
      const declared = (recordFields || []).find((f) => f.name === k);
      const rendered = declared
        ? formatValueForType(value[k], declared.type, moduleName, depth + 1, moduleSource)
        : toFlowScriptLiteral(value[k], depth + 1);
      return `${pad}${k}: ${rendered}`;
    });
    if (entries.length === 0) return "{}";
    return `{\n${entries.join(",\n")}\n${closePad}}`;
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
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) return null;

    const paramsText = moduleSource.slice(parenStart + 1, end);
    const params = splitTopLevel(paramsText, ",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((paramText) => {
        const eqIdx = paramText.indexOf("=");
        const withoutDefault = eqIdx === -1 ? paramText : paramText.slice(0, eqIdx);
        const colonIdx = withoutDefault.indexOf(":");
        const name = (colonIdx === -1 ? withoutDefault : withoutDefault.slice(0, colonIdx)).trim();
        const type = colonIdx === -1 ? "" : withoutDefault.slice(colonIdx + 1).trim();
        return { name, type };
      });
    // The declared RETURN type, e.g. `function F(...): CustomerDefaultsStructure {` ->
    // "CustomerDefaultsStructure". Needed so a later step referencing this call's result can
    // know the REAL declared kind of each field (see findRecordTypeFields) — a GET/function
    // call's return type is routinely looser than its semantic meaning (e.g. an enum-like field
    // declared as plain `text?`), confirmed live 2026-08-08. null if there's no `):` (a
    // parameterless-return-omitted declaration, rare) or nothing follows it before `{`.
    const afterParen = moduleSource.slice(end + 1);
    const returnMatch = afterParen.match(/^\s*:\s*([^{]+?)\s*\{/);
    const returnType = returnMatch ? returnMatch[1].trim() : null;
    return { name: functionName, params, returnType };
  }

  /** Same marker/paren-matching as findFunctionSignature, but returns the function's own BODY
   *  text (between its `{` and matching `}`) instead of its parsed signature — needed by
   *  buildRawContextualCallScript to inline a wrapper's real generated body (deserialize,
   *  Record.mapValues, unsafeCast, ...) with just its hardcoded URL literal swapped out, rather
   *  than reconstructing that body from scratch and guessing at per-function special-casing. */
  function findFunctionBody(moduleSource, functionName) {
    const marker = `function ${functionName}(`;
    const idx = (moduleSource || "").indexOf(marker);
    if (idx === -1) return null;
    const parenStart = idx + marker.length - 1;
    let depth = 0;
    let parenEnd = -1;
    for (let i = parenStart; i < moduleSource.length; i++) {
      const c = moduleSource[i];
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) { parenEnd = i; break; }
      }
    }
    if (parenEnd === -1) return null;
    const braceStart = moduleSource.indexOf("{", parenEnd + 1);
    if (braceStart === -1) return null;
    const body = extractBraceBlock(moduleSource, braceStart);
    return body === null ? null : body.trim();
  }

  /** Real bug, live, 2026-08-10: a bound function reached via a NAVIGATION PROPERTY (e.g.
   *  `CustomerOrderSet(OrderNo='X')/OrderLinesArray/...CustomerOrderLine_Default()`) carries real
   *  context — which order — that the GENERATED wrapper function can't express when it declares
   *  ZERO real params. Flow's codegen builds exactly ONE wrapper per bound-function NAME,
   *  hardcoded to the bare unscoped entity-set path (confirmed against the real module source:
   *  `CustomerOrderLine_Default(headers)`'s own body always queries plain `CustomerOrderLineSet`,
   *  no way to inject any navigation context — it takes no other params to put one in; confirmed
   *  no scoped overload exists either, e.g. no `CustomerOrderLine_Default_0`). Calling that
   *  wrapper for a recording that actually used the scoped path silently returns
   *  generic/empty-context data instead of the real thing (confirmed live: TaxLiabilityType and
   *  other fields came back null — this call's own resolution had thrown away the real order
   *  context the recording captured). Fixed by inlining the wrapper's OWN body text with its
   *  hardcoded URL literal swapped for the REAL recorded path, reusing whatever the generator's
   *  real body does (deserialize, Record.mapValues, unsafeCast, ...) instead of reconstructing
   *  and guessing at it.
   *
   *  Follow-up, same day: the first segment's own key value (e.g. `OrderNo='X'`) was landing as
   *  opaque text buried inside the whole-path literal — never offered as a dependency-matchable
   *  valueSlot at all (user caught this directly: "do you consider variables like OrderNo= in
   *  this example?"). Fixed: rebuild that key clause using the SAME `{ToQueryStringParam(...)}`
   *  embedding convention every real generated wrapper already uses for its own key params (seen
   *  throughout this module's real source, e.g. `OrderNo={ToQueryStringParam(orderNo)}`) — each
   *  key value becomes a real, classified valueSlot (same shape as the existing named-key-segment
   *  handling above, entitySetName's own row type via findQueryableVarName/findQueryableRowType)
   *  with its literal rendered as plain FlowScript text inside the interpolation, so dependency
   *  substitution's plain-substring search can find and replace it exactly like any other slot.
   *  entitySetName/keyLiteral/moduleName are optional — omitting them (or an unnamed/malformed
   *  key) leaves the path's first segment exactly as recorded, same as before this follow-up.
   *
   *  Returns null (caller falls back to the normal wrapper-call path) when the body can't be
   *  found or doesn't have the expected shape — never guess a broken script. */
  function buildRawContextualCallScript(moduleName, moduleSource, functionName, realSvcPath, entitySetName, keyLiteral, usedNames) {
    usedNames = usedNames || new Set();
    const body = findFunctionBody(moduleSource, functionName);
    if (!body) return null;
    const literalMatch = body.match(/`([^`]*)`/);
    if (!literalMatch) return null;
    const svcIdx = literalMatch[1].indexOf(".svc");
    if (svcIdx === -1) return null;
    const prefix = literalMatch[1].slice(0, svcIdx + 4); // "ModuleName.svc"

    let pathTemplate = realSvcPath;
    const valueSlots = [];
    if (keyLiteral && entitySetName) {
      const keyNames = splitKeyNames(keyLiteral);
      const keyValues = splitKeyValues(keyLiteral);
      if (keyNames.length > 0 && keyNames.length === keyValues.length) {
        const rowType = findQueryableRowType(moduleSource, findQueryableVarName(moduleSource, entitySetName) || entitySetName);
        const rowFields = rowType ? findRecordTypeFields(moduleSource, rowType) : null;
        const rebuiltKeyClause = keyNames.map((name, i) => {
          const raw = keyValues[i];
          const declared = rowFields && rowFields.find((f) => f.name === name);
          const classified = declared ? classifyFlowType(declared.type) : { kind: "text", nullable: false };
          let literal = keyValueToLiteral(raw);
          if (classified.kind === "enum") literal = formatValueForType(keyValueToJs(raw), declared.type, moduleName);
          valueSlots.push({
            path: `key.${name}`,
            value: keyValueToJs(raw),
            literal,
            kind: classified.kind,
            kindKnown: !!declared, // see buildInlineRecordLet's comment — kind always defaults to "text", never treat that default as a positive classification
            nullable: classified.nullable || (declared ? declared.optional : false),
            valueNullable: classified.nullable
          });
          return `${name}={ToQueryStringParam(${literal})}`;
        }).join(",");
        // Replace only the FIRST parenthesized group (the entity's own key segment) — the
        // trailing action segment's own "()" is untouched since it comes later in the string.
        pathTemplate = realSvcPath.replace(/\([^()]*\)/, `(${rebuiltKeyClause})`);
      }
    }

    let newBody = body.replace(literalMatch[0], "`" + prefix + pathTemplate + "`");
    // `headers` is a bare identifier inside the inlined body (was the wrapper's OWN parameter,
    // defaulting to []) — declare it locally with the same default. Disambiguated against
    // usedNames (real bug, live, 2026-08-11 — FlowScript's variable namespace is flat across the
    // whole flow, two occurrences of this fallback in one session both declaring bare `headers`
    // collided, "The identifier ... is already declared" — same fix as
    // buildNavigationQueryableScript's entity/source, see disambiguateLocalName's own doc
    // comment) — every occurrence inside the copied body (not just the declaration) needs the
    // same rename, since the wrapper's own body references its param by this exact name.
    const headersVar = disambiguateLocalName("headers", usedNames);
    if (headersVar !== "headers") {
      newBody = newBody.replace(/\bheaders\b/g, headersVar);
    }
    return {
      script: `open ${moduleName};\nlet ${headersVar}: Header* = [];\n${newBody}`,
      valueSlots
    };
  }

  function escapeRegExp(s) {
    return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /** Real bug, live, 2026-08-11: FlowScript's variable namespace is flat across the WHOLE flow,
   *  not scoped per script step (same reason flow-steps.js already disambiguates step OUTPUT
   *  variable names, disambiguateVariableName/collectUsedVariableNames) — a script-internal `let`
   *  name we choose ourselves (not copied verbatim from a real generated wrapper's own body) can
   *  collide with the SAME name chosen for a different step earlier in the same flow. Confirmed
   *  live: two occurrences of the same navigation-queryable shape (buildNavigationQueryableScript)
   *  in one session both declared `let entity`/`let source`, "The identifier 'source' is already
   *  declared." Duplicated here (not reusing flow-steps.js's own version) — same "no load-order
   *  dependency between the two global modules" precedent already used for classifyFieldType
   *  elsewhere in this codebase. Mutates `usedNames` in place, matching
   *  collectUsedVariableNames's own convention. */
  function disambiguateLocalName(base, usedNames) {
    let name = base;
    let i = 2;
    while (usedNames.has(name)) {
      name = `${base}${i}`;
      i++;
    }
    usedNames.add(name);
    return name;
  }

  /** Splits a FlowScript type string into { kind, nullable }. kind is one of
   *  "text"/"number"/"datetime"/"boolean"/"enum", defaulting to "text" for anything
   *  unrecognized. Enum types in this codebase are always referenced as `TypeName.Value`
   *  (e.g. `CPackageType.Value`) — structurally-typed records, not plain strings, so callers
   *  should not treat them like a free-text field until there's a confirmed-safe way to
   *  build a value for one. */
  function classifyFlowType(typeStr) {
    const trimmed = String(typeStr || "").trim();
    const nullable = trimmed.endsWith("?");
    const base = trimmed.replace(/\?$/, "").replace(/\*$/, "").trim();
    if (base === "number") return { kind: "number", nullable };
    if (base === "datetime") return { kind: "datetime", nullable };
    if (base === "boolean") return { kind: "boolean", nullable };
    if (/^\w+\.Value$/.test(base)) return { kind: "enum", nullable };
    return { kind: "text", nullable };
  }

  /** Parses the field list of a `type TypeName = { ... }` record declaration from the module
   *  source, e.g. `type OrderQuotationUpdateRequest = { optional Note: text?, QuotationNo: text }`
   *  -> [{ name: "Note", type: "text?", optional: true }, { name: "QuotationNo", type: "text",
   *  optional: false }]. Returns null if the type isn't declared as a record in this module. */
  /** Finds the matching closing `}` for an already-located opening `{` at moduleSource[braceStart],
   *  brace-depth aware (nested records inside a field's own type don't confuse it). Returns the
   *  block's inner text, or null if unterminated. Split out from findRecordTypeFields 2026-08-10
   *  so buildFieldTypeIndex can reuse it without re-searching moduleSource from the start for a
   *  position it already found — see that function's own perf comment. */
  function extractBraceBlock(moduleSource, braceStart) {
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < moduleSource.length; i++) {
      const c = moduleSource[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    return end === -1 ? null : moduleSource.slice(braceStart + 1, end);
  }

  /** Parses a record type's already-extracted body text (the part between `{` and `}`) into
   *  field descriptors. Split out from findRecordTypeFields 2026-08-10, same reason as
   *  extractBraceBlock above. */
  function parseFieldsFromBody(body) {
    return splitTopLevel(body, ",")
      .map((f) => f.trim())
      .filter(Boolean)
      .map((fieldText) => {
        const optionalMatch = fieldText.match(/^optional\s+/);
        const withoutOptional = optionalMatch ? fieldText.slice(optionalMatch[0].length) : fieldText;
        const colonIdx = withoutOptional.indexOf(":");
        const rawName = colonIdx === -1 ? withoutOptional : withoutOptional.slice(0, colonIdx);
        const name = rawName.trim().replace(/^["']|["']$/g, "");
        const afterColon = colonIdx === -1 ? "" : withoutOptional.slice(colonIdx + 1);
        // A field can carry its own default (`Field: type = null`) — IFS Connect's generator
        // convention for "the real IFS payload may omit this field", used throughout real
        // module source (CustomerOrderLine, CustomerOrder, CustomerDefaultsStructure, ...)
        // alongside (not instead of) the `optional` prefix. Real bug, 2026-08-09: this default
        // was never split off `type` before — e.g. "boolean = null" fell through
        // classifyFlowType's whole case chain (nothing matches a string with " = null" glued on)
        // straight to the generic text fallback, silently misclassifying every defaulted
        // number/boolean/enum field — confirmed live, UsePriceInclTax (boolean) got the generic
        // `isNull(ref, "")` text fallback instead of `isNull(ref, false)`. Split BEFORE trimming
        // type, same order findFunctionSignature already uses for its own params. (Note: unlike
        // commit 48ff0a0 — reverted, see bug #18 — this default text is intentionally NOT wired
        // into buildRecordLiteral's literal construction; that approach is superseded by
        // applyOptionalFieldWorkaround in ifs-modules.js. This split exists purely to keep `type`
        // clean for classifyFlowType.)
        const eqIdx = afterColon.indexOf("=");
        const type = (eqIdx === -1 ? afterColon : afterColon.slice(0, eqIdx)).trim();
        return { name, type, optional: !!optionalMatch };
      });
  }

  function findRecordTypeFields(moduleSource, typeName) {
    const re = new RegExp(`type\\s+${escapeRegExp(typeName)}\\s*=\\s*\\{`);
    const m = re.exec(moduleSource || "");
    if (!m) return null;
    const body = extractBraceBlock(moduleSource, m.index + m[0].length - 1);
    return body === null ? null : parseFieldsFromBody(body);
  }

  /** Returns the declared Queryable variable name matching entitySetName, or null if the
   *  module never turned this endpoint into a queryable (common — many GET endpoints are
   *  plain functions instead, e.g. GetBasicCustomerInformation). Never guess a table that
   *  doesn't exist. */
  function findQueryableVarName(moduleSource, entitySetName) {
    const re = /let\s+(\w+)\s*=\s*Queryable\.Create</g;
    let m;
    let fallback = null;
    while ((m = re.exec(moduleSource || ""))) {
      if (m[1] === entitySetName) return m[1];
      if (!fallback && m[1].toUpperCase() === entitySetName.toUpperCase()) fallback = m[1];
    }
    return fallback;
  }

  function buildGetScript(moduleName, entitySetName, moduleSource) {
    const table = findQueryableVarName(moduleSource, entitySetName) || entitySetName;
    return `open ${moduleName};\nreturn select * from ${table}`;
  }

  /** The row type of a declared Queryable, e.g. `Queryable.Create<Translation, OrderQuotation,
   *  text>` -> "OrderQuotation" — used to look up filter-referenced fields' declared types. */
  function findQueryableRowType(moduleSource, queryableVarName) {
    const re = new RegExp(`let\\s+${escapeRegExp(queryableVarName)}\\s*=\\s*Queryable\\.Create<[^,]+,\\s*([A-Za-z0-9_]+)\\s*,`);
    const m = re.exec(moduleSource || "");
    return m ? m[1] : null;
  }

  function deriveWriteCandidates(method, entitySetName, actionName) {
    const m = String(method || "").toUpperCase();
    const candidates = [];
    if (actionName) {
      const entityType = entitySetName.replace(/Set$/, "");
      // Real bug, live, 2026-08-10: CustomerOrder_RefreshAfterCustOrdCrud (a bound action on
      // CustomerOrderSet) — its own real IFS action name already starts with the entity type
      // ("CustomerOrder_..."), so re-inserting entityType a second time (the next candidate
      // below) produces "CustomerOrderSet_CustomerOrder_CustomerOrder_RefreshAfterCustOrdCrud",
      // which doesn't exist — the loop fell through to the bare actionName candidate, which DOES
      // exist but takes a whole `entity: CustomerOrder_Keys` RECORD parameter, not the plain
      // scalar key we actually have from the URL. IFS also generates a disambiguated
      // scalar-friendly overload for exactly this shape:
      // "CustomerOrderSet_CustomerOrder_RefreshAfterCustOrdCrud(OrderNo: text, ...)" — simple
      // entitySetName+actionName concatenation, no entityType re-insertion. Tried first since
      // it's the one our key-literal substitution already knows how to satisfy.
      candidates.push(`${entitySetName}_${actionName}`);
      candidates.push(`${entitySetName}_${entityType}_${actionName}`);
      candidates.push(actionName);
    } else if (m === "POST") {
      candidates.push(`${entitySetName}_Create`);
    } else if (m === "PATCH" || m === "PUT") {
      candidates.push(`${entitySetName}_Update`);
    } else if (m === "DELETE") {
      candidates.push(`${entitySetName}_Delete`);
    }
    candidates.push(entitySetName); // unbound function import called directly by name
    return candidates;
  }

  /** Same segment-splitting as splitKeyValues, but returns each key segment's NAME (e.g.
   *  "ValidationRec" from "ValidationRec=@ValidationRec") instead of its value — used to score
   *  which overload of an action a recorded call actually matches (see
   *  findBestMatchingOverload). A segment with no "Name=" prefix (a single unnamed key, e.g.
   *  "'Q1'") contributes nothing. */
  function splitKeyNames(keyLiteral) {
    return splitTopLevel(keyLiteral, ",")
      .map((seg) => {
        const m = seg.trim().match(/^([A-Za-z0-9_]+)=/);
        return m ? m[1] : null;
      })
      .filter(Boolean);
  }

  /** Finds every function declared in the module whose name is either exactly baseName or a
   *  numbered-suffix variant of it (baseName_0, baseName_1, ...) — IFS Connect generates
   *  multiple overloads of the same bound action/function when it accepts different parameter
   *  shapes (e.g. ValidateAddressNo's flat-params version vs. ValidateAddressNo_0's
   *  ValidationRec-record version, both resolving the same REST endpoint), confirmed real
   *  2026-08-08. Returns [] if none exist. */
  function findFunctionOverloads(moduleSource, baseName) {
    const re = new RegExp(`function\\s+(${escapeRegExp(baseName)}(?:_\\d+)?)\\s*\\(`, "g");
    const names = new Set();
    let m;
    while ((m = re.exec(moduleSource || ""))) {
      names.add(m[1]);
    }
    return Array.from(names)
      .map((name) => findFunctionSignature(moduleSource, name))
      .filter(Boolean);
  }

  /** How many of a candidate function's own declared parameter names (excluding headers) match
   *  the recorded call's actual key-segment names, case-insensitively — the best signal
   *  available for picking between overloads of the same action without knowing IFS's own
   *  overload-selection rules. */
  function scoreOverloadMatch(signature, keyNames) {
    const declaredNames = signature.params.filter((p) => p.name !== "headers").map((p) => p.name.toLowerCase());
    const recordedNames = keyNames.map((n) => n.toLowerCase());
    return declaredNames.filter((n) => recordedNames.includes(n)).length;
  }

  /** Picks the best-matching overload among every function sharing candidateName's base (see
   *  findFunctionOverloads) by scoring each against the recorded call's actual key-segment
   *  names — a fixed-priority name search alone can't distinguish IFS Connect's multiple
   *  overloads of the same action, confirmed real 2026-08-08 (ValidateAddressNo's flat-params
   *  version was always picked over ValidateAddressNo_0's ValidationRec-record version, even
   *  when the recorded call's key names — ValidationRec, DeliveryAddress, ... — matched _0's
   *  params exactly and none of the flat version's). Ties (including "every overload scores 0",
   *  e.g. a call with no key segment at all) fall back to declaration order — the first-found
   *  overload, matching the pre-overload-aware behavior. Returns null if candidateName has no
   *  match in the module at all (base or suffixed). */
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

  /** Recursively flattens a JS value into {path, value, literal} leaves, dot/bracket-addressed
   *  (e.g. "input.Lines[0].Qty"). Used both to record where a request-body value ended up in
   *  the generated script (for dependency substitution) and, on the response side, to build
   *  the pool of values a later step's slots get matched against. */
  function collectValueSlots(value, path, out) {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => collectValueSlots(v, `${path}[${i}]`, out));
      return;
    }
    if (typeof value === "object") {
      Object.keys(value).forEach((k) => collectValueSlots(value[k], path ? `${path}.${k}` : k, out));
      return;
    }
    out.push({ path, value, literal: toFlowScriptLiteral(value) });
  }

  /* --- OData $filter -> FlowScript "where" clause translation ---
     A select-from-queryable step needs to reconstruct the same filter the recorded call used
     (e.g. GET .../OrderQuotationSet?$filter=(Objstate eq Namespace'Released') and
     (startswith(QuotationNo,'1100463'))) -> "where (Objstate = OrderQuotationState.Released) and
     (QuotationNo like "1100463%")". This is the reverse of the module's own getTranslation()
     (which converts a FlowScript where-clause into $filter at runtime), so the operators/`like`
     semantics here are the exact mirror of that. */

  function extractODataFilter(url) {
    try {
      return new URL(url).searchParams.get("$filter");
    } catch (e) {
      return null;
    }
  }

  function tokenizeODataFilter(text) {
    const tokens = [];
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === "(" || c === ")" || c === ",") { tokens.push({ type: c }); i++; continue; }
      if (c === "'") {
        let j = i + 1;
        let str = "";
        while (j < text.length) {
          if (text[j] === "'" && text[j + 1] === "'") { str += "'"; j += 2; continue; }
          if (text[j] === "'") break;
          str += text[j]; j++;
        }
        tokens.push({ type: "string", value: str });
        i = j + 1;
        continue;
      }
      const wordMatch = text.slice(i).match(/^[A-Za-z_][A-Za-z0-9_.]*/);
      if (wordMatch) {
        const word = wordMatch[0];
        i += word.length;
        if (text[i] === "'") {
          // enum literal glued directly onto the identifier, e.g. Namespace.Type'Value' (no space)
          let j = i + 1;
          let val = "";
          while (j < text.length) {
            if (text[j] === "'" && text[j + 1] === "'") { val += "'"; j += 2; continue; }
            if (text[j] === "'") break;
            val += text[j]; j++;
          }
          i = j + 1;
          tokens.push({ type: "enum", namespace: word, value: val });
          continue;
        }
        tokens.push({ type: "word", value: word });
        continue;
      }
      const numMatch = text.slice(i).match(/^-?\d+(\.\d+)?/);
      if (numMatch) {
        tokens.push({ type: "number", value: numMatch[0] });
        i += numMatch[0].length;
        continue;
      }
      i++; // unrecognized character — skip rather than fail the whole translation
    }
    return tokens;
  }

  const ODATA_COMPARISON_OPS = { eq: "=", ne: "!=", gt: ">", ge: ">=", lt: "<", le: "<=" };

  function likePattern(rawValue, kind) {
    if (kind === "startswith") return `${rawValue}%`;
    if (kind === "endswith") return `%${rawValue}`;
    return `%${rawValue}%`; // contains
  }

  /** Parses the filter, returning { clause, valueSlots }. valueSlots (path "filter.FieldName")
   *  let a $filter-embedded value participate in dependency tracing and user-input
   *  classification the same way a write call's body fields do — previously these were baked
   *  straight into the clause text with nothing tracking them, invisible to both. */
  function parseODataFilterTokens(tokens, rowFields, moduleName) {
    let pos = 0;
    const peek = () => tokens[pos];
    const isWord = (t, word) => !!t && t.type === "word" && t.value.toLowerCase() === word;
    const valueSlots = [];

    /** Looks up fieldName's declared type against rowFields and, if it's positively enum-typed,
     *  renders rawValue as a real qualified enum literal (Module.EnumType.fromText(...)) instead
     *  of a bare string. Returns null when there's nothing to correct (no row-type info, field
     *  not found, not enum-typed, or the value isn't a string) — callers keep their own
     *  already-built text in that case. */
    function enumAwareLiteral(fieldName, rawValue) {
      if (!rowFields || !moduleName || typeof rawValue !== "string") return null;
      const declared = rowFields.find((f) => f.name === fieldName);
      if (!declared || classifyFlowType(declared.type).kind !== "enum") return null;
      return formatValueForType(rawValue, declared.type, moduleName);
    }

    // { text: FlowScript source fragment, isLiteral: true if this came from a string/number
    // token (a real value, not a field reference or enum constant), raw: the unwrapped JS value. */
    function parseValue() {
      // OData case-normalization wrapping a plain field reference, e.g. tolower(PickListNo) —
      // real bug, live, 2026-08-11: startswith(tolower(PickListNo),'x') wasn't recognized as a
      // NESTED function call at all — this function only ever consumed ONE token, so "tolower"
      // itself got treated as if it WERE the field name, and the stray "(" token that followed
      // fell through every branch to the generic null fallback (no `.raw` at all) — likePattern
      // then rendered the literal text "undefined%". Common real OData pattern for
      // case-insensitive startswith/endswith/contains (confirmed live). FlowScript has real
      // lower()/upper() builtins (confirmed via docs) — wrap the field reference the same way;
      // fieldName still points at the REAL underlying field for valueSlot/enum-awareness
      // purposes (comparing against tolower(...)'s OWN output is always plain text regardless,
      // enum-awareness correctly never fires for it). Only this exact shape — tolower/toupper
      // wrapping a single bare field name — is handled; anything more complex bails
      // conservatively (no safe generic answer for a nested shape with no real evidence yet).
      const t0 = tokens[pos];
      if (t0 && t0.type === "word" && (t0.value.toLowerCase() === "tolower" || t0.value.toLowerCase() === "toupper") && tokens[pos + 1] && tokens[pos + 1].type === "(") {
        const flowFn = t0.value.toLowerCase() === "tolower" ? "lower" : "upper";
        const inner = tokens[pos + 2];
        if (inner && inner.type === "word" && tokens[pos + 3] && tokens[pos + 3].type === ")") {
          pos += 4; // fnName, "(", field word, ")"
          return { text: `${flowFn}(${inner.value})`, isLiteral: false, fieldName: inner.value };
        }
      }
      const t = tokens[pos++];
      if (!t) return { text: "null", isLiteral: false };
      if (t.type === "string") return { text: toFlowScriptLiteral(t.value), isLiteral: true, raw: t.value };
      if (t.type === "number") return { text: t.value, isLiteral: true, raw: Number(t.value) };
      // Real root cause, live, 2026-08-10: this used to be isLiteral:false on the theory that
      // the query translator accepts a bare enum member name as a plain string at runtime — true
      // for the runtime translator, but Flow's own STATIC compiler flags the comparison anyway:
      // "Possibly unintended comparison of non-overlapping types 'X.OrderCoordinatorState.Value'
      // and '"Blocked"'". isLiteral:true (mirroring the plain-quoted-string branch above) routes
      // this through the same enumAwareLiteral correction below when the paired field is
      // positively enum-typed, producing a real qualified fromText(...) call instead. Without
      // rowFields/moduleName (no correction available), falls back to the same bare-string
      // rendering as before — unchanged for every caller that doesn't supply row-type info.
      if (t.type === "enum") return { text: toFlowScriptLiteral(t.value), isLiteral: true, raw: t.value };
      if (t.type === "word") return { text: t.value, isLiteral: false, fieldName: t.value };
      return { text: "null", isLiteral: false };
    }

    // wrapKind marks a slot whose *substituted* reference (a dependency or user-input
    // variable) must be re-wrapped with the % wildcard rather than dropped in verbatim — the
    // module's own query translator inspects the RUNTIME string content of a `like` RHS to
    // decide startswith/endswith/contains, so the wildcard has to survive substitution or the
    // query fails at flow-execution time ("Pattern could not be translated"), not at save time.
    function recordSlot(fieldName, rawValue, literalText, wrapKind) {
      if (!fieldName) return;
      const slot = { path: `filter.${fieldName}`, value: rawValue, literal: literalText };
      if (wrapKind) slot.wrapKind = wrapKind;
      valueSlots.push(slot);
    }

    function parsePrimary() {
      if (peek() && peek().type === "(") {
        pos++;
        const inner = parseOr();
        if (peek() && peek().type === ")") pos++;
        return `(${inner})`;
      }
      if (peek() && peek().type === "word" && tokens[pos + 1] && tokens[pos + 1].type === "(") {
        const fnName = tokens[pos++].value.toLowerCase();
        pos++; // "("
        const args = [];
        while (peek() && peek().type !== ")") {
          args.push(parseValue());
          if (peek() && peek().type === ",") pos++;
        }
        if (peek() && peek().type === ")") pos++;
        if (fnName === "startswith" || fnName === "endswith" || fnName === "contains") {
          const fieldArg = args[0];
          const valueArg = args[1] || { text: "null", isLiteral: false };
          const patternRaw = likePattern(valueArg.raw, fnName);
          const patternLiteral = toFlowScriptLiteral(patternRaw);
          if (valueArg.isLiteral && fieldArg && fieldArg.fieldName) {
            const wrapKind = fnName === "startswith" ? "start" : fnName === "endswith" ? "end" : "contains";
            recordSlot(fieldArg.fieldName, valueArg.raw, patternLiteral, wrapKind);
          }
          return `${fieldArg.text} like ${patternLiteral}`;
        }
        return `/* TODO: unsupported filter function ${fnName}(${args.map((a) => a.text).join(", ")}) */ true`;
      }
      let left = parseValue();
      if (peek() && peek().type === "word" && ODATA_COMPARISON_OPS[peek().value.toLowerCase()]) {
        const op = ODATA_COMPARISON_OPS[tokens[pos++].value.toLowerCase()];
        let right = parseValue();
        // Correct the literal side's text when the OTHER side is a field we can positively
        // classify as enum-typed — see enumAwareLiteral's doc comment. Must happen here (not in
        // parseValue) since a value's own token doesn't know which role it plays in the
        // comparison until both sides are parsed.
        if (right.isLiteral && left.fieldName) {
          const corrected = enumAwareLiteral(left.fieldName, right.raw);
          if (corrected) right = Object.assign({}, right, { text: corrected });
        } else if (left.isLiteral && right.fieldName) {
          const corrected = enumAwareLiteral(right.fieldName, left.raw);
          if (corrected) left = Object.assign({}, left, { text: corrected });
        }
        if (right.isLiteral && left.fieldName) recordSlot(left.fieldName, right.raw, right.text);
        else if (left.isLiteral && right.fieldName) recordSlot(right.fieldName, left.raw, left.text);
        return `${left.text} ${op} ${right.text}`;
      }
      return left.text;
    }

    function parseAnd() {
      let left = parsePrimary();
      while (isWord(peek(), "and")) {
        pos++;
        left = `${left} and ${parsePrimary()}`;
      }
      return left;
    }

    function parseOr() {
      let left = parseAnd();
      while (isWord(peek(), "or")) {
        pos++;
        left = `${left} or ${parseAnd()}`;
      }
      return left;
    }

    return { clause: parseOr(), valueSlots };
  }

  /** Translates a recorded GET's $filter query param into a FlowScript "where" clause body
   *  (no leading "where ") plus the value slots it contains, or null if the URL has no
   *  $filter. Never throws — a filter this can't make sense of is simply dropped (better an
   *  unfiltered select than a broken script).
   *
   *  rowFields/moduleName (both optional) let a comparison against a field we can positively
   *  classify as enum-typed render its RHS as a real qualified enum literal instead of a bare
   *  string — real bug, live, 2026-08-10: "Objstate != \"Blocked\"" (Objstate genuinely
   *  enum-typed) flagged by Flow's compiler: "Possibly unintended comparison of non-overlapping
   *  types". This is the same "always use the field's real declared type" standard already
   *  applied to record literals, key params, and dependency substitution — the $filter path was
   *  the one place left still emitting a type-blind literal, because the clause TEXT was always
   *  built before any row-type lookup happened; the type only ever got attached to the valueSlot
   *  metadata afterward, never fed back into the text. Without rowFields/moduleName, behaves
   *  exactly as before (every value rendered as a plain literal) — used by any caller that
   *  doesn't have row-type info available. */
  function buildWhereClause(url, rowFields, moduleName) {
    const filterText = extractODataFilter(url);
    if (!filterText) return null;
    try {
      const tokens = tokenizeODataFilter(filterText);
      if (tokens.length === 0) return null;
      return parseODataFilterTokens(tokens, rowFields, moduleName);
    } catch (e) {
      return null;
    }
  }

  /** Walks a dotted field path (e.g. ["ValidationRec", "TaxLiabilityType"]) down through nested
   *  declared record types, one findRecordTypeFields lookup per level — exactly mirroring the
   *  same per-level resolution formatValueForType/buildRecordLiteral now use when actually
   *  RENDERING a nested field (see that pair's own 2026-08-10 doc comments). Returns the FINAL
   *  segment's own {name, type, optional} descriptor, or null if any level's type can't be
   *  resolved (a genuinely unresolvable/untyped level, or an array segment — arrays aren't
   *  walked, same "fall back to a safe default" precedent as before). Bounded/proportional: one
   *  targeted lookup per actual nesting level in the path, not a whole-module scan. */
  function resolveDeclaredFieldType(recordFields, moduleSource, segments) {
    let fields = recordFields;
    let declared = null;
    for (let i = 0; i < segments.length; i++) {
      declared = (fields || []).find((f) => f.name === segments[i]);
      if (!declared) return null;
      if (i < segments.length - 1) {
        const baseType = String(declared.type || "").trim().replace(/[?*]+$/, "");
        fields = findRecordTypeFields(moduleSource, baseType);
        if (!fields) return null; // can't descend further — not a known record type
      }
    }
    return declared;
  }

  /** Builds a `let <varName>: <typeName> = {...};` line for a structured (object) value, plus
   *  classified valueSlots for its fields matching the declared record type — shared by both a
   *  write call's request-body "input" parameter and an OData parameter-alias ("@AliasName") key
   *  parameter's resolved query-string value. Appends the produced valueSlots onto `valueSlots`
   *  in place (mutating the caller's array, matching collectValueSlots' own convention). Nested
   *  "varName.Field.SubField..." slots are resolved the same way top-level ones always were
   *  (resolveDeclaredFieldType, one lookup per nesting level) — extended 2026-08-10 alongside
   *  formatValueForType/buildRecordLiteral's own nested-recursion fix (real bug: a nested
   *  enum-typed field, e.g. ValidationRec.TaxLiabilityType, started rendering via
   *  Module.EnumType.fromText(...) at that point but this classification loop still only ever
   *  matched direct top-level paths, so the slot's own kind/literal stayed stale — dependency
   *  substitution's bare-literal fallback search then landed its own replacement INSIDE the
   *  fromText(...) call instead of replacing it whole, producing a nonsensical double-wrapped
   *  fromText(ref.name) that the server correctly rejected as "Could not convert to the
   *  corresponding enumeration value"). An array-indexed segment ("Field[0]") still falls back to
   *  the safe default (text, non-nullable) — arrays aren't walked here, same as before. */
  function buildInlineRecordLet(varName, typeName, body, moduleSource, moduleName, valueSlots) {
    const recordFields = findRecordTypeFields(moduleSource, typeName) || [];
    const line = `let ${varName}: ${typeName} = ${buildRecordLiteral(body, recordFields, moduleName, moduleSource)};`;
    const startIdx = valueSlots.length;
    collectValueSlots(body, varName, valueSlots);

    const fieldPathRe = new RegExp(`^${escapeRegExp(varName)}\\.(.+)$`);
    for (let i = startIdx; i < valueSlots.length; i++) {
      const slot = valueSlots[i];
      const fieldMatch = slot.path.match(fieldPathRe);
      const segments = fieldMatch && !fieldMatch[1].includes("[") ? fieldMatch[1].split(".") : null;
      const declared = segments ? resolveDeclaredFieldType(recordFields, moduleSource, segments) : null;
      const classified = declared ? classifyFlowType(declared.type) : { kind: "text", nullable: false };
      slot.kind = classified.kind;
      // True only when `declared` (a real field lookup against the type's own declared fields)
      // succeeded — `kind` itself always has SOME value (defaults to "text" when the lookup
      // fails, kept for downstream consumers like createControlForKind that need a safe
      // default), but that default must never be treated as a POSITIVE classification. Real bug,
      // 2026-08-09: flow-dependency-tracer.js's value-only-fallback kind-conflict check (added
      // for the RentalChargableDays/ShipAddrNo coincidence) trusted `slot.kind` as "known" purely
      // because it was truthy — since it's ALWAYS truthy (this default), that check ended up
      // rejecting the vast majority of legitimate matches too (source genuinely classified via
      // resultFields as non-text, target merely defaulted to "text" because its declared field
      // couldn't be resolved) — user-observed: ~20 real matches collapsed to 4, all coincidental.
      slot.kindKnown = !!declared;
      // Only meaningful for kind "enum" — the enum's own type name (e.g. "Lookup_IsoCountry"),
      // needed to build a real fromText(...) isNull(...) fallback for a nullable enum
      // dependency reference (see flow-dependency-tracer.js's nullFallbackForKind).
      slot.enumType = classified.kind === "enum" ? enumModuleName(declared.type) : null;
      // `nullable` folds in "optional key" (AllowEmpty on a user-step control is correct for
      // either case) but `valueNullable` stays pure type nullability — a key marked `optional
      // Objsite: text` still has a non-nullable VALUE type when present, so a firstOrNull(...)
      // reference substituted in still needs isNull(...) unwrapping. Conflating the two here
      // was the bug: it made isNull-unwrapping skip fields that are merely optional-but-present.
      slot.nullable = classified.nullable || (declared ? declared.optional : false);
      slot.valueNullable = classified.nullable;
      // Keep literal in sync with what buildRecordLiteral actually emitted for this field, or
      // dependency substitution (which finds this text via a plain indexOf) silently no-ops.
      // Real confirmed bug (2026-08-07, real "Edit Sales Quotation" recording): only the enum
      // case was re-synced here, but formatValueForType ALSO rewrites number-typed fields whose
      // recorded value is an OData-serialized string (e.g. CProjectDiscount "10" -> bare 10) —
      // without the same re-sync, slot.literal stayed the quoted-text form ("10") while the
      // script actually embedded the bare number (10), so substitution (both the field-name-
      // qualified AND the bare-literal fallback search) silently found nothing and the
      // classified-as-user-input value stayed hardcoded instead of being wired to its control.
      if ((classified.kind === "enum" || classified.kind === "number") && typeof slot.value === "string") {
        slot.literal = formatValueForType(slot.value, declared.type, moduleName);
      }
    }
    return line;
  }

  /** actionKeyLiteral: the TRAILING action segment's own embedded key=value args (e.g.
   *  "Source='REPORT PICK',PickToParentQty=null" from
   *  "...ShopMaterialPickLineVirtual_CheckSerialRecords(Source='REPORT PICK',PickToParentQty=null)"),
   *  distinct from `keyLiteral` (the ENTITY's own key segment, e.g. "Objkey='X'" from
   *  "ShopMaterialPickLineSet(Objkey='X')"). Real bug, live, 2026-08-11: a bound function/action
   *  reached via a key segment whose OWN first param is typed as the entity's `_Keys` record
   *  (e.g. `entity: ShopMaterialPickLineVirtual_Keys`) had that param treated as a bare
   *  positional scalar (wrong type entirely — server: "Argument 'entity' was expected to have
   *  type ...ShopMaterialPickLineVirtual_Keys, but the expression has type text"), and the
   *  trailing action's own real args (Source/PickToParentQty) were silently discarded — the OLD
   *  positional keyValues array only ever had ONE entry, from the entity's own key segment,
   *  so every param past the first one always got a bare `null`.
   *
   *  Fixed: when the FIRST key param's declared type resolves to a real record type (via
   *  findRecordTypeFields — the `_Keys` naming is IFS's own convention, not hardcoded here),
   *  build it as a REAL classified record (buildInlineRecordLet, from keyLiteral — the entity's
   *  own key) instead of a scalar, and match every REMAINING param BY NAME (not position)
   *  against actionKeyLiteral's own key=value pairs (OData named-arg calls don't guarantee
   *  param order). Every other call shape (no _Keys-record first param) is completely
   *  unaffected — falls straight through to the original positional keyValues mapping. */
  function buildWriteScript(moduleName, signature, call, keyLiteral, moduleSource, actionKeyLiteral, usedNames) {
    usedNames = usedNames || new Set();
    const nonHeaderParams = signature.params.filter((p) => p.name !== "headers");
    const inputParam = nonHeaderParams.find((p) => p.name === "input");
    const keyParams = nonHeaderParams.filter((p) => p.name !== "input");

    const valueSlots = [];
    const lines = [`open ${moduleName};`];
    const extraLines = [];

    let entityArgName = null;
    let remainingKeyParams = keyParams;
    if (keyLiteral && keyParams.length > 0) {
      const firstParamType = String(keyParams[0].type || "").trim().replace(/[?*]+$/, "");
      // Real bug caught by an existing test, 2026-08-11: matching ANY resolvable record type
      // here (not just IFS's own `_Keys` naming convention) accidentally caught
      // ValidateAddressNo_0's `validationRec: AddressStructure` param too — that one is
      // genuinely resolved through the SEPARATE, already-correct @AliasName mechanism a few
      // lines below, not a URL key segment at all. `_Keys` is IFS's own consistent real naming
      // convention for an entity's own key-identifying record (confirmed via every real example
      // seen today: ShopMaterialPickLineVirtual_Keys, CustomerOrderLine_Keys,
      // CustomerOrder_Keys) — specific enough to not collide with a normal data-carrying struct
      // like AddressStructure.
      const keysFields = /_Keys$/.test(firstParamType) ? findRecordTypeFields(moduleSource, firstParamType) : null;
      if (keysFields) {
        const keyNames = splitKeyNames(keyLiteral);
        const entityKeyValues = splitKeyValues(keyLiteral);
        const keyObj = {};
        if (keyNames.length === entityKeyValues.length) {
          keyNames.forEach((name, i) => { keyObj[name] = keyValueToJs(entityKeyValues[i]); });
        }
        entityArgName = disambiguateLocalName(keyParams[0].name || "entity", usedNames);
        lines.push(buildInlineRecordLet(entityArgName, firstParamType, keyObj, moduleSource, moduleName, valueSlots));
        remainingKeyParams = keyParams.slice(1);
      }
    }

    // Positional fallback (the original, unchanged mechanism) is only used when there's no
    // entity-record param — once one's detected, remaining params come from actionKeyLiteral,
    // matched by name, never by position.
    const keyValues = !entityArgName && keyLiteral ? splitKeyValues(keyLiteral) : [];
    const namedNames = entityArgName && actionKeyLiteral ? splitKeyNames(actionKeyLiteral) : [];
    const namedValues = entityArgName && actionKeyLiteral ? splitKeyValues(actionKeyLiteral) : [];

    // OData "parameter alias" syntax: a key segment value of the form `@AliasName` refers to a
    // same-named query-string parameter carrying the actual (often structured/object) value —
    // used when a value can't fit cleanly in a URL path segment. Real bug, 2026-08-08:
    // GetCustomerDefaults(...,CustomerDefaultsStructureParams=@CustomerDefaultsStructureParams)
    // with `?@CustomerDefaultsStructureParams=%7B...%7D` in the query string — the alias
    // reference itself was rendered as a literal text string ("@CustomerDefaultsStructureParams")
    // instead of being resolved to the real object it points at.
    let queryParams = null;
    try {
      queryParams = new URL(call.url).searchParams;
    } catch (e) {
      queryParams = null;
    }

    const remainingArgs = remainingKeyParams.map((p, i) => {
      let raw;
      if (entityArgName) {
        const idx = namedNames.findIndex((n) => n.toLowerCase() === p.name.toLowerCase());
        raw = idx === -1 ? undefined : namedValues[idx];
      } else {
        raw = keyValues[i];
      }
      const aliasMatch = raw !== undefined ? String(raw).trim().match(/^@(\w+)$/) : null;
      if (aliasMatch) {
        const rawAliasValue = queryParams ? queryParams.get(`@${aliasMatch[1]}`) : null;
        let parsed = null;
        if (rawAliasValue !== null && rawAliasValue !== undefined) {
          try { parsed = JSON.parse(rawAliasValue); } catch (e) { parsed = null; }
        }
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          extraLines.push(buildInlineRecordLet(p.name, p.type, parsed, moduleSource, moduleName, valueSlots));
          return p.name;
        }
        // Alias present but unresolvable (missing query param, malformed JSON, non-object value)
        // — a visible TODO beats silently emitting the wrong literal.
        return `/* TODO: could not resolve alias parameter @${aliasMatch[1]} */ null`;
      }

      let literal = keyValueToLiteral(raw);
      if (raw !== undefined) {
        const { kind, nullable } = classifyFlowType(p.type);
        if (kind === "enum") literal = formatValueForType(keyValueToJs(raw), p.type, moduleName);
        // valueNullable is the VALUE's own type nullability (text vs text?) — kept separate
        // from `nullable` (which also folds in "optional key", see buildInlineRecordLet)
        // because a dependency reference only needs isNull(...) unwrapping when the TYPE itself
        // is non-nullable, not when the field merely may be omitted.
        // kindKnown: true — p.type comes straight from the function's own parsed signature, a
        // real declared type, never a lookup that can fail (see buildInlineRecordLet's comment
        // for why this flag exists at all).
        valueSlots.push({ path: p.name, value: keyValueToJs(raw), literal, kind, kindKnown: true, nullable, valueNullable: nullable });
      }
      return literal;
    });

    const args = (entityArgName ? [entityArgName] : []).concat(remainingArgs);
    lines.push(...extraLines);

    if (inputParam) {
      let body = {};
      if (call.requestBody) {
        try { body = JSON.parse(call.requestBody); } catch (e) { body = {}; }
      }
      lines.push(buildInlineRecordLet("input", inputParam.type, body, moduleSource, moduleName, valueSlots));
      args.push("input");
    }

    lines.push(`return ${signature.name}(${args.join(", ")});`);
    return { script: lines.join("\n"), valueSlots };
  }

  const BUILD_BATCH_CALL_IFS_FUNCTION = [
    "function buildBatchCallIfs(batchEndpoint: text, content: {functionMethod: text, ifsFunction: text, jsonBody: text}*): text {",
    "  let bodyArray: {contentType: text, content: text}* = []",
    "  for item in content {",
    "    bodyArray = bodyArray & {",
    "      contentType: \"application/http\",",
    "      content: item.functionMethod & \" \" & item.ifsFunction & \" HTTP/1.1\\r\\n\" &",
    "        \"Accept: application/json;IEEE754Compatible=true\\r\\n\" &",
    "        \"Content-Type: application/json;IEEE754Compatible=true\\r\\n\" &",
    "        \"\\r\\n\" &",
    "        item.jsonBody",
    "    }",
    "  }",
    "  return HTTP.request(batchEndpoint, { method: \"POST\", body: HTTP.multipart('mixed', bodyArray) }).asText()",
    "}"
  ].join("\n");

  /** Translates a recorded $batch call into a script step calling the user-supplied
   *  buildBatchCallIfs helper (embedded inline — see the design spec for why there's no
   *  cross-step sharing). resultKind is "record" but the response is opaque text in v1 - no
   *  per-part response parsing, see the design spec's explicit scope note. */
  function buildBatchCallScript(call, moduleName) {
    const valueSlots = [];
    const boundary = extractBatchBoundary(getHeader(call.requestHeaders, "Content-Type"));
    const parts = splitMultipartParts(call.requestBody, boundary);
    const contentEntries = parts.map((partText, i) => buildBatchPart(i, partText, valueSlots));

    const contentLines = contentEntries
      .map((c) => `  {functionMethod: ${JSON.stringify(c.functionMethod)}, ifsFunction: ${c.ifsFunctionExpr}, jsonBody: ${c.jsonBody}}`)
      .join(",\n");

    const script = [
      `open ${moduleName};`,
      BUILD_BATCH_CALL_IFS_FUNCTION,
      `return buildBatchCallIfs(${JSON.stringify(stripUrlOrigin(call.url))}, [\n${contentLines}\n]);`
    ].join("\n");

    return { script, label: "BatchCall", resolved: true, valueSlots, resultKind: "record", resultFields: null };
  }

  /** Builds a script for a navigation-property-scoped QUERYABLE GET — see buildCallScript's own
   *  call site for the full real-case background. Produces:
   *    open Module;
   *    let entity: <KeysType> = {...};   // from the URL's own key segment, real declared fields
   *    let source = <NavProp>_From<EntitySet>(entity);
   *    return select * from source where <$filter-derived clause, if any>;
   *  The child row type (for $filter/dependency classification) is pulled from the resolved
   *  function's OWN body (its `Queryable.Create<..., RowType, ...>` call) — not guessed. Returns
   *  null (caller falls back to the normal resolution path) when the candidate function doesn't
   *  exist, doesn't take exactly one `_Keys`-typed param, or its own row type/body can't be
   *  resolved — never guess a broken script. */
  function buildNavigationQueryableScript(moduleName, moduleSource, entitySetName, navPropertyName, keyLiteral, call, usedNames) {
    usedNames = usedNames || new Set();
    const candidateName = `${navPropertyName}_From${entitySetName}`;
    const signature = findFunctionSignature(moduleSource, candidateName);
    if (!signature) return null;

    const params = signature.params.filter((p) => p.name !== "headers");
    if (params.length !== 1) return null; // expects exactly the parent's own key record

    const keysTypeName = String(params[0].type || "").trim().replace(/[?*]+$/, "");
    const keysFields = findRecordTypeFields(moduleSource, keysTypeName);
    if (!keysFields) return null; // param isn't a resolvable record type — not this shape

    const body = findFunctionBody(moduleSource, candidateName);
    if (!body) return null;
    const rowTypeMatch = body.match(/Queryable\.Create<[^,]+,\s*([A-Za-z0-9_]+)\s*,/);
    if (!rowTypeMatch) return null; // doesn't return a Queryable — not this shape
    const rowFields = findRecordTypeFields(moduleSource, rowTypeMatch[1]);

    // Parent key values, keyed by name — same key-segment parsing every other GET branch already
    // uses. Built as a plain object so buildInlineRecordLet can classify+render it exactly like
    // any other record literal (real declared field types, enum conversion, etc.), instead of a
    // bare positional-scalar argument (the shape every OTHER resolved-function call uses, wrong
    // here since this function's sole param is a whole record, not a scalar).
    const keyObj = {};
    if (keyLiteral) {
      const keyNames = splitKeyNames(keyLiteral);
      const keyValues = splitKeyValues(keyLiteral);
      if (keyNames.length === keyValues.length) {
        keyNames.forEach((name, i) => { keyObj[name] = keyValueToJs(keyValues[i]); });
      }
    }

    const entityVar = disambiguateLocalName("entity", usedNames);
    const sourceVar = disambiguateLocalName("source", usedNames);

    const valueSlots = [];
    const entityLine = buildInlineRecordLet(entityVar, keysTypeName, keyObj, moduleSource, moduleName, valueSlots);

    const where = buildWhereClause(call.url, rowFields, moduleName);
    if (where) {
      where.valueSlots.forEach((slot) => {
        const fieldName = slot.path.slice("filter.".length);
        const declared = rowFields && rowFields.find((f) => f.name === fieldName);
        const classified = declared ? classifyFlowType(declared.type) : { kind: "text", nullable: false };
        valueSlots.push(Object.assign({}, slot, {
          kind: classified.kind,
          kindKnown: !!declared,
          nullable: classified.nullable || (declared ? declared.optional : false),
          valueNullable: classified.nullable
        }));
      });
    }

    const selectLine = `return select * from ${sourceVar}` + (where ? ` where ${where.clause}` : "");
    const script = [
      `open ${moduleName};`,
      entityLine,
      `let ${sourceVar} = ${candidateName}(${entityVar});`,
      selectLine
    ].join("\n");

    return {
      script,
      label: candidateName,
      resolved: true,
      valueSlots,
      resultKind: "sequence",
      resultFields: rowFields
    };
  }

  /** Builds a script for a WRITE (PATCH/PUT/POST) to a child ROW of a navigation-property
   *  collection — the write-side counterpart to buildNavigationQueryableScript above. Real case,
   *  2026-08-13: "SplitArrivalSet(Objkey='X')/SplitArrivalLines(Objkey='Y')" (PATCH). Confirmed
   *  against the real module source: IFS generates one function per verb, named
   *  "<EntitySet>_<NavProp>_<Verb>" (Update/Create — e.g. SplitArrivalSet_SplitArrivalLines_Update,
   *  SequenceGeneratorSet_SequenceArray_Create), taking PLAIN SCALAR key params (parent's own key
   *  segment fields, then — for Update only — the child row's own key segment fields, in that
   *  order), then `input: <Verb>Request`. Unlike buildNavigationQueryableScript's GET-side
   *  function, no `_Keys` record wrapping — every real signature seen uses bare scalars here.
   *  Returns null (caller falls through to the normal resolution path, never a guessed/broken
   *  script) when the candidate function doesn't exist or its key-param count doesn't match the
   *  URL's own parent+child key segments exactly. DELETE isn't handled yet (see buildCallScript's
   *  own call site comment). */
  function buildNavigationChildWriteScript(moduleName, moduleSource, entitySetName, navPropertyName, method, parentKeyLiteral, childKeyLiteral, call, usedNames) {
    usedNames = usedNames || new Set();
    const verb = method === "POST" ? "Create" : "Update"; // PATCH and PUT both mean Update here
    const candidateName = `${entitySetName}_${navPropertyName}_${verb}`;
    const signature = findFunctionSignature(moduleSource, candidateName);
    if (!signature) return null;

    const nonHeaderParams = signature.params.filter((p) => p.name !== "headers");
    const inputParam = nonHeaderParams.find((p) => p.name === "input");
    const keyParams = nonHeaderParams.filter((p) => p.name !== "input");
    if (!inputParam) return null; // every real Update/Create signature seen carries one

    const parentKeyValues = parentKeyLiteral ? splitKeyValues(parentKeyLiteral) : [];
    const childKeyValues = verb === "Update" && childKeyLiteral ? splitKeyValues(childKeyLiteral) : [];
    const expectedKeyCount = parentKeyValues.length + childKeyValues.length;
    // Param count must match the URL's own key segments EXACTLY — a mismatch means this isn't
    // really the plain-scalar-key shape this function handles (e.g. a compound/record key),
    // never guess which raw value maps to which param.
    if (keyParams.length !== expectedKeyCount || expectedKeyCount === 0) return null;

    const allKeyValues = parentKeyValues.concat(childKeyValues);
    const valueSlots = [];
    const keyArgs = keyParams.map((p, i) => {
      const raw = allKeyValues[i];
      let literal = keyValueToLiteral(raw);
      const { kind, nullable } = classifyFlowType(p.type);
      if (kind === "enum") literal = formatValueForType(keyValueToJs(raw), p.type, moduleName);
      valueSlots.push({ path: p.name, value: keyValueToJs(raw), literal, kind, kindKnown: true, nullable, valueNullable: nullable });
      return literal;
    });

    let body = {};
    if (call.requestBody) {
      try { body = JSON.parse(call.requestBody); } catch (e) { body = {}; }
    }
    const inputVar = disambiguateLocalName("input", usedNames);
    const inputLine = buildInlineRecordLet(inputVar, inputParam.type, body, moduleSource, moduleName, valueSlots);

    const returnTypeName = signature.returnType ? String(signature.returnType).trim().replace(/[?*]+$/, "") : null;
    const resultFields = returnTypeName ? findRecordTypeFields(moduleSource, returnTypeName) : null;

    const script = [
      `open ${moduleName};`,
      inputLine,
      `return ${candidateName}(${keyArgs.concat([inputVar]).join(", ")});`
    ].join("\n");

    return {
      script,
      label: candidateName,
      resolved: true,
      valueSlots,
      resultKind: "record",
      resultFields
    };
  }

  /** Returns { script, label, resolved, valueSlots, resultKind }. "resultKind" is "sequence" for
   *  a select-from-queryable step (result must be narrowed with firstOrNull(...) before a later
   *  step can reference a field on it) or "record" for a single-result function call (referenced
   *  directly). Never throws — an unresolvable call becomes a TODO placeholder step. */
  function buildCallScript(call, moduleName, moduleSource, usedNames) {
    usedNames = usedNames || new Set();
    if (isBatchCall(call)) {
      return buildBatchCallScript(call, moduleName);
    }
    const svcPath = pathAfterSvc(call.url);
    const segments = svcPath.split("/").filter(Boolean);
    if (segments.length === 0) {
      return {
        script: `// TODO: could not determine endpoint for ${call.method} ${call.url}`,
        label: "Unknown",
        resolved: false,
        // Structured failure reason — mandatory directive, 2026-08-11: a step carrying commented
        // TODO placeholder script must never be added to the generated Flow (was happening
        // unconditionally before this — ifs-modules.js never checked `resolved`). This lets the
        // caller build a clean end-of-generation failure summary instead of string-parsing the
        // TODO comment text.
        reason: "Could not determine endpoint from the call's URL",
        valueSlots: [],
        resultKind: "record"
      };
    }

    const { entitySetName, keyLiteral } = parseFirstSegment(segments[0]);
    const method = String(call.method || "GET").toUpperCase();

    let actionName = null;
    // The trailing action segment's OWN embedded key=value args (e.g. "Source='X',Qty=null" from
    // "...CheckSerialRecords(Source='X',Qty=null)") — distinct from `keyLiteral` above (the
    // ENTITY's own key segment). Real bug, live, 2026-08-11: previously discarded entirely when
    // stripping the "(...)" to extract actionName — see buildWriteScript's own doc comment for
    // the real case (ShopMaterialPickLineVirtual_CheckSerialRecords) this was silently dropping.
    let actionKeyLiteral = null;
    // True only for a genuine bound function/action segment — every real one seen this session is
    // namespace-qualified in the URL (e.g. "IfsApp.ReceiveWithSerialsLots.SomeAction(...)",
    // confirmed against the real module source's own action-invocation URLs throughout). A bare
    // navigation-property segment (e.g. "SplitArrivalLines(Objkey='X')", a child ROW of a nav
    // collection, not an action) never carries a dot. Real bug, 2026-08-13 — see
    // buildNavigationChildWriteScript's own doc comment for the case this distinction exists for.
    let isDotQualifiedAction = false;
    if (segments.length > 1) {
      const lastSeg = segments[segments.length - 1];
      // Bound function/action calls end in a parenthesized (possibly empty) argument list, e.g.
      // "IfsApp.CustomerOrderHandling.CustomerOrder_Default()" — strip it before extracting the
      // short name, or the trailing "()" ends up glued onto the name and findFunctionSignature's
      // marker search never matches. Real bug, 2026-08-08.
      const argsMatch = lastSeg.match(/\((.*)\)$/);
      if (argsMatch && argsMatch[1]) actionKeyLiteral = argsMatch[1];
      const withoutArgs = lastSeg.replace(/\(.*\)$/, "");
      isDotQualifiedAction = withoutArgs.includes(".");
      actionName = isDotQualifiedAction ? withoutArgs.slice(withoutArgs.lastIndexOf(".") + 1) : withoutArgs;
    }

    // A WRITE (PATCH/PUT/POST) to a child ROW of a navigation-property collection (e.g.
    // "SplitArrivalSet(Objkey='X')/SplitArrivalLines(Objkey='Y')", PATCHing one line of a virtual
    // entity's own child array) — real bug, live, 2026-08-13
    // (ReceiveWithSerialsLots.svc/SplitArrivalSet.../SplitArrivalLines): actionName here is
    // "SplitArrivalLines", a bare (non-dot-qualified) nav-property name, not a bound action — but
    // deriveWriteCandidates' `if (actionName)` branch unconditionally took priority over the
    // method-based write-verb branch right below it regardless of method, producing candidates
    // like "SplitArrivalSet_SplitArrivalLines" (missing the real "_Update" suffix) that never
    // match anything in the module. The real generated function IS
    // "<EntitySet>_<NavProp>_Update"/"_Create" (confirmed against the real module source:
    // SplitArrivalSet_SplitArrivalLines_Update, SequenceGeneratorSet_SequenceArray_Create, etc —
    // same nav-property-write convention throughout the whole file) — tried BEFORE the generic
    // bound-function/write-candidate resolution below since it's the more specific shape; returns
    // null (falls through unchanged) when the candidate function doesn't exist or its param count
    // doesn't match the URL's own key segments, never guess a broken script. DELETE isn't handled
    // here yet (a real "_Delete" nav-child function exists too, e.g.
    // SequenceGeneratorSet_SequenceArray_Delete, but no failing DELETE case has been seen yet —
    // known related gap, not guessed).
    if ((method === "PATCH" || method === "PUT" || method === "POST") && segments.length === 2 && actionName && !isDotQualifiedAction) {
      const navWriteResult = buildNavigationChildWriteScript(moduleName, moduleSource, entitySetName, actionName, method, keyLiteral, actionKeyLiteral, call, usedNames);
      if (navWriteResult) return navWriteResult;
    }

    // A GET on a navigation-property-scoped QUERYABLE (e.g.
    // ShopMaterialPickLineSet(Objkey='X')/ShopMaterialPickLineArray?$select=...) has no bound
    // function/action at all, but the last segment still LOOKS like one to the actionName
    // extraction above (a plain name, no dot) — real bug, live, 2026-08-11: neither the
    // bound-function resolution below (needs a real action match) nor the plain-queryable branch
    // right after this (only ever checks segments[0]) can find or correctly call this. Confirmed
    // against a real module source: IFS/Flow exposes this shape as a PLAIN FUNCTION (not a
    // `let X = Queryable.Create` variable), named `<NavProperty>_From<ParentEntitySet>`, taking
    // the parent row's own `<EntityType>_Keys` record and returning `Queryable.Create<...>` —
    // `ShopMaterialPickLineArray_FromShopMaterialPickLineSet(entity:
    // ShopMaterialPickLineVirtual_Keys)`. Matched purely from the URL's own two segments (parent
    // entity set + navigation-property name), not by scanning the module by function body/content
    // — tried BEFORE the bound-function/plain-queryable paths since it's the more specific shape;
    // returns null (falls through unchanged) when the candidate function doesn't exist, doesn't
    // take exactly one `_Keys`-typed param, or its own row type can't be resolved.
    if (method === "GET" && segments.length === 2 && actionName) {
      const navResult = buildNavigationQueryableScript(moduleName, moduleSource, entitySetName, actionName, keyLiteral, call, usedNames);
      if (navResult) return navResult;
    }

    // GET is only "select * from EntitySet" when there's no trailing bound-function/action
    // segment AND the module turned this endpoint into a Queryable — plenty of GET endpoints
    // (e.g. GetBasicCustomerInformation) are just plain functions instead, and a GET like
    // "CustomerOrderSet/IfsApp.CustomerOrderHandling.CustomerOrder_Default()" is a bound
    // FUNCTION call on the entity set, not a query at all. Real bug, 2026-08-08: this check
    // never looked at actionName, so a bound-function GET on a queryable entity set silently
    // became a full unfiltered "select * from CustomerOrderSet" table scan instead of calling
    // CustomerOrder_Default() — both fall through to the same function-resolution path as
    // writes when actionName is present.
    if (method === "GET" && !actionName) {
      const queryableVar = findQueryableVarName(moduleSource, entitySetName);
      if (queryableVar) {
        // Resolved regardless of whether there's a $filter (not just `where ? ... : null`) — a
        // later step referencing this one's result fields needs the row type even for an
        // unfiltered select (exposed as resultFields below), AND buildWhereClause itself needs
        // it up front now (not after, like before) to render an enum comparison correctly the
        // first time — see buildWhereClause's own doc comment, real bug 2026-08-10.
        const rowType = findQueryableRowType(moduleSource, queryableVar);
        const rowFields = rowType ? findRecordTypeFields(moduleSource, rowType) : null;
        const where = buildWhereClause(call.url, rowFields, moduleName);

        // A GET can also narrow a queryable via a NAMED key segment directly on the entity
        // (e.g. "Reference_CustOrdCust6(Company='X',CustomerNo='Y')") rather than a $filter.
        // Real bug, 2026-08-08: keyLiteral was parsed at the top of buildCallScript but never
        // consulted here — both key values were silently dropped, producing a full unfiltered
        // "select * from Reference_CustOrdCust6" and never even entering valueSlots, so
        // CustomerNo never got offered for dependency-matching or user-input classification.
        // Only NAMED key segments are handled — an unnamed single key (e.g.
        // "OrderQuotationSet('Q1')") would need the entity's own declared key field name, which
        // isn't recoverable from the module source we parse; left as a known gap, same as before
        // this fix.
        let keyClause = null;
        const keyValueSlots = [];
        if (keyLiteral) {
          const keyNames = splitKeyNames(keyLiteral);
          const keyValues = splitKeyValues(keyLiteral);
          if (keyNames.length > 0 && keyNames.length === keyValues.length) {
            const parts = keyNames.map((name, i) => {
              const raw = keyValues[i];
              const declared = rowFields && rowFields.find((f) => f.name === name);
              const classified = declared ? classifyFlowType(declared.type) : { kind: "text", nullable: false };
              let literal = keyValueToLiteral(raw);
              if (classified.kind === "enum") literal = formatValueForType(keyValueToJs(raw), declared.type, moduleName);
              keyValueSlots.push({
                path: `filter.${name}`,
                value: keyValueToJs(raw),
                literal,
                kind: classified.kind,
                kindKnown: !!declared, // see buildInlineRecordLet's comment — kind always defaults to "text", never treat that default as a positive classification
                nullable: classified.nullable || (declared ? declared.optional : false),
                valueNullable: classified.nullable
              });
              return `${name} = ${literal}`;
            });
            keyClause = parts.join(" and ");
          }
        }

        const filterValueSlots = (where ? where.valueSlots : []).map((slot) => {
          const fieldName = slot.path.slice("filter.".length);
          const declared = rowFields && rowFields.find((f) => f.name === fieldName);
          const classified = declared ? classifyFlowType(declared.type) : { kind: "text", nullable: false };
          return Object.assign({}, slot, {
            kind: classified.kind,
            kindKnown: !!declared, // see buildInlineRecordLet's comment
            nullable: classified.nullable || (declared ? declared.optional : false),
            valueNullable: classified.nullable
          });
        });

        const combinedClause = keyClause && where ? `${keyClause} and ${where.clause}` : keyClause || (where ? where.clause : null);
        const selectLine = `return select * from ${queryableVar}` + (combinedClause ? ` where ${combinedClause}` : "");

        return {
          script: `open ${moduleName};\n${selectLine}`,
          label: entitySetName,
          resolved: true,
          valueSlots: keyValueSlots.concat(filterValueSlots),
          resultKind: "sequence",
          resultFields: rowFields
        };
      }
    }

    const candidates = deriveWriteCandidates(method, entitySetName, actionName);
    const keyNames = keyLiteral ? splitKeyNames(keyLiteral) : [];
    for (const candidate of candidates) {
      const signature = findBestMatchingOverload(moduleSource, candidate, keyNames);
      if (signature) {
        // The function's declared RETURN type's own field kinds — a GET/function call's return
        // type is routinely looser than its semantic meaning (e.g. an enum-like field declared
        // as plain `text?`), confirmed live 2026-08-08 (GetCustomerDefaults.SupplyCountryDb).
        // null when the return type isn't a named record declared in this module (a primitive
        // return type, or one declared elsewhere) — findRecordTypeFields already returns null
        // in that case, nothing extra to guard here.
        const resultFields = signature.returnType
          ? findRecordTypeFields(moduleSource, signature.returnType.replace(/\?$/, "").replace(/\*$/, ""))
          : null;

        // See buildRawContextualCallScript's own doc comment — a GET resolved to a wrapper with
        // ZERO real params can't carry any of the URL's own context (a key on the first segment,
        // and/or a middle navigation-property segment), so calling it silently drops that
        // context. Only fires for GET (a write call's real context comes via its request body
        // instead, a different mechanism this doesn't affect).
        const nonHeaderParams = signature.params.filter((p) => p.name !== "headers");
        if (method === "GET" && nonHeaderParams.length === 0 && (keyLiteral || segments.length > 2)) {
          const raw = buildRawContextualCallScript(moduleName, moduleSource, candidate, svcPath, entitySetName, keyLiteral, usedNames);
          if (raw) {
            return { script: raw.script, label: candidate, resolved: true, valueSlots: raw.valueSlots, resultKind: "record", resultFields };
          }
        }

        const { script, valueSlots } = buildWriteScript(moduleName, signature, call, keyLiteral, moduleSource, actionKeyLiteral, usedNames);
        return { script, label: candidate, resolved: true, valueSlots, resultKind: "record", resultFields };
      }
    }

    return {
      script: `// TODO: could not resolve a Flow function for ${method} ${call.url}`,
      label: entitySetName,
      resolved: false,
      // See the other resolved:false return's own comment above — structured reason for the
      // end-of-generation failure summary, mandatory directive 2026-08-11.
      reason: "Could not find a matching Flow function in the module for this call",
      valueSlots: [],
      resultKind: "record"
    };
  }

  const api = {
    stripUrlOrigin,
    extractSvcName,
    pathAfterSvc,
    splitKeyValues,
    keyValueToLiteral,
    keyValueToJs,
    toFlowScriptLiteral,
    enumModuleName,
    formatValueForType,
    buildRecordLiteral,
    collectValueSlots,
    findFunctionSignature,
    findFunctionBody,
    buildRawContextualCallScript,
    buildNavigationQueryableScript,
    buildNavigationChildWriteScript,
    disambiguateLocalName,
    classifyFlowType,
    findRecordTypeFields,
    findQueryableRowType,
    deriveWriteCandidates,
    buildGetScript,
    buildWriteScript,
    buildInlineRecordLet,
    splitKeyNames,
    findFunctionOverloads,
    scoreOverloadMatch,
    findBestMatchingOverload,
    buildWhereClause,
    extractODataFilter,
    buildCallScript,
    getHeader,
    extractBatchBoundary,
    isBatchCall,
    splitMultipartParts,
    parseBatchPartRequestLine,
    rawQuotedODataValue,
    buildBatchIfsFunctionExpr,
    buildBatchPart,
    buildBatchCallScript
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.FlowCallScript = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
