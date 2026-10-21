const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const jsyaml = require("../lib/vendor/js-yaml.min.js");
const { parseSpecText, detectSpecVersion, findSpecUrlInHtml } = require("./spec-load.js");

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

test("parseSpecText reads JSON (with a BOM) and YAML", () => {
  assert.equal(parseSpecText("﻿{\"swagger\":\"2.0\"}", jsyaml).swagger, "2.0");
  const doc = parseSpecText(fixture("oas3-petstore.yaml"), jsyaml);
  assert.equal(doc.openapi, "3.0.0");
  assert.equal(doc.info.title, "Swagger Petstore");
});

test("parseSpecText explains empty input, broken JSON and HTML pages", () => {
  assert.throws(() => parseSpecText("  ", jsyaml), /empty/);
  assert.throws(() => parseSpecText("{ nope", jsyaml), /looks like JSON/);
  assert.throws(() => parseSpecText("<!doctype html><html></html>", jsyaml), /HTML page/);
  assert.throws(() => parseSpecText("just a sentence", jsyaml), /not a JSON\/YAML object/);
});

test("detectSpecVersion accepts OpenAPI 3.0/3.1 and Swagger 2.0 only", () => {
  assert.deepEqual(detectSpecVersion({ openapi: "3.0.3" }), { kind: "oas3", version: "3.0.3" });
  assert.deepEqual(detectSpecVersion({ openapi: "3.1.0" }), { kind: "oas3", version: "3.1.0" });
  assert.deepEqual(detectSpecVersion({ swagger: "2.0" }), { kind: "swagger2", version: "2.0" });
  assert.throws(() => detectSpecVersion({ openapi: "4.0.0" }), /4\.0\.0 is not supported/);
  assert.throws(() => detectSpecVersion({ swagger: "1.2" }), /1\.2 is not supported/);
  assert.throws(() => detectSpecVersion({ info: { name: "x" }, item: [] }), /Postman/);
  assert.throws(() => detectSpecVersion({ foo: 1 }), /not an OpenAPI/);
});

test("findSpecUrlInHtml finds the spec behind Swagger UI, Redoc and RapiDoc pages", () => {
  const page = "https://api.example.com/docs/index.html";
  assert.equal(
    findSpecUrlInHtml(`<script>const ui = SwaggerUIBundle({ dom_id: '#swagger-ui', url: "/v2/swagger.json", presets: [] })</script>`, page),
    "https://api.example.com/v2/swagger.json"
  );
  assert.equal(
    findSpecUrlInHtml(`SwaggerUIBundle({ urls: [{ name: "v1", url: "openapi/v1.yaml" }] })`, page),
    "https://api.example.com/docs/openapi/v1.yaml"
  );
  assert.equal(findSpecUrlInHtml(`<redoc spec-url='https://x.test/openapi.json'></redoc>`, page), "https://x.test/openapi.json");
  assert.equal(findSpecUrlInHtml(`<rapi-doc spec-url="/spec.yaml">`, page), "https://api.example.com/spec.yaml");
  assert.equal(findSpecUrlInHtml("<html>nothing here</html>", "https://p.test/ui/?url=/api/openapi.json"), "https://p.test/api/openapi.json");
  assert.equal(findSpecUrlInHtml("<html>nothing here</html>", page), null);
});
