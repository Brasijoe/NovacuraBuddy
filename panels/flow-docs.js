// Documentation tab: documents the flow open in the Designer tab for people and LLMs, to download or
// to publish as a link that expires.
let fdocPublishArmed = false;
let fdocResult = null; // { name, files }

function fdocHint(text) {
  const el = document.getElementById("fdocHint");
  el.textContent = text || "";
  el.hidden = !text;
}

chrome.runtime.onMessage.addListener((m) => {
  if (m.type === "FDOC_PROGRESS") fdocHint(`${m.step}${m.total ? ` (${m.current}/${m.total})` : ""}…`);
});

async function fdocOnShow() {
  fdocRenderPublished();
  const select = document.getElementById("fdocInstance");
  if (select.options.length) return;
  const response = await send({ type: "LIST_INSTANCES" });
  if (!response.ok) return;
  for (const i of response.instances.slice().sort((a, b) => a.name.localeCompare(b.name))) select.append(new Option(i.name, i.baseUrl));
}

document.getElementById("fdocIfs").addEventListener("change", (e) => {
  const select = document.getElementById("fdocInstance");
  select.hidden = !e.target.checked || !select.options.length;
  if (e.target.checked && !select.options.length) fdocHint("No IFS installations yet — add one in Basic Data.");
});

document.getElementById("fdocGenerateBtn").addEventListener("click", async () => {
  const btn = document.getElementById("fdocGenerateBtn");
  const useIfs = document.getElementById("fdocIfs").checked && document.getElementById("fdocInstance").value;
  const baseUrl = useIfs ? document.getElementById("fdocInstance").value : null;
  if (baseUrl) {
    const origin = new URL(baseUrl).origin;
    // The click is the user gesture chrome.permissions.request needs; ask before any other await.
    const granted = await new Promise((resolve) => chrome.permissions.request({ origins: [origin + "/*"] }, resolve));
    if (!granted) return fdocHint(`Permission for ${origin} was not granted — can't read its IFS dependencies.`);
    const lock = await send({ type: "GET_LOCK_STATUS" });
    if (lock.ok && lock.passwordSet && !lock.unlocked) return fdocHint("Saved credentials are locked — unlock them above, then try again.");
  }
  btn.disabled = true;
  document.getElementById("fdocResult").hidden = true;
  fdocHint("Starting…");
  const response = await send({ type: "FDOC_GENERATE", baseUrl, notes: document.getElementById("fdocNotes").value.trim(), design: document.getElementById("fdocDesign").checked });
  btn.disabled = false;
  if (!response.ok) return fdocHint(response.error);
  fdocResult = response;
  const s = response.stats;
  fdocHint(s.unreadFlows.length ? `Could not read ${s.unreadFlows.length} flow(s) while looking for where this is used: ${s.unreadFlows.join(", ")}.` : "");
  document.getElementById("fdocSummary").textContent =
    `${response.name}: ${s.assets} asset(s) documented, used by ${s.usedBy} flow(s)` +
    (s.ifsChains == null ? "." : `, ${s.ifsChains} IFS chain(s) call it.`);
  document.getElementById("fdocResult").hidden = false;
});

function fdocSave(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

document.getElementById("fdocDownloadBtn").addEventListener("click", () => {
  if (!fdocResult) return;
  const base = fdocResult.name.replace(/[^\w.-]+/g, "_");
  // One self-contained file for a person or an LLM; the JSON is the raw export.
  fdocSave(`${base}.llm-context.md`, fdocResult.files["llm-context.md"]);
  fdocSave(`${base}.README.md`, fdocResult.files["README.md"]);
  fdocSave(`${base}.flow.json`, fdocResult.files["flow.json"]);
});

// Status right under the Publish button, where the user is looking; `link` makes the result a clickable URL.
function fdocPublishStatus(text, link) {
  const el = document.getElementById("fdocPublishStatus");
  el.textContent = text || "";
  if (link) {
    const a = document.createElement("a");
    a.href = link; a.target = "_blank"; a.textContent = link;
    el.append(" ", a);
  }
  el.hidden = !text;
}

document.getElementById("fdocPublishBtn").addEventListener("click", async () => {
  if (!fdocResult) return;
  const hours = 8;
  const btn = document.getElementById("fdocPublishBtn");
  // window.confirm is blocked in the side panel (returns false without showing), so ask on the button.
  if (!fdocPublishArmed) {
    fdocPublishArmed = true;
    btn.textContent = "Confirm: anyone with the link can read it";
    fdocPublishStatus(`This uploads the documentation as a secret GitHub Gist. Anyone with the link can read it until it is deleted after ${hours} hours. Click again to publish.`);
    setTimeout(() => { fdocPublishArmed = false; btn.textContent = "Publish link (8 h)"; }, 10000);
    return;
  }
  fdocPublishArmed = false;
  btn.textContent = "Publish link (8 h)";
  btn.disabled = true;
  fdocPublishStatus("Publishing…");
  try {
    // Published files carry the expiry so a reader (or LLM) sees it.
    const expiresAt = new Date(Date.now() + hours * 3600e3).toISOString();
    const stamp = (t) => t.replace(/^(- Generated:.*)$/m, `$1\n- This published copy expires: ${expiresAt}`);
    const files = { "llm-context.md": stamp(fdocResult.files["llm-context.md"]), "README.md": stamp(fdocResult.files["README.md"]), "flow.json": fdocResult.files["flow.json"] };
    const response = await Promise.race([
      send({ type: "FDOC_PUBLISH", name: fdocResult.name, files, hours }),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: "No answer from GitHub after 60 seconds." }), 60000))
    ]);
    if (response.needsMasterPassword) return fdocPublishStatus("Publishing needs your saved GitHub token, which is protected by the master password: unlock your saved credentials above, then publish again.");
    if (!response.ok) return fdocPublishStatus(`Publishing failed: ${response.error}`);
    let copied = "";
    try { await navigator.clipboard.writeText(response.entry.rawUrl); copied = " (copied to the clipboard)"; } catch { /* the link is shown anyway */ }
    fdocPublishStatus(`Published${copied}. Give the LLM this link:`, response.entry.rawUrl);
    fdocRenderPublished();
  } catch (e) {
    fdocPublishStatus(`Publishing failed: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
});

async function fdocRenderPublished() {
  const list = document.getElementById("fdocPublished");
  const response = await send({ type: "FDOC_LIST" });
  list.innerHTML = "";
  const entries = response.ok ? response.entries : [];
  if (!entries.length) {
    const li = document.createElement("li");
    li.className = "empty-state";
    li.textContent = "Nothing published.";
    list.appendChild(li);
    return;
  }
  for (const e of entries) {
    const li = document.createElement("li");
    const title = document.createElement("div");
    title.textContent = `${e.name} — expires ${new Date(e.expiresAt).toLocaleString()}`;
    const open = document.createElement("a");
    open.href = e.rawUrl; open.target = "_blank"; open.textContent = "Open";
    const copy = document.createElement("button");
    copy.textContent = "Copy link";
    copy.onclick = () => navigator.clipboard.writeText(e.rawUrl).then(() => { copy.textContent = "Copied"; });
    const del = document.createElement("button");
    del.textContent = "Delete now";
    del.onclick = async () => {
      del.disabled = true;
      const r = await send({ type: "FDOC_DELETE", gistId: e.gistId });
      if (!r.ok) { del.disabled = false; return fdocHint(r.error); }
      fdocRenderPublished();
    };
    li.append(title, open, " ", copy, " ", del);
    list.appendChild(li);
  }
}
