/* ============================================================
   Flow Types — JSON Schema -> Flowscript types, in the same
   shapes Connect's OData generator uses:

     type Pet = {                      response/row type
         id: number? = null,           optional scalar
         name: text,                   required scalar
         tags: Tag*,                   sequences/records never get `?`
         status: Pet_status.Value,     enum -> module with a Value union
     }
     type PetRequest = {               request-body variant
         optional id: number,
         name: text,
     }
     module Pet_status { ... fromText ... }

   plus, for every row type holding enums (directly or nested),
   the `enumMappingsForX` / `recordMapperForX` pair the OData
   modules use to turn the API's plain enum text into the typed
   enum values.
   ============================================================ */
(function (global) {
  const KEYWORDS = new Set([
    "and", "as", "break", "by", "case", "continue", "distinct", "else", "end", "error", "expand", "false", "for",
    "from", "function", "given", "group", "if", "in", "is", "join", "left", "let", "like", "map", "module", "new",
    "not", "null", "on", "open", "or", "order", "outer", "private", "return", "select", "set", "then", "true",
    "type", "when", "where", "with", "yield", "optional", "self"
  ]);
  const BUILTIN_TYPES = new Set([
    "text", "number", "boolean", "datetime", "binary", "any", "unknown", "Header", "Mapping", "Enum", "Seq", "Record",
    "JSON", "HTTP", "Queryable", "Text", "Math", "DateTime", "Try", "RestQuery", "RestQueryTranslation", "RestParam"
  ]);

  // Keywords are case-sensitive: Connect's own OData modules declare fields like `Type: text`.
  const isIdentifier = (s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && !KEYWORDS.has(s);

  /** Any text -> a safe Flowscript identifier (letters, digits, `_`; no leading digit; no keyword). */
  function toIdentifier(text) {
    let id = String(text == null ? "" : text).replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+(?=[A-Za-z0-9])/, "").replace(/_+$/, "");
    if (!id) id = "_empty";
    if (/^[0-9]/.test(id)) id = "_" + id;
    if (KEYWORDS.has(id)) id += "_";
    return id;
  }

  /** A record field label: bare when it is an identifier, quoted otherwise (as the OData modules
   *  do for "@odata.etag"), so JSON keys round-trip unchanged. */
  function fieldLabel(name) {
    return isIdentifier(name) ? name : `"${String(name).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  function typeList(schema) {
    if (Array.isArray(schema.type)) return schema.type;
    return schema.type ? [schema.type] : [];
  }

  function createTypeRegistry(model, options = {}) {
    const deref = model.deref;
    const namespace = options.namespace || "Api";
    const usedNames = new Set([...BUILTIN_TYPES, ...(options.reserved || [])].map((n) => n.toLowerCase()));
    const declarations = []; // { kind: "enum"|"record", name, text }
    const byKey = new Map(); // "<mode>|<ref or inline key>" -> type name
    const records = new Map(); // record name -> { fields: [{ name, kind, target }] } (response mode only)
    const mappers = new Map(); // record name -> mapper name | null
    const mapperDecls = [];
    const warnings = [];

    function claimName(wanted) {
      let base = toIdentifier(wanted);
      if (BUILTIN_TYPES.has(base)) base += "_";
      let name = base;
      for (let i = 2; usedNames.has(name.toLowerCase()); i++) name = `${base}_${i}`;
      usedNames.add(name.toLowerCase());
      return name;
    }

    function refName(ref) {
      return decodeURIComponent(ref.split("/").pop());
    }

    /** All properties/required of a schema, `allOf` parts merged in. */
    function flatten(schema, seen = new Set()) {
      const s = deref(schema);
      if (seen.has(s)) return { properties: {}, required: [] };
      seen.add(s);
      const out = { properties: { ...(s.properties || {}) }, required: [...(s.required || [])] };
      for (const part of s.allOf || []) {
        const p = flatten(part, seen);
        Object.assign(out.properties, p.properties);
        out.required.push(...p.required);
      }
      return out;
    }

    function isEnum(s) {
      return Array.isArray(s.enum) && s.enum.some((v) => typeof v === "string");
    }

    function isObjectLike(s) {
      return !!(s.properties || s.allOf || typeList(s).includes("object"));
    }

    function enumModule(schema, hint, key) {
      if (byKey.has(key)) return byKey.get(key);
      const name = claimName(hint);
      byKey.set(key, name);
      const values = [...new Set(schema.enum.filter((v) => v !== null).map(String))];
      const members = [];
      const seen = new Set();
      for (const v of values) {
        let m = toIdentifier(v);
        for (let i = 2; seen.has(m.toLowerCase()) || m === "Namespace" || m === "Value"; i++) m = `${toIdentifier(v)}_${i}`;
        seen.add(m.toLowerCase());
        members.push({ member: m, value: v });
      }
      const lit = (v) => `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
      const lines = [
        `module ${name} {`,
        `    type Namespace = '${namespace}.${name}'`,
        ...members.map((m) => `    type ${m.member} = Enum<Namespace, ${lit(m.value)}>;`),
        "",
        `    type Value = ${members.map((m) => m.member).join(" | ")};`,
        `    let values: Value* = [${members.map((m) => m.member).join(", ")}];`,
        "",
        `    let fromText = memoize(fromTextFunction(values, '${name}', _) >> unsafeCast<Value>);`,
        "};"
      ];
      declarations.push({ kind: "enum", name, text: lines.join("\n") });
      return name;
    }

    function recordType(schema, hint, key, mode) {
      if (byKey.has(key)) return byKey.get(key);
      const name = claimName(mode === "request" ? `${hint}Request` : hint);
      byKey.set(key, name); // before the fields: a self-reference resolves to this name
      const { properties, required } = flatten(schema);
      const fieldLines = [];
      const fields = [];
      for (const [prop, rawPropSchema] of Object.entries(properties)) {
        const propSchema = deref(rawPropSchema);
        if (mode === "request" && propSchema.readOnly) continue;
        if (mode === "response" && propSchema.writeOnly) continue;
        const t = typeOf(rawPropSchema, `${hint.replace(/Request$/, "")}_${prop}`, mode);
        const isRequired = required.includes(prop);
        const scalar = !t.endsWith("*") && /^(text|number|boolean|datetime|binary)$/.test(t);
        if (mode === "request") {
          fieldLines.push(`\t${isRequired ? "" : "optional "}${fieldLabel(prop)}: ${t},`);
        } else {
          fieldLines.push(`\t${fieldLabel(prop)}: ${t}${scalar && !isRequired ? "? = null" : ""},`);
          fields.push({ name: prop, type: t });
        }
      }
      declarations.push({ kind: "record", name, text: `type ${name} = {\n${fieldLines.join("\n")}\n}` });
      if (mode === "response") records.set(name, { fields });
      return name;
    }

    /** The Flowscript type for a schema. `hint` names a type made for an inline object/enum;
     *  `mode` "request" makes request-body variants (optional markers, no readOnly fields). */
    function typeOf(rawSchema, hint, mode = "response") {
      if (!rawSchema) return "any";
      const ref = rawSchema.$ref;
      const s = deref(rawSchema);
      const keyBase = ref ? `ref:${ref}` : null;
      const nameHint = ref ? refName(ref) : hint;
      if (isEnum(s)) return `${enumModule(s, nameHint, `enum|${keyBase || "inline:" + hint}`)}.Value`;
      const types = typeList(s).filter((t) => t !== "null");
      const t = types.length === 1 ? types[0] : null;
      if (t === "array" || (!t && s.items)) {
        const items = s.items || {};
        return `${typeOf(items, isEnum(deref(items)) ? hint : `${hint}Item`, mode)}*`;
      }
      if (t === "string") {
        if (s.format === "date-time" || s.format === "date") return "datetime";
        if (s.format === "binary") return "binary";
        return "text";
      }
      if (t === "integer" || t === "number") return "number";
      if (t === "boolean") return "boolean";
      if (s.oneOf || s.anyOf) {
        warnings.push(`${nameHint}: oneOf/anyOf is not typed; it became an untyped value.`);
        return "any";
      }
      if (isObjectLike(s)) {
        const { properties } = flatten(rawSchema);
        if (!Object.keys(properties).length) return "{}";
        return recordType(rawSchema, nameHint, `${mode}|${keyBase || "inline:" + hint}`, mode);
      }
      if (types.length > 1) return "any";
      return "any";
    }

    /** The mapping expression for one field value, or null when it needs none. */
    function fieldMapping(type, stack) {
      const m = type.match(/^([A-Za-z_][A-Za-z0-9_]*)(\.Value)?(\*)?$/);
      if (!m) return null;
      const [, base, isEnumValue, isSeq] = m;
      let one = null;
      if (isEnumValue) one = `${base}.fromText`;
      else if (records.has(base)) {
        const mapper = recordMapperName(base, stack);
        if (mapper) one = `(r => Record.mapValues(r, ${mapper}))`;
      }
      if (!one) return null;
      return isSeq ? `Seq.map(_, ${one})` : one;
    }

    /** The `recordMapperForX` that converts a raw row of type X (enums as text) into typed enum
     *  values, declaring it (and the ones it needs, first) on first use; null when X holds no
     *  enums. A record that refers back to itself leaves that field unmapped. */
    function recordMapperName(recordName, stack = []) {
      if (mappers.has(recordName)) return mappers.get(recordName);
      if (stack.includes(recordName)) return null;
      const rec = records.get(recordName);
      if (!rec) return null;
      const entries = [];
      for (const f of rec.fields) {
        const mapping = fieldMapping(f.type, [...stack, recordName]);
        if (mapping) entries.push(`    enumMapping('${f.name.replace(/'/g, "\\'")}', ${mapping}),`);
      }
      if (!entries.length) {
        mappers.set(recordName, null);
        return null;
      }
      const name = `recordMapperFor${recordName}`;
      mapperDecls.push([
        `private let enumMappingsFor${recordName} = [`,
        ...entries,
        "];",
        `private let ${name} = recordMappingFunction(enumMappingsFor${recordName});`
      ].join("\n"));
      mappers.set(recordName, name);
      return name;
    }

    /** Value-mapping expression for a whole response of the given type (row, list or scalar),
     *  or null when the raw value can be used as-is. */
    function responseMapping(type) {
      return fieldMapping(type, []);
    }

    return {
      typeOf,
      recordMapperName,
      responseMapping,
      isRecord: (name) => records.has(name),
      declarations: () => declarations.slice(),
      mapperDeclarations: () => mapperDecls.slice(),
      warnings: () => warnings.slice(),
      claimName
    };
  }

  const api = { createTypeRegistry, toIdentifier, fieldLabel, isIdentifier, KEYWORDS };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.ApiFlowTypes = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
