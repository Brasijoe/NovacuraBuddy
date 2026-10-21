const TAB_KEY = "activeTab";
const TABS = ["tracker", "recorder", "quick-reports", "custom-lus", "api-modules", "basic-data"];

function showTab(name) {
  for (const tab of TABS) {
    document.getElementById(`tab-${tab}`).classList.toggle("is-active", tab === name);
    document.getElementById(`panel-${tab}`).hidden = tab !== name;
  }
  try { localStorage.setItem(TAB_KEY, name); } catch { /* per-viewer convenience only */ }
  if (name === "quick-reports" && !qrLoadedOnce) refreshQuickReports();
  if (name === "custom-lus" && !clLoadedOnce) refreshCustomLus();
}

for (const tab of TABS) document.getElementById(`tab-${tab}`).addEventListener("click", () => showTab(tab));

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
refreshUpdateBanner();
refreshUnmatchedHosts();
setInterval(() => { refreshProjections(); refreshLockStatus(); refreshUnmatchedHosts(); refreshQrDesignerState(); refreshApiDesignerState(); }, 5000);
