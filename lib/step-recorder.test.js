const test = require("node:test");
const assert = require("node:assert/strict");
const SR = require("./step-recorder.js");

test("sentences follow the templates in all three languages", () => {
  const s = { kind: "input", data: { prompt: "Shipment No", value: "SHP-1042" } };
  assert.equal(SR.sentence(s, "en"), 'Enter "SHP-1042" in "Shipment No".');
  assert.equal(SR.sentence(s, "de"), "Geben Sie „SHP-1042“ in „Shipment No“ ein.");
  assert.equal(SR.sentence(s, "fr"), "Saisissez « SHP-1042 » dans « Shipment No ».");
  assert.equal(SR.sentence({ kind: "binary", data: { prompt: "Print label", on: true } }, "de"), "Setzen Sie „Print label“ auf Ja.");
  assert.equal(SR.sentence({ kind: "lov", data: { prompt: "Shipment", value: "A", column: "No" } }, "fr"), "Sélectionnez « A » dans « Shipment » (colonne « No »).");
  assert.equal(SR.sentence({ kind: "lov", data: { prompt: "Shipment", value: "A" } }, "en"), 'Select "A" from "Shipment".');
});

test("sub-workflow steps are numbered under the step that started them", () => {
  const steps = [];
  SR.addStep(steps, { kind: "button", data: { button: "A" } });
  SR.addStep(steps, { kind: "button", data: { button: "B" } });
  SR.addStep(steps, { kind: "sub", data: { workflow: "Pack" } });
  SR.addStep(steps, { kind: "button", data: { button: "C" } }, "3");
  SR.addStep(steps, { kind: "button", data: { button: "D" } }, "3");
  SR.addStep(steps, { kind: "button", data: { button: "E" } });
  assert.deepEqual(steps.map((s) => s.number), ["1", "2", "3", "3.1", "3.2", "4"]);
});

test("delete, move and merge renumber", () => {
  const steps = [];
  for (const b of ["A", "B", "C"]) SR.addStep(steps, { kind: "button", data: { button: b } });
  SR.moveStep(steps, steps[2].id, -1);
  assert.deepEqual(steps.map((s) => s.data.button), ["A", "C", "B"]);
  SR.mergeWithPrevious(steps, steps[1].id);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].text, 'Click "A". Click "C".');
  SR.removeStep(steps, steps[0].id);
  assert.deepEqual(steps.map((s) => s.number), ["1"]);
});

test("removing the step that started a sub-workflow lifts its steps", () => {
  const steps = [];
  SR.addStep(steps, { kind: "sub", data: { workflow: "Pack" } });
  SR.addStep(steps, { kind: "button", data: { button: "C" } }, "1");
  SR.removeStep(steps, steps[0].id);
  assert.deepEqual(steps.map((s) => s.number), ["1"]);
  assert.equal(steps[0].sub, null);
});

test("relanguage keeps hand-edited sentences", () => {
  const steps = [];
  SR.addStep(steps, { kind: "button", data: { button: "OK" } });
  SR.addStep(steps, { kind: "button", data: { button: "Back" }, text: "my own", edited: true });
  SR.relanguage(steps, "de");
  assert.equal(steps[0].text, "Klicken Sie auf „OK“.");
  assert.equal(steps[1].text, "my own");
});

test("classify: passwords are masked, buttons need a label, inputs are recorded on change", () => {
  assert.deepEqual(SR.classify({ event: "change", tag: "input", type: "password", prompt: "PW", value: "secret" }), { kind: "input", data: { prompt: "PW", value: SR.MASK } });
  assert.deepEqual(SR.classify({ event: "click", tag: "button", label: "Proceed" }), { kind: "button", data: { button: "Proceed" } });
  assert.equal(SR.classify({ event: "click", tag: "input", type: "text", label: "x" }), null);
  assert.equal(SR.classify({ event: "click", tag: "div" }), null);
  assert.deepEqual(SR.classify({ event: "change", tag: "input", type: "checkbox", prompt: "Print", checked: true }), { kind: "binary", data: { prompt: "Print", on: true } });
  assert.deepEqual(SR.classify({ event: "click", inList: true, rowKey: "SHP-1", listTitle: "Open" }), { kind: "list", data: { list: "Open", value: "SHP-1" } });
  assert.deepEqual(SR.classify({ event: "click", inLov: true, rowKey: "A", prompt: "Shipment", columnHeader: "No" }), { kind: "lov", data: { prompt: "Shipment", value: "A", column: "No" } });
});

test("groupByScreen starts a heading when the screen changes", () => {
  const g = SR.groupByScreen([{ screen: "A" }, { screen: "A" }, { screen: "B" }]);
  assert.deepEqual(g.map((x) => [x.title, x.steps.length]), [["A", 2], ["B", 1]]);
});
