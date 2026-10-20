function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError || !response) {
        resolve({ ok: false, error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || "No response from the extension's background page — try again." });
        return;
      }
      resolve(response);
    });
  });
}

// An error from something the user did (Create, Activate, Search, ...) stays until their next
// action or a click on the banner. Without this the 5s background poll's next success wiped it
// within milliseconds, so a failed Create looked like "nothing happened".
let errorIsSticky = false;

function showNotice(message) {
  const el = document.getElementById("notice");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => { el.hidden = true; }, 6000);
}

function showError(message, sticky) {
  const el = document.getElementById("error");
  el.textContent = message;
  el.hidden = false;
  errorIsSticky = !!sticky;
}

function clearError(force) {
  if (errorIsSticky && !force) return;
  const el = document.getElementById("error");
  el.hidden = true;
  el.textContent = "";
  errorIsSticky = false;
}

document.getElementById("error").addEventListener("click", () => clearError(true));

async function sendOrShowError(message, sticky) {
  const response = await send(message);
  if (response && response.needsMasterPassword) refreshLockStatus();
  if (!response.ok) {
    showError(response.error || "Something went wrong.", sticky);
    return null;
  }
  clearError();
  return response;
}

let currentBaseUrl = null;
let currentInstances = [];

function updateCurrentInstanceLabel() {
  const instance = currentInstances.find((i) => i.baseUrl === currentBaseUrl);
  document.getElementById("currentInstanceName").textContent = instance ? instance.name : "No instance selected";
}

// The unlock field is the normal way in; the Add-instance form's field still works as before.
const masterPasswordOf = () =>
  document.getElementById("unlockPassword").value || document.getElementById("masterPassword").value;

// The unlocked key lives in session storage like IFS Buddy's (cleared by a browser restart or an
// extension reload), so the panel needs its own place to re-enter the master password — the
// equivalent of IFS Buddy's unlock dialog — not just the collapsed Add-instance form.
async function refreshLockStatus() {
  const response = await send({ type: "GET_LOCK_STATUS" });
  if (!response || !response.ok) return;
  const locked = response.passwordSet && !response.unlocked;
  document.getElementById("unlockRow").hidden = !locked;
  const chip = document.getElementById("lockStatus");
  chip.hidden = !response.passwordSet;
  chip.textContent = locked ? "Locked" : "Unlocked";
  chip.className = "status " + (locked ? "status-locked" : "status-unlocked");
  chip.title = locked
    ? "Saved IFS credentials are locked — enter the master password in the Unlock field."
    : "Saved IFS credentials are unlocked for this browser session.";
}

async function unlock() {
  const field = document.getElementById("unlockPassword");
  if (!field.value) return;
  const response = await actionOrShowError({ type: "UNLOCK", masterPassword: field.value });
  field.value = "";
  if (response) refreshLockStatus();
}

const unlockBtnEl = document.getElementById("unlockBtn");
if (unlockBtnEl) unlockBtnEl.addEventListener("click", unlock);
const unlockPasswordEl = document.getElementById("unlockPassword");
if (unlockPasswordEl) unlockPasswordEl.addEventListener("keydown", (e) => { if (e.key === "Enter") unlock(); });

/** Why Create/Activate can't run right now ("" when it can), from a GET_DESIGNER_STATUS response.
 *  Shared by the Projection Tracker and Quick Reports so both explain it the same way. */
function designerBlockReason(designer) {
  if (!designer.open) return "No Flow Designer tab active — switch to the Designer tab of the flow (Create/Activate act on it).";
  if (!designer.hasFlowToken) return "Designer tab found, but no Flow session yet — click anywhere in the Designer tab once.";
  return "";
}

/** The one way any panel creates the Flow module for an IFS projection and activates it in the
 *  open Designer flow. The Projection Tracker and Quick Reports both call this, so the module flow
 *  is the same everywhere. */
function createAndActivateModule(baseUrl, projectionName) {
  return actionOrShowError({ type: "CREATE_MODULE", baseUrl, projectionName, masterPassword: masterPasswordOf() });
}

/** A user-initiated request: clears any previous action error first, and keeps its own error
 *  visible (sticky) instead of letting the next background poll wipe it. */
function actionOrShowError(message) {
  clearError(true);
  return sendOrShowError(message, true);
}

/** Runs one action with immediate visual feedback: the button that triggered it shows its
 *  in-progress label and disables right away, before the network round-trip even starts — "No
 *  visual updates on what's happening" was a real gap, not just a perception problem. */
function runAction(btn, busyLabel, action) {
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyLabel;
  action()
    .catch(() => {}) // sendOrShowError already surfaced the error in the banner
    .finally(() => {
      btn.textContent = originalLabel;
      refreshProjections();
    });
}
