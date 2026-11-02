import { findChild, findChildren, childText } from "./xmlLite.js";
function decodeTableCreation(tagNode) {
  const target = childText(tagNode, "Target") || "";
  const data = findChild(tagNode, "Data");
  if (!data) return { target, columns: [], rows: [] };
  const schemaNode = findChild(data, "schema");
  const rowElement = schemaNode ? findRowElement(schemaNode) : null;
  const columns = rowElement ? decodeColumns(rowElement) : [];
  const rowName = rowElement ? rowElement.attrs.name : void 0;
  if (columns.length === 0 || !rowName) return { target, columns: [], rows: [] };
  const diffgram = findChild(data, "diffgram");
  const documentElement = findChild(diffgram, "DocumentElement");
  const rows = findChildren(documentElement, rowName).map(
    (r) => columns.map((c) => childText(r, c) ?? "")
  );
  return { target, columns, rows };
}
function findRowElement(schemaNode) {
  const dataset = findChild(schemaNode, "element");
  const complexType = dataset ? findChild(dataset, "complexType") : null;
  const choice = complexType ? findChild(complexType, "choice") : null;
  return choice ? findChild(choice, "element") : null;
}
function decodeColumns(rowElement) {
  const complexType = findChild(rowElement, "complexType");
  const sequence = complexType ? findChild(complexType, "sequence") : null;
  return findChildren(sequence, "element").map((el) => el.attrs.name).filter((n) => !!n);
}
export {
  decodeTableCreation
};
