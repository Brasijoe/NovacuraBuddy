const test = require("node:test");
const assert = require("node:assert/strict");
const FlowLinks = require("./flow-links.js");
const {
  parseLinkTag, withLinkTag, materialize, fingerprint, refNamesFor, lineDiff, diffSteps, memberStatus, groupsOf, mapReferences,
  scan, statuses, planPush, runPush, planLink, runLink, unlink, undoPush, latestOf
} = FlowLinks;

/* In-memory Flow Connect for one organisation: App Library + packages, assets with designer
 * documents (flows) or sources (modules), and the asset description update. */
function fakeConnect() {
  let n = 0;
  const id = (p) => `${p}-${++n}`;
  const assets = new Map();
  const packages = [{ id: "pkgW", name: "Warehouse" }, { id: "pkgS", name: "Shipping" }, { id: "pkgR", name: "Returns" }];
  const calls = [];
  function add(packageId, type, name, extra) {
    const assetId = id(type);
    const meta = { id: assetId, name, type, description: "", color: "#000", tagIds: [], mainBranch: { id: id("branch"), headVersionId: id("ver") } };
    assets.set(assetId, { meta, packageId, ...(type === "module" ? { source: "" } : { designer: { assets: [], data: [] } }), ...extra });
    return meta;
  }
  const json = (body, headers) => ({ ok: true, status: 200, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)), headers: { get: (h) => (headers || {})[h.toLowerCase()] || null } });
  const fail = (status) => ({ ok: false, status, text: async () => "nope", json: async () => ({}) });
  async function flowFetch(path, options) {
    const method = (options && options.method) || "GET";
    calls.push({ method, path });
    let m;
    if (/\/organisations\/org\/packages$/.test(path)) return json(packages);
    if (/\/organisation\/org\/connectors$/.test(path)) return json([{ id: "c1", name: "IFS", type: "ifs" }]);
    if ((m = path.match(/\/organisations\/org(?:\/packages\/([^/]+))?\/assets$/))) {
      const packageId = m[1] || null;
      if (method === "POST") {
        const body = JSON.parse(options.body);
        const meta = add(packageId, body.type, body.name);
        meta.description = body.description || "";
        return json(meta);
      }
      return json([...assets.values()].filter((a) => a.packageId === packageId).map((a) => ({ ...a.meta })));
    }
    if ((m = path.match(/\/organisations\/org(?:\/packages\/([^/]+))?\/assets\/([^/]+)$/))) {
      const a = assets.get(m[2]);
      if (!a || a.packageId !== (m[1] || null)) return fail(404);
      if (method === "PUT") {
        const body = JSON.parse(options.body);
        a.meta.description = body.description;
        return json(a.meta);
      }
      return json({ ...a.meta });
    }
    if ((m = path.match(/\/items\/([^/]+)\/designer$/))) {
      const a = assets.get(m[1]);
      if (method === "POST") {
        const body = JSON.parse(options.body);
        a.designer = { ...a.designer, assets: body.assets, data: body.data, parameterTypeExpression: body.parameterTypeExpression };
        a.saves = (a.saves || 0) + 1;
        return json({});
      }
      return json(JSON.parse(JSON.stringify({ ...a.designer, packageInfo: a.packageId ? { id: a.packageId } : null })), { etag: `"e-${m[1]}"` });
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
      a.committed = (a.committed || 0) + 1;
      return json(a.meta.mainBranch);
    }
    if (/\/branches\/[^/]+$/.test(path)) return json({});
    throw new Error(`fake: unexpected ${method} ${path}`);
  }
  return { flowFetch, add, assets, calls };
}

const steps = (moduleId, script) => [
  { type: "module-added", name: "Shop", moduleId },
  { type: "step-created", id: "s1", stepType: "start", location: { x: 0, y: 0 }, label: "" },
  { type: "step-created", id: "s2", stepType: "script", location: { x: 300, y: 0 }, label: "Get lines", configuration: { script, connector: { id: "c1", name: "IFS" } } },
  { type: "arrow-created", id: "a1", fromStep: "s1", toStep: "s2", joints: [] }
];

/** Order Picking in Warehouse using package module Shop and App Library module Lib; Shipping has
 *  its own Shop. */
function world() {
  const c = fakeConnect();
  const lib = c.add(null, "module", "Lib", { source: "module Lib;" });
  const shopW = c.add("pkgW", "module", "Shop", { source: "module Shop;" });
  const shopS = c.add("pkgS", "module", "Shop", { source: "module Shop; // shipping" });
  const flow = c.add("pkgW", "component", "Order Picking", {
    designer: {
      assets: [{ assetId: shopW.id, assetVersion: shopW.mainBranch.headVersionId }, { assetId: lib.id, assetVersion: lib.mainBranch.headVersionId }],
      data: steps(shopW.id, "let x = 1;")
    }
  });
  return { c, lib, shopW, shopS, flow, flowFetch: c.flowFetch, orgId: "org" };
}

test("link tag round-trips and keeps the user's description", () => {
  const tag = { id: "7f3a1c", rev: 3, h: "abc", src: "flow-1", at: "2026-10-22T12:30Z" };
  const desc = withLinkTag("Picking of lines.", tag);
  assert.match(desc, /^Picking of lines\.\n\n⛓ Linked with copies/);
  assert.deepEqual(parseLinkTag(desc), tag);
  assert.equal(withLinkTag(desc, null), "Picking of lines.");
  assert.equal(parseLinkTag(withLinkTag(desc, { ...tag, rev: 4 })).rev, 4);
  assert.equal(withLinkTag(desc, { ...tag, rev: 4 }).match(/nb-link/g).length, 1);
  assert.equal(parseLinkTag("no tag here"), null);
  assert.equal(parseLinkTag(withLinkTag("", tag)).id, "7f3a1c");
});

test("materialize replays created, updated and deleted events", () => {
  const items = materialize([
    { type: "step-created", id: "a", label: "A" },
    { type: "step-created", id: "b", label: "B" },
    { type: "step-updated", id: "a", label: "A2" },
    { type: "step-deleted", id: "b" },
    { type: "module-added", moduleId: "m" }
  ]);
  assert.deepEqual([...items.keys()], ["a"]);
  assert.equal(items.get("a").label, "A2");
});

test("fingerprint ignores package-specific ids and layout, not content", () => {
  const index = new Map([["m1", { name: "Shop", type: "module" }], ["m2", { name: "SHOP", type: "module" }]]);
  const a = { assets: [{ assetId: "m1", assetVersion: "v1" }], data: steps("m1", "let x = 1;") };
  const b = { assets: [{ assetId: "m2", assetVersion: "v9" }], data: steps("m2", "let x = 1;") };
  b.data[2] = { ...b.data[2], location: { x: 999, y: 5 }, configuration: { ...b.data[2].configuration, connector: { id: "other", name: "ifs" } } };
  assert.equal(fingerprint(a, refNamesFor(a, index)), fingerprint(b, refNamesFor(b, index)));
  const c = { ...b, data: steps("m2", "let x = 2;") };
  assert.notEqual(fingerprint(a, refNamesFor(a, index)), fingerprint(c, refNamesFor(c, index)));
});

test("diffSteps lists changed, added and removed steps with a script diff", () => {
  const index = new Map([["m", { name: "Shop", type: "module" }]]);
  const sd = { assets: [], data: [...steps("m", "a\nb"), { type: "step-created", id: "s3", stepType: "decision", label: "Check serial" }] };
  const td = { assets: [], data: [...steps("m", "a\nc"), { type: "step-created", id: "s9", stepType: "machine", label: "Print label" }] };
  const d = diffSteps({ designer: sd, refNames: refNamesFor(sd, index) }, { designer: td, refNames: refNamesFor(td, index) });
  assert.deepEqual(d.rows.map((r) => [r.label, r.change]), [["start", "same"], ["Get lines", "changed"], ["Check serial", "added"], ["Print label", "removed"]]);
  assert.deepEqual(d.rows[1].script, [{ op: "=", text: "a" }, { op: "-", text: "c" }, { op: "+", text: "b" }]);
  assert.equal(d.arrows, 0);
});

test("copies whose steps got new ids match by content, not by id", () => {
  const index = new Map([["m", { name: "Shop", type: "module" }]]);
  const renumber = (data) => JSON.parse(JSON.stringify(data).replace(/"s1"/g, '"x7"').replace(/"s2"/g, '"x8"').replace(/"a1"/g, '"x9"'));
  const sd = { assets: [], data: steps("m", "a") };
  const td = { assets: [], data: renumber(steps("m", "a")) };
  assert.equal(fingerprint(sd, refNamesFor(sd, index)), fingerprint(td, refNamesFor(td, index)));
  const d = diffSteps({ designer: sd, refNames: {} }, { designer: td, refNames: {} });
  assert.deepEqual(d.rows.map((r) => [r.label, r.change]), [["start", "same"], ["Get lines", "same"]]);
  assert.equal(d.arrows, 0);
  // A renamed step that kept its id is one changed step, not removed plus added.
  const renamed = { assets: [], data: steps("m", "a").map((e) => e.id === "s2" ? { ...e, label: "Read lines" } : e) };
  const r = diffSteps({ designer: renamed, refNames: {} }, { designer: sd, refNames: {} });
  assert.deepEqual(r.rows.map((x) => [x.label, x.change]), [["start", "same"], ["Read lines", "changed"]]);
  assert.equal(r.arrows, 0);
});

test("lineDiff keeps common lines", () => {
  assert.deepEqual(lineDiff("x\ny", "x\ny\nz").map((l) => l.op), ["=", "=", "+"]);
});

test("memberStatus covers every state", () => {
  const tag = { id: "g", rev: 2, h: "h1" };
  assert.equal(memberStatus(tag, "h1", 2), "in_sync");
  assert.equal(memberStatus(tag, "h2", 2), "changed");
  assert.equal(memberStatus(tag, "h1", 3), "behind");
  assert.equal(memberStatus(tag, "h2", 3), "conflict");
  assert.equal(memberStatus({ ...tag, rev: 0 }, "h1", 2), "differs");
  assert.equal(memberStatus(tag, null, 2), "unknown");
  assert.equal(memberStatus(null, "h1", 2), "unlinked");
});

test("mapReferences: App Library stays, own same-named module, copy-in, missing sub-flow", async () => {
  const w = world();
  const sub = w.c.add("pkgW", "component", "Pick Line");
  const s = await scan(w);
  const index = new Map(s.assets.map((a) => [a.id, a]));
  const designer = { assets: [{ assetId: w.shopW.id }, { assetId: w.lib.id }, { assetId: sub.id }] };
  assert.deepEqual(mapReferences(designer, index, "pkgS", s.assets).map((r) => [r.name, r.mode, r.targetId || null]),
    [["Shop", "own", w.shopS.id], ["Lib", "library", w.lib.id], ["Pick Line", "missing", null]]);
  assert.deepEqual(mapReferences(designer, index, "pkgR", s.assets).map((r) => r.mode), ["copy-in", "library", "missing"]);
});

test("link: tags the source, creates a linked copy in another package with its own modules, adopts a same-named flow", async () => {
  const w = world();
  const ret = w.c.add("pkgR", "component", "Order Picking", { designer: { assets: [], data: [{ type: "step-created", id: "x", label: "Old" }] } });
  const plan = await planLink({ ...w, sourceId: w.flow.id, adoptIds: [ret.id], newPackageIds: ["pkgS"], scanResult: await scan(w) });
  assert.equal(plan.blocked, null);
  assert.deepEqual(plan.fresh[0].refs.map((r) => r.mode), ["own", "library"]);
  assert.equal(plan.adopt[0].sameSteps, false);

  const out = await runLink({ ...w, sourceId: w.flow.id, adoptIds: [ret.id], newPackageIds: ["pkgS"] });
  assert.deepEqual(out.results.map((r) => [r.packageName, r.outcome]), [["Warehouse", "linked"], ["Returns", "linked"], ["Shipping", "created"]]);
  const s = await scan(w);
  const group = groupsOf(s.assets).get(out.linkId);
  assert.deepEqual(group.map((a) => [a.packageName, a.tag.rev]), [["Returns", 0], ["Shipping", 1], ["Warehouse", 1]]);
  const copy = w.c.assets.get(group[1].id);
  assert.deepEqual(copy.designer.assets.map((r) => r.assetId), [w.shopS.id, w.lib.id]);
  assert.equal(copy.designer.data[0].moduleId, w.shopS.id);
  assert.equal(copy.committed, 1);
  const st = await statuses({ ...w, scanResult: s, linkIds: [] });
  assert.deepEqual(group.map((a) => st[a.id].status), ["differs", "in_sync", "in_sync"]);
});

test("push: copies a missing module in, skips a copy with own changes unless overwritten, commits, bumps rev; undo restores", async () => {
  const w = world();
  const link = await runLink({ ...w, sourceId: w.flow.id, adoptIds: [], newPackageIds: ["pkgS", "pkgR"] });
  let s = await scan(w);
  const [ret, ship] = groupsOf(s.assets).get(link.linkId);
  assert.equal(ret.packageName, "Returns");
  // Returns got a copy of Shop; edit Warehouse (the source) and Shipping (a local change).
  w.c.assets.get(w.flow.id).designer.data = steps(w.shopW.id, "let x = 2;");
  w.c.assets.get(ship.id).designer.data.push({ type: "step-created", id: "local", label: "Local step" });

  s = await scan(w);
  const plan = await planPush({ ...w, sourceId: w.flow.id, scanResult: s });
  assert.equal(plan.sourceStatus, "changed");
  const byPkg = Object.fromEntries(plan.targets.map((t) => [t.asset.packageName, t]));
  assert.equal(byPkg.Returns.losesWork, false);
  assert.equal(byPkg.Shipping.status, "changed");
  assert.equal(byPkg.Shipping.losesWork, true);
  assert.deepEqual(byPkg.Shipping.diff.rows.filter((r) => r.change !== "same").map((r) => [r.label, r.change]), [["Get lines", "changed"], ["Local step", "removed"]]);

  const out = await runPush({ ...w, sourceId: w.flow.id, targets: plan.targets.map((t) => ({ id: t.asset.id })), expectedMaxRev: plan.maxRev, expectedSourceFp: plan.sourceFp });
  assert.deepEqual(out.results.map((r) => [r.packageName, r.outcome]), [["Returns", "pushed"], ["Shipping", "skipped"]]);
  s = await scan(w);
  const st = await statuses({ ...w, scanResult: s, linkIds: [link.linkId] });
  const g = groupsOf(s.assets).get(link.linkId);
  assert.deepEqual(g.map((a) => [a.packageName, a.tag.rev, st[a.id].status]), [["Returns", 2, "in_sync"], ["Shipping", 1, "conflict"], ["Warehouse", 2, "in_sync"]]);
  assert.equal(w.c.assets.get(w.flow.id).committed, 1);

  // A stale preview is refused.
  await assert.rejects(runPush({ ...w, sourceId: w.flow.id, targets: [{ id: ship.id, overwrite: true }], expectedMaxRev: 1 }), /pushed since the preview/);
  // Overwrite on request, then undo.
  const before = JSON.stringify(w.c.assets.get(ship.id).designer.data);
  const again = await runPush({ ...w, sourceId: w.flow.id, targets: [{ id: ship.id, overwrite: true }], expectedMaxRev: 2 });
  assert.equal(again.results[0].outcome, "pushed");
  assert.equal(again.results[0].overwrote, true);
  assert.notEqual(JSON.stringify(w.c.assets.get(ship.id).designer.data), before);
  await undoPush({ ...w, assetId: ship.id, undo: again.results[0].undo });
  assert.equal(JSON.stringify(w.c.assets.get(ship.id).designer.data), before);
  assert.equal(parseLinkTag(w.c.assets.get(ship.id).meta.description).rev, 1);
});

test("pull is a push from the latest copy; unlink removes the tag only", async () => {
  const w = world();
  const link = await runLink({ ...w, sourceId: w.flow.id, adoptIds: [], newPackageIds: ["pkgS"] });
  let s = await scan(w);
  const ship = groupsOf(s.assets).get(link.linkId).find((a) => a.packageName === "Shipping");
  w.c.assets.get(ship.id).designer.data = steps(w.shopS.id, "let y = 1;");
  s = await scan(w);
  let plan = await planPush({ ...w, sourceId: ship.id, scanResult: s });
  await runPush({ ...w, sourceId: ship.id, targets: [{ id: w.flow.id }], expectedMaxRev: plan.maxRev });
  s = await scan(w);
  const latest = await latestOf({ ...w, scanResult: s, linkId: link.linkId, exceptId: null });
  assert.equal(latest.packageName, "Shipping");
  assert.equal(parseLinkTag(w.c.assets.get(w.flow.id).meta.description).src, ship.id);
  assert.match(w.c.assets.get(w.flow.id).designer.data[2].configuration.script, /let y = 1/);
  assert.equal(w.c.assets.get(w.flow.id).designer.data[0].moduleId, w.shopW.id); // back to Warehouse's own Shop

  await unlink({ ...w, assetId: ship.id });
  assert.equal(parseLinkTag(w.c.assets.get(ship.id).meta.description), null);
});

test("planLink blocks a flow already in another group and a second copy in one package", async () => {
  const w = world();
  const other = w.c.add("pkgS", "component", "Order Picking");
  const third = w.c.add("pkgR", "component", "Order Picking");
  await runLink({ ...w, sourceId: other.id, adoptIds: [third.id], newPackageIds: [] });
  const plan = await planLink({ ...w, sourceId: w.flow.id, adoptIds: [other.id], newPackageIds: ["pkgW"], scanResult: await scan(w) });
  assert.match(plan.adopt[0].blocked, /Already linked/);
  assert.match(plan.fresh[0].blocked, /Already has a copy/);
});

test("a flow copied with Import/Export into another package links in sync (Keep linked)", async () => {
  const w = world();
  const FlowTransfer = require("./flow-transfer.js");
  const pkg = await FlowTransfer.exportFlow({ ...w, packageId: "pkgW", itemId: w.flow.id });
  const outcome = await FlowTransfer.runImport({ ...w, pkg, packageId: "pkgS" });
  const copy = outcome.results.find((r) => r.isRoot);
  const out = await runLink({ ...w, sourceId: w.flow.id, adoptIds: [copy.targetId], newPackageIds: [] });
  assert.deepEqual(out.results.map((r) => r.outcome), ["linked", "linked"]);
  assert.equal(out.results[1].differs, false);
  const s = await scan(w);
  const st = await statuses({ ...w, scanResult: s, linkIds: [out.linkId] });
  assert.deepEqual(Object.values(st).map((x) => x.status), ["in_sync", "in_sync"]);
});
