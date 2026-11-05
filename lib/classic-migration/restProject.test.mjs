import test from "node:test";
import assert from "node:assert/strict";
import { parseXml } from "./migration/xmlLite.js";
import { decodeRestProject } from "./migration/classicRestProjectDecoder.js";

const op = (name) => `<Operation z:Id="${name}"><DisplayName>${name}</DisplayName><HttpMethod>GET</HttpMethod><Id>${name}</Id><Output z:Id="o${name}"><OutputParameters/></Output></Operation>`;

test("operations inside (nested) OperationContainers are found, not only root-level ones", () => {
  const xml = `<ConnectorProject z:Id="i1" xmlns="http://novacura.se/connector/rest/1.1" xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns:z="http://schemas.microsoft.com/2003/10/Serialization/">
    <ConnectorId>RestServiceConnector</ConnectorId><ConnectorName>D3</ConnectorName>
    <Containers>
      <OperationContainer z:Id="c1"><Containers><OperationContainer z:Id="c2"><Containers/><Operations>${op("Inner")}</Operations></OperationContainer></Containers><Operations>${op("A")}${op("B")}</Operations></OperationContainer>
    </Containers>
  </ConnectorProject>`;
  const project = decodeRestProject(parseXml(xml));
  assert.deepEqual(project.operations.map((o) => o.displayName).sort(), ["A", "B", "Inner"]);
});

test("root-level operations still work", () => {
  const xml = `<ConnectorProject z:Id="i1" xmlns="http://novacura.se/connector/rest/1.1" xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns:z="http://schemas.microsoft.com/2003/10/Serialization/"><ConnectorName>X</ConnectorName><Operations>${op("Solo")}</Operations></ConnectorProject>`;
  assert.deepEqual(decodeRestProject(parseXml(xml)).operations.map((o) => o.displayName), ["Solo"]);
});
