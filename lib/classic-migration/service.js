/* Flow Classic Migration service: the browser port of the Quick Report Deployer's "Migration
 * Helper" (src/main/ipc/migrationIpc.ts). ES module, loaded on demand by panels/classic-migration.js.
 * Decoding and emitting are the original, unchanged modules in this folder; this file replaces the
 * Electron/Node parts (zlib -> DecompressionStream, IPC + SQLite -> plain calls, MSAL -> the
 * Buddy's sniffed Flow session token).
 *
 * Differences from the original, on purpose:
 *  - Flows are SAVED, not committed (Buddy rule: a flow commit from the extension blanks flows;
 *    commit in the Designer or with Commit Dependencies). Modules are still committed.
 *  - No offline WASM validation; the push is verified by reading the saved data back instead.
 */
import { parseZipEntries, getCompressedBytes, METHOD_DEFLATE } from "./migration/zipLite.js";
import { decodeFlowFile, classifyAssetKind, collectAllItems, collectAllItemsWithKeys } from "./migration/classicDecoder.js";
import { buildIncludeDependencyOrder } from "./migration/classicArchive.js";
import { decodeOperationConfig } from "./migration/classicOperationDecoder.js";
import { decodeMethodCallOperation, decodeMethodCallConnectorRef } from "./migration/classicMethodCallDecoder.js";
import { decodeDatabaseCommand, decodeEmailCommand, decodeHtml2PdfCommand } from "./migration/classicConnectorCommandDecoder.js";
import { emitConnectSteps, extractSvcName } from "./migration/classicEmitter.js";
import { decodeRestProject, findRestProjectOperationByDisplayName, buildRestCallResultTypeExpression } from "./migration/classicRestProjectDecoder.js";
import { generateModuleSource } from "./migration/classicModuleCodegen.js";
import { createAsset, saveDesignerData } from "./migration/migrationPush.js";
import { matchInstanceByEnvironmentOrigin } from "./migration/instanceMatcher.js";
import { findChild, childText, parseXml } from "./migration/xmlLite.js";
import { commitModule, getModuleAsset } from "./flow-elements/flowModules.js";

const FLOW_CONNECT_BASE_URL = "https://build.novacura.com";
const X_ORIGIN = "HubWebApp";

/* --- bytes --- */

async function decompress(bytes, format) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const utf8 = (bytes) => new TextDecoder("utf-8").decode(bytes);
function base64ToBytes(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const looksLikeZip = (b) => b.length >= 2 && b[0] === 0x50 && b[1] === 0x4b;
const looksLikeGzip = (b) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
const gunzipText = async (bytes) => utf8(await decompress(bytes, "gzip"));

/* --- Flow Connect REST --- */

/** The REST client the original modules expect (get/post/put/postRaw -> fetch Response). */
function createRest(token, fetchImpl) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const headers = (extra) => ({ Authorization: `Bearer ${token}`, "X-Origin": X_ORIGIN, ...extra });
  const json = (method) => (path, body) =>
    doFetch(FLOW_CONNECT_BASE_URL + path, {
      method,
      headers: headers(body === undefined ? undefined : { "Content-Type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  return {
    get: json("GET"),
    post: json("POST"),
    put: json("PUT"),
    postRaw: (path, body, extra) => doFetch(FLOW_CONNECT_BASE_URL + path, { method: "POST", headers: headers(extra), body })
  };
}

/* --- decoding --- */

/** Decodes a .wap (zip of .flow files), a bare .flow (plain or gzip XML) into DecodedFlow[]. */
async function decodeArchiveBytes(fileBytes) {
  if (looksLikeZip(fileBytes)) {
    const entries = parseZipEntries(fileBytes).filter((e) => e.name.endsWith(".flow"));
    const flows = [];
    for (const entry of entries) {
      const compressed = getCompressedBytes(fileBytes, entry);
      const raw = entry.method === METHOD_DEFLATE ? await decompress(compressed, "deflate-raw") : compressed;
      flows.push(decodeFlowFile(utf8(raw)));
    }
    return flows;
  }
  const text = looksLikeGzip(fileBytes) ? await gunzipText(fileBytes) : utf8(fileBytes);
  return [decodeFlowFile(text)];
}

/** Everything the panel shows about an upload. `instances` ({id,name,baseUrl}) auto-match the
 *  Classic environment a flow came from. */
async function decodeArchive(fileBytes, instances) {
  const flows = await decodeArchiveBytes(fileBytes);
  const { order, unresolvedReferences, cyclic } = buildIncludeDependencyOrder(flows);
  return {
    flows,
    summaries: flows.map((f) => {
      const match = matchInstanceByEnvironmentOrigin(f.environmentOrigin, instances || []);
      return {
        versionIdentifier: f.versionIdentifier,
        name: f.name,
        assetKind: classifyAssetKind(f),
        itemCount: f.items.length,
        environmentOrigin: f.environmentOrigin,
        autoMatchedInstanceId: match.kind === "matched" ? match.instance.id : null
      };
    }),
    dependencyOrder: order.map((f) => f.versionIdentifier),
    unresolvedReferences: unresolvedReferences.map((r) => ({ flowVersionIdentifier: r.flow.versionIdentifier, flowName: r.flow.name, versionIdentifier: r.versionIdentifier })),
    cyclic: cyclic.map((f) => f.versionIdentifier)
  };
}

/** A .ncrcp REST project: base64 text of gzip'd ConnectorProject XML. */
async function decodeRestProjectFile(fileBytes) {
  const xml = await gunzipText(base64ToBytes(utf8(fileBytes)));
  return decodeRestProject(parseXml(xml));
}

function findMethodCallTaskConfigNode(item) {
  if (item.tagKind !== "MachineStepConfiguration" || !item.tagNode) return null;
  const cmdElement = findChild(item.tagNode, "CommandElement");
  const command = cmdElement ? findChild(cmdElement, "command") : null;
  return command ? findChild(command, "MethodCallTaskConfiguration") : null;
}

function findConnectorServiceTaskConnectorRef(item) {
  if (item.tagKind !== "MachineStepConfiguration" || !item.tagNode) return null;
  const cmdElement = findChild(item.tagNode, "CommandElement");
  const command = cmdElement ? findChild(cmdElement, "command") : null;
  const task = command ? findChild(command, "ConnectorServiceTask") : null;
  if (!task || !command) return null;
  const rawName = command.attrs ? command.attrs["connector"] : null;
  const name = rawName ? rawName.trim() : null;
  if (!name) return null;
  return { name, typeName: childText(item.tagNode, "ConnectorTypeName") || null };
}

/** Every distinct Classic connector {name, typeName} a flow's steps use (network-free). */
function listFlowConnectors(flow) {
  const seen = new Map();
  const consider = (ref) => {
    // "flow" (the pseudo "Flow Environment" connector) maps to itself implicitly.
    if (ref && ref.name && ref.typeName !== "flow" && !seen.has(ref.name)) seen.set(ref.name, ref);
  };
  for (const item of collectAllItems(flow.items)) {
    const methodCallNode = findMethodCallTaskConfigNode(item);
    if (methodCallNode && item.tagNode) {
      const ref = decodeMethodCallConnectorRef(item.tagNode);
      consider(ref && ref.connectorName ? { name: ref.connectorName, typeName: ref.connectorTypeName } : null);
    }
    consider(findConnectorServiceTaskConnectorRef(item));
    const dbCommand = item.tagNode ? decodeDatabaseCommand(item.tagNode) : null;
    consider(dbCommand && dbCommand.connectorName ? { name: dbCommand.connectorName, typeName: "database" } : null);
    const emailCommand = item.tagNode ? decodeEmailCommand(item.tagNode) : null;
    consider(emailCommand && emailCommand.connectorName ? { name: emailCommand.connectorName, typeName: "email" } : null);
  }
  return Array.from(seen.values());
}

/** One item's EmitterOperation, or undefined when it has no decodable operation config. */
async function decodeItemOperationConfig(item) {
  const tagNode = item.tagNode;
  if (item.tagKind !== "MachineStepConfiguration" || !tagNode) return undefined;
  const methodCallNode = findMethodCallTaskConfigNode(item);
  if (methodCallNode) {
    const decodedOp = decodeMethodCallOperation(methodCallNode);
    const connectorRef = decodeMethodCallConnectorRef(tagNode);
    return {
      kind: "methodcall",
      identifier: decodedOp?.identifier ?? null,
      displayName: decodedOp?.displayName ?? null,
      description: decodedOp?.description ?? null,
      connectorName: connectorRef?.connectorName ?? null,
      connectorTypeName: connectorRef?.connectorTypeName ?? null,
      input: decodedOp?.input ?? null,
      output: decodedOp?.output ?? null,
      methodCallInputs: decodedOp?.inputs ?? [],
      declaringCategory: decodedOp?.declaringCategory ?? null
    };
  }
  const databaseCommand = decodeDatabaseCommand(tagNode);
  if (databaseCommand) {
    return {
      kind: "database",
      commandType: databaseCommand.commandType,
      commandText: databaseCommand.commandText,
      iteratorExpression: databaseCommand.iteratorExpression,
      runAsTemplate: databaseCommand.runAsTemplate,
      connectorName: databaseCommand.connectorName,
      connectorTypeName: "database"
    };
  }
  const emailCommand = decodeEmailCommand(tagNode);
  if (emailCommand) {
    return {
      kind: "email",
      from: emailCommand.from,
      to: emailCommand.to,
      cc: emailCommand.cc,
      bcc: emailCommand.bcc,
      subject: emailCommand.subject,
      body: emailCommand.body,
      isHtml: emailCommand.isHtml,
      attachmentScript: emailCommand.attachmentScript,
      connectorName: emailCommand.connectorName,
      connectorTypeName: "email"
    };
  }
  const html2pdfCommand = decodeHtml2PdfCommand(tagNode);
  if (html2pdfCommand) {
    return {
      kind: "html2pdf",
      stylesheet: html2pdfCommand.stylesheet,
      html: html2pdfCommand.html,
      fileName: html2pdfCommand.fileName,
      pageSize: html2pdfCommand.pageSize,
      pageOrientation: html2pdfCommand.pageOrientation,
      marginTop: html2pdfCommand.marginTop,
      marginBottom: html2pdfCommand.marginBottom,
      marginLeft: html2pdfCommand.marginLeft,
      marginRight: html2pdfCommand.marginRight,
      connectorTypeName: "html2pdf"
    };
  }
  const cmdElement = findChild(tagNode, "CommandElement");
  const command = cmdElement ? findChild(cmdElement, "command") : null;
  const task = command ? findChild(command, "ConnectorServiceTask") : null;
  const taskConfigB64 = task ? childText(task, "TaskConfig") : null;
  if (!taskConfigB64) return undefined;
  const xml = await gunzipText(base64ToBytes(taskConfigB64));
  const rawConnectorName = command && command.attrs ? command.attrs["connector"] : null;
  return {
    ...decodeOperationConfig(xml),
    connectorName: rawConnectorName ? rawConnectorName.trim() : null,
    connectorTypeName: childText(tagNode, "ConnectorTypeName") || null
  };
}

/* --- emit --- */

/** Translates one decoded flow to Designer events.
 *  ctx: { rest, userId, ifs?: { baseUrl, token } }  (ifs is needed only for OData steps)
 *  input: { flow, connectorMapping?, restProjects?, includedWorkflows?, target? ({orgId, packageId}) }
 *  Without `target` no module is committed (preview emit). Modules the flow uses are generated
 *  from the IFS instance and committed into the target. */
async function emitFlow(ctx, input) {
  const { flow } = input;
  const operationConfigs = new Map();
  const allItems = collectAllItemsWithKeys(flow.items);
  for (const { item, key } of allItems) {
    const operation = await decodeItemOperationConfig(item);
    if (operation) operationConfigs.set(key, operation);
  }

  const serviceUrlByModuleName = new Map();
  for (const operation of operationConfigs.values()) {
    if (operation.kind === "methodcall" || !operation.serviceUrl) continue;
    const moduleName = extractSvcName(operation.serviceUrl) || "UnknownModule";
    if (moduleName === "UnknownModule" || serviceUrlByModuleName.has(moduleName)) continue;
    serviceUrlByModuleName.set(moduleName, operation.serviceUrl);
  }

  const moduleSources = new Map();
  const moduleAssetIds = new Map();
  if (serviceUrlByModuleName.size > 0) {
    if (!ctx.ifs || !ctx.ifs.token) {
      throw new Error(`This flow calls IFS projections (${[...serviceUrlByModuleName.keys()].join(", ")}). Pick the IFS instance it came from so the Flow modules can be generated.`);
    }
    for (const [moduleName, serviceUrl] of serviceUrlByModuleName) {
      moduleSources.set(moduleName, await generateModuleSource(ctx.ifs.baseUrl, ctx.ifs.token, ctx.rest, moduleName, serviceUrl));
    }
    if (input.target) {
      for (const [moduleName, source] of moduleSources) {
        const committed = await commitModule(ctx.rest, input.target.orgId, input.target.packageId, moduleName, source);
        moduleAssetIds.set(moduleName, committed.assetId);
      }
    }
  }

  const restResolutions = new Map();
  if (input.connectorMapping) {
    for (const [connectorName, { runAsUser, ...connector }] of Object.entries(input.connectorMapping)) {
      const restProject = input.restProjects ? input.restProjects[connectorName] : undefined;
      restResolutions.set(connectorName, { connector, restProjectOperations: restProject ? restProject.operations : undefined, runAsUser });
    }
  }

  const componentResultTypesByStep = new Map();
  for (const { item, key } of allItems) {
    if (item.stepType !== "MachineTaskItem" || !item.tagNode) continue;
    const operation = operationConfigs.get(key);
    if (!operation || operation.kind !== "methodcall" || !operation.connectorName) continue;
    const resolution = restResolutions.get(operation.connectorName);
    const ops = resolution ? resolution.restProjectOperations : null;
    if (!ops) continue;
    const matched = findRestProjectOperationByDisplayName(ops, operation.displayName ?? null);
    if (!matched) continue;
    const response = matched.responses.find((r) => r.httpStatusCode === "200") ?? matched.responses[0];
    if (!response || response.fields.length === 0) continue;
    componentResultTypesByStep.set(key, `{ contents: ${buildRestCallResultTypeExpression(response.fields)} }`);
  }

  const result = emitConnectSteps(flow, {
    userId: ctx.userId,
    operationConfigs,
    moduleSources,
    moduleAssetIds,
    restResolutions,
    includedWorkflows: new Map(Object.entries(input.includedWorkflows || {})),
    componentResultTypesByStep
  });
  return {
    data: result.data,
    warnings: result.warnings,
    resultTypeExpression: result.resultTypeExpression,
    componentAssetsUsed: result.componentAssetsUsed,
    unreachableStepIds: result.unreachableStepIds,
    startParametersExpression: result.startParametersExpression,
    isInbox: result.isInbox,
    moduleCount: moduleSources.size
  };
}

/* --- push --- */

/** Creates the flow in `target` ({orgId, packageId, name, kind}) and SAVES its steps. Not
 *  committed (see the header). Reads the data back and fails when steps went missing. */
async function pushFlow(ctx, target, emitted) {
  const { rest } = ctx;
  const refs = [];
  const seen = new Set();
  const addRef = (assetId, assetVersion, offeredParameterType) => {
    if (seen.has(assetId)) return;
    seen.add(assetId);
    refs.push({ assetId, assetVersion, offeredParameterType: offeredParameterType || "{}" });
  };
  for (const c of emitted.componentAssetsUsed || []) {
    let version = c.assetVersion;
    try {
      version = (await getModuleAsset(rest, target.orgId, target.packageId, c.assetId)).mainBranch.headVersionId;
    } catch { /* keep the version the emitter had */ }
    addRef(c.assetId, version, c.offeredParameterType);
  }
  for (const entry of emitted.data) {
    if (entry.type !== "module-added" || !entry.moduleId) continue;
    const asset = await getModuleAsset(rest, target.orgId, target.packageId, entry.moduleId);
    addRef(entry.moduleId, asset.mainBranch.headVersionId);
  }

  const asset = await createAsset(rest, target);
  await saveDesignerData(rest, target.orgId, asset.id, emitted.data, refs, emitted.resultTypeExpression, emitted.startParametersExpression, emitted.isInbox);

  const sent = emitted.data.filter((e) => e.type === "step-created").length;
  const readBack = await rest.get(`/admin/application/api/v2/organisations/${target.orgId}/items/${asset.id}/designer`);
  if (!readBack.ok) throw new Error(`Flow "${target.name}" was created (${asset.id}) but could not be read back (${readBack.status}).`);
  const stored = (await readBack.json()).data || [];
  const got = stored.filter((e) => e.type === "step-created").length;
  if (got < sent) throw new Error(`Flow "${target.name}" was created (${asset.id}) but only ${got} of ${sent} steps were saved. Do not commit it.`);

  let assetVersion = "";
  try {
    assetVersion = (await getModuleAsset(rest, target.orgId, target.packageId, asset.id)).mainBranch.headVersionId;
  } catch { /* later flows then fall back to an unresolved marker */ }
  return { itemId: asset.id, assetVersion, steps: got };
}

export {
  FLOW_CONNECT_BASE_URL,
  createRest,
  decodeArchive,
  decodeRestProjectFile,
  listFlowConnectors,
  emitFlow,
  pushFlow
};
