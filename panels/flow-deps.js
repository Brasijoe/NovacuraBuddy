// Flow Dependencies tab: pick an IFS installation, Scan. The scan itself runs from the results page
// (flow-deps.html), which opens in a new tab and shows its progress.
function fdHint(text) {
  const el = document.getElementById("fdHint");
  el.textContent = text || "";
  el.hidden = !text;
}

// Which addresses the scan searches: the two Novacura hosts (unless unticked) plus the user's own.
// Kept in chrome.storage.local so the results page's Rescan uses the same list.
const FD_ADDRESSES_KEY = "flowDepsAddresses"; // { useDefaults, custom: [] }
let fdAddresses = { useDefaults: true, custom: [] };

async function fdLoadAddresses() {
  const { [FD_ADDRESSES_KEY]: stored } = await chrome.storage.local.get(FD_ADDRESSES_KEY);
  fdAddresses = { useDefaults: true, custom: [], ...(stored || {}) };
  fdRenderAddresses();
}

function fdSaveAddresses() {
  chrome.storage.local.set({ [FD_ADDRESSES_KEY]: fdAddresses });
  fdRenderAddresses();
}

function fdRenderAddresses() {
  document.getElementById("fdUseDefaults").checked = fdAddresses.useDefaults;
  const list = document.getElementById("fdAddressList");
  list.innerHTML = "";
  for (const address of fdAddresses.custom) {
    const li = document.createElement("li");
    li.append(address);
    const remove = document.createElement("button");
    remove.textContent = "✕";
    remove.title = `Remove ${address}`;
    remove.onclick = () => { fdAddresses.custom = fdAddresses.custom.filter((a) => a !== address); fdSaveAddresses(); };
    li.appendChild(remove);
    list.appendChild(li);
  }
  fdUpdateScanBtn();
}

function fdAddAddress() {
  const input = document.getElementById("fdAddressInput");
  const address = input.value.trim();
  if (!address) return;
  if (!fdAddresses.custom.some((a) => a.toLowerCase() === address.toLowerCase())) fdAddresses.custom.push(address);
  input.value = "";
  fdSaveAddresses();
}

function fdUpdateScanBtn() {
  const hasAddress = fdAddresses.useDefaults || fdAddresses.custom.length > 0;
  document.getElementById("fdScanBtn").disabled = !document.getElementById("fdInstanceSelect").value || !hasAddress;
}

document.getElementById("fdUseDefaults").addEventListener("change", (e) => { fdAddresses.useDefaults = e.target.checked; fdSaveAddresses(); });
document.getElementById("fdAddressAddBtn").addEventListener("click", fdAddAddress);
document.getElementById("fdAddressInput").addEventListener("keydown", (e) => { if (e.key === "Enter") fdAddAddress(); });

function openFlowDeps(baseUrl, scan) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`flow-deps.html?baseUrl=${encodeURIComponent(baseUrl)}${scan ? "&scan=1" : ""}`) });
}

async function fdShowLast() {
  const select = document.getElementById("fdInstanceSelect");
  const last = document.getElementById("fdLast");
  fdUpdateScanBtn();
  last.hidden = true;
  if (!select.value) return;
  const baseUrl = select.value;
  const response = await send({ type: "FD_LAST_RESULT", baseUrl });
  if (select.value !== baseUrl || !response.ok || !response.result) return;
  last.textContent = `Last scan: ${new Date(response.result.scannedAt).toLocaleString()}, ${response.result.chains.length} chain(s). `;
  const open = document.createElement("a");
  open.href = "#";
  open.textContent = "Open";
  open.onclick = (e) => { e.preventDefault(); openFlowDeps(baseUrl, false); };
  last.appendChild(open);
  last.hidden = false;
}

async function fdOnShow() {
  fdLoadAddresses();
  const select = document.getElementById("fdInstanceSelect");
  const previous = select.value;
  const response = await send({ type: "LIST_INSTANCES" });
  select.innerHTML = "";
  if (!response.ok) return fdHint(response.error);
  const instances = response.instances.slice().sort((a, b) => a.name.localeCompare(b.name));
  if (!instances.length) { select.hidden = true; return fdHint("No IFS installations yet — add one in Basic Data."); }
  select.hidden = false;
  fdHint("");
  select.append(new Option("Choose an installation…", ""));
  for (const instance of instances) select.append(new Option(instance.name, instance.baseUrl));
  if (instances.some((i) => i.baseUrl === previous)) select.value = previous;
  else if (instances.length === 1) select.value = instances[0].baseUrl;
  fdShowLast();
}

document.getElementById("fdInstanceSelect").addEventListener("change", fdShowLast);

document.getElementById("fdScanBtn").addEventListener("click", async () => {
  const baseUrl = document.getElementById("fdInstanceSelect").value;
  if (!baseUrl) return;
  const origin = new URL(baseUrl).origin;
  // The click is the user gesture chrome.permissions.request needs; ask before any other await.
  const granted = await new Promise((resolve) => chrome.permissions.request({ origins: [origin + "/*"] }, resolve));
  if (!granted) return fdHint(`Permission for ${origin} was not granted — can't scan it.`);
  const lock = await send({ type: "GET_LOCK_STATUS" });
  if (lock.ok && lock.passwordSet && !lock.unlocked) return fdHint("Saved credentials are locked — unlock them above, then scan.");
  fdHint("");
  openFlowDeps(baseUrl, true);
});
