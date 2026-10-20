/* ============================================================
   Composite key-ref reconstruction — IFS occasionally builds a single
   opaque string identifying one exact record by concatenating ALL its
   key/identifying fields into one ^-delimited string, DB column naming
   (e.g. ActivitySeq -> ACTIVITY_SEQ), sometimes assembled entirely
   client-side in IFS's own UI (never appears as separate fields
   anywhere in the recorded trace). Real confirmed example
   (IFS_Session_12_8_2026_10_59.json, PrepareSelectedPickListLines):
   PickListSelection: ["ACTIVITY_SEQ=100128618^CONFIGURATION_ID=*^..."]
   — every field in it matches (after DB-name conversion) fields
   returned by an earlier list call in the same session.

   Scope (Case 1 only, designed 2026-08-12 — see project_ifs_backlog.md
   for cases 2/3, not built yet): matches a key-ref string against a
   SINGLE prior RECORD-kind step result, never an array/sequence result
   (that's Case 2, needs list-selection, a separate not-yet-built
   piece). Only ever runs as a fallback once normal dependency matching
   has already failed for a value — never competes with it, never
   guesses a partial match (all-or-nothing per real design decision,
   same "no silent wrong guess" precedent as everywhere else in this
   codebase).

   Pure matching/reconstruction logic only. Wiring this into the
   fallback flow and the review modal lives in ifs-modules.js.
   ============================================================ */
(function (global) {
  const KEY_VALUE_SEGMENT_RE = /^[A-Z][A-Z0-9_]*=/;

  /** True when `value` structurally looks like a composite key-ref string: one or more
   *  ^-delimited "UPPER_SNAKE_NAME=value" segments. Deliberately permissive on the VALUE side
   *  (any characters at all, including another literal "^" isn't possible since we split on it —
   *  a real limitation if a value ever legitimately contains "^", not observed in any real
   *  capture so far) since only the NAME side follows IFS's own fixed DB-naming convention. Cheap
   *  and safe to run broadly since this is only ever a FALLBACK after normal matching failed —
   *  a false positive here just means a fruitless (and free) search, not a wrong result. */
  function looksLikeKeyRef(value) {
    if (typeof value !== "string" || !value.includes("^")) return false;
    const segments = value.split("^").filter(Boolean);
    if (segments.length === 0) return false;
    return segments.every((seg) => KEY_VALUE_SEGMENT_RE.test(seg));
  }

  /** Splits a confirmed key-ref string into its own {dbName, value} segments, in original
   *  order (needed to rebuild the exact same string later, same field order/delimiters). Drops
   *  the trailing empty segment the terminal "^" produces. Splits each segment on the FIRST "="
   *  only — a value could theoretically contain one, the name side never does. */
  function parseKeyRefSegments(value) {
    return value.split("^").filter(Boolean).map((seg) => {
      const eqIdx = seg.indexOf("=");
      return { dbName: seg.slice(0, eqIdx), value: seg.slice(eqIdx + 1) };
    });
  }

  /** IFS's real DB column naming convention: SCREAMING_SNAKE_CASE. Converts to the PascalCase
   *  form real API/FlowScript field names use (ACTIVITY_SEQ -> ActivitySeq). Mechanical only —
   *  the caller still verifies the result against a real declared field before trusting it
   *  (findMatchingRecord below); this function alone doesn't guarantee a real field exists —
   *  IFS's own naming occasionally diverges further than a case-flip for some fields, an
   *  accepted, documented risk (same field just won't match, never guessed wrong). */
  function dbNameToApiName(dbName) {
    return String(dbName || "")
      .toLowerCase()
      .split("_")
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join("");
  }

  /** True when `value` is a FlowScript enum value's own wire shape — {enumerationNamespace,
   *  name} — confirmed real throughout this whole project (every GET response with an
   *  enum-typed field). Detected structurally from the value itself, not via a separate
   *  declared-type lookup — simpler and doesn't depend on resultFields having resolved
   *  correctly for this particular field. */
  function isEnumShapedValue(value) {
    return !!value && typeof value === "object" &&
      typeof value.name === "string" && typeof value.enumerationNamespace === "string";
  }

  /** Same stringification an enum-shaped value needs everywhere else in this codebase (real
   *  bug, live, 2026-08-10/11 — see flow-dependency-tracer.js's applyDependency: FlowScript's
   *  own str() dumps an enum's raw object shape instead of its plain member name, .name field
   *  access is the real, live-confirmed fix). Any other value just gets String()'d — a key-ref's
   *  own recorded values are always plain text/numbers. */
  function stringifyFieldValue(value) {
    return isEnumShapedValue(value) ? value.name : String(value);
  }

  /** Searches every RECORD-kind (never sequence/array — Case 2, not built yet) prior step
   *  result for one whose OWN real fields (after DB-name conversion) cover EVERY segment, with
   *  every value matching exactly. All-or-nothing per record — no partial matches, per explicit
   *  design decision (a partial match is a real false-positive risk this codebase has hit
   *  before, bugs #22/#24's value-only-coincidence class). stepContexts: same shape
   *  flow-dependency-tracer.js's own pool-building already consumes (each needs resultKind,
   *  responseBody, stepVarName). Returns { stepIndex, stepVarName, resultKind, row,
   *  fieldsByDbName: {dbName -> realFieldName} } for the first fully-matching record found, or
   *  null. */
  function findMatchingRecord(segments, stepContexts) {
    for (let stepIndex = 0; stepIndex < (stepContexts || []).length; stepIndex++) {
      const ctx = stepContexts[stepIndex];
      if (!ctx || ctx.resultKind !== "record") continue;
      const rows = global.FlowDependencyTracer.extractRows(ctx.responseBody);
      const row = rows && rows[0];
      if (!row) continue;

      const fieldsByDbName = {};
      const allMatch = segments.every((seg) => {
        const apiName = dbNameToApiName(seg.dbName);
        if (!(apiName in row)) return false;
        if (stringifyFieldValue(row[apiName]) !== seg.value) return false;
        fieldsByDbName[seg.dbName] = apiName;
        return true;
      });
      if (allMatch) return { stepIndex, stepVarName: ctx.stepVarName, resultKind: ctx.resultKind, row, fieldsByDbName };
    }
    return null;
  }

  /** Builds the FlowScript expression that reconstructs the EXACT original string at runtime.
   *  Literal "NAME=" / "^" text preserved verbatim (the OUTPUT string must stay DB-named for
   *  IFS to parse it back — only the VALUES become live references, never the names). An
   *  enum-shaped matched field uses .name field access (str() is proven wrong for enums — see
   *  isEnumShapedValue's own doc comment); anything else uses str(...) so a non-text field
   *  (number, etc.) concatenates safely. */
  function buildReconstructionExpression(segments, match) {
    const parts = segments.map((seg) => {
      const apiName = match.fieldsByDbName[seg.dbName];
      const ref = global.FlowDependencyTracer.referenceExpression(match.stepVarName, match.resultKind, apiName, false);
      const textExpr = isEnumShapedValue(match.row[apiName]) ? `${ref}.name` : `str(${ref})`;
      return `"${seg.dbName}=" & ${textExpr} & "^"`;
    });
    return parts.join(" & ");
  }

  /** Orchestrates the whole fallback: detect, parse, match, build. Returns
   *  { expression, stepIndex, stepVarName } when every segment matched the SAME record, or null
   *  (caller falls through to the existing hardcode/user-input path unchanged) otherwise — never
   *  guess a broken script. */
  function tryReconstructKeyRef(value, stepContexts) {
    if (!looksLikeKeyRef(value)) return null;
    const segments = parseKeyRefSegments(value);
    const match = findMatchingRecord(segments, stepContexts);
    if (!match) return null;
    return {
      expression: buildReconstructionExpression(segments, match),
      stepIndex: match.stepIndex,
      stepVarName: match.stepVarName
    };
  }

  const api = {
    looksLikeKeyRef,
    parseKeyRefSegments,
    dbNameToApiName,
    isEnumShapedValue,
    stringifyFieldValue,
    findMatchingRecord,
    buildReconstructionExpression,
    tryReconstructKeyRef
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.FlowKeyRef = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
