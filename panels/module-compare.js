// Module Compare tab: pick the Flow organisation, optionally one package, and the upgraded IFS
// instance, then Scan. The scan runs from the results page (module-compare.html), which opens in
// a new tab and shows its progress.
const mcEl = (id) => document.getElementById(id);

function mcHint(text) {
  mcEl("mcHint").textContent = text || "";
  mcEl("mcHint").hidden = !text;
}

function mcSelection() {
  return { orgId: mcEl("mcOrgSelect").value, packageId: mcEl("mcPackageSelect").value, baseUrl: mcEl("mcInstanceSelect").value };
}

function mcUpdateScanBtn() {
  const { orgId, baseUrl } = mcSelection();
  mcEl("mcScanBtn").disabled = !orgId || !baseUrl;
}

function mcOpenResults(sel, scan) {
  const q = new URLSearchParams({ orgId: sel.orgId, packageId: sel.packageId || "", baseUrl: sel.baseUrl });
  q.set("org", mcEl("mcOrgSelect").selectedOptions[0].textContent);
  q.set("pkg", mcEl("mcPackageSelect").selectedOptions[0].textContent);
  if (scan) q.set("scan", "1");
  chrome.tabs.create({ url: chrome.runtime.getURL(`module-compare.html?${q}`) });
}

async function mcShowLast() {
  mcUpdateScanBtn();
  const last = mcEl("mcLast");
  last.hidden = true;
  const sel = mcSelection();
  if (!sel.orgId || !sel.baseUrl) return;
  const response = await send({ type: "MC_LAST_RESULT", ...sel });
  const now = mcSelection();
  if (now.orgId !== sel.orgId || now.packageId !== sel.packageId || now.baseUrl !== sel.baseUrl || !response.ok || !response.result) return;
  const changed = response.result.modules.filter((m) => m.status === "changed").length;
  last.textContent = `Last scan: ${new Date(response.result.scannedAt).toLocaleString()}, ${changed} of ${response.result.modules.length} module(s) changed. `;
  const open = document.createElement("a");
  open.href = "#";
  open.textContent = "Open";
  open.onclick = (e) => { e.preventDefault(); mcOpenResults(sel, false); };
  last.appendChild(open);
  last.hidden = false;
}

async function mcLoadPackages() {
  const select = mcEl("mcPackageSelect");
  const previous = select.value;
  select.innerHTML = "";
  select.append(new Option("All packages", ""));
  const orgId = mcEl("mcOrgSelect").value;
  if (!orgId) return mcShowLast();
  const response = await send({ type: "FT_PACKAGES", orgId });
  if (mcEl("mcOrgSelect").value !== orgId) return;
  if (!response.ok) return mcHint(response.error);
  for (const p of response.packages) select.append(new Option(p.name, p.id));
  if (response.packages.some((p) => p.id === previous)) select.value = previous;
  mcShowLast();
}

let mcOrgsLoaded = false;

/** Fills the organisation list once Flow has a session. The dropdown is always shown; until the
 *  organisations can be read it offers the Designer tab's organisation (if known) and a hint, and
 *  the 5s poll (refreshModuleCompareState) tries again. */
async function mcLoadOrgs() {
  const orgSelect = mcEl("mcOrgSelect");
  const [ctx, orgs] = await Promise.all([send({ type: "LF_CONTEXT" }), send({ type: "FT_ORGS" })]);
  const previous = orgSelect.value;
  const designerOrg = ctx.ok ? ctx.orgId : null;
  if (!orgs.ok || !orgs.orgs.length) {
    if (!orgSelect.options.length) {
      orgSelect.append(new Option(designerOrg ? "Organisation of the open flow" : "No Flow session yet…", designerOrg || ""));
      mcLoadPackages();
    }
    mcEl("mcOrgHint").textContent = orgs.ok
      ? "Flow returned no organisations for your user."
      : "No Flow session yet: open Flow in a tab (or refresh the open Flow tab) and click in it once. The list fills in by itself.";
    mcEl("mcOrgHint").hidden = false;
    return false;
  }
  mcEl("mcOrgHint").hidden = true;
  orgSelect.innerHTML = "";
  orgSelect.append(new Option("Choose an organisation…", ""));
  for (const o of orgs.orgs) orgSelect.append(new Option(o.name, o.id));
  const wanted = previous || designerOrg || (orgs.orgs.length === 1 ? orgs.orgs[0].id : "");
  if (orgs.orgs.some((o) => o.id === wanted)) orgSelect.value = wanted;
  mcOrgsLoaded = true;
  await mcLoadPackages();
  return true;
}

async function mcLoadInstances() {
  const instances = await send({ type: "LIST_INSTANCES" });
  const instSelect = mcEl("mcInstanceSelect");
  const previousInst = instSelect.value;
  instSelect.innerHTML = "";
  if (!instances.ok) return mcHint(instances.error);
  if (!instances.instances.length) {
    instSelect.append(new Option("No IFS instances yet", ""));
    return mcHint("No IFS instances yet — add one in Basic Data.");
  }
  instSelect.append(new Option("Choose an IFS instance…", ""));
  const list = instances.instances.slice().sort((a, b) => a.name.localeCompare(b.name));
  for (const i of list) instSelect.append(new Option(i.name, i.baseUrl));
  if (list.some((i) => i.baseUrl === previousInst)) instSelect.value = previousInst;
  else if (list.length === 1) instSelect.value = list[0].baseUrl;
}

async function mcOnShow() {
  mcHint("");
  await mcLoadInstances();
  await mcLoadOrgs();
  mcShowLast();
}

/** From the side panel's 5s poll: picks up the Flow session if it arrived after the tab opened. */
function refreshModuleCompareState() {
  const panel = mcEl("panel-module-compare");
  if (panel && !panel.hidden && !mcOrgsLoaded) mcLoadOrgs();
}

mcEl("mcOrgSelect").addEventListener("change", mcLoadPackages);
mcEl("mcPackageSelect").addEventListener("change", mcShowLast);
mcEl("mcInstanceSelect").addEventListener("change", mcShowLast);

mcEl("mcScanBtn").addEventListener("click", async () => {
  const sel = mcSelection();
  if (!sel.orgId || !sel.baseUrl) return;
  const origin = new URL(sel.baseUrl).origin;
  // The click is the user gesture chrome.permissions.request needs; ask before any other await.
  const granted = await new Promise((resolve) => chrome.permissions.request({ origins: [origin + "/*"] }, resolve));
  if (!granted) return mcHint(`Permission for ${origin} was not granted — can't read IFS there.`);
  const lock = await send({ type: "GET_LOCK_STATUS" });
  if (lock.ok && lock.passwordSet && !lock.unlocked) return mcHint("Saved credentials are locked — unlock them above, then scan.");
  mcHint("");
  mcOpenResults(sel, true);
});

/** Turns a <select> into a search-as-you-type combobox. The select stays (hidden) as the value
 *  store, so the code above keeps using select.value, its options and its change event; the field
 *  shows the chosen option, typing filters the open list in real time, arrows/Enter/Escape and
 *  clicks pick. `allowEmpty`: the option with value "" is a real choice (All packages), not a
 *  "Choose…" prompt. */
function mcCombobox(selectId, placeholder, allowEmpty) {
  const select = mcEl(selectId);
  const wrap = document.createElement("div");
  wrap.className = "mc-combo";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "mc-combo-input";
  input.placeholder = placeholder;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.autocomplete = "off";
  const list = document.createElement("ul");
  list.className = "mc-combo-list";
  list.setAttribute("role", "listbox");
  list.hidden = true;
  select.before(wrap);
  wrap.append(input, list, select);
  select.hidden = true;

  let active = -1;
  let shown = [];
  const label = () => {
    const o = select.selectedOptions[0];
    return o && (o.value || allowEmpty) ? o.textContent : "";
  };
  const sync = () => { if (document.activeElement !== input) input.value = label(); input.placeholder = label() || (select.options[0] ? select.options[0].textContent : placeholder); };
  const render = (query) => {
    const q = (query || "").trim().toLowerCase();
    shown = [...select.options].filter((o) => (o.value || allowEmpty) && (!q || o.textContent.toLowerCase().includes(q)));
    list.innerHTML = "";
    if (!shown.length) {
      const li = document.createElement("li");
      li.className = "mc-combo-empty";
      li.textContent = select.options.length > 1 ? "No match" : (select.options[0] ? select.options[0].textContent : "Nothing to choose");
      list.append(li);
    }
    shown.forEach((o, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.className = `mc-combo-option${o.value === select.value ? " is-selected" : ""}${i === active ? " is-active" : ""}`;
      li.textContent = o.textContent;
      li.onmousedown = (e) => { e.preventDefault(); pick(o); };
      list.append(li);
    });
    const activeLi = list.children[active];
    if (activeLi) activeLi.scrollIntoView({ block: "nearest" });
  };
  const open = () => { list.hidden = false; input.setAttribute("aria-expanded", "true"); render(input.value === label() ? "" : input.value); };
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); active = -1; input.value = label(); };
  const pick = (o) => {
    const changed = select.value !== o.value;
    select.value = o.value;
    close();
    input.blur();
    if (changed) select.dispatchEvent(new Event("change"));
  };

  input.addEventListener("focus", () => { input.select(); open(); });
  input.addEventListener("input", () => { active = 0; list.hidden = false; render(input.value); });
  input.addEventListener("blur", close);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (list.hidden) open();
      active = Math.max(0, Math.min(shown.length - 1, active + (e.key === "ArrowDown" ? 1 : -1)));
      render(input.value === label() ? "" : input.value);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[active >= 0 ? active : 0]) pick(shown[active >= 0 ? active : 0]);
    } else if (e.key === "Escape") {
      close();
      input.blur();
    }
  });

  // Keep the field in step with the select when the code above refills it or sets its value.
  const valueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  Object.defineProperty(select, "value", { get() { return valueDesc.get.call(this); }, set(v) { valueDesc.set.call(this, v); sync(); } });
  select.addEventListener("change", sync);
  new MutationObserver(() => { sync(); if (!list.hidden) render(input.value === label() ? "" : input.value); }).observe(select, { childList: true });
  sync();
}

mcCombobox("mcOrgSelect", "Search organisations…");
mcCombobox("mcPackageSelect", "Search packages…", true);
mcCombobox("mcInstanceSelect", "Search IFS instances…");
