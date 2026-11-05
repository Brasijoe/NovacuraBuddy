let deterministicIdCounter = null;
function beginDeterministicIds() {
  deterministicIdCounter = 0;
}
function endDeterministicIds() {
  deterministicIdCounter = null;
}
function newGuid() {
  if (deterministicIdCounter === null) return crypto.randomUUID();
  const hex = (deterministicIdCounter++).toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}
function attribution(userId) {
  return { userId, timestamp: (/* @__PURE__ */ new Date()).toISOString() };
}
function getStepsCreated(data) {
  return data.filter((d) => d.type === "step-created");
}
function getArrowsCreated(data) {
  return data.filter((d) => d.type === "arrow-created");
}
function maxLocationX(data) {
  return data.reduce((max, d) => {
    const loc = "location" in d ? d.location : void 0;
    return loc ? Math.max(max, loc.x) : max;
  }, 0);
}
function collectUsedVariableNames(data) {
  const names = /* @__PURE__ */ new Set();
  data.forEach((d) => {
    if (d.type !== "step-created" || !d.configuration) return;
    const config = d.configuration;
    if (typeof config.targetVariableName === "string") names.add(config.targetVariableName);
    if (Array.isArray(config.controls)) {
      config.controls.forEach((c) => {
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
function createStartStepEntry() {
  return { type: "step-created", id: newGuid(), stepType: "start", location: { x: 0, y: 0 }, label: "", configuration: null };
}
function createEndStepEntry(location) {
  return { type: "step-created", id: newGuid(), stepType: "end", location, label: "", configuration: null };
}
function connectIncoming(data, toStepId, fromStepId, joints, dataFromStepIds) {
  let sources;
  if (Array.isArray(fromStepId)) {
    sources = fromStepId.filter((s) => Boolean(s));
  } else if (fromStepId) {
    sources = [fromStepId];
  } else if (dataFromStepIds && dataFromStepIds.length > 0) {
    sources = [];
  } else {
    const arrowsFrom = new Set(getArrowsCreated(data).map((a) => a.fromStep));
    const candidate = getStepsCreated(data).find((s) => s.id !== toStepId && !arrowsFrom.has(s.id));
    sources = candidate ? [candidate.id] : [];
  }
  const singleSourceJoints = sources.length === 1 && Array.isArray(joints) ? joints : [];
  const withSequence = sources.reduce(
    (acc, fromStep) => acc.concat([
      { type: "arrow-created", id: newGuid(), arrowKind: "sequence", fromStep, toStep: toStepId, joints: singleSourceJoints, attachment: null }
    ]),
    data
  );
  return (dataFromStepIds || []).filter((s) => Boolean(s)).reduce(
    (acc, fromStep) => acc.concat([
      { type: "arrow-created", id: newGuid(), arrowKind: "data", fromStep, toStep: toStepId, joints: [], attachment: null }
    ]),
    withSequence
  );
}
function needsAutoStart(data, fromStepId) {
  const noExplicitSource = fromStepId === void 0 || fromStepId === null || Array.isArray(fromStepId) && fromStepId.filter(Boolean).length === 0;
  return data.length === 0 && noExplicitSource;
}
function addStartStep(userId, startParametersExpression, location, inboxConfig) {
  const startConfiguration = inboxConfig ? {
    type: "inbox",
    sourceTable: inboxConfig.sourceTable,
    itemKey: inboxConfig.itemKey,
    titleTemplate: "",
    descriptionTemplate: "",
    importanceExpression: "",
    timestampExpression: ""
  } : startParametersExpression ? { type: "params", expression: startParametersExpression } : null;
  const configuration = startConfiguration ? { type: "start-step-configuration", startConfiguration, attribution: attribution(userId) } : null;
  const stepId = newGuid();
  const data = [{ type: "step-created", id: stepId, stepType: "start", location: location || { x: 0, y: 0 }, label: "", configuration }];
  return { data, stepId };
}
function addEndStep(data, fromStepId, location, joints, dataFromStepIds) {
  const endStep = createEndStepEntry(location || { x: maxLocationX(data) + 300, y: 0 });
  let tempData = data.concat([endStep]);
  tempData = connectIncoming(tempData, endStep.id, fromStepId, joints, dataFromStepIds);
  return { data: tempData, stepId: endStep.id };
}
function addModule(data, name, moduleId) {
  return data.concat([{ type: "module-added", name, moduleId }]);
}
function addOutputVariables(data, variableNames) {
  if (!variableNames || variableNames.length === 0) return data;
  return data.concat([{ type: "output-variables-modified", outputVariables: variableNames }]);
}
function addAnnotation(data, text, location, size, color = "grey") {
  return data.concat([{ type: "annotation-created", id: newGuid(), text, location, size, color }]);
}
function addScriptStep(data, script, tableName, connector, loadingMessage, userId, type, moduleParam, fromStepId, location, joints, dataFromStepIds) {
  void moduleParam;
  let tempData = data;
  const stepId = newGuid();
  if (needsAutoStart(tempData, fromStepId)) {
    const startStep = createStartStepEntry();
    tempData = tempData.concat([startStep]);
    fromStepId = startStep.id;
  }
  const targetVariableName = type + tableName;
  const scriptStep = {
    type: "step-created",
    id: stepId,
    stepType: "script",
    location: location || { x: maxLocationX(tempData) + 300, y: 0 },
    label: tableName + "GetData" + type,
    configuration: {
      type: "script-step-configuration",
      targetVariableName,
      script,
      connector: connector || null,
      loadingMessage: loadingMessage || "",
      attribution: attribution(userId)
    }
  };
  tempData = tempData.concat([scriptStep]);
  tempData = connectIncoming(tempData, stepId, fromStepId, joints, dataFromStepIds);
  return { data: tempData, stepId };
}
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
  return {
    type,
    targetVariableName,
    label,
    defaultValue: "",
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
function addUserStep(data, beforeStepId, controls, label, userId) {
  const beforeIndex = data.findIndex((d) => d.type === "step-created" && d.id === beforeStepId);
  if (beforeIndex === -1) return { data, stepId: null };
  const beforeStep = data[beforeIndex];
  const x = beforeStep.location ? beforeStep.location.x - 150 : maxLocationX(data) + 300;
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
      buttons: [{ id: newGuid(), arrowId: outArrowId, label: "Next", isPrimary: false, isAlwaysEnabled: false, availableIf: "" }],
      attribution: attribution(userId)
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
  const tempData = data.slice();
  tempData.splice(beforeIndex, 0, userStep, outArrow);
  const finalData = tempData.map(
    (d) => d.type === "arrow-created" && d.id !== outArrowId && d.toStep === beforeStepId ? { ...d, toStep: stepId, joints: [] } : d
  );
  return { data: finalData, stepId };
}
function isLowcodeCondition(c) {
  return c.type === "lowcode";
}
function addDecisionStep(data, routes, label, userId, fromStepId, location, incomingJoints, dataFromStepIds) {
  let tempData = data;
  const stepId = newGuid();
  if (needsAutoStart(tempData, fromStepId)) {
    const startStep = createStartStepEntry();
    tempData = tempData.concat([startStep]);
    fromStepId = startStep.id;
  }
  const decoratedRoutes = routes.map((r) => ({
    label: r.label,
    arrowId: newGuid(),
    conditions: (r.conditions || []).map((c) => isLowcodeCondition(c) ? c : { type: "expression", expression: c.expression }),
    relation: r.relation || "all"
  }));
  const decisionStep = {
    type: "step-created",
    id: stepId,
    stepType: "decision",
    location: location || { x: maxLocationX(tempData) + 300, y: 0 },
    label,
    configuration: { type: "decision-step-configuration", routes: decoratedRoutes, attribution: attribution(userId) }
  };
  tempData = tempData.concat([decisionStep]);
  tempData = connectIncoming(tempData, stepId, fromStepId, incomingJoints, dataFromStepIds);
  routes.forEach((r, i) => {
    const routeArrow = {
      type: "arrow-created",
      id: decoratedRoutes[i].arrowId,
      arrowKind: "sequence",
      fromStep: stepId,
      toStep: r.toStep,
      joints: r.joints || [],
      attachment: null
    };
    tempData = tempData.concat([routeArrow]);
  });
  return { data: tempData, stepId };
}
function addUserTaskStep(data, controls, controlPositions, stepConfig, buttons, label, userId, fromStepId, location, incomingJoints, dataFromStepIds) {
  let tempData = data;
  const stepId = newGuid();
  if (needsAutoStart(tempData, fromStepId)) {
    const startStep = createStartStepEntry();
    tempData = tempData.concat([startStep]);
    fromStepId = startStep.id;
  }
  const decoratedButtons = buttons.map((b) => ({
    id: newGuid(),
    arrowId: newGuid(),
    label: b.label,
    isPrimary: b.isPrimary,
    isAlwaysEnabled: b.isAlwaysEnabled,
    availableIf: b.availableIf
  }));
  const userStep = {
    type: "step-created",
    id: stepId,
    stepType: "user",
    location: location || { x: maxLocationX(tempData) + 300, y: 0 },
    label,
    configuration: {
      type: "user-step-configuration",
      controls,
      controlPositions,
      allowReloading: stepConfig.allowReloading,
      isPinned: stepConfig.isPinned,
      pinnedColorIndex: stepConfig.backgroundColorIndex,
      pinnedIconString: null,
      preventGoingBack: stepConfig.preventUserBack,
      allowDependencies: false,
      autoForwardEnabled: stepConfig.allowAutoForward,
      autoForwardDelay: stepConfig.autoForwardDelay,
      autoForwardCondition: stepConfig.autoForwardCondition,
      buttons: decoratedButtons,
      attribution: attribution(userId)
    }
  };
  tempData = tempData.concat([userStep]);
  tempData = connectIncoming(tempData, stepId, fromStepId, incomingJoints, dataFromStepIds);
  buttons.forEach((b, i) => {
    const buttonArrow = {
      type: "arrow-created",
      id: decoratedButtons[i].arrowId,
      arrowKind: "sequence",
      fromStep: stepId,
      toStep: b.toStep,
      joints: [],
      attachment: null
    };
    tempData = tempData.concat([buttonArrow]);
  });
  return { data: tempData, stepId, buttonArrowIds: decoratedButtons.map((b) => b.arrowId) };
}
function addAssignmentStep(data, assignments, label, userId, fromStepId, location, joints, dataFromStepIds) {
  let tempData = data;
  const stepId = newGuid();
  if (needsAutoStart(tempData, fromStepId)) {
    const startStep = createStartStepEntry();
    tempData = tempData.concat([startStep]);
    fromStepId = startStep.id;
  }
  const assignmentStep = {
    type: "step-created",
    id: stepId,
    stepType: "assignment",
    location: location || { x: maxLocationX(tempData) + 300, y: 0 },
    label,
    configuration: {
      type: "assignment-step-configuration",
      assignments: assignments.map((a) => ({ targetVariableName: a.targetVariableName, template: a.template })),
      attribution: attribution(userId)
    }
  };
  tempData = tempData.concat([assignmentStep]);
  tempData = connectIncoming(tempData, stepId, fromStepId, joints, dataFromStepIds);
  return { data: tempData, stepId };
}
function addAssertionStep(data, conditions, relation, errorMessage, label, userId, fromStepId, location, joints, dataFromStepIds) {
  let tempData = data;
  const stepId = newGuid();
  if (needsAutoStart(tempData, fromStepId)) {
    const startStep = createStartStepEntry();
    tempData = tempData.concat([startStep]);
    fromStepId = startStep.id;
  }
  const assertionStep = {
    type: "step-created",
    id: stepId,
    stepType: "assertion",
    location: location || { x: maxLocationX(tempData) + 300, y: 0 },
    label,
    configuration: {
      type: "assertion-step-configuration",
      errorMessage,
      conditions: conditions.map((c) => isLowcodeCondition(c) ? c : { type: "expression", expression: c.expression }),
      relation: relation || "all",
      attribution: attribution(userId)
    }
  };
  tempData = tempData.concat([assertionStep]);
  tempData = connectIncoming(tempData, stepId, fromStepId, joints, dataFromStepIds);
  return { data: tempData, stepId };
}
function addMachineStep(data, targetVariableName, command, label, userId, fromStepId, location, joints, dataFromStepIds) {
  let tempData = data;
  const stepId = newGuid();
  if (needsAutoStart(tempData, fromStepId)) {
    const startStep = createStartStepEntry();
    tempData = tempData.concat([startStep]);
    fromStepId = startStep.id;
  }
  const machineStep = {
    type: "step-created",
    id: stepId,
    stepType: "machine",
    location: location || { x: maxLocationX(tempData) + 300, y: 0 },
    label,
    configuration: { type: "machine-step-configuration", id: newGuid(), targetVariableName, attribution: attribution(userId), command }
  };
  tempData = tempData.concat([machineStep]);
  tempData = connectIncoming(tempData, stepId, fromStepId, joints, dataFromStepIds);
  return { data: tempData, stepId };
}
function addRestCallStep(data, restCall, label, userId, fromStepId, location, joints, dataFromStepIds) {
  const command = {
    type: "rest-call",
    connector: restCall.connector,
    method: restCall.method,
    urlExpression: restCall.urlExpression,
    bodyExpression: restCall.bodyExpression,
    bodyType: restCall.bodyType || "jsonSerialized",
    headers: restCall.headers || [],
    failOnUnsuccessfulResponse: restCall.failOnUnsuccessfulResponse !== false,
    responseType: restCall.responseType || "json",
    resultTypeExpression: restCall.resultTypeExpression,
    targetVariableName: restCall.targetVariableName
  };
  return addMachineStep(data, restCall.targetVariableName, command, label, userId, fromStepId, location, joints, dataFromStepIds);
}
function addDatabaseCommandStep(data, input, label, userId, fromStepId, location, joints, dataFromStepIds) {
  const command = {
    type: "database-command",
    commandType: input.commandType,
    commandText: input.commandText,
    iteratorExpression: input.iteratorExpression || "",
    runAsTemplate: input.runAsTemplate || "",
    isRunAsSigned: input.isRunAsSigned !== false,
    defaultValue: input.defaultValue || "",
    defaultValueEnabled: input.defaultValueEnabled || false,
    loadingMessage: input.loadingMessage || "",
    isSigned: input.isSigned || false,
    connector: input.connector ?? null
  };
  return addMachineStep(data, input.targetVariableName, command, label, userId, fromStepId, location, joints, dataFromStepIds);
}
function addEmailStep(data, input, label, userId, fromStepId, location, joints) {
  const command = {
    type: "email-command",
    from: input.from || "",
    to: input.to,
    cc: input.cc || "",
    bcc: input.bcc || "",
    subject: input.subject,
    body: input.body,
    isHtml: input.isHtml || false,
    attachmentScript: input.attachmentScript || "",
    connector: input.connector ?? null
  };
  return addMachineStep(data, input.targetVariableName, command, label, userId, fromStepId, location, joints);
}
function addComponentStep(data, component, label, userId, fromStepId, location, joints, dataFromStepIds) {
  let tempData = data;
  const stepId = newGuid();
  if (needsAutoStart(tempData, fromStepId)) {
    const startStep = createStartStepEntry();
    tempData = tempData.concat([startStep]);
    fromStepId = startStep.id;
  }
  const componentStep = {
    type: "step-created",
    id: stepId,
    stepType: "component",
    location: location || { x: maxLocationX(tempData) + 300, y: 0 },
    label,
    configuration: {
      type: "component-step-configuration",
      componentId: component.componentId,
      targetVariableName: component.targetVariableName || "",
      componentName: component.componentName,
      componentColorCode: component.componentColorCode || "#0A68FF",
      parameterExpression: component.parameterExpression || "{}",
      attribution: attribution(userId)
    }
  };
  tempData = tempData.concat([componentStep]);
  tempData = connectIncoming(tempData, stepId, fromStepId, joints, dataFromStepIds);
  return { data: tempData, stepId };
}
function addCheckpointStep(data, title, text, userId, fromStepId, location, joints, dataFromStepIds) {
  let tempData = data;
  const stepId = newGuid();
  if (needsAutoStart(tempData, fromStepId)) {
    const startStep = createStartStepEntry();
    tempData = tempData.concat([startStep]);
    fromStepId = startStep.id;
  }
  const checkpointStep = {
    type: "step-created",
    id: stepId,
    stepType: "checkpoint",
    location: location || { x: maxLocationX(tempData) + 300, y: 0 },
    label: title,
    configuration: { type: "checkpoint-configuration", title, text, attribution: attribution(userId) }
  };
  tempData = tempData.concat([checkpointStep]);
  tempData = connectIncoming(tempData, stepId, fromStepId, joints, dataFromStepIds);
  return { data: tempData, stepId };
}
function addTableStep(data, table, label, userId, fromStepId, location, joints) {
  let tempData = data;
  const stepId = newGuid();
  if (needsAutoStart(tempData, fromStepId)) {
    const startStep = createStartStepEntry();
    tempData = tempData.concat([startStep]);
    fromStepId = startStep.id;
  }
  const tableStep = {
    type: "step-created",
    id: stepId,
    stepType: "table",
    location: location || { x: maxLocationX(tempData) + 300, y: 0 },
    label: label || "",
    configuration: {
      type: "table-step-configuration",
      targetVariableName: table.targetVariableName,
      columns: table.columns,
      rows: table.rows,
      attribution: attribution(userId)
    }
  };
  tempData = tempData.concat([tableStep]);
  tempData = connectIncoming(tempData, stepId, fromStepId, joints);
  return { data: tempData, stepId };
}
function addSplitStep(data, label, userId, fromStepId, location, joints) {
  let tempData = data;
  const stepId = newGuid();
  if (needsAutoStart(tempData, fromStepId)) {
    const startStep = createStartStepEntry();
    tempData = tempData.concat([startStep]);
    fromStepId = startStep.id;
  }
  tempData = tempData.concat([{
    type: "step-created",
    id: stepId,
    stepType: "split",
    location: location || { x: maxLocationX(tempData) + 300, y: 0 },
    label: label || "",
    configuration: null
  }]);
  tempData = connectIncoming(tempData, stepId, fromStepId, joints);
  return { data: tempData, stepId };
}
export {
  addAnnotation,
  addAssertionStep,
  addAssignmentStep,
  addCheckpointStep,
  addComponentStep,
  addDatabaseCommandStep,
  addDecisionStep,
  addEmailStep,
  addEndStep,
  addModule,
  addOutputVariables,
  addRestCallStep,
  addScriptStep,
  addSplitStep,
  addStartStep,
  addTableStep,
  addUserStep,
  addUserTaskStep,
  beginDeterministicIds,
  collectUsedVariableNames,
  connectIncoming,
  createDateInputControl,
  createListSelectionControl,
  createMultiListSelectionControl,
  createNumericInputControl,
  createTextInputControl,
  createTimeInputControl,
  disambiguateVariableName,
  endDeterministicIds,
  newGuid
};
