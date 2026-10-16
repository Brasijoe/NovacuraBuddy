// Injected into build.novacura.com. Best-effort, unverified selector — see
// docs/superpowers/specs/2026-10-16-projection-tracker-design.md §9/§10.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "CLICK_REFRESH") return;

  try {
    const candidate =
      document.querySelector('[data-testid="refresh-button"]') ||
      document.querySelector('button[title="Refresh"]') ||
      document.querySelector('button[aria-label="Refresh"]');

    if (candidate) {
      candidate.click();
      sendResponse({ clicked: true });
    } else {
      sendResponse({ clicked: false });
    }
  } catch (e) {
    sendResponse({ clicked: false });
  }
});
