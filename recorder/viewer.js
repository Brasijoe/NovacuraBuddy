/* ============================================================
   Viewer Controller & Call Log Inspector
   ============================================================ */

const $ = (s) => document.querySelector(s);
let sessions = [];
let activeSessionId = null;
let searchQuery = "";
let excludedProjections = new Set();
/** Ids the user manually unchecked from the optimizer's auto-marks for the active session.
 *  Reset whenever the active session changes, so switching sessions doesn't carry stale
 *  overrides into a different call list. */
let manualOverrides = new Set();

/** Cache for FlowCallOptimizer.computeMarks(), keyed on the active session's id AND the
 *  identity of its calls array. computeMarks() is expensive on real traces (large $select/
 *  $expand query strings), and renderCalls() used to call it on every render — including every
 *  search keystroke — causing multi-second UI freezes. Keying on the calls array reference (not
 *  just session id) means a session whose calls were mutated in place under the same reference
 *  would NOT be detected as stale by identity alone; every call site that mutates session.calls
 *  therefore also explicitly invalidates this cache (see invalidateMarksCache() call sites). */
let marksCache = null; // { sessionId, calls, marks }

function invalidateMarksCache() {
  marksCache = null;
}

/** Single source of truth for computeMarks() results so renderCalls() and the #optimizeCallsBtn
 *  handler never drift into two separate computations that could disagree. */
function getMarksForSession(session) {
  if (marksCache && marksCache.sessionId === session.id && marksCache.calls === session.calls) {
    return marksCache.marks;
  }
  const marks = FlowCallOptimizer.computeMarks(session.calls || []);
  marksCache = { sessionId: session.id, calls: session.calls, marks };
  return marks;
}

/** Calls to excluded projections (see excluded-projections.txt) are still recorded in full
 *  (ifs-modules.js's dependency tracer needs their response data), just hidden from this
 *  display so the call list stays uncluttered. */
function getVisibleCalls(session) {
  return (session.calls || []).filter((c) => {
    const svcName = ProjectionFilter.extractSvcName(c.url);
    return !svcName || !excludedProjections.has(svcName.toUpperCase());
  });
}

/** The exact filter renderCalls() applies for display: excluded-projections AND the search box.
 *  #optimizeCallsBtn must use this SAME predicate for its visibleIds set, otherwise a call
 *  hidden by an active search filter (which never rendered a checkbox) would still be eligible
 *  for deletion when the button is clicked. */
function getFilteredCalls(session) {
  return getVisibleCalls(session).filter((c) => {
    if (!searchQuery) return true;
    const str = `${c.method} ${c.url} ${c.status} ${c.statusText || ""}`.toLowerCase();
    return str.includes(searchQuery);
  });
}

async function loadExcludedProjections() {
  try {
    const res = await fetch(chrome.runtime.getURL("recorder/excluded-projections.txt"));
    excludedProjections = ProjectionFilter.parseExcludedList(await res.text());
  } catch (e) {
    excludedProjections = new Set();
  }
}

// Initialize
(async function init() {
  await loadExcludedProjections();
  await loadSessions();
  const queryParam = new URLSearchParams(location.search).get("s");
  if (queryParam && sessions.some(s => s.id === queryParam)) {
    activeSessionId = queryParam;
  } else {
    activeSessionId = sessions[0]?.id || null;
  }
  renderSidebar();
  renderWorkspace();
})();

// Real-time synchronization
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.sessions) {
    sessions = changes.sessions.newValue || [];
    if (!sessions.some(s => s.id === activeSessionId)) {
      activeSessionId = sessions[0]?.id || null;
    }
    invalidateMarksCache(); // another tab/window may have changed session.calls
    renderSidebar();
    renderWorkspace();
  }
});

async function loadSessions() {
  const { sessions: s = [] } = await chrome.storage.local.get("sessions");
  sessions = s;
}
async function persistSessions() {
  await chrome.storage.local.set({ sessions });
}

function getActiveSession() {
  return sessions.find(s => s.id === activeSessionId);
}

/* --- Sidebar --- */
function renderSidebar() {
  const container = $("#sessionList");
  container.innerHTML = "";

  if (!sessions.length) {
    container.innerHTML = '<div style="padding:16px;color:#64748b;text-align:center;">No sessions found</div>';
    return;
  }

  sessions.forEach(s => {
    const item = document.createElement("div");
    item.className = "sess-nav-item" + (s.id === activeSessionId ? " active" : "");
    item.innerHTML = `
      <div class="s-name"></div>
      <div class="s-meta">${getVisibleCalls(s).length} calls · ${new Date(s.createdAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</div>
    `;
    item.querySelector(".s-name").textContent = s.name;
    item.onclick = () => {
      activeSessionId = s.id;
      searchQuery = "";
      $("#searchInput").value = "";
      manualOverrides = new Set();
      invalidateMarksCache();
      renderSidebar();
      renderWorkspace();
    };
    container.appendChild(item);
  });
}

/* --- Top Toolbar --- */
$("#searchInput").oninput = (e) => {
  searchQuery = e.target.value.toLowerCase();
  renderCalls();
};

$("#expandAllBtn").onclick = () => {
  document.querySelectorAll(".call-card").forEach(el => toggleCallDetail(el, true));
};
$("#collapseAllBtn").onclick = () => {
  document.querySelectorAll(".call-card").forEach(el => toggleCallDetail(el, false));
};

$("#optimizeCallsBtn").onclick = () => {
  const session = getActiveSession();
  if (!session) return;

  // Only ever act on calls the user could actually see and review a checkbox for - a call
  // hidden by excluded-projections filtering OR by an active search filter never rendered a
  // checkbox, so it must never be silently deleted or folded into a merge even if computeMarks
  // flagged it using the full session for cross-reference accuracy. getFilteredCalls() is the
  // exact same predicate renderCalls() uses, so this always matches what's on screen right now.
  const visibleIds = new Set(getFilteredCalls(session).map(c => c.id));
  const marks = getMarksForSession(session);
  const deleteIds = new Set(
    [...marks.deleteIds].filter(id => visibleIds.has(id) && !manualOverrides.has(id))
  );
  const chains = marks.chains.filter(chain => chain.calls.every(c => visibleIds.has(c.id)));
  const mergingChainCount = chains.filter(chain =>
    chain.calls.slice(1).some(c => deleteIds.has(c.id))
  ).length;

  if (deleteIds.size === 0 && mergingChainCount === 0) {
    alert("Nothing marked for deletion or merging.");
    return;
  }
  if (!confirm(`Delete ${deleteIds.size} redundant call(s) and merge ${mergingChainCount} patch chain(s)? This cannot be undone.`)) return;

  session.calls = FlowCallOptimizer.applyOptimization(session.calls, deleteIds, chains);
  invalidateMarksCache();
  manualOverrides = new Set();
  persistSessions();
  renderSidebar();
  renderWorkspace();
};

$("#renameSessionBtn").onclick = () => {
  const s = getActiveSession();
  if (!s) return;
  const name = prompt("Rename session:", s.name);
  if (name && name.trim()) {
    s.name = name.trim();
    persistSessions();
    renderSidebar();
    renderWorkspace();
  }
};

$("#deleteSessionBtn").onclick = () => {
  const s = getActiveSession();
  if (!s || !confirm(`Delete session "${s.name}"?`)) return;
  sessions = sessions.filter(x => x.id !== s.id);
  activeSessionId = sessions[0]?.id || null;
  persistSessions();
  renderSidebar();
  renderWorkspace();
};

$("#clearAllBtn").onclick = () => {
  if (!sessions.length || !confirm("Delete ALL recorded sessions?")) return;
  sessions = [];
  activeSessionId = null;
  persistSessions();
  renderSidebar();
  renderWorkspace();
};

$("#exportBtn").onclick = () => {
  const s = getActiveSession();
  if (!s) return;
  const blob = new Blob([JSON.stringify(s, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${s.name.replace(/[^a-z0-9_-]/gi, '_')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

/* --- Main Call Log Workspace --- */
function renderWorkspace() {
  const session = getActiveSession();
  const title = $("#activeSessionName");
  const meta = $("#activeSessionMeta");

  if (!session) {
    title.textContent = "Select a recording";
    meta.textContent = "0 calls";
    $("#callsContainer").innerHTML = `
      <div class="empty-splash">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        <p>No active recording selected.</p>
      </div>`;
    return;
  }

  const visibleCount = getVisibleCalls(session).length;
  title.textContent = session.name;
  meta.textContent = `${visibleCount} total call${visibleCount === 1 ? '' : 's'}`;
  renderCalls();
}

function extractProjectionPath(fullUrl) {
  try {
    const idx = fullUrl.indexOf("main/ifsapplications/projection");
    if (idx !== -1) {
      return fullUrl.substring(idx + "main/ifsapplications/projection".length);
    }
    const u = new URL(fullUrl);
    return u.pathname + u.search;
  } catch (e) {
    return fullUrl || "Unknown Endpoint";
  }
}

function renderCalls() {
  const box = $("#callsContainer");
  box.innerHTML = "";
  const session = getActiveSession();
  if (!session) return;

  const filtered = getFilteredCalls(session);

  if (!filtered.length) {
    box.innerHTML = '<div class="empty-splash"><p>No calls match your search filter.</p></div>';
    return;
  }

  // Computed over the FULL session (including calls hidden by excluded-projections/search) so
  // used/unused and chain detection stay accurate even though hidden calls never get a
  // checkbox and are never touched by the apply step (see Step 4). Cached per session so
  // typing in the search box doesn't re-run the expensive detection on every keystroke.
  const marks = getMarksForSession(session);
  filtered.forEach(call => box.appendChild(createCallCard(session, call, marks)));
}

function createCallCard(session, call, marks) {
  const card = document.createElement("div");
  card.className = "call-card";
  card._call = call;

  const header = document.createElement("div");
  header.className = "call-header";

  const isSuccess = call.status >= 200 && call.status < 400;
  const statusDisplay = call.error ? "ERR" : (call.status || "0");

  const mergeInfo = marks.mergeInfo.get(call.id);
  const isDeletable = marks.deleteIds.has(call.id);
  const isChecked = isDeletable && !manualOverrides.has(call.id);

  let badgeHtml = "";
  if (mergeInfo && mergeInfo.role === "survivor") {
    badgeHtml = `<span class="opt-badge merge-survivor">Merges with ${mergeInfo.partnerIds.length} call${mergeInfo.partnerIds.length === 1 ? "" : "s"}</span>`;
  } else if (mergeInfo && mergeInfo.role === "absorbed") {
    badgeHtml = `<span class="opt-badge merge-absorbed">Merging</span>`;
  } else if (marks.duplicateIds.has(call.id)) {
    badgeHtml = `<span class="opt-badge dup">Duplicate</span>`;
  } else if (marks.unusedIds.has(call.id)) {
    badgeHtml = `<span class="opt-badge unused">Unused</span>`;
  }

  const checkboxHtml = isDeletable
    ? `<input type="checkbox" class="call-del-check" title="Mark for deletion" ${isChecked ? "checked" : ""} />`
    : "";

  if (isChecked) card.classList.add("marked-delete");

  header.innerHTML = `
    <span class="call-caret">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
    </span>
    ${checkboxHtml}
    <span class="http-pill ${call.method}">${call.method}</span>
    <span class="call-endpoint" title="${call.url}"></span>
    ${badgeHtml}
    <span class="status-pill ${isSuccess ? 'success' : 'error'}">${statusDisplay}</span>
    <span class="call-timing">${call.duration != null ? call.duration + 'ms' : '-'}</span>
    <span class="call-size">${formatBytes(call.size)}</span>
    <button class="btn-del-call" title="Delete call">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
    </button>
  `;

  header.querySelector(".call-endpoint").textContent = extractProjectionPath(call.url);

  if (isDeletable) {
    const checkEl = header.querySelector(".call-del-check");
    checkEl.onclick = (e) => e.stopPropagation();
    checkEl.onchange = (e) => {
      if (e.target.checked) manualOverrides.delete(call.id);
      else manualOverrides.add(call.id);
      card.classList.toggle("marked-delete", e.target.checked);
    };
  }

  // Per-call delete
  header.querySelector(".btn-del-call").onclick = (e) => {
    e.stopPropagation();
    if (!confirm("Delete this call from the session?")) return;
    session.calls = session.calls.filter(c => c.id !== call.id);
    invalidateMarksCache();
    persistSessions();
    renderSidebar();
    renderWorkspace();
  };

  const detail = document.createElement("div");
  detail.className = "call-detail";
  detail.style.display = "none";

  header.onclick = () => {
    const isExpanded = detail.style.display !== "none";
    toggleCallDetail(card, !isExpanded);
  };

  card.append(header, detail);
  return card;
}

function toggleCallDetail(cardEl, expand) {
  const detail = cardEl.querySelector(".call-detail");
  const caret = cardEl.querySelector(".call-caret");
  if (!detail) return;

  detail.style.display = expand ? "block" : "none";
  caret.innerHTML = expand
    ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>`
    : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>`;

  if (expand && !detail.hasChildNodes()) {
    renderCallDetailDrawer(detail, cardEl._call);
  }
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(2) + " MB";
}

/* --- Detail Drawer --- */
function renderCallDetailDrawer(container, call) {
  const tabsNav = document.createElement("div");
  tabsNav.className = "detail-tabs";

  const panesContainer = document.createElement("div");

  const tabDefs = [
    ["Overview", () => createOverviewPane(call)],
    ["Request Body", () => createPayloadPane(call.requestBody, "No request body (GET or empty).")],
    ["Response Body", () => createPayloadPane(call.responseBody, call.responseNote || "No response body captured.")],
    ["Request Headers", () => createHeadersPane(call.requestHeaders)],
    ["Response Headers", () => createHeadersPane(call.responseHeaders)]
  ];

  tabDefs.forEach(([label, builder], idx) => {
    const tab = document.createElement("button");
    tab.className = "d-tab" + (idx === 0 ? " active" : "");
    tab.textContent = label;

    const pane = document.createElement("div");
    pane.className = "d-pane" + (idx === 0 ? " active" : "");
    pane.appendChild(builder());

    tab.onclick = () => {
      tabsNav.querySelectorAll(".d-tab").forEach(t => t.classList.remove("active"));
      panesContainer.querySelectorAll(".d-pane").forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      pane.classList.add("active");
    };

    tabsNav.appendChild(tab);
    panesContainer.appendChild(pane);
  });

  container.append(tabsNav, panesContainer);
}

function createOverviewPane(call) {
  const table = document.createElement("table");
  table.className = "kv-table";

  let parsedUrl = { pathname: call.url, search: "" };
  try { parsedUrl = new URL(call.url); } catch (e) {}

  const rows = [
    ["Full URL", call.url],
    ["Endpoint", extractProjectionPath(call.url).split("?")[0]],
    ["Query Params", parsedUrl.search ? decodeURIComponent(parsedUrl.search.slice(1)) : "—"],
    ["Method", call.method],
    ["Status", call.error ? `Error: ${call.error}` : `${call.status} ${call.statusText || ""}`],
    ["Duration", call.duration != null ? `${call.duration} ms` : "—"],
    ["Payload Size", formatBytes(call.size) || "—"],
    ["MIME Type", call.mimeType || "—"],
    ["Timestamp", new Date(call.timestamp).toLocaleString()],
    ["cURL", ""]
  ];

  rows.forEach(([k, v]) => {
    const tr = table.insertRow();
    tr.insertCell().textContent = k;
    const valCell = tr.insertCell();
    valCell.className = "val";

    if (k === "cURL") {
      const curlBtn = document.createElement("button");
      curlBtn.className = "btn-tool";
      curlBtn.textContent = "Copy as cURL";
      curlBtn.onclick = () => copyText(generateCurl(call));
      valCell.appendChild(curlBtn);
    } else {
      valCell.textContent = v;
    }
  });

  return table;
}

function createHeadersPane(headers) {
  if (!headers || !Object.keys(headers).length) {
    const msg = document.createElement("div");
    msg.style.cssText = "padding:12px;color:#94a3b8;font-size:12px;";
    msg.textContent = "No headers available.";
    return msg;
  }
  const table = document.createElement("table");
  table.className = "kv-table";
  Object.keys(headers).sort().forEach(k => {
    const tr = table.insertRow();
    tr.insertCell().textContent = k;
    const valCell = tr.insertCell();
    valCell.className = "val";
    valCell.textContent = headers[k];
  });
  return table;
}

function createPayloadPane(rawBody, fallbackMsg) {
  if (!rawBody) {
    const msg = document.createElement("div");
    msg.style.cssText = "padding:16px;color:#94a3b8;font-size:12px;font-style:italic;";
    msg.textContent = fallbackMsg;
    return msg;
  }

  const wrapper = document.createElement("div");
  const actions = document.createElement("div");
  actions.className = "pane-actions";
  const displayArea = document.createElement("div");

  const parsed = tryParseJson(rawBody);
  const gridBtn = makeBtn("Grid View", "btn-tool");
  const rawBtn = makeBtn("Raw JSON", "btn-tool");
  const copyBtn = makeBtn("Copy", "btn-tool");

  const showGrid = () => {
    displayArea.innerHTML = "";
    displayArea.appendChild(jsonGrid(parsed.value));
    gridBtn.classList.add("active");
    rawBtn.classList.remove("active");
  };

  const showRaw = () => {
    displayArea.innerHTML = "";
    const pre = document.createElement("pre");
    pre.className = "raw-code";
    pre.textContent = parsed.ok ? JSON.stringify(parsed.value, null, 2) : rawBody;
    displayArea.appendChild(pre);
    rawBtn.classList.add("active");
    gridBtn.classList.remove("active");
  };

  copyBtn.onclick = () => copyText(rawBody);

  if (parsed.ok) {
    gridBtn.onclick = showGrid;
    rawBtn.onclick = showRaw;
    actions.append(gridBtn, rawBtn, copyBtn);
    const info = document.createElement("span");
    info.className = "payload-info";
    info.textContent = `Valid JSON · ${(rawBody.length / 1024).toFixed(1)} KB`;
    actions.appendChild(info);
    wrapper.append(actions, displayArea);
    showGrid();
  } else {
    rawBtn.onclick = showRaw;
    actions.append(copyBtn);
    const info = document.createElement("span");
    info.className = "payload-info";
    info.textContent = `Raw Text · ${rawBody.length} chars`;
    actions.appendChild(info);
    wrapper.append(actions, displayArea);
    showRaw();
  }

  return wrapper;
}

function makeBtn(text, cls) {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = text;
  return b;
}

function copyText(str) {
  navigator.clipboard.writeText(str).then(() => {
    const t = $("#toast");
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 2000);
  });
}

function generateCurl(call) {
  let cmd = `curl '${call.url}' \\\n  -X '${call.method}'`;
  if (call.requestHeaders) {
    Object.keys(call.requestHeaders).forEach(h => {
      cmd += ` \\\n  -H '${h}: ${call.requestHeaders[h].replace(/'/g, "\\'")}'`;
    });
  }
  if (call.requestBody) {
    cmd += ` \\\n  --data-raw '${call.requestBody.replace(/'/g, "\\'")}'`;
  }
  return cmd;
}