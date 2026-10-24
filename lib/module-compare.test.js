const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const MC = require("./module-compare.js");

const fixture = fs.readFileSync(path.join(__dirname, "fixtures/codegen-shop-repair-picking-locat.flowscript"), "utf8");
const regenerated = (src) => src.replace(/Auto generated code: [^\n]*/, "Auto generated code: 2027-01-01 00:00:00 (build 999999)");

test("parseDeclarations splits a generated module into its functions, types and lets", () => {
  const decls = MC.parseDeclarations(fixture);
  const keys = decls.map((d) => d.key);
  assert.ok(keys.includes("let:basePath"));
  assert.ok(keys.includes("type:ShopRepairPickingLocat"));
  assert.ok(keys.includes("function:ShopRepairPickingLocatSet_Create"));
  assert.ok(keys.includes("let:ShopRepairPickingLocatSet"));
  const create = decls.find((d) => d.key === "function:ShopRepairPickingLocatSet_Create");
  assert.match(create.text, /^\/\*\* Add new entity/); // its doc comment comes along
  assert.ok(decls.find((d) => d.name === "enumName").private);
});

test("a regenerated module that differs only in its header has no changes", () => {
  const r = MC.analyzeModule({ name: "M", oldSource: fixture, newSource: regenerated(fixture), usages: [] });
  assert.strictEqual(r.status, "same");
  assert.strictEqual(r.headerOnly, true);
});

test("parseFunction reads parameters, defaults and the return type", () => {
  const sig = MC.parseFunction("function F(Objkey:text, ifMatch: text = \"*\", headers: Header* = []): ShopX {\n}");
  assert.deepStrictEqual(sig.params.map((p) => [p.name, p.type, p.optional]), [["Objkey", "text", false], ["ifMatch", "text", true], ["headers", "Header*", true]]);
  assert.strictEqual(sig.returnType, "ShopX");
});

test("parseRecordType reads optional, defaulted and quoted fields", () => {
  const f = MC.parseRecordType('type T = {\n    "@odata.etag": text,\n    luname: text? = null,\n    optional Cf_Site: text,\n    Objkey: text,\n}');
  assert.deepStrictEqual(f.map((x) => [x.name, x.optional]), [["@odata.etag", false], ["luname", true], ["Cf_Site", true], ["Objkey", false]]);
});

const usageOfCreate = [{ flowId: "f1", flowName: "Create location", packageName: "P", text: "let r = CustomProjectionShopRepairPickingLocat.ShopRepairPickingLocatSet_Create({ Cf_Site: site })" }];

test("a new mandatory field in a used input type is critical and counts as impacted", () => {
  const next = regenerated(fixture).replace("    optional Cf_Site: text,\n};", "    optional Cf_Site: text,\n    Contract: text,\n};");
  const r = MC.analyzeModule({ name: "CustomProjectionShopRepairPickingLocat", oldSource: fixture, newSource: next, usages: usageOfCreate });
  assert.strictEqual(r.status, "changed");
  const change = r.changes.find((c) => c.key === "type:ShopRepairPickingLocatInsertRequest");
  assert.strictEqual(change.severity, "critical");
  assert.strictEqual(change.used, true);
  const used = r.usage[0].used.find((u) => u.name === "ShopRepairPickingLocatSet_Create");
  assert.strictEqual(used.status, "impacted");
  assert.strictEqual(used.severity, "critical");
  assert.strictEqual(r.impactedCount, 1);
  assert.ok(change.diff.some((l) => l.op === "+" && l.text.includes("Contract")));
});

test("an optional new field or a removed field nobody uses is not critical", () => {
  const next = regenerated(fixture)
    .replace("    Cf_Site: text? = null,\n}", "    Cf_Site: text? = null,\n    Cf_New: text? = null,\n}")
    .replace("    keyref: text? = null,\n", "");
  const r = MC.analyzeModule({ name: "CustomProjectionShopRepairPickingLocat", oldSource: fixture, newSource: next, usages: usageOfCreate });
  const change = r.changes.find((c) => c.key === "type:ShopRepairPickingLocat");
  assert.deepStrictEqual(change.findings.map((f) => f.severity).sort(), ["info", "minor"]);
  assert.notStrictEqual(r.usage[0].used[0].status, "impacted");
});

test("a removed field the flows read is major", () => {
  const next = regenerated(fixture).replace("    Cf_Locationno: text? = null,\n", "");
  const usages = [{ flowId: "f1", flowName: "Read", text: "select Cf_Locationno from CustomProjectionShopRepairPickingLocat.ShopRepairPickingLocatSet" }];
  const r = MC.analyzeModule({ name: "CustomProjectionShopRepairPickingLocat", oldSource: fixture, newSource: next, usages });
  const used = r.usage[0].used.find((u) => u.name === "ShopRepairPickingLocatSet");
  assert.strictEqual(used.severity, "major");
  assert.strictEqual(used.status, "impacted");
});

test("a sub-function's change reaches the public function that calls it", () => {
  const next = regenerated(fixture).replace("private function toSanitizedLiteral(lit: text): text => `'{lit.replace(\"'\", \"''\")}'`;", "private function toSanitizedLiteral(lit: text): text => `'{lit}'`;");
  const usages = [{ flowId: "f1", flowName: "Get", text: "CustomProjectionShopRepairPickingLocat.GetShopRepairPickingLocatSetByKey(k)" }];
  const r = MC.analyzeModule({ name: "CustomProjectionShopRepairPickingLocat", oldSource: fixture, newSource: next, usages });
  const used = r.usage[0].used[0];
  assert.strictEqual(used.status, "changed");
  assert.strictEqual(used.severity, "minor");
  assert.ok(used.changes.includes("function:toSanitizedLiteral"));
});

test("rateChange: new mandatory parameter is critical, new optional one info, removed function critical", () => {
  const f = (t) => ({ key: "function:F", name: "F", kind: "function", text: t });
  assert.strictEqual(MC.rateChange(f("function F(a: text) {}"), f("function F(a: text, b: number) {}"))[0].severity, "critical");
  assert.strictEqual(MC.rateChange(f("function F(a: text) {}"), f("function F(a: text, b: number = 1) {}"))[0].severity, "info");
  assert.strictEqual(MC.rateChange(f("function F(a: text) {}"), null)[0].severity, "critical");
});

test("lineDiff keeps the common head and tail", () => {
  assert.deepStrictEqual(MC.lineDiff("a\nb\nc", "a\nx\nc").map((l) => l.op + l.text), ["=a", "-b", "+x", "=c"]);
});

test("flowText collects every string of the step data", () => {
  assert.strictEqual(MC.flowText({ data: [{ a: "x", b: [{ c: "y" }, 3] }] }), "x\ny");
});

test("runScan compares the package's and the App Library's modules and finds their flows", async () => {
  const assets = {
    null: [{ id: "lib1", name: "CustomProjectionShopRepairPickingLocat", type: "module", mainBranch: { headVersionId: "v1" } }, { id: "plain", name: "Helpers", type: "module" }],
    p1: [{ id: "f1", name: "Create location", type: "component" }],
    p2: [{ id: "f2", name: "Other package flow", type: "component" }]
  };
  const next = regenerated(fixture).replace("    optional Cf_Site: text,\n};", "    optional Cf_Site: text,\n    Contract: text,\n};");
  const generatedFor = [];
  const result = await MC.runScan({
    packageId: "p1",
    flow: {
      listPackages: async () => [{ id: "p1", name: "P1" }, { id: "p2", name: "P2" }],
      listAssets: async (id) => assets[id],
      readSource: async (m) => (m.id === "lib1" ? fixture : "let x = 1;"),
      readDesigner: async (id) => ({ assets: [{ assetId: "lib1", usedIndirectly: false }], data: [{ script: usageOfCreate[0].text }] })
    },
    generateCode: async (projection) => { generatedFor.push(projection); return next; },
    ifsProjectionOf: (src) => (/#importSource\("[^"]*?\/([A-Za-z0-9_]+)\.svc/.exec(src) || [])[1] || null
  });
  assert.deepStrictEqual(generatedFor, ["CustomProjectionShopRepairPickingLocat"]);
  const m = result.modules.find((x) => x.id === "lib1");
  assert.strictEqual(m.status, "changed");
  assert.strictEqual(m.packageName, "App Library");
  assert.strictEqual(m.usedBy, 1); // only f1: p2 is outside the scan
  assert.strictEqual(m.impactedCount, 1);
  assert.ok(m.newSource.includes("Contract"));
  assert.strictEqual(result.modules.find((x) => x.id === "plain").status, "skipped");
});
