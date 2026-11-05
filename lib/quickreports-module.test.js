const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const M = require("./quickreports-module.js");

const block = (id) => `type Structure_${id} = {
\tC1_A: text? = null,
}

function QuickReport_${id}(a:text?, headers: Header* = []): Structure_${id}* { 
    let __raw = 1;
    return unsafeCast<Structure_${id}*>(__raw);
}
`;
const CODE = `/*\n#importSource("/b2b/ifsapplications/projection/v1/QuickReports.svc")\n*/\nlet basePath = 'x';\n\ntype Header = {\n    Name: text\n};\n\n${block(1)}\n${block(22)}\n${block(333)}\ntype KeyValuePair = {\n\tKey: text? = null,\n}\n\nfunction GetReportInfo(reportId:text): text? { \n    return 1;\n}\n`;

test("reportIds lists the report functions", () => {
  assert.deepEqual(M.reportIds(CODE), ["1", "22", "333"]);
});

test("keepOnly drops the type and function of other reports and nothing else", () => {
  const out = M.keepOnly(CODE, ["22", "999"]);
  assert.deepEqual(M.reportIds(out), ["22"]);
  assert.doesNotMatch(out, /Structure_1\b|Structure_333/);
  assert.match(out, /Structure_22 = \{/);
  for (const keepMe of ["let basePath", "type Header", "type KeyValuePair", "function GetReportInfo", "#importSource"]) assert.ok(out.includes(keepMe), keepMe);
  assert.doesNotMatch(out, /\n\n\n/);
});

test("keepOnly with every id is a no-op and accepts IFS ids like 22.0", () => {
  assert.equal(M.keepOnly(CODE, ["1", "22", "333"]), CODE.replace(/\r/g, ""));
  assert.deepEqual(M.reportIds(M.keepOnly(CODE, ["1.0"])), ["1"]);
});

test("compare counts total, new and lost", () => {
  assert.deepEqual(M.compare(M.keepOnly(CODE, ["22"]), CODE), { total: 1, added: 0, existing: 3, lost: ["1", "333"] });
  assert.deepEqual(M.compare(CODE, null), { total: 3, added: 3, existing: 0, lost: [] });
});

test("updateQuickReportsModule asks before losing reports, commits when forced or nothing is lost", async () => {
  const commits = [];
  const deps = (existingSource) => ({
    generate: async () => CODE,
    readExisting: async () => (existingSource ? { asset: { id: "A" }, source: existingSource } : null),
    commit: async (code, asset) => { commits.push(code); return asset || { id: "NEW" }; }
  });
  const ask = await M.updateQuickReportsModule({ ...deps(CODE), deployedIds: ["22"] });
  assert.equal(ask.status, "needsConfirmation");
  assert.equal(commits.length, 0);
  const forced = await M.updateQuickReportsModule({ ...deps(CODE), deployedIds: ["22"], force: true });
  assert.equal(forced.status, "done");
  assert.equal(commits.length, 1);
  const full = await M.updateQuickReportsModule({ ...deps(M.keepOnly(CODE, ["22"])), deployedIds: null });
  assert.deepEqual([full.status, full.total, full.added, full.existing], ["done", 3, 2, 1]);
  const fresh = await M.updateQuickReportsModule({ ...deps(null), deployedIds: ["22"] });
  assert.equal(fresh.assetId, "NEW");
});
