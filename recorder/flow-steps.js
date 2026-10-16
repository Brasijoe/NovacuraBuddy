/* ============================================================
   Flow Steps — builds the designer "data" array (script steps,
   sequence arrows, module-added entries) for a component asset.
   Ported from Infos/FlowGenerator.txt (Novacura's own FlowScript
   generator for the same job) — kept close to that source rather
   than redesigned, since the wire format (field names/shape) must
   match what Flow's designer actually expects.
   ============================================================ */
(function (global) {
  function newGuid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function createStartStep() {
    return [{
      type: "step-created",
      id: newGuid(),
      stepType: "start",
      location: { x: 0, y: 0 },
      label: "",
      configuration: null
    }];
  }

  function createEndStep(x) {
    return {
      type: "step-created",
      id: newGuid(),
      stepType: "end",
      location: { x, y: 0 },
      label: "",
      configuration: null
    };
  }

  function getScriptStepsCreated(data) {
    return data.filter((d) => d.type === "step-created");
  }

  function getArrowsCreated(data) {
    return data.filter((d) => d.type === "arrow-created");
  }

  function maxLocationX(data) {
    return data.reduce((max, d) => (d.location ? Math.max(max, d.location.x) : max), 0);
  }

  /** Every targetVariableName already declared by a step-created entry (script steps and every
   *  user-step control) so far — FlowScript's `let` is single-assignment, so two steps can't
   *  declare the same variable name without a validation failure. */
  function collectUsedVariableNames(data) {
    const names = new Set();
    data.forEach((d) => {
      if (d.type !== "step-created" || !d.configuration) return;
      if (d.configuration.targetVariableName) names.add(d.configuration.targetVariableName);
      if (Array.isArray(d.configuration.controls)) {
        d.configuration.controls.forEach((c) => {
          if (c.targetVariableName) names.add(c.targetVariableName);
        });
      }
    });
    return names;
  }

  function disambiguateVariableName(base, used) {
    let name = base;
    let i = 2;
    while (used.has(name)) {
      name = `${base}${i}`;
      i++;
    }
    return name;
  }

  /** Appends one script step (and, if needed, a start step + connecting sequence arrow) to `data`. */
  function addScriptStep(data, script, tableName, connector, loadingMessage, userId, type, module) {
    let tempData = data.slice();
    const stepId = newGuid();
    let fromStep = null;

    if (tempData.length === 0) {
      const startStep = createStartStep();
      tempData = tempData.concat(startStep);
      fromStep = startStep[0].id;
    }

    // The same entity/function is very commonly fetched more than once in one recording (e.g.
    // list -> action -> refresh list) — disambiguate rather than emit a duplicate declaration.
    const targetVariableName = disambiguateVariableName(type + tableName, collectUsedVariableNames(tempData));

    const xCoordinate = maxLocationX(tempData) + 300;
    tempData = tempData.concat([{
      type: "step-created",
      id: stepId,
      stepType: "script",
      location: { x: xCoordinate, y: 0 },
      label: tableName + "GetData" + type,
      configuration: {
        type: "script-step-configuration",
        targetVariableName,
        script,
        connector: connector || null,
        loadingMessage: loadingMessage || "",
        attribution: { userId, timestamp: new Date().toISOString() }
      }
    }]);

    if (fromStep === null) {
      const arrowsFrom = new Set(getArrowsCreated(tempData).map((a) => a.fromStep));
      const candidate = getScriptStepsCreated(tempData).find((s) => !arrowsFrom.has(s.id));
      fromStep = candidate ? candidate.id : null;
    }

    if (fromStep !== null) {
      tempData = tempData.concat([{
        type: "arrow-created",
        id: newGuid(),
        arrowKind: "sequence",
        fromStep,
        toStep: stepId,
        joints: [],
        attachment: null
      }]);
    }

    return tempData;
  }

  /** Marks a module as used/activated by the component — required for the module's functions to resolve. */
  function addModule(data, name, moduleId) {
    return data.concat([{ type: "module-added", name, moduleId }]);
  }

  /* --- User-step controls --- */

  function createTextInputControl(targetVariableName, label, allowEmpty) {
    return {
      type: "text-input",
      targetVariableName,
      label,
      defaultText: "",
      multiline: false,
      allowEmpty: !!allowEmpty,
      forceUppercase: false,
      enableCorrection: false,
      autoTrim: false,
      passwordMask: false,
      keyboardType: "text",
      mergeBehavior: "keepMyChanges",
      id: newGuid(),
      hideIfExpr: ""
    };
  }

  function createSimpleValueControl(type, targetVariableName, label, allowEmpty) {
    // Key order matters: the backend's polymorphic control deserializer reads the "type"
    // discriminator before the rest of the object, same requirement as .NET's
    // System.Text.Json discriminated-union converters — confirmed live 2026-08-07 (text-input
    // always had `type` first by coincidence and always worked; this function had it last and
    // 500'd every time, even with byte-identical field SET to a real Designer capture).
    return {
      type,
      targetVariableName,
      label,
      defaultValue: "", // confirmed correct via real Designer capture 2026-08-07
      allowEmpty: !!allowEmpty,
      mergeBehavior: "keepMyChanges",
      id: newGuid(),
      hideIfExpr: ""
    };
  }

  function createNumericInputControl(targetVariableName, label, allowEmpty) {
    return createSimpleValueControl("numeric-input", targetVariableName, label, allowEmpty);
  }

  function createDateInputControl(targetVariableName, label, allowEmpty) {
    return createSimpleValueControl("date-input", targetVariableName, label, allowEmpty);
  }

  function createTimeInputControl(targetVariableName, label, allowEmpty) {
    return createSimpleValueControl("time-input", targetVariableName, label, allowEmpty);
  }

  /** sourceVariableName: the targetVariableName of the earlier step whose result is the
   *  candidate list. largeRowText/smallRowText are "{Field}"-templated row-display strings.
   *
   *  Key order matters: same discriminator-first requirement already confirmed live for
   *  createSimpleValueControl (2026-08-07). Two earlier attempts at this control's own order
   *  (type-only-first, then type/targetVariableName/label-first) both still 500'd live — the
   *  field SET was always right, but the order was guessed both times, no real capture existed.
   *  User then supplied a REAL Designer-built list-selection control's own saved JSON (2026-08-12)
   *  — ground truth, not a guess. Rebuilt to match it EXACTLY, including the nested `source`
   *  object's own order (type before path — same discriminator-first pattern one level deeper,
   *  confirmed by the same real capture): type, targetVariableName, source, label, largeRowText,
   *  smallRowText, imageExpr, itemStyleExpr, groupByMember, defaultSelectionExpr,
   *  resultTransformationExpr, allowEmpty, inline, showAutomatically, barcodeMatchStrategy,
   *  barcodeMatchColumns, mergeBehavior, id, hideIfExpr. */
  function createListSelectionControl(targetVariableName, label, sourceVariableName, largeRowText, smallRowText, allowEmpty) {
    return {
      type: "list-selection",
      targetVariableName,
      source: { type: "variable", path: sourceVariableName },
      label,
      largeRowText,
      smallRowText,
      imageExpr: "",
      itemStyleExpr: "",
      groupByMember: "",
      defaultSelectionExpr: "",
      resultTransformationExpr: "",
      allowEmpty: !!allowEmpty,
      inline: "auto",
      showAutomatically: false,
      barcodeMatchStrategy: "rowText",
      barcodeMatchColumns: [],
      mergeBehavior: "keepMyChanges",
      id: newGuid(),
      hideIfExpr: ""
    };
  }

  /** Multi-selection variant of createListSelectionControl — real bug class already learned
   *  live for the single-select control (2026-08-12, took THREE rounds to get right): don't
   *  guess a control's shape by analogy from a similar one, get a real Designer capture first.
   *  This function's field set/order comes directly from a real captured multi-list-selection
   *  control (user-supplied, 2026-08-12) — genuinely DIFFERENT from list-selection, not just a
   *  renamed copy: no `allowEmpty`/`resultTransformationExpr`/`barcodeMatchStrategy`/
   *  `barcodeMatchColumns` at all, and the field is `defaultSelectionExpression` (full word, NOT
   *  `defaultSelectionExpr` like list-selection's own field), positioned right after `source`,
   *  not down near the end. Exact real order: type, targetVariableName, source,
   *  defaultSelectionExpression, label, largeRowText, smallRowText, imageExpr, itemStyleExpr,
   *  groupByMember, inline, showAutomatically, mergeBehavior, id, hideIfExpr. Wiring — deciding
   *  WHEN to emit this instead of a single list-selection control — is a separate, not-yet-built
   *  piece (see project_ifs_backlog.md's composite key-ref design); this is just the control
   *  shape itself. */
  function createMultiListSelectionControl(targetVariableName, label, sourceVariableName, largeRowText, smallRowText) {
    return {
      type: "multi-list-selection",
      targetVariableName,
      source: { type: "variable", path: sourceVariableName },
      defaultSelectionExpression: "",
      label,
      largeRowText,
      smallRowText,
      imageExpr: "",
      itemStyleExpr: "",
      groupByMember: "",
      inline: "auto",
      showAutomatically: false,
      mergeBehavior: "keepMyChanges",
      id: newGuid(),
      hideIfExpr: ""
    };
  }

  /** Inserts a user-input step immediately before `beforeStepId` (the first step whose script
   *  needs the value), matching how Flow's own designer represents this: the step-created entry
   *  with one or more controls, a "Next" button wired to a new outgoing arrow (button.arrowId
   *  === arrow.id) into beforeStepId, and the PRE-EXISTING incoming arrow retargeted to point at
   *  the new step instead of straight at beforeStepId. That retargeting is done by mutating the
   *  existing arrow-created entry's toStep/joints directly, NOT by appending
   *  arrow-target-changed/arrow-joints-changed entries — those are Flow's own incremental-edit
   *  delta events (diffed against an already-saved version), which don't apply here since we
   *  submit the whole `data` array fresh every time; mixing them into a from-scratch submission
   *  produced a 500 (confirmed live). Returns { data, stepId } — stepId is needed by the caller
   *  to know which step to hang a NEXT user step's insertion off of, or to no-op gracefully if
   *  beforeStepId isn't found. */
  function addUserStep(data, beforeStepId, controls, label, userId) {
    let tempData = data.slice();
    const beforeIndex = tempData.findIndex((d) => d.type === "step-created" && d.id === beforeStepId);
    if (beforeIndex === -1) return { data: tempData, stepId: null };
    const beforeStep = tempData[beforeIndex];

    const x = beforeStep.location ? beforeStep.location.x - 150 : maxLocationX(tempData) + 300;
    const y = beforeStep.location ? beforeStep.location.y : 0;

    const stepId = newGuid();
    const outArrowId = newGuid();
    const userStep = {
      type: "step-created",
      id: stepId,
      stepType: "user",
      location: { x, y },
      label,
      configuration: {
        type: "user-step-configuration",
        controls,
        controlPositions: controls.map((_, i) => [i]),
        allowReloading: false,
        isPinned: false,
        pinnedColorIndex: 0,
        pinnedIconString: null,
        preventGoingBack: false,
        allowDependencies: false,
        autoForwardEnabled: false,
        autoForwardDelay: "instant",
        autoForwardCondition: "",
        buttons: [{
          id: newGuid(),
          arrowId: outArrowId,
          label: "Next",
          isPrimary: false,
          isAlwaysEnabled: false,
          availableIf: ""
        }],
        attribution: { userId, timestamp: new Date().toISOString() }
      }
    };

    const outArrow = {
      type: "arrow-created",
      id: outArrowId,
      arrowKind: "sequence",
      fromStep: stepId,
      toStep: beforeStepId,
      joints: [],
      attachment: null
    };

    // Insert right before the target step rather than appending at the very end — every
    // previously-working payload had each entity defined before anything referencing it;
    // always appending new steps at the end left the retargeted arrow (defined near the top
    // of the array) pointing at a step defined near the bottom, a gap that never existed
    // before user-step insertion.
    tempData.splice(beforeIndex, 0, userStep, outArrow);

    const incomingIndex = tempData.findIndex((d) => d.type === "arrow-created" && d.id !== outArrowId && d.toStep === beforeStepId);
    if (incomingIndex !== -1) {
      tempData[incomingIndex] = Object.assign({}, tempData[incomingIndex], { toStep: stepId, joints: [] });
    }

    return { data: tempData, stepId };
  }

  /** Appends an end step and connects the current last dangling step (normally the final
   *  script step) to it. Must be called last, once no more script steps will be added —
   *  `data` here must contain only step-created/arrow-created entries, not module-added
   *  entries (those have no `location` and would be mistaken for a step). */
  function addEndStep(data) {
    let tempData = data.slice();
    const endStep = createEndStep(maxLocationX(tempData) + 300);
    tempData = tempData.concat([endStep]);

    const arrowsFrom = new Set(getArrowsCreated(tempData).map((a) => a.fromStep));
    const fromStep = getScriptStepsCreated(tempData).find((s) => s.id !== endStep.id && !arrowsFrom.has(s.id));
    if (fromStep) {
      tempData = tempData.concat([{
        type: "arrow-created",
        id: newGuid(),
        arrowKind: "sequence",
        fromStep: fromStep.id,
        toStep: endStep.id,
        joints: [],
        attachment: null
      }]);
    }

    return tempData;
  }

  const api = {
    addScriptStep,
    addModule,
    addEndStep,
    addUserStep,
    collectUsedVariableNames,
    disambiguateVariableName,
    createTextInputControl,
    createNumericInputControl,
    createDateInputControl,
    createTimeInputControl,
    createListSelectionControl,
    createMultiListSelectionControl,
    newGuid
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.FlowSteps = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
