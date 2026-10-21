const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const jsyaml = require("../lib/vendor/js-yaml.min.js");
const { buildModel } = require("./spec-model.js");
const { createTypeRegistry, toIdentifier, fieldLabel } = require("./flow-types.js");

const petstore = () => buildModel(jsyaml.load(fs.readFileSync(path.join(__dirname, "fixtures", "swagger-petstore-oas3.yaml"), "utf8")));
const modelOf = (schemas) => buildModel({ openapi: "3.0.0", paths: {}, components: { schemas } });
const decl = (registry, name) => registry.declarations().find((d) => d.name === name).text;

test("toIdentifier and fieldLabel keep names usable in Flowscript", () => {
  assert.equal(toIdentifier("in-progress"), "in_progress");
  assert.equal(toIdentifier("1st"), "_1st");
  assert.equal(toIdentifier("select"), "select_");
  assert.equal(toIdentifier(""), "_empty");
  assert.equal(toIdentifier("__meta"), "meta");
  assert.equal(fieldLabel("name"), "name");
  assert.equal(fieldLabel("first-name"), '"first-name"');
  assert.equal(fieldLabel("@type"), '"@type"');
  assert.equal(fieldLabel("type"), '"type"');
});

test("scalar mapping", () => {
  const r = createTypeRegistry(modelOf({}));
  assert.equal(r.typeOf({ type: "string" }), "text");
  assert.equal(r.typeOf({ type: "string", format: "date-time" }), "datetime");
  assert.equal(r.typeOf({ type: "string", format: "date" }), "datetime");
  assert.equal(r.typeOf({ type: "string", format: "byte" }), "text");
  assert.equal(r.typeOf({ type: "string", format: "binary" }), "binary");
  assert.equal(r.typeOf({ type: "integer", format: "int64" }), "number");
  assert.equal(r.typeOf({ type: "number" }), "number");
  assert.equal(r.typeOf({ type: "boolean" }), "boolean");
  assert.equal(r.typeOf({ type: ["string", "null"] }), "text");
  assert.equal(r.typeOf({ type: "array", items: { type: "integer" } }), "number*");
  assert.equal(r.typeOf({ type: "object", additionalProperties: { type: "integer" } }), "{}");
  assert.equal(r.typeOf({}), "any");
  assert.equal(r.typeOf({ oneOf: [{ type: "string" }, { type: "integer" }] }, "X"), "any");
  assert.match(r.warnings()[0], /oneOf\/anyOf/);
});

test("the Petstore Pet becomes a row type with an enum module, nested records and a record mapper", () => {
  const r = createTypeRegistry(petstore(), { namespace: "SwaggerPetstore" });
  assert.equal(r.typeOf({ $ref: "#/components/schemas/Pet" }), "Pet");
  assert.equal(decl(r, "Pet"), [
    "type Pet = {",
    "\tid: number? = null,",
    "\tname: text,",
    "\tcategory: Category,",
    "\tphotoUrls: text*,",
    "\ttags: Tag*,",
    "\tstatus: Pet_status.Value,",
    "}"
  ].join("\n"));
  assert.equal(decl(r, "Pet_status"), [
    "module Pet_status {",
    "    type Namespace = 'SwaggerPetstore.Pet_status'",
    "    type available = Enum<Namespace, 'available'>;",
    "    type pending = Enum<Namespace, 'pending'>;",
    "    type sold = Enum<Namespace, 'sold'>;",
    "",
    "    type Value = available | pending | sold;",
    "    let values: Value* = [available, pending, sold];",
    "",
    "    let fromText = memoize(fromTextFunction(values, 'Pet_status', _) >> unsafeCast<Value>);",
    "};"
  ].join("\n"));
  assert.equal(r.recordMapperName("Pet"), "recordMapperForPet");
  assert.equal(r.recordMapperName("Category"), null);
  assert.deepEqual(r.mapperDeclarations(), [[
    "private let enumMappingsForPet = [",
    "    enumMapping('status', Pet_status.fromText),",
    "];",
    "private let recordMapperForPet = recordMappingFunction(enumMappingsForPet);"
  ].join("\n")]);
});

test("request variants mark optional fields and drop readOnly ones", () => {
  const r = createTypeRegistry(modelOf({
    Thing: { type: "object", required: ["name"], properties: { id: { type: "integer", readOnly: true }, name: { type: "string" }, note: { type: "string" }, secret: { type: "string", writeOnly: true } } }
  }));
  assert.equal(r.typeOf({ $ref: "#/components/schemas/Thing" }, "x", "request"), "ThingRequest");
  assert.equal(decl(r, "ThingRequest"), "type ThingRequest = {\n\tname: text,\n\toptional note: text,\n\toptional secret: text,\n}");
  assert.equal(r.typeOf({ $ref: "#/components/schemas/Thing" }), "Thing");
  assert.equal(decl(r, "Thing"), "type Thing = {\n\tid: number? = null,\n\tname: text,\n\tnote: text? = null,\n}");
});

test("allOf merges, recursion terminates, odd names and enum values are sanitized", () => {
  const r = createTypeRegistry(modelOf({
    Base: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    Node: { allOf: [{ $ref: "#/components/schemas/Base" }, { type: "object", properties: { children: { type: "array", items: { $ref: "#/components/schemas/Node" } }, "first-name": { type: "string" }, state: { type: "string", enum: ["in-progress", "Done", "done", "Value"] } } }] },
    text: { type: "object", properties: { a: { type: "string" } } }
  }));
  assert.equal(r.typeOf({ $ref: "#/components/schemas/Node" }), "Node");
  assert.equal(decl(r, "Node"), [
    "type Node = {",
    "\tid: text,",
    "\tchildren: Node*,",
    '\t"first-name": text? = null,',
    "\tstate: Node_state.Value,",
    "}"
  ].join("\n"));
  assert.match(decl(r, "Node_state"), /type in_progress = Enum<Namespace, 'in-progress'>;\n    type Done = Enum<Namespace, 'Done'>;\n    type done_2 = Enum<Namespace, 'done'>;\n    type Value_2 = Enum<Namespace, 'Value'>;/);
  assert.equal(r.recordMapperName("Node"), "recordMapperForNode");
  assert.match(r.mapperDeclarations()[0], /enumMapping\('state', Node_state\.fromText\)/);
  assert.doesNotMatch(r.mapperDeclarations()[0], /children/);
  assert.equal(r.typeOf({ $ref: "#/components/schemas/text" }), "text_");
});

test("a nested record with enums is mapped through its own mapper, sequences through Seq.map", () => {
  const r = createTypeRegistry(modelOf({
    Purchase: { type: "object", properties: { lines: { type: "array", items: { $ref: "#/components/schemas/Line" } }, flags: { type: "array", items: { type: "string", enum: ["a", "b"] } } } },
    Line: { type: "object", properties: { kind: { type: "string", enum: ["x", "y"] } } }
  }));
  assert.equal(r.typeOf({ $ref: "#/components/schemas/Purchase" }), "Purchase");
  assert.equal(r.recordMapperName("Purchase"), "recordMapperForPurchase");
  const decls = r.mapperDeclarations();
  assert.equal(decls.length, 2);
  assert.match(decls[0], /recordMapperForLine/);
  assert.match(decls[1], /enumMapping\('lines', Seq\.map\(_, \(r => Record\.mapValues\(r, recordMapperForLine\)\)\)\)/);
  assert.match(decls[1], /enumMapping\('flags', Seq\.map\(_, Purchase_flags\.fromText\)\)/);
  assert.equal(r.responseMapping("Purchase*"), "Seq.map(_, (r => Record.mapValues(r, recordMapperForPurchase)))");
  assert.equal(r.typeOf({ type: "object", properties: { a: { type: "string" } } }, "order"), "order_"); // keywords are never type names
  assert.equal(r.typeOf({ type: "object", properties: { a: { type: "string" } } }, "Order"), "Order"); // ...but they are case-sensitive
  assert.equal(r.responseMapping("text"), null);
});
