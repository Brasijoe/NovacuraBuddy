const test = require("node:test");
const assert = require("node:assert/strict");
const {
  stripUrlOrigin,
  extractSvcName,
  pathAfterSvc,
  splitKeyValues,
  keyValueToLiteral,
  keyValueToJs,
  toFlowScriptLiteral,
  enumModuleName,
  formatValueForType,
  buildRecordLiteral,
  collectValueSlots,
  findFunctionSignature,
  classifyFlowType,
  findRecordTypeFields,
  findFunctionBody,
  buildRawContextualCallScript,
  buildNavigationQueryableScript,
  buildNavigationChildWriteScript,
  disambiguateLocalName,
  findQueryableRowType,
  deriveWriteCandidates,
  buildGetScript,
  buildWhereClause,
  extractODataFilter,
  buildCallScript,
  buildInlineRecordLet,
  splitKeyNames,
  findFunctionOverloads,
  scoreOverloadMatch,
  findBestMatchingOverload,
  getHeader,
  extractBatchBoundary,
  isBatchCall,
  splitMultipartParts,
  parseBatchPartRequestLine,
  rawQuotedODataValue,
  buildBatchIfsFunctionExpr,
  buildBatchPart
} = require("./flow-call-script.js");

test("extractSvcName reads the service name from a URL", () => {
  assert.equal(extractSvcName("https://x.example.com/main/ifsapplications/projection/v1/SalesQuotationHandling.svc/OrderQuotationSet"), "SalesQuotationHandling");
});

test("pathAfterSvc strips the query string and leading slash", () => {
  assert.equal(pathAfterSvc("https://x.example.com/.../Foo.svc/OrderQuotationSet('123')?$expand=Bar"), "OrderQuotationSet('123')");
});

test("pathAfterSvc returns empty string for a bare service root", () => {
  assert.equal(pathAfterSvc("https://x.example.com/.../Foo.svc"), "");
});

test("splitKeyValues handles a single unnamed key", () => {
  assert.deepEqual(splitKeyValues("'12345'"), ["'12345'"]);
});

test("splitKeyValues handles named, comma-separated compound keys", () => {
  assert.deepEqual(splitKeyValues("QuotationNo='Q1',LineNo='10'"), ["'Q1'", "'10'"]);
});

test("splitKeyNames extracts each key segment's name", () => {
  assert.deepEqual(splitKeyNames("ValidationRec=@ValidationRec,DeliveryAddress=true"), ["ValidationRec", "DeliveryAddress"]);
});

test("splitKeyNames skips an unnamed single key (no Name= prefix)", () => {
  assert.deepEqual(splitKeyNames("'Q1'"), []);
});

test("findFunctionOverloads finds a bare function name and its numbered-suffix variants (real case, 2026-08-08: ValidateAddressNo / ValidateAddressNo_0)", () => {
  const source = [
    `function ValidateAddressNo(orderNo: text, headers: Header* = []): AddressDetailStructure {`,
    `function ValidateAddressNo_0(validationRec: AddressStructure, headers: Header* = []): AddressStructure {`
  ].join("\n");
  const overloads = findFunctionOverloads(source, "ValidateAddressNo");
  assert.equal(overloads.length, 2);
  assert.deepEqual(overloads.map((s) => s.name).sort(), ["ValidateAddressNo", "ValidateAddressNo_0"]);
});

test("findFunctionOverloads returns a single-element array when there's no overload", () => {
  const source = `function OrderQuotationSet_Update(QuotationNo: text, headers: Header* = []): text {`;
  const overloads = findFunctionOverloads(source, "OrderQuotationSet_Update");
  assert.equal(overloads.length, 1);
});

test("findFunctionOverloads returns an empty array when the base name doesn't exist at all", () => {
  assert.deepEqual(findFunctionOverloads("function Unrelated() {}", "DoesNotExist"), []);
});

test("scoreOverloadMatch counts case-insensitive matches between a signature's own param names and the recorded key names", () => {
  const flatSig = { name: "ValidateAddressNo", params: [{ name: "orderNo" }, { name: "shipAddrNo" }, { name: "headers" }] };
  const recSig = { name: "ValidateAddressNo_0", params: [{ name: "validationRec" }, { name: "deliveryAddress" }, { name: "headers" }] };
  const keyNames = ["ValidationRec", "DeliveryAddress"];
  assert.equal(scoreOverloadMatch(flatSig, keyNames), 0);
  assert.equal(scoreOverloadMatch(recSig, keyNames), 2);
});

test("findBestMatchingOverload picks the higher-scoring overload — real case, 2026-08-08: ValidateAddressNo(OrderNo=...) params never match, ValidateAddressNo_0's ValidationRec-shaped params match all 6 recorded key names", () => {
  const source = [
    `function ValidateAddressNo(orderNo: text, lineNo: text, relNo: text, lineItemNo: number, shipAddrNo: text, addrFlag: GenYesNo.Value, defaultAddrFlag: GenYesNo.Value, deliveryLeadtime: number, pickingLeadtime: number, shipmentCreation: ShipmentCreationCustomerOrder.Value, headers: Header* = []): AddressDetailStructure {`,
    `function ValidateAddressNo_0(validationRec: AddressStructure, deliveryAddress: boolean, documentAddress: boolean, validatingCustomer: boolean, agreementChanged: text, shipAddrNoChanged: text, headers: Header* = []): AddressStructure {`
  ].join("\n");
  const keyNames = ["ValidationRec", "DeliveryAddress", "DocumentAddress", "ValidatingCustomer", "AgreementChanged", "ShipAddrNoChanged"];
  const best = findBestMatchingOverload(source, "ValidateAddressNo", keyNames);
  assert.equal(best.name, "ValidateAddressNo_0");
});

test("findBestMatchingOverload falls back to the first overload when no key names are given (e.g. a call with no key segment at all)", () => {
  const source = `function Foo(a: text, headers: Header* = []): text {\nfunction Foo_0(b: text, headers: Header* = []): text {`;
  const best = findBestMatchingOverload(source, "Foo", []);
  assert.ok(best.name === "Foo" || best.name === "Foo_0");
});

test("findBestMatchingOverload returns null when the candidate name has no match at all", () => {
  assert.equal(findBestMatchingOverload("function Unrelated() {}", "DoesNotExist", []), null);
});

test("keyValueToLiteral unwraps a quoted OData string literal", () => {
  assert.equal(keyValueToLiteral("'Q1'"), '"Q1"');
});

test("keyValueToLiteral passes a numeric literal through as-is", () => {
  assert.equal(keyValueToLiteral("123"), "123");
});

test("keyValueToLiteral renders OData's bare null keyword as FlowScript null, not the quoted text \"null\" (real bug, 2026-08-07: ValidateClassificationDefaults(Param1=null,...) — 4 null key params all rendered as literal 4-char string \"null\")", () => {
  assert.equal(keyValueToLiteral("null"), "null");
});

test("keyValueToLiteral still quotes a real string value that happens to spell \"null\" in single quotes (OData's own way to mean the literal text, not the null keyword)", () => {
  assert.equal(keyValueToLiteral("'null'"), '"null"');
});

test("keyValueToLiteral renders OData's bare true/false keywords as FlowScript boolean literals, not quoted text (real bug, 2026-08-08: ValidateAddressNo(...,DeliveryAddress=true,...) rendered \"true\" as the 4-char text string instead of the boolean keyword — same class of bug as the null-keyword fix, just never hit until a call with a bare boolean key value came up)", () => {
  assert.equal(keyValueToLiteral("true"), "true");
  assert.equal(keyValueToLiteral("false"), "false");
});

test("keyValueToLiteral still quotes a real string value that happens to spell \"true\"/\"false\" in single quotes", () => {
  assert.equal(keyValueToLiteral("'true'"), '"true"');
  assert.equal(keyValueToLiteral("'false'"), '"false"');
});

test("keyValueToLiteral URL-decodes a quoted string value (real bug, 2026-08-07: 'NC%20LABS' rendered literally as \"NC%20LABS\" instead of \"NC LABS\")", () => {
  assert.equal(keyValueToLiteral("'NC%20LABS'"), '"NC LABS"');
});

test("keyValueToLiteral extracts just the value from an OData namespace-qualified enum literal (real bug, 2026-08-07: IfsApp.SalesQuotationHandling.Lookup_IsoCountry'US' embedded whole instead of just \"US\" — the plain-quoted-string regex requires the string to START with a quote, this format has a namespace path before it)", () => {
  assert.equal(keyValueToLiteral("IfsApp.SalesQuotationHandling.Lookup_IsoCountry'US'"), '"US"');
});

test("toFlowScriptLiteral renders an object with unquoted keys, one entry per line (2026-08-10: requested for readability, matching the top-level record treatment)", () => {
  assert.equal(toFlowScriptLiteral({ CustomerNo: "16789", Qty: 3 }), '{\n  CustomerNo: "16789",\n  Qty: 3\n}');
});

test("toFlowScriptLiteral renders nested objects and arrays, indenting one step deeper per nesting level", () => {
  assert.equal(toFlowScriptLiteral({ Lines: [{ Qty: 1 }] }), '{\n  Lines: [\n    {\n      Qty: 1\n    }\n  ]\n}');
});

test("toFlowScriptLiteral renders an empty object/array compactly (no pointless line breaks)", () => {
  assert.equal(toFlowScriptLiteral({}), "{}");
  assert.equal(toFlowScriptLiteral([]), "[]");
});

test("findFunctionSignature parses a simple key+input+headers signature", () => {
  const source = `function OrderQuotationSet_Update(QuotationNo:text, input: OrderQuotationUpdateRequest, headers: Header* = []): OrderQuotationCopyValuesStructure {`;
  const sig = findFunctionSignature(source, "OrderQuotationSet_Update");
  assert.equal(sig.name, "OrderQuotationSet_Update");
  assert.deepEqual(sig.params.map((p) => p.name), ["QuotationNo", "input", "headers"]);
  assert.equal(sig.params[1].type, "OrderQuotationUpdateRequest");
});

test("findFunctionSignature returns null when the function isn't in the source", () => {
  assert.equal(findFunctionSignature("function Foo() {}", "Bar"), null);
});

test("findFunctionSignature captures the declared return type", () => {
  const source = `function GetCustomerDefaults(P1: text): CustomerDefaultsStructure {`;
  assert.equal(findFunctionSignature(source, "GetCustomerDefaults").returnType, "CustomerDefaultsStructure");
});

test("findFunctionSignature returns a null returnType when the function has none declared", () => {
  const source = `function Foo(P1: text) {`;
  assert.equal(findFunctionSignature(source, "Foo").returnType, null);
});

test("deriveWriteCandidates proposes EntitySet_Create for a plain POST", () => {
  const candidates = deriveWriteCandidates("POST", "OrderQuotationSet", null);
  assert.equal(candidates[0], "OrderQuotationSet_Create");
});

test("deriveWriteCandidates proposes the plain entitySetName+actionName pattern first, then the entityType-inserted pattern, then the bare action name", () => {
  const candidates = deriveWriteCandidates("POST", "OrderQuotationSet", "Release");
  assert.equal(candidates[0], "OrderQuotationSet_Release");
  assert.equal(candidates[1], "OrderQuotationSet_OrderQuotation_Release");
  assert.ok(candidates.includes("Release"));
});

test("deriveWriteCandidates's plain entitySetName+actionName pattern resolves an action whose own real name already starts with the entity type — real bug, live, 2026-08-10: CustomerOrder_RefreshAfterCustOrdCrud (bound on CustomerOrderSet) re-inserting entityType produced a nonexistent doubled-prefix name, so the loop fell through to a bare-actionName function that takes a whole `entity: CustomerOrder_Keys` RECORD parameter instead of the plain scalar key actually available — \"Argument 'entity' was expected to have type CustomerOrder_Keys, but the expression has type text\"", () => {
  const candidates = deriveWriteCandidates("POST", "CustomerOrderSet", "CustomerOrder_RefreshAfterCustOrdCrud");
  assert.equal(candidates[0], "CustomerOrderSet_CustomerOrder_RefreshAfterCustOrdCrud");
});

test("extractODataFilter reads and URL-decodes the $filter query param", () => {
  const url = "https://x.example.com/.../Foo.svc/Bar?$filter=startswith(Name%2C'ab')&$top=25";
  assert.equal(extractODataFilter(url), "startswith(Name,'ab')");
});

test("extractODataFilter returns null when there's no $filter param", () => {
  assert.equal(extractODataFilter("https://x.example.com/.../Foo.svc/Bar"), null);
});

test("buildWhereClause translates a simple eq comparison", () => {
  const url = "https://x.example.com/.../Foo.svc/Bar?$filter=CustomerNo eq '16789'";
  assert.equal(buildWhereClause(url).clause, 'CustomerNo = "16789"');
});

test("buildWhereClause records a value slot for an eq comparison, no wrapKind", () => {
  const url = "https://x.example.com/.../Foo.svc/Bar?$filter=CustomerNo eq '16789'";
  const result = buildWhereClause(url);
  assert.deepEqual(result.valueSlots, [{ path: "filter.CustomerNo", value: "16789", literal: '"16789"' }]);
});

test("buildWhereClause translates numeric comparisons", () => {
  const url = "https://x.example.com/.../Foo.svc/Bar?$filter=Qty gt 5";
  assert.equal(buildWhereClause(url).clause, "Qty > 5");
});

test("buildWhereClause translates startswith/contains/endswith into like with % placement", () => {
  assert.equal(buildWhereClause("https://x/Foo.svc/Bar?$filter=startswith(Name,'ab')").clause, 'Name like "ab%"');
  assert.equal(buildWhereClause("https://x/Foo.svc/Bar?$filter=endswith(Name,'ab')").clause, 'Name like "%ab"');
  assert.equal(buildWhereClause("https://x/Foo.svc/Bar?$filter=contains(Name,'ab')").clause, 'Name like "%ab%"');
});

test("buildWhereClause records the raw value (no wildcard) and a wrapKind for like-derived slots", () => {
  const start = buildWhereClause("https://x/Foo.svc/Bar?$filter=startswith(Name,'ab')");
  assert.deepEqual(start.valueSlots, [{ path: "filter.Name", value: "ab", literal: '"ab%"', wrapKind: "start" }]);

  const end = buildWhereClause("https://x/Foo.svc/Bar?$filter=endswith(Name,'ab')");
  assert.equal(end.valueSlots[0].wrapKind, "end");
  assert.equal(end.valueSlots[0].value, "ab");

  const contains = buildWhereClause("https://x/Foo.svc/Bar?$filter=contains(Name,'ab')");
  assert.equal(contains.valueSlots[0].wrapKind, "contains");
  assert.equal(contains.valueSlots[0].value, "ab");
});

test("buildWhereClause recognizes tolower(Field)/toupper(Field) wrapping the field argument inside startswith/endswith/contains, wraps the LHS with the matching FlowScript lower()/upper() builtin — real bug, live, 2026-08-11: startswith(tolower(PickListNo),'x') wasn't recognized as a nested function call at all, \"tolower\" itself got treated as the field name and the stray following \"(\" token produced a garbage fallback with no raw value at all, rendering the literal text \"undefined%\"", () => {
  const lower = buildWhereClause("https://x/Foo.svc/Bar?$filter=startswith(tolower(Name),'ab')");
  assert.equal(lower.clause, 'lower(Name) like "ab%"');
  assert.deepEqual(lower.valueSlots, [{ path: "filter.Name", value: "ab", literal: '"ab%"', wrapKind: "start" }]);

  const upper = buildWhereClause("https://x/Foo.svc/Bar?$filter=endswith(toupper(Name),'AB')");
  assert.equal(upper.clause, 'upper(Name) like "%AB"');
});

test("buildWhereClause translates the real recorded ShopMaterialPickLists filter end-to-end (nested tolower inside startswith, doubly-parenthesized)", () => {
  const url = "https://uatifs.hima.com/main/ifsapplications/projection/v1/ReportPickingOfShopOrderPickListHandling.svc/ShopMaterialPickLists" +
    "?$filter=((startswith(tolower(PickListNo)%2C%27629783%27)))&$select=PickListNo&$skip=0&$top=25";
  const result = buildWhereClause(url);
  assert.equal(result.clause, '((lower(PickListNo) like "629783%"))');
  assert.deepEqual(result.valueSlots, [{ path: "filter.PickListNo", value: "629783", literal: '"629783%"', wrapKind: "start" }]);
});

test("buildWhereClause translates the full recorded example (enum eq + startswith, and-combined, outer-parenthesized)", () => {
  const url =
    "https://uatifs.hima.com/main/ifsapplications/projection/v1/SalesQuotationHandling.svc/OrderQuotationSet" +
    "?$filter=((Objstate%20eq%20IfsApp.SalesQuotationHandling.OrderQuotationState%27Released%27)%20and%20(startswith(QuotationNo%2C%271100463%27)))" +
    "&$select=QuotationNo,CustomerNo&use-timezone-filter=false&$skip=0&$top=25";
  const result = buildWhereClause(url);
  assert.equal(result.clause, '((Objstate = "Released") and (QuotationNo like "1100463%"))');
  // Real root cause, live, 2026-08-10: an enum-literal-syntax comparison (Namespace'Value',
  // what real IFS traffic actually sends — see the enum-literal-syntax test below) now records
  // its slot too, same as the plain-quoted-string form always did — this asymmetry was the actual
  // bug; kind-based enum exclusion (see findUnmappedSlots) is what keeps it out of unmapped/
  // dependency candidates downstream once buildCallScript classifies it via rowFields, not an
  // unconditional skip here. No rowFields supplied to this call, so the clause text itself stays
  // the old bare-string rendering (asserted above) — only whether the slot is tracked changes.
  assert.deepEqual(result.valueSlots, [
    { path: "filter.Objstate", value: "Released", literal: '"Released"' },
    { path: "filter.QuotationNo", value: "1100463", literal: '"1100463%"', wrapKind: "start" }
  ]);
});

test("buildWhereClause returns null when there's no $filter", () => {
  assert.equal(buildWhereClause("https://x.example.com/.../Foo.svc/Bar"), null);
});

test("buildWhereClause renders a comparison against a positively enum-typed field as a real qualified enum literal, not a bare string, when row-type info is available — real bug, live, 2026-08-10: \"Objstate != \\\"Blocked\\\"\" (Objstate genuinely enum-typed) flagged by Flow's compiler: \"Possibly unintended comparison of non-overlapping types 'CustomerOrderHandling.OrderCoordinatorState.Value' and '\\\"Blocked\\\"'\"", () => {
  const url = "https://x.example.com/.../CustomerOrderHandling.svc/Reference_OrderCoordinatorLov?$filter=Objstate%20ne%20%27Blocked%27";
  const rowFields = [{ name: "Objstate", type: "OrderCoordinatorState.Value" }];
  const result = buildWhereClause(url, rowFields, "CustomerOrderHandling");
  assert.equal(result.clause, 'Objstate != CustomerOrderHandling.OrderCoordinatorState.fromText("Blocked")');
});

test("buildWhereClause renders a correct enum literal when the filter uses OData's FULL enum-literal syntax (Namespace.Type'Value'), not just a plain-quoted string — real root cause, live, 2026-08-10: cb140d2 only fixed the plain-quoted-string form of the filter; real captured IFS traffic renders enum comparisons as the qualified form (see the OrderQuotationState test above), which the tokenizer marks isLiteral:false and which therefore skipped the enumAwareLiteral correction entirely, regardless of rowFields being supplied — fix must make parseValue's enum branch isLiteral:true too", () => {
  const url =
    "https://x.example.com/.../CustomerOrderHandling.svc/Reference_OrderCoordinatorLov" +
    "?$filter=Objstate%20ne%20IfsApp.CustomerOrderHandling.OrderCoordinatorState%27Blocked%27";
  const rowFields = [{ name: "Objstate", type: "OrderCoordinatorState.Value" }];
  const result = buildWhereClause(url, rowFields, "CustomerOrderHandling");
  assert.equal(result.clause, 'Objstate != CustomerOrderHandling.OrderCoordinatorState.fromText("Blocked")');
});

test("buildWhereClause still renders a plain string comparison for a field NOT classified as enum (or when row-type info isn't available at all), unchanged from before", () => {
  const url = "https://x.example.com/.../CustomerOrderHandling.svc/Reference_OrderCoordinatorLov?$filter=Objstate%20ne%20%27Blocked%27";
  const rowFields = [{ name: "Objstate", type: "text" }];
  assert.equal(buildWhereClause(url, rowFields, "CustomerOrderHandling").clause, 'Objstate != "Blocked"');
  assert.equal(buildWhereClause(url).clause, 'Objstate != "Blocked"'); // no rowFields/moduleName at all
});

test("buildCallScript renders the real reported case end-to-end: an enum comparison AND a like-comparison in the same $filter on a queryable's LOV", () => {
  const source = [
    `type OrderCoordinatorLov = { Objstate: OrderCoordinatorState.Value, AuthorizeCode: text };`,
    `let Reference_OrderCoordinatorLov = Queryable.Create<ODataQueryTranslation, OrderCoordinatorLov, text>(x, y);`
  ].join("\n");
  const call = {
    method: "GET",
    url: "https://x.example.com/.../CustomerOrderHandling.svc/Reference_OrderCoordinatorLov?$filter=((Objstate%20ne%20%27Blocked%27)%20and%20(startswith(AuthorizeCode%2C%27ABC%27)))"
  };
  const result = buildCallScript(call, "CustomerOrderHandling", source);
  assert.match(result.script, /Objstate != CustomerOrderHandling\.OrderCoordinatorState\.fromText\("Blocked"\)/);
  assert.match(result.script, /AuthorizeCode like "ABC%"/);
});

test("buildCallScript appends the translated where clause to a select-from-queryable step", () => {
  const source = `let OrderQuotationSet = Queryable.Create<ODataQueryTranslation, OrderQuotation, text>(x, y);`;
  const call = {
    method: "GET",
    url: "https://x.example.com/.../SalesQuotationHandling.svc/OrderQuotationSet?$filter=CustomerNo eq '16789'"
  };
  const result = buildCallScript(call, "SalesQuotationHandling", source);
  assert.equal(
    result.script,
    'open SalesQuotationHandling;\nreturn select * from OrderQuotationSet where CustomerNo = "16789"'
  );
});

test("buildCallScript translates a named key segment on a GET-to-queryable call into a where clause instead of silently dropping it (real bug, 2026-08-08: Reference_CustOrdCust6(Company='NC LABS',CustomerNo='EXTERNAL01') became an unfiltered select — both key values discarded, never even collected as valueSlots, so CustomerNo never got offered for dependency-matching or user-input classification)", () => {
  const source = [
    `type CustOrdCust6 = { Company: text, CustomerNo: text };`,
    `let Reference_CustOrdCust6 = Queryable.Create<ODataQueryTranslation, CustOrdCust6, text>(x, y);`
  ].join("\n");
  const call = {
    method: "GET",
    url: "https://x.example.com/.../CustomerOrderHandling.svc/Reference_CustOrdCust6(Company='NC%20LABS',CustomerNo='EXTERNAL01')"
  };
  const result = buildCallScript(call, "CustomerOrderHandling", source);
  assert.equal(result.resolved, true);
  assert.equal(
    result.script,
    'open CustomerOrderHandling;\nreturn select * from Reference_CustOrdCust6 where Company = "NC LABS" and CustomerNo = "EXTERNAL01"'
  );
  const customerSlot = result.valueSlots.find((s) => s.path === "filter.CustomerNo");
  assert.deepEqual(customerSlot, { path: "filter.CustomerNo", value: "EXTERNAL01", literal: '"EXTERNAL01"', kind: "text", kindKnown: true, nullable: false, valueNullable: false });
});

test("buildCallScript combines a named key segment with a $filter on the same GET-to-queryable call, key clause first", () => {
  const source = [
    `type OrderQuotation = { QuotationNo: text, CustomerNo: text };`,
    `let OrderQuotationSet = Queryable.Create<ODataQueryTranslation, OrderQuotation, text>(x, y);`
  ].join("\n");
  const call = {
    method: "GET",
    url: "https://x.example.com/.../SalesQuotationHandling.svc/OrderQuotationSet(QuotationNo='Q1')?$filter=CustomerNo eq '16789'"
  };
  const result = buildCallScript(call, "SalesQuotationHandling", source);
  assert.equal(
    result.script,
    'open SalesQuotationHandling;\nreturn select * from OrderQuotationSet where QuotationNo = "Q1" and CustomerNo = "16789"'
  );
});

test("buildCallScript leaves an unnamed single key segment on a GET-to-queryable call unfiltered (known gap — the entity's own key field name isn't recoverable from the module source we parse, same as before this fix)", () => {
  const source = `let OrderQuotationSet = Queryable.Create<ODataQueryTranslation, OrderQuotation, text>(x, y);`;
  const call = { method: "GET", url: "https://x.example.com/.../SalesQuotationHandling.svc/OrderQuotationSet('Q1')" };
  const result = buildCallScript(call, "SalesQuotationHandling", source);
  assert.equal(result.script, "open SalesQuotationHandling;\nreturn select * from OrderQuotationSet");
});

test("findQueryableRowType extracts the row type from a Queryable.Create declaration", () => {
  const source = `let OrderQuotationSet = Queryable.Create<ODataQueryTranslation, OrderQuotation, text>(x, y);`;
  assert.equal(findQueryableRowType(source, "OrderQuotationSet"), "OrderQuotation");
});

test("findQueryableRowType returns null when the variable isn't declared as a Queryable", () => {
  assert.equal(findQueryableRowType("let Foo = 1;", "Foo"), null);
});

test("buildCallScript resolves declared type/nullability for filter-derived slots via the row type", () => {
  const source = [
    `type OrderQuotation = { QuotationNo: text, Qty: number? };`,
    `let OrderQuotationSet = Queryable.Create<ODataQueryTranslation, OrderQuotation, text>(x, y);`
  ].join("\n");
  const call = {
    method: "GET",
    url: "https://x.example.com/.../SalesQuotationHandling.svc/OrderQuotationSet?$filter=startswith(QuotationNo,'1100463') and Qty eq 5"
  };
  const result = buildCallScript(call, "SalesQuotationHandling", source);
  const quotationSlot = result.valueSlots.find((s) => s.path === "filter.QuotationNo");
  const qtySlot = result.valueSlots.find((s) => s.path === "filter.Qty");
  assert.deepEqual(quotationSlot, { path: "filter.QuotationNo", value: "1100463", literal: '"1100463%"', wrapKind: "start", kind: "text", kindKnown: true, nullable: false, valueNullable: false });
  assert.deepEqual(qtySlot, { path: "filter.Qty", value: 5, literal: "5", kind: "number", kindKnown: true, nullable: true, valueNullable: true });
});

test("buildGetScript finds the declared Queryable variable name", () => {
  const source = `let OrderQuotationSet = Queryable.Create<ODataQueryTranslation, OrderQuotation, text>(x, y);`;
  assert.equal(buildGetScript("SalesQuotationHandling", "OrderQuotationSet", source), "open SalesQuotationHandling;\nreturn select * from OrderQuotationSet");
});

test("buildCallScript builds a GET step script", () => {
  const source = `let OrderQuotationSet = Queryable.Create<ODataQueryTranslation, OrderQuotation, text>(x, y);`;
  const call = { method: "GET", url: "https://x.example.com/.../SalesQuotationHandling.svc/OrderQuotationSet" };
  const result = buildCallScript(call, "SalesQuotationHandling", source);
  assert.equal(result.resolved, true);
  assert.equal(result.script, "open SalesQuotationHandling;\nreturn select * from OrderQuotationSet");
});

test("buildCallScript calls a plain function for a GET endpoint the module never turned into a queryable", () => {
  const source = `function GetBasicCustomerInformation(customerNo:text?, headers: Header* = []): CustomerInfo {`;
  const call = {
    method: "GET",
    url: "https://x.example.com/.../SalesQuotationHandling.svc/GetBasicCustomerInformation(customerNo='16789')"
  };
  const result = buildCallScript(call, "SalesQuotationHandling", source);
  assert.equal(result.resolved, true);
  assert.equal(
    result.script,
    'open SalesQuotationHandling;\nreturn GetBasicCustomerInformation("16789");'
  );
});

test("keyValueToJs unwraps a quoted string key to its real string value", () => {
  assert.equal(keyValueToJs("'Q1'"), "Q1");
});

test("keyValueToJs converts OData's bare null keyword to a real JS null, not the string \"null\"", () => {
  assert.equal(keyValueToJs("null"), null);
});

test("keyValueToJs still returns the real string value for a quoted 'null'", () => {
  assert.equal(keyValueToJs("'null'"), "null");
});

test("keyValueToJs converts OData's bare true/false keywords to real JS booleans", () => {
  assert.equal(keyValueToJs("true"), true);
  assert.equal(keyValueToJs("false"), false);
});

test("keyValueToJs still returns the real string value for a quoted 'true'/'false'", () => {
  assert.equal(keyValueToJs("'true'"), "true");
  assert.equal(keyValueToJs("'false'"), "false");
});

test("keyValueToJs URL-decodes a quoted string value", () => {
  assert.equal(keyValueToJs("'NC%20LABS'"), "NC LABS");
});

test("keyValueToJs extracts just the value from an OData namespace-qualified enum literal", () => {
  assert.equal(keyValueToJs("IfsApp.SalesQuotationHandling.Lookup_IsoCountry'US'"), "US");
});

test("keyValueToJs converts a numeric key to a real number", () => {
  assert.equal(keyValueToJs("123"), 123);
  assert.equal(typeof keyValueToJs("123"), "number");
});

test("collectValueSlots flattens nested objects and arrays into addressed leaves", () => {
  const out = [];
  collectValueSlots({ CustomerNo: "16789", Lines: [{ Qty: 3 }] }, "input", out);
  assert.deepEqual(out, [
    { path: "input.CustomerNo", value: "16789", literal: '"16789"' },
    { path: "input.Lines[0].Qty", value: 3, literal: "3" }
  ]);
});

test("buildCallScript reports resultKind 'sequence' for a select-from-queryable step", () => {
  const source = `let OrderQuotationSet = Queryable.Create<ODataQueryTranslation, OrderQuotation, text>(x, y);`;
  const call = { method: "GET", url: "https://x.example.com/.../SalesQuotationHandling.svc/OrderQuotationSet" };
  const result = buildCallScript(call, "SalesQuotationHandling", source);
  assert.equal(result.resultKind, "sequence");
  assert.deepEqual(result.valueSlots, []);
});

test("classifyFlowType recognizes number/datetime/boolean and defaults unknowns to text", () => {
  assert.deepEqual(classifyFlowType("number"), { kind: "number", nullable: false });
  assert.deepEqual(classifyFlowType("datetime?"), { kind: "datetime", nullable: true });
  assert.deepEqual(classifyFlowType("boolean"), { kind: "boolean", nullable: false });
  assert.deepEqual(classifyFlowType("text?"), { kind: "text", nullable: true });
  assert.deepEqual(classifyFlowType("SomeEnumType"), { kind: "text", nullable: false });
});

test("classifyFlowType recognizes the TypeName.Value enum pattern", () => {
  assert.deepEqual(classifyFlowType("CPackageType.Value"), { kind: "enum", nullable: false });
  assert.deepEqual(classifyFlowType("CHimaSys.Value?"), { kind: "enum", nullable: true });
});

test("findRecordTypeFields parses a record type's fields, including optional/nullable markers", () => {
  const source = `type OrderQuotationUpdateRequest = { optional Note: text?, QuotationNo: text, Qty: number };`;
  const fields = findRecordTypeFields(source, "OrderQuotationUpdateRequest");
  assert.deepEqual(fields, [
    { name: "Note", type: "text?", optional: true },
    { name: "QuotationNo", type: "text", optional: false },
    { name: "Qty", type: "number", optional: false }
  ]);
});

test("findRecordTypeFields strips a field's own default value (`Field: type = null`) out of `type` — real generator convention (CustomerOrderLine, CustomerOrder, CustomerDefaultsStructure, ... all declare most fields this way), and real bug, 2026-08-09: an un-stripped default glued onto type (e.g. \"boolean = null\") never matched classifyFlowType's case chain, silently misclassifying a defaulted number/boolean/enum field as text — confirmed live, UsePriceInclTax (boolean) got the generic isNull(ref, \"\") text fallback instead of isNull(ref, false)", () => {
  const source = `type CustomerDefaultsStructure = { UsePriceInclTax: boolean = null, Priority: number = null, SupplyCountry: Lookup_IsoCountry.Value, OrderId: text };`;
  const fields = findRecordTypeFields(source, "CustomerDefaultsStructure");
  assert.equal(classifyFlowType(fields[0].type).kind, "boolean");
  assert.equal(classifyFlowType(fields[1].type).kind, "number");
  assert.equal(classifyFlowType(fields[2].type).kind, "enum");
  assert.deepEqual(fields.map((f) => f.type), ["boolean", "number", "Lookup_IsoCountry.Value", "text"]);
});

test("findRecordTypeFields returns null when the type isn't declared as a record", () => {
  assert.equal(findRecordTypeFields("type Foo = text;", "Foo"), null);
  assert.equal(findRecordTypeFields("no such type here", "Bar"), null);
});

test("buildCallScript resolves declared field types/nullability for input-record slots", () => {
  const source = [
    `type OrderQuotationUpdateRequest = { optional Note: text?, Qty: number };`,
    `function OrderQuotationSet_Update(QuotationNo:text, input: OrderQuotationUpdateRequest, headers: Header* = []): OrderQuotationCopyValuesStructure {`
  ].join("\n");
  const call = {
    method: "PATCH",
    url: "https://x.example.com/.../SalesQuotationHandling.svc/OrderQuotationSet('Q1')",
    requestBody: JSON.stringify({ Note: "hi", Qty: 3 })
  };
  const result = buildCallScript(call, "SalesQuotationHandling", source);
  const noteSlot = result.valueSlots.find((s) => s.path === "input.Note");
  const qtySlot = result.valueSlots.find((s) => s.path === "input.Qty");
  assert.deepEqual(noteSlot, { path: "input.Note", value: "hi", literal: '"hi"', kind: "text", kindKnown: true, enumType: null, nullable: true, valueNullable: true });
  assert.deepEqual(qtySlot, { path: "input.Qty", value: 3, literal: "3", kind: "number", kindKnown: true, enumType: null, nullable: false, valueNullable: false });
});

test("buildCallScript keeps a number-typed input-record slot's literal in sync with the OData-string-to-bare-number conversion (regression: real 'Edit Sales Quotation' recording, 2026-08-07 — CProjectDiscount recorded as JSON string \"10\", declared 'number' — the script correctly embedded bare `10`, but valueSlots still carried the quoted '\"10\"' text left over from the generic renderer, so substitution could never find it and the user-classified value stayed hardcoded instead of being wired to its control)", () => {
  const source = [
    `type OrderQuotationUpdateRequest = { optional CProjectDiscount: number? };`,
    `function OrderQuotationSet_Update(QuotationNo:text, input: OrderQuotationUpdateRequest, headers: Header* = []): OrderQuotationCopyValuesStructure {`
  ].join("\n");
  const call = {
    method: "PATCH",
    url: "https://x.example.com/.../SalesQuotationHandling.svc/OrderQuotationSet('Q1')",
    requestBody: JSON.stringify({ CProjectDiscount: "10" })
  };
  const result = buildCallScript(call, "SalesQuotationHandling", source);
  assert.match(result.script, /CProjectDiscount: 10\b/); // bare, unquoted — what buildRecordLiteral actually emits
  const slot = result.valueSlots.find((s) => s.path === "input.CProjectDiscount");
  assert.equal(slot.literal, "10"); // must match the embedded text exactly, or substitution silently no-ops
  assert.equal(slot.kind, "number");
});

test("buildCallScript reports resultKind 'record' and collects value slots for a write call", () => {
  const source = `function OrderQuotationSet_Update(QuotationNo:text, input: OrderQuotationUpdateRequest, headers: Header* = []): OrderQuotationCopyValuesStructure {`;
  const call = {
    method: "PATCH",
    url: "https://x.example.com/.../SalesQuotationHandling.svc/OrderQuotationSet('Q1')",
    requestBody: JSON.stringify({ CustomerNo: "16789" })
  };
  const result = buildCallScript(call, "SalesQuotationHandling", source);
  assert.equal(result.resultKind, "record");
  assert.deepEqual(result.valueSlots, [
    { path: "QuotationNo", value: "Q1", literal: '"Q1"', kind: "text", kindKnown: true, nullable: false, valueNullable: false },
    { path: "input.CustomerNo", value: "16789", literal: '"16789"', kind: "text", kindKnown: false, enumType: null, nullable: false, valueNullable: false }
  ]);
});

test("buildCallScript prefers select-from-queryable over a same-named function when both exist", () => {
  const source = [
    `let OrderQuotationSet = Queryable.Create<ODataQueryTranslation, OrderQuotation, text>(x, y);`,
    `function OrderQuotationSet(headers: Header* = []) {}`
  ].join("\n");
  const call = { method: "GET", url: "https://x.example.com/.../SalesQuotationHandling.svc/OrderQuotationSet" };
  const result = buildCallScript(call, "SalesQuotationHandling", source);
  assert.equal(result.script, "open SalesQuotationHandling;\nreturn select * from OrderQuotationSet");
});

test("buildCallScript resolves a POST create call and inlines the recorded body", () => {
  const source = `function OrderQuotationSet_Create(input: OrderQuotationInsertRequest, headers: Header* = []): OrderQuotationCopyValuesStructure {`;
  const call = {
    method: "POST",
    url: "https://x.example.com/.../SalesQuotationHandling.svc/OrderQuotationSet",
    requestBody: JSON.stringify({ CustomerNo: "16789" })
  };
  const result = buildCallScript(call, "SalesQuotationHandling", source);
  assert.equal(result.resolved, true);
  assert.equal(
    result.script,
    'open SalesQuotationHandling;\nlet input: OrderQuotationInsertRequest = {\n  CustomerNo: "16789"\n};\nreturn OrderQuotationSet_Create(input);'
  );
});

test("buildCallScript resolves a bound-function GET call (EntitySet/Namespace.FunctionName()) to the function, not a queryable select — even though the entity set IS queryable (real bug, 2026-08-08: CustomerOrderSet/IfsApp.CustomerOrderHandling.CustomerOrder_Default() silently became 'select * from CustomerOrderSet', a full unfiltered table scan, instead of calling CustomerOrder_Default())", () => {
  const source = [
    `let CustomerOrderSet = Queryable.Create<ODataQueryTranslation, CustomerOrder, text>(x, y);`,
    `function CustomerOrder_Default(headers: Header* = []): CustomerOrder {`
  ].join("\n");
  const call = {
    method: "GET",
    url: "https://x.example.com/.../CustomerOrderHandling.svc/CustomerOrderSet/IfsApp.CustomerOrderHandling.CustomerOrder_Default()"
  };
  const result = buildCallScript(call, "CustomerOrderHandling", source);
  assert.equal(result.resolved, true);
  assert.match(result.script, /return CustomerOrder_Default\(\);/);
  assert.doesNotMatch(result.script, /select \* from CustomerOrderSet/);
});

test("buildCallScript resolves a bound POST action whose real name already starts with the entity type to its scalar-friendly overload, not the entity-Keys-record one — real bug, live, 2026-08-10: CustomerOrder_RefreshAfterCustOrdCrud (bound on CustomerOrderSet('NO123')) resolved to the wrong of two real functions, substituting a plain scalar OrderNo reference as the WHOLE argument where a `entity: CustomerOrder_Keys` record was expected — \"Argument 'entity' was expected to have type CustomerOrder_Keys, but the expression has type text\"", () => {
  const source = [
    `type CustomerOrder_Keys = { OrderNo: text };`,
    `function CustomerOrder_RefreshAfterCustOrdCrud(entity: CustomerOrder_Keys, headers: Header* = []): text {`,
    `function CustomerOrderSet_CustomerOrder_RefreshAfterCustOrdCrud(OrderNo: text, headers: Header* = []): text {`
  ].join("\n");
  const call = {
    method: "POST",
    url: "https://x.example.com/.../CustomerOrderHandling.svc/CustomerOrderSet('NO123')/IfsApp.CustomerOrderHandling.CustomerOrder_RefreshAfterCustOrdCrud"
  };
  const result = buildCallScript(call, "CustomerOrderHandling", source);
  assert.equal(result.resolved, true);
  assert.match(result.script, /return CustomerOrderSet_CustomerOrder_RefreshAfterCustOrdCrud\("NO123"\);/);
});

test("buildCallScript resolves a bound-function GET call whose action segment has key-style arguments too (defensive — real examples so far are always parameterless (), but the () -> \"\" strip must not corrupt a name that has none)", () => {
  const source = `function OrderQuotationSet_Release(headers: Header* = []): text {`;
  const call = {
    method: "GET",
    url: "https://x.example.com/.../SalesQuotationHandling.svc/OrderQuotationSet('Q1')/IfsApp.SalesQuotationHandling.OrderQuotationSet_Release()"
  };
  const result = buildCallScript(call, "SalesQuotationHandling", source);
  assert.equal(result.resolved, true);
  assert.match(result.script, /return OrderQuotationSet_Release\(\);/);
});

test("buildCallScript picks the best-matching overload for a call, not just the first name match — real recorded case, 2026-08-08: ValidateAddressNo(ValidationRec=@ValidationRec,DeliveryAddress=true,DocumentAddress=true,ValidatingCustomer=true,AgreementChanged=null,ShipAddrNoChanged='TRUE') must resolve to ValidateAddressNo_0 (matches all 6 recorded key names), not the unrelated flat-param ValidateAddressNo", () => {
  const source = [
    `function ValidateAddressNo(orderNo: text, lineNo: text, relNo: text, lineItemNo: number, shipAddrNo: text, addrFlag: GenYesNo.Value, defaultAddrFlag: GenYesNo.Value, deliveryLeadtime: number, pickingLeadtime: number, shipmentCreation: ShipmentCreationCustomerOrder.Value, headers: Header* = []): AddressDetailStructure {`,
    `function ValidateAddressNo_0(validationRec: AddressStructure, deliveryAddress: boolean, documentAddress: boolean, validatingCustomer: boolean, agreementChanged: text, shipAddrNoChanged: text, headers: Header* = []): AddressStructure {`,
    `type AddressStructure = { CustomerNo: text };`
  ].join("\n");
  const aliasValue = JSON.stringify({ CustomerNo: "EXTERNAL01" });
  const call = {
    method: "GET",
    url: `https://x.example.com/.../CustomerOrderHandling.svc/ValidateAddressNo(ValidationRec=@ValidationRec,DeliveryAddress=true,DocumentAddress=true,ValidatingCustomer=true,AgreementChanged=null,ShipAddrNoChanged='TRUE')?@ValidationRec=${encodeURIComponent(aliasValue)}`
  };
  const result = buildCallScript(call, "CustomerOrderHandling", source);
  assert.equal(result.resolved, true);
  assert.match(result.script, /let validationRec: AddressStructure = \{/);
  assert.match(result.script, /return ValidateAddressNo_0\(validationRec, true, true, true, null, "TRUE"\);/);
});

/* ---------- buildWriteScript's entity/_Keys record param + named trailing-action-args handling,
   real bug, live, 2026-08-11: a bound function/action reached via a key segment whose OWN first
   param is typed as the entity's `_Keys` record (e.g. `entity:
   ShopMaterialPickLineVirtual_Keys`) had that param treated as a bare positional scalar (wrong
   type entirely - "Argument 'entity' was expected to have type
   ...ShopMaterialPickLineVirtual_Keys, but the expression has type text"), and the trailing
   action's own real args (e.g. Source/PickToParentQty) were silently discarded entirely - real
   case, ShopMaterialPickLineSet(Objkey='X')/...ShopMaterialPickLineVirtual_CheckSerialRecords(
   Source='REPORT PICK',PickToParentQty=null). ---------- */

test("buildCallScript builds a real entity key record for a _Keys-typed first param (from the ENTITY's own key segment) and matches every remaining param BY NAME against the trailing action's own key=value args — real case, ShopMaterialPickLineVirtual_CheckSerialRecords", () => {
  const source = [
    "type ShopMaterialPickLineVirtual_Keys = { Objkey: text };",
    "function ShopMaterialPickLineVirtual_CheckSerialRecords(entity: ShopMaterialPickLineVirtual_Keys, source: text, pickToParentQty: number?, headers: Header* = []): CheckSerialRecordsResult {",
    "    return unsafeCast(GetResponse(``));",
    "}"
  ].join("\n");
  const call = { method: "GET", url: "https://uatifs.hima.com/main/ifsapplications/projection/v1/ReportPickingOfShopOrderPickListHandling.svc/ShopMaterialPickLineSet(Objkey='58C2CFF998C30482E0630A3165647DC8')/IfsApp.ReportPickingOfShopOrderPickListHandling.ShopMaterialPickLineVirtual_CheckSerialRecords(Source='REPORT PICK',PickToParentQty=null)" };
  const result = buildCallScript(call, "ReportPickingOfShopOrderPickListHandling", source);
  assert.equal(result.resolved, true);
  assert.equal(
    result.script,
    'open ReportPickingOfShopOrderPickListHandling;\n' +
    'let entity: ShopMaterialPickLineVirtual_Keys = {\n' +
    '  Objkey: "58C2CFF998C30482E0630A3165647DC8"\n' +
    '};\n' +
    'return ShopMaterialPickLineVirtual_CheckSerialRecords(entity, "REPORT PICK", null);'
  );
  assert.deepEqual(result.valueSlots.map((s) => s.path), ["entity.Objkey", "source", "pickToParentQty"]);
  assert.equal(result.valueSlots[1].value, "REPORT PICK");
  assert.equal(result.valueSlots[2].value, null);
});

test("buildCallScript matches trailing-action args by name regardless of their order relative to the function's own declared param order", () => {
  const source = [
    "type X_Keys = { Id: text };",
    "function Fn(entity: X_Keys, a: text, b: text, headers: Header* = []): T {",
    "    return unsafeCast(GetResponse(``));",
    "}"
  ].join("\n");
  // Recorded with b BEFORE a — real OData named-arg calls don't guarantee declared param order.
  const call = { url: "https://x.example.com/.../X.svc/XSet(Id='1')/Fn(B='BVal',A='AVal')" };
  const result = buildCallScript(call, "X", source);
  assert.match(result.script, /return Fn\(entity, "AVal", "BVal"\);/);
});

test("buildCallScript disambiguates the entity variable name against a shared usedNames set, same as buildNavigationQueryableScript", () => {
  const source = [
    "type X_Keys = { Id: text };",
    "function Fn(entity: X_Keys, headers: Header* = []): T {",
    "    return unsafeCast(GetResponse(``));",
    "}"
  ].join("\n");
  const used = new Set();
  const call1 = { url: "https://x.example.com/.../X.svc/XSet(Id='1')/Fn()" };
  const call2 = { url: "https://x.example.com/.../X.svc/XSet(Id='2')/Fn()" };
  const r1 = buildCallScript(call1, "X", source, used);
  const r2 = buildCallScript(call2, "X", source, used);
  assert.match(r1.script, /let entity: X_Keys/);
  assert.match(r2.script, /let entity2: X_Keys/);
  assert.match(r2.script, /return Fn\(entity2\);/);
});

test("buildCallScript leaves a normal (non-_Keys) key param completely on the original positional path — no entity/named-arg detection fires", () => {
  const source = [
    `function OrderQuotationSet_Update(QuotationNo: text, headers: Header* = []): T { return unsafeCast(GetResponse(\`\`)); }`
  ].join("\n");
  const call = { method: "PATCH", url: "https://x.example.com/.../SalesQuotationHandling.svc/OrderQuotationSet('Q1')" };
  const result = buildCallScript(call, "SalesQuotationHandling", source);
  assert.match(result.script, /return OrderQuotationSet_Update\("Q1"\);/);
  assert.doesNotMatch(result.script, /let entity/);
});

test("buildCallScript resolves an update call with a key parameter", () => {
  const source = `function OrderQuotationSet_Update(QuotationNo:text, input: OrderQuotationUpdateRequest, headers: Header* = []): OrderQuotationCopyValuesStructure {`;
  const call = {
    method: "PATCH",
    url: "https://x.example.com/.../SalesQuotationHandling.svc/OrderQuotationSet('Q1')",
    requestBody: JSON.stringify({ Note: "hi" })
  };
  const result = buildCallScript(call, "SalesQuotationHandling", source);
  assert.equal(result.resolved, true);
  assert.equal(
    result.script,
    'open SalesQuotationHandling;\nlet input: OrderQuotationUpdateRequest = {\n  Note: "hi"\n};\nreturn OrderQuotationSet_Update("Q1", input);'
  );
});

test("enumModuleName extracts the module name from an enum field type, nullable or not", () => {
  assert.equal(enumModuleName("CHimaSys.Value"), "CHimaSys");
  assert.equal(enumModuleName("CHimaSys.Value?"), "CHimaSys");
  assert.equal(enumModuleName("text"), null);
  assert.equal(enumModuleName("text?"), null);
});

test("formatValueForType routes an enum-typed field through fromText, qualified with the containing module name", () => {
  // Confirmed live: CHimaSys/CPackageType are declared top-level in the generated source file,
  // but `open SalesQuotationHandling;` alone doesn't put them in scope by short name — the
  // working reference is `SalesQuotationHandling.CHimaSys.fromText(...)`.
  assert.equal(formatValueForType("HiCore", "CHimaSys.Value", "SalesQuotationHandling"), 'SalesQuotationHandling.CHimaSys.fromText("HiCore")');
  assert.equal(formatValueForType("hi", "text", "SalesQuotationHandling"), '"hi"');
  assert.equal(formatValueForType(3, "number", "SalesQuotationHandling"), "3");
});

test("formatValueForType converts a number-typed field's STRING value to a bare numeric literal instead of quoting it (regression: real recorded 'create Part' session, 2026-08-07 — StdNameId/FreightFactor are real number-typed fields, both recorded by OData as JSON strings '0'/'1', the standard OData serialization convention for Decimal/Int64 — a quoted \"1\" for a number-typed record-literal field is a real Connect type mismatch, unlike the SAME string in a where-clause comparison, which is lenient)", () => {
  assert.equal(formatValueForType("1", "number", "PartHandling"), "1");
  assert.equal(formatValueForType("0", "number?", "PartHandling"), "0");
  assert.equal(formatValueForType("1.5", "number", "PartHandling"), "1.5");
});

test("formatValueForType leaves a number-typed field's UNPARSEABLE string value to the generic (quoted-text) fallback rather than emit an invalid bare token", () => {
  assert.equal(formatValueForType("not-a-number", "number", "PartHandling"), '"not-a-number"');
  assert.equal(formatValueForType("", "number", "PartHandling"), '""');
});

test("formatValueForType unwraps a recorded ARRAY value to its first element when the declared type is SINGULAR (no trailing *) — real bug, live, 2026-08-11: PrepareSelectedPickListLines_Input.PickListSelection was recorded as a one-element JSON array (IFS's own convention for a \"selection\" field, even for a single pick) but the function's own declared parameter is singular text? — rendering it as a real FlowScript array literal (`[value]`) got rejected, \"has type text* but expected text?\"", () => {
  assert.equal(formatValueForType(["58C2CFF998C30482E0630A3165647DC8"], "text?", "ReportPickingOfShopOrderPickListHandling"), '"58C2CFF998C30482E0630A3165647DC8"');
  assert.equal(formatValueForType(["58C2CFF998C30482E0630A3165647DC8"], "text", "X"), '"58C2CFF998C30482E0630A3165647DC8"');
});

test("formatValueForType leaves an array UNWRAPPED (renders as a real FlowScript array) when the declared type genuinely IS a sequence (trailing *)", () => {
  assert.equal(formatValueForType(["A", "B"], "text*", "X"), '[\n  "A",\n  "B"\n]');
});

test("formatValueForType unwraps to null when the recorded array is empty but the declared type is singular — no element to take, still better than a guaranteed array-vs-scalar type error", () => {
  assert.equal(formatValueForType([], "text?", "X"), "null");
});

test("formatValueForType's array-unwrap still applies enum/number conversion to the unwrapped element (recursion, not just a bare passthrough)", () => {
  assert.equal(formatValueForType(["1"], "number", "X"), "1");
});

test("buildRecordLiteral renders enum-declared top-level fields via fromText, others unchanged", () => {
  const recordFields = [
    { name: "CSystem", type: "CHimaSys.Value", optional: false },
    { name: "Note", type: "text?", optional: true }
  ];
  const literal = buildRecordLiteral({ CSystem: "HiCore", Note: "hi" }, recordFields, "SalesQuotationHandling");
  assert.equal(literal, '{\n  CSystem: SalesQuotationHandling.CHimaSys.fromText("HiCore"),\n  Note: "hi"\n}');
});

test("buildRecordLiteral renders a number-declared top-level field's recorded string value as a bare numeric literal (regression: real 'create Part' session, 2026-08-07)", () => {
  const recordFields = [
    { name: "FreightFactor", type: "number", optional: false },
    { name: "StdNameId", type: "number?", optional: true }
  ];
  const literal = buildRecordLiteral({ FreightFactor: "1", StdNameId: "0" }, recordFields, "PartHandling");
  assert.equal(literal, "{\n  FreightFactor: 1,\n  StdNameId: 0\n}");
});

test("buildRecordLiteral renders a NESTED record field with the same one-entry-per-line treatment as the top level (requested 2026-08-10 for readability — e.g. a real ValidationRec-shaped blob)", () => {
  const literal = buildRecordLiteral({ ValidationRec: { Identity4: "0", OrderNo: "123" } }, []);
  assert.equal(literal, '{\n  ValidationRec: {\n    Identity4: "0",\n    OrderNo: "123"\n  }\n}');
});

test("buildRecordLiteral recurses into a nested field's OWN declared record type when moduleSource is given — real bug, live, 2026-08-10: ValidationRec's own type now resolves (CustOrdLineValidation, synthesized by applyAnyTypedFieldWorkaround) but Identity4 (a real number field) inside it still rendered as quoted text since nothing looked up ITS declared type; without moduleSource, behaves exactly as before (generic renderer, unchanged)", () => {
  const source = `type CustOrdLineValidation = { Identity4: number, AddrFlag: GenYesNo.Value, OrderNo: text };`;
  const recordFields = [{ name: "ValidationRec", type: "CustOrdLineValidation", optional: false }];
  const value = { ValidationRec: { Identity4: "0", AddrFlag: "No", OrderNo: "123" } };

  const withModuleSource = buildRecordLiteral(value, recordFields, "CustomerOrderHandling", source);
  assert.equal(
    withModuleSource,
    '{\n  ValidationRec: {\n    Identity4: 0,\n    AddrFlag: CustomerOrderHandling.GenYesNo.fromText("No"),\n    OrderNo: "123"\n  }\n}'
  );

  const withoutModuleSource = buildRecordLiteral(value, recordFields, "CustomerOrderHandling");
  assert.equal(
    withoutModuleSource,
    '{\n  ValidationRec: {\n    Identity4: "0",\n    AddrFlag: "No",\n    OrderNo: "123"\n  }\n}'
  );
});

test("buildCallScript emits fromText(...) for an enum-typed write-record field (regression: CSystem/CExclusivePackaging type mismatch)", () => {
  const source = [
    `type OrderQuotationUpdateRequest = { optional CSystem: CHimaSys.Value, optional CExclusivePackaging: CPackageType.Value };`,
    `function OrderQuotationSet_Update(QuotationNo:text, input: OrderQuotationUpdateRequest, headers: Header* = []): OrderQuotationCopyValuesStructure {`
  ].join("\n");
  const call = {
    method: "PATCH",
    url: "https://x.example.com/.../SalesQuotationHandling.svc/OrderQuotationSet('Q1')",
    requestBody: JSON.stringify({ CSystem: "HiCore", CExclusivePackaging: "ExclusivePackaging" })
  };
  const result = buildCallScript(call, "SalesQuotationHandling", source);
  assert.equal(
    result.script,
    'open SalesQuotationHandling;\nlet input: OrderQuotationUpdateRequest = {\n  CSystem: SalesQuotationHandling.CHimaSys.fromText("HiCore"),\n  CExclusivePackaging: SalesQuotationHandling.CPackageType.fromText("ExclusivePackaging")\n};\nreturn OrderQuotationSet_Update("Q1", input);'
  );
  const csystemSlot = result.valueSlots.find((s) => s.path === "input.CSystem");
  assert.equal(csystemSlot.kind, "enum");
  assert.equal(csystemSlot.literal, 'SalesQuotationHandling.CHimaSys.fromText("HiCore")');
});

test("buildCallScript emits fromText(...) for an enum-typed key parameter", () => {
  const source = `function OrderQuotationSet_Update(CSystem: CHimaSys.Value, input: OrderQuotationUpdateRequest, headers: Header* = []): OrderQuotationCopyValuesStructure {`;
  const call = {
    method: "PATCH",
    url: "https://x.example.com/.../SalesQuotationHandling.svc/OrderQuotationSet('HiCore')",
    requestBody: JSON.stringify({})
  };
  const result = buildCallScript(call, "SalesQuotationHandling", source);
  assert.match(result.script, /OrderQuotationSet_Update\(SalesQuotationHandling\.CHimaSys\.fromText\("HiCore"\), input\)/);
});

test("buildCallScript emits fromText(...) for an enum-typed key parameter recorded in OData's namespace-qualified literal form (real bug, 2026-08-07: GetCustomerDefaults(...IfsApp.SalesQuotationHandling.Lookup_IsoCountry'US') embedded the whole namespaced literal instead of just fromText(\"US\"))", () => {
  const source = `function GetCustomerDefaults(P1: text, P2: text, P3: text, CountryCode: Lookup_IsoCountry.Value, P5: text): text {`;
  const call = {
    method: "GET",
    url: "https://x.example.com/.../SalesQuotationHandling.svc/GetCustomerDefaults(P1='A',P2='B',P3='C',CountryCode=IfsApp.SalesQuotationHandling.Lookup_IsoCountry'US',P5=null)"
  };
  const result = buildCallScript(call, "SalesQuotationHandling", source);
  assert.match(result.script, /SalesQuotationHandling\.Lookup_IsoCountry\.fromText\("US"\)/);
  assert.doesNotMatch(result.script, /IfsApp/);
});

test("buildCallScript keeps valueNullable false for an optional-but-non-nullable field (regression: Objsite)", () => {
  // `optional Objsite: text` means the KEY may be omitted, not that the VALUE's type is
  // nullable — conflating the two made a dependency reference skip its isNull(...) unwrap and
  // fail live with "field 'Objsite' has type text? but expected text".
  const source = [
    `type OrderQuotationUpdateRequest = { optional Objsite: text, optional Note: text? };`,
    `function OrderQuotationSet_Update(QuotationNo:text, input: OrderQuotationUpdateRequest, headers: Header* = []): OrderQuotationCopyValuesStructure {`
  ].join("\n");
  const call = {
    method: "PATCH",
    url: "https://x.example.com/.../SalesQuotationHandling.svc/OrderQuotationSet('Q1')",
    requestBody: JSON.stringify({ Objsite: "SITE1", Note: "hi" })
  };
  const result = buildCallScript(call, "SalesQuotationHandling", source);
  const objsiteSlot = result.valueSlots.find((s) => s.path === "input.Objsite");
  const noteSlot = result.valueSlots.find((s) => s.path === "input.Note");
  assert.equal(objsiteSlot.nullable, true); // AllowEmpty still correct — key is optional
  assert.equal(objsiteSlot.valueNullable, false); // but the value's own type is not text?
  assert.equal(noteSlot.nullable, true);
  assert.equal(noteSlot.valueNullable, true); // text? — genuinely nullable at the type level too
});

test("buildCallScript falls back to a TODO placeholder when no function matches", () => {
  const call = { method: "POST", url: "https://x.example.com/.../SalesQuotationHandling.svc/SomethingUnknown" };
  const result = buildCallScript(call, "SalesQuotationHandling", "function Unrelated() {}");
  assert.equal(result.resolved, false);
  assert.match(result.script, /TODO/);
});

test("buildCallScript exposes resultFields (the SOURCE's own declared field kinds) for a sequence result, even with no $filter", () => {
  const source = [
    `let OrderQuotationSet = Queryable.Create<ODataQueryTranslation, OrderQuotation, text>(x, y);`,
    `type OrderQuotation = { QuotationNo: text, SupplyCountry: Lookup_IsoCountry.Value };`
  ].join("\n");
  const call = { method: "GET", url: "https://x.example.com/.../SalesQuotationHandling.svc/OrderQuotationSet" };
  const result = buildCallScript(call, "SalesQuotationHandling", source);
  assert.equal(result.resultKind, "sequence");
  assert.deepEqual(result.resultFields, [
    { name: "QuotationNo", type: "text", optional: false },
    { name: "SupplyCountry", type: "Lookup_IsoCountry.Value", optional: false }
  ]);
});

test("buildCallScript exposes resultFields (the SOURCE's own declared field kinds) for a function-call result, from its declared RETURN type — real case, 2026-08-08: GetCustomerDefaults.SupplyCountryDb declared plain text? in its own return type", () => {
  const source = [
    `function GetCustomerDefaults(P1: text): CustomerDefaultsStructure {`,
    `type CustomerDefaultsStructure = { SupplyCountryDb: text?, CurrencyCode: text };`
  ].join("\n");
  const call = { method: "GET", url: "https://x.example.com/.../SalesQuotationHandling.svc/GetCustomerDefaults(P1='A')" };
  const result = buildCallScript(call, "SalesQuotationHandling", source);
  assert.equal(result.resultKind, "record");
  assert.deepEqual(result.resultFields, [
    { name: "SupplyCountryDb", type: "text?", optional: false },
    { name: "CurrencyCode", type: "text", optional: false }
  ]);
});

test("buildCallScript returns a null resultFields when the return type isn't a named record declared in this module", () => {
  const source = `function GetSomeText(P1: text): text {`;
  const call = { method: "GET", url: "https://x.example.com/.../SalesQuotationHandling.svc/GetSomeText(P1='A')" };
  const result = buildCallScript(call, "SalesQuotationHandling", source);
  assert.equal(result.resultFields, null);
});

/* ---------- buildRawContextualCallScript / buildCallScript's raw-context fallback, real bug,
   live, 2026-08-10: a bound function reached via a NAVIGATION PROPERTY (e.g.
   CustomerOrderSet(OrderNo='X')/OrderLinesArray/...CustomerOrderLine_Default()) carries real
   context the GENERATED wrapper function can't express when it takes zero real params — Flow's
   codegen builds exactly ONE wrapper per bound-function name, hardcoded to the bare unscoped
   entity-set path (confirmed against the real module source). Calling that wrapper for a
   recording that used the scoped path silently drops the real context and returns
   generic/empty-context data (confirmed live: TaxLiabilityType and other real fields came back
   null). ---------- */

test("findFunctionBody extracts a function's own body text, real shape (CustomerOrderLine_Default, confirmed against the real module source)", () => {
  const source = [
    "function CustomerOrderLine_Default(headers: Header* = []): CustomerOrderLine {",
    "    let __raw = JSON.deserialize{}(GetResponse(`CustomerOrderHandling.svcCustomerOrderLineSetIfsApp.CustomerOrderHandling.CustomerOrderLine_Default()`, headers))",
    "    let __result = Record.mapValues(__raw, recordMapperForCustomerOrderLine);",
    "    return unsafeCastCustomerOrderLine(__result);",
    "}"
  ].join("\n");
  const body = findFunctionBody(source, "CustomerOrderLine_Default");
  assert.match(body, /^let __raw = JSON\.deserialize/);
  assert.match(body, /return unsafeCastCustomerOrderLine\(__result\);$/);
});

test("findFunctionBody returns null when the function isn't declared in the module", () => {
  assert.equal(findFunctionBody("function Foo() {}", "Bar"), null);
});

test("buildRawContextualCallScript inlines the wrapper's real body with its hardcoded URL literal swapped for the real recorded path — preserves whatever the generator's body actually does (Record.mapValues, unsafeCast, ...) instead of reconstructing it. Without entitySetName/keyLiteral, the path is embedded as-is (no key extraction) and valueSlots is empty", () => {
  const source = [
    "function CustomerOrderLine_Default(headers: Header* = []): CustomerOrderLine {",
    "    let __raw = JSON.deserialize{}(GetResponse(`CustomerOrderHandling.svcCustomerOrderLineSetIfsApp.CustomerOrderHandling.CustomerOrderLine_Default()`, headers))",
    "    let __result = Record.mapValues(__raw, recordMapperForCustomerOrderLine);",
    "    return unsafeCastCustomerOrderLine(__result);",
    "}"
  ].join("\n");
  const realPath = "CustomerOrderSet(OrderNo='*1103')/OrderLinesArray/IfsApp.CustomerOrderHandling.CustomerOrderLine_Default()";
  const result = buildRawContextualCallScript("CustomerOrderHandling", source, "CustomerOrderLine_Default", realPath);
  assert.equal(
    result.script,
    "open CustomerOrderHandling;\n" +
    "let headers: Header* = [];\n" +
    "let __raw = JSON.deserialize{}(GetResponse(`CustomerOrderHandling.svc" + realPath + "`, headers))\n" +
    "    let __result = Record.mapValues(__raw, recordMapperForCustomerOrderLine);\n" +
    "    return unsafeCastCustomerOrderLine(__result);"
  );
  assert.deepEqual(result.valueSlots, []);
});

test("buildRawContextualCallScript rebuilds the first segment's own key clause via {ToQueryStringParam(...)} and offers each key value as a real, classified valueSlot — real bug, live, 2026-08-10: OrderNo was buried as opaque text inside the whole-path literal, never offered for dependency-matching at all (user caught this directly)", () => {
  const source = [
    "type CustomerOrder = { OrderNo: text };",
    "let CustomerOrderSet = Queryable.Create<ODataQueryTranslation, CustomerOrder, text>(x, y);",
    "function CustomerOrderLine_Default(headers: Header* = []): CustomerOrderLine {",
    "    let __raw = JSON.deserialize{}(GetResponse(`CustomerOrderHandling.svcCustomerOrderLineSetIfsApp.CustomerOrderHandling.CustomerOrderLine_Default()`, headers))",
    "    return unsafeCastCustomerOrderLine(__raw);",
    "}"
  ].join("\n");
  const realPath = "CustomerOrderSet(OrderNo='*1103')/OrderLinesArray/IfsApp.CustomerOrderHandling.CustomerOrderLine_Default()";
  const result = buildRawContextualCallScript("CustomerOrderHandling", source, "CustomerOrderLine_Default", realPath, "CustomerOrderSet", "OrderNo='*1103'");
  assert.match(
    result.script,
    /GetResponse\(`CustomerOrderHandling\.svcCustomerOrderSet\(OrderNo=\{ToQueryStringParam\("\*1103"\)\}\)\/OrderLinesArray\/IfsApp\.CustomerOrderHandling\.CustomerOrderLine_Default\(\)`, headers\)/
  );
  assert.deepEqual(result.valueSlots, [{
    path: "key.OrderNo",
    value: "*1103",
    literal: '"*1103"',
    kind: "text",
    kindKnown: true,
    nullable: false,
    valueNullable: false
  }]);
});

test("buildRawContextualCallScript leaves the first segment's key untouched when entitySetName/keyLiteral aren't given, or the key is unnamed (e.g. Set('Q1') — no recoverable field name)", () => {
  const source = [
    "function CustomerOrderLine_Default(headers: Header* = []): CustomerOrderLine {",
    "    let __raw = JSON.deserialize{}(GetResponse(`CustomerOrderHandling.svcCustomerOrderLineSetIfsApp.CustomerOrderHandling.CustomerOrderLine_Default()`, headers))",
    "    return unsafeCastCustomerOrderLine(__raw);",
    "}"
  ].join("\n");
  const realPath = "CustomerOrderSet('Q1')/OrderLinesArray/IfsApp.CustomerOrderHandling.CustomerOrderLine_Default()";
  const result = buildRawContextualCallScript("CustomerOrderHandling", source, "CustomerOrderLine_Default", realPath, "CustomerOrderSet", "'Q1'");
  assert.match(result.script, /svcCustomerOrderSet\('Q1'\)\/OrderLinesArray/);
  assert.deepEqual(result.valueSlots, []);
});

test("buildRawContextualCallScript returns null (caller falls back to the normal wrapper call) when the function body or its URL literal can't be found", () => {
  assert.equal(buildRawContextualCallScript("X", "no such function here", "Missing", "Real/Path()"), null);
  const noBacktick = "function F(headers: Header* = []): T {\n  return 1;\n}";
  assert.equal(buildRawContextualCallScript("X", noBacktick, "F", "Real/Path()"), null);
});

test("buildCallScript uses the raw-context fallback for a real navigation-property-scoped GET whose resolved function takes zero real params — real case, CustomerOrderLine_Default via CustomerOrderSet/OrderLinesArray — and offers the URL's own OrderNo as a real, dependency-matchable valueSlot instead of burying it as opaque text", () => {
  const source = [
    "type CustomerOrder = { OrderNo: text };",
    "let CustomerOrderSet = Queryable.Create<ODataQueryTranslation, CustomerOrder, text>(x, y);",
    "function CustomerOrderLine_Default(headers: Header* = []): CustomerOrderLine {",
    "    let __raw = JSON.deserialize{}(GetResponse(`CustomerOrderHandling.svcCustomerOrderLineSetIfsApp.CustomerOrderHandling.CustomerOrderLine_Default()`, headers))",
    "    let __result = Record.mapValues(__raw, recordMapperForCustomerOrderLine);",
    "    return unsafeCastCustomerOrderLine(__result);",
    "}",
    "type CustomerOrderLine = { TaxLiabilityType: TaxLiabilityType.Value };"
  ].join("\n");
  const call = {
    method: "GET",
    url: "https://ifscloud.flowington.com/main/ifsapplications/projection/v1/CustomerOrderHandling.svc/CustomerOrderSet(OrderNo='%2A1103')/OrderLinesArray/IfsApp.CustomerOrderHandling.CustomerOrderLine_Default()"
  };
  const result = buildCallScript(call, "CustomerOrderHandling", source);
  assert.equal(result.resolved, true);
  assert.equal(result.label, "CustomerOrderLine_Default");
  // The REAL scoped path, not the wrapper's own hardcoded unscoped one — OrderNo rebuilt through
  // {ToQueryStringParam(...)} so it's plain FlowScript text a substitution search can find.
  assert.match(result.script, /GetResponse\(`CustomerOrderHandling\.svcCustomerOrderSet\(OrderNo=\{ToQueryStringParam\("\*1103"\)\}\)\/OrderLinesArray\/IfsApp\.CustomerOrderHandling\.CustomerOrderLine_Default\(\)`, headers\)/);
  assert.doesNotMatch(result.script, /svcCustomerOrderLineSetIfsApp/); // NOT the context-free wrapper path
  assert.deepEqual(result.resultFields, [{ name: "TaxLiabilityType", type: "TaxLiabilityType.Value", optional: false }]);
  assert.deepEqual(result.valueSlots, [{
    path: "key.OrderNo",
    value: "*1103",
    literal: '"*1103"',
    kind: "text",
    kindKnown: true,
    nullable: false,
    valueNullable: false
  }]);
});

test("buildCallScript does NOT use the raw-context fallback for the plain unscoped shape (2 segments, no key) — the wrapper call is already correct, nothing to lose", () => {
  const source = [
    "function CustomerOrderLine_Default(headers: Header* = []): CustomerOrderLine {",
    "    let __raw = JSON.deserialize{}(GetResponse(`CustomerOrderHandling.svcCustomerOrderLineSetIfsApp.CustomerOrderHandling.CustomerOrderLine_Default()`, headers))",
    "    return unsafeCastCustomerOrderLine(__raw);",
    "}"
  ].join("\n");
  const call = {
    method: "GET",
    url: "https://x.example.com/.../CustomerOrderHandling.svc/CustomerOrderLineSet/IfsApp.CustomerOrderHandling.CustomerOrderLine_Default()"
  };
  const result = buildCallScript(call, "CustomerOrderHandling", source);
  assert.match(result.script, /return CustomerOrderLine_Default\(\);/);
});

test("buildCallScript does NOT use the raw-context fallback when the resolved function DOES take real params — those already carry the URL's context through the normal write-script path", () => {
  const source = [
    "function GetCustomerOrderLine(orderNo: text, lineNo: text, headers: Header* = []): CustomerOrderLine {",
    "    let __raw = JSON.deserialize{}(GetResponse(`CustomerOrderHandling.svcCustomerOrderLineSet(OrderNo={ToQueryStringParam(orderNo)},LineNo={ToQueryStringParam(lineNo)})`, headers))",
    "    return unsafeCastCustomerOrderLine(__raw);",
    "}"
  ].join("\n");
  const call = {
    method: "GET",
    url: "https://x.example.com/.../CustomerOrderHandling.svc/CustomerOrderLineSet(OrderNo='1103',LineNo='10')/IfsApp.CustomerOrderHandling.GetCustomerOrderLine()"
  };
  const result = buildCallScript(call, "CustomerOrderHandling", source);
  assert.match(result.script, /return GetCustomerOrderLine\(/);
  assert.doesNotMatch(result.script, /let headers: Header\* = \[\];/);
});

/* ---------- buildNavigationQueryableScript / buildCallScript's navigation-queryable fallback,
   real bug, live, 2026-08-11: a GET on a navigation-property-scoped QUERYABLE (e.g.
   ShopMaterialPickLineSet(Objkey='X')/ShopMaterialPickLineArray?$select=...) has no bound
   function/action at all. Neither the bound-function resolution (needs a real action match) nor
   the plain-queryable path (only ever checks the first segment) can find or correctly call this.
   Confirmed against a real module source: IFS/Flow exposes this shape as a plain function (not a
   `let X = Queryable.Create` variable), named `<NavProperty>_From<ParentEntitySet>`, taking the
   parent row's own `<EntityType>_Keys` record and returning `Queryable.Create<...>`. ---------- */

const NAV_QUERYABLE_SOURCE = [
  "type ShopMaterialPickLineVirtual_Keys = { Objkey: text };",
  "type ShopMaterialPickLineListVirtual = { PartNo: text, QtyToPick: number };",
  "private function getShopMaterialPickLineSet_ShopMaterialPickLineArrayRows(entity: ShopMaterialPickLineVirtual_Keys, q: Queryable.QuerySpec<text>): {}* {",
  "    let raw = JSON.deserialize<{value: {}*}>(GetResponse(`/ReportPickingOfShopOrderPickListHandling.svc/ShopMaterialPickLineSet({keyFilterForShopMaterialPickLineVirtual(entity)})/ShopMaterialPickLineArray?{buildQueryString(q)}`)).value;",
  "    return raw.eval();",
  "}",
  "function ShopMaterialPickLineArray_FromShopMaterialPickLineSet(entity: ShopMaterialPickLineVirtual_Keys) {",
  "    return Queryable.Create<ODataQueryTranslation, ShopMaterialPickLineListVirtual, text>(getTranslation([]), getShopMaterialPickLineSet_ShopMaterialPickLineArrayRows(entity, _));",
  "}"
].join("\n");

test("buildNavigationQueryableScript resolves the real ShopMaterialPickLineArray case: finds <NavProp>_From<EntitySet> purely from the URL's own two segments, builds a real entity key record (not a bare scalar), and pulls the row type from the resolved function's own body", () => {
  const call = { method: "GET", url: "https://x.example.com/.../ReportPickingOfShopOrderPickListHandling.svc/ShopMaterialPickLineSet(Objkey='58C2CFF998C30482E0630A3165647DC8')/ShopMaterialPickLineArray" };
  const result = buildNavigationQueryableScript("ReportPickingOfShopOrderPickListHandling", NAV_QUERYABLE_SOURCE, "ShopMaterialPickLineSet", "ShopMaterialPickLineArray", "Objkey='58C2CFF998C30482E0630A3165647DC8'", call);
  assert.equal(result.resolved, true);
  assert.equal(result.label, "ShopMaterialPickLineArray_FromShopMaterialPickLineSet");
  assert.equal(
    result.script,
    'open ReportPickingOfShopOrderPickListHandling;\n' +
    'let entity: ShopMaterialPickLineVirtual_Keys = {\n' +
    '  Objkey: "58C2CFF998C30482E0630A3165647DC8"\n' +
    '};\n' +
    'let source = ShopMaterialPickLineArray_FromShopMaterialPickLineSet(entity);\n' +
    'return select * from source'
  );
  assert.deepEqual(result.resultFields, [
    { name: "PartNo", type: "text", optional: false },
    { name: "QtyToPick", type: "number", optional: false }
  ]);
  assert.deepEqual(result.valueSlots, [{
    path: "entity.Objkey",
    value: "58C2CFF998C30482E0630A3165647DC8",
    literal: '"58C2CFF998C30482E0630A3165647DC8"',
    kind: "text",
    kindKnown: true,
    enumType: null,
    nullable: false,
    valueNullable: false
  }]);
});

test("buildNavigationQueryableScript appends a real where-clause when the URL carries a $filter, classified against the resolved row type", () => {
  const call = { method: "GET", url: "https://x.example.com/.../ReportPickingOfShopOrderPickListHandling.svc/ShopMaterialPickLineSet(Objkey='X')/ShopMaterialPickLineArray?$filter=PartNo eq 'P1'" };
  const result = buildNavigationQueryableScript("ReportPickingOfShopOrderPickListHandling", NAV_QUERYABLE_SOURCE, "ShopMaterialPickLineSet", "ShopMaterialPickLineArray", "Objkey='X'", call);
  assert.match(result.script, /return select \* from source where PartNo = "P1"/);
});

test("buildNavigationQueryableScript returns null when no candidate function exists, when it doesn't take exactly one param, or when the param isn't a resolvable record type — caller falls back to the normal resolution path", () => {
  assert.equal(buildNavigationQueryableScript("X", "no such function here", "EntitySet", "NavProp", null, { url: "https://x/y" }), null);

  const twoParams = "function NavProp_FromEntitySet(entity: X_Keys, extra: text) { return Queryable.Create<A, B, text>(x, y); }\ntype X_Keys = { Id: text };";
  assert.equal(buildNavigationQueryableScript("X", twoParams, "EntitySet", "NavProp", null, { url: "https://x/y" }), null);

  const scalarParam = "function NavProp_FromEntitySet(id: text) { return Queryable.Create<A, B, text>(x, y); }";
  assert.equal(buildNavigationQueryableScript("X", scalarParam, "EntitySet", "NavProp", null, { url: "https://x/y" }), null);

  const noQueryable = "function NavProp_FromEntitySet(entity: X_Keys) { return 1; }\ntype X_Keys = { Id: text };";
  assert.equal(buildNavigationQueryableScript("X", noQueryable, "EntitySet", "NavProp", null, { url: "https://x/y" }), null);
});

test("buildCallScript uses the navigation-queryable fallback end-to-end for a real 2-segment GET with no bound action", () => {
  const call = { method: "GET", url: "https://uatifs.hima.com/main/ifsapplications/projection/v1/ReportPickingOfShopOrderPickListHandling.svc/ShopMaterialPickLineSet(Objkey='58C2CFF998C30482E0630A3165647DC8')/ShopMaterialPickLineArray?$select=QtyToPick,PartNo&$skip=0&$top=25" };
  const result = buildCallScript(call, "ReportPickingOfShopOrderPickListHandling", NAV_QUERYABLE_SOURCE);
  assert.equal(result.resolved, true);
  assert.equal(result.label, "ShopMaterialPickLineArray_FromShopMaterialPickLineSet");
  assert.match(result.script, /let source = ShopMaterialPickLineArray_FromShopMaterialPickLineSet\(entity\);/);
});

test("buildCallScript does NOT use the navigation-queryable fallback for a plain bound-function GET (3+ segments, real dotted action name)", () => {
  const source = [
    "function CustomerOrderLine_Default(headers: Header* = []): CustomerOrderLine {",
    "    let __raw = JSON.deserialize{}(GetResponse(`CustomerOrderHandling.svcCustomerOrderLineSetIfsApp.CustomerOrderHandling.CustomerOrderLine_Default()`, headers))",
    "    return unsafeCastCustomerOrderLine(__raw);",
    "}"
  ].join("\n");
  const call = { method: "GET", url: "https://x.example.com/.../CustomerOrderHandling.svc/CustomerOrderSet(OrderNo='X')/OrderLinesArray/IfsApp.CustomerOrderHandling.CustomerOrderLine_Default()" };
  const result = buildCallScript(call, "CustomerOrderHandling", source);
  // 3 segments — not the 2-segment nav-queryable shape — should still hit the raw-context fallback (bug #40/#41), not this one.
  assert.doesNotMatch(result.script, /_From/);
});

/* ---------- disambiguateLocalName / usedNames threading, real bug, live, 2026-08-11: FlowScript's
   `let` variable namespace is flat across the WHOLE flow, not scoped per script step (same reason
   flow-steps.js already disambiguates step OUTPUT variable names) — a script-internal `let` name we
   choose ourselves (entity/source in buildNavigationQueryableScript, headers in
   buildRawContextualCallScript) collided across two occurrences of the same call shape in one
   session: "The identifier 'source' is already declared." ---------- */

test("disambiguateLocalName returns the base name unchanged the first time, then appends an incrementing suffix on collision, and mutates usedNames in place", () => {
  const used = new Set();
  assert.equal(disambiguateLocalName("entity", used), "entity");
  assert.equal(disambiguateLocalName("entity", used), "entity2");
  assert.equal(disambiguateLocalName("entity", used), "entity3");
  assert.deepEqual([...used], ["entity", "entity2", "entity3"]);
});

test("buildNavigationQueryableScript disambiguates entity/source against a shared usedNames set — real bug, live: two real occurrences of the same nav-queryable shape in one session both declared bare `entity`/`source`", () => {
  const used = new Set();
  const call = { method: "GET", url: "https://x.example.com/.../ReportPickingOfShopOrderPickListHandling.svc/ShopMaterialPickLineSet(Objkey='A')/ShopMaterialPickLineArray" };
  const first = buildNavigationQueryableScript("ReportPickingOfShopOrderPickListHandling", NAV_QUERYABLE_SOURCE, "ShopMaterialPickLineSet", "ShopMaterialPickLineArray", "Objkey='A'", call, used);
  const second = buildNavigationQueryableScript("ReportPickingOfShopOrderPickListHandling", NAV_QUERYABLE_SOURCE, "ShopMaterialPickLineSet", "ShopMaterialPickLineArray", "Objkey='B'", call, used);
  assert.match(first.script, /let entity: ShopMaterialPickLineVirtual_Keys/);
  assert.match(first.script, /let source = /);
  assert.match(second.script, /let entity2: ShopMaterialPickLineVirtual_Keys/);
  assert.match(second.script, /let source2 = ShopMaterialPickLineArray_FromShopMaterialPickLineSet\(entity2\);/);
  assert.match(second.script, /return select \* from source2/);
});

/* ---------- buildNavigationChildWriteScript / buildCallScript's nav-child-write fallback, real
   bug, live, 2026-08-13 (ReceiveWithSerialsLots.svc, PATCH
   SplitArrivalSet(Objkey='X')/SplitArrivalLines(Objkey='Y')): a WRITE to a child ROW of a
   navigation-property collection has no bound function/action at all — deriveWriteCandidates'
   actionName branch (meant for genuine bound actions) took priority regardless of method and
   produced candidate names missing the real "_Update"/"_Create" suffix. Real module source
   (trimmed to the fields this logic actually reads) confirms the generated function name is
   "<EntitySet>_<NavProp>_<Verb>" with plain scalar key params (parent key, then — Update only —
   child key), then `input`. ---------- */

const SPLIT_ARRIVAL_SOURCE = [
  "type SplitArrivalLineVirtual = { \"@odata.etag\": text, Objkey: text, LocationNo: text? = null, Warehouse: text? = null };",
  "type SplitArrivalLineVirtualUpdateRequest = { optional LocationNo: text, optional Warehouse: text };",
  "function SplitArrivalSet_SplitArrivalLines_Update(ObjkeySplitArrivalSet:text, SplitArrivalLineVirtual_Objkey:text, input: SplitArrivalLineVirtualUpdateRequest, headers: Header* = []): SplitArrivalLineVirtual {",
  "    let __raw = JSON.deserialize<{}>(PatchResponse(`/ReceiveWithSerialsLots.svc/SplitArrivalSet(Objkey='{str(ObjkeySplitArrivalSet)}')/SplitArrivalLines(Objkey='{str(SplitArrivalLineVirtual_Objkey)}')`, JSON.serialize(input), headers))",
  "    return unsafeCast<SplitArrivalLineVirtual>(__raw);",
  "}",
  "type SequencesVirtualInsertRequest = { optional Quantity: number };",
  "function SequenceGeneratorSet_SequenceArray_Create(Objkey:text, input: SequencesVirtualInsertRequest, headers: Header* = []): SequencesVirtual {",
  "    let __raw = JSON.deserialize<{}>(PostResponse(`/ReceiveWithSerialsLots.svc/SequenceGeneratorSet(Objkey='{str(Objkey)}')/SequenceArray`, JSON.serialize(input), headers))",
  "    return unsafeCast<SequencesVirtual>(__raw);",
  "}"
].join("\n");

test("buildNavigationChildWriteScript resolves the real SplitArrivalLines PATCH case: finds <EntitySet>_<NavProp>_Update, builds both parent+child keys as plain scalar positional args (not a _Keys record), and the PATCH body as a real classified input record", () => {
  const call = { method: "PATCH", url: "https://x.example.com/.../ReceiveWithSerialsLots.svc/SplitArrivalSet(Objkey='CC4F3DE211424807BC32F9CA73E2055C')/SplitArrivalLines(Objkey='D8CF239AC56D4C53A734E43A1463087D')", requestBody: JSON.stringify({ LocationNo: "MS1", Warehouse: "W1" }) };
  const result = buildNavigationChildWriteScript("ReceiveWithSerialsLots", SPLIT_ARRIVAL_SOURCE, "SplitArrivalSet", "SplitArrivalLines", "PATCH", "Objkey='CC4F3DE211424807BC32F9CA73E2055C'", "Objkey='D8CF239AC56D4C53A734E43A1463087D'", call);
  assert.equal(result.resolved, true);
  assert.equal(result.label, "SplitArrivalSet_SplitArrivalLines_Update");
  assert.equal(
    result.script,
    'open ReceiveWithSerialsLots;\n' +
    'let input: SplitArrivalLineVirtualUpdateRequest = {\n' +
    '  LocationNo: "MS1",\n' +
    '  Warehouse: "W1"\n' +
    '};\n' +
    'return SplitArrivalSet_SplitArrivalLines_Update("CC4F3DE211424807BC32F9CA73E2055C", "D8CF239AC56D4C53A734E43A1463087D", input);'
  );
  assert.deepEqual(result.resultFields, [
    { name: "@odata.etag", type: "text", optional: false },
    { name: "Objkey", type: "text", optional: false },
    { name: "LocationNo", type: "text?", optional: false },
    { name: "Warehouse", type: "text?", optional: false }
  ]);
  // Parent + child key valueSlots, in order — the exact gap this bug's error message showed
  // (both had silently vanished from dependency/user-input consideration before this fix).
  assert.deepEqual(result.valueSlots.slice(0, 2), [
    { path: "ObjkeySplitArrivalSet", value: "CC4F3DE211424807BC32F9CA73E2055C", literal: '"CC4F3DE211424807BC32F9CA73E2055C"', kind: "text", kindKnown: true, nullable: false, valueNullable: false },
    { path: "SplitArrivalLineVirtual_Objkey", value: "D8CF239AC56D4C53A734E43A1463087D", literal: '"D8CF239AC56D4C53A734E43A1463087D"', kind: "text", kindKnown: true, nullable: false, valueNullable: false }
  ]);
});

test("buildNavigationChildWriteScript handles the Create verb (POST), which takes only the PARENT key, no child key yet", () => {
  const call = { method: "POST", url: "https://x.example.com/.../ReceiveWithSerialsLots.svc/SequenceGeneratorSet(Objkey='G1')/SequenceArray", requestBody: JSON.stringify({ Quantity: 5 }) };
  const result = buildNavigationChildWriteScript("ReceiveWithSerialsLots", SPLIT_ARRIVAL_SOURCE, "SequenceGeneratorSet", "SequenceArray", "POST", "Objkey='G1'", null, call);
  assert.equal(result.resolved, true);
  assert.equal(result.label, "SequenceGeneratorSet_SequenceArray_Create");
  assert.match(result.script, /return SequenceGeneratorSet_SequenceArray_Create\("G1", input\);/);
});

test("buildNavigationChildWriteScript returns null (caller falls back unchanged) when no candidate function exists, or its key-param count doesn't match the URL's own parent+child key segments", () => {
  const call = { method: "PATCH", url: "https://x/y" };
  assert.equal(buildNavigationChildWriteScript("X", "no such function here", "EntitySet", "NavProp", "PATCH", "Objkey='X'", "Objkey='Y'", call), null);

  // Real function exists but only ONE key param declared — URL supplies parent+child (2) — must
  // not guess which raw value maps to the single param.
  const wrongArity = "type T = { optional F: text };\nfunction EntitySet_NavProp_Update(onlyOneKey:text, input: T, headers: Header* = []): T { return input; }";
  assert.equal(buildNavigationChildWriteScript("X", wrongArity, "EntitySet", "NavProp", "PATCH", "Objkey='X'", "Objkey='Y'", call), null);
});

test("buildCallScript uses the nav-child-write fallback end-to-end for the real SplitArrivalLines PATCH, and still resolves a genuine dot-qualified bound-action write unaffected", () => {
  const call = { method: "PATCH", url: "https://ifscloud.flowington.com/main/ifsapplications/projection/v1/ReceiveWithSerialsLots.svc/SplitArrivalSet(Objkey='CC4F3DE211424807BC32F9CA73E2055C')/SplitArrivalLines(Objkey='D8CF239AC56D4C53A734E43A1463087D')?select-fields=LocationNo,Warehouse", requestBody: JSON.stringify({ LocationNo: "MS1" }) };
  const result = buildCallScript(call, "ReceiveWithSerialsLots", SPLIT_ARRIVAL_SOURCE);
  assert.equal(result.resolved, true);
  assert.equal(result.label, "SplitArrivalSet_SplitArrivalLines_Update");
  assert.match(result.script, /return SplitArrivalSet_SplitArrivalLines_Update\("CC4F3DE211424807BC32F9CA73E2055C", "D8CF239AC56D4C53A734E43A1463087D", input\);/);
});

test("buildCallScript does NOT use the nav-child-write fallback for a genuine dot-qualified bound action (e.g. .../IfsApp.Module.SomeAction(...)) — that's a real action, not a nav-property child row", () => {
  const source = "function SomeEntitySet_SomeAction(entity:text, headers: Header* = []) { return 1; }";
  const call = { method: "POST", url: "https://x.example.com/.../SomeModule.svc/SomeEntitySet(Objkey='X')/IfsApp.SomeModule.SomeAction()" };
  const result = buildCallScript(call, "SomeModule", source);
  // Dot-qualified last segment -> real action -> must go through the normal bound-action
  // resolution path, never buildNavigationChildWriteScript's <EntitySet>_<NavProp>_<Verb> shape.
  assert.doesNotMatch(result.script, /SomeEntitySet_IfsApp/);
});

test("buildRawContextualCallScript disambiguates headers (declaration AND every reference inside the copied body) against a shared usedNames set", () => {
  const source = [
    "function CustomerOrderLine_Default(headers: Header* = []): CustomerOrderLine {",
    "    let __raw = JSON.deserialize{}(GetResponse(`CustomerOrderHandling.svcCustomerOrderLineSetIfsApp.CustomerOrderHandling.CustomerOrderLine_Default()`, headers))",
    "    return unsafeCastCustomerOrderLine(__raw);",
    "}"
  ].join("\n");
  const used = new Set();
  const first = buildRawContextualCallScript("CustomerOrderHandling", source, "CustomerOrderLine_Default", "CustomerOrderSet(OrderNo='A')/OrderLinesArray/IfsApp.CustomerOrderHandling.CustomerOrderLine_Default()", undefined, undefined, used);
  const second = buildRawContextualCallScript("CustomerOrderHandling", source, "CustomerOrderLine_Default", "CustomerOrderSet(OrderNo='B')/OrderLinesArray/IfsApp.CustomerOrderHandling.CustomerOrderLine_Default()", undefined, undefined, used);
  assert.match(first.script, /let headers: Header\* = \[\];/);
  assert.match(first.script, /GetResponse\(`[^`]*`, headers\)/);
  assert.match(second.script, /let headers2: Header\* = \[\];/);
  assert.match(second.script, /GetResponse\(`[^`]*`, headers2\)/);
  assert.doesNotMatch(second.script, /,\s*headers\)/); // the declaration's OWN default isn't accidentally left referencing the old name
});

test("buildCallScript threads usedNames through end-to-end so two navigation-queryable calls in one session don't collide", () => {
  const used = new Set();
  const call1 = { method: "GET", url: "https://x.example.com/.../ReportPickingOfShopOrderPickListHandling.svc/ShopMaterialPickLineSet(Objkey='A')/ShopMaterialPickLineArray" };
  const call2 = { method: "GET", url: "https://x.example.com/.../ReportPickingOfShopOrderPickListHandling.svc/ShopMaterialPickLineSet(Objkey='B')/ShopMaterialPickLineArray" };
  const r1 = buildCallScript(call1, "ReportPickingOfShopOrderPickListHandling", NAV_QUERYABLE_SOURCE, used);
  const r2 = buildCallScript(call2, "ReportPickingOfShopOrderPickListHandling", NAV_QUERYABLE_SOURCE, used);
  assert.match(r1.script, /let entity: /);
  assert.match(r2.script, /let entity2: /);
});

test("buildInlineRecordLet builds a let statement and classifies top-level valueSlots against the declared record type", () => {
  const source = `type Params = { Contract: text, SupplyCountry: Lookup_IsoCountry.Value };`;
  const valueSlots = [];
  const line = buildInlineRecordLet("Params", "Params", { Contract: "NC01", SupplyCountry: "US" }, source, "CustomerOrderHandling", valueSlots);
  assert.match(line, /^let Params: Params = \{/);
  assert.match(line, /Contract: "NC01"/);
  assert.match(line, /SupplyCountry: CustomerOrderHandling\.Lookup_IsoCountry\.fromText\("US"\)/);
  const contractSlot = valueSlots.find((s) => s.path === "Params.Contract");
  assert.equal(contractSlot.kind, "text");
  const countrySlot = valueSlots.find((s) => s.path === "Params.SupplyCountry");
  assert.equal(countrySlot.kind, "enum");
  assert.equal(countrySlot.enumType, "Lookup_IsoCountry");
});

test("buildInlineRecordLet marks kindKnown true when a field resolves against the declared type, and false when it doesn't — real bug, 2026-08-09: kind always defaults to \"text\" when a field can't be resolved (a safe default for downstream consumers like createControlForKind), but flow-dependency-tracer.js's value-only-match kind-conflict check needs to tell that default apart from a REAL classification, or it rejects the vast majority of legitimate matches (user-observed: ~20 real matches collapsed to 4 nonsense ones)", () => {
  const source = `type Params = { Contract: text };`;
  const valueSlots = [];
  buildInlineRecordLet("Params", "Params", { Contract: "NC01", Unrelated: "X" }, source, "CustomerOrderHandling", valueSlots);
  const knownSlot = valueSlots.find((s) => s.path === "Params.Contract");
  assert.equal(knownSlot.kindKnown, true);
  const unknownSlot = valueSlots.find((s) => s.path === "Params.Unrelated");
  assert.equal(unknownSlot.kind, "text"); // still defaults to text for downstream use
  assert.equal(unknownSlot.kindKnown, false); // but that default must not be trusted as known
});

test("buildInlineRecordLet classifies NESTED valueSlots (varName.Field.SubField) against the declared type too, keeping slot.literal in sync with what buildRecordLiteral actually emitted for that nested field — real bug, live, 2026-08-10: a nested enum field (ValidationRec.TaxLiabilityType) started rendering via Module.EnumType.fromText(...) once buildRecordLiteral gained nested-recursion (bug #36), but this classification loop still only matched top-level paths, so the slot's kind/literal stayed stale (\"text\"/plain-quoted) — dependency substitution's bare-literal fallback search then landed its own .name-converted reference INSIDE the pre-existing fromText(...) call instead of replacing it whole, producing a nonsensical fromText(ref.name) the server rejected (\"Could not convert to the corresponding enumeration value\")", () => {
  const source = [
    `type ValidationRec = { TaxLiabilityType: TaxLiabilityType.Value, Identity4: number };`,
    `type Params = { ValidationRec: ValidationRec };`
  ].join("\n");
  const valueSlots = [];
  const line = buildInlineRecordLet("input", "Params", { ValidationRec: { TaxLiabilityType: "TAX", Identity4: "0" } }, source, "CustomerOrderHandling", valueSlots);

  assert.match(line, /TaxLiabilityType: CustomerOrderHandling\.TaxLiabilityType\.fromText\("TAX"\)/);
  assert.match(line, /Identity4: 0/);

  const taxSlot = valueSlots.find((s) => s.path === "input.ValidationRec.TaxLiabilityType");
  assert.equal(taxSlot.kind, "enum");
  assert.equal(taxSlot.kindKnown, true);
  assert.equal(taxSlot.enumType, "TaxLiabilityType");
  // Re-synced to match what the script text ACTUALLY contains at this point — the qualified
  // "FieldName: literal" substitution search (applyDependency/substituteLiteral) needs this to
  // find and replace the WHOLE fromText(...) call, not just fall through to a bare-literal
  // search that lands its own replacement inside the wrapper.
  assert.equal(taxSlot.literal, 'CustomerOrderHandling.TaxLiabilityType.fromText("TAX")');

  const identitySlot = valueSlots.find((s) => s.path === "input.ValidationRec.Identity4");
  assert.equal(identitySlot.kind, "number");
  assert.equal(identitySlot.kindKnown, true);
  assert.equal(identitySlot.literal, "0");
});

test("buildInlineRecordLet leaves an ARRAY-indexed nested slot (Field[0].Sub) at the safe default — arrays aren't walked", () => {
  const source = `type Params = { Lines: {Qty: number}* };`;
  const valueSlots = [];
  buildInlineRecordLet("input", "Params", { Lines: [{ Qty: "5" }] }, source, "CustomerOrderHandling", valueSlots);
  const qtySlot = valueSlots.find((s) => s.path === "input.Lines[0].Qty");
  assert.equal(qtySlot.kind, "text");
  assert.equal(qtySlot.kindKnown, false);
});

test("buildCallScript resolves an OData parameter alias (@AliasName key value -> same-named query-string param) to a real let statement and identifier arg — real bug, 2026-08-08: GetCustomerDefaults(...,CustomerDefaultsStructureParams=@CustomerDefaultsStructureParams) with ?@CustomerDefaultsStructureParams={...} rendered the bare alias text \"@CustomerDefaultsStructureParams\" as a string literal instead of resolving it", () => {
  const source = [
    `function GetCustomerDefaults(Contract: text, CustomerDefaultsStructureParams: CustomerDefaultsStructureParams): CustomerDefaultsStructure {`,
    `type CustomerDefaultsStructureParams = { Contract: text, SupplyCountry: text };`
  ].join("\n");
  const aliasValue = JSON.stringify({ Contract: "NC01", SupplyCountry: "US" });
  const call = {
    method: "GET",
    url: `https://x.example.com/.../SalesQuotationHandling.svc/GetCustomerDefaults(Contract='NC01',CustomerDefaultsStructureParams=@CustomerDefaultsStructureParams)?@CustomerDefaultsStructureParams=${encodeURIComponent(aliasValue)}`
  };
  const result = buildCallScript(call, "SalesQuotationHandling", source);
  assert.doesNotMatch(result.script, /@CustomerDefaultsStructureParams["']/); // never emitted as a text literal
  assert.match(result.script, /let CustomerDefaultsStructureParams: CustomerDefaultsStructureParams = \{/);
  assert.match(result.script, /Contract: "NC01"/);
  assert.match(result.script, /SupplyCountry: "US"/);
  assert.match(
    result.script,
    /return GetCustomerDefaults\("NC01", CustomerDefaultsStructureParams\);/
  );
  const slot = result.valueSlots.find((s) => s.path === "CustomerDefaultsStructureParams.Contract");
  assert.ok(slot, "alias object's fields should be collected as valueSlots too (dependency-traceable)");
  assert.equal(slot.value, "NC01");
});

test("buildCallScript falls back to a visible TODO when an alias key value can't be resolved (missing query param)", () => {
  const source = `function GetCustomerDefaults(Params: SomeParams): text {`;
  const call = {
    method: "GET",
    url: "https://x.example.com/.../SalesQuotationHandling.svc/GetCustomerDefaults(Params=@Params)"
  };
  const result = buildCallScript(call, "SalesQuotationHandling", source);
  assert.match(result.script, /TODO: could not resolve alias parameter @Params/);
});

test("getHeader looks up a header case-insensitively", () => {
  assert.equal(getHeader({ "Content-Type": "text/plain" }, "content-type"), "text/plain");
  assert.equal(getHeader({ "content-type": "text/plain" }, "Content-Type"), "text/plain");
});

test("getHeader returns null when the header isn't present, or headers is null", () => {
  assert.equal(getHeader({}, "Content-Type"), null);
  assert.equal(getHeader(null, "Content-Type"), null);
});

test("extractBatchBoundary reads the boundary out of a multipart Content-Type header", () => {
  assert.equal(extractBatchBoundary("multipart/mixed;boundary=fa842d2d-8304-40ae-b8d2-f920c6e5f94d"), "fa842d2d-8304-40ae-b8d2-f920c6e5f94d");
});

test("extractBatchBoundary returns null for a non-multipart Content-Type", () => {
  assert.equal(extractBatchBoundary("application/json;IEEE754Compatible=true"), null);
  assert.equal(extractBatchBoundary(null), null);
});

test("isBatchCall is true for a POST to .../$batch with a multipart Content-Type", () => {
  const call = {
    method: "POST",
    url: "https://x.example.com/main/ifsapplications/projection/v1/CustomerOrderHandling.svc/$batch",
    requestHeaders: { "Content-Type": "multipart/mixed;boundary=abc-123" }
  };
  assert.equal(isBatchCall(call), true);
});

test("isBatchCall is false for a normal (non-$batch) call", () => {
  const call = {
    method: "GET",
    url: "https://x.example.com/main/ifsapplications/projection/v1/CustomerOrderHandling.svc/CustomerOrderSet",
    requestHeaders: { "Content-Type": "application/json" }
  };
  assert.equal(isBatchCall(call), false);
});

test("isBatchCall is false for a POST to .../$batch with a non-multipart Content-Type", () => {
  const call = {
    method: "POST",
    url: "https://x.example.com/main/ifsapplications/projection/v1/CustomerOrderHandling.svc/$batch",
    requestHeaders: { "Content-Type": "application/json" }
  };
  assert.equal(isBatchCall(call), false);
});

test("splitMultipartParts splits a real two-part batch body on the boundary", () => {
  const boundary = "fa842d2d-8304-40ae-b8d2-f920c6e5f94d";
  const body = [
    `--${boundary}`,
    "Content-Type: application/http",
    "Content-Transfer-Encoding:binary",
    "",
    "GET CustomerOrderSet(OrderNo='%2A1103')?$select=OrderNo,CustomerNo HTTP/1.1",
    "Accept:application/json;odata.metadata=full;IEEE754Compatible=true",
    "",
    "",
    `--${boundary}`,
    "Content-Type: application/http",
    "Content-Transfer-Encoding:binary",
    "",
    "GET CustomerOrderSet(OrderNo='%2A1102')?$select=OrderNo,CustomerNo HTTP/1.1",
    "Accept:application/json;odata.metadata=full;IEEE754Compatible=true",
    "",
    "",
    `--${boundary}--`
  ].join("\r\n");
  const parts = splitMultipartParts(body, boundary);
  assert.equal(parts.length, 2);
  assert.match(parts[0], /GET CustomerOrderSet\(OrderNo='%2A1103'\)/);
  assert.match(parts[1], /GET CustomerOrderSet\(OrderNo='%2A1102'\)/);
});

test("splitMultipartParts returns an empty array for missing body or boundary", () => {
  assert.deepEqual(splitMultipartParts(null, "abc"), []);
  assert.deepEqual(splitMultipartParts("body text", null), []);
});

test("parseBatchPartRequestLine extracts method and path/query from a part's inner HTTP request line", () => {
  const partText = [
    "Content-Type: application/http",
    "Content-Transfer-Encoding:binary",
    "",
    "GET CustomerOrderSet(OrderNo='%2A1103')?$select=OrderNo,CustomerNo HTTP/1.1",
    "Accept:application/json;odata.metadata=full;IEEE754Compatible=true"
  ].join("\r\n");
  const result = parseBatchPartRequestLine(partText);
  assert.deepEqual(result, { method: "GET", pathAndQuery: "CustomerOrderSet(OrderNo='%2A1103')?$select=OrderNo,CustomerNo" });
});

test("parseBatchPartRequestLine returns null when no request line is found", () => {
  assert.equal(parseBatchPartRequestLine("nothing recognizable here"), null);
});

test("rawQuotedODataValue returns the raw (still percent-encoded) inner text of a simple quoted value", () => {
  assert.equal(rawQuotedODataValue("'%2A1103'"), "%2A1103");
});

test("rawQuotedODataValue un-escapes OData's doubled-quote syntax without percent-decoding", () => {
  assert.equal(rawQuotedODataValue("'O''Brien%20Ltd'"), "O'Brien%20Ltd");
});

test("rawQuotedODataValue returns null for a bare null keyword, a number, or a namespace-qualified enum literal", () => {
  assert.equal(rawQuotedODataValue("null"), null);
  assert.equal(rawQuotedODataValue("123"), null);
  assert.equal(rawQuotedODataValue("IfsApp.CustomerOrderHandling.Lookup_IsoCountry'US'"), null);
});

test("buildBatchIfsFunctionExpr splits a single simple-quoted key value into a substitutable concatenation piece, matching the design spec's worked example", () => {
  const valueSlots = [];
  const expr = buildBatchIfsFunctionExpr(
    "CustomerOrderSet(OrderNo='%2A1103')?$select=OrderNo,CustomerNo",
    "OrderNo='%2A1103'",
    0,
    valueSlots
  );
  assert.equal(expr, `"CustomerOrderSet(OrderNo='" & "%2A1103" & "')?$select=OrderNo,CustomerNo"`);
  assert.equal(valueSlots.length, 1);
  assert.deepEqual(valueSlots[0], {
    path: "batch[0].OrderNo",
    value: "*1103",
    literal: '"%2A1103"',
    kind: "text",
    nullable: false,
    valueNullable: false,
    wrapKind: "urlEncode"
  });
});

test("buildBatchIfsFunctionExpr returns a single literal (no concatenation) when no key value is a simple quoted string", () => {
  const valueSlots = [];
  const expr = buildBatchIfsFunctionExpr(
    "CustomerOrderSet(OrderNo=null)?$select=OrderNo",
    "OrderNo=null",
    0,
    valueSlots
  );
  assert.equal(expr, JSON.stringify("CustomerOrderSet(OrderNo=null)?$select=OrderNo"));
  assert.equal(valueSlots.length, 0);
});

test("buildBatchIfsFunctionExpr handles two simple-quoted key values in the same sub-request", () => {
  const valueSlots = [];
  const expr = buildBatchIfsFunctionExpr(
    "OrderLine(OrderNo='1103',LineNo='10')",
    "OrderNo='1103',LineNo='10'",
    2,
    valueSlots
  );
  assert.equal(expr, `"OrderLine(OrderNo='" & "1103" & "',LineNo='" & "10" & "')"`);
  assert.equal(valueSlots.length, 2);
  assert.equal(valueSlots[0].path, "batch[2].OrderNo");
  assert.equal(valueSlots[1].path, "batch[2].LineNo");
});

test("buildBatchIfsFunctionExpr falls back to the positional index for a genuinely unnamed key segment — real bug, 2026-08-10: a bare index alone (\"batch[0].0\") became a classify-modal variable/label name of literally \"0\" (invalid in Flow) whenever the value went unmapped; a real key name is used instead whenever the segment has one", () => {
  const valueSlots = [];
  buildBatchIfsFunctionExpr("Reference_CustOrdCust6('EXTERNAL01')", "'EXTERNAL01'", 0, valueSlots);
  assert.equal(valueSlots[0].path, "batch[0].0"); // no name on this segment — index is all we have
});

test("buildBatchPart builds a GET part with a substitutable key value, jsonBody empty", () => {
  const partText = [
    "Content-Type: application/http",
    "Content-Transfer-Encoding:binary",
    "",
    "GET CustomerOrderSet(OrderNo='%2A1103')?$select=OrderNo,CustomerNo HTTP/1.1",
    "Accept:application/json;odata.metadata=full;IEEE754Compatible=true",
    "Content-Type: application/json;IEEE754Compatible=true",
    "",
    ""
  ].join("\r\n");
  const valueSlots = [];
  const result = buildBatchPart(0, partText, valueSlots);
  assert.equal(result.functionMethod, "GET");
  assert.equal(result.ifsFunctionExpr, `"CustomerOrderSet(OrderNo='" & "%2A1103" & "')?$select=OrderNo,CustomerNo"`);
  assert.equal(result.jsonBody, '""');
  assert.equal(valueSlots.length, 1);
});

test("buildBatchPart falls back to a single opaque literal for a part with no key segment (e.g. a bare $filter GET)", () => {
  const partText = [
    "Content-Type: application/http",
    "Content-Transfer-Encoding:binary",
    "",
    "GET CustomerOrderSet?$filter=CustomerNo eq 'ABC' HTTP/1.1",
    "Accept:application/json"
  ].join("\r\n");
  const valueSlots = [];
  const result = buildBatchPart(0, partText, valueSlots);
  assert.equal(result.ifsFunctionExpr, JSON.stringify("CustomerOrderSet?$filter=CustomerNo eq 'ABC'"));
  assert.equal(valueSlots.length, 0);
});

test("buildBatchPart falls back to a TODO jsonBody for a write sub-request (has a body) — out of scope for v1", () => {
  const partText = [
    "Content-Type: application/http",
    "Content-Transfer-Encoding:binary",
    "",
    "PATCH CustomerOrderSet(OrderNo='1103') HTTP/1.1",
    "Content-Type: application/json;IEEE754Compatible=true",
    "",
    '{"CustomerNo":"ABC"}'
  ].join("\r\n");
  const valueSlots = [];
  const result = buildBatchPart(0, partText, valueSlots);
  assert.equal(result.functionMethod, "PATCH");
  assert.match(result.jsonBody, /TODO: batch write body not yet supported/);
  assert.equal(valueSlots.length, 0);
});

test("buildBatchPart falls back to a TODO for an unparseable part", () => {
  const valueSlots = [];
  const result = buildBatchPart(0, "nothing recognizable here", valueSlots);
  assert.match(result.ifsFunctionExpr, /TODO: could not parse batch part/);
});

test("buildCallScript translates a real recorded \$batch call into a script that embeds buildBatchCallIfs and calls it with both sub-requests' key values as substitutable pieces", () => {
  const boundary = "fa842d2d-8304-40ae-b8d2-f920c6e5f94d";
  const requestBody = [
    `--${boundary}`,
    "Content-Type: application/http",
    "Content-Transfer-Encoding:binary",
    "",
    "GET CustomerOrderSet(OrderNo='%2A1103')?$select=OrderNo,CustomerNo,Contract,WantedDeliveryDate,Objstate,Objgrants,luname,keyref HTTP/1.1",
    "Accept:application/json;odata.metadata=full;IEEE754Compatible=true",
    "Content-Type: application/json;IEEE754Compatible=true",
    "",
    "",
    `--${boundary}`,
    "Content-Type: application/http",
    "Content-Transfer-Encoding:binary",
    "",
    "GET CustomerOrderSet(OrderNo='%2A1102')?$select=OrderNo,CustomerNo,Contract,WantedDeliveryDate,Objstate,Objgrants,luname,keyref HTTP/1.1",
    "Accept:application/json;odata.metadata=full;IEEE754Compatible=true",
    "Content-Type: application/json;IEEE754Compatible=true",
    "",
    "",
    `--${boundary}--`
  ].join("\r\n");
  const call = {
    method: "POST",
    url: "https://ifscloud.flowington.com/main/ifsapplications/projection/v1/CustomerOrderHandling.svc/$batch",
    requestHeaders: { "Content-Type": `multipart/mixed;boundary=${boundary}` },
    requestBody
  };
  const result = buildCallScript(call, "CustomerOrderHandling", "");
  assert.equal(result.resolved, true);
  assert.equal(result.resultKind, "record");
  assert.equal(result.label, "BatchCall");
  assert.match(result.script, /^open CustomerOrderHandling;/);
  assert.match(result.script, /function buildBatchCallIfs\(batchEndpoint: text, content: \{functionMethod: text, ifsFunction: text, jsonBody: text\}\*\): text \{/);
  assert.match(result.script, /HTTP\.multipart\('mixed', bodyArray\)/);
  assert.match(
    result.script,
    /\{functionMethod: "GET", ifsFunction: "CustomerOrderSet\(OrderNo='" & "%2A1103" & "'\)\?\$select=OrderNo,CustomerNo,Contract,WantedDeliveryDate,Objstate,Objgrants,luname,keyref", jsonBody: ""\}/
  );
  assert.match(
    result.script,
    /\{functionMethod: "GET", ifsFunction: "CustomerOrderSet\(OrderNo='" & "%2A1102" & "'\)\?\$select=OrderNo,CustomerNo,Contract,WantedDeliveryDate,Objstate,Objgrants,luname,keyref", jsonBody: ""\}/
  );
  // Real bug, live, 2026-08-10: "You can not set an absolute url in Flow Developer when Base
  // url exists" — buildBatchCallIfs hands batchEndpoint straight to HTTP.request (unlike every
  // other GET/write call in this codebase, which goes through request()'s own addBasePath), so
  // it must get the relative path (origin+leading-slash stripped), matching the "basePath/..."
  // shape addBasePath produces for every other call.
  assert.match(result.script, /return buildBatchCallIfs\("main\/ifsapplications\/projection\/v1\/CustomerOrderHandling\.svc\/\$batch", \[/);
  assert.equal(result.valueSlots.length, 2);
  assert.equal(result.valueSlots[0].value, "*1103");
  assert.equal(result.valueSlots[0].wrapKind, "urlEncode");
  assert.equal(result.valueSlots[1].value, "*1102");
});

test("stripUrlOrigin strips scheme+host, keeps path (no leading slash) and query", () => {
  assert.equal(
    stripUrlOrigin("https://ifscloud.flowington.com/main/ifsapplications/projection/v1/CustomerOrderHandling.svc/$batch"),
    "main/ifsapplications/projection/v1/CustomerOrderHandling.svc/$batch"
  );
  assert.equal(stripUrlOrigin("https://x.example.com/Foo.svc/Bar?$top=5"), "Foo.svc/Bar?$top=5");
});

test("stripUrlOrigin returns the input unchanged for an unparseable URL (defensive)", () => {
  assert.equal(stripUrlOrigin("not a url"), "not a url");
});

test("buildCallScript does not route a normal (non-\$batch) call through the batch path", () => {
  const call = { method: "GET", url: "https://x.example.com/.../SalesQuotationHandling.svc/OrderQuotationSet" };
  const result = buildCallScript(call, "SalesQuotationHandling", "let OrderQuotationSet = Queryable.Create<ODataQueryTranslation, OrderQuotation, text>(x, y);");
  assert.notEqual(result.label, "BatchCall");
});
