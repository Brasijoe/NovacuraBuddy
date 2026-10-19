/** Instance → permission sets → Deploy, shared by the Quick Reports tab and the editor page.
 *  `getReport()` returns the report to deploy, or null when it can't be deployed yet (unsaved
 *  edits). Never writes history — the background does that after a finished deploy. */
function renderDeployForm(container, getReport, { send, onDeployed, onError }) {
  container.innerHTML = "";
  container.classList.add("deploy-form");

  const select = document.createElement("select");
  const sets = document.createElement("div");
  sets.className = "checklist";
  const actions = document.createElement("div");
  actions.className = "deploy-actions";
  const deployBtn = document.createElement("button");
  deployBtn.className = "btn-primary";
  deployBtn.textContent = "Deploy";
  deployBtn.disabled = true;
  actions.appendChild(deployBtn);
  container.append(select, sets, actions);

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

  select.onchange = async () => {
    sets.textContent = "";
    deployBtn.disabled = true;
    if (!select.value) return;
    sets.textContent = "Loading permission sets…";
    const response = await send({ type: "QR_PERMISSION_SETS", baseUrl: select.value, masterPassword: "" });
    sets.textContent = "";
    if (!response.ok) return onError(explain(response));
    const remembered = new Set(response.remembered);
    if (!response.sets.length) sets.textContent = "No customer permission sets on this instance — the report deploys without grants.";
    for (const ps of response.sets) {
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = ps.id;
      box.checked = remembered.has(ps.id);
      label.append(box, document.createTextNode(` ${ps.name}`));
      sets.appendChild(label);
    }
    deployBtn.disabled = false;
  };

  function explain(response) {
    return response.needsMasterPassword
      ? "Saved credentials are locked — unlock them in the NovacuraBuddy side panel, then try again."
      : response.error;
  }

  async function deploy(forceQuickReportId) {
    const report = getReport();
    if (!report) return onError("Save your changes before deploying — Deploy sends the saved version.");
    const baseUrl = select.value;
    const origin = new URL(baseUrl).origin;
    // Must run inside the click's user gesture, before any other await.
    const granted = await new Promise((resolve) => chrome.permissions.request({ origins: [origin + "/*"] }, resolve));
    if (!granted) return onError(`Permission for ${origin} was not granted — can't deploy there.`);
    const permissionSetIds = [...sets.querySelectorAll("input:checked")].map((b) => b.value);
    deployBtn.disabled = true;
    deployBtn.textContent = "Deploying…";
    const response = await send({ type: "QR_DEPLOY", baseUrl, report, permissionSetIds, forceQuickReportId, masterPassword: "" });
    deployBtn.disabled = false;
    deployBtn.textContent = "Deploy";
    if (!response.ok) return onError(explain(response));
    if (response.outcome.status === "needsConfirmation") return askOverwrite(response.outcome);
    onDeployed({ baseUrl, ...response.outcome });
  }

  function askOverwrite({ existingQuickReportId, existingDescription }) {
    const box = document.createElement("div");
    box.className = "banner banner-warning";
    const text = document.createElement("span");
    text.textContent = `A Quick Report named "${existingDescription}" already exists on this instance (id ${existingQuickReportId}). Overwrite it?`;
    const yes = document.createElement("button");
    yes.className = "btn-primary";
    yes.textContent = "Overwrite";
    yes.onclick = () => { box.remove(); deploy(existingQuickReportId); };
    const no = document.createElement("button");
    no.className = "btn-ghost";
    no.textContent = "Cancel";
    no.onclick = () => box.remove();
    box.append(text, yes, no);
    container.appendChild(box);
  }

  deployBtn.onclick = () => deploy();
}
