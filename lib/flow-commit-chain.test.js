const test = require("node:test");
const assert = require("node:assert/strict");
const FlowCommitChain = require("./flow-commit-chain.js");
const { branchState, markNeeds, plan, commitOne, undoOne } = FlowCommitChain;

/* Small in-memory Flow Connect: assets of one package, designer documents, module sources and
 * the commit sequence (every commit gives the asset a new head version). */
function fakeConnect() {
  let n = 0;
  const id = (p) => `${p}-${++n}`;
  const assets = new Map();
  const calls = [];
  const products = [];
  const usedBy = [];
  const add = (type, name, extra, branchExtra) => {
    const assetId = id(type);
    const meta = { id: assetId, name, type, description: "", mainBranch: { id: id("branch"), headVersionId: id("ver"), ...branchExtra } };
    assets.set(assetId, { meta, ...(type === "module" ? { source: `module ${name};` } : { designer: { assets: [], data: [] } }), ...extra });
    return meta;
  };
  const json = (body, headers) => ({ ok: true, status: 200, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)), headers: { get: (h) => (headers || {})[h.toLowerCase()] || null } });
  async function flowFetch(path, options) {
    const method = (options && options.method) || "GET";
    calls.push({ method, path });
    let m;
    if (/\/organisations\/org\/packages$/.test(path)) return json([{ id: "pkg", name: "Pkg" }]);
    if (/\/organisations\/org\/packages\/pkg\/products$/.test(path)) return json(products);
    if ((m = path.match(/\/organisations\/org\/packages\/pkg\/products\/([^/]+)$/))) return json(products.find((p) => p.id === m[1]) || {});
    if (/\/organisations\/org\/packages\/pkg\/assets$/.test(path)) return json([...assets.values()].map((a) => ({ ...a.meta })));
    if (/\/organisations\/org\/assets$/.test(path)) return json([]);
    if ((m = path.match(/\/assets\/([^/]+)\/used-by$/)) && usedBy.length) return json(usedBy);
    if ((m = path.match(/\/assets\/([^/]+)$/))) return json({ ...assets.get(m[1]).meta });
    if ((m = path.match(/\/items\/([^/]+)\/designer$/))) {
      const a = assets.get(m[1]);
      if (method === "POST") { const b = JSON.parse(options.body); a.designer = { ...a.designer, assets: b.assets, data: b.data }; return json({}); }
      return json(JSON.parse(JSON.stringify({ ...a.designer, packageInfo: { id: "pkg" } })), { etag: `"e"` });
    }
    if ((m = path.match(/\/items\/([^/]+)\/designerXml\/([^/]+)$/))) {
      const a = assets.get(m[1]);
      if (method === "POST") { a.source = options.body.match(/<Source>([\s\S]*)<\/Source>/)[1]; return json(""); }
      return json(`<Module><Name>${a.meta.name}</Name><Source>${a.source}</Source></Module>`);
    }
    if (/\/items\/[^/]+\/(tasks|data)\/[^/]+$/.test(path)) return json("");
    if (/\/branches\/[^/]+\/validate$/.test(path)) return json({ snapshot: "snap" });
    if ((m = path.match(/\/items\/([^/]+)\/branches\/[^/]+\/commit$/))) {
      const a = assets.get(m[1]);
      a.meta.mainBranch = { ...a.meta.mainBranch, headVersionId: id("ver") };
      a.commits = (a.commits || 0) + 1;
      return json(a.meta.mainBranch);
    }
    if (/\/branches\/[^/]+$/.test(path)) return json({});
    throw new Error(`fake: unexpected ${method} ${path}`);
  }
  return { flowFetch, add, assets, calls, products, usedBy };
}

const ref = (meta) => ({ assetId: meta.id, assetVersion: meta.mainBranch.headVersionId });
const scanOf = (c) => ({ assets: [...c.assets.values()].map((a) => ({ ...a.meta, packageId: "pkg", packageName: "Pkg" })) });

test("branchState reads a flag or a latest-committed version, and says when it can't tell", () => {
  assert.deepEqual(branchState({ mainBranch: { headVersionId: "v1" } }), { dirty: false, known: false });
  assert.deepEqual(branchState({ hasUncommittedChanges: true, mainBranch: {} }), { dirty: true, known: true });
  assert.deepEqual(branchState({ mainBranch: { headVersionId: "v2", latestCommittedVersionId: "v1" } }), { dirty: true, known: true });
  assert.deepEqual(branchState({ mainBranch: { headVersionId: "v2", latestCommittedVersionId: "v2" } }), { dirty: false, known: true });
  assert.deepEqual(branchState({ mainBranch: { headVersionId: "v2", latestCommittedVersionId: null } }), { dirty: true, known: true });
});

test("markNeeds: a dirty leaf makes every user above it need a commit", () => {
  const nodes = new Map([
    ["mod", { id: "mod", dirty: true, deps: [] }],
    ["sub", { id: "sub", dirty: false, deps: [{ id: "mod", name: "Mod", outdated: false }] }],
    ["top", { id: "top", dirty: false, deps: [{ id: "sub", name: "Sub", outdated: false }] }],
    ["solo", { id: "solo", dirty: false, deps: [] }]
  ]);
  markNeeds(["mod", "sub", "top", "solo"], nodes);
  assert.deepEqual([...nodes.values()].map((n) => n.needs), [true, true, true, false]);
  assert.equal(nodes.get("sub").reasons[0].kind, "below");
});

function world() {
  const c = fakeConnect();
  const mod = c.add("module", "Shop", {}, { latestCommittedVersionId: "old" }); // head differs: uncommitted
  const sub = c.add("component", "Pick", {});
  const top = c.add("component", "Order", {});
  c.assets.get(sub.id).designer = { assets: [ref(mod)], data: [{ type: "module-added", moduleId: mod.id }, { type: "step-created", id: "s1", stepType: "start", label: "" }] };
  c.assets.get(top.id).designer = {
    assets: [ref(sub), ref(mod)],
    data: [{ type: "step-created", id: "s1", stepType: "subflow", label: "Pick", configuration: { assetId: sub.id, version: sub.mainBranch.headVersionId } }]
  };
  return { c, mod, sub, top };
}

test("plan lists the flows above the open asset, the asset first, each once, and marks what needs a commit", async () => {
  const { c, mod, sub, top } = world();
  const p = await plan({ flowFetch: c.flowFetch, orgId: "org", rootId: mod.id, scanResult: scanOf(c) });
  assert.deepEqual(p.items.map((i) => i.id), [mod.id, sub.id, top.id]);
  assert.deepEqual(p.items.map((i) => i.needs), [false, false, false]); // the source is not committed here and they point at its head
  assert.deepEqual(p.tree, [{ id: mod.id, depth: 0 }, { id: sub.id, depth: 1 }, { id: top.id, depth: 2 }]); // Order uses Shop directly too, but sits under Pick, which it also uses
  assert.equal(p.items[2].steps, 1);
  assert.deepEqual(p.cycles, []);
});

test("plan from a flow only reads what uses it, not what it uses", async () => {
  const { c, mod, sub, top } = world();
  const p = await plan({ flowFetch: c.flowFetch, orgId: "org", rootId: sub.id, scanResult: scanOf(c) });
  assert.deepEqual(p.items.map((i) => i.id), [sub.id, top.id]);
  assert.ok(!p.items.some((i) => i.id === mod.id));
});

test("plan flags a reference cycle instead of looping", async () => {
  const c = fakeConnect();
  const a = c.add("component", "A", {});
  const b = c.add("component", "B", {});
  c.assets.get(a.id).designer = { assets: [ref(b)], data: [] };
  c.assets.get(b.id).designer = { assets: [ref(a)], data: [] };
  const p = await plan({ flowFetch: c.flowFetch, orgId: "org", rootId: a.id, scanResult: scanOf(c) });
  assert.equal(p.items.length, 2);
  assert.deepEqual(p.cycles[0], ["A", "B", "A"]);
});

test("a flow that uses an older version of the open asset is outdated", async () => {
  const { c, mod, sub } = world();
  const branch = c.assets.get(mod.id).meta.mainBranch;
  branch.headVersionId = "ver-new";
  branch.latestCommittedVersionId = "ver-new"; // clean, but newer than what Pick references
  const p = await plan({ flowFetch: c.flowFetch, orgId: "org", rootId: mod.id, scanResult: scanOf(c) });
  const item = p.items.find((i) => i.id === sub.id);
  assert.equal(item.deps[0].outdated, true);
  assert.equal(item.reasons[0].kind, "newer");
  assert.equal(p.items.find((i) => i.id === mod.id).needs, false);
});

test("commitOne commits a module with its own code and offers Undo", async () => {
  const { c, mod } = world();
  const before = c.assets.get(mod.id).meta.mainBranch.headVersionId;
  const out = await commitOne({ flowFetch: c.flowFetch, orgId: "org", asset: { id: mod.id, name: "Shop", type: "module", packageId: "pkg" } });
  assert.notEqual(out.headVersionId, before);
  assert.equal(c.assets.get(mod.id).commits, 1);
  assert.equal(out.undo.previousSource, "module Shop;");
  await undoOne({ flowFetch: c.flowFetch, orgId: "org", asset: { id: mod.id, packageId: "pkg" }, undo: out.undo });
  assert.equal(c.assets.get(mod.id).commits, 2);
});

test("commitOne moves the references to the new head versions, saves the FULL data and commits", async () => {
  const { c, mod, sub, top } = world();
  const oldSub = sub.mainBranch.headVersionId;
  await commitOne({ flowFetch: c.flowFetch, orgId: "org", asset: { id: mod.id, name: "Shop", type: "module", packageId: "pkg" } });
  await commitOne({ flowFetch: c.flowFetch, orgId: "org", asset: { id: sub.id, name: "Pick", type: "component", packageId: "pkg" }, bump: [{ assetId: mod.id, packageId: "pkg" }] });
  const newSub = c.assets.get(sub.id).meta.mainBranch.headVersionId;
  assert.notEqual(newSub, oldSub);
  const out = await commitOne({ flowFetch: c.flowFetch, orgId: "org", asset: { id: top.id, name: "Order", type: "component", packageId: "pkg" }, bump: [{ assetId: sub.id, packageId: "pkg" }, { assetId: mod.id, packageId: "pkg" }] });
  const saved = c.assets.get(top.id);
  assert.deepEqual(saved.designer.assets.map((r) => r.assetVersion), [newSub, c.assets.get(mod.id).meta.mainBranch.headVersionId]);
  assert.equal(saved.designer.data.length, 1); // full data kept
  assert.equal(saved.designer.data[0].configuration.version, newSub); // the step's pinned version moved too
  assert.equal(saved.commits, 1);
  assert.equal(out.undo.kind, "flow");
  assert.equal(out.undo.previous.data[0].configuration.version, oldSub);
});

test("a dependency that is not bumped keeps its referenced version", async () => {
  const { c, top } = world();
  const kept = c.assets.get(top.id).designer.assets.map((r) => r.assetVersion);
  await commitOne({ flowFetch: c.flowFetch, orgId: "org", asset: { id: top.id, name: "Order", type: "component", packageId: "pkg" }, bump: [] });
  assert.deepEqual(c.assets.get(top.id).designer.assets.map((r) => r.assetVersion), kept);
});

test("commitOne with commit: false saves a flow with its references moved, without committing", async () => {
  const { c, mod, sub } = world();
  const branch = c.assets.get(mod.id).meta.mainBranch;
  branch.headVersionId = "ver-new";
  const out = await commitOne({ flowFetch: c.flowFetch, orgId: "org", asset: { id: sub.id, name: "Pick", type: "component", packageId: "pkg" }, bump: [{ assetId: mod.id, packageId: "pkg" }], commit: false });
  assert.equal(c.assets.get(sub.id).commits, undefined);
  assert.equal(c.assets.get(sub.id).designer.assets[0].assetVersion, "ver-new");
  assert.equal(out.undo.saved, true);
  const mine = await commitOne({ flowFetch: c.flowFetch, orgId: "org", asset: { id: mod.id, name: "Shop", type: "module", packageId: "pkg" }, commit: false });
  assert.equal(mine.undo, null);
  assert.equal(c.assets.get(mod.id).commits, undefined);
});

test("referencedIds finds a component step's componentId even when assets[] lacks it", () => {
  const id = "720d8365-2f7f-4285-a6d9-1dbb56ccb8c3";
  const index = new Map([[id, { id, name: "TesT123" }], ["other", { id: "other" }]]);
  const designer = { assets: [{ assetId: "other", assetVersion: "v1" }], data: [{ type: "step-created", stepType: "component", configuration: { type: "component-step-configuration", componentId: id.toUpperCase(), componentName: "TesT123" } }] };
  assert.deepEqual(FlowCommitChain.referencedIds(designer, index, "me").map((r) => r.assetId), ["other", id]);
});

test("plan finds an automation product that uses the open asset through its version info", async () => {
  const { c, mod } = world();
  c.products.push({ id: "auto-1", name: "IFSC Print", type: "automation", mainBranch: { versionInfo: { assets: [{ assetId: mod.id, assetVersion: "v1", usedIndirectly: false }, { assetId: "x", usedIndirectly: true }] } } });
  const p = await plan({ flowFetch: c.flowFetch, orgId: "org", rootId: mod.id, scanResult: { ...scanOf(c), packages: [{ id: "pkg", name: "Pkg" }] } });
  const auto = p.items.find((i) => i.id === "auto-1");
  assert.ok(auto, "the automation is in the tree");
  assert.equal(auto.type, "automation");
  assert.deepEqual(p.failed, []);
});

test("plan uses Flow's used-by lookup when it answers, without scanning every flow", async () => {
  const { c, mod, sub } = world();
  c.usedBy.push({ id: "app-1", name: "IFSC Print", type: "application", location: { packageId: "pkg", packageName: "Pkg" }, headVersionId: "h1", mainBranchId: "b1",
    consistsOf: [{ id: sub.id, name: "Pick", type: "component", location: null, consistsOf: [{ id: mod.id, name: "Shop", type: "module", location: null, consistsOf: [] }] }] });
  const p = await plan({ flowFetch: c.flowFetch, orgId: "org", rootId: mod.id, scanResult: scanOf(c) });
  assert.deepEqual(p.items.map((i) => i.name), ["Shop", "Pick", "IFSC Print"]);
  assert.equal(p.items[2].type, "application");
  assert.deepEqual(p.tree.map((t) => t.depth), [0, 1, 2]);
  assert.ok(c.calls.every((x) => !/\/designer$/.test(x.path) || x.path.includes(sub.id) || x.path.includes("app-1")), "no flow outside the tree was read");
});

test("lastCommitMessage reads the branch's last commit message when Flow gives one", () => {
  assert.equal(FlowCommitChain.lastCommitMessage({ commitMessage: " Fix label " }), "Fix label");
  assert.equal(FlowCommitChain.lastCommitMessage({ headVersionId: "v" }), "");
});

test("the open asset is the source: what uses an older version of it needs an update, what uses its head does not", async () => {
  const c = fakeConnect();
  const mod = c.add("module", "Source");
  const old = c.add("component", "Old user");
  const current = c.add("component", "Current user");
  c.assets.get(old.id).designer = { assets: [{ assetId: mod.id, assetVersion: "older" }], data: [] };
  c.assets.get(current.id).designer = { assets: [ref(mod)], data: [] };
  const p = await plan({ flowFetch: c.flowFetch, orgId: "org", rootId: mod.id, scanResult: scanOf(c) });
  const needs = Object.fromEntries(p.items.map((i) => [i.name, i.needs]));
  assert.deepEqual(needs, { Source: false, "Old user": true, "Current user": false });
});

test("used-by with an app that uses both a component and the open asset puts the app under the component", async () => {
  const { c, mod } = world();
  const leaf = { id: mod.id, name: "TesT123", type: "component", location: null, consistsOf: [] };
  c.usedBy.push({ id: "app-1", name: "IFSC", type: "application", location: { packageId: "pkg", packageName: "Pkg" },
    consistsOf: [{ id: "two-level", name: "Test 2 Level", type: "component", location: null, consistsOf: [leaf] }, leaf] });
  const p = await plan({ flowFetch: c.flowFetch, orgId: "org", rootId: mod.id, scanResult: scanOf(c) });
  const names = (list) => list.map((t) => `${t.depth}:${p.items.find((i) => i.id === t.id).name}`);
  assert.deepEqual(names(p.tree).filter((n) => /IFSC|Test 2/.test(n)), ["1:Test 2 Level", "2:IFSC"]);
});

test("an app is saved with data: [] (its steps are never re-sent), its direct references moved, then committed", async () => {
  const { c, mod } = world();
  const app = c.add("application", "IFSC", {});
  c.assets.get(app.id).designer = {
    assets: [{ assetId: mod.id, assetVersion: "old", usedIndirectly: false }, { assetId: "deep", assetVersion: "v9", usedIndirectly: true }],
    data: [{ type: "step-created", id: "s1" }, { type: "step-created", id: "s2" }]
  };
  c.products.push({ id: app.id, name: "IFSC", type: "application", mainBranch: c.assets.get(app.id).meta.mainBranch });
  const posts = [];
  // Flow treats `data` of a designer save as the changes to add (the Designer sends [] when there are none).
  const flowFetch = async (path, options) => {
    if (options && options.method === "POST" && /\/designer$/.test(path)) {
      const body = JSON.parse(options.body);
      posts.push(body);
      options = { ...options, body: JSON.stringify({ ...body, data: [...c.assets.get(app.id).designer.data, ...body.data] }) };
    }
    return c.flowFetch(path, options);
  };
  const out = await commitOne({ flowFetch, orgId: "org", asset: { id: app.id, name: "IFSC", type: "application", packageId: "pkg" }, bump: [{ assetId: mod.id, packageId: "pkg", headVersionId: "new" }] });
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].data, [], "the steps are not sent");
  assert.deepEqual(posts[0].assets.map((r) => r.assetVersion), ["new", "v9"], "only the direct reference moves");
  assert.equal(c.assets.get(app.id).commits, 1);
  assert.equal(out.undo.kind, "product");
});

test("commitOne refuses a flow whose content is not a list", async () => {
  const { c, sub } = world();
  c.assets.get(sub.id).designer.data = { notAList: true };
  await assert.rejects(() => commitOne({ flowFetch: c.flowFetch, orgId: "org", asset: { id: sub.id, name: "Pick", type: "component", packageId: "pkg" } }), /expected format/);
  assert.equal(c.calls.filter((x) => x.method === "POST").length, 0, "nothing was written");
});
