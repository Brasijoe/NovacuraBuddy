const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const jsyaml = require("../lib/vendor/js-yaml.min.js");
const { buildModel, listShape, basePathFromServers, nameFromPath } = require("./spec-model.js");

const load = (name) => jsyaml.load(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));

test("basePathFromServers keeps only the path, with server variables filled in", () => {
  assert.equal(basePathFromServers([{ url: "https://petstore3.swagger.io/api/v3" }]), "api/v3");
  assert.equal(basePathFromServers([{ url: "/api/v3/" }]), "api/v3");
  assert.equal(basePathFromServers([{ url: "https://x.test" }]), "");
  assert.equal(basePathFromServers([{ url: "https://{host}/{ver}/rest", variables: { host: { default: "a.test" }, ver: { default: "v2" } } }]), "v2/rest");
  assert.equal(basePathFromServers([]), "");
  assert.equal(basePathFromServers(undefined), "");
});

test("nameFromPath builds a name for operations without operationId", () => {
  assert.equal(nameFromPath("get", "/pets/{petId}/photos"), "getPetsByPetIdPhotos");
  assert.equal(nameFromPath("delete", "/store/order-items/{order_id}"), "deleteStoreOrderItemsByOrderId");
});

test("buildModel lists the Swagger Petstore's operations with params, body and response", () => {
  const model = buildModel(load("swagger-petstore-oas3.yaml"));
  assert.equal(model.title, "Swagger Petstore - OpenAPI 3.0");
  assert.equal(model.basePath, "api/v3");
  assert.deepEqual(model.tags, ["pet", "store", "user"]);
  assert.equal(model.operations.length, 19);

  const find = model.operations.find((o) => o.id === "findPetsByStatus");
  assert.equal(find.method, "get");
  assert.deepEqual(find.params.map((p) => [p.name, p.in, p.required]), [["status", "query", true]]);
  assert.equal(find.response.status, "200");
  assert.equal(find.response.contentType, "application/json");

  const add = model.operations.find((o) => o.id === "addPet");
  assert.equal(add.body.contentType, "application/json");
  assert.equal(add.body.schema.$ref, "#/components/schemas/Pet");

  const del = model.operations.find((o) => o.id === "deletePet");
  assert.deepEqual(del.params.map((p) => [p.name, p.in]), [["api_key", "header"], ["petId", "path"]]);
  assert.equal(model.warnings.length, 0);
});

test("path-level parameters merge in, operation-level ones win, and auth headers are dropped", () => {
  const model = buildModel({
    openapi: "3.0.0", info: { title: "t", version: "1" },
    components: { parameters: { Id: { name: "id", in: "path", required: true, schema: { type: "integer" } } } },
    paths: { "/things/{id}": {
      parameters: [{ $ref: "#/components/parameters/Id" }, { name: "lang", in: "query", schema: { type: "string" } }],
      get: { parameters: [{ name: "lang", in: "query", required: true, schema: { type: "string", enum: ["de", "en"] } }, { name: "Authorization", in: "header", schema: { type: "string" } }], responses: { 204: { description: "x" } } }
    } }
  });
  const op = model.operations[0];
  assert.equal(op.id, "getThingsById");
  assert.deepEqual(op.params.map((p) => [p.name, p.required]), [["id", true], ["lang", true]]);
  assert.deepEqual(op.params[1].schema.enum, ["de", "en"]);
  assert.deepEqual(op.response, { status: "204", contentType: null, schema: null });
});

test("duplicate operation names get a numeric suffix; external refs are warned about", () => {
  const model = buildModel({
    openapi: "3.1.0", info: { title: "t", version: "1" },
    paths: {
      "/a": { get: { operationId: "list", responses: { 200: { description: "", content: { "application/json": { schema: { $ref: "other.yaml#/X" } } } } } } },
      "/b": { get: { operationId: "List", responses: {} } }
    }
  });
  assert.deepEqual(model.operations.map((o) => o.id), ["list", "List_2"]);
  assert.equal(model.resolveRef("other.yaml#/X").constructor, Object);
  assert.match(model.warnings[0], /External reference other\.yaml#\/X/);
});

test("listShape recognises bare arrays and the usual wrapper objects", () => {
  const { deref } = buildModel({ openapi: "3.0.0", paths: {}, components: { schemas: { Pets: { type: "array", items: { $ref: "#/components/schemas/Pet" } } } } });
  assert.deepEqual(listShape({ $ref: "#/components/schemas/Pets" }, deref), { wrapper: null, item: { $ref: "#/components/schemas/Pet" } });
  assert.deepEqual(listShape({ type: "object", properties: { total: { type: "integer" }, data: { type: "array", items: { type: "string" } }, links: { type: "array", items: {} } } }, deref).wrapper, "data");
  assert.equal(listShape({ type: "object", properties: { pets: { type: "array", items: {} } } }, deref).wrapper, "pets");
  assert.equal(listShape({ type: "object", properties: { a: { type: "array" }, b: { type: "array" } } }, deref), null);
  assert.equal(listShape({ type: "object", properties: { id: { type: "integer" } } }, deref), null);
  assert.equal(listShape(null, deref), null);
});
