const test = require("node:test");
const assert = require("node:assert/strict");
const { findDependencies, referenceExpression, wrapLikeReference, applyDependency, mappingKey, extractFirstRow, extractRows, isListSource, lastFieldName, namesSimilar, convertKindMismatch, isLowInformationValue, groupCandidatesByMapping } = require("./flow-dependency-tracer.js");

test("extractFirstRow returns the first row of an OData collection response", () => {
  const body = JSON.stringify({ value: [{ QuotationNo: "Q1" }, { QuotationNo: "Q2" }] });
  assert.deepEqual(extractFirstRow(body), { QuotationNo: "Q1" });
});

test("extractFirstRow returns null for an empty collection", () => {
  assert.equal(extractFirstRow(JSON.stringify({ value: [] })), null);
});

test("extractFirstRow returns the body itself for a single-record response", () => {
  const body = JSON.stringify({ CustomerNo: "16789" });
  assert.deepEqual(extractFirstRow(body), { CustomerNo: "16789" });
});

test("extractFirstRow returns null for unparsable or empty input", () => {
  assert.equal(extractFirstRow("not json"), null);
  assert.equal(extractFirstRow(null), null);
});

test("findDependencies matches a later step's key value against an earlier sequence step's field", () => {
  const stepContexts = [
    {
      label: "OrderQuotationSet",
      stepVarName: "GetOrderQuotationSet",
      resultKind: "sequence",
      responseBody: JSON.stringify({ value: [{ QuotationNo: "Q1", CustomerNo: "16789" }] }),
      valueSlots: []
    },
    {
      label: "OrderQuotationSet_Update",
      stepVarName: "PatchOrderQuotationSet",
      resultKind: "record",
      responseBody: null,
      valueSlots: [{ path: "QuotationNo", value: "Q1", literal: '"Q1"' }]
    }
  ];

  const candidates = findDependencies(stepContexts);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].stepIndex, 1);
  assert.equal(candidates[0].sourceStepIndex, 0);
  assert.equal(candidates[0].sourceFieldPath, "QuotationNo");
  assert.equal(candidates[0].sourceResultKind, "sequence");
});

test("findDependencies's candidate.sourceLabel reads a source step's baseLabel (undisambiguated) when present, not its display label — real request 2026-08-10: mappingKey needs the SAME undisambiguated name for a repeated call regardless of which numbered occurrence happened to match", () => {
  const stepContexts = [
    {
      label: "GetCustomerOrder_Default2",
      baseLabel: "GetCustomerOrder_Default",
      stepVarName: "GetCustomerOrder_Default1",
      resultKind: "record",
      responseBody: JSON.stringify({ OrderNo: "NO123" }),
      valueSlots: []
    },
    {
      label: "PatchStep",
      stepVarName: "PatchStep1",
      resultKind: "record",
      responseBody: null,
      valueSlots: [{ path: "input.OrderNo", value: "NO123", literal: '"NO123"' }]
    }
  ];
  const candidates = findDependencies(stepContexts);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sourceLabel, "GetCustomerOrder_Default");
});

test("findDependencies tags a candidate's sourceKind from the source step's resultFields (real case, 2026-08-08: GetCustomerDefaults.SupplyCountryDb declared text? in its own return type)", () => {
  const stepContexts = [
    {
      label: "GetCustomerDefaults",
      stepVarName: "GetGetCustomerDefaults",
      resultKind: "record",
      responseBody: JSON.stringify({ SupplyCountryDb: "SE" }),
      valueSlots: [],
      resultFields: [{ name: "SupplyCountryDb", type: "text?", optional: false }]
    },
    {
      label: "ValidateCatalogNo",
      stepVarName: "PostValidateCatalogNo",
      resultKind: "record",
      responseBody: null,
      valueSlots: [{ path: "input.SupplyCountryDb", value: "SE", literal: '"SE"' }]
    }
  ];
  const candidates = findDependencies(stepContexts);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sourceKind, "text");
});

test("findDependencies tags sourceKind null when the field isn't in the source step's resultFields (unclassifiable, treated conservatively downstream)", () => {
  const stepContexts = [
    {
      label: "GetCustomerDefaults",
      stepVarName: "GetGetCustomerDefaults",
      resultKind: "record",
      responseBody: JSON.stringify({ Unlisted: "SE" }),
      valueSlots: [],
      resultFields: [{ name: "SomethingElse", type: "text", optional: false }]
    },
    {
      label: "ValidateCatalogNo",
      stepVarName: "PostValidateCatalogNo",
      resultKind: "record",
      responseBody: null,
      valueSlots: [{ path: "input.Unlisted", value: "SE", literal: '"SE"' }]
    }
  ];
  const candidates = findDependencies(stepContexts);
  assert.equal(candidates[0].sourceKind, null);
});

test("findDependencies never matches a step against its own response", () => {
  const stepContexts = [
    {
      label: "OrderQuotationSet_Create",
      stepVarName: "PostOrderQuotationSet",
      resultKind: "record",
      responseBody: JSON.stringify({ QuotationNo: "Q1" }),
      valueSlots: [{ path: "input.QuotationNo", value: "Q1", literal: '"Q1"' }]
    }
  ];
  assert.deepEqual(findDependencies(stepContexts), []);
});

test("findDependencies ignores values with no earlier match", () => {
  const stepContexts = [
    { label: "A", stepVarName: "A1", resultKind: "record", responseBody: JSON.stringify({ Foo: "bar" }), valueSlots: [] },
    { label: "B", stepVarName: "B1", resultKind: "record", responseBody: null, valueSlots: [{ path: "input.X", value: "unrelated", literal: '"unrelated"' }] }
  ];
  assert.deepEqual(findDependencies(stepContexts), []);
});

test("lastFieldName strips array indices and dotted prefixes", () => {
  assert.equal(lastFieldName("input.Lines[0].Qty"), "Qty");
  assert.equal(lastFieldName("QuotationNo"), "QuotationNo");
});

test("namesSimilar matches case-insensitively and by containment", () => {
  assert.equal(namesSimilar("QuotationNo", "quotationno"), true);
  assert.equal(namesSimilar("QuotationNo", "SourceQuotationNo"), true);
  assert.equal(namesSimilar("QuotationNo", "CustomerNo"), false);
});

test("findDependencies prefers a name-similar match over an unrelated same-value match", () => {
  const stepContexts = [
    {
      label: "GetSiteDefaults",
      stepVarName: "GetSiteDefaults1",
      resultKind: "record",
      responseBody: JSON.stringify({ Active: true }), // unrelated field, happens to share the value
      valueSlots: []
    },
    {
      label: "OrderQuotationSet",
      stepVarName: "GetOrderQuotationSet",
      resultKind: "sequence",
      responseBody: JSON.stringify({ value: [{ CompanyActive: true }] }), // name-similar to the target
      valueSlots: []
    },
    {
      label: "OrderQuotationSet_Update",
      stepVarName: "PatchOrderQuotationSet",
      resultKind: "record",
      responseBody: null,
      valueSlots: [{ path: "input.CompanyActive", value: true, literal: "true" }]
    }
  ];

  const candidates = findDependencies(stepContexts);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sourceStepIndex, 1); // the name-similar source, not the earlier unrelated one
  assert.equal(candidates[0].matchedByName, true);
});

test("findDependencies marks a value-only fallback match with matchedByName: false, for the review UI's confidence split", () => {
  const stepContexts = [
    {
      label: "GetSiteDefaults",
      stepVarName: "GetSiteDefaults1",
      resultKind: "record",
      responseBody: JSON.stringify({ SomeUnrelatedField: "Q1" }),
      valueSlots: []
    },
    {
      label: "OrderQuotationSet_Update",
      stepVarName: "PatchOrderQuotationSet",
      resultKind: "record",
      responseBody: null,
      valueSlots: [{ path: "input.TotallyDifferentName", value: "Q1", literal: '"Q1"' }]
    }
  ];
  const candidates = findDependencies(stepContexts);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].matchedByName, false);
});

test("findDependencies does not fall back to a value-only match for booleans with no name-similar source", () => {
  const stepContexts = [
    {
      label: "GetSiteDefaults",
      stepVarName: "GetSiteDefaults1",
      resultKind: "record",
      responseBody: JSON.stringify({ Active: true }),
      valueSlots: []
    },
    {
      label: "OrderQuotationSet_Update",
      stepVarName: "PatchOrderQuotationSet",
      resultKind: "record",
      responseBody: null,
      valueSlots: [{ path: "input.IsPreliminary", value: true, literal: "true" }]
    }
  ];
  assert.deepEqual(findDependencies(stepContexts), []);
});

test("isLowInformationValue treats booleans, 0/1 (both number and text form), empty string, and null as too common to trust a name-blind match against", () => {
  assert.equal(isLowInformationValue(true), true);
  assert.equal(isLowInformationValue(false), true);
  assert.equal(isLowInformationValue(0), true);
  assert.equal(isLowInformationValue(1), true);
  assert.equal(isLowInformationValue("0"), true);
  assert.equal(isLowInformationValue("1"), true);
  assert.equal(isLowInformationValue(""), true);
  assert.equal(isLowInformationValue(null), true);
});

test("isLowInformationValue treats ANY bare number or numeric-looking text as low-information, not just 0/1 — real bug, 2026-08-10: RevisedQtyDue coincidentally matched CurrRounding, both genuinely \"2\" (not on the old 0/1-only list) — chasing individual risky values doesn't converge, so every plain number is excluded now regardless of magnitude", () => {
  assert.equal(isLowInformationValue(2), true);
  assert.equal(isLowInformationValue("2"), true);
  assert.equal(isLowInformationValue(-1), true);
  assert.equal(isLowInformationValue("47"), true);
  assert.equal(isLowInformationValue("3.5"), true);
});

test("isLowInformationValue treats common boolean-word text as low-information, case-insensitively — real request 2026-08-10", () => {
  assert.equal(isLowInformationValue("TRUE"), true);
  assert.equal(isLowInformationValue("False"), true);
  assert.equal(isLowInformationValue("Yes"), true);
  assert.equal(isLowInformationValue("no"), true);
  assert.equal(isLowInformationValue("Y"), true);
  assert.equal(isLowInformationValue("N"), true);
});

test("isLowInformationValue is still false for a genuinely distinctive text value — a customer number, a code, a name", () => {
  assert.equal(isLowInformationValue("NC01"), false);
  assert.equal(isLowInformationValue("EXTERNAL01"), false);
  assert.equal(isLowInformationValue("Yesterday's Report"), false); // contains "Yes" but isn't the whole value
});

test("findDependencies does not fall back to a value-only match when the shared value is a small number (0/1) even when the source's and target's kinds agree — real bug, 2026-08-09/10: RentalChargableDays coincidentally matched ConvFactor, both genuinely number-typed and both \"1\" — kind agreement alone doesn't mean the fields are related when the shared value is this common", () => {
  const stepContexts = [
    {
      label: "CustomerOrderLine_Default",
      stepVarName: "GetCustomerOrderLine_Default1",
      resultKind: "record",
      responseBody: JSON.stringify({ ConvFactor: "1" }),
      resultFields: [{ name: "ConvFactor", type: "number" }],
      valueSlots: []
    },
    {
      label: "ValidateAndFetchCatalogNoDefaults",
      stepVarName: "PatchValidate",
      resultKind: "record",
      responseBody: null,
      valueSlots: [{ path: "input.RentalChargableDays", value: "1", literal: '"1"', kind: "number", kindKnown: true }]
    }
  ];
  assert.deepEqual(findDependencies(stepContexts), []);
});

test("findDependencies still falls back to value-only matching for non-boolean values", () => {
  const stepContexts = [
    {
      label: "GetSiteDefaults",
      stepVarName: "GetSiteDefaults1",
      resultKind: "record",
      responseBody: JSON.stringify({ SomeUnrelatedField: "Q1" }),
      valueSlots: []
    },
    {
      label: "OrderQuotationSet_Update",
      stepVarName: "PatchOrderQuotationSet",
      resultKind: "record",
      responseBody: null,
      valueSlots: [{ path: "input.TotallyDifferentName", value: "Q1", literal: '"Q1"' }]
    }
  ];
  const candidates = findDependencies(stepContexts);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sourceFieldPath, "SomeUnrelatedField");
});

test("findDependencies does NOT fall back to a value-only match when the source's and target's declared kinds are both known and conflict — real bug, 2026-08-09: RentalChargableDays (number) coincidentally matched ShipAddrNo (text), both recorded as \"1\", zero name similarity, purely a shared value — server rejected it: \"field 'RentalChargableDays' has type text? but expected number?\"", () => {
  const stepContexts = [
    {
      label: "GetGetCustomerDefaults",
      stepVarName: "GetGetCustomerDefaults1",
      resultKind: "record",
      responseBody: JSON.stringify({ ShipAddrNo: "1" }),
      resultFields: [{ name: "ShipAddrNo", type: "text" }],
      valueSlots: []
    },
    {
      label: "ValidateAndFetchCatalogNoDefaults",
      stepVarName: "PatchValidate",
      resultKind: "record",
      responseBody: null,
      valueSlots: [{ path: "input.RentalChargableDays", value: "1", literal: '"1"', kind: "number", kindKnown: true }]
    }
  ];
  assert.deepEqual(findDependencies(stepContexts), []);
});

test("findDependencies still falls back to a value-only match when the target's kind is only the DEFAULT (kindKnown false) even though it happens to differ from the source's real kind — real regression, 2026-08-09: this default (flow-call-script.js always defaults an unresolvable field's kind to \"text\" for downstream consumers) is NOT a positive classification; trusting it collapsed ~20 real matches down to 4 nonsense ones", () => {
  const stepContexts = [
    {
      label: "GetGetCustomerDefaults",
      stepVarName: "GetGetCustomerDefaults1",
      resultKind: "record",
      responseBody: JSON.stringify({ SomeNumberField: "NC01" }),
      resultFields: [{ name: "SomeNumberField", type: "number" }],
      valueSlots: []
    },
    {
      label: "SomeWriteCall",
      stepVarName: "PatchSomeWriteCall",
      resultKind: "record",
      responseBody: null,
      // kind: "text" here is the DEFAULT (field's declared type couldn't be resolved), not a
      // real classification — kindKnown is false/absent, so this must still match. Value is a
      // distinctive text string (not a bare number) so isLowInformationValue's own — separate —
      // exclusion doesn't mask what THIS test is checking.
      valueSlots: [{ path: "input.UnrelatedField", value: "NC01", literal: '"NC01"', kind: "text" }]
    }
  ];
  const candidates = findDependencies(stepContexts);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sourceFieldPath, "SomeNumberField");
});

test("findDependencies still matches a value-only candidate when kinds agree (both known, both the same)", () => {
  const stepContexts = [
    {
      label: "GetGetCustomerDefaults",
      stepVarName: "GetGetCustomerDefaults1",
      resultKind: "record",
      responseBody: JSON.stringify({ ShipAddrNo: "NC01" }),
      resultFields: [{ name: "ShipAddrNo", type: "text" }],
      valueSlots: []
    },
    {
      label: "ValidateAndFetchCatalogNoDefaults",
      stepVarName: "PatchValidate",
      resultKind: "record",
      responseBody: null,
      valueSlots: [{ path: "input.TotallyDifferentTextField", value: "NC01", literal: '"NC01"', kind: "text", kindKnown: true }]
    }
  ];
  const candidates = findDependencies(stepContexts);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sourceFieldPath, "ShipAddrNo");
});

test("referenceExpression wraps a sequence-result step in firstOrNull", () => {
  assert.equal(referenceExpression("GetOrderQuotationSet", "sequence", "CustomerNo"), "firstOrNull(GetOrderQuotationSet).CustomerNo");
});

test("referenceExpression references a record-result step directly", () => {
  assert.equal(referenceExpression("GetBasicCustomerInformation", "record", "CustomerNo"), "GetBasicCustomerInformation.CustomerNo");
});

test("applyDependency replaces the literal with a reference expression", () => {
  const script = 'open SalesQuotationHandling;\nlet input: X = {QuotationNo: "Q1"};\nreturn OrderQuotationSet_Update("Q1", input);';
  const candidate = {
    slotLiteral: '"Q1"',
    sourceStepVarName: "GetOrderQuotationSet",
    sourceResultKind: "sequence",
    sourceFieldPath: "QuotationNo"
  };
  const result = applyDependency(script, candidate);
  assert.match(result, /firstOrNull\(GetOrderQuotationSet\)\.QuotationNo/);
});

test("wrapLikeReference wraps a reference with the % wildcard matching its filter position", () => {
  assert.equal(wrapLikeReference("x.Field", "start"), '(x.Field & "%")');
  assert.equal(wrapLikeReference("x.Field", "end"), '("%" & x.Field)');
  assert.equal(wrapLikeReference("x.Field", "contains"), '("%" & x.Field & "%")');
  assert.equal(wrapLikeReference("x.Field", undefined), "x.Field");
});

test("wrapLikeReference wraps a reference in urlEncode(...) for a batch sub-request's percent-encoded key value", () => {
  assert.equal(wrapLikeReference("x.Field", "urlEncode"), "urlEncode(x.Field)");
});

test("applyDependency wraps the reference with the wildcard when the candidate has a wrapKind", () => {
  const script = 'open SalesQuotationHandling;\nreturn select * from OrderQuotationSet where QuotationNo like "1100463%"';
  const candidate = {
    slotLiteral: '"1100463%"',
    sourceStepVarName: "GetPrior",
    sourceResultKind: "record",
    sourceFieldPath: "QuotationNo",
    wrapKind: "start"
  };
  const result = applyDependency(script, candidate);
  assert.match(result, /QuotationNo like \(GetPrior\.QuotationNo & "%"\)/);
});

test("applyDependency wraps a substituted reference in urlEncode(...) for a wrapKind of \"urlEncode\" (batch sub-request key value)", () => {
  const script = `"CustomerOrderSet(OrderNo='" & "%2A1103" & "')?$select=OrderNo"`;
  const candidate = {
    slotLiteral: '"%2A1103"',
    sourceStepVarName: "GetPriorOrder",
    sourceResultKind: "record",
    sourceFieldPath: "OrderNo",
    wrapKind: "urlEncode"
  };
  const result = applyDependency(script, candidate);
  assert.equal(result, `"CustomerOrderSet(OrderNo='" & urlEncode(GetPriorOrder.OrderNo) & "')?$select=OrderNo"`);
});

test("findDependencies carries a matched slot's wrapKind onto the candidate", () => {
  const stepContexts = [
    {
      label: "GetSomething",
      stepVarName: "GetSomething1",
      resultKind: "record",
      responseBody: JSON.stringify({ QuotationNo: "1100463" }),
      valueSlots: []
    },
    {
      label: "OrderQuotationSet",
      stepVarName: "GetOrderQuotationSet",
      resultKind: "sequence",
      responseBody: null,
      valueSlots: [{ path: "filter.QuotationNo", value: "1100463", literal: '"1100463%"', wrapKind: "start" }]
    }
  ];
  const candidates = findDependencies(stepContexts);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].wrapKind, "start");
});

test("findDependencies uses valueNullable (not the optional-key-folded nullable) for targetNullable (regression: Objsite)", () => {
  const stepContexts = [
    {
      label: "GetCustomerOrder",
      stepVarName: "GetCustomerOrder1",
      resultKind: "sequence",
      responseBody: JSON.stringify({ value: [{ Objsite: "SITE1" }] }),
      valueSlots: []
    },
    {
      label: "OrderQuotationSet_Update",
      stepVarName: "PatchOrderQuotationSet",
      resultKind: "record",
      responseBody: null,
      // optional key (nullable: true, AllowEmpty-correct) but the value's own type is non-nullable text
      valueSlots: [{ path: "input.Objsite", value: "SITE1", literal: '"SITE1"', kind: "text", nullable: true, valueNullable: false }]
    }
  ];
  const candidates = findDependencies(stepContexts);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].targetNullable, false);
});

test("applyDependency wraps a nullable sequence reference with isNull when the target field is non-nullable", () => {
  const script = 'let input: X = {Objsite: "SITE1"};';
  const candidate = {
    slotLiteral: '"SITE1"',
    sourceStepVarName: "GetCustomerOrder",
    sourceResultKind: "sequence",
    sourceFieldPath: "Objsite",
    targetKind: "text",
    targetKindKnown: true,
    targetNullable: false
  };
  const result = applyDependency(script, candidate);
  assert.match(result, /Objsite: isNull\(firstOrNull\(GetCustomerOrder\)\.Objsite, ""\)/);
});

test("applyDependency does not wrap with isNull when the target field is itself nullable", () => {
  const script = 'let input: X = {Note: "hi"};';
  const candidate = {
    slotLiteral: '"hi"',
    sourceStepVarName: "GetCustomerOrder",
    sourceResultKind: "sequence",
    sourceFieldPath: "Note",
    targetKind: "text",
    targetNullable: true
  };
  const result = applyDependency(script, candidate);
  assert.match(result, /Note: firstOrNull\(GetCustomerOrder\)\.Note/);
  assert.doesNotMatch(result, /isNull/);
});

test("applyDependency wraps a record-kind reference with isNull when the target field is non-nullable — a record result can still have nullable fields, resultKind alone doesn't tell us (real bug, 2026-08-07: GetCustomerDefaults.DeliveryLeadtime etc. left bare, server rejected number?/text? into non-nullable fields)", () => {
  const script = 'let input: X = {Objsite: "SITE1"};';
  const candidate = {
    slotLiteral: '"SITE1"',
    sourceStepVarName: "GetCustomerOrder",
    sourceResultKind: "record",
    sourceFieldPath: "Objsite",
    targetKind: "text",
    targetKindKnown: true,
    targetNullable: false
  };
  const result = applyDependency(script, candidate);
  assert.match(result, /Objsite: isNull\(GetCustomerOrder\.Objsite, ""\)/);
});

test("applyDependency does not wrap a record-kind reference when the target field is itself nullable", () => {
  const script = 'let input: X = {Note: "hi"};';
  const candidate = {
    slotLiteral: '"hi"',
    sourceStepVarName: "GetCustomerOrder",
    sourceResultKind: "record",
    sourceFieldPath: "Note",
    targetKind: "text",
    targetNullable: true
  };
  const result = applyDependency(script, candidate);
  assert.match(result, /Note: GetCustomerOrder\.Note/);
  assert.doesNotMatch(result, /isNull/);
});

test("applyDependency uses first(...) instead of firstOrNull(...)+isNull for a non-nullable-target enum reference from a sequence source (real bug, 2026-08-07: fromText(\"\") type-checked fine but threw at runtime — \"\" isn't a real member of any real enum's closed value set)", () => {
  const script = 'let input: X = {SupplyCountry: "SE"};';
  const candidate = {
    slotLiteral: '"SE"',
    sourceStepVarName: "GetOrderQuotationSet",
    sourceResultKind: "sequence",
    sourceFieldPath: "SupplyCountry",
    targetKind: "enum",
    targetNullable: false
  };
  const result = applyDependency(script, candidate);
  assert.match(result, /SupplyCountry: first\(GetOrderQuotationSet\)\.SupplyCountry/);
  assert.doesNotMatch(result, /isNull/);
  assert.doesNotMatch(result, /firstOrNull/);
});

test("applyDependency does not use first(...) for an enum reference when the target field is itself nullable — firstOrNull stays, no isNull needed either", () => {
  const script = 'let input: X = {SupplyCountry: "SE"};';
  const candidate = {
    slotLiteral: '"SE"',
    sourceStepVarName: "GetOrderQuotationSet",
    sourceResultKind: "sequence",
    sourceFieldPath: "SupplyCountry",
    targetKind: "enum",
    targetNullable: true
  };
  const result = applyDependency(script, candidate);
  assert.match(result, /SupplyCountry: firstOrNull\(GetOrderQuotationSet\)\.SupplyCountry/);
  assert.doesNotMatch(result, /isNull/);
});

test("applyDependency leaves a non-nullable-target enum reference from a RECORD-kind source unwrapped — first()/firstOrNull() only exist for sequence access, no safe fallback for enum either", () => {
  const script = 'let input: X = {SupplyCountry: "SE"};';
  const candidate = {
    slotLiteral: '"SE"',
    sourceStepVarName: "GetCustomerDefaults",
    sourceResultKind: "record",
    sourceFieldPath: "SupplyCountry",
    targetKind: "enum",
    targetNullable: false
  };
  const result = applyDependency(script, candidate);
  assert.match(result, /SupplyCountry: GetCustomerDefaults\.SupplyCountry/);
  assert.doesNotMatch(result, /isNull/);
});

test("applyDependency converts a text-declared source field into an enum-typed target via fromText(isNull(ref, \"\")) — mapping is correct, format isn't (real case, 2026-08-08: GetCustomerDefaults.SupplyCountryDb declared text? in its own return type, target expects Lookup_IsoCountry.Value)", () => {
  const script = 'let input: X = {SupplyCountryDb: "SE"};';
  const candidate = {
    slotLiteral: '"SE"',
    sourceStepVarName: "GetGetCustomerDefaults",
    sourceResultKind: "record",
    sourceFieldPath: "SupplyCountryDb",
    sourceKind: "text",
    targetKind: "enum",
    targetNullable: false,
    targetEnumType: "Lookup_IsoCountry",
    targetModuleName: "SalesQuotationHandling"
  };
  const result = applyDependency(script, candidate);
  assert.match(result, /SupplyCountryDb: SalesQuotationHandling\.Lookup_IsoCountry\.fromText\(isNull\(GetGetCustomerDefaults\.SupplyCountryDb, ""\)\)/);
});

test("applyDependency also converts a text-declared field from a SEQUENCE source, using firstOrNull (never first — first() is only for an already-matching enum source)", () => {
  const script = 'let input: X = {SupplyCountryDb: "SE"};';
  const candidate = {
    slotLiteral: '"SE"',
    sourceStepVarName: "GetSomeSequence",
    sourceResultKind: "sequence",
    sourceFieldPath: "SupplyCountryDb",
    sourceKind: "text",
    targetKind: "enum",
    targetNullable: false,
    targetEnumType: "Lookup_IsoCountry",
    targetModuleName: "SalesQuotationHandling"
  };
  const result = applyDependency(script, candidate);
  assert.match(result, /SalesQuotationHandling\.Lookup_IsoCountry\.fromText\(isNull\(firstOrNull\(GetSomeSequence\)\.SupplyCountryDb, ""\)\)/);
  assert.doesNotMatch(result, /\bfirst\(/);
});

test("applyDependency converts enum -> enum via fromText(ref.name) from a SEQUENCE source too, using firstOrNull — superseded 2026-08-10: this used to stay a bare first() reference on the (disproven) assumption that a matching enum type meant a real runtime value; now always converts, see the enum->enum block above", () => {
  const script = 'let input: X = {SupplyCountry: "SE"};';
  const candidate = {
    slotLiteral: '"SE"',
    sourceStepVarName: "GetOrderQuotationSet",
    sourceResultKind: "sequence",
    sourceFieldPath: "SupplyCountry",
    sourceKind: "enum",
    targetKind: "enum",
    targetNullable: false,
    targetEnumType: "Lookup_IsoCountry",
    targetModuleName: "SalesQuotationHandling"
  };
  const result = applyDependency(script, candidate);
  assert.match(result, /SupplyCountry: SalesQuotationHandling\.Lookup_IsoCountry\.fromText\(firstOrNull\(GetOrderQuotationSet\)\.SupplyCountry\.name\)/);
});

test("applyDependency STILL falls back to a bare first() reference for a SEQUENCE source + non-nullable target when the target's specific enum info ISN'T known (targetKind is enum by kind but targetEnumType/targetModuleName are missing) — the one case the enum->enum fromText conversion can't cover, since it needs the target's own enum type name to build the fromText(...) call", () => {
  const script = 'let input: X = {SupplyCountry: "SE"};';
  const candidate = {
    slotLiteral: '"SE"',
    sourceStepVarName: "GetOrderQuotationSet",
    sourceResultKind: "sequence",
    sourceFieldPath: "SupplyCountry",
    sourceKind: "enum",
    targetKind: "enum",
    targetNullable: false,
    targetEnumType: null,
    targetModuleName: null
  };
  const result = applyDependency(script, candidate);
  assert.match(result, /SupplyCountry: first\(GetOrderQuotationSet\)\.SupplyCountry/);
  assert.doesNotMatch(result, /fromText/);
});

test("applyDependency converts an enum-declared source field into a plain text target via ref.name — real live case, 2026-08-09/10: CustomerDefaultsStructure.SupplyCountry is genuinely text-declared (confirmed against real IFS OpenAPI metadata) but the matched source field of the same name is enum-declared (Lookup_IsoCountry.Value); server rejected the bare reference, \"field 'SupplyCountry' has type ...Lookup_IsoCountry.Value but expected text?\". First tried str(ref) — live-disproven 2026-08-10, str() rendered the enum's own {enumerationNamespace, name} shape as text instead of the plain member name. ref.name (direct field access — enums are structurally {enumerationNamespace, name} under the hood, matching the wire JSON shape) is the real, live-confirmed fix.", () => {
  const script = 'let x: X = {SupplyCountry: "SE"};';
  const candidate = {
    slotLiteral: '"SE"',
    sourceStepVarName: "GetCustomerOrder_Default",
    sourceResultKind: "record",
    sourceFieldPath: "SupplyCountry",
    sourceKind: "enum",
    targetKind: "text",
    targetKindKnown: true,
    targetNullable: false
  };
  const result = applyDependency(script, candidate);
  assert.match(result, /SupplyCountry: GetCustomerOrder_Default\.SupplyCountry\.name/);
  assert.doesNotMatch(result, /isNull|\bstr\(/); // no safe enum fallback to wrap with, same as the enum branch above
});

test("applyDependency's enum-to-text .name conversion also works from a SEQUENCE source, using firstOrNull", () => {
  const script = 'let x: X = {Region: "SE"};';
  const candidate = {
    slotLiteral: '"SE"',
    sourceStepVarName: "GetSomeSequence",
    sourceResultKind: "sequence",
    sourceFieldPath: "Region",
    sourceKind: "enum",
    targetKind: "text",
    targetKindKnown: true,
    targetNullable: false
  };
  const result = applyDependency(script, candidate);
  assert.match(result, /Region: firstOrNull\(GetSomeSequence\)\.Region\.name/);
});

/* ---------- enum -> enum dependency conversion, TWO real live rounds, 2026-08-10:
   Round 1 only converted when source/target were positively known to be DIFFERENT specific enum
   types (e.g. PartOwnershipSubset1 vs PartOwnership — IFS declares many narrower "Subset" variant
   enums sharing a real-world field name, confirmed distinct FlowScript nominal types via real
   OpenAPI), leaving a bare reference whenever the two types matched — on the wrong assumption
   that "same enum type" meant "already a real, correctly-typed runtime value". Round 2, live
   retest, DISPROVEN: a SAME-type case (AddrFlag, GenYesNo -> GenYesNo) still failed live ("must
   not be an object or array") — same root cause as bug #31's datetime fix: a GET response's
   `unsafeCastX(...)` deserializer never performs a real runtime conversion, so an enum-typed
   field is STILL the raw {enumerationNamespace, name} object underneath regardless of whether
   the static type happens to match the target's. Fixed: enum -> enum ALWAYS converts via
   fromText(ref.name) now, whenever the TARGET's own enum info is known — the source's specific
   enum type no longer gates the decision at all. ---------- */

test("applyDependency converts enum -> enum via fromText(ref.name) even when source and target are the SAME specific enum type — real bug, live, 2026-08-10: AddrFlag (GenYesNo -> GenYesNo) still failed as a bare reference (\"must not be an object or array\") because the GET-sourced reference is never really a native enum value at runtime (unsafeCast doesn't convert), regardless of type match", () => {
  const script = 'let x: X = {AddrFlag: "No"};';
  const candidate = {
    slotLiteral: '"No"',
    sourceStepVarName: "GetCustomerOrder_Default",
    sourceResultKind: "record",
    sourceFieldPath: "AddrFlag",
    sourceKind: "enum",
    sourceEnumType: "GenYesNo",
    targetKind: "enum",
    targetKindKnown: true,
    targetNullable: false,
    targetEnumType: "GenYesNo",
    targetModuleName: "CustomerOrderHandling"
  };
  const result = applyDependency(script, candidate);
  assert.match(result, /AddrFlag: CustomerOrderHandling\.GenYesNo\.fromText\(GetCustomerOrder_Default\.AddrFlag\.name\)/);
});

test("applyDependency converts enum -> enum via fromText(ref.name) when source and target are DIFFERENT specific enum types (real case: PartOwnershipSubset1 -> PartOwnership)", () => {
  const script = 'let x: X = {PartOwnership: "CompanyOwned"};';
  const candidate = {
    slotLiteral: '"CompanyOwned"',
    sourceStepVarName: "GetSomeOtherRow",
    sourceResultKind: "record",
    sourceFieldPath: "PartOwnership",
    sourceKind: "enum",
    sourceEnumType: "PartOwnershipSubset1",
    targetKind: "enum",
    targetKindKnown: true,
    targetNullable: false,
    targetEnumType: "PartOwnership",
    targetModuleName: "CustomerOrderHandling"
  };
  const result = applyDependency(script, candidate);
  assert.match(result, /PartOwnership: CustomerOrderHandling\.PartOwnership\.fromText\(GetSomeOtherRow\.PartOwnership\.name\)/);
});

test("applyDependency converts enum -> enum via fromText(ref.name) even when the SOURCE's specific enum type isn't known — only the TARGET's own enum info gates this now, the source's specific type no longer matters to the decision", () => {
  const script = 'let x: X = {PartOwnership: "CompanyOwned"};';
  const candidate = {
    slotLiteral: '"CompanyOwned"',
    sourceStepVarName: "GetSomeOtherRow",
    sourceResultKind: "record",
    sourceFieldPath: "PartOwnership",
    sourceKind: "enum",
    sourceEnumType: null, // unknown — no longer a blocker
    targetKind: "enum",
    targetNullable: false,
    targetEnumType: "PartOwnership",
    targetModuleName: "CustomerOrderHandling"
  };
  const result = applyDependency(script, candidate);
  assert.match(result, /PartOwnership: CustomerOrderHandling\.PartOwnership\.fromText\(GetSomeOtherRow\.PartOwnership\.name\)/);
});

test("applyDependency leaves an enum->enum reference bare when the TARGET's own enum info isn't known — same conservative precedent as every other kind check", () => {
  const script = 'let x: X = {PartOwnership: "CompanyOwned"};';
  const noTargetEnumType = {
    slotLiteral: '"CompanyOwned"',
    sourceStepVarName: "GetSomeOtherRow",
    sourceResultKind: "record",
    sourceFieldPath: "PartOwnership",
    sourceKind: "enum",
    sourceEnumType: "PartOwnership",
    targetKind: "enum",
    targetNullable: false,
    targetEnumType: null, // unknown
    targetModuleName: "CustomerOrderHandling"
  };
  assert.doesNotMatch(applyDependency(script, noTargetEnumType), /fromText/);

  const noTargetModuleName = Object.assign({}, noTargetEnumType, { targetEnumType: "PartOwnership", targetModuleName: null });
  assert.doesNotMatch(applyDependency(script, noTargetModuleName), /fromText/);
});

test("applyDependency STILL applies the enum-to-text .name conversion when the target's kind is merely the unresolvable-field default (e.g. a genuinely `any`-typed field) — real bug, 2026-08-10: ValidationRec (declared `any` in several generated action-import-request types, no resolvable per-field type at all) needed the SAME conversion as a known-text target; an earlier attempt at this fix skipped conversion entirely for unknown-kind targets, which also failed live (\"must not be an object or array\" — the raw enum object is invalid for ANY non-enum target, known or not)", () => {
  const script = 'let x: X = {ValidationRec: {AddrFlag: "No"}};';
  const candidate = {
    slotLiteral: '"No"',
    sourceStepVarName: "GetCustomerOrder_Default",
    sourceResultKind: "record",
    sourceFieldPath: "AddrFlag",
    sourceKind: "enum",
    targetKind: "text", // defaulted, not a real classification
    targetKindKnown: false,
    targetNullable: false
  };
  const result = applyDependency(script, candidate);
  assert.match(result, /AddrFlag: GetCustomerOrder_Default\.AddrFlag\.name/);
});

/* ---------- convertKindMismatch + applyDependency's generic (non-enum) kind-mismatch
   conversion, added 2026-08-09: a dependency match shouldn't ever substitute a bare reference of
   the wrong kind and let the server reject it — see the SupplyCountry/RentalChargableDays cases
   this session that motivated it. ---------- */

test("convertKindMismatch converts text -> number via val(isNull(ref, \"\"))", () => {
  assert.equal(convertKindMismatch("GetX.Field", "text", "number"), 'val(isNull(GetX.Field, ""))');
});

test("convertKindMismatch converts any non-text kind -> text via str(ref)", () => {
  assert.equal(convertKindMismatch("GetX.Field", "number", "text"), "str(GetX.Field)");
  assert.equal(convertKindMismatch("GetX.Field", "boolean", "text"), "str(GetX.Field)");
  assert.equal(convertKindMismatch("GetX.Field", "datetime", "text"), "str(GetX.Field)");
});

test("convertKindMismatch converts text -> datetime via date(ref)", () => {
  assert.equal(convertKindMismatch("GetX.Field", "text", "datetime"), "date(GetX.Field)");
});

test("convertKindMismatch converts text -> boolean via an inline case/error expression (no dedicated FlowScript parser exists)", () => {
  const result = convertKindMismatch("GetX.Field", "text", "boolean");
  assert.match(result, /case when lower\(GetX\.Field\) = "true" then true when lower\(GetX\.Field\) = "false" then false else error/);
});

test("convertKindMismatch returns null when either kind is unknown, when they already match, or when no conversion is defined for the pair", () => {
  assert.equal(convertKindMismatch("GetX.Field", null, "number"), null);
  assert.equal(convertKindMismatch("GetX.Field", "text", null), null);
  assert.equal(convertKindMismatch("GetX.Field", "number", "number"), null);
  assert.equal(convertKindMismatch("GetX.Field", "number", "boolean"), null); // no realistic real-world case
});

test("applyDependency converts a text-declared source into a number target via val(isNull(ref, \"\")) — real case, RentalChargableDays' own kind (number) fed by a genuinely text-declared, correctly NAME-matched source (not the coincidental value-only match fixed separately)", () => {
  const script = 'let input: X = {RentalChargableDays: "5"};';
  const candidate = {
    slotLiteral: '"5"',
    sourceStepVarName: "GetCustomerOrderLine_Default",
    sourceResultKind: "record",
    sourceFieldPath: "RentalChargableDays",
    sourceKind: "text",
    targetKind: "number",
    targetKindKnown: true,
    targetNullable: false
  };
  const result = applyDependency(script, candidate);
  assert.match(result, /RentalChargableDays: val\(isNull\(GetCustomerOrderLine_Default\.RentalChargableDays, ""\)\)/);
});

test("applyDependency converts a number-declared source into a text target via str(ref)", () => {
  const script = 'let input: X = {Note: "5"};';
  const candidate = {
    slotLiteral: '"5"',
    sourceStepVarName: "GetSomeStep",
    sourceResultKind: "sequence",
    sourceFieldPath: "Count",
    sourceKind: "number",
    targetKind: "text",
    targetKindKnown: true,
    targetNullable: false
  };
  const result = applyDependency(script, candidate);
  assert.match(result, /Note: str\(firstOrNull\(GetSomeStep\)\.Count\)/);
});

test("applyDependency leaves a non-nullable target's isNull(...) fallback OFF entirely when the target's kind couldn't be resolved (targetKindKnown false) — real bug, 2026-08-10: a genuinely NUMBER field (ConvFactor/Identity4, Edm.Decimal) whose declared type wasn't resolvable (same `any`-typed-record class as ValidationRec) fell back to targetKind's unconditional \"text\" default, so nullFallbackForKind picked the TEXT fallback (\"\") instead of the real number one (\"0\") — server rejected it, \"Invalid json type: STRING for Edm.Decimal property\". Guessing a fallback for an unresolved type is worse than leaving the reference unwrapped.", () => {
  const script = 'let input: X = {ConvFactor: "1"};';
  const candidate = {
    slotLiteral: '"1"',
    sourceStepVarName: "GetCustomerOrderLine_Default",
    sourceResultKind: "record",
    sourceFieldPath: "ConvFactor",
    targetKind: "text", // defaulted, not a real classification
    targetKindKnown: false,
    targetNullable: false
  };
  const result = applyDependency(script, candidate);
  assert.match(result, /ConvFactor: GetCustomerOrderLine_Default\.ConvFactor/);
  assert.doesNotMatch(result, /isNull/);
});

test("applyDependency leaves a nullable datetime reference unwrapped (no safe generic fallback)", () => {
  const script = 'let input: X = {DueDate: "2026-01-01"};';
  const candidate = {
    slotLiteral: '"2026-01-01"',
    sourceStepVarName: "GetCustomerOrder",
    sourceResultKind: "sequence",
    sourceFieldPath: "DueDate",
    targetKind: "datetime",
    targetNullable: false
  };
  const result = applyDependency(script, candidate);
  assert.match(result, /DueDate: firstOrNull\(GetCustomerOrder\)\.DueDate/);
  assert.doesNotMatch(result, /isNull/);
});

test("applyDependency forces a real date(str(ref)) reparse for a datetime->datetime match, since unsafeCast never really converts the JSON string (real bug, 2026-08-10: WantedDeliveryDate arrived quoted like text at the target's own request builder)", () => {
  const script = 'return CheckConfigRevisions(orderNo, contract, "2026-08-10T00:00:00Z");';
  const candidate = {
    slotLiteral: '"2026-08-10T00:00:00Z"',
    sourceStepVarName: "GetCustomerDefaults",
    sourceResultKind: "record",
    sourceFieldPath: "WantedDeliveryDate",
    sourceKind: "datetime",
    targetKind: "datetime",
    targetNullable: true
  };
  const result = applyDependency(script, candidate);
  assert.match(result, /date\(str\(GetCustomerDefaults\.WantedDeliveryDate\)\)/);
});

test("applyDependency combines isNull unwrap and like-wildcard wrap when both apply", () => {
  const script = 'return select * from OrderQuotationSet where QuotationNo like "1100463%"';
  const candidate = {
    slotLiteral: '"1100463%"',
    sourceStepVarName: "GetPrior",
    sourceResultKind: "sequence",
    sourceFieldPath: "QuotationNo",
    targetKind: "text",
    targetKindKnown: true,
    targetNullable: false,
    wrapKind: "start"
  };
  const result = applyDependency(script, candidate);
  assert.match(result, /QuotationNo like \(isNull\(firstOrNull\(GetPrior\)\.QuotationNo, ""\) & "%"\)/);
});

test("applyDependency returns the script unchanged when the literal isn't found", () => {
  const script = "return Foo();";
  const candidate = { slotLiteral: '"missing"', sourceStepVarName: "X", sourceResultKind: "record", sourceFieldPath: "Y" };
  assert.equal(applyDependency(script, candidate), script);
});

test("applyDependency targets each field's OWN occurrence via its field-name-qualified form, even when multiple DIFFERENT fields share the identical literal value (regression: real recorded 'create Part' session, 2026-08-07, 500 on designer save — 9 separate boolean fields all recorded as 'false' got nested into ONE 9-deep isNull() chain instead of 9 independent substitutions, because a bare literal search finds the first 'false' anywhere, including one a PRIOR substitution's own isNull(..., false) fallback just inserted)", () => {
  let script = 'open PartHandling;\nlet input: X = {CatchUnitEnabled: false, AllowAsNotConsumed: false, KitPart: false};\nreturn PartCatalogSet_Create(input);';
  const candidateFor = (fieldName, sourceFieldPath) => ({
    slotPath: fieldName,
    slotLiteral: "false",
    sourceStepVarName: "GetPartCatalogSet",
    sourceResultKind: "sequence",
    sourceFieldPath,
    targetKind: "boolean",
    targetKindKnown: true,
    targetNullable: false
  });
  // Applied one at a time, exactly like ifs-modules.js's applyDependencyCandidate loop does —
  // each call operates on the PREVIOUS call's own already-modified script.
  script = applyDependency(script, candidateFor("CatchUnitEnabled", "CatchUnitEnabled"));
  script = applyDependency(script, candidateFor("AllowAsNotConsumed", "AllowAsNotConsumed"));
  script = applyDependency(script, candidateFor("KitPart", "KitPart"));

  assert.match(script, /CatchUnitEnabled: isNull\(firstOrNull\(GetPartCatalogSet\)\.CatchUnitEnabled, false\)/);
  assert.match(script, /AllowAsNotConsumed: isNull\(firstOrNull\(GetPartCatalogSet\)\.AllowAsNotConsumed, false\)/);
  assert.match(script, /KitPart: isNull\(firstOrNull\(GetPartCatalogSet\)\.KitPart, false\)/);
  // The specific nesting bug: NONE of the three substitutions' own fallback default may
  // reference one of the OTHER two fields as its source.
  assert.doesNotMatch(script, /CatchUnitEnabled, isNull/);
  assert.doesNotMatch(script, /AllowAsNotConsumed, isNull/);
});

test("applyDependency falls back to the bare-literal search when a slot has no clean 'FieldName: literal' shape (e.g. a value inside a where-clause, not a record key)", () => {
  const script = 'open PartHandling;\nreturn select * from Reference_IsoUnit where UnitCode = "Ft"';
  const candidate = {
    slotPath: "UnitCode", // present in the script too, but NOT immediately before this literal (it's "UnitCode = ", not "UnitCode: ")
    slotLiteral: '"Ft"',
    sourceStepVarName: "GetPartCatalogSet",
    sourceResultKind: "sequence",
    sourceFieldPath: "UnitCode"
  };
  const result = applyDependency(script, candidate);
  assert.match(result, /UnitCode = firstOrNull\(GetPartCatalogSet\)\.UnitCode/);
});

test("mappingKey is stable across different runtime step vars/values for the same field pairing", () => {
  const stepContexts = [
    { label: "OrderQuotationSet", stepVarName: "GetOrderQuotationSet1", resultKind: "sequence", responseBody: null, valueSlots: [] },
    { label: "OrderQuotationSet_Update", stepVarName: "PatchOrderQuotationSet1", resultKind: "record", responseBody: null, valueSlots: [] }
  ];
  const candidate = {
    stepIndex: 1,
    slotPath: "QuotationNo",
    sourceLabel: "OrderQuotationSet",
    sourceFieldPath: "QuotationNo"
  };
  assert.equal(mappingKey(candidate, stepContexts), "OrderQuotationSet_Update::QuotationNo::OrderQuotationSet::QuotationNo");
});

test("mappingKey uses a step's baseLabel (undisambiguated) instead of its display label when present — real request 2026-08-10: 3 separate $batch calls in one session (each individually disambiguated as \"BatchCall\"/\"BatchCall2\"/\"BatchCall3\" for display, a bare trailing digit — Flow rejects parens/spaces in a step name) must still be recognized as ONE underlying mapping, not 3. Textually stripping a suffix off the display label was tried first and abandoned — a bare digit suffix is ambiguous against a real name that happens to end in one", () => {
  const stepContexts = [
    { label: "BatchCall2", baseLabel: "BatchCall", stepVarName: "b2", resultKind: "record", responseBody: null, valueSlots: [] }
  ];
  const candidate = { stepIndex: 0, slotPath: "batch[0].0", sourceLabel: "GetCustomerOrder_Default", sourceFieldPath: "OrderNo" };
  assert.equal(mappingKey(candidate, stepContexts), "BatchCall::batch[0].0::GetCustomerOrder_Default::OrderNo");
});

test("mappingKey falls back to the display label when baseLabel isn't set (callers/tests that don't provide it)", () => {
  const stepContexts = [
    { label: "OrderQuotationSet_Update", stepVarName: "p1", resultKind: "record", responseBody: null, valueSlots: [] }
  ];
  const candidate = { stepIndex: 0, slotPath: "QuotationNo", sourceLabel: "GetOrderQuotationSet", sourceFieldPath: "QuotationNo" };
  assert.equal(mappingKey(candidate, stepContexts), "OrderQuotationSet_Update::QuotationNo::GetOrderQuotationSet::QuotationNo");
});

test("groupCandidatesByMapping groups candidates sharing the same mappingKey into one entry with all real occurrences, preserving first-seen order", () => {
  const stepContexts = [
    { label: "BatchCall", baseLabel: "BatchCall", stepVarName: "b1", resultKind: "record", responseBody: null, valueSlots: [] },
    { label: "BatchCall2", baseLabel: "BatchCall", stepVarName: "b2", resultKind: "record", responseBody: null, valueSlots: [] },
    { label: "BatchCall3", baseLabel: "BatchCall", stepVarName: "b3", resultKind: "record", responseBody: null, valueSlots: [] }
  ];
  const candidates = [0, 1, 2].map((stepIndex) => ({
    stepIndex, slotPath: "batch[0].0", sourceLabel: "GetCustomerOrder_Default", sourceFieldPath: "OrderNo", value: "NO123"
  }));
  const groups = groupCandidatesByMapping(candidates, stepContexts);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].occurrences.length, 3);
  assert.deepEqual(groups[0].occurrences, candidates);
});

test("groupCandidatesByMapping keeps genuinely different mappings in separate groups", () => {
  const stepContexts = [
    { label: "OrderQuotationSet_Update", stepVarName: "p1", resultKind: "record", responseBody: null, valueSlots: [] },
    { label: "OrderQuotationSet_Update", stepVarName: "p2", resultKind: "record", responseBody: null, valueSlots: [] }
  ];
  const candidates = [
    { stepIndex: 0, slotPath: "QuotationNo", sourceLabel: "GetOrderQuotationSet", sourceFieldPath: "QuotationNo", value: "Q1" },
    { stepIndex: 1, slotPath: "CustomerNo", sourceLabel: "GetOrderQuotationSet", sourceFieldPath: "CustomerNo", value: "C1" }
  ];
  const groups = groupCandidatesByMapping(candidates, stepContexts);
  assert.equal(groups.length, 2);
});

test("extractRows returns every row of a collection response", () => {
  const body = JSON.stringify({ value: [{ Id: "1" }, { Id: "2" }] });
  assert.deepEqual(extractRows(body), [{ Id: "1" }, { Id: "2" }]);
});

test("extractRows returns a single-element array for a single-record response", () => {
  assert.deepEqual(extractRows(JSON.stringify({ Id: "1" })), [{ Id: "1" }]);
});

test("isListSource is true for a name containing Lov regardless of row count", () => {
  assert.equal(isListSource("GetCustomerLov", [{ Id: "1" }]), true);
  assert.equal(isListSource("CustomerLovSet", []), true);
});

test("isListSource is true when more than one row came back, even without Lov in the name", () => {
  assert.equal(isListSource("OrderQuotationSet", [{ Id: "1" }, { Id: "2" }]), true);
});

test("isListSource is false for a single row from a non-Lov-named source (precise fetch by key)", () => {
  assert.equal(isListSource("OrderQuotationSet", [{ Id: "1" }]), false);
});

test("findDependencies tags a match from a multi-row source as viaListSelection with row field names", () => {
  const stepContexts = [
    {
      label: "OrderQuotationSet",
      stepVarName: "GetOrderQuotationSet",
      resultKind: "sequence",
      responseBody: JSON.stringify({ value: [{ QuotationNo: "Q1", CustomerName: "Acme" }, { QuotationNo: "Q2", CustomerName: "Globex" }] }),
      valueSlots: []
    },
    {
      label: "OrderQuotationSet_Update",
      stepVarName: "PatchOrderQuotationSet",
      resultKind: "record",
      responseBody: null,
      valueSlots: [{ path: "QuotationNo", value: "Q2", literal: '"Q2"' }]
    }
  ];
  const candidates = findDependencies(stepContexts);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].viaListSelection, true);
  assert.deepEqual(candidates[0].sourceRowFields.sort(), ["CustomerName", "QuotationNo"]);
  assert.equal(candidates[0].sourceFieldPath, "QuotationNo");
});

test("findDependencies does not tag a match from a single-row, non-Lov source as viaListSelection", () => {
  const stepContexts = [
    {
      label: "GetOrderQuotationSetByKey",
      stepVarName: "GetOrderQuotationSetByKey1",
      resultKind: "record",
      responseBody: JSON.stringify({ QuotationNo: "Q1" }),
      valueSlots: []
    },
    {
      label: "OrderQuotationSet_Update",
      stepVarName: "PatchOrderQuotationSet",
      resultKind: "record",
      responseBody: null,
      valueSlots: [{ path: "QuotationNo", value: "Q1", literal: '"Q1"' }]
    }
  ];
  const candidates = findDependencies(stepContexts);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].viaListSelection, false);
  assert.equal(candidates[0].sourceRowFields, null);
});
