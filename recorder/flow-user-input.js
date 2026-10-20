/* ============================================================
   Flow User Input — after dependency tracing, whatever's left
   hardcoded is either a genuine constant or something a human
   typed during the recording. This groups those leftovers (by
   exact value, since the same value used twice is one input, not
   two) and derives variable names / control labels / insertion
   points for turning "User Input" choices into user-step controls.

   Pure grouping/naming logic only. Building the actual user-step
   JSON and the classification review UI live in ifs-modules.js.
   ============================================================ */
(function (global) {
  function lastFieldName(path) {
    const cleaned = String(path || "").replace(/\[\d+\]/g, "");
    const parts = cleaned.split(".");
    return parts[parts.length - 1] || "";
  }

  /** Same split as FlowAssetHeuristic.splitPascalCase, duplicated for independent testability
   *  (matches this project's existing convention of duplicating small pure helpers). */
  function splitPascalCase(str) {
    return String(str || "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .trim();
  }

  /** Every valueSlot not covered by an applied dependency candidate (auto-applied or
   *  user-confirmed — rejected candidates fall back to being unmapped too). Enum-typed slots
   *  are excluded outright — there's no confirmed-safe way yet to build an enum value from a
   *  user-step control, so they stay hardcoded as recorded rather than risk a broken script.
   *  stepContexts: [{ label, valueSlots }]; appliedCandidates: [{ stepIndex, slotPath }]. */
  function findUnmappedSlots(stepContexts, appliedCandidates) {
    const appliedKeys = new Set((appliedCandidates || []).map((c) => `${c.stepIndex}::${c.slotPath}`));
    const unmapped = [];
    stepContexts.forEach((ctx, stepIndex) => {
      (ctx.valueSlots || []).forEach((slot) => {
        if (slot.kind === "enum") return;
        if (appliedKeys.has(`${stepIndex}::${slot.path}`)) return;
        const item = {
          stepIndex,
          stepLabel: ctx.label,
          slotPath: slot.path,
          slotLiteral: slot.literal,
          value: slot.value,
          kind: slot.kind || "text",
          nullable: !!slot.nullable
        };
        // Carried per-occurrence, not per-group — a value used both as a plain field and
        // inside a $filter startswith/endswith/contains needs different substitution wrapping
        // at each of those spots even though it's the same underlying value.
        if (slot.wrapKind) item.wrapKind = slot.wrapKind;
        unmapped.push(item);
      });
    });
    return unmapped;
  }

  /** Groups unmapped slots by exact value — the same literal used in two places is one input,
   *  not two. Each group takes its field name/kind/nullability from its first occurrence.
   *  Sorted by earliest occurrence so insertion order matches the flow's own step order. */
  function groupUnmappedByValue(unmapped) {
    const groups = new Map();
    unmapped.forEach((item) => {
      const key = `${typeof item.value}:${JSON.stringify(item.value)}`;
      if (!groups.has(key)) {
        groups.set(key, {
          value: item.value,
          fieldName: lastFieldName(item.slotPath),
          kind: item.kind,
          nullable: item.nullable,
          occurrences: []
        });
      }
      groups.get(key).occurrences.push(item);
    });
    return Array.from(groups.values()).sort((a, b) => earliestStepIndex(a) - earliestStepIndex(b));
  }

  function earliestStepIndex(group) {
    return Math.min(...group.occurrences.map((o) => o.stepIndex));
  }

  /** Groups value-groups further by their common insertion point (the earliest target step
   *  they share) — lets several fields destined for the same point become controls on one
   *  user step instead of several consecutive ones. */
  function groupByInsertionPoint(valueGroups) {
    const byStep = new Map();
    valueGroups.forEach((g) => {
      const stepIndex = earliestStepIndex(g);
      if (!byStep.has(stepIndex)) byStep.set(stepIndex, []);
      byStep.get(stepIndex).push(g);
    });
    return Array.from(byStep.entries())
      .map(([stepIndex, groups]) => ({ stepIndex: Number(stepIndex), groups }))
      .sort((a, b) => a.stepIndex - b.stepIndex);
  }

  /** lowerCamelCase identifier derived from a field name, e.g. "CustomerNo" -> "customerNo". */
  function variableNameFor(fieldName) {
    const clean = String(fieldName || "value").replace(/[^A-Za-z0-9]/g, "");
    if (!clean) return "value";
    // Real bug, live, 2026-08-10: "variablename 0 is also not allowed" — a field name that's
    // purely numeric (or, after stripping non-alphanumerics, STARTS with a digit) produces an
    // identifier Flow rejects outright, not just an unconventional one. Most commonly hit via a
    // $batch sub-request's positional key index leaking through as a "field name" (fixed at the
    // source in buildBatchIfsFunctionExpr), but guarded here too as the last-resort layer for any
    // other unmapped value whose field name happens to be/start with a digit.
    if (/^[0-9]/.test(clean)) return `value${clean}`;
    return clean.charAt(0).toLowerCase() + clean.slice(1);
  }

  /** Disambiguates a candidate variable name against ones already used in this batch. */
  function uniqueVariableName(baseName, usedNames) {
    let name = baseName;
    let i = 2;
    while (usedNames.has(name)) {
      name = `${baseName}${i}`;
      i++;
    }
    usedNames.add(name);
    return name;
  }

  /** Human-readable control label, e.g. "CustomerNo" -> "Customer No". */
  function controlLabelFor(fieldName) {
    return splitPascalCase(fieldName) || "Value";
  }

  const api = {
    findUnmappedSlots,
    groupUnmappedByValue,
    groupByInsertionPoint,
    earliestStepIndex,
    variableNameFor,
    uniqueVariableName,
    controlLabelFor,
    lastFieldName
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.FlowUserInput = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
