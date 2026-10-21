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
  assert.throws(() => parseConnectProperties(JSON.stringify([{ Name: "t", Type: "Text" }])), /^Error: No Table or User properties found in this file\.$/);
});

test("User-scoped properties merge into one wide UserProperties LU with USER_ID first; values are never read", () => {
  const lus = parseConnectProperties(JSON.stringify([
    { Name: "Site", Type: "Text", Scope: "User", Value: "SECRET1" },
    { Name: "MasterObject", Type: "Text", Scope: "Global", Value: "CH" },
    { Name: "TaskSeq", Type: "Text", Scope: "User", Value: "" },
    { Name: "site", Type: "Text", Scope: "User", Value: "dup" },
    { Name: "MileageTbl", Type: "Table", Scope: "Global", Columns: ["Site"], TableValues: [] }
  ]));
  assert.deepEqual(lus.map((lu) => lu.name), ["MileageTbl", "UserProperties"]);
  assert.deepEqual(lus[1], {
    source: "2 User properties",
    name: "UserProperties",
    prompt: "User Properties",
    attributes: [
      { name: "USER_ID", prompt: "User Id", type: "STRING", length: 100 },
      { name: "SITE", prompt: "Site", type: "STRING", length: 100 },
      { name: "TASKSEQ", prompt: "TaskSeq", type: "STRING", length: 100 }
    ]
  });
  assert.equal(JSON.stringify(lus).includes("SECRET1"), false);
});

test("a file with only User properties still imports", () => {
  const lus = parseConnectProperties(JSON.stringify([{ Name: "Agent", Type: "Text", Scope: "User", Value: "" }]));
  assert.deepEqual(lus.map((lu) => [lu.name, lu.attributes.map((a) => a.name)]), [["UserProperties", ["USER_ID", "AGENT"]]]);
});
