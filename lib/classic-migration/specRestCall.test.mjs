import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { buildSpecRestCall, matchSpecOperation, parseTemplate } from "./migration/classicSpecRestCall.js";

const require = createRequire(import.meta.url);
const jsyaml = require("../vendor/js-yaml.min.js");
const { buildModel } = require("../../apimodule/spec-model.js");
const { generateModule } = require("../../apimodule/flow-emit.js");

const model = buildModel(jsyaml.load(fs.readFileSync(new URL("../../apimodule/fixtures/oas3-petstore.yaml", import.meta.url), "utf8")));
const gen = generateModule(model, { moduleName: "SwaggerPetstore" });
const spec = { moduleName: gen.moduleName, code: gen.code, basePath: gen.basePath, signatures: gen.signatures };

const param = (identifier, mappingExpression, mode = "VariableMapping") => ({ identifier, type: "Simple", mode, mappingExpression, value: "", children: [] });
const okOutput = { identifier: "Output", children: [{ identifier: "HttpStatusCode", children: [] }, { identifier: "OK", children: [] }] };
const op = (displayName, inputs, output = okOutput) => ({ displayName, identifier: displayName, methodCallInputs: inputs, output });

test("parseTemplate normalises placeholders and query", () => {
  assert.deepEqual(parseTemplate("/v1/pets/{Id}?limit={Max}"), { key: "/v1/pets/{}", placeholders: ["Id"], query: [{ key: "limit", placeholder: "Max", constant: null }] });
});

test("the .ncrcp method + path picks the spec operation even with a different display name", () => {
  const m = matchSpecOperation(spec, "GetOnePet", null, { httpMethod: "GET", resourcePath: "/v1/pets/{Id}" });
  assert.equal(m.sig.fnName, "showPetById");
});

test("a path param is passed by position from the .ncrcp placeholder, the result keeps .OK", () => {
  const notes = [];
  const built = buildSpecRestCall(spec, op("GetOnePet", [param("parameter_Id", "{PetNo}")]), { httpMethod: "GET", resourcePath: "/v1/pets/{Id}" }, notes);
  assert.ok(built, notes.join("\n"));
  assert.match(built.script, /^open SwaggerPetstore;/);
  assert.match(built.script, /return \{ OK: showPetById\(PetNo\), HttpStatusCode: 200/);
});

test("without a REST project the call is matched by operationId and params by name", () => {
  const notes = [];
  const built = buildSpecRestCall(spec, op("listPets", [param("parameter_limit", "{Max}")]), null, notes);
  assert.match(built.script, /listPets\(Max\)/);
});

test("a Cookie input is sent as a header", () => {
  const notes = [];
  const built = buildSpecRestCall(spec, op("listPets", [param("parameter_Cookie", "{Cookies}")]), null, notes);
  assert.match(built.script, /listPets\(null, \[\{ Name: "Cookie", Value: Cookies \}\]\)/);
});

test("calls that read response headers or have no match stay REST connector calls", () => {
  const notes = [];
  assert.equal(buildSpecRestCall(spec, op("listPets", [], { identifier: "Output", children: [{ identifier: "OperationHeaders", children: [] }] }), null, notes), null);
  assert.equal(buildSpecRestCall(spec, op("Unknown", []), null, notes), null);
  assert.equal(notes.length, 2);
});

test("a missing required path param keeps the REST connector call", () => {
  const notes = [];
  assert.equal(buildSpecRestCall(spec, op("showPetById", []), null, notes), null);
  assert.match(notes[0], /path 'petId'/);
});
