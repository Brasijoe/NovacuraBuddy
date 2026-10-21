/* ============================================================
   Spec Model — reads an OpenAPI 3 document (Swagger 2.0 already
   normalized) into the flat shape the generator needs: one entry
   per operation with resolved parameters, request body and
   success response, plus the base path and the raw schemas.
   Schemas keep their `$ref`s: the type registry names a Flowscript
   type after the component a `$ref` points at.
   ============================================================ */
(function (global) {
  const METHODS = ["get", "post", "put", "patch", "delete"];
  const LIST_WRAPPER_KEYS = ["value", "items", "data", "results", "content", "records"];

  function createResolver(doc, warnings) {
    const warned = new Set();
    function resolveRef(ref) {
      if (typeof ref !== "string" || !ref.startsWith("#/")) {
        if (!warned.has(ref)) {
          warned.add(ref);
          warnings.push(`External reference ${ref} is not supported; it was treated as an untyped record.`);
        }
        return {};
      }
      let node = doc;
      for (const raw of ref.slice(2).split("/")) {
        const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
        node = node && typeof node === "object" ? node[key] : undefined;
      }
      if (node === undefined) {
        if (!warned.has(ref)) {
          warned.add(ref);
          warnings.push(`Reference ${ref} points at nothing; it was treated as an untyped record.`);
        }
        return {};
      }
      return node;
    }
    /** Follows `$ref` chains (with a guard) until a real object. */
    function deref(obj) {
      const seen = new Set();
      while (obj && obj.$ref && !seen.has(obj.$ref)) {
        seen.add(obj.$ref);
        obj = resolveRef(obj.$ref);
      }
      return obj || {};
    }
    return { resolveRef, deref };
  }

  /** `https://api.x.com/{version}/v2/` -> `v1/v2` (server variables take their defaults). */
  function basePathFromServers(servers) {
    const server = servers && servers[0];
    if (!server || !server.url) return "";
    let url = server.url;
    for (const [name, v] of Object.entries(server.variables || {})) {
      url = url.split(`{${name}}`).join(v && v.default != null ? String(v.default) : "");
    }
    let pathPart = url;
    const m = url.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/i);
    if (m) pathPart = m[1] || "";
    return pathPart.split(/[?#]/)[0].replace(/^\/+|\/+$/g, "");
  }

  function pickContent(content) {
    const types = Object.keys(content || {});
    if (!types.length) return null;
    const type = types.find((t) => t.split(";")[0].trim() === "application/json")
      || types.find((t) => /[/+]json\b/.test(t))
      || types[0];
    return { contentType: type, schema: (content[type] && content[type].schema) || null };
  }

  function pickSuccessResponse(responses, deref) {
    const codes = Object.keys(responses || {});
    const success = codes.filter((c) => /^2(\d\d|XX)$/i.test(c)).sort();
    const code = success.find((c) => pickContent(deref(responses[c]).content)) || success[0] || (codes.includes("default") ? "default" : null);
    if (!code) return null;
    const picked = pickContent(deref(responses[code]).content);
    return { status: code, contentType: picked ? picked.contentType : null, schema: picked ? picked.schema : null };
  }

  function pascal(text) {
    return String(text).split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  }

  /** `GET /pets/{petId}/photos` -> `getPetsByPetIdPhotos`. */
  function nameFromPath(method, pathKey) {
    const parts = pathKey.split("/").filter(Boolean).map((seg) => {
      const m = seg.match(/^\{(.+)\}$/);
      return m ? "By" + pascal(m[1]) : pascal(seg);
    });
    return method + parts.join("");
  }

  function buildModel(doc) {
    const warnings = [];
    const { resolveRef, deref } = createResolver(doc, warnings);
    const operations = [];
    for (const [pathKey, rawItem] of Object.entries(doc.paths || {})) {
      const item = deref(rawItem);
      const pathParams = (item.parameters || []).map(deref);
      for (const method of METHODS) {
        const op = item[method];
        if (!op) continue;
        const own = (op.parameters || []).map(deref);
        // An operation-level parameter replaces a path-level one with the same name+location.
        const params = [...pathParams.filter((p) => !own.some((o) => o.name === p.name && o.in === p.in)), ...own]
          .filter((p) => p && p.name && ["path", "query", "header"].includes(p.in))
          .map((p) => ({
            name: p.name,
            in: p.in,
            required: p.in === "path" ? true : !!p.required,
            schema: p.schema || (p.content && pickContent(p.content) && pickContent(p.content).schema) || { type: "string" },
            description: p.description || "",
            deprecated: !!p.deprecated,
            example: p.example !== undefined ? p.example
              : p.examples && typeof p.examples === "object" && Object.values(p.examples)[0] && Object.values(p.examples)[0].value !== undefined
                ? Object.values(p.examples)[0].value : undefined,
            explode: p.explode !== undefined ? !!p.explode : true
          }));
        for (const p of params.filter((x) => x.in === "header" && /^(authorization|content-type|accept)$/i.test(x.name))) {
          params.splice(params.indexOf(p), 1); // the connector / HandleHeaders own these
        }
        let body = null;
        if (op.requestBody) {
          const rb = deref(op.requestBody);
          const picked = pickContent(rb.content);
          if (picked) {
            body = {
              contentType: picked.contentType,
              schema: picked.schema || {},
              required: !!rb.required,
              description: rb.description || "",
              media: rb.content[picked.contentType] || {}
            };
          }
        }
        operations.push({
          operationId: op.operationId || null,
          baseName: op.operationId || nameFromPath(method, pathKey),
          method,
          path: pathKey,
          tag: (op.tags && op.tags[0]) || "default",
          summary: op.summary || "",
          description: op.description || "",
          deprecated: !!op.deprecated,
          params,
          body,
          response: pickSuccessResponse(op.responses, deref),
          // Every documented status with its text, in spec order (for the doc comment).
          responses: Object.entries(op.responses || {}).map(([status, r]) => ({ status, description: deref(r).description || "" }))
        });
      }
    }
    // Stable, unique ids: the picker and the emitter both key operations by this.
    const used = new Map();
    for (const op of operations) {
      const key = op.baseName.toLowerCase();
      const n = (used.get(key) || 0) + 1;
      used.set(key, n);
      op.id = n === 1 ? op.baseName : `${op.baseName}_${n}`;
    }
    const tagOrder = (doc.tags || []).map((t) => t.name);
    return {
      title: (doc.info && doc.info.title) || "API",
      version: (doc.info && doc.info.version) || "",
      basePath: basePathFromServers(doc.servers),
      serverUrl: (doc.servers && doc.servers[0] && doc.servers[0].url) || "",
      description: (doc.info && doc.info.description) || "",
      externalDocs: doc.externalDocs || null,
      tagDescriptions: Object.fromEntries((doc.tags || []).filter((t) => t && t.name && t.description).map((t) => [t.name, t.description])),
      securitySchemes: (doc.components && doc.components.securitySchemes) || {},
      tags: [...new Set([...tagOrder.filter((t) => operations.some((o) => o.tag === t)), ...operations.map((o) => o.tag)])],
      operations,
      schemas: (doc.components && doc.components.schemas) || {},
      resolveRef,
      deref,
      warnings
    };
  }

  /** How a response schema holds a list: `{ wrapper: null, item }` for a bare array,
   *  `{ wrapper: "items", item }` for `{ items: [...] , ... }`, or null when it isn't a list. */
  function listShape(schema, deref) {
    if (!schema) return null;
    const s = deref(schema);
    if (s.type === "array" || (Array.isArray(s.type) && s.type.includes("array"))) return { wrapper: null, item: s.items || {} };
    const props = s.properties || {};
    const arrayProps = Object.keys(props).filter((k) => {
      const p = deref(props[k]);
      return p.type === "array" || (Array.isArray(p.type) && p.type.includes("array"));
    });
    const key = LIST_WRAPPER_KEYS.find((k) => arrayProps.includes(k)) || (arrayProps.length === 1 ? arrayProps[0] : null);
    return key ? { wrapper: key, item: deref(props[key]).items || {} } : null;
  }

  const api = { buildModel, listShape, basePathFromServers, nameFromPath, pascal };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.ApiSpecModel = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
