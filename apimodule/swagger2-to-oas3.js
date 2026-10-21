/* ============================================================
   Swagger 2.0 -> OpenAPI 3 — normalizes the subset of Swagger 2.0
   the module generator reads, so there is only one generator.
   Not a general-purpose converter: security, examples and docs
   fields are carried over as-is or dropped.
   ============================================================ */
(function (global) {
  const REF_MOVES = [
    ["#/definitions/", "#/components/schemas/"],
    ["#/parameters/", "#/components/parameters/"],
    ["#/responses/", "#/components/responses/"]
  ];

  /** Deep copy with every `$ref` pointed at its OpenAPI 3 home. */
  function rewriteRefs(value) {
    if (Array.isArray(value)) return value.map(rewriteRefs);
    if (!value || typeof value !== "object") return value;
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (key === "$ref" && typeof v === "string") {
        const move = REF_MOVES.find(([from]) => v.startsWith(from));
        out[key] = move ? move[1] + v.slice(move[0].length) : v;
      } else {
        out[key] = rewriteRefs(v);
      }
    }
    return out;
  }

  const SCHEMA_KEYS = ["type", "format", "items", "enum", "default", "minimum", "maximum", "pattern", "minLength", "maxLength", "minItems", "maxItems"];

  /** A non-body Swagger 2.0 parameter keeps its schema keywords inline; OpenAPI 3 nests them. */
  function convertParameter(p) {
    if (!p || p.$ref || p.in === "body" || p.in === "formData") return p;
    const schema = {};
    for (const key of SCHEMA_KEYS) if (p[key] !== undefined) schema[key] = p[key];
    if (schema.type === "file") schema.type = "string", schema.format = "binary";
    const out = { name: p.name, in: p.in, required: !!p.required || p.in === "path", schema };
    if (p.description) out.description = p.description;
    if (p.collectionFormat) {
      out["x-collectionFormat"] = p.collectionFormat;
      if (p.collectionFormat === "multi") out.explode = true;
      else if (p.collectionFormat === "csv") out.explode = false;
    }
    return out;
  }

  function convertResponse(r, produces) {
    if (!r || r.$ref) return r;
    const out = { description: r.description || "" };
    if (r.schema) {
      const types = produces && produces.length ? produces : ["application/json"];
      out.content = {};
      for (const t of types) out.content[t] = { schema: r.schema };
    }
    if (r.headers) out.headers = r.headers;
    return out;
  }

  /** Builds the requestBody from `in: body` (one schema) or `in: formData` (one object schema
   *  with a property per field). Parameters given by `$ref` are resolved first so a shared body
   *  parameter isn't lost. */
  function convertBody(params, consumes, sharedParams) {
    const resolved = params.map((p) => (p && p.$ref && p.$ref.startsWith("#/parameters/") ? sharedParams[p.$ref.slice(13)] || p : p));
    const body = resolved.find((p) => p && p.in === "body");
    if (body) {
      const types = consumes && consumes.length ? consumes : ["application/json"];
      const content = {};
      for (const t of types) content[t] = { schema: rewriteRefs(body.schema || {}) };
      return { required: !!body.required, content, ...(body.description ? { description: body.description } : {}) };
    }
    const form = resolved.filter((p) => p && p.in === "formData");
    if (!form.length) return null;
    const properties = {};
    const required = [];
    let hasFile = false;
    for (const f of form) {
      const prop = convertParameter({ ...f, in: "query" }).schema;
      if (f.type === "file") hasFile = true;
      if (f.description) prop.description = f.description;
      properties[f.name] = prop;
      if (f.required) required.push(f.name);
    }
    const type = hasFile || (consumes || []).includes("multipart/form-data") ? "multipart/form-data" : "application/x-www-form-urlencoded";
    return { required: required.length > 0, content: { [type]: { schema: { type: "object", properties, ...(required.length ? { required } : {}) } } } };
  }

  function convertSwagger2(doc) {
    const sharedParams = doc.parameters || {};
    const scheme = (doc.schemes && doc.schemes[0]) || "https";
    const out = {
      openapi: "3.0.3",
      info: doc.info || { title: "API", version: "" },
      servers: doc.host || doc.basePath ? [{ url: doc.host ? `${scheme}://${doc.host}${doc.basePath || ""}` : doc.basePath }] : [],
      tags: doc.tags || [],
      paths: {},
      components: {
        schemas: rewriteRefs(doc.definitions || {}),
        parameters: {},
        responses: {}
      }
    };
    for (const [name, p] of Object.entries(sharedParams)) {
      if (p.in !== "body" && p.in !== "formData") out.components.parameters[name] = rewriteRefs(convertParameter(p));
    }
    for (const [name, r] of Object.entries(doc.responses || {})) {
      out.components.responses[name] = rewriteRefs(convertResponse(r, doc.produces));
    }
    const isBodyRef = (p) => p && p.$ref && p.$ref.startsWith("#/parameters/") && sharedParams[p.$ref.slice(13)] && ["body", "formData"].includes(sharedParams[p.$ref.slice(13)].in);

    for (const [pathKey, item] of Object.entries(doc.paths || {})) {
      const pathParams = item.parameters || [];
      const outItem = {};
      const keepParams = pathParams.filter((p) => p.in !== "body" && p.in !== "formData" && !isBodyRef(p));
      if (keepParams.length) outItem.parameters = rewriteRefs(keepParams.map(convertParameter));
      for (const method of ["get", "put", "post", "delete", "options", "head", "patch"]) {
        const op = item[method];
        if (!op) continue;
        const allParams = [...pathParams, ...(op.parameters || [])];
        const params = (op.parameters || []).filter((p) => p.in !== "body" && p.in !== "formData" && !isBodyRef(p));
        const o = { ...op };
        delete o.consumes;
        delete o.produces;
        o.parameters = rewriteRefs(params.map(convertParameter));
        if (!o.parameters.length) delete o.parameters;
        const body = convertBody(allParams, op.consumes || doc.consumes, sharedParams);
        if (body) o.requestBody = body;
        o.responses = {};
        for (const [code, r] of Object.entries(op.responses || {})) {
          o.responses[code] = rewriteRefs(convertResponse(r, op.produces || doc.produces));
        }
        outItem[method] = o;
      }
      out.paths[pathKey] = outItem;
    }
    return out;
  }

  const api = { convertSwagger2 };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.ApiSwagger2ToOas3 = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
