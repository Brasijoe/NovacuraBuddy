// Runs in the Flow Designer page itself (MAIN world): the Designer's code editors are Monaco, whose
// text only the page can reach (the extension's content script lives in an isolated world and the
// editor draws just the lines on screen). On request, content/designer.js gets the full code of
// the visible code editors. Read-only: nothing is changed in the editors.
(() => {
  if (window.__novacuraBuddyMonacoHook) return;
  window.__novacuraBuddyMonacoHook = true;
  window.addEventListener("novacura-buddy-code-ask", () => {
    let editors = [];
    try {
      const m = window.monaco;
      editors = ((m && m.editor && m.editor.getEditors && m.editor.getEditors()) || [])
        .filter((e) => { const dom = e.getDomNode(); return dom && dom.offsetParent !== null && e.getModel(); })
        .map((e) => ({ uri: String(e.getModel().uri), language: e.getModel().getLanguageId(), text: e.getModel().getValue() }));
    } catch { /* leave empty */ }
    window.dispatchEvent(new CustomEvent("novacura-buddy-code-texts", { detail: JSON.stringify(editors) }));
  });
})();
