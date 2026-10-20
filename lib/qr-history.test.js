const test = require("node:test");
const assert = require("node:assert/strict");
const { createQrHistory } = require("./qr-history.js");

function fakeStorage() {
  const data = {};
  return { data, get: async (k) => ({ [k]: data[k] }), set: async (o) => { Object.assign(data, o); } };
}

const A = "https://a.example.com";
const B = "https://b.example.com";

test("record keeps one entry per (report, instance) — redeploy replaces it", async () => {
  const h = createQrHistory(fakeStorage());
  await h.record({ qrId: "r1", instanceKey: A, quickReportId: "10", permissionSetIds: ["S"], deployedAt: "2026-10-01T10:00:00.000Z" });
  await h.record({ qrId: "r1", instanceKey: A, quickReportId: "10", permissionSetIds: ["S", "T"], deployedAt: "2026-10-02T10:00:00.000Z" });
  const list = await h.listForReport("r1");
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].permissionSetIds, ["S", "T"]);
  assert.equal(list[0].deployedAt, "2026-10-02T10:00:00.000Z");
});

test("latestFor finds the instance-specific entry, null when none", async () => {
  const h = createQrHistory(fakeStorage());
  await h.record({ qrId: "r1", instanceKey: A, quickReportId: "10", permissionSetIds: [] });
  assert.equal((await h.latestFor("r1", A)).quickReportId, "10");
  assert.equal(await h.latestFor("r1", B), null);
});

test("lists are newest first, per report and per instance", async () => {
  const h = createQrHistory(fakeStorage());
  await h.record({ qrId: "r1", instanceKey: A, quickReportId: "1", permissionSetIds: [], deployedAt: "2026-10-01T00:00:00.000Z" });
  await h.record({ qrId: "r1", instanceKey: B, quickReportId: "2", permissionSetIds: [], deployedAt: "2026-10-03T00:00:00.000Z" });
  await h.record({ qrId: "r2", instanceKey: A, quickReportId: "3", permissionSetIds: [], deployedAt: "2026-10-02T00:00:00.000Z" });
  assert.deepEqual((await h.listForReport("r1")).map((e) => e.quickReportId), ["2", "1"]);
  assert.deepEqual((await h.listForInstance(A)).map((e) => e.quickReportId), ["3", "1"]);
  assert.deepEqual((await h.listAll()).map((e) => e.quickReportId), ["2", "3", "1"]);
});

test("record also remembers the permission sets per instance", async () => {
  const h = createQrHistory(fakeStorage());
  assert.deepEqual(await h.getPermissionSetMemory(A), []);
  await h.record({ qrId: "r1", instanceKey: A, quickReportId: "1", permissionSetIds: ["S", "T"] });
  assert.deepEqual(await h.getPermissionSetMemory(A), ["S", "T"]);
  assert.deepEqual(await h.getPermissionSetMemory(B), []);
});
