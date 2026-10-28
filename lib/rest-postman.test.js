const test = require("node:test");
const assert = require("node:assert/strict");
const RP = require("./rest-postman.js");

// The two REST steps of the "Invoice Automation 2" export (bodies shortened).
const post = {
  type: "rest-call", urlExpression: "openai/v1/chat/completions", method: "post",
  headers: [{ include: true, name: "Content-Type", valueTemplate: "application/json" }, { include: false, name: "X-Off", valueTemplate: "x" }],
  bodyType: "jsonSerialized",
  bodyExpression: '{\n  "model": "gpt-4o",\n"messages": [ { "role": "system", "content": PromptRec.systemContent }, { "role": "user", "content": PromptRec.userContent } ], "n": Count, "stream": false\n}',
  connector: { id: "a21b", name: "Azure OpenAI", type: "Http.Rest" }
};
const get = { type: "rest-call", urlExpression: "{AnalyzeUrl}", method: "get", headers: [], bodyType: "textFromVariable", bodyExpression: "", connector: { id: "de3c", name: "Azure Cognitive Services", type: "Http.Rest" } };
const values = { PromptRec__systemContent: '"You are \\"helpful\\""', PromptRec__userContent: '"Rows?"', Count: "2", AnalyzeUrl: '"https://x.example/analyze/1"' };

test("literals", () => {
  assert.equal(RP.fromLiteral('"a \\"b\\""'), 'a "b"');
  assert.equal(RP.fromLiteral("12"), 12);
  assert.equal(RP.fromLiteral("null"), null);
  assert.equal(RP.fromLiteral("true"), true);
});

test("a jsonSerialized body gets the variables as JSON values, strings untouched", () => {
  const item = RP.requestItem("Get Invoice Rows by Prompt", post, values);
  assert.equal(item.request.method, "POST");
  assert.equal(item.request.url.raw, "{{baseUrl_Azure_OpenAI}}/openai/v1/chat/completions");
  assert.deepEqual(item.request.header, [{ key: "Content-Type", value: "application/json", type: "text" }]);
  const body = JSON.parse(item.request.body.raw);
  assert.equal(body.model, "gpt-4o");
  assert.equal(body.messages[0].content, 'You are "helpful"');
  assert.equal(body.n, 2);
  assert.equal(body.stream, false);
  assert.equal(item.request.body.options.raw.language, "json");
});

test("a URL template from a variable, no body", () => {
  const item = RP.requestItem("Get Analyze Result", get, values);
  assert.equal(item.request.url.raw, "https://x.example/analyze/1");
  assert.equal(item.request.body, undefined);
});

test("unknown variables become Postman variables and are declared", () => {
  const c = RP.buildCollection("Flow", [{ label: "A", command: { ...post, bodyExpression: '{ "a": Missing.field }', urlExpression: "orders/{Id}" } }], {});
  assert.equal(JSON.parse(c.item[0].request.body.raw).a, "{{Missing_field}}");
  assert.equal(c.item[0].request.url.raw, "{{baseUrl_Azure_OpenAI}}/orders/{{Id}}");
  assert.deepEqual(c.variable.map((v) => v.key).sort(), ["Id", "Missing_field", "baseUrl_Azure_OpenAI"]);
  assert.match(c.info.schema, /v2\.1\.0/);
});

test("textFromVariable sends the variable's text", () => {
  const b = RP.requestBody({ bodyType: "textFromVariable", bodyExpression: "Payload" }, (p) => (p === "Payload" ? { found: true, value: '{"x":1}' } : { found: false }));
  assert.deepEqual(b, { text: '{"x":1}', json: true });
});

const logged = "Type: GET\nUrl: https://z103.example.com/main/svc/Set?$filter=Contract eq '2002' and LocationNo eq 'VAN54900'&$select=PartNo,UoM\nSent: 28.10.2026 13:36:55 +01:00\nHeaders: \n\tContent-Type:application/json\n\tAuthorization:Bearer *****\n\nBody: -\n";

test("a logged GET request becomes a Postman request, masked token as variable", () => {
  const req = RP.parseLoggedRequest(logged);
  assert.equal(req.method, "GET");
  assert.equal(req.url, "https://z103.example.com/main/svc/Set?$filter=Contract eq '2002' and LocationNo eq 'VAN54900'&$select=PartNo,UoM");
  assert.deepEqual(req.headers, [{ name: "Content-Type", value: "application/json" }, { name: "Authorization", value: "Bearer *****" }]);
  assert.equal(req.body, null);
  const c = RP.collectionFromLog("GET Set", req);
  assert.equal(c.item[0].request.header[1].value, "Bearer {{token}}");
  assert.deepEqual(c.variable, [{ key: "token", value: "" }]);
  assert.equal(c.item[0].request.body, undefined);
});

test("a logged POST body (JSON, several lines) is kept", () => {
  const req = RP.parseLoggedRequest('Type: POST\nUrl: https://x/y\nHeaders: \n\tContent-Type:application/json\n\nBody: {"TaskSeq": 5,\n "a": "b"}\n');
  const c = RP.collectionFromLog("POST y", req);
  assert.equal(c.item[0].request.method, "POST");
  assert.deepEqual(JSON.parse(c.item[0].request.body.raw), { TaskSeq: 5, a: "b" });
});
