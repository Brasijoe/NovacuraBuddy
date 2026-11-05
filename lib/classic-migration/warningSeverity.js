/** Classifies a real emit-time warning string as "blocker" (needs attention before the flow can be
 *  trusted: it produced an unresolved marker, an untranslated script, a REST gap, ...) or "fyi"
 *  (a safe default was applied or the gap is documented as non-blocking). Port of the Electron
 *  app's warningSeverity.ts: only the listed shapes are FYI, EVERYTHING else stays a blocker so an
 *  unknown warning is never under-flagged. The patterns are not anchored because the package-level
 *  rollup prefixes each message with the flow name. */
const FYI_MATCHERS = [
  /unrecognized Classic codePage/,
  /has no bound value — defaulted to null in the request body/,
  /Classic query selects through navigation property/,
  /is Classic's Flow Environment 'Get properties' call — has no Connect equivalent/,
  /FileSystem step connector binding:/,
  /Flow contains a loop \(a route leads back to an earlier step\)/
];

export function classifyWarning(message) {
  return FYI_MATCHERS.some((re) => re.test(message)) ? "fyi" : "blocker";
}

export function groupWarningsBySeverity(warnings) {
  const blockers = [];
  const fyis = [];
  for (const w of warnings) (classifyWarning(w) === "blocker" ? blockers : fyis).push(w);
  return { blockers, fyis };
}

/** Summary of an emitted flow's Designer data: step/arrow/module counts, steps by type. */
export function summarizeEmitted(data) {
  const byType = {};
  let arrows = 0;
  let modules = 0;
  for (const entry of data || []) {
    if (entry.type === "step-created") byType[entry.stepType] = (byType[entry.stepType] || 0) + 1;
    else if (entry.type === "arrow-created") arrows++;
    else if (entry.type === "module-added") modules++;
  }
  const stepsByType = Object.entries(byType).sort(([a], [b]) => a.localeCompare(b));
  return { steps: stepsByType.reduce((sum, [, n]) => sum + n, 0), arrows, modules, stepsByType };
}
