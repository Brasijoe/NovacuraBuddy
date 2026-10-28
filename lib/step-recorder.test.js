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

test("free text sections are not numbered and sit anywhere", () => {
  const steps = [];
  SR.addStep(steps, { kind: "button", data: { button: "A" } });
  const sec = SR.addSection(steps, steps[0].id, "Prerequisites");
  SR.addStep(steps, { kind: "button", data: { button: "B" } });
  assert.deepEqual(steps.map((s) => s.number), ["1", "", "2"]);
  SR.addSection(steps, null, "Intro");
  assert.equal(steps[0].text, "Intro");
  assert.ok(sec.id);
});

test("cropMarker moves the marker into the cropped image", () => {
  const m = SR.cropMarker({ shape: "circle", x: 50, y: 30, vw: 100, vh: 60 }, { fx: 0.25, fy: 0.5, fw: 0.5, fh: 0.5 });
  assert.deepEqual(m, { shape: "circle", x: 25, y: 0, vw: 50, vh: 30 });
});

test("brand title is upper case with a trailing period; contents lists screens and sections", () => {
  assert.equal(SR.brandTitle("Pack shipment."), "PACK SHIPMENT.");
  assert.equal(SR.brandTitle(""), "");
  const steps = [];
  SR.addStep(steps, { kind: "button", data: { button: "A" }, screen: "Pick" });
  SR.addStep(steps, { kind: "button", data: { button: "B" }, screen: "Pick" });
  SR.addStep(steps, { kind: "button", data: { button: "C" }, screen: "Pack" });
  assert.deepEqual(SR.contents(steps).map((c) => [c.title, c.from]), [["Pick", "1"], ["Pack", "3"]]);
});

test("pages: a lead step holds the screenshot, later steps share it, sections break the run", () => {
  const steps = [];
  const add = (b, leads, shot) => SR.addStep(steps, { kind: "button", data: { button: b }, leads, screenshot: shot });
  add("A", true, "shotA"); add("B", false, null); add("C", true, "shotC");
  SR.addSection(steps, steps[2].id, "Note");
  add("D", false, null);
  const runs = SR.pageRuns(steps);
  assert.deepEqual(runs.map((r) => r.type === "section" ? "sec" : r.steps.map((s) => s.data.button).join("")), ["AB", "C", "sec", "D"]);
  assert.equal(runs[3].lead, null);
});

test("deleting or merging a page's lead hands the screenshot to the next step of the page", () => {
  const steps = [];
  SR.addStep(steps, { kind: "button", data: { button: "A" }, leads: true, screenshot: "shotA" });
  SR.addStep(steps, { kind: "button", data: { button: "B" } });
  SR.addStep(steps, { kind: "button", data: { button: "C" }, leads: true, screenshot: "shotC" });
  SR.removeStep(steps, steps[0].id);
  assert.equal(steps[0].leads, true);
  assert.equal(steps[0].screenshot, "shotA");
  assert.equal(steps[1].screenshot, "shotC");
});

test("moving a step inside a page keeps the screenshot at the page's first position; movePage swaps whole pages", () => {
  const steps = [];
  SR.addStep(steps, { kind: "button", data: { button: "A" }, leads: true, screenshot: "shotA" });
  SR.addStep(steps, { kind: "button", data: { button: "B" } });
  SR.addStep(steps, { kind: "button", data: { button: "C" }, leads: true, screenshot: "shotC" });
  SR.moveStep(steps, steps[0].id, 1);
  assert.deepEqual(steps.map((s) => s.data.button), ["B", "A", "C"]);
  assert.equal(steps[0].screenshot, "shotA");
  assert.equal(steps[1].screenshot, null);
  SR.movePage(steps, steps[2].id, -1);
  assert.deepEqual(steps.map((s) => s.data.button), ["C", "B", "A"]);
  assert.deepEqual(steps.map((s) => s.number), ["1", "2", "3"]);
});

test("joinPreviousPage drops the screenshot and cropPage moves all markers", () => {
  const steps = [];
  SR.addStep(steps, { kind: "button", data: { button: "A" }, leads: true, screenshot: "a" });
  SR.addStep(steps, { kind: "button", data: { button: "B" }, leads: true, screenshot: "b" });
  SR.joinPreviousPage(steps, steps[1].id);
  assert.equal(steps[1].leads, false);
  assert.equal(steps[1].screenshot, null);
  const run = { steps: [{ marker: { shape: "circle", x: 50, y: 30, vw: 100, vh: 60 } }, { marker: { shape: "circle", x: 80, y: 40, vw: 100, vh: 60 } }] };
  SR.cropPage(run, { fx: 0.25, fy: 0.5, fw: 0.5, fh: 0.5 });
  assert.deepEqual(run.steps.map((s) => [s.marker.x, s.marker.y]), [[25, 0], [55, 10]]);
});

test("a click on read-only text becomes a Note step in all languages", () => {
  const c = SR.classify({ event: "click", readonly: true, tag: "div", label: "Gross weight 12 kg" });
  assert.deepEqual(c, { kind: "object", data: { value: "Gross weight 12 kg" } });
  assert.equal(SR.sentence(c, "en"), 'Note "Gross weight 12 kg".');
  assert.equal(SR.sentence(c, "de"), "Beachten Sie „Gross weight 12 kg“.");
  assert.equal(SR.classify({ event: "click", readonly: true, tag: "div", label: "" }), null);
});

test("similarity and samePage: same title but different controls is a different page", () => {
  assert.equal(SR.similarity(["a", "b"], ["a", "b"]), 1);
  assert.equal(SR.similarity([], ["a"]), 1);
  assert.ok(SR.similarity(["a", "b", "c"], ["x", "y", "z"]) < SR.SAME_PAGE);
  const page = { screen: "Pack", url: "/a", lov: false, sig: ["ok", "back", "ship", "weight"] };
  assert.equal(SR.samePage(page, { screen: "Pack", page: "/a", sig: ["ok", "back", "ship"] }), true);
  assert.equal(SR.samePage(page, { screen: "Pack", page: "/a", sig: ["save", "cancel", "items"] }), false);
  assert.equal(SR.samePage(page, { screen: "Pick", page: "/a", sig: ["ok", "back", "ship", "weight"] }), false);
  assert.equal(SR.samePage(null, { screen: "Pack" }), false);
});

test("free text fields are named by their prompt, not by what was typed", () => {
  const c = SR.classify({ event: "change", tag: "textarea", prompt: "Action Taken", value: "Some action" });
  assert.deepEqual(c, { kind: "freetext", data: { prompt: "Action Taken", value: "Some action" } });
  assert.equal(SR.sentence(c, "en"), 'Enter "Action Taken".');
  assert.equal(SR.sentence(c, "de"), "Geben Sie „Action Taken“ ein.");
  assert.equal(SR.sentence(c, "fr"), "Saisissez « Action Taken ».");
  assert.equal(SR.classify({ event: "change", tag: "input", type: "text", prompt: "P", value: "a\nb" }).kind, "freetext");
  assert.equal(SR.classify({ event: "change", tag: "input", type: "text", prompt: "P", value: "short" }).kind, "input");
});

test("generic headings like Info are left out of page titles and contents", () => {
  assert.equal(SR.pageTitle({ lead: { screen: "Info" }, steps: [] }), "");
  assert.equal(SR.pageTitle({ lead: { screen: "Pack shipment" }, steps: [] }), "Pack shipment");
  assert.equal(SR.pageTitle({ lead: { screen: "Pack shipment" }, steps: [] }, false), "");
  const steps = [];
  SR.addStep(steps, { kind: "button", data: { button: "A" }, screen: "Info" });
  SR.addStep(steps, { kind: "button", data: { button: "B" }, screen: "Pack" });
  assert.deepEqual(SR.contents(steps).map((c) => c.title), ["Pack"]);
});
