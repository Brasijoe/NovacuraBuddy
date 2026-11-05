import { childText, findChild, findChildren } from "./xmlLite.js";
import { decodeLanguageText, decodeLocalizedTextNode, stripPathPrefix } from "./classicDecisionDecoder.js";
import { translateControlField } from "./classicScriptTranslator.js";
function mapClassicEnum(value, table, fallback, fieldName, warnings) {
  if (value !== null && Object.prototype.hasOwnProperty.call(table, value)) {
    return table[value];
  }
  warnings.push(`Unknown ${fieldName} value '${value ?? "(none)"}' -- kept default '${fallback}'`);
  return fallback;
}
function decodeLayout(tagNode, controlCount) {
  const layoutNode = tagNode.localName === "Layout" ? tagNode : findChild(tagNode, "Layout");
  const rows = findChildren(layoutNode, "ArrayOfInt").map(
    (row) => findChildren(row, "int").map((n) => Number(n.text)).filter((i) => Number.isInteger(i) && i >= 0 && i < controlCount)
  ).filter((row) => row.length > 0);
  if (rows.length > 0) return rows;
  return Array.from({ length: controlCount }, (_, i) => [i]);
}
function decodeStepConfig(tagNode) {
  const boolField = (name) => childText(tagNode, name) === "true";
  const bgRaw = childText(tagNode, "BackgroundColorIndex");
  const bg = bgRaw === null ? 0 : Number(bgRaw);
  return {
    allowReloading: boolField("AllowReloading"),
    isPinned: boolField("IsPinned"),
    backgroundColorIndex: bg < 0 ? 0 : bg,
    preventUserBack: boolField("PreventUserBack"),
    allowAutoForward: boolField("AllowAutoForward"),
    autoForwardDelay: childText(tagNode, "AutoForwardDelay") || "Instant"
  };
}
const KEYBOARD_TABLE = { Text: "text" };
const FILE_MODE_TABLE = { Multiple: "multiple", None: "none", Single: "single" };
const IMAGE_SIZE_TABLE = { OriginalSize: "originalSize" };
const GRID_SIZE_MODE_TABLE = { Fit: "fitContent", Clip: "clip", Break: "break" };
const GRID_SIZE_TABLE = { Small: "small", Medium: "medium", Large: "large" };
const GRID_ROW_HEIGHT_TABLE = { Small: "small", Medium: "medium", Large: "large" };
const GRID_SELECTION_MODE_TABLE = {
  NoSelection: "noSelection",
  SingleSelection: "singleSelection",
  MultiSelection: "multiSelection",
  SingleAutoAcceptSelection: "singleAutoAcceptSelection"
};
function sourcePathOf(instr, name) {
  const src = findChild(instr, name);
  const path = src && childText(src, "Path");
  if (!path) return "";
  const idx = path.indexOf(":");
  return idx === -1 ? path : path.slice(idx + 1);
}
function loc(instr, name, flowDefaultLangCode, warnings, ctx) {
  return decodeLanguageText(instr, name, null, flowDefaultLangCode, warnings, ctx) || "";
}
const INSTRUCTION_MAPPERS = {
  InputText: (h) => ({
    kind: "text-input",
    targetVariableName: h.target(),
    label: h.prompt(),
    defaultText: h.field("DefaultText", "template"),
    multiline: h.bool("Multiline"),
    allowEmpty: h.allowEmpty(),
    forceUppercase: h.bool("ForceUppercase"),
    enableCorrection: h.bool("EnableSuggestions"),
    autoTrim: h.bool("AutoTrim"),
    passwordMask: h.bool("PasswordMask"),
    keyboardType: mapClassicEnum(childText(h.instr, "KeyboardType"), KEYBOARD_TABLE, "text", "KeyboardType", h.warnings),
    hideIfExpr: h.hideIf()
  }),
  NumericInput: (h) => simpleValueControl("numeric-input", h),
  InputDate: (h) => simpleValueControl("date-input", h),
  InputTime: (h) => simpleValueControl("time-input", h),
  ListSelection: (h) => ({
    kind: "list-selection",
    targetVariableName: h.target(),
    sourcePath: h.sourcePath("Source"),
    label: h.prompt(),
    largeRowText: h.loc("LargeText"),
    smallRowText: h.loc("SmallText"),
    allowEmpty: h.allowEmpty(),
    itemStyleExpr: h.field("ItemStyle", "template"),
    groupByMember: h.text("GroupFieldId"),
    defaultSelectionExpr: h.field("DefaultSelectionExpression", "template"),
    resultTransformationExpr: h.field("ResultTransformationExpression", "template"),
    hideIfExpr: h.hideIf()
  }),
  MultiListSelection: (h) => ({
    kind: "multi-list-selection",
    targetVariableName: h.target(),
    sourcePath: h.sourcePath("Source"),
    label: h.prompt(),
    largeRowText: h.loc("LargeText"),
    smallRowText: h.loc("SmallText"),
    itemStyleExpr: h.field("ItemStyle", "template"),
    groupByMember: h.text("GroupFieldId"),
    defaultSelectionExpression: h.field("DefaultSelectionExpression", "template"),
    hideIfExpr: h.hideIf()
  }),
  // SmallHeader / TextMessage: Classic carries only `Text` (+ optional ConditionToHideTemplate), so
  // the fixed Connect font/alignment defaults live in the emitter, not here. `Text` is passed
  // through UNTRANSLATED (h.loc only): whether Connect accepts a mixed literal+{expr} template
  // here is an open, unverified item (design spec section 5).
  SmallHeader: (h) => ({ kind: "header", text: h.loc("Text"), hideIfExpr: h.hideIf() }),
  TextMessage: (h) => ({ kind: "static-text", text: h.loc("Text"), hideIfExpr: h.hideIf() }),
  // RecordField: IFS-Buddy-only real value (not in our two fixtures); Label/Text untranslated too.
  RecordField: (h) => ({ kind: "labelled-static-text", label: h.loc("Label"), text: h.loc("Text"), useLargeFont: h.bool("UseLargeFont"), hideIfExpr: h.hideIf() }),
  // ListPresentation: read-only list, no Target. ItemStyle goes through the SAME h.field funnel as
  // ListSelection/MultiListSelection's itemStyleExpr so any finding is fixed in one place.
  // LargeText/SmallText/HyperlinkTemplate are plain localized text (h.loc, untranslated).
  ListPresentation: (h) => ({
    kind: "list-presentation",
    sourcePath: h.sourcePath("Source"),
    label: h.prompt(),
    largeText: h.loc("LargeText"),
    smallText: h.loc("SmallText"),
    hyperlinkTemplate: h.loc("HyperlinkTemplate"),
    itemStyleExpr: h.field("ItemStyle", "template"),
    groupByMember: h.text("GroupFieldId"),
    hideIfExpr: h.hideIf()
  }),
  // InputBoolean / YesNoQuestion / MenuSelection: IFS-Buddy-only evidence (none occurs in either
  // real fixture). DefaultValue is a template slot (h.field). YesNoQuestion's Option1Value/
  // Option2Value are Classic constants (e.g. BUILDROLE) read RAW via h.text -- NOT translated, and
  // left "" when absent (no invented "1"/"0"). Prompt/RowText/EmptyOptionText/Option*Text are
  // plain localized text (h.loc, untranslated, spec section 5).
  InputBoolean: (h) => ({ kind: "checkbox", targetVariableName: h.target(), label: h.prompt(), defaultValue: h.field("DefaultValue", "template"), mustBeChecked: h.bool("MustBeChecked"), hideIfExpr: h.hideIf() }),
  YesNoQuestion: (h) => ({
    kind: "binary-option",
    targetVariableName: h.target(),
    defaultValue: h.field("DefaultValue", "template"),
    refuseNegativeAnswer: h.bool("RefuseNegativeAnswer"),
    option1Text: h.loc("Option1Text"),
    option2Text: h.loc("Option2Text"),
    option1Value: h.text("Option1Value"),
    option2Value: h.text("Option2Value"),
    hideIfExpr: h.hideIf()
  }),
  MenuSelection: (h) => ({
    kind: "menu-selection",
    targetVariableName: h.target(),
    sourcePath: h.sourcePath("Source"),
    label: h.prompt(),
    defaultValue: h.field("DefaultValue", "template"),
    rowText: h.loc("RowText"),
    keyFieldId: h.text("KeyFieldId"),
    hasEmptyOption: h.bool("HasEmptyOption"),
    emptyOptionText: h.loc("EmptyOptionText"),
    allowEmptyOption: h.bool("AllowEmptyOption"),
    hideIfExpr: h.hideIf()
  }),
  // SignatureInput: IFS-Buddy-only evidence (not in our two fixtures). Has Target (the variable
  // to store the signature) and Prompt (the label). Like every other kind, supports
  // ConditionToHideTemplate for visibility.
  SignatureInput: (h) => ({ kind: "signature", targetVariableName: h.target(), label: h.prompt(), hideIfExpr: h.hideIf() }),
  // FileBox: IFS-Buddy-only evidence (not in our two fixtures). Has Target (the variable to store
  // files), Prompt (the label), Mode/ImageSize (enum-mapped, only warn if explicitly present but
  // unrecognized), Source (path prefix stripped like ListSelection/MenuSelection), AutoShow
  // (boolean), and AllowedUploadFileSuffixes (dropped with a warning, no confirmed Connect shape).
  // Like every other kind, supports ConditionToHideTemplate.
  FileBox: (h) => {
    const suffixes = h.text("AllowedUploadFileSuffixes");
    if (suffixes) {
      h.warnings.push(`FileBox AllowedUploadFileSuffixes "${suffixes}" not migrated (no confirmed Connect shape) -- restrict upload types manually if still needed`);
    }
    const modeRaw = childText(h.instr, "Mode");
    const mode = modeRaw === null ? "none" : mapClassicEnum(modeRaw, FILE_MODE_TABLE, "none", "FileBox Mode", h.warnings);
    const imageSizeRaw = childText(h.instr, "ImageSize");
    const imageSize = imageSizeRaw === null ? "originalSize" : mapClassicEnum(imageSizeRaw, IMAGE_SIZE_TABLE, "originalSize", "ImageSize", h.warnings);
    return {
      kind: "file-gallery",
      targetVariableName: h.target(),
      sourcePath: h.sourcePath("Source"),
      label: h.prompt(),
      showAutomatically: h.bool("AutoShow"),
      mode,
      imageSize,
      hideIfExpr: h.hideIf()
    };
  },
  // VerbSubTaskItem ("subworkflow tile" -> Connect's single-item control, G11, spec §6.1.5).
  // Real evidence, both local archives: Target, localized Title, VersionIdentifier (the GUID
  // that must resolve against the SAME flow's own SubworkflowItem.SubworkflowIdentifier set --
  // confirmed byte-for-byte matching in real data), VariableMappings/__Mappings/
  // SerializableVariableMapping entries. THE FIRST mapper entry able to itself produce the
  // "unmapped" shape (matching IFS-Buddy's own real behavior: their mapper returns null on a
  // dangling VersionIdentifier, falling through to their generic unmapped TODO) rather than
  // always its own named kind -- reuses the exact same `{ kind: "unmapped", classicKind,
  // description }` shape every other unrecognized/absent kind already falls back to
  // (decodeOneInstruction's own generic fallback below), never a second dispatch mechanism.
  // ConditionToHideTemplate is IFS-Buddy-only evidence for THIS specific kind (not in either real
  // fixture, which contains no VerbSubTaskItem at all) but decoded via the exact same h.hideIf()
  // funnel every other kind uses regardless -- costs nothing when genuinely absent (degrades to
  // ""), and never silently drops a real field if Classic does carry one here, matching the
  // existing "every kind supports it identically" convention (see SignatureInput/FileBox).
  // Pills/DesignerLocalizedString badges and the dangling-reference/non-identity-mapping-warning
  // paths are IFS-Buddy-only evidence tier (not exercised by either real local archive, whose two
  // real instances both resolve cleanly with identity mappings, per spec §6.1.5's evidence-tier
  // note).
  VerbSubTaskItem: (h) => {
    const title = h.loc("Title");
    const versionId = childText(h.instr, "VersionIdentifier") || "";
    const subworkflowIds = h.ctx && h.ctx.subworkflowIds;
    if (!subworkflowIds || !subworkflowIds.has(versionId)) {
      return {
        kind: "unmapped",
        classicKind: "VerbSubTaskItem",
        description: `subworkflow tile "${title}" references subworkflow ${versionId || "?"}, which is not declared in this flow -- the single-item control would carry a dangling subworkflowId; rebuild it manually`
      };
    }
    const mappingsContainer = findChild(findChild(h.instr, "VariableMappings"), "__Mappings");
    findChildren(mappingsContainer, "SerializableVariableMapping").forEach((m) => {
      const mapping = (childText(m, "Mapping") || "").trim();
      const variableName = childText(m, "VariableName") || "";
      if (mapping && mapping !== `{${variableName}}`) {
        h.warnings.push(`subworkflow tile maps "${variableName}" from expression ${JSON.stringify(mapping)} -- Connect's single-item control has no parameter mapping; make the subworkflow read the value it needs directly`);
      }
    });
    const pills = findChild(h.instr, "Pills");
    const badges = findChildren(pills, "DesignerLocalizedString").map((dls) => ({ value: h.locNode(dls) }));
    return {
      kind: "single-item",
      targetVariableName: h.target(),
      subworkflowId: versionId,
      label: title,
      iconString: h.text("IconString"),
      badges,
      allowMultipleInvokes: h.bool("AllowMultipleInvokes"),
      hideIfExpr: h.hideIf()
    };
  },
  // Grid2 -> Connect's real `grid` user-step control. Confirmed real (2026-09-21, live-captured
  // `configuration-changed` event for a Grid built directly in Designer, plus a real customer
  // archive's own Grid2 instructions, 220 real occurrences): Target->targetVariableName,
  // Prompt->label, SourceOrNull->sourcePath (same Path-prefix-stripping convention as
  // ListSelection/MenuSelection/FileBox's own Source), AllowAdd/AllowDelete/UseChangeTracking
  // (same names both sides), ItemStyle->rowStyleExpr (a real, CONFIRMED rename -- not "itemStyle"
  // as every other control's own field is named), RowHeight/SelectionMode (enum-mapped, see the
  // GRID_*_TABLE doc comments), ReloadStrategy has no confirmed Connect field on the control
  // itself (the live capture's own top-level control JSON has no reload-related field at all --
  // Connect's "Reloading behavior" doc mention may live at the per-column level only, matching
  // the one real capture) so it's not migrated here, matching this project's "don't guess a field
  // that isn't there" rule.
  Grid2: (h) => {
    const columnNodes = findChildren(findChild(h.instr, "Columns"), "Column");
    const columns = columnNodes.map((col) => decodeGridColumn(col, h));
    const rowHeightRaw = childText(h.instr, "RowHeight");
    const selectionModeRaw = childText(h.instr, "SelectionMode");
    return {
      kind: "grid",
      targetVariableName: h.target(),
      label: h.prompt(),
      sourcePath: h.sourcePath("SourceOrNull"),
      allowAdd: h.bool("AllowAdd"),
      allowDelete: h.bool("AllowDelete"),
      useChangeTracking: h.bool("UseChangeTracking"),
      // Real bug fix (2026-09-22): a value-producing field (the row's own style/color text), same
      // class as a grid column's sourceExpr/itemTextExpr/itemValueExpr/valueExpr (see
      // decodeGridColumn's own doc comment) -- mode "expression" silently never translated a
      // braced real value at all (translateOrRaw's raw-text fallback on every real braced
      // ItemStyle, e.g. "{case when Site = '101' then 'RED' else 'BLUE' end}"); "template" mode
      // both translates it for real and keeps the same braced shape.
      rowStyleExpr: h.field("ItemStyle", "template"),
      rowHeight: rowHeightRaw === null ? "medium" : mapClassicEnum(rowHeightRaw, GRID_ROW_HEIGHT_TABLE, "medium", "Grid RowHeight", h.warnings),
      selectionMode: selectionModeRaw === null ? "noSelection" : mapClassicEnum(selectionModeRaw, GRID_SELECTION_MODE_TABLE, "noSelection", "Grid SelectionMode", h.warnings),
      columns,
      hideIfExpr: h.hideIf()
    };
  }
};
const GRID_COLUMN_TYPE_TABLE = {
  TextColumnConfiguration: "text",
  NumericColumnConfiguration: "numeric",
  CheckboxColumnConfiguration: "checkbox",
  ValueListColumnConfiguration: "value-list",
  ComputedColumnConfiguration: "computed"
};
function decodeGridColumn(columnNode, h) {
  const warnings = h.warnings;
  const sourceColumn = stripPathPrefix(childText(findChild(columnNode, "SourceColumn"), "Path")) || "";
  const config = findChild(columnNode, "ConfigurationOrNull");
  const outputName = childText(columnNode, "OutputName") || "";
  const classicConfigType = config ? config.attrs["xsi:type"] || "" : "";
  const columnType = Object.prototype.hasOwnProperty.call(GRID_COLUMN_TYPE_TABLE, classicConfigType) ? GRID_COLUMN_TYPE_TABLE[classicConfigType] : "text";
  if (classicConfigType && !Object.prototype.hasOwnProperty.call(GRID_COLUMN_TYPE_TABLE, classicConfigType)) {
    warnings.push(`Grid column "${outputName}" has Classic column type '${classicConfigType}' -- no confirmed Connect column type exists for it, emitted as a text column, verify manually`);
  }
  const configBool = (name) => !!(config && childText(config, name) === "true");
  const configField = (name, mode) => translateControlField(config && childText(config, name) || "", mode, h.ctx);
  const titleNode = config ? findChild(config, "Title") : null;
  const sizeModeRaw = config ? childText(config, "SizeMode") : null;
  const sizeRaw = config ? childText(config, "Size") : null;
  const common = {
    outputName,
    includeInOutput: childText(columnNode, "IncludeInOutput") === "true",
    sourceColumn,
    title: titleNode ? h.locNode(titleNode) : "",
    sizeMode: sizeModeRaw === null ? "fitContent" : mapClassicEnum(sizeModeRaw, GRID_SIZE_MODE_TABLE, "fitContent", "Grid column SizeMode", warnings),
    size: sizeRaw === null ? "medium" : mapClassicEnum(sizeRaw, GRID_SIZE_TABLE, "medium", "Grid column Size", warnings)
  };
  if (columnType === "checkbox") {
    return { ...common, columnType, isEditable: configBool("IsEditable"), defaultValueExpr: configField("DefaultValue", "template"), onlyEditableForNewRows: configBool("EditableForNew") };
  }
  if (columnType === "value-list") {
    return {
      ...common,
      columnType,
      // Real bug fix (2026-09-22, sibling of translateControlField's own Condition-field fix):
      // these are VALUE-producing fields (a lookup source, a display/key expression), not boolean
      // conditions -- Classic's own real values keep the outer {} (confirmed real:
      // "{LocationTbl}"/"{LocationNo}"), same template-shape convention as an assignment/grid
      // DefaultValue field, not the "never wrap" convention a Condition/hideIf field needs. Mode
      // "expression" used to be wrong here in a way that never surfaced: a braced value always
      // threw inside translateExpression (no unwrap), so translateOrRaw silently fell back to the
      // untouched raw Classic text -- these fields were NEVER actually translated at all until
      // now, just echoed back exactly as Classic stored them.
      sourceExpr: configField("SourceExpression", "template"),
      itemTextExpr: configField("RowTextExpression", "template"),
      itemValueExpr: configField("KeyExpression", "template"),
      selectValueOnly: configBool("SelectKeyOnly"),
      onlyEditableForNewRows: configBool("EditableForNew"),
      matchWhenScanningBarcode: configBool("MatchWhenScanningBarcode")
    };
  }
  if (columnType === "computed") {
    return { ...common, columnType, valueExpr: configField("ValueExpression", "template"), hidden: configBool("Hidden"), matchWhenScanningBarcode: configBool("MatchWhenScanningBarcode") };
  }
  if (columnType === "numeric") {
    return {
      ...common,
      columnType,
      isEditable: configBool("IsEditable"),
      defaultValueExpr: configField("DefaultValue", "template"),
      onlyEditableForNewRows: configBool("EditableForNew"),
      formatString: "",
      hidden: configBool("Hidden"),
      matchWhenScanningBarcode: configBool("MatchWhenScanningBarcode")
    };
  }
  return {
    ...common,
    columnType: "text",
    isEditable: configBool("IsEditable"),
    defaultValueExpr: configField("DefaultValue", "template"),
    onlyEditableForNewRows: configBool("EditableForNew"),
    hidden: configBool("Hidden"),
    matchWhenScanningBarcode: configBool("MatchWhenScanningBarcode")
  };
}
function simpleValueControl(kind, h) {
  return { kind, targetVariableName: h.target(), label: h.prompt(), defaultValue: h.field("DefaultValue", "template"), allowEmpty: h.allowEmpty(), hideIfExpr: h.hideIf() };
}
function decodeOneInstruction(instr, kind, flowDefaultLangCode, warnings, ctx) {
  const field = (name, mode) => translateControlField(childText(instr, name) || "", mode, ctx);
  const h = {
    instr,
    warnings,
    ctx,
    target: () => childText(instr, "Target") || "",
    prompt: () => loc(instr, "Prompt", flowDefaultLangCode, warnings, ctx),
    field,
    hideIf: () => field("ConditionToHideTemplate", "expression"),
    allowEmpty: () => childText(instr, "AllowEmpty") === "true",
    bool: (name) => childText(instr, name) === "true",
    text: (name) => childText(instr, name) || "",
    loc: (name) => loc(instr, name, flowDefaultLangCode, warnings, ctx),
    locNode: (node) => decodeLocalizedTextNode(node, "Pills", null, flowDefaultLangCode, warnings, ctx) || "",
    sourcePath: (name) => sourcePathOf(instr, name)
  };
  if (Object.prototype.hasOwnProperty.call(INSTRUCTION_MAPPERS, kind)) {
    return INSTRUCTION_MAPPERS[kind](h);
  }
  const label = h.loc("Text") || h.prompt();
  return { kind: "unmapped", classicKind: kind, description: `Unmapped Classic instruction kind '${kind}'${label ? ` ("${label}")` : ""} -- not yet migrated (planned for a later phase), review manually` };
}
function decodeUserStep(tagNode, flowDefaultLangCode, warnings, ctx) {
  const instructions = findChildren(findChild(tagNode, "Instructions"), "InstructionBase");
  const controls = instructions.map((instr) => decodeOneInstruction(instr, instr.attrs["xsi:type"] || "", flowDefaultLangCode, warnings, ctx));
  return {
    controls,
    layout: decodeLayout(tagNode, controls.length),
    stepConfig: decodeStepConfig(tagNode)
  };
}
function decodeUserStepButton(exitTagNode, flowDefaultLangCode, warnings, ctx) {
  const conditionRaw = childText(exitTagNode, "Condition");
  return {
    label: loc(exitTagNode, "Text", flowDefaultLangCode, warnings, ctx),
    isPrimary: childText(exitTagNode, "IsDefault") === "true",
    isAlwaysEnabled: childText(exitTagNode, "IsAlwaysEnabled") === "true",
    availableIf: conditionRaw ? translateControlField(conditionRaw, "expression", ctx) : "",
    priority: Number(childText(exitTagNode, "Priority") ?? "0") || 0
  };
}
export {
  decodeLayout,
  decodeStepConfig,
  decodeUserStep,
  decodeUserStepButton,
  mapClassicEnum
};
