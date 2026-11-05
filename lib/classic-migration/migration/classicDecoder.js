import { parseXml, findChild, findChildren, childText } from "./xmlLite.js";
function stringListOf(node, containerName) {
  const container = findChild(node, containerName);
  return findChildren(container, "string").map((n) => n.text);
}
function decodeApplicationMetaData(outerRoot) {
  const container = findChild(outerRoot, "ApplicationMetaData");
  const entries = findChildren(container, "ApplicationMetaDataEntry");
  const map = /* @__PURE__ */ new Map();
  entries.forEach((entry) => {
    const key = childText(entry, "Key");
    if (key !== null) map.set(key, childText(entry, "Value") ?? "");
  });
  return map;
}
function decodeHeader(containerRoot) {
  const header = findChild(containerRoot, "Header");
  if (!header) return null;
  return {
    id: childText(header, "Id"),
    versionId: childText(header, "VersionId"),
    languageCodes: stringListOf(header, "LanguageCodes"),
    defaultLanguageCode: childText(header, "DefaultLanguageCode"),
    startParametersSchema: childText(findChild(header, "StartParameters"), "Schema"),
    workflowOutputType: childText(header, "WorkflowOutputType"),
    outputVariableNames: stringListOf(header, "OutputVariableNames"),
    outputVariableSchema: childText(findChild(header, "OutputVariableCollection"), "Schema"),
    propertiesType: childText(findChild(header, "Properties"), "Type")
  };
}
function classifyAssetKind(decodedFlow) {
  const type = decodedFlow.header && decodedFlow.header.propertiesType;
  if (type === "Fragment" || type === "Machine") return "component";
  if (type === "User") return "application";
  return null;
}
function isFragment(decodedFlow) {
  return !!(decodedFlow.header && decodedFlow.header.propertiesType === "Fragment");
}
function decodeLocation(base) {
  const locationNode = findChild(base, "Location");
  if (!locationNode) return null;
  const x = parseFloat(childText(locationNode, "X") ?? "");
  const y = parseFloat(childText(locationNode, "Y") ?? "");
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return { x, y };
}
function decodeAnnotation(base) {
  const sizeNode = findChild(base, "Size");
  const width = sizeNode ? parseFloat(childText(sizeNode, "Width") ?? "") : NaN;
  const height = sizeNode ? parseFloat(childText(sizeNode, "Height") ?? "") : NaN;
  return {
    text: childText(base, "Text") || "",
    location: decodeLocation(base),
    size: Number.isNaN(width) || Number.isNaN(height) ? null : { width, height }
  };
}
function decodeItem(base) {
  const tagNode = findChild(base, "Tag");
  return {
    kind: "item",
    id: childText(base, "Id"),
    tagKind: tagNode ? tagNode.attrs["xsi:type"] || null : null,
    stepType: childText(base, "Type"),
    incomingConnectorIds: stringListOf(base, "IncomingConnectorIds"),
    outgoingConnectorIds: stringListOf(base, "OutgoingConnectorIds"),
    location: decodeLocation(base),
    tagNode,
    label: null
  };
}
function decodeJoints(base) {
  const container = findChild(base, "Joints");
  return findChildren(container, "PointF").map((node) => ({
    x: parseFloat(childText(node, "X") ?? ""),
    y: parseFloat(childText(node, "Y") ?? "")
  })).filter((p) => !Number.isNaN(p.x) && !Number.isNaN(p.y));
}
function decodeArrow(base) {
  const tagNode = findChild(base, "Tag");
  return {
    kind: "arrow",
    id: childText(base, "Id"),
    arrowType: childText(base, "Type"),
    sinkItemId: childText(base, "SinkItemId"),
    targetItemId: childText(base, "TargetItemId"),
    text: childText(base, "Text"),
    joints: decodeJoints(base),
    tagKind: tagNode ? tagNode.attrs["xsi:type"] || null : null,
    tagNode
  };
}
function decodeLabelBase(base) {
  return {
    id: childText(base, "Id"),
    parentItemId: childText(base, "ParentItemId"),
    text: childText(base, "Text")
  };
}
function decodeElementsBlock(elementsNode) {
  const bases = findChildren(elementsNode, "Base");
  const items = [];
  const arrows = [];
  const labels = [];
  const annotations = [];
  bases.forEach((base) => {
    const xsiType = base.attrs["xsi:type"];
    if (xsiType === "Item") items.push(decodeItem(base));
    else if (xsiType === "Arrow") arrows.push(decodeArrow(base));
    else if (xsiType === "Label") labels.push(decodeLabelBase(base));
    else if (xsiType === "Annotation") annotations.push(decodeAnnotation(base));
  });
  const labelByParentId = new Map(labels.map((l) => [l.parentItemId, l.text]));
  items.forEach((item) => {
    item.label = labelByParentId.has(item.id) ? labelByParentId.get(item.id) : null;
  });
  return { items, arrows, annotations };
}
function decodeSubworkflowItems(tagNode) {
  const subItemsNode = findChild(tagNode, "SubItems");
  if (!subItemsNode) return null;
  const result = decodeElementsBlock(subItemsNode);
  return result.items.length > 0 ? result : null;
}
const NESTED_ITEM_KEY_SEPARATOR = "/";
function qualifiedItemKey(parentKey, itemId) {
  const id = itemId ?? "";
  return parentKey ? `${parentKey}${NESTED_ITEM_KEY_SEPARATOR}${id}` : id;
}
function collectAllItemsWithKeys(items) {
  const out = [];
  const walk = (list, parentKey) => {
    list.forEach((it) => {
      const key = qualifiedItemKey(parentKey, it.id);
      out.push({ item: it, key });
      if (it.stepType === "SubworkflowItem" && it.tagNode) {
        const nested = decodeSubworkflowItems(it.tagNode);
        if (nested) walk(nested.items, key);
      }
    });
  };
  walk(items, "");
  return out;
}
function collectAllItems(items) {
  return collectAllItemsWithKeys(items).map((entry) => entry.item);
}
function narrowItemKeyedMapForSubworkflow(map, subworkflowItemId) {
  if (!map) return map;
  const prefix = `${qualifiedItemKey("", subworkflowItemId)}${NESTED_ITEM_KEY_SEPARATOR}`;
  const narrowed = /* @__PURE__ */ new Map();
  map.forEach((value, key) => {
    if (key.startsWith(prefix)) narrowed.set(key.slice(prefix.length), value);
  });
  return narrowed;
}
function decodeFlowFile(flowXmlText) {
  const outerRoot = parseXml(flowXmlText);
  const name = childText(outerRoot, "Name");
  const versionIdentifier = childText(outerRoot, "VersionIdentifier");
  const environmentOrigin = decodeApplicationMetaData(outerRoot).get("EnvironmentOrigin") ?? null;
  const workflowDataText = childText(outerRoot, "WorkflowData");
  if (!workflowDataText) throw new Error("FlowClassicDecoder: export has no <WorkflowData> \u2014 not a recognized .flow export");
  const containerRoot = parseXml(workflowDataText);
  const header = decodeHeader(containerRoot);
  const elementsNode = findChild(containerRoot, "Elements");
  const { items, arrows, annotations } = decodeElementsBlock(elementsNode);
  return { name, versionIdentifier, header, items, arrows, annotations, environmentOrigin };
}
function decodeIncludedWorkflow(tagNode) {
  return {
    versionIdentifier: childText(tagNode, "VersionIdentifier"),
    outputRecord: childText(tagNode, "OutputRecord"),
    isMachineDependency: childText(tagNode, "IsMachineDependency") === "true",
    startParametersSchema: childText(findChild(tagNode, "StartParameters"), "Schema"),
    variableMappingsNode: findChild(tagNode, "VariableMappings")
  };
}
export {
  NESTED_ITEM_KEY_SEPARATOR,
  classifyAssetKind,
  collectAllItems,
  collectAllItemsWithKeys,
  decodeElementsBlock,
  decodeFlowFile,
  decodeIncludedWorkflow,
  decodeJoints,
  decodeSubworkflowItems,
  isFragment,
  narrowItemKeyedMapForSubworkflow,
  qualifiedItemKey
};
