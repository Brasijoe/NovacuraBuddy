const test = require("node:test");
const assert = require("node:assert/strict");
const { parseConnectProperties, columnToAttributeName } = require("./flow-properties.js");

const sample = [
  { Name: "SOME_PATH", Type: "Text", Scope: "Global", Value: "\\\\server\\share" },
  { Name: "IntegCredentials", Type: "Table", Scope: "Global", Columns: ["Integration", "UserName", "API Endpoint"], TableValues: "[{'Integration': 'X', 'UserName': 'u', 'API Endpoint': 'https://example.com'}]" },
  { Name: "EmptyTable", Type: "Table", Scope: "Global", Columns: [], TableValues: "[]" },
  { Name: "NoColumns", Type: "Table", Scope: "Global" },
  null
];

test("Table properties become String-attribute LUs; TableValues is never used", () => {
  const lus = parseConnectProperties(JSON.stringify(sample));
  assert.deepEqual(lus, [{
    source: "IntegCredentials",
    name: "IntegCredentials",
    prompt: "IntegCredentials",
    attributes: [
      { name: "INTEGRATION", prompt: "Integration", type: "STRING", length: 100 },
      { name: "USERNAME", prompt: "UserName", type: "STRING", length: 100 },
      { name: "API_ENDPOINT", prompt: "API Endpoint", type: "STRING", length: 100 }
    ]
  }]);
  assert.equal(JSON.stringify(lus).includes("example.com"), false);
});

test("a UTF-8 BOM is accepted", () => {
  assert.equal(parseConnectProperties("﻿" + JSON.stringify(sample)).length, 1);
});

test("columnToAttributeName makes IFS-safe names", () => {
  assert.equal(columnToAttributeName(" API Endpoint "), "API_ENDPOINT");
  assert.equal(columnToAttributeName("a-b.c"), "A_B_C");
  assert.equal(columnToAttributeName("__x__"), "X");
});

test("bad input gives a plain error, never an empty list", () => {
  assert.throws(() => parseConnectProperties("{nope"), /^Error: File is not valid JSON\.$/);
  assert.throws(() => parseConnectProperties('{"Name":"x"}'), /^Error: Expected a JSON array of Flow properties\.$/);
  assert.throws(() => parseConnectProperties(JSON.stringify([{ Name: "t", Type: "Text" }])), /^Error: No Table-type properties found in this file\.$/);
});
