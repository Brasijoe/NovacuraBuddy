/** Instance → permission sets → Deploy for Custom LUs, used by the editor page and the side panel.
 *  Shows one result line per LU (green = deployed, red = the IFS error verbatim) with a Module
 *  button that creates the Flow module through the shared createAndActivateModule. */
function renderClDeployForm(container, getLus, { send, onError, onClose }) {
  container.innerHTML = "";
  container.classList.add("deploy-form");

  const actions = document.createElement("div");
  actions.className = "deploy-actions";
  const deployBtn = document.createElement("button");
  deployBtn.className = "btn-primary";
  deployBtn.textContent = "Deploy";
  deployBtn.disabled = true;
  actions.appendChild(deployBtn);
  if (onClose) {
    const closeBtn = document.createElement("button");
    closeBtn.className = "btn-ghost";
    closeBtn.textContent = "Close";
    closeBtn.onclick = onClose;
    actions.appendChild(closeBtn);
  }
  const results = document.createElement("ul");
  results.className = "cl-results";

  const picker = renderPermissionPicker(container, {
    send,
    onError,
    emptySetsText: "No customer permission sets on this instance — the LU deploys without grants.",
    onChange: (ready) => { deployBtn.disabled = !ready; results.innerHTML = ""; }
  });
  container.append(actions, results);

  function summary(outcome) {
    const parts = [];
    parts.push(outcome.createdLu ? "LU created" : "LU existed");
    parts.push(outcome.created.length ? `${outcome.created.length} attribute(s) added` : "no new attributes");
    if (outcome.published) parts.push("approved & published");
    if (outcome.granted.length) parts.push(`granted to ${outcome.granted.join(", ")}`);
    return parts.join(" · ");
  }

  async function createModule(baseUrl, name, btn) {
    const designer = await send({ type: "GET_DESIGNER_STATUS" });
    const blocked = designer && designer.ok !== false ? designerBlockReason(designer) : "";
    if (blocked) return onError(blocked);
    btn.disabled = true;
    btn.textContent = "Creating & activating…";
    const response = await createAndActivateModule(baseUrl, name);
    btn.disabled = false;
    btn.textContent = "Module";
    if (response) btn.insertAdjacentText("afterend", ` ✓ Module ${name} created & activated in the open flow.`);
  }

  function renderResults(list, baseUrl) {
    results.innerHTML = "";
    for (const r of list) {
      const li = document.createElement("li");
      if (r.ok) {
        li.className = "banner banner-deployed";
        li.setAttribute("role", "status");
        li.textContent = `✓ ${r.name} on ${picker.instanceLabel(baseUrl)} — ${summary(r.outcome)}.`;
        for (const m of r.outcome.mismatches) {
          const warn = document.createElement("div");
          warn.className = "cl-warning";
          warn.textContent = `⚠ ${m.message}`;
          li.appendChild(warn);
        }
        const moduleBtn = document.createElement("button");
        moduleBtn.textContent = "Module";
        moduleBtn.onclick = () => createModule(baseUrl, r.name, moduleBtn);
        li.appendChild(moduleBtn);
      } else {
        li.className = "banner banner-error";
        li.setAttribute("role", "alert");
        li.textContent = `✗ ${r.name} — ${r.error}`;
      }
      results.appendChild(li);
    }
  }

  deployBtn.onclick = async () => {
    const lus = getLus();
    if (!lus) return;
    const baseUrl = picker.baseUrl();
    const origin = new URL(baseUrl).origin;
    // Must run inside the click's user gesture, before any other await.
    const granted = await new Promise((resolve) => chrome.permissions.request({ origins: [origin + "/*"] }, resolve));
    if (!granted) return onError(`Permission for ${origin} was not granted — can't deploy there.`);
    results.innerHTML = "";
    deployBtn.disabled = true;
    deployBtn.textContent = "Deploying…";
    const response = await send({ type: "CL_DEPLOY", baseUrl, lus, permissionSetIds: picker.selectedIds(), masterPassword: "" });
    deployBtn.disabled = false;
    deployBtn.textContent = "Deploy";
    if (!response.ok) return onError(explainLocked(response));
    renderResults(response.results, baseUrl);
  };
}
