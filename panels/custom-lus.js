let clLoadedOnce = false;
let clOpenForm = null; // the one expanded deploy form in the library list: { close() }

function openClEditor(query) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`cl-editor.html?${query}`) });
}

function clHint(id, text) {
  const el = document.getElementById(id);
  el.textContent = text || "";
  el.hidden = !text;
}

function buildClLibraryRow(lu) {
  const li = document.createElement("li");
  li.className = "qr-item";
  const head = document.createElement("div");
  head.className = "qr-head";
  const name = document.createElement("span");
  name.className = "qr-name";
  name.textContent = lu.name;
  const count = document.createElement("span");
  count.className = "list-count";
  count.textContent = `${lu.attributes.length} attribute(s)`;
  const deployBtn = document.createElement("button");
  deployBtn.textContent = "Deploy";
  const openBtn = document.createElement("button");
  openBtn.className = "btn-ghost";
  openBtn.textContent = "Open";
  openBtn.onclick = () => openClEditor(`mode=library&id=${encodeURIComponent(lu.id)}`);
  head.append(name, count, deployBtn, openBtn);

  const form = document.createElement("div");
  form.hidden = true;
  const panel = {
    close() { form.hidden = true; deployBtn.textContent = "Deploy"; if (clOpenForm === panel) clOpenForm = null; }
  };
  deployBtn.onclick = () => {
    if (!form.hidden) return panel.close();
    if (clOpenForm) clOpenForm.close();
    form.hidden = false;
    deployBtn.textContent = "Close";
    clOpenForm = panel;
    renderClDeployForm(form, () => [lu], { send, onClose: () => panel.close(), onError: (message) => showError(message, true) });
  };
  li.append(head, form);
  return li;
}

let clLibraryLus = [];

function renderClLibrary() {
  const list = document.getElementById("clLibraryList");
  const needle = document.getElementById("clLibrarySearch").value.trim().toLowerCase();
  list.innerHTML = "";
  clOpenForm = null;
  const shown = clLibraryLus.filter((lu) => lu.name.toLowerCase().includes(needle));
  clHint("clLibraryHint", !clLibraryLus.length ? "No saved LUs yet — New LU creates one." : shown.length ? "" : "No LUs match.");
  for (const lu of shown) list.appendChild(buildClLibraryRow(lu));
}

async function refreshClLibrary() {
  const list = document.getElementById("clLibraryList");
  clHint("clLibraryHint", "Loading…");
  const response = await send({ type: "CL_LIBRARY", masterPassword: "" });
  list.innerHTML = "";
  clOpenForm = null;
  clLibraryLus = [];
  if (!response.ok) return clHint("clLibraryHint", `${explainLocked(response)} (GitHub settings are in Basic Data.)`);
  clLibraryLus = response.lus;
  renderClLibrary();
}

async function createClModule(baseUrl, name, btn) {
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const designer = await send({ type: "GET_DESIGNER_STATUS" });
    const blocked = designer && designer.ok !== false ? designerBlockReason(designer) : "";
    if (blocked) return showError(blocked, true);
    btn.textContent = "Creating & activating…";
    const projection = CustomLuModel.projectionName(name);
    const response = await createAndActivateModule(baseUrl, projection);
    if (response) showNotice(`Module ${projection} created & activated in the open flow.`);
  } catch (err) {
    showError(err && err.message ? err.message : String(err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Module";
  }
}

function buildClEnvRow(baseUrl, lu) {
  const li = document.createElement("li");
  li.className = "qr-item";
  const head = document.createElement("div");
  head.className = "qr-head";
  const name = document.createElement("span");
  name.className = "qr-name";
  name.textContent = lu.name;
  const addBtn = document.createElement("button");
  addBtn.textContent = "Add attributes";
  addBtn.onclick = () => openClEditor(`mode=existing&baseUrl=${encodeURIComponent(baseUrl)}&lu=${encodeURIComponent(lu.name)}`);
  const moduleBtn = document.createElement("button");
  moduleBtn.textContent = "Module";
  moduleBtn.onclick = () => createClModule(baseUrl, lu.name, moduleBtn);
  head.append(name, addBtn, moduleBtn);
  li.appendChild(head);
  return li;
}

let clEnvToken = 0; // a slow answer for a previously chosen instance is ignored
async function refreshClEnvironment() {
  const select = document.getElementById("clInstanceSelect");
  const list = document.getElementById("clEnvList");
  const token = ++clEnvToken;
  list.innerHTML = "";
  if (!select.value) return clHint("clEnvHint", "");
  const baseUrl = select.value;
  const origin = new URL(baseUrl).origin;
  // The change event is the user gesture chrome.permissions.request needs; ask before any other await.
  const granted = await new Promise((resolve) => chrome.permissions.request({ origins: [origin + "/*"] }, resolve));
  if (token !== clEnvToken) return;
  if (!granted) return clHint("clEnvHint", `Permission for ${origin} was not granted — can't read its Custom LUs.`);
  clHint("clEnvHint", "Loading…");
  const response = await send({ type: "CL_ENV_LIST", baseUrl, masterPassword: "" });
  if (token !== clEnvToken) return;
  if (!response.ok) return clHint("clEnvHint", explainLocked(response));
  clHint("clEnvHint", response.lus.length ? "" : "No Custom LUs on this instance yet.");
  for (const lu of response.lus) list.appendChild(buildClEnvRow(baseUrl, lu));
}

async function fillClInstances() {
  const select = document.getElementById("clInstanceSelect");
  const previous = select.value;
  const response = await send({ type: "LIST_INSTANCES" });
  select.innerHTML = "";
  if (!response.ok) return clHint("clEnvHint", response.error);
  const instances = response.instances.slice().sort((a, b) => a.name.localeCompare(b.name));
  if (!instances.length) { select.hidden = true; return clHint("clEnvHint", "No IFS instances yet — add one in Basic Data."); }
  select.hidden = false;
  select.append(new Option("Choose an IFS instance…", ""));
  for (const instance of instances) select.append(new Option(instance.name, instance.baseUrl));
  if (instances.some((i) => i.baseUrl === previous)) select.value = previous;
}

function refreshCustomLus() {
  clLoadedOnce = true;
  refreshClLibrary();
  fillClInstances();
}

function initCustomLusPanel() {
  document.getElementById("clNewBtn").onclick = () => openClEditor("mode=new");
  document.getElementById("clImportBtn").onclick = () => openClEditor("mode=import");
  document.getElementById("clLibrarySearch").oninput = renderClLibrary;
  document.getElementById("clRefreshBtn").onclick = () => { refreshClLibrary(); refreshClEnvironment(); };
  document.getElementById("clInstanceSelect").onchange = refreshClEnvironment;
}
