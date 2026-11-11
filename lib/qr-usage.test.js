const test = require("node:test");
const assert = require("node:assert");
const QU = require("./qr-usage.js");

test("findQuickReportIds finds each called id once", () => {
  assert.deepStrictEqual(QU.findQuickReportIds("let r = QuickReports.QuickReport_123(a);\nQuickReport_45(); QuickReport_123(); NotQuickReport_9 MyQuickReport_7x"), ["123", "45"]);
  assert.deepStrictEqual(QU.findQuickReportIds(""), []);
});

test("runScan lists reports with their flows, skips modules, collects errors", async () => {
  const flows = { A: ["2", "10"], B: ["10"], C: [] };
  const r = await QU.runScan({
    flow: {
      listPackages: async () => [{ id: "p1", name: "Pkg" }],
      listAssets: async (p) => p ? [{ id: "B", name: "b flow", type: "application" }, { id: "X", name: "QuickReports", type: "module" }, { id: "E", name: "broken", type: "application" }]
        : [{ id: "A", name: "a flow", type: "automation" }, { id: "C", name: "c", type: "page" }],
      readFlowIds: async (id) => { if (id === "E") throw new Error("boom"); return flows[id]; }
    },
    readNames: async (ids) => { assert.deepStrictEqual(ids.sort(), ["10", "2"]); return { 10: "Stock" }; }
  });
  assert.strictEqual(r.flowCount, 4);
  assert.deepStrictEqual(r.reports.map((x) => [x.id, x.name, x.flows.map((f) => f.name)]), [["2", "", ["a flow"]], ["10", "Stock", ["a flow", "b flow"]]]);
  assert.deepStrictEqual(r.errors, ["Flow broken: boom"]);
});

test("readNames chunks and normalizes ids", async () => {
  const paths = [];
  const names = await QU.readNames(async (p) => { paths.push(p); return { value: [{ QuickReportId: "5.0", Description: "Five" }] }; }, ["5", "6", "7"], 2);
  assert.strictEqual(paths.length, 2);
  assert.deepStrictEqual(names, { 5: "Five" });
});
