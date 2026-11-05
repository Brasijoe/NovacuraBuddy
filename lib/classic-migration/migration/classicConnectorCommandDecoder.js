import { findChild, childText } from "./xmlLite.js";
const DATABASE_COMMAND_TAG_TO_TYPE = {
  query: "multiRecordQuery",
  singleRecordQuery: "singleRecordQuery",
  singleValueQuery: "singleValueQuery",
  script: "nonQuery"
};
function decodeDatabaseCommand(itemTagNode) {
  if (!itemTagNode || childText(itemTagNode, "ConnectorTypeName") !== "database") return null;
  const cmdElement = findChild(itemTagNode, "CommandElement");
  const command = cmdElement ? findChild(cmdElement, "command") : null;
  if (!command) return null;
  let commandType = null;
  let queryNode = null;
  for (const tagName of Object.keys(DATABASE_COMMAND_TAG_TO_TYPE)) {
    const node = findChild(command, tagName);
    if (node) {
      commandType = DATABASE_COMMAND_TAG_TO_TYPE[tagName];
      queryNode = node;
      break;
    }
  }
  if (!commandType || !queryNode) return null;
  const rawConnector = command.attrs ? command.attrs["connector"] : null;
  return {
    commandType,
    commandText: (childText(queryNode, "code") || "").trim(),
    iteratorExpression: queryNode.attrs && queryNode.attrs["iterator"] || "",
    runAsTemplate: queryNode.attrs && queryNode.attrs["runAs"] || "",
    connectorName: rawConnector ? rawConnector.trim() : null
  };
}
function decodeEmailCommand(itemTagNode) {
  if (!itemTagNode || childText(itemTagNode, "ConnectorTypeName") !== "email") return null;
  const cmdElement = findChild(itemTagNode, "CommandElement");
  const command = cmdElement ? findChild(cmdElement, "command") : null;
  const emailTaskConfig = command ? findChild(command, "EmailTaskConfig") : null;
  if (!command || !emailTaskConfig) return null;
  const rawConnector = command.attrs ? command.attrs["connector"] : null;
  return {
    from: childText(emailTaskConfig, "From") || "",
    to: childText(emailTaskConfig, "To") || "",
    cc: childText(emailTaskConfig, "Cc") || "",
    bcc: childText(emailTaskConfig, "Bcc") || "",
    subject: childText(emailTaskConfig, "Subject") || "",
    body: childText(emailTaskConfig, "Body") || "",
    isHtml: childText(emailTaskConfig, "IsHtml") === "true",
    attachmentScript: childText(emailTaskConfig, "AttachmentScript") || "",
    connectorName: rawConnector ? rawConnector.trim() : null
  };
}
function numberOrNull(text) {
  if (text === null || text.trim() === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}
function decodeHtml2PdfCommand(itemTagNode) {
  if (!itemTagNode || childText(itemTagNode, "ConnectorTypeName") !== "html2pdf") return null;
  const cmdElement = findChild(itemTagNode, "CommandElement");
  const command = cmdElement ? findChild(cmdElement, "command") : null;
  const config = command ? findChild(command, "Html2PdfTaskConfig") : null;
  if (!command || !config) return null;
  const rawConnector = command.attrs ? command.attrs["connector"] : null;
  return {
    stylesheet: childText(config, "Stylesheet") || "",
    html: childText(config, "Html") || "",
    fileName: childText(config, "FileName") || "",
    pageSize: childText(config, "PageSize") || "",
    pageOrientation: childText(config, "PageOrientation") || "",
    marginTop: numberOrNull(childText(config, "MarginTop")),
    marginBottom: numberOrNull(childText(config, "MarginBottom")),
    marginLeft: numberOrNull(childText(config, "MarginLeft")),
    marginRight: numberOrNull(childText(config, "MarginRight")),
    connectorName: rawConnector ? rawConnector.trim() : null
  };
}
export {
  decodeDatabaseCommand,
  decodeEmailCommand,
  decodeHtml2PdfCommand
};
