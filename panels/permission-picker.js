/** Instance select + permission-set checklist, shared by the Quick Report and Custom LU deploy
 *  forms. Instances come from Basic Data; ticks are pre-set from the per-instance memory. */
function renderPermissionPicker(container, { send, onError, emptySetsText, onChange }) {
  const select = document.createElement("select");
  const sets = document.createElement("div");
  sets.className = "checklist";
  container.append(select, sets);

  (async () => {
    const response = await send({ type: "LIST_INSTANCES" });
    if (!response.ok) return onError(response.error);
    const instances = response.instances.slice().sort((a, b) => a.name.localeCompare(b.name));
    if (!instances.length) {
      sets.textContent = "No IFS instances yet — add one in Basic Data.";
      select.hidden = true;
      return;
    }
    select.append(new Option("Choose an IFS instance…", ""));
    for (const instance of instances) select.append(new Option(instance.name, instance.baseUrl));
  })();

  let selectToken = 0; // bumped on every change so a slow response for a previous instance is ignored
  select.onchange = async () => {
    const token = ++selectToken;
    onChange(false);
    sets.textContent = "";
    if (!select.value) return;
    sets.textContent = "Loading permission sets…";
    const response = await send({ type: "PERMISSION_SETS", baseUrl: select.value, masterPassword: "" });
    if (token !== selectToken) return;
    sets.textContent = "";
    if (!response.ok) return onError(explainLocked(response));
    const remembered = new Set(response.remembered);
    if (!response.sets.length) sets.textContent = emptySetsText;
    for (const ps of response.sets) {
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = ps.id;
      box.checked = remembered.has(ps.id);
      label.append(box, document.createTextNode(` ${ps.name}`));
      sets.appendChild(label);
    }
    onChange(true);
  };

  // Loading the sets (and the user list of the Permission Check tab) fails while the saved
  // credentials are locked; after unlocking, load again for the instance that is picked.
  document.addEventListener("ifs-unlocked", () => { if (select.value) select.onchange(); });

  return {
    baseUrl: () => select.value,
    selectedIds: () => [...sets.querySelectorAll("input:checked")].map((b) => b.value),
    instanceLabel: (baseUrl) => {
      const option = [...select.options].find((o) => o.value === baseUrl);
      return option ? option.text : baseUrl;
    }
  };
}
