const TAB_KEY = "activeTab";
const TABS = ["tracker", "recorder", "quick-reports", "custom-lus", "flow-deps", "flow-docs", "api-modules", "flows", "module-compare", "linked-flows", "commit-chain", "permission-check", "basic-data"];

function showTab(name) {
  for (const tab of TABS) {
    document.getElementById(`tab-${tab}`).classList.toggle("is-active", tab === name);
    document.getElementById(`panel-${tab}`).hidden = tab !== name;
  }
  for (const group of document.querySelectorAll(".tab-group")) {
    const active = group.querySelector(".tab-item.is-active");
    const btn = group.querySelector(".tab-group-btn");
    btn.classList.toggle("is-active", !!active);
    btn.title = active ? active.textContent : "";
  }
  // Subheader under the tab bar: which tab is open (and the menu group it sits in).
  const openItem = document.getElementById(`tab-${name}`);
  const openGroup = openItem.closest(".tab-group");
  const itemLabel = openItem.firstChild.textContent.trim();
  document.getElementById("tabSubheader").textContent = openGroup ? `${openGroup.querySelector(".tab-group-btn").firstChild.textContent.trim()} › ${itemLabel}` : itemLabel;
  try { localStorage.setItem(TAB_KEY, name); } catch { /* per-viewer convenience only */ }
  if (name === "quick-reports" && !qrLoadedOnce) refreshQuickReports();
  if (name === "custom-lus" && !clLoadedOnce) refreshCustomLus();
  if (name === "flow-deps") fdOnShow();
  if (name === "flow-docs") fdocOnShow();
  if (name === "linked-flows") lfOnShow();
  if (name === "module-compare") mcOnShow();
  if (name === "commit-chain") ccOnShow();
}

// After unlocking the saved credentials, reload what the open tab could not read while locked.
document.addEventListener("ifs-unlocked", () => {
  const name = TABS.find((t) => !document.getElementById(`panel-${t}`).hidden);
  if (name === "flow-deps") fdOnShow();
  if (name === "quick-reports" && !qrLoadedOnce) refreshQuickReports();
  if (name === "custom-lus" && !clLoadedOnce) refreshCustomLus();
});

for (const tab of TABS) document.getElementById(`tab-${tab}`).addEventListener("click", () => { showTab(tab); closeTabMenus(); });

// Tab group menus: hover opens them through CSS; click, Enter/Space and the arrow keys open them
// here for touch and keyboard. After a pick the menu stays shut until the pointer leaves it.
function closeTabMenus(except) {
  for (const group of document.querySelectorAll(".tab-group")) {
    if (group === except) continue;
    group.classList.remove("is-open");
    group.querySelector(".tab-group-btn").setAttribute("aria-expanded", "false");
  }
}
function openTabMenu(group, focusItem) {
  closeTabMenus(group);
  group.classList.add("is-open");
  group.classList.remove("is-suppressed");
  group.querySelector(".tab-group-btn").setAttribute("aria-expanded", "true");
  if (focusItem) (group.querySelector(".tab-item.is-active") || group.querySelector(".tab-item")).focus();
}
for (const group of document.querySelectorAll(".tab-group")) {
  const btn = group.querySelector(".tab-group-btn");
  const items = () => [...group.querySelectorAll(".tab-item")];
  btn.addEventListener("click", () => {
    if (group.classList.contains("is-open")) { closeTabMenus(); group.classList.add("is-suppressed"); }
    else openTabMenu(group, false);
  });
  btn.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") { e.preventDefault(); openTabMenu(group, true); }
  });
  group.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeTabMenus(); group.classList.add("is-suppressed"); btn.focus(); return; }
    const list = items();
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); list[(i + 1) % list.length].focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
  });
  for (const item of items()) item.addEventListener("click", () => { group.classList.add("is-suppressed"); item.blur(); });
  group.addEventListener("mouseleave", () => { group.classList.remove("is-suppressed"); closeTabMenus(); });
  group.addEventListener("focusout", (e) => { if (!group.contains(e.relatedTarget)) group.classList.remove("is-open"); });
}
document.addEventListener("click", (e) => { if (!e.target.closest(".tab-group")) closeTabMenus(); });

let initialTab = "tracker";
try { initialTab = TABS.includes(localStorage.getItem(TAB_KEY)) ? localStorage.getItem(TAB_KEY) : "tracker"; } catch { /* default */ }
showTab(initialTab);

initTrackingToggle();
refreshLockStatus();
refreshInstances();
refreshGithubStatus();
refreshProjections();
let lastUnmatchedHostsKey = null;
async function refreshUnmatchedHosts() {
  const response = await send({ type: "GET_UNMATCHED_HOSTS" });
  if (!response || !response.ok) return;
  const key = response.hosts.join("\n");
  if (key === lastUnmatchedHostsKey) return; // unchanged: keep the DOM (and any button mid-click) as is
  lastUnmatchedHostsKey = key;
  const container = document.getElementById("unmatchedHosts");
  container.innerHTML = "";
  for (const host of response.hosts) {
    const notice = document.createElement("div");
    notice.className = "banner banner-warning";
    const label = document.createElement("span");
    label.textContent = `IFS instance ${host} isn't set up yet.`;
    const save = document.createElement("button");
    save.textContent = "Save now";
    save.className = "btn-primary";
    save.onclick = () => {
      showTab("basic-data");
      prefillInstanceForm({ baseUrl: `https://${host}`, name: host });
    };
    const dismiss = document.createElement("button");
    dismiss.textContent = "Dismiss";
    dismiss.className = "btn-ghost";
    dismiss.onclick = async () => { await send({ type: "DISMISS_UNMATCHED_HOST", host }); refreshUnmatchedHosts(); };
    notice.append(label, save, dismiss);
    container.appendChild(notice);
  }
}

initRecorderPanel();
initQuickReportsPanel();
initCustomLusPanel();
initApiModulesPanel();
initFlowTransferPanel();
initLinkedFlowsPanel();
refreshUpdateBanner();
refreshUnmatchedHosts();
setInterval(() => { refreshProjections(); refreshLockStatus(); refreshUnmatchedHosts(); refreshQrDesignerState(); refreshApiDesignerState(); refreshFlowTransferState(); refreshLinkedFlowsState(); refreshModuleCompareState(); refreshCommitChainState(); }, 5000);
