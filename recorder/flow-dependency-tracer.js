/* ============================================================
   Flow Dependency Tracer — finds values a step needs (key params,
   request-body fields) that were already produced by an earlier
   step's response in the same recording, so the generated script
   can reference that step's output instead of a hardcoded literal.

   Pure matching/substitution logic only. Persisting confirmed
   mappings and the review UI live in ifs-modules.js.
   ============================================================ */
(function (global) {
  /** Same recursive flattening as FlowCallScript.collectValueSlots, duplicated here so this
   *  module has no load-order dependency on flow-call-script.js (small, pure, cheap to keep
   *  independent — same trade-off already made for the .svc regex elsewhere in this project). */
  function collectValues(value, path, out) {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => collectValues(v, `${path}[${i}]`, out));
      return;
    }
    if (typeof value === "object") {
      Object.keys(value).forEach((k) => collectValues(value[k], path ? `${path}.${k}` : k, out));
      return;
    }
    out.push({ path, value });
  }

  /** Picks the one record a later step's reference would resolve against: the first row of
   *  an OData collection response, or the response body itself for a single-entity/function
   *  result. Returns null if there's no usable row (empty collection, unparsable body, etc). */
  function extractFirstRow(responseBodyText) {
    if (!responseBodyText) return null;
    let parsed;
    try {
      parsed = JSON.parse(responseBodyText);
    } catch (e) {
      return null;
    }
    if (parsed && Array.isArray(parsed.value)) return parsed.value[0] || null;
    return parsed;
  }

  /** Returns every row of an OData collection response, or a single-element array for a
   *  single-entity/function result body. [] if there's nothing usable. */
  function extractRows(responseBodyText) {
    if (!responseBodyText) return [];
    let parsed;
    try {
      parsed = JSON.parse(responseBodyText);
    } catch (e) {
      return [];
    }
    if (parsed && Array.isArray(parsed.value)) return parsed.value;
    return parsed ? [parsed] : [];
  }

  /** Last field segment of a dotted/indexed path, e.g. "input.Lines[0].Qty" -> "Qty",
   *  "QuotationNo" -> "QuotationNo". Used to compare field names, not full paths — the
   *  source and target sides are rarely addressed the same way (different nesting). */
  function lastFieldName(path) {
    const cleaned = String(path || "").replace(/\[\d+\]/g, "");
    const parts = cleaned.split(".");
    return parts[parts.length - 1] || "";
  }

  /** 2 = exact (case-insensitive) name match, 1 = one name contains the other, 0 = unrelated.
   *  Ranked rather than boolean so an exact match always outranks a merely-containing one —
   *  e.g. target "CompanyActive" must prefer a source field named exactly "CompanyActive"
   *  over an unrelated "Active" that happens to be a substring of it. */
  function nameSimilarityScore(a, b) {
    const na = String(a || "").toLowerCase();
    const nb = String(b || "").toLowerCase();
    if (!na || !nb) return 0;
    if (na === nb) return 2;
    if (na.includes(nb) || nb.includes(na)) return 1;
    return 0;
  }

  function namesSimilar(a, b) {
    return nameSimilarityScore(a, b) > 0;
  }

  /** Same classification as FlowCallScript.classifyFlowType, duplicated here so this module
   *  has no load-order dependency on flow-call-script.js (same trade-off already made for
   *  collectValues above). Only `.kind` is used here (a source field's declared kind, to know
   *  whether it needs converting to match an enum-typed target — see applyDependency), but kept
   *  as the full {kind, nullable} shape for parity with the original. */
  function classifyFieldType(typeStr) {
    const trimmed = String(typeStr || "").trim();
    const nullable = trimmed.endsWith("?");
    const base = trimmed.replace(/\?$/, "").replace(/\*$/, "").trim();
    if (base === "number") return { kind: "number", nullable };
    if (base === "datetime") return { kind: "datetime", nullable };
    if (base === "boolean") return { kind: "boolean", nullable };
    // enumType: the specific enum module name (e.g. "PartOwnership"), not just the generic
    // "enum" kind — needed to tell two DIFFERENT enum types apart. Real bug, live, 2026-08-10:
    // IFS declares many narrower "Subset" variant enums sharing the same real-world field name
    // (PartOwnershipSubset1/2/3, PartOwnershipRentOnly, ... all distinct FlowScript nominal
    // types, confirmed via real OpenAPI: CustOrdLineValidation.PartOwnership itself is the FULL
    // PartOwnership enum, but some OTHER step's own row type declares a same-named field typed
    // as one of the narrower Subset variants) — a source correctly classified as "enum" and a
    // target correctly classified as "enum" were assumed to be the SAME enum type and left as a
    // bare reference, but they can genuinely be two DIFFERENT enum types sharing a field name;
    // Flow's compiler correctly rejected it ("has type ...PartOwnershipSubset1.Value but
    // expected ...PartOwnership.Value").
    const enumMatch = base.match(/^(\w+)\.Value$/);
    if (enumMatch) return { kind: "enum", nullable, enumType: enumMatch[1] };
    return { kind: "text", nullable };
  }

  /** A source step is treated as a list of candidate values to pick FROM (rather than a single
   *  already-resolved record) when either its function/entity name suggests an LOV, or it
   *  actually returned more than one row in this recording. A single row from a non-"Lov"-named
   *  source is assumed to already be a precise fetch-by-key — no selection needed. */
  function isListSource(label, rows) {
    return rows.length > 1 || /lov/i.test(label || "");
  }

  // Common textual stand-ins for a boolean, case-insensitive — OData/IFS routinely represents a
  // flag as one of these instead of a real true/false. Chasing individual "risky" values (0, 1,
  // 2, ...) one bug report at a time doesn't converge — real bug, 2026-08-10: "2" wasn't on the
  // list, so RevisedQtyDue coincidentally matched CurrRounding (unrelated fields, zero name
  // similarity, both genuinely "2"). Generalized instead: see isLowInformationValue below.
  const BOOLEAN_LIKE_STRINGS = new Set(["true", "false", "yes", "no", "y", "n"]);

  /** True for a value with too little information content to trust a coincidental (value-only,
   *  no name similarity at all) match against. Booleans, and now ANY bare number or
   *  numeric-looking text — not just 0/1 — are excluded: small numeric values (quantities,
   *  counts, factors, rounding levels, indices) repeat constantly across completely unrelated
   *  fields in real IFS data, so a name-blind match on a shared number is barely more
   *  trustworthy than a shared boolean regardless of its magnitude. Also excludes common
   *  boolean-word text ("TRUE"/"Yes"/"N", case-insensitive) for the same reason numeric text is
   *  excluded — OData/IFS represents a flag as text at least as often as as a real boolean.
   *  Empty string/null are excluded too — a blank default is even less informative than any of
   *  the above. A genuinely distinctive text value (a customer number, a code, a name) is NOT
   *  excluded — those still carry real information and the fallback remains useful for them. */
  function isLowInformationValue(value) {
    if (typeof value === "boolean") return true;
    if (value === "" || value === null) return true;
    if (typeof value === "number") return true;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (/^-?\d+(\.\d+)?$/.test(trimmed)) return true;
      if (BOOLEAN_LIKE_STRINGS.has(trimmed.toLowerCase())) return true;
    }
    return false;
  }

  /** stepContexts: ordered array of
   *    { label, stepVarName, resultKind: "sequence"|"record", responseBody, valueSlots,
   *      resultFields }
   *  (valueSlots/resultFields as produced by FlowCallScript.buildCallScript — resultFields is
   *  the step's own declared result-field types, null if unknown). Returns candidates:
   *    { stepIndex, slotPath, slotLiteral, value, sourceStepIndex, sourceLabel,
   *      sourceStepVarName, sourceFieldPath, sourceResultKind, sourceKind, viaListSelection,
   *      sourceRowFields }
   *  viaListSelection is true when the matched value came from a step whose result is a list to
   *  pick from (see isListSource) — applying such a candidate means inserting a list-selection
   *  user step rather than referencing the source step's field directly; sourceRowFields (the
   *  matched row's own top-level field names) is what the caller needs to build that control's
   *  row-display templates. Only matches against EARLIER steps — a step's own response never
   *  explains its own inputs.
   *
   *  Matching priority: value equality alone is a weak signal (e.g. two unrelated booleans
   *  that both happen to be true), so a same-value pool entry whose field name is also similar
   *  to the target field's name is always preferred. Value-only matches are still used as a
   *  fallback for anything with more than a couple of possible values, but never for booleans
   *  (or other single-bit-of-information values) — those require a name match, or don't match
   *  at all. */
  function findDependencies(stepContexts) {
    const pool = []; // { value, stepIndex, label, stepVarName, fieldPath, resultKind, isListSource, rowFields }
    const candidates = [];

    stepContexts.forEach((ctx, stepIndex) => {
      (ctx.valueSlots || []).forEach((slot) => {
        const valueMatches = pool.filter((p) => p.value === slot.value);
        if (valueMatches.length === 0) return;

        const slotFieldName = lastFieldName(slot.path);
        let match = null;
        let bestScore = 0;
        valueMatches.forEach((p) => {
          const score = nameSimilarityScore(lastFieldName(p.fieldPath), slotFieldName);
          if (score > bestScore) {
            bestScore = score;
            match = p;
          }
        });
        if (!match && !isLowInformationValue(slot.value)) {
          // Value-only fallback (no name similarity at all) is an inherently weaker signal —
          // small-cardinality values (e.g. "1") collide across completely unrelated fields
          // easily. Real bug, 2026-08-09: RentalChargableDays (number) coincidentally matched
          // ShipAddrNo (text), both recorded as "1" — zero name similarity, purely a shared
          // value — producing "field 'RentalChargableDays' has type text? but expected number?".
          // When both the source's and target's declared kind are POSITIVELY known and they
          // conflict, a value-only match is almost certainly a coincidence, not a real
          // dependency — skip it rather than substitute a wrong reference. An unknown kind on
          // either side still falls back to the first same-value candidate as before
          // (conservative: don't lose a real match just because kind info wasn't available).
          //
          // Uses slot.kindKnown, NOT slot.kind's own truthiness — real regression, 2026-08-09:
          // slot.kind ALWAYS has a value (flow-call-script.js defaults an unresolvable field to
          // "text" so downstream consumers like createControlForKind have a safe default to work
          // with), so treating it as "positively known" whenever merely truthy rejected the vast
          // majority of legitimate matches too — user-observed, ~20 real matches collapsed to 4,
          // all coincidental. kindKnown is only true when the target's declared type was actually
          // resolved. The SOURCE side (p.kind, from the response-value pool) never had this
          // problem — it's genuinely null when unresolved, no default-masking-as-known issue.
          match = valueMatches.find((p) => !slot.kindKnown || !p.kind || p.kind === slot.kind) || null;
        }
        if (!match) return;

        const candidate = {
          stepIndex,
          slotPath: slot.path,
          slotLiteral: slot.literal,
          value: slot.value,
          sourceStepIndex: match.stepIndex,
          sourceLabel: match.label,
          sourceStepVarName: match.stepVarName,
          sourceFieldPath: match.fieldPath,
          sourceResultKind: match.resultKind,
          viaListSelection: match.isListSource,
          sourceRowFields: match.isListSource ? match.rowFields : null,
          // The SOURCE field's own declared kind (null if unknown/unclassifiable) — needed to
          // detect a genuine format mismatch (e.g. a text-declared field feeding an enum-typed
          // target) rather than assume the source already matches. See applyDependency's
          // isEnumTextConversion. Confirmed live 2026-08-08: GetCustomerDefaults.SupplyCountryDb
          // is declared plain text? in that function's own return type.
          sourceKind: match.kind || null,
          // Only meaningful when sourceKind is "enum" — the SOURCE's own specific enum type
          // name, needed to tell it apart from the TARGET's specific enum type (see
          // classifyFieldType's own doc comment — real bug, live, 2026-08-10: two same-named
          // fields declared as genuinely DIFFERENT enum types, e.g. PartOwnershipSubset1 vs
          // PartOwnership, were assumed interchangeable just because both classified as "enum").
          sourceEnumType: match.enumType || null,
          // True when this candidate was found via the strong name+value signal (the
          // name-similarity loop above), false when it only ever matched via the weaker
          // value-only fallback. Lets the review UI split candidates into "high confidence" vs
          // "please verify" groups instead of presenting every match with equal weight —
          // requested 2026-08-10, after the value-only fallback's own false-positive history
          // this session made it clear the two signal strengths shouldn't look identical to the
          // user either.
          matchedByName: bestScore > 0
        };
        if (slot.wrapKind) candidate.wrapKind = slot.wrapKind;
        // The FIELD being written into — needed to know if a firstOrNull(...)-sourced
        // reference (always nullable) needs unwrapping to satisfy a non-nullable target.
        // valueNullable (pure type nullability) is what matters here, not slot.nullable — that
        // one also folds in "optional key present-or-absent", which is unrelated to whether the
        // VALUE's type accepts null once the key IS present (e.g. `optional Objsite: text`).
        candidate.targetKind = slot.kind || "text";
        // Whether targetKind above is a REAL classification or just the unresolvable-field
        // default ("text") masquerading as one — same distinction slot.kindKnown already exists
        // for (see its own definition in flow-call-script.js and the value-only-fallback comment
        // a few lines up). Needed by applyDependency's enum->text and generic kind-mismatch
        // conversions, which previously trusted targetKind's bare truthiness (always true) and so
        // always fired — real bug, 2026-08-10: an `any`-typed field (e.g. ValidationRec, an
        // untyped passthrough blob in several generated action-import-request types) has no
        // resolvable per-field type at all, so targetKind defaulted to "text" and a genuinely
        // enum-typed source (GetCustomerOrder_Default.AddrFlag) got wrapped in str(...) —
        // FlowScript's str() on an enum value doesn't render its plain member name, it dumps the
        // enum's own internal {enumerationNamespace, name} shape as text, which the server then
        // rejected outright ("Invalid value for property 'AddrFlag'"). The correct behavior for a
        // genuinely-untyped target is to pass the source value through completely unconverted.
        candidate.targetKindKnown = !!slot.kindKnown;
        candidate.targetNullable = slot.valueNullable !== undefined ? !!slot.valueNullable : !!slot.nullable;
        // Only meaningful when targetKind is "enum" — needed to build a real
        // ModuleName.EnumType.fromText(...) conversion when the source turns out to be
        // text-declared (see applyDependency's isEnumTextConversion). targetModuleName is the
        // TARGET step's own module (its `open X;`), not the source's — that's what the
        // fromText(...) call needs to be in scope, confirmed live 2026-08-07.
        candidate.targetEnumType = slot.enumType || null;
        candidate.targetModuleName = ctx.moduleName || null;
        candidates.push(candidate);
      });

      const rows = extractRows(ctx.responseBody);
      const listSource = isListSource(ctx.label, rows);
      const rowsToPool = listSource ? rows : rows.slice(0, 1);
      rowsToPool.forEach((row) => {
        if (!row) return;
        const flattened = [];
        collectValues(row, "", flattened);
        const rowFields = Object.keys(row);
        flattened.forEach(({ path, value }) => {
          // Only a top-level field name (no dot/bracket nesting) can be matched against
          // ctx.resultFields — same "top-level only" precedent used elsewhere for declared-type
          // lookups. null kind (unclassifiable, or a nested path) means "unknown" — treated
          // conservatively downstream, never assumed to need conversion.
          const declared = ctx.resultFields && !path.includes(".") && !path.includes("[")
            ? ctx.resultFields.find((f) => f.name === path)
            : null;
          const declaredClassification = declared ? classifyFieldType(declared.type) : null;
          pool.push({
            value,
            stepIndex,
            kind: declaredClassification ? declaredClassification.kind : null,
            // Only meaningful when kind is "enum" — see classifyFieldType's own doc comment for
            // why two "enum"-kind fields aren't necessarily the SAME enum type.
            enumType: declaredClassification ? declaredClassification.enumType || null : null,
            // baseLabel (undisambiguated — see ifs-modules.js's usedStepLabels) when available,
            // so mappingKey groups repeats of "the same shaped call" correctly without needing
            // to guess where a Flow-safe numeric disambiguation suffix ends and a real name that
            // happens to end in a digit begins (that guess is exactly what broke — real bug,
            // 2026-08-10 — when the suffix format changed from " (2)" to a bare "2").
            label: ctx.baseLabel || ctx.label,
            stepVarName: ctx.stepVarName,
            fieldPath: path,
            resultKind: ctx.resultKind,
            isListSource: listSource,
            rowFields
          });
        });
      });
    });

    return candidates;
  }

  /** FlowScript expression referencing a prior step's output field. A "sequence" result
   *  (select * from ...) must be narrowed first — indexing it directly ([0]) or first(...) both
   *  throw if the sequence came back empty; firstOrNull(...) doesn't, which is why it's the
   *  default. `useFirst` opts into the throwing accessor instead — see applyDependency's enum
   *  handling for why. */
  function referenceExpression(sourceStepVarName, sourceResultKind, sourceFieldPath, useFirst) {
    let accessor = sourceStepVarName;
    if (sourceResultKind === "sequence") {
      accessor = useFirst ? `first(${sourceStepVarName})` : `firstOrNull(${sourceStepVarName})`;
    }
    return `${accessor}.${sourceFieldPath}`;
  }

  /** Re-wraps a substituted reference for a slot that came from a $filter startswith/endswith/
   *  contains — the wildcard has to survive substitution (in the actual runtime string, not
   *  just the source literal) or the module's query translator can't figure out which OData
   *  function to use and errors at flow-execution time. */
  function wrapLikeReference(expr, wrapKind) {
    if (wrapKind === "start") return `(${expr} & "%")`;
    if (wrapKind === "end") return `("%" & ${expr})`;
    if (wrapKind === "contains") return `("%" & ${expr} & "%")`;
    // A batch sub-request's key value is embedded as hand-built HTTP wire text (see
    // flow-call-script.js's buildBatchIfsFunctionExpr) — never re-encoded by a module function's
    // own URL-building the way a normal call's key value is, so a substituted reference has to be
    // re-encoded explicitly at substitution time to keep the wire format correct regardless of
    // the source value's own encoding. urlEncode is a real, confirmed FlowScript builtin.
    if (wrapKind === "urlEncode") return `urlEncode(${expr})`;
    return expr;
  }

  /** A safe fallback literal for isNull(...) unwrapping, by target kind. null means "no safe
   *  generic fallback" — callers should leave the nullable reference as-is (or, for enum from a
   *  sequence source, use first(...) instead — see applyDependency) rather than risk a
   *  mismatched fallback. Enum has NO safe generic fallback: `fromText("")` type-checks fine
   *  (confirmed live 2026-08-07, fixed the original "expected type ...Value, but the expression
   *  has type text" error) but throws at RUNTIME for any real enum module, because "" isn't
   *  actually one of its declared members — an enum's `values` list is a closed, specific set
   *  (e.g. Lookup_IsoCountry's 25 country codes) with no blank/null sentinel to fall back to.
   *  Confirmed live 2026-08-07 (same day): the fromText("") version passed the type-check but
   *  crashed on execution. Same treatment as datetime now. */
  function nullFallbackForKind(kind) {
    if (kind === "number") return "0";
    if (kind === "boolean") return "false";
    if (kind === "datetime") return null;
    if (kind === "enum") return null;
    return '""';
  }

  /** Converts baseRef's value to match a mismatched TARGET kind, for the real (non-enum)
   *  combinations FlowScript doesn't implicitly coerce between. Enum conversions are handled by
   *  applyDependency's own dedicated branches (they need extra context — targetEnumType/
   *  targetModuleName) — this is the generic path for the remaining text/number/boolean/datetime
   *  pairs, added 2026-08-09 per explicit request: a dependency match shouldn't ever substitute a
   *  bare reference of the wrong kind and let the server reject it, the way SupplyCountry and
   *  RentalChargableDays both did before their own dedicated fixes landed. Only fires when BOTH
   *  kinds are positively known and differ — unknown stays conservative, unconverted, same
   *  precedent as every other kind check in this file. Returns null (no conversion available,
   *  caller leaves the reference as-is) for a pair with no defined conversion — no realistic
   *  real-world case has been observed for e.g. number<->boolean or number<->datetime, and
   *  guessing one would risk being worse than an unconverted reference.
   *
   *  - X -> text: str(value) — FlowScript's universal to-text converter (confirmed via docs).
   *  - text -> number: val(text) — VB-style Val(), confirmed via docs; safe on "" (returns 0).
   *  - text -> datetime: date(text) — parses standard/ISO formats; no safe fallback for an
   *    unparseable/empty string (same "no safe fallback, accept near-impossible residual risk"
   *    precedent as first()/fromText("") elsewhere in this file).
   *  - text -> boolean: FlowScript has no dedicated parser (confirmed via docs) — the documented
   *    pattern is a case/error expression, inlined here as a single expression (FlowScript is
   *    expression-oriented, no helper function declaration needed). Throws at runtime for any
   *    value that isn't (case-insensitively) "true"/"false" — an explicit, intentional trade
   *    matching the same style FlowScript's own docs use for this exact conversion. */
  function convertKindMismatch(baseRef, sourceKind, targetKind) {
    if (!sourceKind || !targetKind || sourceKind === targetKind) return null;
    if (targetKind === "text") return `str(${baseRef})`;
    if (sourceKind !== "text") return null;
    if (targetKind === "number") return `val(isNull(${baseRef}, ""))`;
    if (targetKind === "datetime") return `date(${baseRef})`;
    if (targetKind === "boolean") {
      return `(case when lower(${baseRef}) = "true" then true when lower(${baseRef}) = "false" then false else error "Expected boolean text \\"true\\"/\\"false\\"" end)`;
    }
    return null;
  }

  /** Replaces one occurrence of a candidate's literal text in `script` with a reference to its
   *  source step. No-op (returns script unchanged) if the literal can't be found.
   *
   *  Real confirmed bug (2026-08-07, real recorded "create Part" session, 500 on designer
   *  save): a bare `script.indexOf(candidate.slotLiteral)` search finds the FIRST occurrence of
   *  the literal TEXT anywhere in the whole script — but multiple DIFFERENT fields routinely
   *  share the identical literal value (every boolean field is either "true" or "false"; this
   *  real script had 9 separate boolean fields all recorded as `false`). Applying candidates
   *  one at a time via repeated calls (see ifs-modules.js's applyDependencyCandidate) means each
   *  call searches the ALREADY-MODIFIED script from prior calls — and a prior substitution's own
   *  isNull(..., false) fallback default is ALSO literally the text "false", so a later
   *  candidate's search can find and nest inside THAT instead of its own, still-untouched
   *  occurrence. Confirmed real result: a 9-deep nested isNull() chain assigning completely
   *  unrelated fields (CatchUnitEnabled, AllowAsNotConsumed, KitPart, ...) as each other's
   *  fallback defaults.
   *
   *  Fixed by first searching for the field-name-qualified form ("FieldName: literal") — unique
   *  within a flat record literal even when the bare value isn't, since each field name appears
   *  exactly once — and only falling back to the old bare-literal search when a slot isn't
   *  inside that shape (e.g. a $filter-translated where-clause value, or a bare scalar argument
   *  with no record key at all). */
  function applyDependency(script, candidate) {
    const fieldName = lastFieldName(candidate.slotPath);
    const qualified = `${fieldName}: ${candidate.slotLiteral}`;
    let idx = script.indexOf(qualified);
    if (idx !== -1) {
      idx += qualified.length - candidate.slotLiteral.length; // point at the literal itself, past "FieldName: "
    } else {
      idx = script.indexOf(candidate.slotLiteral);
    }
    if (idx === -1) return script;
    // A source field genuinely declared TEXT (not the matching enum type) feeding an
    // enum-typed target needs a real fromText(...) conversion — the mapping is correct, the
    // FORMAT isn't. Confirmed live 2026-08-08: GetCustomerDefaults declares SupplyCountryDb as
    // plain text? in its own return type (IFS's "Db" suffix convention for the raw/underlying
    // value), even though the target field expects Lookup_IsoCountry.Value. Only fires when
    // sourceKind is POSITIVELY known to be "text" — unknown (null) is treated conservatively,
    // same as before, since wrapping fromText(...) around an already-correctly-enum-typed
    // reference would itself be a type error the other way round.
    //
    // isNull(baseRef, "") here is safe (unlike nullFallbackForKind's enum case): "" is a valid
    // TEXT fallback for fromText's own text parameter, not an enum member — so this only risks
    // fromText(""), which only crashes if the source is genuinely empty at runtime (same
    // acceptable near-impossible residual risk as first() throwing, just via a different route).
    // Always firstOrNull (never first()) here — first()'s value only applies when the source is
    // already the matching enum type, not when converting from text.
    if (candidate.targetKind === "enum" && candidate.sourceKind === "text" && candidate.targetEnumType && candidate.targetModuleName) {
      const baseRef = referenceExpression(candidate.sourceStepVarName, candidate.sourceResultKind, candidate.sourceFieldPath, false);
      const refExpr = `${candidate.targetModuleName}.${candidate.targetEnumType}.fromText(isNull(${baseRef}, ""))`;
      return script.slice(0, idx) + refExpr + script.slice(idx + candidate.slotLiteral.length);
    }
    // Enum-to-enum, ALWAYS converted now — real bug, live, 2026-08-10, TWO rounds. Round 1
    // (narrower, since reverted in spirit): only converted when source/target were POSITIVELY
    // known to be DIFFERENT specific enum types (IFS declares many narrower "Subset" variant
    // enums sharing a real-world field name — PartOwnershipSubset1/2/3, PartOwnershipRentOnly,
    // ... confirmed via real OpenAPI, all distinct FlowScript nominal types) — left a bare
    // reference whenever the two types matched (or either was unknown), on the assumption that
    // "same enum type" meant "already a real, correctly-typed runtime value". Round 2, live
    // retest, DISPROVEN: a SAME-type case (AddrFlag, GenYesNo -> GenYesNo) still failed —
    // "must not be an object or array". Root cause is the SAME as bug #31's datetime fix:
    // GetX()'s own `unsafeCastX(...)` deserializer never performs a real runtime conversion —
    // a GET response's enum-typed field is STILL the raw `{enumerationNamespace, name}` object
    // underneath, REGARDLESS of whether the static type happens to match the target's. "Same
    // enum type = safe bare reference" was never actually true for a dependency-sourced
    // reference — only for a `fromText(...)`-constructed literal value (which real natively
    // constructs the value, unlike a GET-sourced reference). So: whenever target is enum and
    // source is enum and the target's own enum info is known, ALWAYS reconstruct via
    // Module.TargetEnumType.fromText(baseRef.name) — the source's specific enum type no longer
    // matters for THIS decision (fromText itself will throw at runtime if the source's real
    // member name genuinely isn't valid for the target enum — an inherent semantic mismatch,
    // not something to guess around, same "no safe generic fallback" precedent as elsewhere).
    if (candidate.targetKind === "enum" && candidate.sourceKind === "enum" && candidate.targetEnumType && candidate.targetModuleName) {
      const baseRef = referenceExpression(candidate.sourceStepVarName, candidate.sourceResultKind, candidate.sourceFieldPath, false);
      const refExpr = `${candidate.targetModuleName}.${candidate.targetEnumType}.fromText(${baseRef}.name)`;
      return script.slice(0, idx) + refExpr + script.slice(idx + candidate.slotLiteral.length);
    }
    // The reverse direction of the case just above: a source field genuinely declared an ENUM
    // value feeding a plain non-enum (text, or genuinely untyped `any`) target. Real bug, live,
    // 2026-08-09/10, TWO rounds: first tried `str(value)` (assumed universal to-text converter,
    // "confirmed via docs" — that assumption was never actually docs-confirmed for enums
    // specifically, the built-in-functions page has no enum section at all) — live-tested
    // 2026-08-10 and DISPROVEN: `str(GetCustomerOrder_Default.AddrFlag)` rendered the enum's own
    // internal `{enumerationNamespace, name}` shape AS TEXT (not the plain member name), server
    // rejected it ("Invalid value: {enumerationNamespace: ..., name: No} for property:
    // 'AddrFlag'"). Removing the conversion entirely (bare reference) was tried too — also fails,
    // differently: the bare enum value serializes as a genuine JSON object, server explicitly
    // rejects it as wrong JSON type ("must not be an object or array"). Real fix, confirmed live
    // 2026-08-10: direct field access on the enum value's OWN `.name` property — FlowScript
    // enums are structurally `{enumerationNamespace: text, name: text}` under the hood (matches
    // the wire JSON shape exactly), and this codebase already treats FlowScript as structurally
    // typed elsewhere, so a plain field access is legitimate, not a hack. No target-kind-known
    // gate here (unlike the generic non-enum kind-mismatch path below) — an enum source's raw
    // object shape is invalid for ANY non-enum target regardless of whether that target's own
    // declared type could be resolved, confirmed by the real ValidationRec (`any`-typed) case
    // that motivated this rewrite. No safe generic isNull(...) fallback exists for wrapping the
    // enum reference itself before conversion (same "no safe enum fallback" reasoning as
    // nullFallbackForKind's own enum case) — accept the same near-impossible-empty-source
    // residual risk already accepted elsewhere in this function (first(), fromText("")).
    if (candidate.targetKind !== "enum" && candidate.sourceKind === "enum") {
      const baseRef = referenceExpression(candidate.sourceStepVarName, candidate.sourceResultKind, candidate.sourceFieldPath, false);
      const refExpr = `${baseRef}.name`;
      return script.slice(0, idx) + refExpr + script.slice(idx + candidate.slotLiteral.length);
    }
    // FlowScript's own `unsafeCastX(...)` record deserializer (used by every generated GetX()
    // function's `JSON.deserialize{}` call) never performs a REAL type conversion — it's a
    // static relabel only. Confirmed real, live, 2026-08-10: a genuine `datetime`-declared source
    // field, forwarded unchanged into another `datetime`-declared target (kinds "matching", no
    // conversion previously applied), arrived at the target's own generated wrapper function
    // still holding its raw JSON string underneath — captured request showed
    // `WantedDeliveryDate='2026-08-10T00:00:00Z'`, QUOTED like a text literal, not the bare OData
    // datetime literal a real native datetime value renders as via the exact same shared
    // `ToQueryStringParam` builtin that correctly quoted `OrderNo`/`Contract` alongside it in the
    // same request (server rejected it: "Invalid value for property 'WantedDeliveryDate'"). So a
    // datetime->datetime "match" can't be trusted as a real no-op the way every other kind can —
    // force a genuine reparse via date(str(ref)): str() is the universal to-text converter (works
    // regardless of static type), date() is the real text->datetime parser, producing an actual
    // native datetime value the target's own serializer sees as such. No isNull(...) safety wrap
    // here even for a non-nullable target — same "no safe generic datetime fallback" reasoning as
    // nullFallbackForKind's own datetime case elsewhere in this file.
    if (candidate.targetKind === "datetime" && candidate.sourceKind === "datetime") {
      const baseRef = referenceExpression(candidate.sourceStepVarName, candidate.sourceResultKind, candidate.sourceFieldPath, false);
      const refExpr = `date(str(${baseRef}))`;
      return script.slice(0, idx) + refExpr + script.slice(idx + candidate.slotLiteral.length);
    }
    // Remaining non-enum kind mismatches (text<->number/boolean/datetime, any->text) — see
    // convertKindMismatch's own doc comment. wrapKind (the like-wildcard case) still applies on
    // top, same as the generic path below.
    {
      const baseRef = referenceExpression(candidate.sourceStepVarName, candidate.sourceResultKind, candidate.sourceFieldPath, false);
      const converted = candidate.targetKindKnown ? convertKindMismatch(baseRef, candidate.sourceKind, candidate.targetKind) : null;
      if (converted) {
        const refExpr = candidate.wrapKind ? wrapLikeReference(converted, candidate.wrapKind) : converted;
        return script.slice(0, idx) + refExpr + script.slice(idx + candidate.slotLiteral.length);
      }
    }
    // Enum has no safe isNull(...) fallback value (see nullFallbackForKind) — for a sequence
    // source, sidestep the problem entirely by using first(...) instead of firstOrNull(...):
    // first() returns the enum's actual non-nullable Value type directly, so the target's
    // non-nullable requirement is satisfied with no fallback needed at all. Trades "silently
    // substitutes a made-up value on an empty source" for "throws a clear error on an empty
    // source" — acceptable here since these are dependency-sourced from a step whose data we
    // already have (an empty result is realistically near-impossible), confirmed live 2026-08-07.
    const useFirstForEnum = candidate.sourceResultKind === "sequence" && candidate.targetKind === "enum" && candidate.targetNullable === false;
    let refExpr = referenceExpression(candidate.sourceStepVarName, candidate.sourceResultKind, candidate.sourceFieldPath, useFirstForEnum);
    // Whether to wrap depends only on whether the TARGET requires non-null — not on
    // sourceResultKind. A "record" (non-sequence) source needing no firstOrNull() to access is
    // a separate question from whether ITS OWN field is nullable; a single-record GET result
    // can still have individually-nullable fields. Real bug, 2026-08-07: bare
    // `GetCustomerDefaults.DeliveryLeadtime`-style references (record-kind source) went
    // unwrapped and the server rejected number?/text? into the non-nullable target fields.
    if (candidate.targetNullable === false && !useFirstForEnum) {
      // Same "text" default masquerading as a real classification already fixed for the enum
      // conversion path (see the .name comment above) — real bug, live, 2026-08-10: a
      // ConvFactor/Identity4-style genuinely NUMBER field whose declared type couldn't be
      // resolved (targetKindKnown false, same `any`-typed-record class as ValidationRec) fell
      // back to candidate.targetKind's unconditional "text" default, so nullFallbackForKind
      // picked the TEXT fallback (`""`) instead of the real number one (`"0"`) — server rejected
      // it, "Invalid json type: STRING for Edm.Decimal property". Only trust nullFallbackForKind
      // when the kind is positively known; an unknown kind leaves the reference unwrapped
      // instead of guessing a fallback for a type we don't actually know — same conservative
      // precedent as every other "unknown kind" branch in this file.
      const fallback = candidate.targetKindKnown ? nullFallbackForKind(candidate.targetKind) : null;
      if (fallback !== null) refExpr = `isNull(${refExpr}, ${fallback})`;
    }
    if (candidate.wrapKind) refExpr = wrapLikeReference(refExpr, candidate.wrapKind);
    return script.slice(0, idx) + refExpr + script.slice(idx + candidate.slotLiteral.length);
  }

  /** Stable key for remembering a confirmed mapping across recordings — built from function/
   *  field names (which stay the same call to call) rather than runtime step ids or values
   *  (which don't). Uses each label AS GIVEN — the caller is expected to have already resolved
   *  it to its undisambiguated base form (stepContexts[i].baseLabel / candidate.sourceLabel from
   *  the pool, which now reads baseLabel too — see findDependencies' pool-push comment) so that
   *  two occurrences of "the same shaped call" repeated in one session (3 separate $batch calls;
   *  the same write call issued once per order line; ...) are recognized as ONE underlying
   *  mapping, not N unrelated ones with visually-identical rows. Real bug, 2026-08-10: user
   *  explicitly doesn't want to confirm the same mapping 3 times — "one time is fine". Previously
   *  tried stripping a " (N)" suffix textually here instead — abandoned once the disambiguation
   *  format itself had to change to a bare trailing digit (Flow rejects parens/spaces in a step
   *  name), which made stripping ambiguous against a real name that happens to end in a digit. */
  function mappingKey(candidate, stepContexts) {
    const targetCtx = stepContexts[candidate.stepIndex];
    const targetLabel = targetCtx.baseLabel || targetCtx.label;
    return `${targetLabel}::${candidate.slotPath}::${candidate.sourceLabel}::${candidate.sourceFieldPath}`;
  }

  /** Groups candidates sharing the same mappingKey into one entry with all of its real
   *  occurrences — the review UI shows/confirms ONE row per group instead of one per occurrence,
   *  and applying a group means applying every occurrence in it. Preserves first-seen order,
   *  both across groups and within each group's occurrences. */
  function groupCandidatesByMapping(candidates, stepContexts) {
    const groups = new Map(); // key -> occurrences[]
    candidates.forEach((c) => {
      const key = mappingKey(c, stepContexts);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    });
    return Array.from(groups.entries()).map(([key, occurrences]) => ({ key, occurrences }));
  }

  const api = {
    findDependencies,
    referenceExpression,
    wrapLikeReference,
    applyDependency,
    mappingKey,
    extractFirstRow,
    extractRows,
    isListSource,
    lastFieldName,
    namesSimilar,
    nameSimilarityScore,
    convertKindMismatch,
    isLowInformationValue,
    groupCandidatesByMapping
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.FlowDependencyTracer = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
