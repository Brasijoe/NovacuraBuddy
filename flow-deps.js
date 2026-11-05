// Results page of the Flow dependency scanner (opened from the side panel's Flow Dependencies tab).
// Same views as the HPHG Flow Mapper: groups on the left (here per endpoint or per Flow package), the chains of
// the chosen group as left-to-right node rows, click a node for its details.
const params = new URLSearchParams(location.search);
const baseUrl = params.get("baseUrl");
const UNKNOWN = "__unknown__";
const ALL = "__all__";

const TYPE_LABELS = {
  event: "Event",
  eventAction: "Event Action",
  workflow: "Workflow",
  routingRule: "Routing Rule",
  routingAddress: "Routing Address",
  pageCommand: "Page Command",
  endpoint: "Endpoint"
};

const NOT_FLOW = "__notflow__";
const NOT_FOUND = "__notfound__";
const GROUP_MODE_KEY = "flowDepsGroupMode";

let result = null;
let selectedGroup = ALL;
let groupMode = "package"; // or "endpoint"
try { if (localStorage.getItem(GROUP_MODE_KEY) === "endpoint") groupMode = "endpoint"; } catch { /* per-viewer convenience only */ }
let flowIndex = null; // packages + assets of the open Flow organisation, loaded on first use
let flowIndexError = "";

function nodeLabel(node) {
  const d = node.data;
  switch (node.type) {
    case "event": return d.eventId || "Event";
    case "eventAction": return d.matchedVia && d.matchedVia.type === "bpa" ? d.matchedVia.processKey : (d.actionType || "Event action");
    case "workflow": return d.processKey;
    case "routingRule": return d.ruleName;
    case "routingAddress": return d.addressName;
    case "pageCommand": return d.name || d.dataId;
    case "endpoint": return d.url || (d.matchedPatterns || []).join(", ") || "Endpoint";
    default: return node.type;
  }
}

function nodeSubLabel(node) {
  const d = node.data;
  switch (node.type) {
    case "event": return d.eventLuName || null;
    case "eventAction": return d.actionType || null;
    case "workflow": return [`v${d.version}`, d.matchedVia.taskName].filter(Boolean).join(" · ");
    case "routingRule": return [d.queue, (d.messageFunctions || []).join(", ")].filter(Boolean).join(" · ") || null;
    case "routingAddress": return d.restRootEndPoint || null;
    case "endpoint": {
      const target = flowIndex && FlowDeps.flowTargetForUrl(d.url, flowIndex);
      if (!target) return null;
      if (target.ambiguous) return `${target.assetName} in ${target.packageNames.join(", ")}?`;
      return [target.packageName, target.automationName, target.assetName].filter((v, i, all) => v && all.indexOf(v) === i).join(" · ");
    }
    case "pageCommand": {
      // modelId looks like "ClientMetadata.client:Customer": the page the command sits on.
      const modelId = d.modelId || "";
      const i = modelId.indexOf(":");
      return i >= 0 ? modelId.slice(i + 1) : modelId || null;
    }
    default: return null;
  }
}

/** What is switched off on an event action or routing rule: it will not fire. */
function nodeWarnings(node) {
  const d = node.data;
  const out = [];
  if (node.type === "eventAction") {
    if (d.enabled === false) out.push("Not enabled");
    if (d.published === false) out.push("Not published");
  }
  if (node.type === "routingRule" && d.enabled === false) out.push("Not enabled");
  return out;
}

function renderValueTree(value) {
  const wrap = document.createElement("div");
  wrap.className = "tree";
  if (value === null || value === undefined || typeof value !== "object") {
    wrap.classList.add("tree-leaf");
    wrap.textContent = value === "" ? '""' : String(value);
    return wrap;
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [`[${i}]`, v]) : Object.entries(value);
  if (!entries.length) {
    wrap.classList.add("tree-leaf");
    wrap.textContent = Array.isArray(value) ? "[ ]" : "{ }";
    return wrap;
  }
  for (const [key, val] of entries) {
    if (key.startsWith("@odata")) continue;
    const row = document.createElement("div");
    row.className = "tree-row";
    const k = document.createElement("div");
    k.className = "tree-key";
    k.textContent = key;
    row.appendChild(k);
    if (val !== null && typeof val === "object") {
      const child = document.createElement("div");
      child.className = "tree-children";
      child.appendChild(renderValueTree(val));
      row.appendChild(child);
    } else {
      const v = document.createElement("div");
      v.className = "tree-value";
      v.textContent = val === "" ? '""' : String(val);
      row.appendChild(v);
    }
    wrap.appendChild(row);
  }
  return wrap;
}

// Layers of a chain, top to bottom. The automation at the end is drawn once per block.
const STAGE_OF = { event: 0, pageCommand: 0, eventAction: 0, workflow: 1, routingRule: 2, routingAddress: 2 };

function makeNode(node, onPick) {
  const el = document.createElement("button");
  el.className = `fd-node fd-type-${node.type}`;
  const type = document.createElement("span");
  type.className = "fd-node-type";
  type.textContent = TYPE_LABELS[node.type] || node.type;
  const value = document.createElement("span");
  value.className = "fd-node-value";
  value.textContent = nodeLabel(node);
  el.append(type, value);
  const sub = nodeSubLabel(node);
  if (sub) {
    const subEl = document.createElement("span");
    subEl.className = "fd-node-sub";
    subEl.textContent = sub;
    el.appendChild(subEl);
  }
  for (const text of nodeWarnings(node)) {
    const warn = document.createElement("span");
    warn.className = "fd-node-warn";
    warn.textContent = text;
    el.appendChild(warn);
  }
  el.onclick = () => onPick(el, node);
  return el;
}

const STAGE_LABELS = ["IFS event", "Workflow", "Routing", "Novacura"];

/** One automation: chains are columns, layers are rows (a layer no chain uses has no row), the automation once at the bottom. */
function renderBlock(block) {
  const card = document.createElement("section");
  card.className = "fd-auto";
  const head = document.createElement("div");
  head.className = "fd-auto-head";
  const tag = document.createElement("span");
  tag.className = "fd-tag fd-tag-flow";
  tag.textContent = block.target ? "Automation" : "Endpoint";
  const title = document.createElement("h3");
  title.textContent = block.title;
  const url = document.createElement("span");
  url.className = "fd-url";
  url.textContent = block.urls.join(" · ");
  head.append(tag, title);
  if (block.target && block.target.packageName) {
    const pkg = document.createElement("span");
    pkg.className = "fd-auto-pkg";
    pkg.textContent = `Package: ${block.target.packageName}`;
    head.appendChild(pkg);
  }
  if (block.urls.length) head.appendChild(url);
  if (!block.target && flowIndex && block.urls.some((u) => /run\.novacura\.com|app\.novacura\.com/i.test(u))) {
    const miss = document.createElement("span");
    miss.className = "fd-node-warn";
    miss.textContent = "No automation in Flow has this webhook address";
    head.appendChild(miss);
  }
  // Collapse / expand this automation (click the heading).
  const toggle = document.createElement("button");
  toggle.className = "fd-collapse";
  toggle.setAttribute("aria-label", "Collapse or expand this automation");
  toggle.setAttribute("aria-expanded", "true");
  toggle.textContent = "▾";
  head.prepend(toggle);
  head.classList.add("fd-auto-head-click");
  head.onclick = () => {
    const collapsed = card.classList.toggle("is-collapsed");
    toggle.textContent = collapsed ? "▸" : "▾";
    toggle.setAttribute("aria-expanded", String(!collapsed));
  };
  card.appendChild(head);

  const scroll = document.createElement("div");
  scroll.className = "fd-scroll";
  const detailHost = document.createElement("div");
  const pick = (el, node) => {
    const open = detailHost.firstChild;
    const wasThis = open && open.node === node;
    detailHost.innerHTML = "";
    card.querySelectorAll(".fd-node.is-active").forEach((n) => n.classList.remove("is-active"));
    if (wasThis) return;
    el.classList.add("is-active");
    const panel = document.createElement("div");
    panel.className = "fd-detail";
    panel.node = node;
    const h = document.createElement("div");
    h.className = "fd-detail-type";
    h.textContent = TYPE_LABELS[node.type] || node.type;
    panel.append(h, renderValueTree(node.data));
    detailHost.appendChild(panel);
  };

  const cols = block.chains.length;
  const grid = document.createElement("div");
  grid.className = "fd-stage-grid";
  grid.style.setProperty("--cols", String(cols));
  const arrow = () => { const a = document.createElement("div"); a.className = "fd-arrow"; a.textContent = "▼"; return a; };
  const stages = [0, 1, 2].filter((st) => block.chains.some((c) => c.nodes.some((n) => STAGE_OF[n.type] === st)));
  stages.forEach((st, rowIndex) => {
    if (rowIndex) { const sep = document.createElement("div"); sep.className = "fd-row-sep"; grid.appendChild(sep); }
    const label = document.createElement("div");
    label.className = "fd-rowlabel";
    label.textContent = STAGE_LABELS[st];
    grid.appendChild(label);
    for (const chain of block.chains) {
      const cell = document.createElement("div");
      cell.className = "fd-cell";
      const nodes = chain.nodes.filter((n) => STAGE_OF[n.type] === st);
      nodes.forEach((n, i) => {
        if (i || (st > 0 && rowIndex)) cell.appendChild(arrow());
        cell.appendChild(makeNode(n, pick));
      });
      grid.appendChild(cell);
    }
  });
  const end = block.chains[0].nodes[block.chains[0].nodes.length - 1];
  if (end && end.type === "endpoint") {
    if (stages.length) { const sep = document.createElement("div"); sep.className = "fd-row-sep"; grid.appendChild(sep); }
    const label = document.createElement("div");
    label.className = "fd-rowlabel";
    label.textContent = STAGE_LABELS[3];
    const target = document.createElement("div");
    target.className = "fd-cell fd-target";
    target.append(arrow(), makeNode(end, pick));
    grid.append(label, target);
  }
  scroll.append(grid, detailHost);
  card.appendChild(scroll);
  return card;
}

function chainText(chain) {
  return chain.nodes.map((n) => `${nodeLabel(n)} ${nodeSubLabel(n) || ""}`).join(" ").toLowerCase();
}

function groupEntries() {
  const entries = groupMode === "package" && flowIndex ? [] : [[ALL, "All chains", result.chains]];
  if (groupMode === "package" && flowIndex) {
    const byPackage = FlowDeps.groupChainsByPackage(result.chains, flowIndex);
    for (const [key, chains] of Object.entries(byPackage.groups).sort(([a], [b]) => a.localeCompare(b))) entries.push([key, key, chains]);
    if (byPackage.notFound.length) entries.push([NOT_FOUND, "Flow asset not found", byPackage.notFound]);
    if (byPackage.notFlow.length) entries.push([NOT_FLOW, "Not run./app.novacura.com", byPackage.notFlow]);
    return entries;
  }
  // Endpoint view: the automation's name is the primary label, the endpoint address the smaller secondary one.
  const named = Object.entries(result.grouped.groups).map(([key, chains]) => {
    const end = chains[0].nodes[chains[0].nodes.length - 1];
    const url = end && end.type === "endpoint" ? end.data.url : key;
    const target = flowIndex ? FlowDeps.flowTargetForUrl(url, flowIndex) : null;
    const name = target && !target.ambiguous ? (target.automationName || target.assetName) : null;
    return [key, name || key, chains, name ? key : ""];
  });
  for (const entry of named.sort((a, b) => a[1].localeCompare(b[1]))) entries.push(entry);
  if (result.grouped.unknown.length) entries.push([UNKNOWN, "No endpoint URL", result.grouped.unknown]);
  return entries;
}

async function setGroupMode(mode) {
  groupMode = mode;
  selectedGroup = ALL;
  try { localStorage.setItem(GROUP_MODE_KEY, mode); } catch { /* per-viewer convenience only */ }
  for (const btn of document.querySelectorAll("[data-group-mode]")) btn.classList.toggle("is-active", btn.dataset.groupMode === mode);
  if (!flowIndex) await loadFlowIndex(); // names of automations and packages come from Flow in both views
  if (groupMode !== mode) return; // switched again while Flow was answering
  document.getElementById("fdGroupHint").hidden = !document.getElementById("fdGroupHint").textContent;
  document.getElementById("fdGroupHead").textContent = mode === "package" && flowIndex ? "Flow packages" : "Endpoints";
  if (result && result.chains.length) render();
}

async function loadFlowIndex() {
  const hint = document.getElementById("fdGroupHint");
  hint.textContent = "Reading packages from Flow…";
  hint.hidden = false;
  const response = await send({ type: "FD_FLOW_INDEX" });
  flowIndex = response.ok ? response.index : null;
  flowIndexError = response.ok ? "" : response.error;
  const wi = response.ok && response.index.webhookInfo;
  const stale = response.ok && response.index.stale;
  hint.textContent = flowIndexError || (stale ? `Flow can't be read right now (${stale.reason}). Showing the names last read from Flow on ${new Date(stale.savedAt).toLocaleString()}.` : wi && wi.failures.length
    ? `Webhook addresses could not be read for ${wi.failures.length} of ${wi.checked} automation(s) (first: ${wi.failures[0]}); their names may be missing.`
    : "");
  hint.hidden = !hint.textContent;
  // The reason must not hide in the sidebar: without Flow the names stay as endpoint addresses.
  const warn = document.getElementById("fdFlowWarn");
  warn.textContent = flowIndexError ? `Package and automation names could not be read from Flow: ${flowIndexError}` : "";
  warn.hidden = !flowIndexError;
}

function render() {
  const needle = document.getElementById("fdFilter").value.trim().toLowerCase();
  const matches = (key, chains) => !needle || key.toLowerCase().includes(needle) || chains.some((c) => chainText(c).includes(needle));
  const entries = groupEntries().filter(([key, label, chains, sub]) => key === ALL || matches(`${label} ${sub || ""}`, chains));
  if (!entries.some(([key]) => key === selectedGroup)) selectedGroup = entries[0][0];

  const list = document.getElementById("fdGroupList");
  list.innerHTML = "";
  for (const [key, label, chains, sub] of entries) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "fd-group" + (key === selectedGroup ? " is-active" : "");
    const name = document.createElement("span");
    name.className = "fd-group-name";
    name.textContent = label;
    if (sub) {
      const subEl = document.createElement("small");
      subEl.className = "fd-group-sub";
      subEl.textContent = sub;
      name.appendChild(subEl);
    }
    const count = document.createElement("span");
    count.className = "list-count";
    count.textContent = String(chains.length);
    btn.append(name, count);
    btn.onclick = () => { selectedGroup = key; render(); };
    li.appendChild(btn);
    list.appendChild(li);
  }

  const [, label, chains] = entries.find(([key]) => key === selectedGroup);
  const shown = selectedGroup === ALL ? chains.filter((c) => !needle || chainText(c).includes(needle)) : chains;
  const blocks = FlowDeps.groupChainsByAutomation(shown, flowIndex);
  const packageView = groupMode === "package" && flowIndex;
  document.getElementById("fdGroupTitle").textContent = `${label} (${shown.length})`;
  document.getElementById("fdGroupTitle").hidden = !!packageView;
  const container = document.getElementById("fdChains");
  container.innerHTML = "";
  if (packageView) {
    const head = document.createElement("div");
    head.className = "fd-pkg-head";
    const tag = document.createElement("span");
    tag.className = "fd-tag";
    tag.textContent = "Package";
    const name = document.createElement("h2");
    name.textContent = label;
    const count = document.createElement("span");
    count.className = "fd-muted";
    count.textContent = `${blocks.length} automation(s) · ${shown.length} chain(s)`;
    head.append(tag, name, count);
    container.appendChild(head);
  }
  for (const block of blocks) container.appendChild(renderBlock(block));
}

function showResult(r) {
  result = r;
  const empty = document.getElementById("fdEmpty");
  if (!r) {
    document.getElementById("fdResults").hidden = true;
    document.getElementById("fdSummary").textContent = "";
    empty.textContent = "No scan yet for this installation — Rescan starts one.";
    empty.hidden = false;
    return;
  }
  const c = r.counts;
  document.getElementById("fdSummary").textContent =
    `Scanned ${new Date(r.scannedAt).toLocaleString()} for ${(r.patterns || []).join(", ")} · ${r.chains.length} chain(s) to ${Object.keys(r.grouped.groups).length} endpoint(s) · ` +
    `${c.routingAddresses} routing address(es), ${c.routingRules || 0} routing rule(s), ${c.workflows} workflow match(es) in ${c.workflowsScanned} active workflow(s), ${c.eventActions} event action(s), ${c.pageCommands} page command(s)`;
  document.getElementById("fdRescanBtn").title = document.getElementById("fdSummary").textContent; // the scan details, on hover
  empty.textContent = r.chains.length ? "" : `Nothing in this installation calls ${(r.patterns || []).join(", ")}.`;
  empty.hidden = !!r.chains.length;
  document.getElementById("fdResults").hidden = !r.chains.length;
  if (r.chains.length) render();

  const errors = r.errors || [];
  document.getElementById("fdErrors").hidden = !errors.length;
  document.getElementById("fdErrorsSummary").textContent = `${errors.length} item(s) could not be read and were skipped`;
  const errList = document.getElementById("fdErrorList");
  errList.innerHTML = "";
  for (const e of errors) {
    const li = document.createElement("li");
    li.textContent = `${e.step} · ${e.item}: ${e.message}`;
    errList.appendChild(li);
  }
}

let currentScanId = null;
chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "FD_SCAN_PROGRESS" || message.scanId !== currentScanId) return;
  const pct = message.total ? Math.round((message.current / message.total) * 100) : 0;
  document.getElementById("fdProgressFill").style.width = `${pct}%`;
  document.getElementById("fdProgressLabel").textContent = `${message.step}: ${message.current}/${message.total}`;
});

// The side panel's Search for list (panels/flow-deps.js), read fresh for every scan.
async function searchPatterns() {
  const { flowDepsAddresses: a } = await chrome.storage.local.get("flowDepsAddresses");
  const settings = { useDefaults: true, custom: [], ...(a || {}) };
  return [...(settings.useDefaults ? ["run.novacura.com", "app.novacura.com"] : []), ...settings.custom];
}

async function scan() {
  const btn = document.getElementById("fdRescanBtn");
  btn.disabled = true;
  currentScanId = `${Date.now()}-${Math.random()}`;
  document.getElementById("fdProgress").hidden = false;
  document.getElementById("fdProgressFill").style.width = "0%";
  document.getElementById("fdProgressLabel").textContent = "Starting…";
  if (!result) document.getElementById("fdEmpty").hidden = true;
  const response = await send({ type: "FD_SCAN", baseUrl, scanId: currentScanId, patterns: await searchPatterns(), masterPassword: "" });
  document.getElementById("fdProgress").hidden = true;
  btn.disabled = false;
  // A failed scan leaves the previous result on screen.
  if (!response.ok) return showError(`Scan failed: ${explainLocked(response)}`, true);
  showResult(response.result);
}

async function main() {
  if (!baseUrl) return showError("No installation given — start the scan from the side panel's Flow Dependencies tab.", true);
  document.getElementById("fdSubtitle").hidden = true; // the instance name in the title is enough
  send({ type: "LIST_INSTANCES" }).then((response) => {
    const instance = response.ok && response.instances.find((i) => i.baseUrl === baseUrl);
    if (instance) {
      document.getElementById("fdTitle").textContent = `Flow dependencies · ${instance.name}`;
      document.title = `Flow dependencies · ${instance.name}`;
    }
  });
  document.getElementById("fdRescanBtn").onclick = scan;
  document.getElementById("fdFilter").addEventListener("input", () => result && render());
  for (const btn of document.querySelectorAll("[data-group-mode]")) btn.onclick = () => setGroupMode(btn.dataset.groupMode);
  setGroupMode(groupMode);
  if (params.get("scan") === "1") {
    history.replaceState(null, "", `?baseUrl=${encodeURIComponent(baseUrl)}`); // a reload shows, not rescans
    const last = await send({ type: "FD_LAST_RESULT", baseUrl });
    if (last.ok && last.result) showResult(last.result);
    return scan();
  }
  const last = await send({ type: "FD_LAST_RESULT", baseUrl });
  showResult(last.ok ? last.result : null);
}

main();
