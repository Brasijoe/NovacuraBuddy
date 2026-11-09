/* Turns an existing flow's designer data plus a fresh translation into the events that make the flow
 * MATCH the translation (overwrite). The Designer save appends events and never replaces, so
 * whatever the new translation drops has to be removed with deleted events. Ported from the Import/Export
 * updater (lib/flow-transfer.js). Step and arrow ids of a translation are deterministic per flow, so
 * re-importing the same Classic flow matches the steps it created before. */

function aliveEntries(data) {
  const entities = new Map(), modules = new Set(), phrases = new Set();
  for (const e of Array.isArray(data) ? data : []) {
    if (!e || typeof e !== "object") continue;
    const type = String(e.type || "");
    if (type === "module-added" && e.moduleId) modules.add(e.moduleId);
    else if (type === "module-removed" && e.moduleId) modules.delete(e.moduleId);
    else if (type === "phrase-added" && e.key) phrases.add(e.key);
    else if (/-created$/.test(type) && e.id) entities.set(e.id, e);
    else if (/-(deleted|removed)$/.test(type) && e.id) entities.delete(e.id);
    else if (type === "configuration-changed" && entities.has(e.stepId)) entities.set(e.stepId, { ...entities.get(e.stepId), configuration: e.configuration });
  }
  return { entities, modules, phrases };
}

function overwriteEvents(existingData, newData) {
  const cur = aliveEntries(existingData), want = aliveEntries(newData);
  const out = [];
  const kindOf = (e) => String(e.type).replace(/-created$/, "");
  const gone = [...cur.entities.entries()].filter(([id]) => !want.entities.has(id));
  for (const [id, e] of gone) if (kindOf(e) === "arrow") out.push({ type: "arrow-deleted", id });
  for (const [id, e] of gone) if (kindOf(e) !== "arrow") out.push({ type: `${kindOf(e)}-deleted`, id });
  for (const moduleId of cur.modules) if (!want.modules.has(moduleId)) out.push({ type: "module-removed", moduleId });
  for (const e of newData) {
    if (!e || typeof e !== "object") continue;
    if (/-created$/.test(String(e.type)) && e.id) {
      if (!want.entities.has(e.id)) continue;
      const have = cur.entities.get(e.id);
      if (!have) out.push(e);
      else if (e.type === "step-created" && JSON.stringify(have.configuration) !== JSON.stringify(e.configuration)) out.push({ type: "configuration-changed", stepId: e.id, configuration: e.configuration });
      continue;
    }
    if (/-(deleted|removed)$/.test(String(e.type)) && e.id) continue;
    if (e.type === "module-added" && cur.modules.has(e.moduleId)) continue;
    if (e.type === "phrase-added" && cur.phrases.has(e.key)) continue;
    out.push(e);
  }
  return out;
}

/** {ok, missing, extra}: whether the read-back data holds exactly the entities `newData` describes. */
function checkMatches(readBackData, newData) {
  const got = aliveEntries(readBackData).entities, want = aliveEntries(newData).entities;
  const missing = [...want.keys()].filter((id) => !got.has(id)).length;
  const extra = [...got.keys()].filter((id) => !want.has(id)).length;
  return { ok: !missing && !extra, missing, extra };
}

export { aliveEntries, overwriteEvents, checkMatches };
