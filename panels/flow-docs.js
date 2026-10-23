// Documentation tab: documents the flow open in the Designer tab for people and LLMs, to download or
// to download.
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

document.getElementById("fdocDownloadMoreBtn").addEventListener("click", () => {
  if (!fdocResult) return;
  const base = fdocResult.name.replace(/[^\w.-]+/g, "_");
  fdocSave(`${base}.README.md`, fdocResult.files["README.md"]);
  fdocSave(`${base}.flow.json`, fdocResult.files["flow.json"]);
});

document.getElementById("fdocDownloadBtn").addEventListener("click", () => {
  if (!fdocResult) return;
  const base = fdocResult.name.replace(/[^\w.-]+/g, "_");
  // One self-contained file with the instructions and the data: attach it to the LLM chat.
  fdocSave(`${base}.llm-context.md`, fdocResult.files["llm-context.md"]);
});
