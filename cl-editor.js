// Full-page Custom LU editor. Modes (URL ?mode=): new | library | existing | import.
// All GitHub/IFS work happens in the background worker (CL_* messages).
const params = new URLSearchParams(location.search);
const mode = ["new", "library", "existing", "import"].includes(params.get("mode")) ? params.get("mode") : "new";

const els = {
  title: document.getElementById("editorTitle"),
  modeHint: document.getElementById("modeHint"),
  importRow: document.getElementById("importRow"),
  importFile: document.getElementById("importFile"),
  blocks: document.getElementById("luBlocks"),
  save: document.getElementById("saveBtn"),
  saved: document.getElementById("savedNote"),
  saveHint: document.getElementById("saveHint"),
  deployForm: document.getElementById("deployForm")
};

const TYPE_OPTIONS = CustomLuModel.TYPES.map((t) => [t, CustomLuModel.TYPE_LABELS[t]]);
const EXISTING_NOTE = "Deleting or changing attributes must be done in IFS.";

/** Editor state: one block per LU. Locked attributes exist already (IFS or library) and are shown read-only. */
let blocks = [];
let savedLu = null; // set once "new" mode saved the LU to the library; the form stays as is

function newAttribute() {
  return { name: "", prompt: "", type: "STRING", length: CustomLuModel.DEFAULT_LENGTH, locked: false };
}

function block(lu, { nameLocked = false, attributesLocked = false, checked = true, source = null } = {}) {
  return {
    name: lu.name || "",
    prompt: lu.prompt || "",
    nameLocked,
    checked,
    source,
    attributes: (lu.attributes || []).map((a) => ({
      name: a.name, prompt: a.prompt || "", type: a.type,
      length: a.length === undefined ? CustomLuModel.DEFAULT_LENGTH : a.length,
      locked: attributesLocked
    }))
  };
}

/** The definition deploy/save sends: in Existing mode only the new rows (deploy skips what IFS has). */
function definitionOf(b) {
  const attributes = b.attributes.filter((a) => (mode === "existing" ? !a.locked : true));
  return CustomLuModel.normalizeLu({ name: b.name, prompt: b.prompt, attributes });
}

/** The model's validation plus editor-only checks: a blank String length (the model would default it to 100)
 *  and, in Existing mode, a new row named like an attribute the LU already has. */
function problemsOf(b) {
  const problems = CustomLuModel.validateLu(definitionOf(b));
  const lockedNames = new Set(b.attributes.filter((a) => a.locked).map((a) => String(a.name).toUpperCase()));
  b.attributes.forEach((a, i) => {
    if (a.locked) return;
    const name = String(a.name || "").trim();
    const label = name || "Row " + (i + 1);
    if (a.type === "STRING" && String(a.length === undefined || a.length === null ? "" : a.length).trim() === "") {
      problems.push({ index: i, field: "length", message: label + ": length can't be empty." });
    }
    if (mode === "existing" && name && lockedNames.has(name.toUpperCase())) {
      problems.push({ index: i, field: "name", message: name.toUpperCase() + ": already exists on this LU." });
    }
  });
  return problems;
}
const activeBlocks = () => blocks.filter((b) => (mode === "import" ? b.checked : true));

function input(value, { type = "text", placeholder = "", disabled = false, onInput }) {
  const el = document.createElement("input");
  el.type = type;
  el.value = value === undefined || value === null ? "" : String(value);
  el.placeholder = placeholder;
  el.disabled = disabled;
  if (onInput) el.oninput = () => { onInput(el.value); refreshProblems(); };
  return el;
}

function typeSelect(attr, disabled, onPick) {
  const select = document.createElement("select");
  select.disabled = disabled;
  const known = TYPE_OPTIONS.some(([v]) => v === attr.type);
  for (const [value, label] of known ? TYPE_OPTIONS : [[attr.type, attr.type], ...TYPE_OPTIONS]) select.append(new Option(label, value));
  select.value = attr.type;
  select.onchange = () => onPick(select.value);
  return select;
}

function renderBlock(b, index) {
  const wrap = document.createElement("div");
  wrap.className = "lu-block";

  const head = document.createElement("div");
  head.className = "lu-head";
  if (mode === "import") {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = b.checked;
    box.title = "Deploy this LU";
    box.onchange = () => { b.checked = box.checked; refreshProblems(); };
    head.appendChild(box);
  }
  head.append(
    input(b.name, { placeholder: "LU name, e.g. CustomPageName", disabled: b.nameLocked, onInput: (v) => { b.name = v; } }),
    input(b.prompt, { placeholder: "Prompt (defaults to the name)", disabled: b.nameLocked, onInput: (v) => { b.prompt = v; } })
  );
  if (b.source && b.source !== b.name) head.appendChild(document.createTextNode(` from property ${b.source}`));
  wrap.appendChild(head);

  if (b.attributes.some((a) => a.locked)) {
    const note = document.createElement("p");
    note.className = "lu-note";
    note.textContent = mode === "library" ? "Library LUs are saved once and not changed." : EXISTING_NOTE;
    wrap.appendChild(note);
  }

  const table = document.createElement("table");
  table.className = "attr-table";
  table.innerHTML = "<thead><tr><th>Attribute</th><th>Prompt</th><th>Type</th><th>Length</th><th></th></tr></thead>";
  const tbody = document.createElement("tbody");
  b.attributes.forEach((a, i) => {
    const tr = document.createElement("tr");
    if (a.locked) tr.className = "is-locked";
    const length = input(a.type === "STRING" ? a.length : "", { type: "number", disabled: a.locked || a.type !== "STRING", onInput: (v) => { a.length = v; } });
    const cells = [
      input(a.name, { placeholder: "NAME", disabled: a.locked, onInput: (v) => { a.name = v; } }),
      input(a.prompt, { placeholder: "Prompt", disabled: a.locked, onInput: (v) => { a.prompt = v; } }),
      typeSelect(a, a.locked, (v) => {
        a.type = v;
        if (v === "STRING" && (a.length === "" || a.length === undefined)) a.length = CustomLuModel.DEFAULT_LENGTH;
        render();
      }),
      length
    ];
    const remove = document.createElement("button");
    remove.className = "btn-ghost";
    remove.textContent = "Remove";
    remove.hidden = a.locked;
    remove.onclick = () => { b.attributes.splice(i, 1); render(); };
    cells.push(remove);
    for (const c of cells) { const td = document.createElement("td"); td.appendChild(c); tr.appendChild(td); }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);

  if (mode !== "library") {
    const add = document.createElement("button");
    add.textContent = "Add attribute";
    add.onclick = () => { b.attributes.push(newAttribute()); render(); };
    wrap.appendChild(add);
  }

  const problems = document.createElement("ul");
  problems.className = "lu-problems";
  problems.dataset.block = String(index);
  wrap.appendChild(problems);
  return wrap;
}

function refreshProblems() {
  blocks.forEach((b, index) => {
    const ul = els.blocks.querySelector(`.lu-problems[data-block="${index}"]`);
    if (!ul) return;
    ul.innerHTML = "";
    if (mode === "import" && !b.checked) return;
    for (const p of problemsOf(b)) {
      const li = document.createElement("li");
      li.textContent = p.message;
      ul.appendChild(li);
    }
  });
  els.save.disabled = mode !== "new" || !!savedLu || !blocks.length || problemsOf(blocks[0]).length > 0;
}

function render() {
  els.blocks.innerHTML = "";
  blocks.forEach((b, i) => els.blocks.appendChild(renderBlock(b, i)));
  refreshProblems();
}

/** What the deploy form sends; null (with the reason shown) while something is invalid. */
function lusToDeploy() {
  const chosen = activeBlocks();
  if (!chosen.length) { showError(mode === "import" ? "Tick at least one LU to deploy." : "Nothing to deploy yet.", true); return null; }
  const broken = chosen.filter((b) => problemsOf(b).length);
  if (broken.length) { showError(`Fix the marked fields first (${broken.map((b) => b.name || "unnamed LU").join(", ")}).`, true); return null; }
  return chosen.map(definitionOf);
}

async function save() {
  els.save.disabled = true;
  els.save.textContent = "Saving…";
  const response = await send({ type: "CL_CREATE", lu: definitionOf(blocks[0]), masterPassword: "" });
  els.save.textContent = "Save to library";
  if (!response.ok) { refreshProblems(); return showError(explainLocked(response), true); }
  savedLu = response.lu;
  els.save.hidden = true;
  els.saved.textContent = `Saved "${response.lu.name}" to your library (side panel: Custom LUs). The form stays open — Deploy sends it to an IFS instance.`;
  els.saved.hidden = false;
  showNotice(`Saved "${response.lu.name}" to your library.`);
  chrome.runtime.sendMessage({ type: "CL_LIBRARY_CHANGED" }).catch(() => {});
  refreshProblems();
}

/** Save is offered only when the GitHub library can be reached (repo, token and login set in Basic Data). */
async function offerSave() {
  const response = await send({ type: "CL_LIBRARY", masterPassword: "" });
  if (response.ok) { els.save.hidden = false; return; }
  els.saveHint.textContent = `Saving to the library isn't possible yet: ${explainLocked(response)} (GitHub settings are in Basic Data.) Deploy still works.`;
  els.saveHint.hidden = false;
}

async function loadLibrary(id) {
  const response = await send({ type: "CL_LIBRARY", masterPassword: "" });
  if (!response.ok) return showError(explainLocked(response), true);
  const lu = response.lus.find((x) => x.id === id);
  if (!lu) return showError(`Library LU "${id}" was not found — it may belong to another GitHub user.`, true);
  blocks = [block(lu, { nameLocked: true, attributesLocked: true })];
  els.title.textContent = `Library LU: ${lu.name}`;
  render();
}

async function loadExisting(baseUrl, name) {
  els.modeHint.textContent = "Loading the LU from IFS…";
  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    els.modeHint.textContent = "";
    return showError("This link has no valid IFS instance address — open the LU again from the side panel.", true);
  }
  const has = await new Promise((resolve) => chrome.permissions.contains({ origins: [origin + "/*"] }, resolve));
  if (!has) { els.modeHint.textContent = ""; return showError(`No permission for ${origin} yet — open the LU from the side panel's instance list once.`, true); }
  const response = await send({ type: "CL_ENV_GET", baseUrl, name, masterPassword: "" });
  if (!response.ok) { els.modeHint.textContent = ""; return showError(explainLocked(response), true); }
  blocks = [block(response.lu, { nameLocked: true, attributesLocked: true })];
  blocks[0].attributes.push(newAttribute());
  els.title.textContent = `Add attributes: ${response.lu.name}`;
  els.modeHint.textContent = `On ${origin}. ${EXISTING_NOTE}`;
  render();
}

function importFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      blocks = FlowProperties.parseConnectProperties(String(reader.result)).map((lu) => block(lu, { source: lu.source }));
      els.modeHint.textContent = `${blocks.length} Table propert${blocks.length === 1 ? "y" : "ies"} from ${file.name}. Imported LUs are not saved to the library.`;
      render();
    } catch (err) {
      blocks = [];
      render();
      showError(err.message, true);
    }
  };
  reader.onerror = () => showError(`Could not read ${file.name}.`, true);
  reader.readAsText(file);
}

function start() {
  renderClDeployForm(els.deployForm, lusToDeploy, { send, onError: (message) => showError(message, true), moduleFromPanelOnly: true, offerFlowPropertiesModule: mode === "import" });
  if (mode === "new") {
    els.title.textContent = "New Custom LU";
    els.save.onclick = save;
    offerSave();
    blocks = [block({ name: "", attributes: [newAttribute()] })];
    els.modeHint.textContent = "Save (when GitHub is set up) stores it once in your GitHub library; Deploy sends it to an IFS instance.";
    render();
  } else if (mode === "library") {
    loadLibrary(params.get("id") || "");
  } else if (mode === "existing") {
    loadExisting(params.get("baseUrl") || "", params.get("lu") || "");
  } else {
    els.title.textContent = "Import Flow properties";
    els.importRow.hidden = false;
    els.importFile.onchange = () => { if (els.importFile.files[0]) importFile(els.importFile.files[0]); };
    render();
  }
}

start();
