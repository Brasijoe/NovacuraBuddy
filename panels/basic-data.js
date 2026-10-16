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
