/* ============================================================
   Novacura Flow — Create Asset Integration
   ============================================================ */
(function () {
  const FLOW_BASE = "https://build.novacura.com";
  const ASSET_COLOR = "#0A68FF";
  const FLOW_X_ORIGIN = "HubWebApp";
  const LAST_ORG_PACKAGE_KEY = "lastFlowOrgPackage";

  async function getLastOrgPackage() {
    const data = await chrome.storage.local.get(LAST_ORG_PACKAGE_KEY);
    return data[LAST_ORG_PACKAGE_KEY] || null;
  }

  function saveLastOrgPackage(orgId, packageId, connectorId) {
    chrome.storage.local.set({ [LAST_ORG_PACKAGE_KEY]: { orgId, packageId, connectorId } }).catch(() => {});
  }

  let modalOverlay = null;
  let modalBody = null;
  let modalFooter = null;

  function ensureModalRoot() {
    if (modalOverlay) return;

    modalOverlay = document.createElement("div");
    modalOverlay.className = "modal-overlay";
    modalOverlay.style.display = "none";

    const panel = document.createElement("div");
    panel.className = "modal-panel";

    const header = document.createElement("div");
    header.className = "modal-header";
    const h2 = document.createElement("h2");
    h2.textContent = "Create Asset in Novacura Flow";
    const closeBtn = document.createElement("button");
    closeBtn.className = "modal-close";
    closeBtn.title = "Close";
    closeBtn.innerHTML = "&times;";
    closeBtn.onclick = closeModal;
    header.append(h2, closeBtn);

    modalBody = document.createElement("div");
    modalBody.className = "modal-body";

    modalFooter = document.createElement("div");
    modalFooter.className = "modal-footer";

    panel.append(header, modalBody, modalFooter);
    modalOverlay.appendChild(panel);
    document.body.appendChild(modalOverlay);
  }

  function closeModal() {
    if (modalOverlay) modalOverlay.style.display = "none";
  }

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function fieldGroup(labelText, inputEl) {
    const group = document.createElement("div");
    group.className = "field-group";
    const label = document.createElement("label");
    label.textContent = labelText;
    group.append(label, inputEl);
    return group;
  }

  function createSearchableSelect() {
    const container = document.createElement("div");
    container.className = "searchable-select";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "searchable-select-input";
    input.autocomplete = "off";

    const list = document.createElement("div");
    list.className = "searchable-select-list";
    list.style.display = "none";

    container.append(input, list);

    let options = []; // [{ id, name }]
    let value = null;
    let changeHandler = null;
    let filtered = [];
    let highlightIndex = -1;

    function nameOf(id) {
      const opt = options.find((o) => o.id === id);
      return opt ? opt.name : "";
    }

    function setHighlight(index) {
      highlightIndex = index;
      Array.from(list.children).forEach((child, i) => {
        child.classList.toggle("is-highlighted", i === highlightIndex);
      });
    }

    function render(filterText) {
      clearChildren(list);
      const q = (filterText || "").trim().toLowerCase();
      filtered = q ? options.filter((o) => o.name.toLowerCase().includes(q)) : options.slice();

      if (filtered.length === 0) {
        const empty = document.createElement("div");
        empty.className = "searchable-select-empty";
        empty.textContent = "No matches";
        list.appendChild(empty);
        highlightIndex = -1;
        return;
      }

      filtered.forEach((o) => {
        const item = document.createElement("div");
        item.className = "searchable-select-option";
        item.textContent = o.name;
        item.onmousedown = (e) => {
          e.preventDefault(); // avoid blurring the input before the click registers
          pick(o);
        };
        list.appendChild(item);
      });
      setHighlight(0);
    }

    function pick(o) {
      value = o.id;
      input.value = o.name;
      closeList();
      if (changeHandler) changeHandler(value);
    }

    function openList() {
      if (input.disabled) return;
      list.style.display = "block";
      render(input.value);
    }

    function closeList() {
      list.style.display = "none";
    }

    input.addEventListener("focus", openList);
    input.addEventListener("input", openList);

    input.addEventListener("keydown", (e) => {
      if (list.style.display === "none") {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); openList(); }
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight(Math.min(highlightIndex + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight(Math.max(highlightIndex - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (filtered[highlightIndex]) pick(filtered[highlightIndex]);
      } else if (e.key === "Escape") {
        closeList();
        input.value = nameOf(value);
      }
    });

    input.addEventListener("blur", () => {
      closeList();
      const typed = input.value.trim();
      if (typed === nameOf(value)) return;
      const match = options.find((o) => o.name.toLowerCase() === typed.toLowerCase());
      if (match) pick(match);
      else input.value = nameOf(value);
    });

    return {
      container,
      setOptions(newOptions) {
        options = (newOptions || []).slice();
      },
      setValue(id) {
        value = id || null;
        input.value = nameOf(value);
      },
      clear() {
        value = null;
        input.value = "";
      },
      getValue() {
        return value;
      },
      setDisabled(disabled) {
        input.disabled = disabled;
        container.classList.toggle("is-disabled", disabled);
        if (disabled) closeList();
      },
      setPlaceholder(text) {
        input.placeholder = text || "";
      },
      onChange(fn) {
        changeHandler = fn;
      }
    };
  }

  function getFlowAuthToken() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "GET_FLOW_TOKEN" }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response && response.ok) {
          resolve(response.token);
        } else {
          reject(new Error((response && response.error) || "Could not get a Novacura Flow session token."));
        }
      });
    });
  }

  async function flowFetch(path, options) {
    options = options || {};
    const token = await getFlowAuthToken();
    const headers = Object.assign({}, options.headers, { Authorization: `Bearer ${token}`, "X-Origin": FLOW_X_ORIGIN });
    const res = await fetch(FLOW_BASE + path, Object.assign({}, options, { headers }));
    if (res.status === 401) {
      chrome.runtime.sendMessage({ type: "CLEAR_FLOW_TOKEN" });
    }
    return res;
  }

  function renderError(container, message, opts) {
    opts = opts || {};
    clearChildren(container);
    const box = document.createElement("div");
    box.className = "modal-error";
    const msg = document.createElement("span");
    msg.textContent = message;
    box.appendChild(msg);
    const actions = opts.actions || (opts.actionLabel && opts.onAction
      ? [{ label: opts.actionLabel, onClick: opts.onAction }]
      : []);
    actions.forEach((action) => {
      const btn = document.createElement("button");
      btn.className = "btn-tool";
      btn.textContent = action.label;
      btn.onclick = action.onClick;
      box.appendChild(btn);
    });
    container.appendChild(box);
  }

  function populatePackages(orgId, pkgCombo, state, errorContainer, updateCreateEnabled, preselectPackageId) {
    pkgCombo.setDisabled(true);
    pkgCombo.clear();
    pkgCombo.setOptions([]);
    pkgCombo.setPlaceholder("Loading packages…");
    state.packageId = null;
    updateCreateEnabled();

    flowFetch(`/admin/application/api/v2/organisations/${orgId}/packages`)
      .then((res) => {
        if (!res.ok) throw new Error(`Packages request failed (${res.status})`);
        return res.json();
      })
      .then((packages) => {
        if (orgId !== state.orgId) return; // stale response for a since-abandoned org selection
        clearChildren(errorContainer);
        const sorted = (packages || []).slice().sort((a, b) => a.name.localeCompare(b.name));
        pkgCombo.setOptions(sorted.map((p) => ({ id: p.id, name: p.name })));
        pkgCombo.setPlaceholder("Select a package…");
        pkgCombo.setDisabled(false);

        if (preselectPackageId && sorted.some((p) => p.id === preselectPackageId)) {
          pkgCombo.setValue(preselectPackageId);
          state.packageId = preselectPackageId;
          updateCreateEnabled();
        }
      })
      .catch((err) => {
        if (orgId !== state.orgId) return; // stale error for a since-abandoned org selection
        renderError(errorContainer, `Could not load packages: ${err.message}`, {
          actionLabel: "Retry",
          onAction: () => populatePackages(orgId, pkgCombo, state, errorContainer, updateCreateEnabled, preselectPackageId)
        });
      });
  }

  function loadConnectors(orgId, connectorCombo, state, errorContainer, updateCreateEnabled, preselectConnectorId) {
    connectorCombo.setDisabled(true);
    connectorCombo.clear();
    connectorCombo.setOptions([]);
    connectorCombo.setPlaceholder("Loading connectors…");
    state.connectorId = null;
    state.connector = null;

    flowFetch(`/admin/admin-connector/api/organisation/${orgId}/connectors`)
      .then((res) => {
        if (!res.ok) throw new Error(`Connectors request failed (${res.status})`);
        return res.json();
      })
      .then((connectors) => {
        if (orgId !== state.orgId) return; // stale response for a since-abandoned org selection
        clearChildren(errorContainer);
        const sorted = (connectors || []).slice().sort((a, b) => a.name.localeCompare(b.name));
        state.connectorsById = new Map(sorted.map((c) => [c.id, c]));
        connectorCombo.setOptions(sorted.map((c) => ({
          id: c.id,
          name: c.typeDisplayName ? `${c.name} (${c.typeDisplayName})` : c.name
        })));
        connectorCombo.setPlaceholder("Select a connector…");
        connectorCombo.setDisabled(false);

        if (preselectConnectorId && state.connectorsById.has(preselectConnectorId)) {
          connectorCombo.setValue(preselectConnectorId);
          const full = state.connectorsById.get(preselectConnectorId);
          state.connectorId = full.id;
          state.connector = { id: full.id, name: full.name, type: full.type };
        }
      })
      .catch((err) => {
        if (orgId !== state.orgId) return; // stale error for a since-abandoned org selection
        renderError(errorContainer, `Could not load connectors: ${err.message}`, {
          actionLabel: "Retry",
          onAction: () => loadConnectors(orgId, connectorCombo, state, errorContainer, updateCreateEnabled, preselectConnectorId)
        });
      });
  }

  function loadOrganizations(orgCombo, pkgCombo, connectorCombo, state, errorContainer, updateCreateEnabled) {
    flowFetch("/admin/security/api/v3/user/whoAmI")
      .then((res) => {
        if (!res.ok) throw new Error(`Novacura Flow rejected the request (${res.status}). Try reloading the Flow tab and retry.`);
        return res.json();
      })
      .then(async (data) => {
        clearChildren(errorContainer);
        const orgs = data.organizations || [];

        if (orgs.length === 0) {
          orgCombo.setOptions([]);
          orgCombo.setPlaceholder("No organizations available");
          return;
        }

        orgCombo.setOptions(orgs.map((o) => ({ id: o.id, name: o.name })));
        orgCombo.setPlaceholder(orgs.length > 1 ? "Select an organization…" : "");
        orgCombo.setDisabled(false);

        const last = await getLastOrgPackage();
        const preselectOrgId = orgs.length === 1
          ? orgs[0].id
          : (last && last.orgId && orgs.some((o) => o.id === last.orgId) ? last.orgId : null);

        if (preselectOrgId) {
          orgCombo.setValue(preselectOrgId);
          state.orgId = preselectOrgId;
          const preselectPackageId = last && last.orgId === preselectOrgId ? last.packageId : null;
          const preselectConnectorId = last && last.orgId === preselectOrgId ? last.connectorId : null;
          populatePackages(state.orgId, pkgCombo, state, errorContainer, updateCreateEnabled, preselectPackageId);
          loadConnectors(state.orgId, connectorCombo, state, errorContainer, updateCreateEnabled, preselectConnectorId);
        }
        updateCreateEnabled();
      })
      .catch((err) => {
        renderError(errorContainer, err.message, {
          actions: [
            {
              label: "Open Flow",
              onClick: () => window.open(FLOW_BASE, "_blank", "noopener")
            },
            {
              label: "Retry",
              onClick: () => loadOrganizations(orgCombo, pkgCombo, connectorCombo, state, errorContainer, updateCreateEnabled)
            }
          ]
        });
      });
  }

  function showSuccess(asset, orgId) {
    clearChildren(modalBody);
    clearChildren(modalFooter);

    const wrap = document.createElement("div");
    wrap.className = "modal-success";
    const icon = document.createElement("div");
    icon.className = "success-icon";
    icon.innerHTML = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 17.01"/></svg>`;
    const msg = document.createElement("p");
    msg.textContent = `Asset "${asset.name}" was created.`;
    wrap.append(icon, msg);
    modalBody.appendChild(wrap);

    const openBtn = document.createElement("button");
    openBtn.className = "btn-primary";
    openBtn.textContent = "Open in Flow";
    openBtn.onclick = () => {
      window.open(`${FLOW_BASE}/admin/design/designer/organizations/${orgId}/items/${asset.id}`, "_blank", "noopener");
    };

    const closeBtn = document.createElement("button");
    closeBtn.className = "btn-action";
    closeBtn.textContent = "Close";
    closeBtn.onclick = closeModal;

    modalFooter.append(closeBtn, openBtn);
  }

  function openCreateAssetModal(session) {
    ensureModalRoot();
    clearChildren(modalBody);
    clearChildren(modalFooter);
    modalOverlay.style.display = "flex";

    const state = { orgId: null, packageId: null, connectorId: null, connector: null, connectorsById: new Map() };

    const orgCombo = createSearchableSelect();
    orgCombo.setDisabled(true);
    orgCombo.setPlaceholder("Loading organizations…");

    const pkgCombo = createSearchableSelect();
    pkgCombo.setDisabled(true);
    pkgCombo.setPlaceholder("Select an organization first");

    const connectorCombo = createSearchableSelect();
    connectorCombo.setDisabled(true);
    connectorCombo.setPlaceholder("Select an organization first");

    orgCombo.onChange((orgId) => {
      state.orgId = orgId || null;
      if (state.orgId) {
        populatePackages(state.orgId, pkgCombo, state, errorContainer, updateCreateEnabled);
        loadConnectors(state.orgId, connectorCombo, state, errorContainer, updateCreateEnabled);
      } else {
        pkgCombo.clear();
        pkgCombo.setOptions([]);
        pkgCombo.setDisabled(true);
        pkgCombo.setPlaceholder("Select an organization first");
        state.packageId = null;
        connectorCombo.clear();
        connectorCombo.setOptions([]);
        connectorCombo.setDisabled(true);
        connectorCombo.setPlaceholder("Select an organization first");
        state.connectorId = null;
        state.connector = null;
      }
      updateCreateEnabled();
    });

    pkgCombo.onChange((packageId) => {
      state.packageId = packageId || null;
      updateCreateEnabled();
    });

    connectorCombo.onChange((connectorId) => {
      state.connectorId = connectorId || null;
      const full = connectorId && state.connectorsById.get(connectorId);
      state.connector = full ? { id: full.id, name: full.name, type: full.type } : null;
      updateCreateEnabled();
    });

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = session.name || "";

    const descInput = document.createElement("textarea");
    descInput.value = window.FlowAssetHeuristic.summarizePostActivity(session.calls || []);

    const errorContainer = document.createElement("div");

    modalBody.append(
      fieldGroup("Organization", orgCombo.container),
      fieldGroup("Package", pkgCombo.container),
      fieldGroup("IFS Cloud Connector", connectorCombo.container),
      fieldGroup("Name", nameInput),
      fieldGroup("Description", descInput),
      errorContainer
    );

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn-action";
    cancelBtn.textContent = "Cancel";
    cancelBtn.onclick = closeModal;

    const createBtn = document.createElement("button");
    createBtn.className = "btn-primary";
    createBtn.textContent = "Create";
    createBtn.disabled = true;

    modalFooter.append(cancelBtn, createBtn);

    function updateCreateEnabled() {
      createBtn.disabled = !(state.orgId && state.packageId && nameInput.value.trim());
    }
    nameInput.oninput = updateCreateEnabled;

    createBtn.onclick = () => {
      createBtn.disabled = true;
      createBtn.textContent = "Creating…";
      clearChildren(errorContainer);

      const submittedOrgId = state.orgId;
      const submittedPackageId = state.packageId;
      const submittedConnector = state.connector;

      flowFetch(
        `/admin/application/api/v2/organisations/${submittedOrgId}/packages/${submittedPackageId}/assets`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: nameInput.value.trim(),
            description: descInput.value.trim(),
            color: ASSET_COLOR,
            tagIds: [],
            type: "component"
          })
        }
      )
        .then(async (res) => {
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`${res.status} ${res.statusText}${text ? " — " + text : ""}`);
          }
          return res.json();
        })
        .then((asset) => {
          saveLastOrgPackage(submittedOrgId, submittedPackageId, submittedConnector && submittedConnector.id);
          if (typeof startModuleGeneration === "function") {
            closeModal();
            startModuleGeneration(session, submittedOrgId, submittedPackageId, asset, submittedConnector);
          } else {
            showSuccess(asset, submittedOrgId);
          }
        })
        .catch((err) => {
          updateCreateEnabled();
          createBtn.textContent = "Create";
          renderError(errorContainer, `Could not create asset: ${err.message}`);
        });
    };

    loadOrganizations(orgCombo, pkgCombo, connectorCombo, state, errorContainer, updateCreateEnabled);
  }

  const createAssetBtn = document.getElementById("createAssetBtn");
  if (createAssetBtn) {
    createAssetBtn.onclick = () => {
      const session = getActiveSession();
      if (!session) return;
      openCreateAssetModal(session);
    };
  }

  window.flowFetch = flowFetch;
})();
