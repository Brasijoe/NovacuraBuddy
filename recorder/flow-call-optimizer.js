/* ============================================================
   Flow Call Optimizer — detects redundant/duplicate GET calls and
   mergeable same-record PATCH chains in a recorded call-log session,
   so the trace can be cleaned up before it's fed into step-generation.

   Pure logic only, no DOM. recorder/viewer.js renders the marks this
   produces and applies the result on a button click.
   ============================================================ */
(function (global) {
  /** Query string stripped — this is a call's "identity" for both duplicate-GET
   *  comparison and same-record PATCH grouping. */
  function targetKey(url) {
    return String(url || "").split("?")[0];
  }

  /** A GET is a duplicate if an earlier GET in the same session has the exact same
   *  full URL (path + query, byte-exact — no pagination-param normalization in v1). */
  function findDuplicateGets(calls) {
    const seen = new Set();
    const duplicateIds = new Set();
    (calls || []).forEach((call) => {
      if (call.method !== "GET") return;
      if (seen.has(call.url)) duplicateIds.add(call.id);
      else seen.add(call.url);
    });
    return duplicateIds;
  }

  /** Recursively collects stringified primitive leaf values from parsed JSON — null/undefined
   *  leaves are skipped (nothing to string-match against). Non-object/array input that isn't
   *  null/undefined is treated as a single leaf (covers a bare-scalar JSON response body). */
  function flattenLeafValues(value) {
    const out = [];
    (function walk(v) {
      if (v === null || v === undefined) return;
      if (Array.isArray(v)) {
        v.forEach(walk);
      } else if (typeof v === "object") {
        Object.values(v).forEach(walk);
      } else {
        out.push(String(v));
      }
    })(value);
    return out;
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text || "null");
    } catch (e) {
      return null;
    }
  }

  /** A GET is unused if none of its response's leaf values show up in any later
   *  POST/PATCH/DELETE's request body or URL, OR in any later GET's URL — i.e. nothing
   *  downstream ever reads what it fetched. A later GET's URL counts too because a value
   *  fetched from a list GET is commonly used as a key/filter literal embedded in a LATER
   *  GET's URL (see flow-dependency-tracer.js, which treats later GETs as consumers the same
   *  way). GET calls don't have a meaningful request body, and we deliberately do NOT check a
   *  later GET's responseBody — only its url — to keep this cheap. An unparseable or empty
   *  response body has nothing to match, so it's unused too. */
  function findUnusedGets(calls) {
    const list = calls || [];
    const unusedIds = new Set();
    list.forEach((call, i) => {
      if (call.method !== "GET") return;
      const values = flattenLeafValues(safeJsonParse(call.responseBody));
      if (values.length === 0) {
        unusedIds.add(call.id);
        return;
      }
      const used = list.slice(i + 1).some((later) => {
        if (later.method === "GET") {
          return values.some((v) => (later.url || "").includes(v));
        }
        if (!["POST", "PATCH", "DELETE"].includes(later.method)) return false;
        const haystack = `${later.requestBody || ""} ${later.url || ""}`;
        return values.some((v) => haystack.includes(v));
      });
      if (!used) unusedIds.add(call.id);
    });
    return unusedIds;
  }

  /** A PATCH the server rejected must never feed into a merge — its field values are values
   *  the server actually refused, and last-write-wins merging could let them silently clobber
   *  a value a successful PATCH in the same chain set. Mirrors the isSuccess convention used
   *  in viewer.js's createCallCard (call.status >= 200 && call.status < 400). A call with no
   *  recorded status (undefined/null — true for every pre-existing recorded call and every
   *  test in this file that predates status tracking) is NOT treated as failed, only an
   *  explicit out-of-range status is. */
  function isFailedPatch(call) {
    if (call.status === null || call.status === undefined) return false;
    return !(call.status >= 200 && call.status < 400);
  }

  /** PATCH calls targeting the same entity (targetKey) with only GET calls (and failed PATCHes)
   *  between them form a mergeable chain. Any non-GET, non-failed-PATCH call — a PATCH to a
   *  DIFFERENT key, a POST, or a DELETE — closes whatever chain is open, even if that call's
   *  own key matches: a same-key PATCH after an interruption starts a NEW chain, it doesn't
   *  resume the old one. A failed PATCH (non-2xx/3xx status) is transparent to chain tracking,
   *  exactly like a GET — it neither joins nor breaks the current chain, and is simply skipped.
   *  Only one chain is ever open at a time (no parallel per-key tracking). Chains of length 1
   *  are dropped — nothing to merge. */
  function findMergeableChains(calls) {
    const chains = [];
    let current = null;
    (calls || []).forEach((call) => {
      if (call.method === "GET") return;
      if (call.method === "PATCH" && isFailedPatch(call)) return;
      if (call.method === "PATCH") {
        const key = targetKey(call.url);
        if (current && current.key === key) {
          current.calls.push(call);
        } else {
          if (current) chains.push(current);
          current = { key, calls: [call] };
        }
      } else {
        if (current) chains.push(current);
        current = null;
      }
    });
    if (current) chains.push(current);
    return chains.filter((c) => c.calls.length > 1);
  }

  /** Convenience wrapper combining all detection into one call: the full delete set (auto-
   *  checked "To Delete" state) plus per-call merge role, for the viewer to render marks and
   *  badges from a single pass. */
  function computeMarks(calls) {
    const duplicateIds = findDuplicateGets(calls);
    const unusedIds = findUnusedGets(calls);
    const chains = findMergeableChains(calls);
    const deleteIds = new Set([...duplicateIds, ...unusedIds]);
    const mergeInfo = new Map();
    chains.forEach((chain) => {
      // Survivor is the LAST (most recent) PATCH in the chain, not the first — real bug,
      // 2026-08-12: merging into the first PATCH left it sitting at the chain's ORIGINAL
      // position while every later chain member got deleted. A GET (e.g. an LOV lookup) that
      // originally sat BETWEEN two chain PATCHes then had nothing left after it in the trace,
      // so findUnusedGets (which only ever looks FORWARD for a consumer) wrongly flagged it as
      // unused/redundant too. Keeping the LAST patch preserves every earlier same-chain GET's
      // real position relative to a surviving consumer.
      const survivor = chain.calls[chain.calls.length - 1];
      const partners = chain.calls.slice(0, -1);
      mergeInfo.set(survivor.id, { role: "survivor", partnerIds: partners.map((c) => c.id) });
      partners.forEach((c) => {
        mergeInfo.set(c.id, { role: "absorbed" });
        deleteIds.add(c.id);
      });
    });
    return { duplicateIds, unusedIds, deleteIds, chains, mergeInfo };
  }

  /** Applies a set of deletions and chain merges to a calls array, returning a NEW array (the
   *  input is never mutated). A chain's survivor (the LAST call in chain.calls — see
   *  computeMarks' own comment on why) only absorbs a partner's requestBody fields when that
   *  partner's id is in deleteIds - this is how the UI's checkbox state controls merge
   *  participation (an unchecked partner is excluded from both the merge AND the deletion, left
   *  exactly as recorded). Field union is last-write-wins in chain.calls' own chronological
   *  order — participating partners are applied first (in their original order), then the
   *  survivor's own fields are applied last, since it's the most recently recorded write and
   *  must win any field both it and an earlier partner set. */
  function applyOptimization(calls, deleteIds, chains) {
    const deleteSet = deleteIds instanceof Set ? deleteIds : new Set(deleteIds);
    const mergedBodies = new Map(); // survivor id -> merged requestBody string

    (chains || []).forEach((chain) => {
      const survivor = chain.calls[chain.calls.length - 1];
      const partners = chain.calls.slice(0, -1);
      const participating = partners.filter((p) => deleteSet.has(p.id));
      if (participating.length === 0) return;
      const body = {};
      participating.forEach((p) => Object.assign(body, safeJsonParse(p.requestBody) || {}));
      Object.assign(body, safeJsonParse(survivor.requestBody) || {});
      mergedBodies.set(survivor.id, JSON.stringify(body));
    });

    return (calls || [])
      .filter((c) => !deleteSet.has(c.id))
      .map((c) => (mergedBodies.has(c.id) ? { ...c, requestBody: mergedBodies.get(c.id) } : c));
  }

  const api = {
    targetKey,
    findDuplicateGets,
    flattenLeafValues,
    findUnusedGets,
    isFailedPatch,
    findMergeableChains,
    computeMarks,
    applyOptimization
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.FlowCallOptimizer = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
