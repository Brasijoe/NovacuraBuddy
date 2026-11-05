// Event Triggers tab: link a Flow automation (webhook endpoint) to an IFS event. Creates the routing
// address, routing rule and event action in IFS (lib/event-triggers.js, background ET_* messages).
// Preview first (read-only), then a second click creates; existing objects are reused, nothing is deleted.
const et = { plan: null, orgId: null, automations: [], accessKeys: [], ifsFor: null, events: [], planned: false };

const etEl = (id) => document.getElementById(id);

function etHint(text) {
  etEl("etHint").textContent = text || "";
  etEl("etHint").hidden = !text;
}

const ET_ENV_LABEL = { dev: "Dev", test: "Test", prod: "Prod" };
const etEnvLabel = (e) => ET_ENV_LABEL[e.envType] || "Env";

function etResetPlan() {
  et.planned = false;
  etEl("etPlan").hidden = true;
  etEl("etLinkBtn").hidden = true;
  etEl("etResult").hidden = true;
  etUpdatePlanBtn();
}

function etSelectedAutomation() { return et.automations.find((a) => a.id === etEl("etAutomation").value) || null; }
function etSelectedEndpoint() {
  const a = etSelectedAutomation();
  return a ? a.endpoints.find((e) => e.envId === etEl("etEndpoint").value) || null : null;
}
function etSelectedEvent() {
  const [luName, id] = (etEl("etEvent").value || "").split("|");
  return luName && id ? { luName, id } : null;
}

function etUpdatePlanBtn() {
  const ready = etSelectedAutomation() && etSelectedEndpoint() && etEl("etKey").value && etEl("etInstance").value && etSelectedEvent() && etEl("etQueue").value;
  etEl("etPlanBtn").disabled = !ready;
}

function etFillEndpoints() {
  const a = etSelectedAutomation();
  const select = etEl("etEndpoint");
  select.innerHTML = "";
  if (!a) return;
  for (const e of a.endpoints) select.append(new Option(e.envName.toLowerCase() === etEnvLabel(e).toLowerCase() ? e.envName : `${etEnvLabel(e)} · ${e.envName}`, e.envId));
  select.value = a.endpoints[0].envId;
  etShowEndpointInfo();
}

function etShowEndpointInfo() {
  const a = etSelectedAutomation();
  const e = etSelectedEndpoint();
  etEl("etEndpointInfo").textContent = e ? e.url : "";
  const keys = a && e ? et.accessKeys.filter((k) => k.packageId === a.packageId && k.environmentId === e.envId) : [];
  const expired = (k) => k.expirationDate && new Date(k.expirationDate) < new Date();
  etEl("etKeyHint").textContent = keys.length
    ? `Keys for this package and environment: ${keys.map((k) => `${k.name}${expired(k) ? " (expired)" : ""}`).join(", ")}`
    : "No access key listed for this package and environment.";
  etResetPlan();
}

async function etLoadAutomations() {
  const btn = etEl("etLoadBtn");
  btn.disabled = true;
  etHint("Reading the automations and their webhooks from Flow…");
  const response = await send({ type: "ET_FLOW_AUTOMATIONS" });
  btn.disabled = false;
  if (!response.ok) { etEl("etFlowFields").hidden = true; return etHint(response.error); }
  et.orgId = response.orgId;
  et.automations = response.automations;
  et.accessKeys = response.accessKeys;
  if (!et.automations.length) {
    etEl("etFlowFields").hidden = true;
    const failed = response.failures || [];
    return etHint(failed.length
      ? `No automation with a webhook switched on found (${response.checked} automations checked, ${failed.length} settings reads failed). First failures: ${failed.slice(0, 3).join(" | ")}`
      : `No automation of this organisation has a webhook switched on (${response.checked} checked).`);
  }
  etHint("");
  const select = etEl("etAutomation");
  select.innerHTML = "";
  select.append(new Option("Choose an automation…", ""));
  for (const a of et.automations) select.append(new Option(`${a.name} · ${a.packageName}`, a.id));
  if (et.automations.length === 1) select.value = et.automations[0].id;
  etEl("etFlowFields").hidden = false;
  etFillEndpoints();
  etUpdatePlanBtn();
}

async function etLoadInstances() {
  const select = etEl("etInstance");
  const previous = select.value;
  const response = await send({ type: "LIST_INSTANCES" });
  select.innerHTML = "";
  if (!response.ok) return etHint(response.error);
  const instances = response.instances.slice().sort((a, b) => a.name.localeCompare(b.name));
  select.append(new Option(instances.length ? "Choose an installation…" : "No IFS installations yet — add one in Basic Data.", ""));
  for (const i of instances) select.append(new Option(i.name, i.baseUrl));
  // The instance of the projection tab open elsewhere (Projection Tracker) is the default.
  if (instances.some((i) => i.baseUrl === previous)) select.value = previous;
  else if (typeof currentBaseUrl !== "undefined" && instances.some((i) => i.baseUrl === currentBaseUrl)) select.value = currentBaseUrl;
  else if (instances.length === 1) select.value = instances[0].baseUrl;
  if (select.value && et.ifsFor !== select.value) etLoadIfsLists(select.value, false);
}

/** Loads queues and events. `gesture`: called from a user click (the permission prompt needs one). */
async function etLoadIfsLists(baseUrl, gesture) {
  const origin = new URL(baseUrl).origin;
  const has = await new Promise((resolve) => chrome.permissions.contains({ origins: [origin + "/*"] }, resolve));
  if (!has) {
    if (!gesture) return etHint(`Choose the installation to let the extension use ${origin}.`);
    const granted = await new Promise((resolve) => chrome.permissions.request({ origins: [origin + "/*"] }, resolve));
    if (!granted) return etHint(`Permission for ${origin} was not granted.`);
  }
  etHint("Reading the events and queues from IFS…");
  const response = await send({ type: "ET_IFS_LISTS", baseUrl });
  if (etEl("etInstance").value !== baseUrl) return;
  if (!response.ok) { etEl("etIfsFields").hidden = true; return etHint(explainLocked(response)); }
  etHint("");
  et.ifsFor = baseUrl;
  const events = etEl("etEvent");
  events.innerHTML = "";
  events.append(new Option("Choose an event…", ""));
  for (const e of response.events) events.append(new Option(`${e.luName} · ${e.id}${e.description ? " — " + e.description : ""}`, `${e.luName}|${e.id}`));
  const queues = etEl("etQueue");
  queues.innerHTML = "";
  for (const q of response.queues) queues.append(new Option(q.description ? `${q.name} — ${q.description}` : q.name, q.name));
  queues.value = response.queues.some((q) => q.name === "NOTIFICATIONS") ? "NOTIFICATIONS" : (response.queues[0] || {}).name || "";
  etEl("etIfsFields").hidden = false;
  etUpdatePlanBtn();
}

function etInput() {
  const a = etSelectedAutomation();
  const e = etSelectedEndpoint();
  const ev = etSelectedEvent();
  return {
    automationName: a.name, endpoint: e.url, method: etEl("etMethod").value,
    eventLuName: ev.luName, eventId: ev.id, queue: etEl("etQueue").value
  };
}

function etRenderPlan(plan, instanceName) {
  const box = etEl("etPlan");
  box.innerHTML = "";
  const row = (label, name, exists) => {
    const p = document.createElement("p");
    p.textContent = `${label}: ${name} — ${exists ? "exists already, will be reused" : "will be created"}`;
    box.append(p);
  };
  const title = document.createElement("p");
  title.textContent = `In ${instanceName}:`;
  box.append(title);
  row("Routing address", plan.addressName, plan.addressExists);
  row("Routing rule", plan.ruleName, plan.ruleExists);
  const action = document.createElement("p");
  action.textContent = `Event action: ${plan.description} — will be created`;
  box.append(action);
  box.hidden = false;
}

etEl("etPlanBtn").addEventListener("click", async () => {
  const baseUrl = etEl("etInstance").value;
  etEl("etResult").hidden = true;
  const response = await actionOrShowError({ type: "ET_PLAN", baseUrl, input: etInput() });
  if (!response) return;
  et.planned = true;
  et.plan = response.plan;
  etRenderPlan(response.plan, etEl("etInstance").selectedOptions[0].textContent);
  etEl("etLinkBtn").hidden = false;
  etEl("etLinkBtn").textContent = "Confirm and link automation";
});

etEl("etLinkBtn").addEventListener("click", async () => {
  if (!et.planned) return;
  const btn = etEl("etLinkBtn");
  btn.disabled = true;
  btn.textContent = "Linking…";
  const response = await actionOrShowError({ type: "ET_LINK", baseUrl: etEl("etInstance").value, input: etInput(), accessKey: etEl("etKey").value });
  btn.disabled = false;
  btn.hidden = true;
  et.planned = false;
  if (!response) return;
  const out = etEl("etResult");
  out.innerHTML = "";
  for (const r of response.results) {
    const p = document.createElement("p");
    p.textContent = `${r.step}: ${r.status === "created" ? "created" : r.status === "exists" ? "already existed, reused" : "failed — " + r.error}`;
    out.append(p);
  }
  // Direct link to the routing address in IFS (created or reused).
  const url = et.plan && IfsLinks.ifsObjectUrl(etEl("etInstance").value, "routingAddress", { addressName: et.plan.addressName });
  if (url) {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = `Open routing address ${et.plan.addressName} in IFS ↗`;
    out.appendChild(a);
  }
  out.hidden = false;
});

etEl("etLoadBtn").addEventListener("click", etLoadAutomations);
etEl("etAutomation").addEventListener("change", () => { etFillEndpoints(); etUpdatePlanBtn(); });
etEl("etEndpoint").addEventListener("change", () => { etShowEndpointInfo(); etUpdatePlanBtn(); });
etEl("etInstance").addEventListener("change", () => { et.ifsFor = null; etEl("etIfsFields").hidden = true; etResetPlan(); if (etEl("etInstance").value) etLoadIfsLists(etEl("etInstance").value, true); });
for (const id of ["etEvent", "etQueue", "etMethod"]) etEl(id).addEventListener("change", () => { etResetPlan(); });
etEl("etKey").addEventListener("input", etUpdatePlanBtn);

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "ET_PROGRESS") etHint(`Reading the webhooks from Flow… ${message.current}/${message.total}`);
});

function etOnShow() {
  etLoadInstances();
  if (!et.automations.length) etLoadAutomations();
}
