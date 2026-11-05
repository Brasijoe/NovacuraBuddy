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

test("the entity set is always <LU>Set, even next to a Reference_ lookup set", () => {
  const x = `<EntityType Name="ExpenseDomains"><Property Name="Domain"/></EntityType><EntityContainer><EntitySet Name="Reference_ExpenseDomains" EntityType="X.ExpenseDomains"/><EntitySet Name="ExpenseDomainsSet" EntityType="X.ExpenseDomains"/></EntityContainer>`;
  const layout = readLayout(x, "ExpenseDomains");
  assert.equal(layout.set, "ExpenseDomainsSet");
  assert.deepEqual(layout.properties, ["Domain"]);
});

test("attribute DOMAIN maps to the live property Cf_Domain", () => {
  assert.deepEqual(mapRow({ DOMAIN: "example.se" }, ["Objkey", "Cf_Domain"]), { Cf_Domain: "example.se" });
  assert.deepEqual(mapRow({ NAME: "x" }, ["Cf_TypeName", "Cf_Name"]), { Cf_Name: "x" });
});
