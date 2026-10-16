const test = require("node:test");
const assert = require("node:assert/strict");
// ifs-modules.js references FlowDependencyTracer as a bare global (browser convention: loaded
// via a separate <script> tag) — set it up manually before any test calls substituteLiteral.
global.FlowDependencyTracer = require("./flow-dependency-tracer.js");
const {
  parseCategoryList,
  resolveCategorizedProjectionUrl,
  queryProjectionMeta,
  substituteLiteral,
  normalizeConfirmedMappings,
  serializeConfirmedMappings,
  partitionCandidatesByConfirmation,
  CONFIRMED_MAPPING_THRESHOLD,
  applyOptionalFieldWorkaround,
  applyAnyTypedFieldWorkaround,
  pickListDisplayFields
} = require("./ifs-modules.js");

test("parseCategoryList splits ProjExplorerQuerySet's comma-separated Categories field, trimming whitespace", () => {
  assert.deepEqual(parseCategoryList("Integration, ExternalB2B"), ["Integration", "ExternalB2B"]);
  assert.deepEqual(parseCategoryList("Integration"), ["Integration"]);
});

test("parseCategoryList returns an empty list for null/empty/blank input", () => {
  assert.deepEqual(parseCategoryList(null), []);
  assert.deepEqual(parseCategoryList(""), []);
  assert.deepEqual(parseCategoryList("  , , "), []);
});

/* ---------- resolveCategorizedProjectionUrl (real ProjectionExplorer dispatch, confirmed 2026-08-06) ---------- */

function mockFetch(responsesByFunctionName) {
  const calls = [];
  return {
    calls,
    fetchFn: async (url) => {
      const match = /ProjectionExplorer\.svc\/([A-Za-z0-9]+)\(/.exec(url);
      const functionName = match ? match[1] : null;
      calls.push(functionName);
      const value = Object.prototype.hasOwnProperty.call(responsesByFunctionName, functionName)
        ? responsesByFunctionName[functionName]
        : null;
      return { ok: true, json: async () => ({ value }) };
    }
  };
}

test("resolveCategorizedProjectionUrl calls ONLY the Int function for an Integration-only category — never Main (regression: real CustomerOrderAddressEntity bug, Main returned a truthy-but-wrong /main/.../entity/v1/... URL)", async () => {
  const { calls, fetchFn } = mockFetch({ GetServiceUrlInt: "https://uatifs.hima.com/int/ifsapplications/entity/v1/CustomerOrderAddressEntity.svc" });
  const originalFetch = global.fetch;
  global.fetch = fetchFn;
  try {
    const url = await resolveCategorizedProjectionUrl("https://uatifs.hima.com", "token", "CustomerOrderAddressEntity", "Integration", "GetServiceUrl");
    assert.equal(url, "https://uatifs.hima.com/int/ifsapplications/entity/v1/CustomerOrderAddressEntity.svc");
    assert.deepEqual(calls, ["GetServiceUrlInt"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("resolveCategorizedProjectionUrl calls ONLY the B2b function for an ExternalB2B-only category", async () => {
  const { calls, fetchFn } = mockFetch({ GetServiceUrlB2b: "https://example/b2b-url" });
  const originalFetch = global.fetch;
  global.fetch = fetchFn;
  try {
    const url = await resolveCategorizedProjectionUrl("https://example", "token", "SomeB2BProjection", "ExternalB2B", "GetServiceUrl");
    assert.equal(url, "https://example/b2b-url");
    assert.deepEqual(calls, ["GetServiceUrlB2b"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("resolveCategorizedProjectionUrl calls ONLY Main when a projection has neither special category (the common case, unchanged)", async () => {
  const { calls, fetchFn } = mockFetch({ GetServiceUrlMain: "https://example/main-url" });
  const originalFetch = global.fetch;
  global.fetch = fetchFn;
  try {
    const url = await resolveCategorizedProjectionUrl("https://example", "token", "SalesQuotationHandling", "", "GetServiceUrl");
    assert.equal(url, "https://example/main-url");
    assert.deepEqual(calls, ["GetServiceUrlMain"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("resolveCategorizedProjectionUrl tries Main FIRST when a projection carries BOTH categories at once, and only falls back to the category-specific function if Main comes back empty (explicit instruction, 2026-08-06)", async () => {
  const { calls, fetchFn } = mockFetch({ GetServiceUrlMain: null, GetServiceUrlInt: "https://example/int-url" });
  const originalFetch = global.fetch;
  global.fetch = fetchFn;
  try {
    const url = await resolveCategorizedProjectionUrl("https://example", "token", "AmbiguousProjection", "Integration,ExternalB2B", "GetServiceUrl");
    assert.equal(url, "https://example/int-url");
    assert.deepEqual(calls, ["GetServiceUrlMain", "GetServiceUrlInt"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("resolveCategorizedProjectionUrl stops at Main when it succeeds, even with both categories present — no unnecessary fallback call", async () => {
  const { calls, fetchFn } = mockFetch({ GetServiceUrlMain: "https://example/main-url" });
  const originalFetch = global.fetch;
  global.fetch = fetchFn;
  try {
    const url = await resolveCategorizedProjectionUrl("https://example", "token", "AmbiguousProjection", "Integration,ExternalB2B", "GetServiceUrl");
    assert.equal(url, "https://example/main-url");
    assert.deepEqual(calls, ["GetServiceUrlMain"]);
  } finally {
    global.fetch = originalFetch;
  }
});

/* ---------- queryProjectionMeta (real bug, confirmed 2026-08-06 via CustomerOrderAddressEntity) ---------- */

test("queryProjectionMeta filters with tolower(ProjectionName) against a LOWERCASED search term, not toupper/uppercase (regression: real bug — the toupper form returned zero rows for a real Entity-kind projection that tolower correctly finds)", async () => {
  let requestedUrl = null;
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      json: async () => ({
        value: [{
          ProjectionName: "CustomerOrderAddressEntity",
          Component: "ORDER",
          ApiClass: "StandardEntity",
          Active: "Yes",
          Deprecated: false,
          Categories: "Integration"
        }]
      })
    };
  };
  try {
    const meta = await queryProjectionMeta("https://uatifs.hima.com", "token", "CustomerOrderAddressEntity");
    assert.match(requestedUrl, /tolower\(ProjectionName\)/);
    assert.match(requestedUrl, /'customerorderaddressentity'/);
    assert.doesNotMatch(requestedUrl, /toupper\(ProjectionName\)/);
    assert.equal(meta.Categories, "Integration");
  } finally {
    global.fetch = originalFetch;
  }
});

test("resolveCategorizedProjectionUrl works identically for the OpenAPI function family (GetOpenApiV3Url*) via the same functionPrefix parameter", async () => {
  const { calls, fetchFn } = mockFetch({ GetOpenApiV3UrlInt: "https://example/openapi-int" });
  const originalFetch = global.fetch;
  global.fetch = fetchFn;
  try {
    const url = await resolveCategorizedProjectionUrl("https://example", "token", "CustomerOrderAddressEntity", "Integration", "GetOpenApiV3Url");
    assert.equal(url, "https://example/openapi-int");
    assert.deepEqual(calls, ["GetOpenApiV3UrlInt"]);
  } finally {
    global.fetch = originalFetch;
  }
});

/* ---------- substituteLiteral (field-name-qualified user-input/list-selection substitution) ---------- */

test("substituteLiteral replaces the occurrence next to its own field name, not an unrelated earlier field sharing the same literal value (real bug: 3+ PATCH steps in one recording sharing a value like '0' or a customer number across unrelated fields)", () => {
  const script = 'let x = { Contract: "0", OrderNo: "12345", RowNo: "0" };';
  // The unqualified indexOf("0") would hit the middle of "12345"'s neighbor scan or the FIRST
  // "0" (Contract), not RowNo's "0" — corrupting the script instead of substituting RowNo.
  const result = substituteLiteral(script, "RowNo", '"0"', "rowNoInput");
  assert.equal(result, 'let x = { Contract: "0", OrderNo: "12345", RowNo: rowNoInput };');
});

test("substituteLiteral falls back to a bare literal search when no 'FieldName: literal' match exists (e.g. the literal appears inside a $filter expression, not a plain field assignment)", () => {
  const script = "let x = CustomerTbl.filter(c => c.CustomerNo == \"123\");";
  const result = substituteLiteral(script, "CustomerNo", "\"123\"", "customerNoInput");
  assert.equal(result, "let x = CustomerTbl.filter(c => c.CustomerNo == customerNoInput);");
});

test("substituteLiteral falls back to a bare literal search when slotPath is undefined (callers without field-name context)", () => {
  const script = 'let x = { Value: "abc" };';
  const result = substituteLiteral(script, undefined, '"abc"', "valueInput");
  assert.equal(result, "let x = { Value: valueInput };");
});

test("substituteLiteral returns the script unchanged when the literal isn't found anywhere", () => {
  const script = 'let x = { Value: "abc" };';
  const result = substituteLiteral(script, "Value", '"zzz"', "valueInput");
  assert.equal(result, script);
});

/* ---------- semi-self-learning confirmed mappings (feature request, 2026-08-08) ---------- */

test("normalizeConfirmedMappings returns an empty Map for undefined/missing stored data", () => {
  assert.deepEqual(normalizeConfirmedMappings(undefined), new Map());
});

test("normalizeConfirmedMappings migrates the old Set-of-strings shape to count=THRESHOLD each (already-confirmed mappings keep auto-applying, don't reset to zero)", () => {
  const result = normalizeConfirmedMappings(["A::B::C::D", "E::F::G::H"]);
  assert.deepEqual(result, new Map([
    ["A::B::C::D", CONFIRMED_MAPPING_THRESHOLD],
    ["E::F::G::H", CONFIRMED_MAPPING_THRESHOLD]
  ]));
});

test("normalizeConfirmedMappings reads the new [key, count] pair-array shape as-is", () => {
  const result = normalizeConfirmedMappings([["A::B::C::D", 1], ["E::F::G::H", 2]]);
  assert.deepEqual(result, new Map([["A::B::C::D", 1], ["E::F::G::H", 2]]));
});

test("serializeConfirmedMappings converts a Map to a [key, count] pair array for storage", () => {
  const map = new Map([["A::B::C::D", 1], ["E::F::G::H", 2]]);
  assert.deepEqual(serializeConfirmedMappings(map), [["A::B::C::D", 1], ["E::F::G::H", 2]]);
});

test("serializeConfirmedMappings round-trips through normalizeConfirmedMappings unchanged", () => {
  const map = new Map([["A::B::C::D", 1]]);
  assert.deepEqual(normalizeConfirmedMappings(serializeConfirmedMappings(map)), map);
});

test("partitionCandidatesByConfirmation auto-applies a candidate confirmed at or above the threshold, and sends a below-threshold or never-seen candidate back for review", () => {
  const counts = new Map([["seen-enough", CONFIRMED_MAPPING_THRESHOLD], ["seen-once", 1]]);
  const candidates = [{ key: "seen-enough" }, { key: "seen-once" }, { key: "never-seen" }];
  const { autoApply, needsReview } = partitionCandidatesByConfirmation(candidates, counts, (c) => c.key);
  assert.deepEqual(autoApply, [{ key: "seen-enough" }]);
  assert.deepEqual(needsReview, [{ key: "seen-once" }, { key: "never-seen" }]);
});

/* ---------- applyOptionalFieldWorkaround (TEMPORARY workaround for a real Novacura Flow
   generator/compiler bug, 2026-08-09 — see the flag's comment in ifs-modules.js) ---------- */

test("applyOptionalFieldWorkaround marks a field 'optional' when OpenAPI's schema for its type doesn't list it as required", () => {
  const flowScriptCode = `type CustomerDefaultsStructure = {\n  Company: text = null,\n  OrderConfFlag: PrintOrderConfirmation.Value,\n  OrderNo: text\n};`;
  const openApiJson = JSON.stringify({
    components: {
      schemas: {
        CustomerDefaultsStructure: {
          type: "object",
          required: ["OrderNo"],
          properties: { Company: {}, OrderConfFlag: {}, OrderNo: {} }
        }
      }
    }
  });
  const result = applyOptionalFieldWorkaround(flowScriptCode, openApiJson);
  assert.match(result, /optional Company: text = null/);
  assert.match(result, /optional OrderConfFlag: PrintOrderConfirmation\.Value/);
  assert.doesNotMatch(result, /optional OrderNo: text/); // required — left alone
});

test("applyOptionalFieldWorkaround leaves a field already marked 'optional' untouched (no double-prefix)", () => {
  const flowScriptCode = `type Foo = {\n  optional Bar: text\n};`;
  const openApiJson = JSON.stringify({
    components: { schemas: { Foo: { type: "object", required: [], properties: { Bar: {} } } } }
  });
  const result = applyOptionalFieldWorkaround(flowScriptCode, openApiJson);
  assert.equal((result.match(/optional/g) || []).length, 1);
});

test("applyOptionalFieldWorkaround leaves a type with no matching OpenAPI schema completely untouched", () => {
  const flowScriptCode = `type Unmapped = {\n  Field: text\n};`;
  const openApiJson = JSON.stringify({ components: { schemas: { SomethingElse: { properties: {} } } } });
  assert.equal(applyOptionalFieldWorkaround(flowScriptCode, openApiJson), flowScriptCode);
});

test("applyOptionalFieldWorkaround leaves a field the OpenAPI schema doesn't declare as a property at all untouched (e.g. @odata.etag)", () => {
  const flowScriptCode = `type Foo = {\n  @odata.etag: text,\n  Bar: text\n};`;
  const openApiJson = JSON.stringify({
    components: { schemas: { Foo: { type: "object", required: [], properties: { Bar: {} } } } }
  });
  const result = applyOptionalFieldWorkaround(flowScriptCode, openApiJson);
  assert.doesNotMatch(result, /optional @odata\.etag/);
  assert.match(result, /optional Bar: text/);
});

test("applyOptionalFieldWorkaround is a safe no-op for an empty/missing/unparsable OpenAPI spec", () => {
  const flowScriptCode = `type Foo = { Bar: text };`;
  assert.equal(applyOptionalFieldWorkaround(flowScriptCode, ""), flowScriptCode);
  assert.equal(applyOptionalFieldWorkaround(flowScriptCode, "not json"), flowScriptCode);
  assert.equal(applyOptionalFieldWorkaround(flowScriptCode, null), flowScriptCode);
});

test("applyOptionalFieldWorkaround handles the real multi-field CustomerDefaultsStructure shape end-to-end, marking every non-required field including ones with no generator-given default at all", () => {
  const flowScriptCode = [
    "type CustomerDefaultsStructure = {",
    "\tShipAddrNo: text = null,",
    "\tOrderConfFlag: PrintOrderConfirmation.Value,",
    "\tPickListFlag: PrintPickList.Value,",
    "\tContract: text",
    "};"
  ].join("\n");
  const openApiJson = JSON.stringify({
    components: {
      schemas: {
        CustomerDefaultsStructure: {
          type: "object",
          // Real IFS metadata for this type: required is empty except a caller-supplied key,
          // matching the real GetCustomerDefaults case investigated live.
          required: ["Contract"],
          properties: { ShipAddrNo: {}, OrderConfFlag: {}, PickListFlag: {}, Contract: {} }
        }
      }
    }
  });
  const result = applyOptionalFieldWorkaround(flowScriptCode, openApiJson);
  assert.match(result, /optional ShipAddrNo: text = null/);
  assert.match(result, /optional OrderConfFlag: PrintOrderConfirmation\.Value/);
  assert.match(result, /optional PickListFlag: PrintPickList\.Value/);
  assert.doesNotMatch(result, /optional Contract: text/);
});

test("applyOptionalFieldWorkaround never touches a type used as a Queryable's ROW type — real bug, 2026-08-09: CustOrdCust6 (Reference_CustOrdCust6's row type) got its own KEY fields (Company, CustomerNo — non-optional per its CustOrdCust6_Keys companion type) marked optional too, because OpenAPI's schema for a plain OData row/read type generally doesn't mark ANY field required, keys included — that type is never constructed as a {...} literal by generated code, so the missing-field-in-a-literal problem this workaround exists for never applies to it", () => {
  const flowScriptCode = [
    "let Reference_CustOrdCust6 = Queryable.Create<ODataQueryTranslation, CustOrdCust6, text>(x, y);",
    "type CustOrdCust6 = {",
    "\tCompany: text,",
    "\tCustomerNo: text,",
    "\tName: text? = null",
    "};",
    "type CustOrdCust6_Keys = {",
    "\tCompany: text,",
    "\tCustomerNo: text",
    "};"
  ].join("\n");
  const openApiJson = JSON.stringify({
    components: {
      schemas: {
        // Real quirk: OpenAPI's row-type schema marks nothing required, keys included.
        CustOrdCust6: { type: "object", required: [], properties: { Company: {}, CustomerNo: {}, Name: {} } }
      }
    }
  });
  const result = applyOptionalFieldWorkaround(flowScriptCode, openApiJson);
  assert.doesNotMatch(result, /optional Company: text/);
  assert.doesNotMatch(result, /optional CustomerNo: text/);
  assert.doesNotMatch(result, /optional Name: text\? = null/);
});

test("applyOptionalFieldWorkaround still applies normally to a non-row type declared alongside an unrelated Queryable in the same module", () => {
  const flowScriptCode = [
    "let OrderQuotationSet = Queryable.Create<ODataQueryTranslation, OrderQuotation, text>(x, y);",
    "type OrderQuotation = { QuotationNo: text };",
    "type CustomerDefaultsStructure = { Priority: number = null };"
  ].join("\n");
  const openApiJson = JSON.stringify({
    components: {
      schemas: {
        OrderQuotation: { type: "object", required: [], properties: { QuotationNo: {} } },
        CustomerDefaultsStructure: { type: "object", required: [], properties: { Priority: {} } }
      }
    }
  });
  const result = applyOptionalFieldWorkaround(flowScriptCode, openApiJson);
  assert.doesNotMatch(result, /optional QuotationNo: text/); // row type — untouched
  assert.match(result, /optional Priority: number = null/); // ordinary type — still fixed
});

/* ---------- applyAnyTypedFieldWorkaround (TEMPORARY workaround, same family as
   applyOptionalFieldWorkaround above — real Novacura Flow generator bug: an action/function's
   own complex-typed parameter gets generated as a bare `any` even though both CSDL and OpenAPI
   declare a real, fully-typed struct for it. Real case, confirmed live against actual captured
   CustomerOrderHandling metadata, 2026-08-10: CalculateAndFetchAvailableQty's ValidationRec
   parameter, declared IfsApp.CustomerOrderHandling.CustOrdLineValidation in real IFS metadata (a
   real struct with ~150 real typed fields, including Identity4: Edm.Decimal and AddrFlag: a real
   GenYesNo enum ref), comes out as `optional ValidationRec: any`. ---------- */

test("applyAnyTypedFieldWorkaround replaces a bare `any` field's type with the real OpenAPI-$ref'd type, keeping the exact same field name, and synthesizes that type from the ref target's real properties — real case, ValidationRec/CustOrdLineValidation", () => {
  const flowScriptCode = "type CalculateAndFetchAvailableQtyActionImportRequest = {\n\toptional ValidationRec: any,\n};";
  const openApiJson = JSON.stringify({
    components: {
      schemas: {
        // Real: OpenAPI's schema name drops the "Request" suffix Flow's generator adds.
        CalculateAndFetchAvailableQtyActionImport: {
          type: "object",
          properties: { ValidationRec: { $ref: "#/components/schemas/CustOrdLineValidation" } }
        },
        CustOrdLineValidation: {
          type: "object",
          properties: {
            Identity4: { type: "number", example: 1 },
            ConvFactor: { type: "number", example: 1 },
            CatalogNo: { type: "string", example: "It is a Text" },
            AddrFlag: { $ref: "#/components/schemas/IfsApp.CustomerOrderHandling.GenYesNo" }
          }
        },
        "IfsApp.CustomerOrderHandling.GenYesNo": { type: "string", enum: ["Yes", "No"] }
      }
    }
  });
  const result = applyAnyTypedFieldWorkaround(flowScriptCode, openApiJson);
  // Same field NAME, same position — only the type token changed.
  assert.match(result, /optional ValidationRec: CustOrdLineValidation,/);
  assert.doesNotMatch(result, /ValidationRec: any/);
  // The synthesized type, appended, with real field types and every field marked optional
  // (OpenAPI's own "required" list for this kind of structure is empty in the real capture).
  assert.match(result, /type CustOrdLineValidation = \{/);
  assert.match(result, /optional Identity4: number/);
  assert.match(result, /optional ConvFactor: number/);
  assert.match(result, /optional CatalogNo: text/);
  assert.match(result, /optional AddrFlag: GenYesNo\.Value/);
});

test("applyAnyTypedFieldWorkaround marks a synthesized field as required (no `optional`) when OpenAPI's schema for the ref target actually lists it", () => {
  const flowScriptCode = "type FooActionImportRequest = {\n\toptional Rec: any,\n};";
  const openApiJson = JSON.stringify({
    components: {
      schemas: {
        FooActionImport: { type: "object", properties: { Rec: { $ref: "#/components/schemas/RecShape" } } },
        RecShape: { type: "object", required: ["MustHave"], properties: { MustHave: { type: "string" }, Optional: { type: "number" } } }
      }
    }
  });
  const result = applyAnyTypedFieldWorkaround(flowScriptCode, openApiJson);
  assert.match(result, /type RecShape = \{\n {2}MustHave: text,\n {2}optional Optional: number\n\}/);
});

test("applyAnyTypedFieldWorkaround only ever synthesizes ONE copy of a referenced type even when it's used by multiple any-typed fields (real case: CustOrdLineValidation is referenced by both CalculateAndFetchAvailableQty AND ValidatePriceEffectivityDate in the real module)", () => {
  const flowScriptCode = [
    "type FirstActionImportRequest = { optional Rec: any };",
    "type SecondActionImportRequest = { optional Rec: any };"
  ].join("\n");
  const openApiJson = JSON.stringify({
    components: {
      schemas: {
        FirstActionImport: { type: "object", properties: { Rec: { $ref: "#/components/schemas/Shared" } } },
        SecondActionImport: { type: "object", properties: { Rec: { $ref: "#/components/schemas/Shared" } } },
        Shared: { type: "object", properties: { X: { type: "number" } } }
      }
    }
  });
  const result = applyAnyTypedFieldWorkaround(flowScriptCode, openApiJson);
  assert.equal((result.match(/type Shared = /g) || []).length, 1);
  assert.match(result, /optional Rec: Shared/);
  assert.equal((result.match(/optional Rec: Shared/g) || []).length, 2);
});

test("applyAnyTypedFieldWorkaround leaves a field untouched when it's already properly typed (not `any`)", () => {
  const flowScriptCode = "type FooActionImportRequest = { optional Rec: SomeRealType };";
  const openApiJson = JSON.stringify({
    components: { schemas: { FooActionImport: { type: "object", properties: { Rec: { $ref: "#/components/schemas/RecShape" } } }, RecShape: { type: "object", properties: { X: { type: "number" } } } } }
  });
  assert.equal(applyAnyTypedFieldWorkaround(flowScriptCode, openApiJson), flowScriptCode);
});

test("applyAnyTypedFieldWorkaround leaves `any` untouched when OpenAPI's own field isn't a $ref, or its ref target has no resolvable properties", () => {
  const noRef = "type FooActionImportRequest = { optional Rec: any };";
  const noRefApi = JSON.stringify({ components: { schemas: { FooActionImport: { type: "object", properties: { Rec: { type: "string" } } } } } });
  assert.equal(applyAnyTypedFieldWorkaround(noRef, noRefApi), noRef);

  const enumRef = "type FooActionImportRequest = { optional Rec: any };";
  const enumRefApi = JSON.stringify({
    components: {
      schemas: {
        FooActionImport: { type: "object", properties: { Rec: { $ref: "#/components/schemas/JustAnEnum" } } },
        JustAnEnum: { type: "string", enum: ["A", "B"] } // no properties — a plain enum, not an object
      }
    }
  });
  assert.equal(applyAnyTypedFieldWorkaround(enumRef, enumRefApi), enumRef);
});

test("applyAnyTypedFieldWorkaround is a safe no-op for an empty/missing/unparsable OpenAPI spec, or no matching schema at all", () => {
  const flowScriptCode = "type FooActionImportRequest = { optional Rec: any };";
  assert.equal(applyAnyTypedFieldWorkaround(flowScriptCode, ""), flowScriptCode);
  assert.equal(applyAnyTypedFieldWorkaround(flowScriptCode, "not json"), flowScriptCode);
  assert.equal(applyAnyTypedFieldWorkaround(flowScriptCode, null), flowScriptCode);
  assert.equal(applyAnyTypedFieldWorkaround(flowScriptCode, JSON.stringify({ components: { schemas: {} } })), flowScriptCode);
});

/* ---------- pickListDisplayFields, real bug, live, 2026-08-12: the loose /name|desc/i substring
   match picked `luname` — IFS's own internal metadata field (present on nearly every entity,
   always lowercase) — for a list-selection control's largeRowText, since "luname" literally
   contains "name" as a substring. Not user-meaningful at all. User caught it directly comparing
   the real submitted designer data: "largeRowText: {luname} i don't think we have a variable
   LuName here, right?" ---------- */

test("pickListDisplayFields does NOT pick a lowercase internal field (luname) as the readable large-text field, even though it substring-matches \"name\" — real case, Reference_ApplicationLanguage", () => {
  const result = pickListDisplayFields(["luname", "keyref", "LanguageCode", "Description"], "LanguageCode");
  assert.equal(result.largeField, "Description");
  assert.equal(result.smallField, "LanguageCode");
});

test("pickListDisplayFields still picks a genuine PascalCase name/description field when one exists", () => {
  assert.equal(pickListDisplayFields(["CustomerNo", "CustomerName", "luname"], "CustomerNo").largeField, "CustomerName");
  assert.equal(pickListDisplayFields(["PartNo", "Description", "luname"], "PartNo").largeField, "Description");
});

test("pickListDisplayFields falls back to the first PascalCase field when none look like a name/description field, and only falls back to a lowercase field as an absolute last resort", () => {
  assert.equal(pickListDisplayFields(["luname", "Contract", "OrderNo"], "OrderNo").largeField, "Contract");
  assert.equal(pickListDisplayFields(["luname", "keyref"], "OrderNo").largeField, "luname"); // nothing PascalCase available at all
});

test("the recorder's instance functions read and write the shared Basic Data store", async () => {
  const local = {}, session = {};
  const area = (backing) => ({
    async get(keys) { const out = {}; for (const k of [].concat(keys)) if (k in backing) out[k] = backing[k]; return out; },
    async set(obj) { Object.assign(backing, obj); }
  });
  global.chrome = { storage: { local: area(local), session: area(session) } };
  global.CredentialCrypto = require("../lib/credential-crypto.js");
  global.IfsInstances = require("../lib/ifs-instances.js");
  global.fetch = async () => ({ ok: true, json: async () => ({ access_token: "tok", expires_in: 3600 }) });
  delete require.cache[require.resolve("./ifs-modules.js")];
  try {
    const mod = require("./ifs-modules.js");

    const key = await mod.ensureMasterKey(async () => "pw");
    await mod.saveIfsInstance("https://ifs.example.com", "client_credentials", "https://ifs.example.com/token", "client-1", { clientSecret: "s" }, key);

    assert.deepEqual(Object.keys(local.ifsInstances), ["https://ifs.example.com"]);
    assert.equal(local.ifsInstances["https://ifs.example.com"].name, "ifs.example.com", "named, not a nameless duplicate");
    assert.equal((await mod.getIfsInstance("https://ifs.example.com/")).clientId, "client-1");
    assert.equal(await mod.getIfsAuthToken("https://ifs.example.com", key), "tok");
  } finally {
    delete global.chrome; delete global.fetch; delete global.CredentialCrypto; delete global.IfsInstances;
    delete require.cache[require.resolve("./ifs-modules.js")];
  }
});
