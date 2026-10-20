const test = require("node:test");
const assert = require("node:assert/strict");
const { listPermissionSets, grantProjection, endpoints } = require("./ifs-permissions.js");

test("grantProjection posts the captured GrantProjections payload", async () => {
  const calls = [];
  const client = { post: async (path, body) => { calls.push({ path, body }); } };
  await grantProjection(client, "CustomPageName", "SALES");
  assert.deepEqual(calls, [{
    path: "/main/ifsapplications/projection/v1/PermissionSetHandling.svc/GrantProjections",
    body: { Projections: "PROJECTION_NAME=CustomPageName^", Role: "SALES" }
  }]);
});

test("grantProjection failure names the permission set", async () => {
  const client = { post: async () => { throw new Error("boom"); } };
  await assert.rejects(grantProjection(client, "X", "SALES"), /^Error: Grant to permission set SALES failed — boom$/);
});

test("listPermissionSets drops IFS-managed sets and falls back to the role id", async () => {
  const client = { get: async (path) => {
    assert.equal(path, endpoints.listPermissionSets());
    return { value: [
      { Role: "SALES", Description: "Sales users", FndRoleDeliveryType: null },
      { Role: "FND_ADMIN", Description: "IFS admin", FndRoleDeliveryType: "IFSManaged" },
      { Role: "NODESC", Description: null, FndRoleDeliveryType: "Customer" }
    ] };
  } };
  assert.deepEqual(await listPermissionSets(client), [{ id: "SALES", name: "Sales users" }, { id: "NODESC", name: "NODESC" }]);
});
