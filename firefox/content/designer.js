// Injected into build.novacura.com Designer tabs. Clicks the Designer's own "reload document"
// button so a module the extension just added shows up without a full page reload.
// Real markup (2026-10-16, user-supplied DOM):
//   <app-refresh-button ...><button aria-label="Refresh" class="... disabled:text-disabled">
//     <app-colored-svg><div style="mask-image: url(&quot;assets/icons/arrows-clockwise.svg&quot;)"></div></app-colored-svg>
//   </button></app-refresh-button>
// The button can be disabled until the Designer notices the remote document changed — clicking it
// then does nothing — so this waits briefly for it to enable. The background falls back to a full
// tab reload when this reports clicked: false.
const WAIT_FOR_ENABLED_MS = 5000;
const POLL_MS = 250;

function findRefreshButton() {
  const candidates = [
    ...document.querySelectorAll("app-refresh-button button"),
    ...document.querySelectorAll('button[aria-label="Refresh"]'),
    ...[...document.querySelectorAll('[style*="arrows-clockwise.svg"]')].map((icon) => icon.closest("button"))
  ];
  return candidates.find((b) => b && b.offsetParent !== null) || null; // first visible one
}

async function clickRefreshWhenEnabled() {
  const deadline = Date.now() + WAIT_FOR_ENABLED_MS;
  for (;;) {
    const button = findRefreshButton();
    if (button && !button.disabled) {
      button.click();
      return { clicked: true };
    }
    if (Date.now() >= deadline) return { clicked: false, reason: button ? "button stayed disabled" : "button not found" };
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "CLICK_REFRESH") return;
  clickRefreshWhenEnabled()
    .then(sendResponse)
    .catch(() => sendResponse({ clicked: false, reason: "error" }));
  return true; // keep the channel open for the async response
});
