/** Instance → permission sets → Deploy for Custom LUs, used by the editor page and the side panel.
 *  Shows one result line per LU (green = deployed, red = the IFS error verbatim) with a Module
 *  button that creates the Flow module through the shared createAndActivateModule. */
function renderClDeployForm(container, getLus, { send, onError, onClose, moduleFromPanelOnly }) {
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
  let deploying = false;
  const results = document.createElement("ul");
  results.className = "cl-results";

  const picker = renderPermissionPicker(container, {
    send,
    onError,
    emptySetsText: "No customer permission sets on this instance — the LU deploys without grants.",
    onChange: (ready) => { deployBtn.disabled = deploying || !ready; results.innerHTML = ""; }
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
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const designer = await send({ type: "GET_DESIGNER_STATUS" });
      const blocked = designer && designer.ok !== false ? designerBlockReason(designer) : "";
      if (blocked) return onError(blocked);
      btn.textContent = "Creating & activating…";
      const response = await createAndActivateModule(baseUrl, name);
      if (response) btn.insertAdjacentText("afterend", ` ✓ Module ${name} created & activated in the open flow.`);
    } catch (err) {
      onError(err && err.message ? err.message : String(err));
    } finally {
      btn.disabled = false;
      btn.textContent = "Module";
    }
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
        if (moduleFromPanelOnly) {
          const hint = document.createElement("div");
          hint.className = "lu-note";
          hint.textContent = "Create the Flow module from the side panel's Custom LUs list — it needs the Flow Designer tab active.";
          li.appendChild(hint);
        } else {
          const moduleBtn = document.createElement("button");
          moduleBtn.textContent = "Module";
          moduleBtn.onclick = () => createModule(baseUrl, r.name, moduleBtn);
          li.appendChild(moduleBtn);
        }
      } else {
        li.className = "banner banner-error";
        li.setAttribute("role", "alert");
        li.textContent = `✗ ${r.name} — ${r.error}`;
      }
      results.appendChild(li);
    }
  }

  /** One "waiting / current step" line per LU while the background deploys them in order. */
  function renderProgress(lus) {
    results.innerHTML = "";
    const lines = lus.map((lu) => {
      const li = document.createElement("li");
      li.className = "banner";
      li.setAttribute("role", "status");
      li.textContent = `${String(lu.name || "").trim()} — waiting…`;
      results.appendChild(li);
      return li;
    });
    // Earlier LUs may have succeeded or failed; the final result lines replace all of this.
    return (p) => {
      lines.slice(0, p.index).forEach((li, i) => { li.textContent = `${String(lus[i].name || "").trim()} — finished.`; });
      const li = lines[p.index];
      if (li) li.textContent = `⏳ ${p.name} (${p.index + 1}/${p.total}) — ${p.step}…`;
    };
  }

  deployBtn.onclick = async () => {
    const lus = getLus();
    if (!lus) return;
    clearError(true);
    const baseUrl = picker.baseUrl();
    const origin = new URL(baseUrl).origin;
    // Must run inside the click's user gesture, before any other await.
    const granted = await new Promise((resolve) => chrome.permissions.request({ origins: [origin + "/*"] }, resolve));
    if (!granted) return onError(`Permission for ${origin} was not granted — can't deploy there.`);
    const showProgress = renderProgress(lus);
    const deployId = crypto.randomUUID();
    const onProgress = (message) => {
      if (message && message.type === "CL_DEPLOY_PROGRESS" && message.deployId === deployId) showProgress(message);
    };
    chrome.runtime.onMessage.addListener(onProgress);
    deploying = true;
    deployBtn.disabled = true;
    deployBtn.textContent = "Deploying…";
    let response;
    try {
      response = await send({ type: "CL_DEPLOY", baseUrl, lus, permissionSetIds: picker.selectedIds(), masterPassword: "", deployId });
    } finally {
      chrome.runtime.onMessage.removeListener(onProgress);
      deploying = false;
      deployBtn.disabled = false;
      deployBtn.textContent = "Deploy";
    }
    if (!response.ok) {
      results.innerHTML = "";
      return onError(explainLocked(response));
    }
    renderResults(response.results, baseUrl);
  };
}
