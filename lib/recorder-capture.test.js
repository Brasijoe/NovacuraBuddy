const test = require("node:test");
const assert = require("node:assert/strict");
const { isRecorderMessage, unmatchedHostsInCalls, truncate } = require("./recorder-capture.js");

test("isRecorderMessage claims exactly the recorder's message types", () => {
  for (const t of ["START_RECORDING", "STOP_RECORDING", "GET_STATUS", "OPEN_VIEWER"]) assert.equal(isRecorderMessage(t), true);
  for (const t of ["GET_FLOW_TOKEN", "GET_TRACKED", "CREATE_MODULE", undefined]) assert.equal(isRecorderMessage(t), false);
});

test("unmatchedHostsInCalls lists IFS hosts without an instance, once each", () => {
  const calls = [
    { url: "https://known.example.com/main/ifsapplications/projection/v1/A.svc/X" },
    { url: "https://new.example.com/main/ifsapplications/projection/v1/B.svc/Y" },
    { url: "https://new.example.com/main/ifsapplications/projection/v1/C.svc/Z" },
    { url: "https://cdn.example.com/script.js" }
  ];
  const instances = [{ baseUrl: "https://known.example.com", name: "K" }];
  assert.deepEqual(unmatchedHostsInCalls(calls, instances), ["new.example.com"]);
});

test("truncate caps very large bodies", () => {
  assert.equal(truncate(null), null);
  assert.ok(truncate("x".repeat(2000000)).length < 2000000);
});
