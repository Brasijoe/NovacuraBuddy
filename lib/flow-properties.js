(function (global) {
  const req = (path, name) => (typeof require === "function" ? require(path) : global[name]);
  const CustomLuModel = req("./custom-lu-model.js", "CustomLuModel");

  /** Column header → IFS attribute name: upper case, anything but A-Z/0-9/_ becomes "_". */
  const USER_PROPERTIES_LU = "UserProperties";
  const USER_ID = "USER_ID";

  function columnToAttributeName(column) {
    return String(column).trim().toUpperCase().replace(/[^A-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  }

  /** Flow properties export (array of {Name, Type, Scope, Columns?, TableValues?, Value?})
   *  → one LU definition per Table property, plus one wide `UserProperties` LU (USER_ID + one column
   *  per Scope "User" property) since IFS has no per-user values. Only the shape is imported:
   *  Value and TableValues (can hold passwords) are never read. */
  function parseConnectProperties(text) {
    let data;
    try {
      data = JSON.parse(String(text).replace(/^﻿/, ""));
    } catch {
      throw new Error("File is not valid JSON.");
    }
    if (!Array.isArray(data)) throw new Error("Expected a JSON array of Flow properties.");
    const lus = [];
    const userProperties = new Map(); // attribute name → original property name, first one wins
    for (const row of data) {
      if (row && typeof row === "object" && row.Scope === "User" && row.Type !== "Table" && typeof row.Name === "string" && row.Name.trim()) {
        const attr = columnToAttributeName(row.Name);
        if (attr && attr !== USER_ID && !userProperties.has(attr)) userProperties.set(attr, row.Name.trim());
        continue;
      }
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
    if (userProperties.size) {
      const attribute = (name, prompt) => ({ name, prompt, type: "STRING", length: CustomLuModel.DEFAULT_LENGTH });
      lus.push({
        source: `${userProperties.size} User properties`,
        name: USER_PROPERTIES_LU,
        prompt: "User Properties",
        attributes: [attribute(USER_ID, "User Id"), ...[...userProperties].map(([name, prompt]) => attribute(name, prompt))]
      });
    }
    if (!lus.length) throw new Error("No Table or User properties found in this file.");
    return lus;
  }

  /** Row data of the Table properties, keyed like parseConnectProperties' LU `source` and attribute names.
   *  Opt-in only: the editor reads it when the user ticks "Fill with values" for a table (TableValues can
   *  hold passwords). Cells are kept as strings; fully empty rows are dropped. */
  function parseTableRows(text) {
    let data;
    try {
      data = JSON.parse(String(text).replace(/^﻿/, ""));
    } catch {
      return {};
    }
    const out = {};
    if (!Array.isArray(data)) return out;
    for (const row of data) {
      if (!row || typeof row !== "object" || row.Type !== "Table" || typeof row.Name !== "string" || !Array.isArray(row.Columns)) continue;
      let values = row.TableValues;
      if (typeof values === "string") {
        try { values = JSON.parse(values); } catch { try { values = JSON.parse(values.replace(/'/g, '"')); } catch { values = []; } }
      }
      if (!Array.isArray(values)) continue;
      const columns = row.Columns.filter((c) => typeof c === "string" && c.trim());
      const rows = [];
      for (const v of values) {
        if (!v || typeof v !== "object") continue;
        const rec = {};
        for (const c of columns) rec[columnToAttributeName(c)] = v[c] == null ? "" : String(v[c]);
        if (Object.values(rec).some((x) => x !== "")) rows.push(rec);
      }
      out[row.Name] = rows;
    }
    return out;
  }

  const api = { parseConnectProperties, parseTableRows, columnToAttributeName };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.FlowProperties = api;
})(typeof window !== "undefined" ? window : globalThis);
