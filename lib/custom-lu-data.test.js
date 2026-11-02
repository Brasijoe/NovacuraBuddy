const test = require("node:test");
const assert = require("node:assert/strict");
const { insertRows, readLayout, mapRow } = require("./custom-lu-data.js");

const xml = `<Schema><EntityType Name="Aeb"><Property Name="Objkey"/><Property Name="Key"/><Property Name="TypeName"/></EntityType>
<EntityContainer><EntitySet Name="AebSet" EntityType="X.Aeb"/></EntityContainer></Schema>`;

test("layout and row mapping use the projection's own names", () => {
  const layout = readLayout(xml, "Aeb");
  assert.equal(layout.set, "AebSet");
  assert.deepEqual(mapRow({ KEY: "a", TYPE_NAME: "b", EMPTY: "" }, layout.properties), { Key: "a", TypeName: "b" });
});

test("insertRows posts every row and keeps going after a failed one", async () => {
  const posts = [];
  const client = {
    getText: async () => xml,
    postOData: async (path, body) => { posts.push([path, body]); if (body.Key === "bad") throw new Error("boom"); }
  };
  const res = await insertRows(client, "Aeb", [{ KEY: "a" }, { KEY: "bad" }, { KEY: "c" }]);
  assert.equal(res.inserted, 2);
  assert.equal(res.failed, 1);
  assert.match(res.errors[0], /row 2: boom/);
  assert.equal(posts[0][0], "/main/ifsapplications/projection/v1/CustomProjectionAeb.svc/AebSet");
});

test("an unknown attribute stops the run with one error", async () => {
  const client = { getText: async () => xml, postOData: async () => {} };
  const res = await insertRows(client, "Aeb", [{ NOPE: "x" }, { NOPE: "y" }]);
  assert.equal(res.inserted, 0);
  assert.equal(res.failed, 2);
  assert.equal(res.errors.length, 1);
});

test("a prefixed entity set and prefixed property names still match", () => {
  const x = `<EntityType Name="CustomEntityAeb"><Property Name="CfKey"/></EntityType><EntitySet Name="CustomEntityAebSet" EntityType="X.CustomEntityAeb"/>`;
  const layout = readLayout(x, "Aeb");
  assert.equal(layout.set, "CustomEntityAebSet");
  assert.deepEqual(mapRow({ KEY: "a" }, layout.properties), { CfKey: "a" });
});
