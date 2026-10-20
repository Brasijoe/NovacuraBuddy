const test = require("node:test");
const assert = require("node:assert/strict");
const { targetKey, findDuplicateGets, flattenLeafValues, findUnusedGets, findMergeableChains, computeMarks, applyOptimization } = require("./flow-call-optimizer.js");

test("targetKey strips the query string, keeps everything else", () => {
  assert.equal(
    targetKey("https://host/svc/OrderQuotationSet(QuotationNo='1100463')?select-fields=A,B"),
    "https://host/svc/OrderQuotationSet(QuotationNo='1100463')"
  );
});

test("targetKey returns the url unchanged when there's no query string", () => {
  assert.equal(targetKey("https://host/svc/Thing(Id='1')"), "https://host/svc/Thing(Id='1')");
});

test("findDuplicateGets flags a GET whose URL exactly matches an earlier GET", () => {
  const calls = [
    { id: "1", method: "GET", url: "https://host/A" },
    { id: "2", method: "PATCH", url: "https://host/A" },
    { id: "3", method: "GET", url: "https://host/A" }
  ];
  const dups = findDuplicateGets(calls);
  assert.equal(dups.size, 1);
  assert.ok(dups.has("3"));
  assert.ok(!dups.has("1"));
});

test("findDuplicateGets flags nothing when every GET url is distinct", () => {
  const calls = [
    { id: "1", method: "GET", url: "https://host/A" },
    { id: "2", method: "GET", url: "https://host/B" }
  ];
  assert.equal(findDuplicateGets(calls).size, 0);
});

test("findDuplicateGets ignores non-GET calls entirely, even with a matching url", () => {
  const calls = [
    { id: "1", method: "GET", url: "https://host/A" },
    { id: "2", method: "PATCH", url: "https://host/A" }
  ];
  assert.equal(findDuplicateGets(calls).size, 0);
});

test("flattenLeafValues collects primitive leaves from a nested object", () => {
  const values = flattenLeafValues({ a: "x", b: { c: 1, d: [true, "y"] } });
  assert.deepEqual(values.sort(), ["1", "true", "x", "y"]);
});

test("flattenLeafValues skips null and undefined leaves", () => {
  assert.deepEqual(flattenLeafValues({ a: null, b: undefined, c: "keep" }), ["keep"]);
});

test("flattenLeafValues returns an empty array for null/non-object input", () => {
  assert.deepEqual(flattenLeafValues(null), []);
});

test("findUnusedGets: a GET is used when a later PATCH's body contains one of its response values", () => {
  const calls = [
    { id: "1", method: "GET", url: "https://host/A", responseBody: JSON.stringify({ Contract: "HPH1" }) },
    { id: "2", method: "PATCH", url: "https://host/B", requestBody: JSON.stringify({ Objsite: "HPH1" }) }
  ];
  assert.equal(findUnusedGets(calls).size, 0);
});

test("findUnusedGets: a GET is used when a later write's URL contains one of its response values", () => {
  const calls = [
    { id: "1", method: "GET", url: "https://host/A", responseBody: JSON.stringify({ QuotationNo: "1100463" }) },
    { id: "2", method: "PATCH", url: "https://host/Thing(QuotationNo='1100463')", requestBody: "{}" }
  ];
  assert.equal(findUnusedGets(calls).size, 0);
});

test("findUnusedGets: flags a GET whose response values never appear in any later write", () => {
  const calls = [
    { id: "1", method: "GET", url: "https://host/Lines", responseBody: JSON.stringify({ LineNo: "999" }) },
    { id: "2", method: "PATCH", url: "https://host/Header", requestBody: JSON.stringify({ Foo: "bar" }) }
  ];
  const unused = findUnusedGets(calls);
  assert.equal(unused.size, 1);
  assert.ok(unused.has("1"));
});

test("findUnusedGets: ignores a matching value that only appears in an EARLIER call", () => {
  const calls = [
    { id: "1", method: "PATCH", url: "https://host/Header", requestBody: JSON.stringify({ Foo: "HPH1" }) },
    { id: "2", method: "GET", url: "https://host/A", responseBody: JSON.stringify({ Contract: "HPH1" }) }
  ];
  const unused = findUnusedGets(calls);
  assert.ok(unused.has("2"));
});

test("findUnusedGets: a GET is used when a later GET's URL contains one of its response values", () => {
  const calls = [
    { id: "1", method: "GET", url: "https://host/A", responseBody: JSON.stringify({ Contract: "HPH1" }) },
    { id: "2", method: "GET", url: "https://host/B(Contract='HPH1')" }
  ];
  const unused = findUnusedGets(calls);
  assert.ok(!unused.has("1"));
});

test("findUnusedGets: a value that only appears in a later GET's response BODY (not its URL) still does not count as used", () => {
  const calls = [
    { id: "1", method: "GET", url: "https://host/A", responseBody: JSON.stringify({ Contract: "HPH1" }) },
    { id: "2", method: "GET", url: "https://host/B", responseBody: JSON.stringify({ Other: "HPH1" }) }
  ];
  const unused = findUnusedGets(calls);
  assert.ok(unused.has("1"));
});

test("findUnusedGets: an unparseable/empty response body is treated as unused (nothing to consume)", () => {
  const calls = [
    { id: "1", method: "GET", url: "https://host/A", responseBody: "<html>401</html>" },
    { id: "2", method: "PATCH", url: "https://host/B", requestBody: JSON.stringify({ Foo: "bar" }) }
  ];
  assert.ok(findUnusedGets(calls).has("1"));
});

test("findMergeableChains merges same-key PATCHes separated only by GETs", () => {
  const calls = [
    { id: "1", method: "PATCH", url: "https://host/A(Id='1')" },
    { id: "2", method: "GET", url: "https://host/whatever" },
    { id: "3", method: "PATCH", url: "https://host/A(Id='1')" }
  ];
  const chains = findMergeableChains(calls);
  assert.equal(chains.length, 1);
  assert.equal(chains[0].key, "https://host/A(Id='1')");
  assert.deepEqual(chains[0].calls.map((c) => c.id), ["1", "3"]);
});

test("findMergeableChains does not merge two single PATCHes (chain length must be > 1)", () => {
  const calls = [{ id: "1", method: "PATCH", url: "https://host/A(Id='1')" }];
  assert.equal(findMergeableChains(calls).length, 0);
});

test("findMergeableChains: a PATCH to a DIFFERENT key breaks the chain, even for the same key later", () => {
  const calls = [
    { id: "1", method: "PATCH", url: "https://host/A(Id='1')" },
    { id: "2", method: "PATCH", url: "https://host/A(Id='2')" },
    { id: "3", method: "PATCH", url: "https://host/A(Id='1')" }
  ];
  const chains = findMergeableChains(calls);
  assert.equal(chains.length, 0); // both A(Id='1') runs are length 1 on their own
});

test("findMergeableChains: a POST breaks the chain", () => {
  const calls = [
    { id: "1", method: "PATCH", url: "https://host/A(Id='1')" },
    { id: "2", method: "POST", url: "https://host/A" },
    { id: "3", method: "PATCH", url: "https://host/A(Id='1')" }
  ];
  assert.equal(findMergeableChains(calls).length, 0);
});

test("findMergeableChains: a DELETE breaks the chain", () => {
  const calls = [
    { id: "1", method: "PATCH", url: "https://host/A(Id='1')" },
    { id: "2", method: "DELETE", url: "https://host/A(Id='9')" },
    { id: "3", method: "PATCH", url: "https://host/A(Id='1')" }
  ];
  assert.equal(findMergeableChains(calls).length, 0);
});

test("findMergeableChains: three same-key PATCHes in a row (with GETs between) form one chain of 3", () => {
  const calls = [
    { id: "1", method: "PATCH", url: "https://host/A(Id='1')" },
    { id: "2", method: "GET", url: "https://host/x" },
    { id: "3", method: "PATCH", url: "https://host/A(Id='1')" },
    { id: "4", method: "GET", url: "https://host/y" },
    { id: "5", method: "PATCH", url: "https://host/A(Id='1')" }
  ];
  const chains = findMergeableChains(calls);
  assert.equal(chains.length, 1);
  assert.deepEqual(chains[0].calls.map((c) => c.id), ["1", "3", "5"]);
});

test("findMergeableChains: a failed PATCH (non-2xx/3xx status) is transparent to the chain, like a GET", () => {
  const calls = [
    { id: "1", method: "PATCH", url: "https://host/A(Id='1')", status: 200 },
    { id: "2", method: "PATCH", url: "https://host/A(Id='1')", status: 400 },
    { id: "3", method: "PATCH", url: "https://host/A(Id='1')", status: 200 }
  ];
  const chains = findMergeableChains(calls);
  assert.equal(chains.length, 1);
  assert.deepEqual(chains[0].calls.map((c) => c.id), ["1", "3"]);
});

test("findMergeableChains: a failed PATCH does not itself become a chain member even flanked by successes", () => {
  const calls = [
    { id: "1", method: "PATCH", url: "https://host/A(Id='1')", status: 200 },
    { id: "2", method: "PATCH", url: "https://host/A(Id='1')", status: 500 },
    { id: "3", method: "PATCH", url: "https://host/A(Id='1')", status: 200 }
  ];
  const chains = findMergeableChains(calls);
  assert.equal(chains.length, 1);
  const ids = chains[0].calls.map((c) => c.id);
  assert.ok(!ids.includes("2"));
});

test("applyOptimization: a failed PATCH's fields are not merged into the survivor even though it sits between two mergeable same-key PATCHes", () => {
  const calls = [
    { id: "1", method: "PATCH", url: "https://host/A(Id='1')", status: 200, requestBody: JSON.stringify({ F: "good1" }) },
    { id: "2", method: "PATCH", url: "https://host/A(Id='1')", status: 400, requestBody: JSON.stringify({ F: "REJECTED" }) },
    { id: "3", method: "PATCH", url: "https://host/A(Id='1')", status: 200, requestBody: JSON.stringify({ G: "good2" }) }
  ];
  const marks = computeMarks(calls);
  // the failed PATCH is never flagged for deletion - it's chain-neutral, not a chain member
  assert.ok(!marks.deleteIds.has("2"));
  const result = applyOptimization(calls, marks.deleteIds, marks.chains);
  const ids = result.map((c) => c.id);
  assert.ok(ids.includes("2")); // left in the session untouched
  const survivor = result.find((c) => c.id === "3"); // survivor is the LAST chain member, not the first
  assert.deepEqual(JSON.parse(survivor.requestBody), { F: "good1", G: "good2" }); // no REJECTED value
});

test("computeMarks: deleteIds is the union of duplicates, unused, and absorbed chain members", () => {
  const calls = [
    { id: "1", method: "GET", url: "https://host/list", responseBody: JSON.stringify({ Id: "K1" }) },
    { id: "2", method: "PATCH", url: "https://host/A(Id='K1')", requestBody: JSON.stringify({ F: "K1" }) },
    { id: "3", method: "GET", url: "https://host/list", responseBody: JSON.stringify({ Id: "K1" }) }, // duplicate of 1
    { id: "4", method: "GET", url: "https://host/lines", responseBody: JSON.stringify({ Unused: "zzz" }) }, // unused
    { id: "5", method: "PATCH", url: "https://host/A(Id='K1')", requestBody: JSON.stringify({ G: "K1" }) } // merges with 2
  ];
  const marks = computeMarks(calls);
  assert.ok(marks.duplicateIds.has("3"));
  assert.ok(marks.unusedIds.has("4"));
  assert.ok(marks.deleteIds.has("3"));
  assert.ok(marks.deleteIds.has("4"));
  assert.ok(marks.deleteIds.has("2")); // absorbed chain member — "5" is the LAST chain member, so IT survives now
  assert.ok(!marks.deleteIds.has("5")); // survivor is never auto-deleted
  assert.equal(marks.mergeInfo.get("5").role, "survivor");
  assert.deepEqual(marks.mergeInfo.get("5").partnerIds, ["2"]);
  assert.equal(marks.mergeInfo.get("2").role, "absorbed");
});

test("applyOptimization removes every call whose id is in deleteIds", () => {
  const calls = [
    { id: "1", method: "GET", url: "https://host/A" },
    { id: "2", method: "GET", url: "https://host/B" }
  ];
  const result = applyOptimization(calls, new Set(["1"]), []);
  assert.deepEqual(result.map((c) => c.id), ["2"]);
});

test("applyOptimization does not mutate the input array", () => {
  const calls = [{ id: "1", method: "GET", url: "https://host/A" }];
  const before = calls.slice();
  applyOptimization(calls, new Set(["1"]), []);
  assert.deepEqual(calls, before);
});

test("applyOptimization merges a chain's fields into the survivor (the LAST chain member) when partners are in deleteIds", () => {
  const partner = { id: "1", method: "PATCH", url: "https://host/A(Id='1')", requestBody: JSON.stringify({ F: "x" }) };
  const survivor = { id: "2", method: "PATCH", url: "https://host/A(Id='1')", requestBody: JSON.stringify({ G: "y" }) };
  const calls = [partner, survivor];
  const chains = [{ key: "https://host/A(Id='1')", calls: [partner, survivor] }];
  const result = applyOptimization(calls, new Set(["1"]), chains);
  assert.equal(result.length, 1);
  assert.deepEqual(JSON.parse(result[0].requestBody), { F: "x", G: "y" });
  assert.equal(result[0].id, "2"); // survivor's identity/other props preserved
});

test("applyOptimization: the LAST (surviving) chain member wins on a field both it and an earlier partner set", () => {
  const partner = { id: "1", method: "PATCH", url: "https://host/A(Id='1')", requestBody: JSON.stringify({ F: "old" }) };
  const survivor = { id: "2", method: "PATCH", url: "https://host/A(Id='1')", requestBody: JSON.stringify({ F: "new" }) };
  const calls = [partner, survivor];
  const chains = [{ key: "https://host/A(Id='1')", calls: [partner, survivor] }];
  const result = applyOptimization(calls, new Set(["1"]), chains);
  assert.deepEqual(JSON.parse(result[0].requestBody), { F: "new" });
});

test("applyOptimization: a chain partner NOT in deleteIds is excluded from the merge and left untouched", () => {
  const partner = { id: "1", method: "PATCH", url: "https://host/A(Id='1')", requestBody: JSON.stringify({ F: "x" }) };
  const survivor = { id: "2", method: "PATCH", url: "https://host/A(Id='1')", requestBody: JSON.stringify({ G: "y" }) };
  const calls = [partner, survivor];
  const chains = [{ key: "https://host/A(Id='1')", calls: [partner, survivor] }];
  // partner "1" unchecked by the user -> not in deleteIds -> stays as its own call, unmerged
  const result = applyOptimization(calls, new Set(), chains);
  assert.equal(result.length, 2);
  assert.deepEqual(JSON.parse(result[0].requestBody), { F: "x" }); // partner unchanged
  assert.deepEqual(JSON.parse(result[1].requestBody), { G: "y" }); // survivor unchanged, nothing merged into it
});

// Modeled on the real IFS_Session_7_8_2026_10_36.json (QuotationNo='1100463', 2 header
// PATCHes to CCustDisc/CNominatedForwarder) walked through with the user during design —
// field lists trimmed to what the logic actually reads, since the real file's $select/$expand
// query strings run to tens of KB per call and add nothing to what this test verifies.
test("applyOptimization: end-to-end with computeMarks on a realistic small session", () => {
  const calls = [
    { id: "1", method: "GET", url: "https://host/list?x=1", responseBody: JSON.stringify({ QuotationNo: "K1", Contract: "HPH1" }) },
    { id: "2", method: "GET", url: "https://host/detail(QuotationNo='K1')", responseBody: JSON.stringify({ Contract: "HPH1" }) },
    { id: "3", method: "PATCH", url: "https://host/detail(QuotationNo='K1')", requestBody: JSON.stringify({ CCustDisc: "20", Objsite: "HPH1" }) },
    { id: "4", method: "GET", url: "https://host/list?x=1", responseBody: JSON.stringify({ QuotationNo: "K1", Contract: "HPH1" }) }, // dup of 1
    { id: "5", method: "GET", url: "https://host/lines", responseBody: JSON.stringify({ LineNo: "999" }) }, // unused
    { id: "6", method: "GET", url: "https://host/detail(QuotationNo='K1')", responseBody: JSON.stringify({ Contract: "HPH1" }) }, // dup of 2
    { id: "7", method: "PATCH", url: "https://host/detail(QuotationNo='K1')", requestBody: JSON.stringify({ CNominatedForwarder: "Test1231", Objsite: "HPH1" }) }
  ];
  const marks = computeMarks(calls);
  const result = applyOptimization(calls, marks.deleteIds, marks.chains);
  // survivor is the LAST chain PATCH ("7"), not the first ("3") — real bug fix, 2026-08-12:
  // merging into the first PATCH stranded a between-PATCH GET with nothing after it in the
  // trace, so it got wrongly flagged unused too. Keeping the last PATCH preserves call "6"
  // (the duplicate GET) correctly ahead of a real surviving consumer.
  assert.deepEqual(result.map((c) => c.id), ["1", "2", "7"]);
  assert.deepEqual(JSON.parse(result[2].requestBody), { CCustDisc: "20", Objsite: "HPH1", CNominatedForwarder: "Test1231" });
});

// Real bug, 2026-08-12 (IFS_Session_12_8_2026_17_49.json, OrderQuotationSet PATCH chain around a
// LanguageCode LOV lookup): a chain PATCH1 -> GET_LOV -> PATCH2 merged into PATCH1 (the OLD,
// buggy first-wins survivor choice) left GET_LOV as the very last call in the merged trace, with
// nothing after it — findUnusedGets only ever looks FORWARD for a consumer, so re-running
// computeMarks on that merged result (exactly what the viewer does on every render, see
// getMarksForSession) then wrongly flagged the still-relevant LOV GET as unused/redundant too.
// This is a genuine TWO-PASS scenario: computeMarks must stay correct not just on the original
// recording, but on its own merged output — never assume a single pass is enough to verify a
// call-log optimizer.
test("computeMarks stays correct on its own merged output: a GET between two chain PATCHes survives a second optimization pass", () => {
  const raw = [
    { id: "1", method: "PATCH", url: "https://host/OrderQuotationSet(QuotationNo='X')", requestBody: JSON.stringify({ AdditionalDiscount: "12", Objsite: "TEST" }) },
    { id: "2", method: "GET", url: "https://host/Reference_ApplicationLanguage?$filter=LanguageCode%20eq%20%27cf%27", responseBody: JSON.stringify({ LanguageCode: "cf", Description: "Some Language" }) },
    { id: "3", method: "PATCH", url: "https://host/OrderQuotationSet(QuotationNo='X')", requestBody: JSON.stringify({ LanguageCode: "cf" }) }
  ];
  const firstPassMarks = computeMarks(raw);
  assert.ok(!firstPassMarks.unusedIds.has("2")); // "3" (its real consumer) still exists in the raw trace

  const merged = applyOptimization(raw, firstPassMarks.deleteIds, firstPassMarks.chains);
  assert.deepEqual(merged.map((c) => c.id), ["2", "3"]); // GET_LOV correctly precedes its surviving consumer

  const secondPassMarks = computeMarks(merged);
  assert.ok(!secondPassMarks.unusedIds.has("2")); // still has a real consumer AFTER it — must not flip to unused
});
