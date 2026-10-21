const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { convertSwagger2 } = require("./swagger2-to-oas3.js");

const petstore = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "swagger2-petstore-expanded.json"), "utf8"));

test("host/basePath/schemes become one server; definitions become components.schemas", () => {
  const oas = convertSwagger2(petstore);
  assert.equal(oas.openapi, "3.0.3");
  assert.deepEqual(oas.servers, [{ url: "http://petstore.swagger.io/api" }]);
  assert.ok(oas.components.schemas.Pet);
  assert.equal(oas.components.schemas.Pet.allOf[0].$ref, "#/components/schemas/NewPet");
});

test("query params nest their schema; csv arrays keep the collection format", () => {
  const op = convertSwagger2(petstore).paths["/pets"].get;
  const tags = op.parameters.find((p) => p.name === "tags");
  assert.deepEqual(tags.schema, { type: "array", items: { type: "string" } });
  assert.equal(tags["x-collectionFormat"], "csv");
  assert.equal(tags.explode, false);
  assert.deepEqual(op.parameters.find((p) => p.name === "limit").schema, { type: "integer", format: "int32" });
});

test("a body parameter becomes requestBody; response schemas move under content", () => {
  const paths = convertSwagger2(petstore).paths;
  const add = paths["/pets"].post;
  assert.equal(add.parameters, undefined);
  assert.equal(add.requestBody.required, true);
  assert.equal(add.requestBody.content["application/json"].schema.$ref, "#/components/schemas/NewPet");
  assert.equal(add.responses["200"].content["application/json"].schema.$ref, "#/components/schemas/Pet");
  assert.equal(paths["/pets/{id}"].delete.responses["204"].content, undefined);
  assert.equal(paths["/pets/{id}"].get.parameters[0].required, true);
});

test("formData fields become a form requestBody; a file field makes it multipart", () => {
  const doc = {
    swagger: "2.0", info: { title: "t", version: "1" }, basePath: "/v1",
    paths: {
      "/upload": { post: { parameters: [
        { name: "note", in: "formData", type: "string", required: true },
        { name: "file", in: "formData", type: "file" }
      ], responses: { 200: { description: "ok" } } } },
      "/login": { post: { consumes: ["application/x-www-form-urlencoded"], parameters: [
        { name: "user", in: "formData", type: "string" }
      ], responses: {} } }
    }
  };
  const oas = convertSwagger2(doc);
  assert.deepEqual(oas.servers, [{ url: "/v1" }]);
  const upload = oas.paths["/upload"].post.requestBody.content["multipart/form-data"].schema;
  assert.deepEqual(upload.required, ["note"]);
  assert.deepEqual(upload.properties.file, { type: "string", format: "binary" });
  assert.ok(oas.paths["/login"].post.requestBody.content["application/x-www-form-urlencoded"]);
});

test("a shared body parameter referenced by $ref still becomes the requestBody", () => {
  const doc = {
    swagger: "2.0", info: { title: "t", version: "1" },
    parameters: { PetBody: { name: "pet", in: "body", required: true, schema: { $ref: "#/definitions/Pet" } }, Limit: { name: "limit", in: "query", type: "integer" } },
    definitions: { Pet: { type: "object" } },
    paths: { "/pets": { post: { parameters: [{ $ref: "#/parameters/PetBody" }, { $ref: "#/parameters/Limit" }], responses: {} } } }
  };
  const oas = convertSwagger2(doc);
  const op = oas.paths["/pets"].post;
  assert.equal(op.requestBody.content["application/json"].schema.$ref, "#/components/schemas/Pet");
  assert.deepEqual(op.parameters, [{ $ref: "#/components/parameters/Limit" }]);
  assert.deepEqual(oas.components.parameters.Limit, { name: "limit", in: "query", required: false, schema: { type: "integer" } });
  assert.equal(oas.components.parameters.PetBody, undefined);
});
