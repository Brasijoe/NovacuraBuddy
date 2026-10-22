const test = require("node:test");
const assert = require("node:assert/strict");
const FlowTransfer = require("./flow-transfer.js");
const {
  validatePackage, collectConnectors, remap, dependencyOrder, choicesFor, findMatch, copyName,
  exportFlow, planImport, runImport
} = FlowTransfer;

/* A small in-memory Flow Connect: organisations with packages, assets, designer documents and
 * module sources, answering the REST paths the extension uses. */
function fakeConnect() {
  let n = 0;
  const id = (p) => `${p}-${++n}`;
  const assets = new Map(); // id -> { meta, orgId, packageId, designer?, source? }
  const connectors = { orgA: [{ id: "connA", name: "IFS", type: "ifs" }], orgB: [{ id: "connB", name: "ifs", type: "ifs" }] };
  const calls = [];

  function add(orgId, packageId, type, name, extra) {
    const assetId = id(type);
    const meta = { id: assetId, name, type, description: "", color: "#000", tagIds: [], mainBranch: { id: id("branch"), headVersionId: id("ver") } };
    assets.set(assetId, { meta, orgId, packageId, ...extra });
    return meta;
  }

  const json = (body, headers) => ({ ok: true, status: 200, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)), headers: { get: (h) => (headers || {})[h.toLowerCase()] || null } });
  const fail = (status) => ({ ok: false, status, text: async () => "nope", json: async () => ({}) });

  async function flowFetch(path, options) {
    const method = (options && options.method) || "GET";
    calls.push({ method, path, body: options && options.body, headers: options && options.headers });
    let m;
    if (path === "/admin/security/api/v3/user/whoAmI") return json({ organizations: [{ id: "orgB", name: "Test" }, { id: "orgA", name: "Dev" }] });
    if ((m = path.match(/^\/admin\/admin-connector\/api\/organisation\/([^/]+)\/connectors$/))) return json(connectors[m[1]] || []);
    if ((m = path.match(/^\/admin\/application\/api\/v2\/organisations\/([^/]+)\/packages$/))) return json([{ id: "pkgA", name: "A" }, { id: "pkgB", name: "B" }]);
    if ((m = path.match(/^\/admin\/application\/api\/v2\/organisations\/([^/]+)(?:\/packages\/([^/]+))?\/assets$/))) {
      const [, orgId, packageId = null] = m;
      if (method === "POST") {
        const body = JSON.parse(options.body);
        return json(add(orgId, packageId, body.type, body.name, body.type === "module" ? { source: "" } : { designer: { assets: [], data: [] } }));
      }
      return json([...assets.values()].filter((a) => a.orgId === orgId && a.packageId === packageId).map((a) => a.meta));
    }
    if ((m = path.match(/^\/admin\/application\/api\/v2\/organisations\/([^/]+)(?:\/packages\/([^/]+))?\/assets\/([^/]+)$/))) {
      const a = assets.get(m[3]);
      if (!a || a.orgId !== m[1] || a.packageId !== (m[2] || null)) return fail(404);
      return json(a.meta);
    }
    if ((m = path.match(/\/items\/([^/]+)\/designer$/))) {
      const a = assets.get(m[1]);
      if (method === "POST") {
        const body = JSON.parse(options.body);
        a.designer = { ...a.designer, assets: body.assets, data: body.data };
        a.saved = body;
        return json({});
      }
      return json({ ...a.designer, packageInfo: a.packageId ? { id: a.packageId } : null }, { etag: `"etag-${m[1]}"` });
    }
    if ((m = path.match(/\/items\/([^/]+)\/designerXml\/([^/]+)$/))) {
      const a = assets.get(m[1]);
      if (method === "POST") {
        a.source = options.body.match(/<Source>([\s\S]*)<\/Source>/)[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
        return json("");
      }
      const esc = a.source.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return json(`<Module><Name>${a.meta.name}</Name><Source>${esc}</Source></Module>`);
    }
    if (/\/items\/[^/]+\/(tasks|data)\/[^/]+$/.test(path)) return json("");
    if (/\/branches\/[^/]+\/validate$/.test(path)) return json({ snapshot: "snap" });
    if ((m = path.match(/\/items\/([^/]+)\/branches\/[^/]+\/commit$/))) {
      const a = assets.get(m[1]);
      a.meta.mainBranch = { ...a.meta.mainBranch, headVersionId: id("ver") };
      a.committed = (a.committed || 0) + 1;
      return json(a.meta.mainBranch);
    }
    if (/\/branches\/[^/]+$/.test(path)) return json({});
    throw new Error(`fake Connect: unexpected ${method} ${path}`);
  }

  return { flowFetch, add, assets, calls };
}

/** orgA/pkgA: flow "Order" using module Shop (package), module Lib (App Library) and sub-flow "Pick". */
function sourceWorld() {
  const c = fakeConnect();
  const shop = c.add("orgA", "pkgA", "module", "Shop", { source: "module Shop; let a = 1 < 2;" });
  const lib = c.add("orgA", null, "module", "Lib", { source: "module Lib;" });
  const pick = c.add("orgA", "pkgA", "component", "Pick", {
    designer: { assets: [{ assetId: shop.id, assetVersion: shop.mainBranch.headVersionId, usedIndirectly: false }], data: [{ type: "module-added", name: "Shop", moduleId: shop.id }] }
  });
  const order = c.add("orgA", "pkgA", "component", "Order", {
    designer: {
      assets: [
        { assetId: shop.id, assetVersion: shop.mainBranch.headVersionId, usedIndirectly: false, offeredParameterType: "any", requiredResultType: "any" },
        { assetId: lib.id, assetVersion: lib.mainBranch.headVersionId, usedIndirectly: false, offeredParameterType: "any", requiredResultType: "any" },
        { assetId: pick.id, assetVersion: pick.mainBranch.headVersionId, usedIndirectly: false, offeredParameterType: "any", requiredResultType: "any" }
      ],
      data: [
        { type: "module-added", name: "Shop", moduleId: shop.id },
        { type: "module-added", name: "Lib", moduleId: lib.id },
        { type: "step-created", id: "s1", stepType: "script", configuration: { script: "open Shop;", connector: { id: "connA", name: "IFS", type: "ifs" } } },
        { type: "step-created", id: "s2", stepType: "subflow", configuration: { assetId: pick.id, version: pick.mainBranch.headVersionId } }
      ],
      parameterTypeExpression: "{}", resultTypeExpression: "{}", architecture: "sequential"
    }
  });
  return { c, shop, lib, pick, order };
}

test("exportFlow packs the flow, its modules (package and App Library) and sub-flows with full data", async () => {
  const { c, shop, lib, pick, order } = sourceWorld();
  const pkg = await exportFlow({ flowFetch: c.flowFetch, orgId: "orgA", packageId: "pkgA", itemId: order.id, generator: "test" });
  assert.equal(pkg.format, "novacura-buddy-flow");
  assert.equal(pkg.rootId, order.id);
  assert.deepEqual(Object.keys(pkg.assets).sort(), [order.id, shop.id, lib.id, pick.id].sort());
  assert.equal(pkg.assets[shop.id].source, "module Shop; let a = 1 < 2;");
  assert.equal(pkg.assets[lib.id].source, "module Lib;");
  assert.equal(pkg.assets[order.id].designer.data.length, 4);
  assert.equal(pkg.assets[order.id].name, "Order");
  assert.deepEqual(pkg.connectors, [{ id: "connA", name: "IFS", type: "ifs" }]);
  assert.deepEqual(pkg.warnings, []);
  assert.ok(c.calls.every((call) => call.method === "GET"), "export only reads");
  validatePackage(JSON.parse(JSON.stringify(pkg)));
});

test("copy to another organisation creates everything, remaps ids, versions and connectors, and saves full data", async () => {
  const { c, shop, lib, pick, order } = sourceWorld();
  const pkg = await exportFlow({ flowFetch: c.flowFetch, orgId: "orgA", packageId: "pkgA", itemId: order.id });
  const plan = await planImport({ flowFetch: c.flowFetch, pkg, orgId: "orgB", packageId: "pkgB" });
  assert.ok(plan.assets.every((a) => a.choice === "create" && a.options.length === 1));
  assert.equal(plan.assets[plan.assets.length - 1].id, order.id, "root last");
  assert.deepEqual(plan.connectors, [{ source: { id: "connA", name: "IFS", type: "ifs" }, targetId: "connB" }]);
  assert.equal(plan.rootName, "Order");

  const out = await runImport({ flowFetch: c.flowFetch, pkg, orgId: "orgB", packageId: "pkgB" });
  const created = (name) => [...c.assets.values()].find((a) => a.orgId === "orgB" && a.meta.name === name);
  const newShop = created("Shop");
  const newLib = created("Lib");
  const newPick = created("Pick");
  const newOrder = created("Order");
  assert.equal(out.rootId, newOrder.meta.id);
  assert.equal(newShop.packageId, "pkgB");
  assert.equal(newShop.source, "module Shop; let a = 1 < 2;");
  assert.equal(newShop.committed, 1);

  const saved = newOrder.saved;
  assert.deepEqual(saved.assets.map((a) => a.assetId), [newShop.meta.id, newLib.meta.id, newPick.meta.id]);
  assert.deepEqual(saved.assets.map((a) => a.assetVersion), [newShop.meta.mainBranch.headVersionId, newLib.meta.mainBranch.headVersionId, newPick.meta.mainBranch.headVersionId]);
  assert.equal(saved.data.length, 4, "the complete flow data, not just changes");
  assert.equal(saved.data[0].moduleId, newShop.meta.id);
  assert.deepEqual(saved.data[2].configuration.connector, { id: "connB", name: "ifs", type: "ifs" });
  assert.equal(saved.data[3].configuration.assetId, newPick.meta.id);
  assert.equal(saved.data[3].configuration.version, newPick.meta.mainBranch.headVersionId);
  const json = JSON.stringify(saved);
  for (const old of [shop.id, lib.id, pick.id]) assert.ok(!json.includes(`"${old}"`), `old id ${old} left in the saved flow`);
  assert.deepEqual(out.unmappedConnectors, []);
  const post = c.calls.find((call) => call.method === "POST" && call.path.endsWith(`/items/${newOrder.meta.id}/designer`));
  assert.equal(post.headers["If-Match"], `"etag-${newOrder.meta.id}"`);
});

test("per-module choice: use existing as-is, update existing, or create new next to an App Library match", async () => {
  const { c, shop, lib, order } = sourceWorld();
  const pkg = await exportFlow({ flowFetch: c.flowFetch, orgId: "orgA", packageId: "pkgA", itemId: order.id });
  const tShop = c.add("orgB", "pkgB", "module", "SHOP", { source: "old code" });
  const tLib = c.add("orgB", null, "module", "Lib", { source: "module Lib;" });
  const tOrder = c.add("orgB", "pkgB", "component", "Order", { designer: { assets: [], data: [{ type: "step-created", id: "x" }] } });

  const plan = await planImport({ flowFetch: c.flowFetch, pkg, orgId: "orgB", packageId: "pkgB" });
  const row = (name) => plan.assets.find((a) => a.name === name);
  assert.deepEqual(row("Shop").options, ["use", "update"]);
  assert.equal(row("Shop").choice, "use");
  assert.equal(row("Shop").sameCode, false);
  assert.deepEqual(row("Lib").options, ["use", "update", "create"]);
  assert.equal(row("Lib").sameCode, true);
  assert.equal(row("Lib").existing.location, "library");
  assert.deepEqual(row("Order").options, ["create", "update"]);
  assert.equal(plan.rootName, "Order (copy)");

  // use Shop as-is, create Lib in the package, update the existing Order flow
  const out = await runImport({
    flowFetch: c.flowFetch, pkg, orgId: "orgB", packageId: "pkgB",
    choices: { [shop.id]: "use", [lib.id]: "create", [order.id]: "update" }
  });
  assert.equal(out.rootId, tOrder.id);
  assert.equal(c.assets.get(tShop.id).source, "old code", "use leaves the module alone");
  assert.equal(c.assets.get(tShop.id).committed, undefined);
  const newLib = [...c.assets.values()].find((a) => a.orgId === "orgB" && a.packageId === "pkgB" && a.meta.name === "Lib");
  assert.ok(newLib && newLib.meta.id !== tLib.id);
  const saved = c.assets.get(tOrder.id).saved;
  assert.equal(saved.data.length, 4, "update replaces the target flow's data with the source's full data");
  assert.equal(saved.assets[0].assetId, tShop.id);
  assert.equal(saved.assets[1].assetId, newLib.meta.id);
});

test("update existing commits the new code to the matched module", async () => {
  const { c, shop, order } = sourceWorld();
  const pkg = await exportFlow({ flowFetch: c.flowFetch, orgId: "orgA", packageId: "pkgA", itemId: order.id });
  const tShop = c.add("orgB", "pkgB", "module", "Shop", { source: "old code" });
  await runImport({ flowFetch: c.flowFetch, pkg, orgId: "orgB", packageId: "pkgB", choices: { [shop.id]: "update" } });
  assert.equal(c.assets.get(tShop.id).source, "module Shop; let a = 1 < 2;");
  assert.equal(c.assets.get(tShop.id).committed, 1);
});

test("runImport refuses a choice the target doesn't allow before changing anything", async () => {
  const { c, shop, order } = sourceWorld();
  const pkg = await exportFlow({ flowFetch: c.flowFetch, orgId: "orgA", packageId: "pkgA", itemId: order.id });
  const before = c.assets.size;
  await assert.rejects(runImport({ flowFetch: c.flowFetch, pkg, orgId: "orgB", packageId: "pkgB", choices: { [shop.id]: "use" } }), /not possible/);
  assert.equal(c.assets.size, before);
});

test("an unmatched connector is cleared and reported", async () => {
  const { c, order } = sourceWorld();
  const pkg = await exportFlow({ flowFetch: c.flowFetch, orgId: "orgA", packageId: "pkgA", itemId: order.id });
  const out = await runImport({ flowFetch: c.flowFetch, pkg, orgId: "orgB", packageId: "pkgB", connectorMap: { connA: null } });
  const saved = c.assets.get(out.rootId).saved;
  assert.equal(saved.data[2].configuration.connector, null);
  assert.deepEqual(out.unmappedConnectors, ["IFS"]);
});

test("pure helpers", () => {
  assert.deepEqual(choicesFor({ isRoot: false, existing: null, targetLocation: "package" }), { options: ["create"], choice: "create" });
  assert.deepEqual(choicesFor({ isRoot: false, existing: { location: "package" }, targetLocation: "package" }), { options: ["use", "update"], choice: "use" });
  assert.equal(copyName("A", [{ name: "a" }, { name: "A (copy)" }]), "A (copy 2)");
  assert.equal(findMatch({ name: "x", type: "module" }, [{ name: "X", type: "component" }], [{ name: "X", type: "module", id: 1 }]).location, "library");
  assert.deepEqual(remap({ a: ["id1", "keep"], connector: { id: "c1", name: "n" } }, { id1: "id2" }, { c1: { id: "c2", name: "m" } }), { a: ["id2", "keep"], connector: { id: "c2", name: "m", type: undefined } });
  assert.deepEqual([...collectConnectors([{ connector: { id: "c", name: "n" } }, { x: { connector: { id: "c" } } }]).keys()], ["c"]);
  const pkg = { rootId: "r", assets: { r: { designer: { assets: [{ assetId: "s" }, { assetId: "m" }] } }, s: { designer: { assets: [{ assetId: "m" }, { assetId: "r" }] } }, m: {} } };
  assert.deepEqual(dependencyOrder(pkg), ["m", "s", "r"]);
  assert.throws(() => validatePackage({ format: "other" }), /not a NovacuraBuddy flow export/);
});
