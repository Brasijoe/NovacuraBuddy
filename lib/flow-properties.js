(function (global) {
  const req = (path, name) => (typeof require === "function" ? require(path) : global[name]);
  const CustomLuModel = req("./custom-lu-model.js", "CustomLuModel");

  /** Column header → IFS attribute name: upper case, anything but A-Z/0-9/_ becomes "_". */
  function columnToAttributeName(column) {
    return String(column).trim().toUpperCase().replace(/[^A-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  }

  /** Flow Connect properties export (array of {Name, Type, Scope, Columns?, TableValues?, Value?})
   *  → one LU definition per Table property. Only the shape is imported: TableValues (row data,
   *  can hold passwords) is never read. */
  function parseConnectProperties(text) {
    let data;
    try {
      data = JSON.parse(String(text).replace(/^﻿/, ""));
    } catch {
      throw new Error("File is not valid JSON.");
    }
    if (!Array.isArray(data)) throw new Error("Expected a JSON array of Flow properties.");
    const lus = [];
    for (const row of data) {
      if (!row || typeof row !== "object" || row.Type !== "Table") continue;
      if (typeof row.Name !== "string" || !Array.isArray(row.Columns)) continue;
      const columns = row.Columns.filter((c) => typeof c === "string" && c.trim());
      if (!columns.length) continue;
      const name = row.Name.trim();
      lus.push({
        source: row.Name,
        name,
        prompt: name,
        attributes: columns.map((c) => ({ name: columnToAttributeName(c), prompt: c.trim(), type: "STRING", length: CustomLuModel.DEFAULT_LENGTH }))
      });
    }
    if (!lus.length) throw new Error("No Table-type properties found in this file.");
    return lus;
  }

  const api = { parseConnectProperties, columnToAttributeName };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.FlowProperties = api;
})(typeof window !== "undefined" ? window : globalThis);
