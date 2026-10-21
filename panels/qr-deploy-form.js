/** Instance → permission sets (shared picker) → Deploy, shared by the Quick Reports tab and the editor page.
 *  `getReport()` returns the report to deploy, or null when it can't be deployed yet (unsaved
 *  edits). Never writes history — the background does that after a finished deploy. A finished
 *  deploy shows a green confirmation inside the form; `onDeployed` is optional. With `onClose`
 *  the form gets a Close button (side panel); the editor page keeps its form always open. */
function renderDeployForm(container, getReport, { send, onDeployed, onClose, onError }) {
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
  let confirmBox = null;
  function removeConfirmBox() {
    if (confirmBox) { confirmBox.remove(); confirmBox = null; }
  }
  let successBox = null;
  function removeSuccessBox() {
    if (successBox) { successBox.remove(); successBox = null; }
  }
  function showDeployed(report, baseUrl, quickReportId) {
    removeSuccessBox();
    successBox = document.createElement("div");
    successBox.className = "banner banner-deployed";
    successBox.setAttribute("role", "status");
    successBox.textContent = `✓ Deployed "${report.name}" to ${picker.instanceLabel(baseUrl)} — Quick Report id ${quickReportId}.`;
    container.appendChild(successBox);
  }

  const picker = renderPermissionPicker(container, {
    send,
    onError,
    emptySetsText: "No customer permission sets on this instance — the report deploys without grants.",
    onChange: (ready) => {
      removeConfirmBox();
      removeSuccessBox();
      deployBtn.disabled = !ready;
    }
  });
  container.append(actions);

  async function deploy(forceQuickReportId, baseUrlOverride) {
    const report = getReport();
    if (!report) return onError("Save your changes before deploying — Deploy sends the saved version.");
    const baseUrl = baseUrlOverride || picker.baseUrl();
    const origin = new URL(baseUrl).origin;
    // Must run inside the click's user gesture, before any other await.
    const granted = await new Promise((resolve) => chrome.permissions.request({ origins: [origin + "/*"] }, resolve));
    if (!granted) return onError(`Permission for ${origin} was not granted — can't deploy there.`);
    const permissionSetIds = picker.selectedIds();
    removeSuccessBox();
    deployBtn.disabled = true;
    deployBtn.textContent = "Deploying…";
    const response = await send({ type: "QR_DEPLOY", baseUrl, report, permissionSetIds, forceQuickReportId, masterPassword: "" });
    deployBtn.disabled = false;
    deployBtn.textContent = "Deploy";
    if (!response.ok) return onError(explainLocked(response));
    if (response.outcome.status === "needsConfirmation") return askOverwrite(response.outcome, baseUrl);
    showDeployed(report, baseUrl, response.outcome.quickReportId);
    if (onDeployed) onDeployed({ baseUrl, instanceName: picker.instanceLabel(baseUrl), ...response.outcome });
  }

  function askOverwrite({ existingQuickReportId, existingDescription }, baseUrl) {
    removeConfirmBox();
    const box = document.createElement("div");
    box.className = "banner banner-warning";
    const text = document.createElement("span");
    text.textContent = `A Quick Report named "${existingDescription}" already exists on this instance (id ${existingQuickReportId}). Overwrite it?`;
    const yes = document.createElement("button");
    yes.className = "btn-primary";
    yes.textContent = "Overwrite";
    yes.onclick = () => { removeConfirmBox(); deploy(existingQuickReportId, baseUrl); };
    const no = document.createElement("button");
    no.className = "btn-ghost";
    no.textContent = "Cancel";
    no.onclick = removeConfirmBox;
    box.append(text, yes, no);
    container.appendChild(box);
    confirmBox = box;
  }

  deployBtn.onclick = () => deploy();
}
