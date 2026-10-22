/* Full-tab overview of the Linked Flows tab (linked-flows.html, opened from the side panel's
 * Linked groups). Runs panels/linked-flows.js with LF_PAGE set: the groups render as a table,
 * the work views (sync preview, deploy, results) in the aside next to it. */

(function () {
  const org = new URLSearchParams(location.search).get("org");
  if (org) lf.orgId = org;
  lfPagePlaceholder();
  lfOnShow();
  setInterval(refreshLinkedFlowsState, 5000);
})();
