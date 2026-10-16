let recPollTimer = null;

function updateRecorderStatus() {
  send({ type: "GET_STATUS" }).then((res) => {
    if (!res || res.recording === undefined) return;
    document.getElementById("startBtn").disabled = res.recording;
    document.getElementById("stopBtn").disabled = !res.recording;
    const bar = document.getElementById("recStatusBar");
    const txt = document.getElementById("recStatusText");
    if (res.recording) {
      bar.className = "status-bar recording";
      txt.textContent = `Recording (${res.callCount} calls captured)`;
    } else {
      bar.className = "status-bar";
      if (!txt.textContent.startsWith("Saved")) txt.textContent = "Ready to record";
    }
  });
}

function startRecorderPolling() { stopRecorderPolling(); recPollTimer = setInterval(updateRecorderStatus, 800); }
function stopRecorderPolling() { if (recPollTimer) clearInterval(recPollTimer); recPollTimer = null; }

async function getSessions() {
  const { sessions = [] } = await chrome.storage.local.get("sessions");
  return sessions;
}
const saveSessions = (s) => chrome.storage.local.set({ sessions: s });

async function renderSessions() {
  const list = document.getElementById("sessionList");
  const sessions = await getSessions();
  list.innerHTML = "";
  if (!sessions.length) {
    list.innerHTML = '<div class="empty-state">No recorded sessions yet.</div>';
    return;
  }
  for (const s of sessions) list.appendChild(buildSessionCard(s));
}

function buildSessionCard(s) {
  const item = document.createElement("div");
  item.className = "sess-item";

  const info = document.createElement("div");
  info.className = "sess-info";
  info.innerHTML = `
    <div class="sess-title"></div>
    <div class="sess-meta">${s.calls.length} calls · ${new Date(s.createdAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</div>
  `;
  info.querySelector(".sess-title").textContent = s.name;
  info.onclick = () => chrome.runtime.sendMessage({ type: "OPEN_VIEWER", sessionId: s.id });

  // Inline Rename
  const renameBtn = document.createElement("button");
  renameBtn.className = "icon-btn";
  renameBtn.title = "Rename";
  renameBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>`;
  renameBtn.onclick = (e) => {
    e.stopPropagation();
    const input = document.createElement("input");
    input.className = "rename-input";
    input.value = s.name;
    info.innerHTML = "";
    info.appendChild(input);
    input.focus();
    input.select();

    const commit = async () => {
      const val = input.value.trim();
      if (val) {
        const all = await getSessions();
        const target = all.find(x => x.id === s.id);
        if (target) target.name = val;
        await saveSessions(all);
      }
      renderSessions();
    };
    input.onkeydown = (ev) => { if (ev.key === "Enter") commit(); if (ev.key === "Escape") renderSessions(); };
    input.onblur = commit;
  };

  // Delete
  const delBtn = document.createElement("button");
  delBtn.className = "icon-btn del";
  delBtn.title = "Delete";
  delBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
  delBtn.onclick = async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete "${s.name}"?`)) return;
    const all = (await getSessions()).filter(x => x.id !== s.id);
    await saveSessions(all);
    renderSessions();
  };

  item.append(info, renameBtn, delBtn);
  return item;
}

function initRecorderPanel() {
  document.getElementById("startBtn").onclick = async () => {
    const res = await actionOrShowError({ type: "START_RECORDING" });
    if (res && res.warning) showError(res.warning, true);
    updateRecorderStatus();
    startRecorderPolling();
  };
  document.getElementById("stopBtn").onclick = async () => {
    const res = await actionOrShowError({ type: "STOP_RECORDING" });
    stopRecorderPolling();
    updateRecorderStatus();
    renderSessions();
    if (typeof refreshUnmatchedHosts === "function") refreshUnmatchedHosts();
    if (res && res.session) {
      document.getElementById("recStatusText").textContent = `Saved "${res.session.name}" (${res.session.calls.length} calls)`;
    }
  };
  document.getElementById("viewerBtn").onclick = () => send({ type: "OPEN_VIEWER" });
  updateRecorderStatus();
  renderSessions();
  send({ type: "GET_STATUS" }).then((res) => { if (res && res.recording) startRecorderPolling(); });
}
