const test = require("node:test");
const assert = require("node:assert/strict");
const {
  addScriptStep,
  addModule,
  addEndStep,
  addUserStep,
  createTextInputControl,
  createNumericInputControl,
  createListSelectionControl,
  createMultiListSelectionControl,
  collectUsedVariableNames,
  disambiguateVariableName
} = require("./flow-steps.js");

test("addScriptStep on empty data creates a start step, the script step, and connects them", () => {
  const data = addScriptStep([], "return 1", "Foo", null, null, "user1", "Get", "MyModule");
  const start = data.find((d) => d.stepType === "start");
  const step = data.find((d) => d.stepType === "script");
  const arrow = data.find((d) => d.type === "arrow-created");

  assert.ok(start, "start step created");
  assert.ok(step, "script step created");
  assert.equal(step.configuration.script, "return 1");
  assert.equal(step.configuration.targetVariableName, "GetFoo");
  assert.equal(step.label, "FooGetDataGet");
  assert.equal(step.configuration.attribution.userId, "user1");
  assert.ok(arrow, "connecting arrow created");
  assert.equal(arrow.fromStep, start.id);
  assert.equal(arrow.toStep, step.id);
});

test("addScriptStep's step entry omits arrow/command-only fields entirely (regression)", () => {
  // "optional" in Flow's schema means the key may be ABSENT, not present-with-null — confirmed
  // by pasting a generated payload into Flow's own designer and getting a type mismatch.
  // command/arrowKind/fromStep/toStep/joints/attachment only apply to arrow-created entries,
  // never to a script step, and previously were always included here as explicit null.
  const data = addScriptStep([], "return 1", "Foo", null, null, "user1", "Get", "MyModule");
  const step = data.find((d) => d.stepType === "script");
  ["command", "arrowKind", "fromStep", "toStep", "joints", "attachment"].forEach((key) => {
    assert.equal(key in step, false, `step entry must not have a "${key}" key`);
  });
});

test("addScriptStep disambiguates targetVariableName when the same entity/type is fetched again (regression)", () => {
  // Fetching the same entity set twice in one session is a normal pattern (list -> action ->
  // refresh list). FlowScript's `let` is single-assignment, so a duplicate targetVariableName
  // across two steps fails validation server-side (500, no body) — confirmed live.
  let data = addScriptStep([], "return select * from OrderQuotationSet where X", "OrderQuotationSet", null, null, "user1", "Get", "MyModule");
  data = addScriptStep(data, "return select * from OrderQuotationSet", "OrderQuotationSet", null, null, "user1", "Get", "MyModule");
  const steps = data.filter((d) => d.stepType === "script");
  assert.equal(steps[0].configuration.targetVariableName, "GetOrderQuotationSet");
  assert.equal(steps[1].configuration.targetVariableName, "GetOrderQuotationSet2");
});

test("collectUsedVariableNames finds names from both script steps and user-step controls", () => {
  const data = [
    { type: "step-created", configuration: { targetVariableName: "GetFoo" } },
    { type: "step-created", configuration: { controls: [{ targetVariableName: "customerNo" }, { targetVariableName: "qty" }] } },
    { type: "arrow-created" } // no configuration — must not throw
  ];
  const names = collectUsedVariableNames(data);
  assert.deepEqual([...names].sort(), ["GetFoo", "customerNo", "qty"]);
});

test("disambiguateVariableName appends a numeric suffix on collision", () => {
  const used = new Set(["GetFoo"]);
  assert.equal(disambiguateVariableName("GetFoo", used), "GetFoo2");
  assert.equal(disambiguateVariableName("GetBar", used), "GetBar");
});

test("addScriptStep chains a second step off the first without a new start step", () => {
  let data = addScriptStep([], "return 1", "Foo", null, null, "user1", "Get", "MyModule");
  data = addScriptStep(data, "return 2", "Bar", null, null, "user1", "Get", "MyModule");

  const starts = data.filter((d) => d.stepType === "start");
  const steps = data.filter((d) => d.stepType === "script");
  const arrows = data.filter((d) => d.type === "arrow-created");

  assert.equal(starts.length, 1);
  assert.equal(steps.length, 2);
  assert.equal(arrows.length, 2);
  assert.equal(arrows[1].fromStep, steps[0].id);
  assert.equal(arrows[1].toStep, steps[1].id);
});

test("addScriptStep places each new step further right on the canvas", () => {
  let data = addScriptStep([], "return 1", "Foo", null, null, "user1", "Get", "MyModule");
  data = addScriptStep(data, "return 2", "Bar", null, null, "user1", "Get", "MyModule");
  const steps = data.filter((d) => d.stepType === "script");
  assert.ok(steps[1].location.x > steps[0].location.x);
});

test("addModule appends a module-added entry", () => {
  const data = addModule([], "SalesQuotationHandling", "mod-123");
  assert.deepEqual(data, [{ type: "module-added", name: "SalesQuotationHandling", moduleId: "mod-123" }]);
});

test("addEndStep connects the last script step to a new end step", () => {
  let data = addScriptStep([], "return 1", "Foo", null, null, "user1", "Get", "MyModule");
  data = addScriptStep(data, "return 2", "Bar", null, null, "user1", "Get", "MyModule");
  data = addEndStep(data);

  const steps = data.filter((d) => d.stepType === "script");
  const end = data.find((d) => d.stepType === "end");
  const arrows = data.filter((d) => d.type === "arrow-created");

  assert.ok(end, "end step created");
  assert.equal(arrows.length, 3, "start->step1, step1->step2, step2->end");
  const lastArrow = arrows[arrows.length - 1];
  assert.equal(lastArrow.fromStep, steps[steps.length - 1].id);
  assert.equal(lastArrow.toStep, end.id);
});

test("addEndStep connects directly to the start step when there are no script steps", () => {
  const data = addEndStep([{ type: "step-created", id: "start-1", stepType: "start", location: { x: 0, y: 0 }, label: "", configuration: null }]);
  const end = data.find((d) => d.stepType === "end");
  const arrow = data.find((d) => d.type === "arrow-created");
  assert.ok(end);
  assert.equal(arrow.fromStep, "start-1");
  assert.equal(arrow.toStep, end.id);
});

test("createTextInputControl matches the reference control shape", () => {
  const c = createTextInputControl("myVarName", "My Label", true);
  assert.equal(c.type, "text-input");
  assert.equal(c.targetVariableName, "myVarName");
  assert.equal(c.label, "My Label");
  assert.equal(c.allowEmpty, true);
  assert.equal(c.defaultText, "");
  assert.equal(c.mergeBehavior, "keepMyChanges");
  assert.ok(c.id);
});

test("createNumericInputControl uses the simple control shape", () => {
  const c = createNumericInputControl("numericInput", "Numeric input Field Name", false);
  assert.equal(c.type, "numeric-input");
  assert.equal(c.allowEmpty, false);
  assert.equal(c.defaultValue, "");
  assert.ok(c.id);
});

test("createListSelectionControl references the source step's variable", () => {
  const c = createListSelectionControl("listSelection", "List selection", "myLovTbl", "{Name}", "{Id}", false);
  assert.equal(c.type, "list-selection");
  assert.deepEqual(c.source, { path: "myLovTbl", type: "variable" });
  assert.equal(c.largeRowText, "{Name}");
  assert.equal(c.smallRowText, "{Id}");
});

test("createListSelectionControl matches a REAL Designer-built control's exact key order, including the nested source object's own order — real bug, live, 2026-08-12: two earlier guessed orders (type-only-first, then type/targetVariableName/label-first) both still 500'd (\"Could not create component steps\") until the user supplied a real captured example to match exactly", () => {
  const c = createListSelectionControl("selQuotationRec", "Select QuotationNo", "GetOrderQuotationSet", "{QuotationNo}", "Customer: {CustomerName}", false);
  assert.deepEqual(Object.keys(c), [
    "type", "targetVariableName", "source", "label", "largeRowText", "smallRowText",
    "imageExpr", "itemStyleExpr", "groupByMember", "defaultSelectionExpr", "resultTransformationExpr",
    "allowEmpty", "inline", "showAutomatically", "barcodeMatchStrategy", "barcodeMatchColumns",
    "mergeBehavior", "id", "hideIfExpr"
  ]);
  assert.deepEqual(Object.keys(c.source), ["type", "path"]); // discriminator-first one level deeper too
});

test("createMultiListSelectionControl matches a real captured multi-list-selection control exactly — genuinely different field set from list-selection, not a renamed copy: no allowEmpty/resultTransformationExpr/barcodeMatchStrategy/barcodeMatchColumns at all, and defaultSelectionExpression (full word) sits right after source, not near the end like list-selection's own defaultSelectionExpr", () => {
  const c = createMultiListSelectionControl("multiSelection", "Select Quotation No", "GetOrderQuotationSet", "Select Quotation No", "{QuotationNo}");
  assert.deepEqual(Object.keys(c), [
    "type", "targetVariableName", "source", "defaultSelectionExpression", "label", "largeRowText", "smallRowText",
    "imageExpr", "itemStyleExpr", "groupByMember", "inline", "showAutomatically", "mergeBehavior", "id", "hideIfExpr"
  ]);
  assert.equal(c.type, "multi-list-selection");
  assert.deepEqual(Object.keys(c.source), ["type", "path"]);
  assert.deepEqual(c.source, { type: "variable", path: "GetOrderQuotationSet" });
});

test("addUserStep inserts before an existing step, retargeting its incoming arrow", () => {
  let data = addScriptStep([], "return 1", "Foo", null, null, "user1", "Get", "MyModule");
  data = addScriptStep(data, "return 2", "Bar", null, null, "user1", "Get", "MyModule");
  const steps = data.filter((d) => d.stepType === "script");
  const secondStep = steps[1];
  const originalIncoming = data.find((d) => d.type === "arrow-created" && d.toStep === secondStep.id);

  const control = createTextInputControl("myVar", "My Var", false);
  const result = addUserStep(data, secondStep.id, [control], "Enter My Var", "user1");

  const userStep = result.data.find((d) => d.id === result.stepId);
  assert.ok(userStep, "user step created");
  assert.equal(userStep.stepType, "user");
  assert.equal(userStep.configuration.controls[0], control);

  // Retargeting mutates the original arrow-created entry in place — no arrow-target-changed/
  // arrow-joints-changed delta events, which only apply to patching an already-saved version.
  const changeEvents = result.data.filter((d) => d.type === "arrow-target-changed" || d.type === "arrow-joints-changed");
  assert.equal(changeEvents.length, 0, "no delta events in a from-scratch submission");

  const retargetedArrow = result.data.find((d) => d.type === "arrow-created" && d.id === originalIncoming.id);
  assert.ok(retargetedArrow, "original incoming arrow still present, same id");
  assert.equal(retargetedArrow.toStep, userStep.id);
  assert.deepEqual(retargetedArrow.joints, []);

  const newArrow = result.data.find((d) => d.type === "arrow-created" && d.fromStep === userStep.id);
  assert.equal(newArrow.toStep, secondStep.id);
  assert.equal(newArrow.id, userStep.configuration.buttons[0].arrowId, "button's arrowId matches the new outgoing arrow");
});

test("addUserStep inserts the new step/arrow before the target step in array order (regression)", () => {
  // Every previously-working payload had each entity appear before anything referencing it.
  // Appending new steps at the very end left a retargeted arrow (defined near the top of the
  // array) pointing at a step defined near the bottom — confirmed live as a second 500 cause.
  let data = addScriptStep([], "return 1", "Foo", null, null, "user1", "Get", "MyModule");
  data = addScriptStep(data, "return 2", "Bar", null, null, "user1", "Get", "MyModule");
  const secondStep = data.filter((d) => d.stepType === "script")[1];

  const control = createTextInputControl("myVar", "My Var", false);
  const result = addUserStep(data, secondStep.id, [control], "Enter My Var", "user1");

  const userStepIndex = result.data.findIndex((d) => d.id === result.stepId);
  const beforeStepIndex = result.data.findIndex((d) => d.id === secondStep.id);
  const outArrowIndex = result.data.findIndex((d) => d.type === "arrow-created" && d.fromStep === result.stepId);

  assert.ok(userStepIndex < beforeStepIndex, "user step defined before the step it precedes");
  assert.ok(outArrowIndex < beforeStepIndex, "new outgoing arrow defined before the step it targets");
});

test("addUserStep no-ops gracefully when beforeStepId doesn't exist", () => {
  const data = addScriptStep([], "return 1", "Foo", null, null, "user1", "Get", "MyModule");
  const result = addUserStep(data, "nonexistent-id", [createTextInputControl("x", "X", false)], "Enter X", "user1");
  assert.equal(result.stepId, null);
  assert.deepEqual(result.data, data);
});
