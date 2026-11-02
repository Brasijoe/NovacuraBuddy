(function (global) {
  // Fills a deployed Custom LU with rows. Every Custom LU gets its own projection
  // (CustomProjection<first 22 chars of the LU>.svc), so the entity set and property names are read
  // from that projection's $metadata instead of being assumed. UNCONFIRMED live: entity set choice,
  // property-name mapping and that the signed-in user may insert (the grant goes to permission sets).
  const req = (path, name) => (typeof require === "function" ? require(path) : global[name]);
  const CustomLuModel = req("./custom-lu-model.js", "CustomLuModel");
  const BASE = "/main/ifsapplications/projection/v1";
  const MAX_ERRORS = 5;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

  /** → { set, properties: [names] } for the LU's main entity set (the one named after the LU, else the first). */
  function readLayout(xml, luName) {
    const sets = [];
    for (const m of xml.matchAll(/<EntitySet\b[^>]*>/g)) {
      const name = /\bName="([^"]+)"/.exec(m[0]);
      const type = /\bEntityType="([^"]+)"/.exec(m[0]);
      if (name && type) sets.push({ name: name[1], type: type[1].split(".").pop() });
    }
    if (!sets.length) throw new Error("the LU's projection has no entity set");
    const wanted = norm(CustomLuModel.entityName(luName));
    const set = sets.find((s) => norm(s.name).startsWith(wanted) || norm(s.type) === wanted) || sets[0];
    const typeXml = new RegExp(`<EntityType\\b[^>]*\\bName="${set.type}"[^>]*>([\\s\\S]*?)</EntityType>`).exec(xml);
    const properties = typeXml ? [...typeXml[1].matchAll(/<Property\b[^>]*\bName="([^"]+)"/g)].map((m) => m[1]) : [];
    return { set: set.name, properties };
  }

  /** Attribute-name keyed row → body keyed by the projection's property names (case/underscore-insensitive). Empty cells are left out. */
  function mapRow(row, properties) {
    const byNorm = new Map(properties.map((p) => [norm(p), p]));
    const body = {};
    for (const [key, value] of Object.entries(row)) {
      if (value === "" || value == null) continue;
      const property = byNorm.get(norm(key));
      if (!property) throw new Error(`the projection has no property for attribute ${key}`);
      body[property] = value;
    }
    return body;
  }

  async function insertRows(client, luName, rows, { onStep } = {}) {
    const projection = `${BASE}/${CustomLuModel.projectionName(luName)}.svc`;
    const layout = readLayout(await client.getText(`${projection}/$metadata`), luName);
    const result = { inserted: 0, failed: 0, errors: [] };
    for (const [i, row] of rows.entries()) {
      if (onStep && i % 10 === 0) onStep(`Insert rows ${i + 1}-${Math.min(i + 10, rows.length)} of ${rows.length}`);
      try {
        await client.postOData(`${projection}/${layout.set}`, mapRow(row, layout.properties));
        result.inserted++;
      } catch (err) {
        result.failed++;
        if (result.errors.length < MAX_ERRORS) result.errors.push(`row ${i + 1}: ${err.message}`);
        // The same mapping error would repeat for every row.
        if (/has no property for attribute/.test(err.message)) { result.failed += rows.length - i - 1; break; }
      }
    }
    return result;
  }

  const api = { insertRows, readLayout, mapRow };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.CustomLuData = api;
})(typeof window !== "undefined" ? window : globalThis);
