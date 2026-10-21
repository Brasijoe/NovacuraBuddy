/* API Modules tab: load an OpenAPI 3.x / Swagger 2.0 description (URL, current tab, file or
 * pasted text), pick operations, generate a Flowscript module and create it in the open flow's
 * package. Parsing and generation run here in the panel (apimodule/*); the background only
 * fetches (with a Basic Data instance's IFS token when the spec lives on one) and saves the
 * module through the open Designer tab, like "Create module" does. */

const API_STATE_KEY = "apiModulesState"; // { lastUrl, unticked: { [source]: id[] } }
const API_MAX_HOPS = 4; // docs page -> initializer script -> swagger-config -> spec

let apiSpec = null; // { model, source, specVersion, queryables: Set<id> }
let apiSelected = new Set();

const apiEl = (id) => document.getElementById(id);

async function apiReadState() {
  try {
    const { [API_STATE_KEY]: state } = await chrome.storage.local.get(API_STATE_KEY);
    return state || { lastUrl: "", unticked: {} };
  } catch (e) {
    return { lastUrl: "", unticked: {} };
  }
}

async function apiWriteState(change) {
  const state = await apiReadState();
  await chrome.storage.local.set({ [API_STATE_KEY]: { ...state, ...change, unticked: { ...state.unticked, ...(change.unticked || {}) } } });
}

function apiDefaultModuleName(title) {
  return ApiFlowTypes.toIdentifier(ApiSpecModel.pascal(title || "Api") || "Api");
}

/** Asks for the origin's host permission. Must be the first await of a click handler: Chrome
 *  only shows the prompt while the user gesture is still alive. */
async function apiRequestOrigin(url) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch (e) {
    return true; // fetchSpec reports the bad URL
  }
  try {
    return await chrome.permissions.request({ origins: [origin + "/*"] });
  } catch (e) {
    return false;
  }
}

async function apiHasOrigin(url) {
  try {
    return await chrome.permissions.contains({ origins: [new URL(url).origin + "/*"] });
  } catch (e) {
    return false;
  }
}

/** Fetches `url` and follows docs pages / initializer scripts / swagger-config until the spec. */
async function apiLoadFromUrl(url) {
  let current = url;
  for (let hop = 0; hop < API_MAX_HOPS; hop++) {
    if (hop > 0 && !(await apiHasOrigin(current))) {
      apiEl("apiUrl").value = current;
      showError(`The API description is at ${current}. Click Load once more to allow access to that site.`, true);
      return;
    }
    const response = await actionOrShowError({ type: "API_FETCH_SPEC", url: current, masterPassword: masterPasswordOf() });
    if (!response) return;
    let step;
    try {
      step = ApiSpecLoad.resolveFetched(response.result, jsyaml);
    } catch (e) {
      showError(e.message, true);
      return;
    }
    if (step.doc) {
      apiEl("apiUrl").value = response.result.url;
      await apiWriteState({ lastUrl: response.result.url });
      const via = response.result.instanceName ? ` (via ${response.result.instanceName})` : "";
      return apiShowSpec(step.doc, response.result.url, via);
    }
    current = step.next;
  }
  showError("Gave up following links to the API description. Open the raw openapi.json / swagger.json and try again.", true);
}

function apiLoadFromText(text, source) {
  try {
    return apiShowSpec(ApiSpecLoad.parseSpecText(text, jsyaml), source, "");
  } catch (e) {
    showError(e.message, true);
  }
}

async function apiShowSpec(doc, source, via) {
  let version;
  let model;
  try {
    version = ApiSpecLoad.detectSpecVersion(doc);
    model = ApiSpecModel.buildModel(version.kind === "swagger2" ? ApiSwagger2ToOas3.convertSwagger2(doc) : doc);
  } catch (e) {
    showError(e.message, true);
    return;
  }
  if (!model.operations.length) {
    showError("The API description has no operations (paths).", true);
    return;
  }
  clearError(true);
  const specVersion = `${version.kind === "swagger2" ? "Swagger" : "OpenAPI"} ${version.version}`;
  apiSpec = { model, source, specVersion, queryables: new Set(ApiFlowEmit.queryableIds(model)) };
  const { unticked = {} } = await apiReadState();
  const off = new Set(unticked[source] || []);
  apiSelected = new Set(model.operations.map((o) => o.id).filter((id) => !off.has(id)));

  apiEl("apiTitle").textContent = `${model.title} ${model.version}`.trim();
  apiEl("apiMeta").textContent = `${specVersion} · ${model.operations.length} operations · base path /${model.basePath}${via}`;
  apiEl("apiModuleName").value = apiDefaultModuleName(model.title);
  apiEl("apiPreview").hidden = true;
  apiRenderWarnings(model.warnings);
  apiRenderOperations();
  apiEl("apiEmpty").hidden = true;
  apiEl("apiLoaded").hidden = false;
}

function apiRenderWarnings(warnings) {
  const box = apiEl("apiWarnings");
  box.hidden = !warnings.length;
  box.querySelector("summary").textContent = `Warnings (${warnings.length})`;
  const list = box.querySelector("ul");
  list.innerHTML = "";
  for (const w of warnings) {
    const li = document.createElement("li");
    li.textContent = w;
    list.appendChild(li);
  }
}

function apiRenderOperations() {
  const container = apiEl("apiOperations");
  container.innerHTML = "";
  const { model, queryables } = apiSpec;
  for (const tag of model.tags) {
    const ops = model.operations.filter((o) => o.tag === tag);
    if (!ops.length) continue;
    const group = document.createElement("details");
    group.className = "api-tag";
    group.open = true;
    const summary = document.createElement("summary");
    const tagBox = document.createElement("input");
    tagBox.type = "checkbox";
    tagBox.addEventListener("click", (e) => e.stopPropagation());
    tagBox.addEventListener("change", () => {
      for (const o of ops) tagBox.checked ? apiSelected.add(o.id) : apiSelected.delete(o.id);
      apiSelectionChanged();
    });
    const tagName = document.createElement("span");
    tagName.className = "api-tag-name";
    tagName.textContent = tag;
    const tagCount = document.createElement("span");
    tagCount.className = "list-count";
    summary.append(tagBox, tagName, tagCount);
    group.appendChild(summary);

    const list = document.createElement("ul");
    list.className = "api-op-list";
    for (const op of ops) {
      const li = document.createElement("li");
      const label = document.createElement("label");
      label.className = "api-op";
      label.title = [op.summary, op.description].filter(Boolean).join("\n\n");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.dataset.opId = op.id;
      box.addEventListener("change", () => {
        box.checked ? apiSelected.add(op.id) : apiSelected.delete(op.id);
        apiSelectionChanged();
      });
      const method = document.createElement("span");
      method.className = `api-method api-method-${op.method}`;
      method.textContent = op.method.toUpperCase();
      const text = document.createElement("span");
      text.className = "api-op-text";
      const pathEl = document.createElement("span");
      pathEl.className = "api-op-path";
      pathEl.textContent = op.path;
      const idEl = document.createElement("span");
      idEl.className = "api-op-id";
      idEl.textContent = op.id + (op.deprecated ? " (deprecated)" : "");
      text.append(pathEl, idEl);
      label.append(box, method, text);
      if (queryables.has(op.id)) {
        const chip = document.createElement("span");
        chip.className = "status status-created";
        chip.textContent = "Queryable";
        chip.title = "Also generated as a data source: select … from it where …";
        label.appendChild(chip);
      }
      li.appendChild(label);
      list.appendChild(li);
    }
    group.appendChild(list);
    group.dataset.tag = tag;
    container.appendChild(group);
  }
  apiSelectionChanged(true);
}

/** Syncs every checkbox (op, tag, select-all) and the counter with `apiSelected`. */
function apiSelectionChanged(skipSave) {
  const { model } = apiSpec;
  for (const box of apiEl("apiOperations").querySelectorAll("input[data-op-id]")) box.checked = apiSelected.has(box.dataset.opId);
  for (const group of apiEl("apiOperations").querySelectorAll("details.api-tag")) {
    const ids = model.operations.filter((o) => o.tag === group.dataset.tag).map((o) => o.id);
    const on = ids.filter((id) => apiSelected.has(id)).length;
    const box = group.querySelector("summary input");
    box.checked = on === ids.length;
    box.indeterminate = on > 0 && on < ids.length;
    group.querySelector("summary .list-count").textContent = `${on}/${ids.length}`;
  }
  const all = apiEl("apiSelectAll");
  all.checked = apiSelected.size === model.operations.length;
  all.indeterminate = apiSelected.size > 0 && apiSelected.size < model.operations.length;
  apiEl("apiSelectedCount").textContent = `${apiSelected.size} of ${model.operations.length} selected`;
  apiEl("apiPreviewBtn").disabled = apiSelected.size === 0;
  apiApplyCreateState();
  if (!skipSave) {
    const unticked = model.operations.map((o) => o.id).filter((id) => !apiSelected.has(id));
    apiWriteState({ unticked: { [apiSpec.source]: unticked } }).catch(() => {});
  }
}

// The Designer tab Create acts on, from GET_DESIGNER_STATUS; refreshed by the side panel's poll.
let apiDesigner = { open: false, hasFlowToken: false };
let apiCreating = false;

/** Create is enabled only with operations ticked and a known Connect session (the active Designer
 *  tab plus a Flow token); otherwise the hint under the buttons says why. Re-run on every poll, so
 *  switching to the Designer tab enables it without reloading the panel. */
function apiApplyCreateState() {
  const btn = apiEl("apiCreateBtn");
  const hint = apiEl("apiCreateHint");
  if (apiCreating) return;
  const reason = apiSelected.size === 0 ? "Tick at least one operation." : designerBlockReason(apiDesigner);
  btn.disabled = !!reason;
  btn.title = reason || "Save the module in the open flow's package and activate it in that flow";
  hint.textContent = reason;
  hint.hidden = !reason;
}

/** Called from the side panel's 5s poll and when the panel opens. */
async function refreshApiDesignerState() {
  const response = await send({ type: "GET_DESIGNER_STATUS" });
  if (!response.ok) return;
  apiDesigner = { open: response.open, hasFlowToken: response.hasFlowToken };
  apiApplyCreateState();
}

function apiGenerate() {
  const moduleName = apiEl("apiModuleName").value.trim();
  if (!ApiFlowTypes.isIdentifier(moduleName)) {
    showError(`"${moduleName}" is not a valid module name: letters, digits and _ only, not starting with a digit.`, true);
    return null;
  }
  return ApiFlowEmit.generateModule(apiSpec.model, {
    moduleName,
    selectedIds: [...apiSelected],
    source: apiSpec.source,
    specVersion: apiSpec.specVersion,
    generatorVersion: chrome.runtime.getManifest().version,
    comments: apiEl("apiComments").value
  });
}

function apiPreview() {
  const result = apiGenerate();
  if (!result) return;
  clearError(true);
  apiEl("apiPreviewText").value = result.code;
  apiEl("apiPreview").hidden = false;
  apiRenderWarnings([...apiSpec.model.warnings, ...result.warnings.filter((w) => !apiSpec.model.warnings.includes(w))]);
}

async function apiCreate() {
  const result = apiGenerate();
  if (!result) return;
  const designer = await sendOrShowError({ type: "GET_DESIGNER_STATUS" }, true);
  if (!designer) return;
  const blocked = designerBlockReason(designer);
  if (blocked) {
    showError(blocked, true);
    return;
  }
  const statuses = await actionOrShowError({ type: "GET_MODULE_STATUSES", projectionNames: [result.moduleName] });
  if (!statuses) return;
  const existing = statuses.statuses[result.moduleName];
  if (existing && existing.status !== "not_created" && existing.status !== "no_designer"
    && !confirm(`A module named ${result.moduleName} already exists in this package. Replace its code with the generated module?`)) {
    return;
  }
  const response = await actionOrShowError({ type: "API_CREATE_MODULE", moduleName: result.moduleName, code: result.code });
  if (!response) return;
  showNotice(`Module ${result.moduleName} saved (${result.functionCount} functions, ${result.queryableCount} data sources) and activated in this flow.`);
}

function initApiModulesPanel() {
  apiReadState().then((state) => {
    if (state.lastUrl && !apiEl("apiUrl").value) apiEl("apiUrl").value = state.lastUrl;
    if (state.comments) apiEl("apiComments").value = state.comments;
  });
  apiEl("apiComments").addEventListener("change", () => apiWriteState({ comments: apiEl("apiComments").value }).catch(() => {}));

  apiEl("apiLoadUrlBtn").addEventListener("click", async () => {
    const url = apiEl("apiUrl").value.trim();
    if (!url) return;
    const btn = apiEl("apiLoadUrlBtn");
    await apiRequestOrigin(url); // first: needs the click's user gesture
    btn.disabled = true;
    try { await apiLoadFromUrl(url); } finally { btn.disabled = false; }
  });
  apiEl("apiUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") apiEl("apiLoadUrlBtn").click(); });

  apiEl("apiCurrentTabBtn").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const url = tab && tab.url;
    if (!url || !/^https:\/\//i.test(url)) {
      showError("The current tab has no https:// address to load an API description from.", true);
      return;
    }
    if (/^https:\/\/build\.novacura\.com\//i.test(url)) {
      showError("The current tab is the Flow Designer. Switch to the tab with the API documentation first.", true);
      return;
    }
    apiEl("apiUrl").value = url;
    await apiRequestOrigin(url);
    await apiLoadFromUrl(url);
  });

  apiEl("apiUploadBtn").addEventListener("click", () => apiEl("apiFile").click());
  apiEl("apiFile").addEventListener("change", async () => {
    const file = apiEl("apiFile").files[0];
    apiEl("apiFile").value = "";
    if (file) apiLoadFromText(await file.text(), `uploaded: ${file.name}`);
  });

  apiEl("apiPasteBtn").addEventListener("click", () => {
    apiEl("apiPasteBox").hidden = !apiEl("apiPasteBox").hidden;
    if (!apiEl("apiPasteBox").hidden) apiEl("apiPasteText").focus();
  });
  apiEl("apiPasteLoadBtn").addEventListener("click", () => {
    const text = apiEl("apiPasteText").value;
    if (!text.trim()) return;
    apiLoadFromText(text, "pasted text");
    apiEl("apiPasteBox").hidden = true;
  });

  apiEl("apiSelectAll").addEventListener("change", () => {
    if (!apiSpec) return;
    apiSelected = apiEl("apiSelectAll").checked ? new Set(apiSpec.model.operations.map((o) => o.id)) : new Set();
    apiSelectionChanged();
  });

  apiEl("apiPreviewBtn").addEventListener("click", apiPreview);
  apiEl("apiCopyBtn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(apiEl("apiPreviewText").value);
      showNotice("Module code copied.");
    } catch (e) {
      apiEl("apiPreviewText").select();
    }
  });
  // Not runAction: that leaves re-enabling to the tracker's re-render, which never touches this button.
  apiEl("apiCreateBtn").addEventListener("click", async () => {
    const btn = apiEl("apiCreateBtn");
    apiCreating = true;
    btn.disabled = true;
    btn.textContent = "Creating…";
    try {
      await apiCreate();
    } finally {
      apiCreating = false;
      btn.textContent = "Create module";
      await refreshApiDesignerState();
    }
  });
  // The background re-reads the active tab on these same events, so ask it a moment later.
  let tabTimer = null;
  const soon = () => { clearTimeout(tabTimer); tabTimer = setTimeout(refreshApiDesignerState, 300); };
  chrome.tabs.onActivated.addListener(soon);
  chrome.tabs.onUpdated.addListener(soon);
  chrome.windows.onFocusChanged.addListener(soon);
  refreshApiDesignerState();
}
