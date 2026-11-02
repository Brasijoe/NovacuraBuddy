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

  /** The entity set is always `<first 22 chars of the LU name>Set` (user, 2026-11-02) — no guessing.
   *  Only the property names are read from $metadata (the entity type behind that set). */
  function readLayout(xml, luName) {
    const set = `${CustomLuModel.entityName(luName)}Set`;
    const setTag = new RegExp(`<EntitySet\\b[^>]*\\bName="${set}"[^>]*>`).exec(xml);
    if (!setTag) throw new Error(`the LU's projection has no entity set ${set}`);
    const type = /\bEntityType="([^"]+)"/.exec(setTag[0]);
    const typeName = type ? type[1].split(".").pop() : null;
    const typeXml = typeName && new RegExp(`<EntityType\\b[^>]*\\bName="${typeName}"[^>]*>([\\s\\S]*?)</EntityType>`).exec(xml);
    const properties = typeXml ? [...typeXml[1].matchAll(/<Property\b[^>]*\bName="([^"]+)"/g)].map((m) => m[1]) : [];
    return { set, properties };
  }

  /** Attribute-name keyed row → body keyed by the projection's property names (case/underscore-insensitive). Empty cells are left out. */
  function mapRow(row, properties) {
    const byNorm = new Map(properties.map((p) => [norm(p), p]));
    const body = {};
    for (const [key, value] of Object.entries(row)) {
      if (value === "" || value == null) continue;
      // Exact (case/underscore-insensitive) first, then a prefixed name such as CustomEntity… / Cf….
      const k = norm(key);
      const property = byNorm.get(k) || properties.find((p) => norm(p).endsWith(k) && norm(p) !== "objkey");
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
        if (err.status === 403 && !result.errors.some((e) => e.startsWith("hint"))) result.errors.push("hint: 403 means the signed-in IFS user has no grant on this projection yet. Tick a permission set the user belongs to, deploy again, and tick the fill option again (existing rows stay; re-inserting adds duplicates, so only do this when the first run inserted nothing).");
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
