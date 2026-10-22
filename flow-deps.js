// Results page of the Flow dependency scanner (opened from the side panel's Flow Dependencies tab).
// Same views as the HPHG Flow Mapper: groups on the left (here one per Flow endpoint), the chains of
// the chosen group as left-to-right node rows, click a node for its details.
const params = new URLSearchParams(location.search);
const baseUrl = params.get("baseUrl");
const UNKNOWN = "__unknown__";
const ALL = "__all__";

const TYPE_LABELS = {
  event: "Event",
  eventAction: "Event Action",
  workflow: "Workflow",
  routingAddress: "Routing Address",
  pageCommand: "Page Command",
  endpoint: "Flow Endpoint"
};

let result = null;
let selectedGroup = ALL;

function nodeLabel(node) {
  const d = node.data;
  switch (node.type) {
    case "event": return d.eventId || "Event";
    case "eventAction": return d.matchedVia && d.matchedVia.type === "bpa" ? d.matchedVia.processKey : `Action #${d.actionNumber}`;
    case "workflow": return d.processKey;
    case "routingAddress": return d.addressName;
    case "pageCommand": return d.name || d.dataId;
    case "endpoint": return d.url || (d.matchedHosts || []).join(", ") || "Flow";
    default: return node.type;
  }
}

function nodeSubLabel(node) {
  const d = node.data;
  switch (node.type) {
    case "event": return d.eventLuName || null;
    case "eventAction": return d.actionType || null;
    case "workflow": return [`v${d.version}`, d.matchedVia.taskName].filter(Boolean).join(" · ");
    case "routingAddress": return d.restRootEndPoint || null;
    case "pageCommand": {
      // modelId looks like "ClientMetadata.client:Customer": the page the command sits on.
      const modelId = d.modelId || "";
      const i = modelId.indexOf(":");
      return i >= 0 ? modelId.slice(i + 1) : modelId || null;
    }
    default: return null;
  }
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

function renderChain(chain) {
  const card = document.createElement("div");
  card.className = "fd-chain";
  const row = document.createElement("div");
  row.className = "fd-chain-row";
  chain.nodes.forEach((node, i) => {
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
    el.onclick = () => {
      const open = card.querySelector(".fd-detail");
      const wasThis = open && open.dataset.index === String(i);
      if (open) open.remove();
      card.querySelectorAll(".fd-node.is-active").forEach((n) => n.classList.remove("is-active"));
      if (wasThis) return;
      el.classList.add("is-active");
      const panel = document.createElement("div");
      panel.className = "fd-detail";
      panel.dataset.index = String(i);
      const head = document.createElement("div");
      head.className = "fd-detail-type";
      head.textContent = TYPE_LABELS[node.type] || node.type;
      panel.append(head, renderValueTree(node.data));
      card.appendChild(panel);
    };
    row.appendChild(el);
    if (i < chain.nodes.length - 1) {
      const arrow = document.createElement("span");
      arrow.className = "fd-arrow";
      arrow.textContent = "→";
      row.appendChild(arrow);
    }
  });
  card.appendChild(row);
  return card;
}

function chainText(chain) {
  return chain.nodes.map((n) => `${nodeLabel(n)} ${nodeSubLabel(n) || ""}`).join(" ").toLowerCase();
}

function groupEntries() {
  const groups = Object.entries(result.grouped.groups).sort(([a], [b]) => a.localeCompare(b));
  const entries = [[ALL, "All chains", result.chains]];
  for (const [key, chains] of groups) entries.push([key, key, chains]);
  if (result.grouped.unknown.length) entries.push([UNKNOWN, "No endpoint URL", result.grouped.unknown]);
  return entries;
}

function render() {
  const needle = document.getElementById("fdFilter").value.trim().toLowerCase();
  const matches = (key, chains) => !needle || key.toLowerCase().includes(needle) || chains.some((c) => chainText(c).includes(needle));
  const entries = groupEntries().filter(([key, label, chains]) => key === ALL || matches(label, chains));
  if (!entries.some(([key]) => key === selectedGroup)) selectedGroup = ALL;

  const list = document.getElementById("fdGroupList");
  list.innerHTML = "";
  for (const [key, label, chains] of entries) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "fd-group" + (key === selectedGroup ? " is-active" : "");
    const name = document.createElement("span");
    name.className = "fd-group-name";
    name.textContent = label;
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
  document.getElementById("fdGroupTitle").textContent = `${label} (${shown.length})`;
  const container = document.getElementById("fdChains");
  container.innerHTML = "";
  for (const chain of shown) container.appendChild(renderChain(chain));
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
    `Scanned ${new Date(r.scannedAt).toLocaleString()} · ${r.chains.length} chain(s) to ${Object.keys(r.grouped.groups).length} Flow endpoint(s) · ` +
    `${c.routingAddresses} routing address(es), ${c.workflows} workflow match(es) in ${c.workflowsScanned} active workflow(s), ${c.eventActions} event action(s), ${c.pageCommands} page command(s)`;
  empty.textContent = r.chains.length ? "" : "Nothing in this installation calls run.novacura.com or app.novacura.com.";
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

async function scan() {
  const btn = document.getElementById("fdRescanBtn");
  btn.disabled = true;
  currentScanId = `${Date.now()}-${Math.random()}`;
  document.getElementById("fdProgress").hidden = false;
  document.getElementById("fdProgressFill").style.width = "0%";
  document.getElementById("fdProgressLabel").textContent = "Starting…";
  if (!result) document.getElementById("fdEmpty").hidden = true;
  const response = await send({ type: "FD_SCAN", baseUrl, scanId: currentScanId, masterPassword: "" });
  document.getElementById("fdProgress").hidden = true;
  btn.disabled = false;
  // A failed scan leaves the previous result on screen.
  if (!response.ok) return showError(`Scan failed: ${explainLocked(response)}`, true);
  showResult(response.result);
}

async function main() {
  if (!baseUrl) return showError("No installation given — start the scan from the side panel's Flow Dependencies tab.", true);
  document.getElementById("fdSubtitle").textContent = baseUrl;
  send({ type: "LIST_INSTANCES" }).then((response) => {
    const instance = response.ok && response.instances.find((i) => i.baseUrl === baseUrl);
    if (instance) {
      document.getElementById("fdTitle").textContent = `Flow dependencies · ${instance.name}`;
      document.title = `Flow dependencies · ${instance.name}`;
    }
  });
  document.getElementById("fdRescanBtn").onclick = scan;
  document.getElementById("fdFilter").addEventListener("input", () => result && render());
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
