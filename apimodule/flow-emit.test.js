const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const jsyaml = require("../lib/vendor/js-yaml.min.js");
const { buildModel } = require("./spec-model.js");
const { convertSwagger2 } = require("./swagger2-to-oas3.js");
const { generateModule, queryableIds, pathExpr } = require("./flow-emit.js");

const fixturePath = (name) => path.join(__dirname, "fixtures", name);
const load = (name) => jsyaml.load(fs.readFileSync(fixturePath(name), "utf8"));
const NOW = new Date("2026-10-21T12:00:00Z");
const opts = { moduleName: "SwaggerPetstore", source: "https://petstore3.swagger.io/api/v3/openapi.json", specVersion: "OpenAPI 3.0.4", now: NOW, generatorVersion: "0.3.0" };

/** Brackets balance once strings and comments are removed: catches emitter typos the Node
 *  tests can't otherwise see (the Flowscript itself can only be compiled in the Designer). */
function assertBalanced(code) {
  let stripped = "";
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    const next = code[i + 1];
    if (c === "/" && next === "*") { i = code.indexOf("*/", i + 2) + 1; continue; }
    if (c === "/" && next === "/") { i = code.indexOf("\n", i); if (i < 0) break; continue; }
    if (c === "@" && next === "\"") { i = code.indexOf("\"", i + 2); continue; }
    if (c === "'" || c === "\"") {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += code[j] === "\\" ? 2 : 1;
      i = j;
      continue;
    }
    if (c === "`") {
      // keep the {interpolations} of a template, drop its text
      let j = i + 1;
      while (j < code.length && code[j] !== "`") {
        if (code[j] === "{") {
          let depth = 1;
          let k = j + 1;
          for (; k < code.length && depth; k++) depth += code[k] === "{" ? 1 : code[k] === "}" ? -1 : 0;
          stripped += "(" + code.slice(j + 1, k - 1) + ")";
          j = k;
        } else j++;
      }
      i = j;
      continue;
    }
    stripped += c;
  }
  const pairs = { ")": "(", "]": "[", "}": "{" };
  const stack = [];
  for (const [n, c] of [...stripped].entries()) {
    if ("([{".includes(c)) stack.push(c);
    else if (pairs[c]) assert.equal(stack.pop(), pairs[c], `unbalanced ${c} near: ${stripped.slice(Math.max(0, n - 80), n + 1)}`);
  }
  assert.deepEqual(stack, [], "unclosed brackets");
}

test("Swagger Petstore module matches the reviewed golden file", () => {
  const result = generateModule(buildModel(load("swagger-petstore-oas3.yaml")), opts);
  const goldenFile = fixturePath("swagger-petstore-oas3.flowscript");
  if (process.env.UPDATE_GOLDEN) fs.writeFileSync(goldenFile, result.code);
  assert.equal(result.code, fs.readFileSync(goldenFile, "utf8"));
  assert.deepEqual(result.warnings, []);
  assert.equal(result.functionCount, 19);
  assert.equal(result.queryableCount, 2);
  assertBalanced(result.code);
});

test("every fixture generates bracket-balanced code", () => {
  for (const name of ["oas3-petstore.yaml", "oas3-petstore-expanded.yaml"]) assertBalanced(generateModule(buildModel(load(name)), opts).code);
  const swagger2 = JSON.parse(fs.readFileSync(fixturePath("swagger2-petstore-expanded.json"), "utf8"));
  assertBalanced(generateModule(buildModel(convertSwagger2(swagger2)), opts).code);
});

test("a list GET without required params becomes a `let` Queryable whose optional query params can be sent from `where`", () => {
  const { code } = generateModule(buildModel(load("oas3-petstore-expanded.yaml")), opts);
  assert.match(code, /let basePath = 'api';/);
  assert.match(code, /let FindPetsSet = Queryable\.Create<RestQueryTranslation, Pet, text>\(restTranslation\(\), getFindPetsSetRows\);/);
  assert.match(code, /let params = restParams\(filter, \['tags', 'limit'\]\);/);
  assert.match(code, /GetResponse\(`\/pets\{restQueryString\(params\)\}`, \[\]\)/);
  assert.match(code, /return restShape\(restKeep\(raw, filter, \['tags', 'limit'\]\), q, identity\);/);
  // the plain function stays too
  assert.match(code, /function findPets\(tags: text\* = \[\], limit: number\? = null, headers: Header\* = \[\]\): Pet\* \{/);
});

test("required path/query params turn the Queryable into a function; header params are passed through", () => {
  const model = buildModel({
    openapi: "3.0.0", info: { title: "Shop API", version: "2" }, servers: [{ url: "https://shop.test" }],
    paths: { "/owners/{ownerId}/orders": { get: {
      operationId: "listOrders",
      parameters: [
        { name: "ownerId", in: "path", required: true, schema: { type: "integer" } },
        { name: "since", in: "query", required: true, schema: { type: "string", format: "date" } },
        { name: "state", in: "query", schema: { type: "string", enum: ["open", "done"] } },
        { name: "X-Tenant", in: "header", required: true, schema: { type: "string" } }
      ],
      responses: { 200: { description: "", content: { "application/json": { schema: { type: "object", properties: { total: { type: "integer" }, items: { type: "array", items: { $ref: "#/components/schemas/Order" } } } } } } } }
    } } },
    components: { schemas: { Order: { type: "object", properties: { id: { type: "integer" }, state: { type: "string", enum: ["open", "done"] } } } } }
  });
  const { code, moduleName } = generateModule(model, { now: NOW });
  assert.equal(moduleName, "Shop_API");
  assert.match(code, /let basePath = '';/);
  assert.match(code, /private function getListOrdersSetRows\(ownerId: number, since: text, X_Tenant: text, headers: Header\*, q: Queryable\.QuerySpec<text>\): \{\}\* \{/);
  assert.match(code, /unsafeCast<\{\}\*>\(Record\.getValue\(JSON\.deserialize<\{\}>\(GetResponse\(`\/owners\/\{restPath\(ownerId\)\}\/orders\{restQueryString\(\[new RestParam \{ name: 'since', value: restText\(since\) \}\] & params\)\}`, MergeHeaders\(restHeaders\(\[\{ Name: 'X-Tenant', Value: restText\(X_Tenant\) \}\]\), headers\)\)\), 'items', \[\]\)\)/);
  assert.match(code, /function ListOrdersSet\(ownerId: number, since: text, X_Tenant: text, headers: Header\* = \[\]\) \{\n    return Queryable\.Create<RestQueryTranslation, Order, text>\(restTranslation\(\), getListOrdersSetRows\(ownerId, since, X_Tenant, headers, _\)\);/);
  assert.match(code, /restParams\(filter, \['state'\]\)/);
  assert.match(code, /r => Record\.mapValues\(r, recordMapperForOrder\)/);
  assertBalanced(code);
});

test("only selected operations, and the types they reach, are emitted", () => {
  const model = buildModel(load("swagger-petstore-oas3.yaml"));
  const { code, functionCount } = generateModule(model, { ...opts, selectedIds: ["getUserByName", "deleteUser"] });
  assert.equal(functionCount, 2);
  assert.match(code, /function getUserByName\(/);
  assert.doesNotMatch(code, /function addPet|type Pet =|module Pet_status|Data sources/);
  assert.match(code, /type User = \{/);
});

test("form, text and binary bodies send their own Content-Type", () => {
  const model = buildModel({
    openapi: "3.0.0", info: { title: "t", version: "1" },
    paths: {
      "/login": { post: { operationId: "login", requestBody: { content: { "application/x-www-form-urlencoded": { schema: { type: "object", properties: { user: { type: "string" } } } } } }, responses: { 204: { description: "" } } } },
      "/note": { put: { operationId: "putNote", requestBody: { content: { "text/plain": { schema: { type: "string" } } } }, responses: {} } },
      "/file": { post: { operationId: "upload", requestBody: { content: { "application/pdf": { schema: { type: "string", format: "binary" } } } }, responses: {} } }
    }
  });
  const { code } = generateModule(model, { now: NOW });
  assert.match(code, /function login\(input: login_InputRequest, headers: Header\* = \[\]\): text \{\n    return PostResponse\(`\/login`, restFormBody\(input\), MergeHeaders\(\[\{ Name: 'Content-Type', Value: 'application\/x-www-form-urlencoded' \}\], headers\)\);/);
  assert.match(code, /function putNote\(body: text, headers: Header\* = \[\]\): text \{\n    return PutResponse\(`\/note`, body, MergeHeaders\(\[\{ Name: 'Content-Type', Value: 'text\/plain' \}\], headers\)\);/);
  assert.match(code, /function upload\(body: binary, headers: Header\* = \[\]\) \{\n    return PostResponseBinary\(`\/file`, body, MergeHeaders\(\[\{ Name: 'Content-Type', Value: 'application\/pdf' \}\], headers\)\);/);
});

test("csv arrays join into one parameter, exploded arrays repeat it", () => {
  const swagger2 = JSON.parse(fs.readFileSync(fixturePath("swagger2-petstore-expanded.json"), "utf8"));
  const { code } = generateModule(buildModel(convertSwagger2(swagger2)), opts);
  assert.match(code, /\(case when tags\.any\(\) then \[new RestParam \{ name: 'tags', value: tags\.map\(restText\)\.join\(','\) \}\] else \[\] end\)/);
  const exploded = generateModule(buildModel(load("oas3-petstore-expanded.yaml")), opts).code;
  assert.match(exploded, /tags\.map\(v => new RestParam \{ name: 'tags', value: restText\(v\) \}\)\.eval\(\)/);
});

test("queryableIds marks list GETs of records only", () => {
  assert.deepEqual(queryableIds(buildModel(load("swagger-petstore-oas3.yaml"))), ["findPetsByStatus", "findPetsByTags"]);
  assert.deepEqual(queryableIds(buildModel(load("oas3-petstore.yaml"))), ["listPets"]);
});

test("pathExpr URL-encodes each path parameter", () => {
  assert.equal(pathExpr("/a/{id}/b/{x-y}", new Map([["id", "id"], ["x-y", "x_y"]])), "/a/{restPath(id)}/b/{restPath(x_y)}");
});
