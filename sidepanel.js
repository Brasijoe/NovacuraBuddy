const TAB_KEY = "activeTab";
const TABS = ["tracker", "recorder", "basic-data"];

function showTab(name) {
  for (const tab of TABS) {
    document.getElementById(`tab-${tab}`).classList.toggle("is-active", tab === name);
    document.getElementById(`panel-${tab}`).hidden = tab !== name;
  }
  try { localStorage.setItem(TAB_KEY, name); } catch { /* per-viewer convenience only */ }
}

for (const tab of TABS) document.getElementById(`tab-${tab}`).addEventListener("click", () => showTab(tab));

let initialTab = "tracker";
try { initialTab = TABS.includes(localStorage.getItem(TAB_KEY)) ? localStorage.getItem(TAB_KEY) : "tracker"; } catch { /* default */ }
showTab(initialTab);

initTrackingToggle();
refreshLockStatus();
refreshInstances();
refreshProjections();
setInterval(() => { refreshProjections(); refreshLockStatus(); }, 5000);
