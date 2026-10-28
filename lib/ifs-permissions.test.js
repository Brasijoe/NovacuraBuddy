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

test("entitySets maps entity types to their set names in either attribute order", async () => {
  const { entitySets } = require("./ifs-permissions.js");
  const client = { getText: async () => '<EntitySet Name="Users" EntityType="X.User"/><EntitySet EntityType="X.UsersGrantedProjection" Name="UsersGrantedProjections"/>' };
  assert.deepEqual(await entitySets(client), { User: "Users", UsersGrantedProjection: "UsersGrantedProjections" });
});

test("userProjections follows nextLink and quotes the identity", async () => {
  const { userProjections } = require("./ifs-permissions.js");
  const paths = [];
  const client = { get: async (path) => {
    paths.push(path);
    return paths.length === 1
      ? { value: [{ Projection: "A", AccessLevel: "Full", PermSetGrantingProj: "PS1" }], "@odata.nextLink": "https://h/main/x?$skip=1" }
      : { value: [{ Projection: "B" }] };
  } };
  const rows = await userProjections(client, { UsersGrantedProjection: "UsersGrantedProjections" }, "O'NEIL");
  assert.match(paths[0], /GrantedUser eq 'O''NEIL'/);
  assert.equal(paths[1], "/main/x?$skip=1");
  assert.deepEqual(rows, [{ projection: "A", level: "Full", via: "PS1", grantingSet: "PS1", userSet: null }, { projection: "B", level: undefined, via: null, grantingSet: null, userSet: null }]);
});

test("applyChanges runs grant, revoke and assign in order and stops at the first failure", async () => {
  const { applyChanges } = require("./ifs-permissions.js");
  const calls = [];
  const client = { post: async (path, body) => { calls.push([path.split("/").pop(), body]); if (body.Role === "BAD") throw new Error("nope"); } };
  const changes = [
    { type: "grant", projection: "P1", role: "R1" },
    { type: "revoke", projection: "P2", role: "R2" },
    { type: "assign", user: "U", role: "BAD" },
    { type: "grant", projection: "P3", role: "R3" }
  ];
  const { results } = await applyChanges(client, { UserGrant: "UserGrants" }, changes);
  assert.deepEqual(calls.map((c) => c[0]), ["GrantProjections", "RevokeProjection", "UserGrants"]);
  assert.deepEqual(calls[1][1], { Role: "R2", Projection: "P2" });
  assert.deepEqual(calls[2][1], { Identity: "U", Role: "BAD" });
  assert.deepEqual(results.map((r) => r.ok), [true, true, false]);
});
