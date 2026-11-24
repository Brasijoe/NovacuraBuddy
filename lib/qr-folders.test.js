const test = require("node:test");
const assert = require("node:assert");
const F = require("./qr-folders.js");

test("folders are sorted, unique and can be renamed", () => {
  let s = F.empty();
  let a = F.addFolder(s, "Uster"); s = a.state;
  s = F.addFolder(s, "Acme").state;
  assert.deepStrictEqual(s.folders.map((f) => f.name), ["Acme", "Uster"]);
  assert.throws(() => F.addFolder(s, " uster "), /already exists/);
  assert.throws(() => F.addFolder(s, "  "), /name/);
  s = F.renameFolder(s, a.folder.id, "Zeta");
  assert.deepStrictEqual(s.folders.map((f) => f.name), ["Acme", "Zeta"]);
  assert.throws(() => F.renameFolder(s, a.folder.id, "acme"), /already exists/);
});

test("moving, grouping and deleting a folder keeps the reports", () => {
  let s = F.empty();
  const { state, folder } = F.addFolder(s, "Uster");
  s = F.moveReport(state, "r1", folder.id);
  const reports = [{ id: "r1" }, { id: "r2" }];
  const g = F.group(s, reports);
  assert.deepStrictEqual(g.map((x) => [x.folder && x.folder.name, x.reports.map((r) => r.id)]), [["Uster", ["r1"]], [null, ["r2"]]]);
  s = F.moveReport(s, "r1", null);
  assert.deepStrictEqual(F.group(s, reports)[1].reports.length, 2);
  s = F.moveReport(s, "r1", folder.id);
  s = F.deleteFolder(s, folder.id);
  assert.deepStrictEqual(s.assign, {});
  assert.strictEqual(F.group(s, reports).length, 1);
});

test("normalize drops assignments to folders that no longer exist", () => {
  const s = F.normalize({ folders: [{ id: "a", name: "A" }, { id: 3 }], assign: { r1: "a", r2: "gone" }, collapsed: { a: true, gone: true } });
  assert.deepStrictEqual(s.assign, { r1: "a" });
  assert.deepStrictEqual(s.collapsed, { a: true });
});
