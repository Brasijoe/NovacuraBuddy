async function refreshInstances() {
  const response = await sendOrShowError({ type: "LIST_INSTANCES" });
  if (!response) return;
  currentInstances = response.instances;
  if (!currentBaseUrl && currentInstances.length) currentBaseUrl = currentInstances[0].baseUrl;

  const list = document.getElementById("instanceList");
  list.innerHTML = "";
  for (const instance of currentInstances) {
    const li = document.createElement("li");
    li.className = instance.baseUrl === currentBaseUrl ? "is-selected" : "";
    li.title = "Select this instance";

    const name = document.createElement("span");
    name.className = "instance-name";
    name.textContent = `${instance.name} (${instance.baseUrl})`;
    li.appendChild(name);

    const testBtn = document.createElement("button");
    testBtn.textContent = "Test";
    testBtn.className = "btn-ghost";
    testBtn.title = "Request a fresh IFS token with the saved credentials";
    testBtn.onclick = (e) => {
      e.stopPropagation();
      runAction(testBtn, "Testing…", async () => {
        const response = await actionOrShowError({ type: "TEST_INSTANCE", baseUrl: instance.baseUrl, masterPassword: masterPasswordOf() });
        if (response) showNotice(`Connection OK — ${instance.name} accepted the saved credentials.`);
      });
    };
    li.appendChild(testBtn);

    const renameBtn = document.createElement("button");
    renameBtn.textContent = "Rename";
    renameBtn.className = "btn-ghost";
    renameBtn.title = "Rename this instance";
    renameBtn.onclick = (e) => {
      e.stopPropagation();
      const input = document.createElement("input");
      input.className = "rename-input";
      input.value = instance.name;
      input.onclick = (ev) => ev.stopPropagation();
      name.replaceWith(input);
      input.focus();
      input.select();

      let done = false;
      const finish = async (commit) => {
        if (done) return;
        done = true;
        const val = input.value.trim();
        if (commit && val && val !== instance.name) {
          await actionOrShowError({ type: "RENAME_INSTANCE", baseUrl: instance.baseUrl, name: val });
        }
        refreshInstances();
      };
      input.onkeydown = (ev) => {
        if (ev.key === "Enter") finish(true);
        else if (ev.key === "Escape") finish(false);
      };
      input.onblur = () => finish(true);
    };
    li.appendChild(renameBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.className = "btn-ghost";
    deleteBtn.onclick = async (e) => {
      e.stopPropagation();
      await actionOrShowError({ type: "DELETE_INSTANCE", baseUrl: instance.baseUrl });
      if (currentBaseUrl === instance.baseUrl) currentBaseUrl = null;
      refreshInstances();
    };
    li.appendChild(deleteBtn);

    li.onclick = () => {
      currentBaseUrl = instance.baseUrl;
      resetProjectionList();
      updateCurrentInstanceLabel();
      refreshInstances();
      refreshProjections();
    };
    list.appendChild(li);
  }
  updateCurrentInstanceLabel();
}

document.getElementById("instanceForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const baseUrl = document.getElementById("instanceBaseUrl").value;

  // chrome.permissions.request() only works from inside a real user gesture — this submit handler
  // is one, the background service worker's onMessage handler is not.
  let origin;
  try {
    origin = new URL(baseUrl).origin + "/*";
  } catch (err) {
    showError(`"${baseUrl}" isn't a valid URL.`);
    return;
  }
  const granted = await new Promise((resolve) => chrome.permissions.request({ origins: [origin] }, resolve));
  if (!granted) {
    showError(`Permission for ${origin} was not granted — tracking for this instance won't work until it is.`);
    return;
  }

  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = "Checking connection…";
  const response = await actionOrShowError({
    type: "SAVE_INSTANCE",
    baseUrl,
    masterPassword: document.getElementById("masterPassword").value,
    fields: {
      name: document.getElementById("instanceName").value.trim(),
      authMethod: "client_credentials",
      tokenEndpoint: document.getElementById("instanceTokenEndpoint").value.trim(),
      clientId: document.getElementById("instanceClientId").value.trim(),
      secretPayload: { clientSecret: document.getElementById("instanceClientSecret").value.trim() }
    }
  });
  submitBtn.disabled = false;
  submitBtn.textContent = "Add instance";
  if (!response) return;
  showNotice("Connection OK — IFS accepted the credentials. Instance saved.");
  e.target.reset();
  refreshInstances();
});

function prefillInstanceForm({ baseUrl, name }) {
  document.getElementById("instanceBaseUrl").value = baseUrl;
  document.getElementById("instanceName").value = name;
  document.getElementById("instanceTokenEndpoint").focus();
}

async function refreshGithubStatus() {
  const response = await send({ type: "QR_GET_SETTINGS" });
  if (!response.ok) return;
  const repoField = document.getElementById("githubRepo");
  if (!repoField.value) repoField.value = response.repo;
  document.getElementById("githubStatus").textContent = response.hasToken
    ? `Connected as ${response.login} → ${response.repo}`
    : "No GitHub token saved yet — Quick Reports need one.";
  document.getElementById("githubMoveBtn").hidden = !response.hasToken;
}

document.getElementById("githubForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = "Checking GitHub…";
  const response = await actionOrShowError({
    type: "QR_SAVE_SETTINGS",
    repo: document.getElementById("githubRepo").value,
    token: document.getElementById("githubToken").value,
    masterPassword: document.getElementById("githubMasterPassword").value || masterPasswordOf()
  });
  submitBtn.disabled = false;
  submitBtn.textContent = "Save GitHub settings";
  if (!response) return;
  document.getElementById("githubToken").value = "";
  document.getElementById("githubMasterPassword").value = "";
  showNotice(`GitHub OK — saved as ${response.login} for ${response.repo}.`);
  if (typeof qrLoadedOnce !== "undefined") qrLoadedOnce = false; // Quick Reports tab reloads on next open
  refreshGithubStatus();
  refreshLockStatus();
});

// Two clicks instead of a confirm() dialog: the move rewrites files in the shared repo.
document.getElementById("githubMoveBtn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  if (!btn.dataset.armed) {
    btn.dataset.armed = "1";
    btn.textContent = "Click again to move them now";
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = "Move unowned reports into my folder"; }, 5000);
    return;
  }
  delete btn.dataset.armed;
  btn.disabled = true;
  btn.textContent = "Moving…";
  const response = await actionOrShowError({ type: "QR_MOVE_UNOWNED", masterPassword: masterPasswordOf() });
  btn.disabled = false;
  btn.textContent = "Move unowned reports into my folder";
  if (!response) return;
  const skipped = response.skipped.length ? ` Skipped (already in your folder or incomplete): ${response.skipped.join(", ")}.` : "";
  showNotice(`Moved ${response.moved.length} report(s) into your folder.${skipped}`);
  if (typeof qrLoadedOnce !== "undefined") qrLoadedOnce = false;
});
