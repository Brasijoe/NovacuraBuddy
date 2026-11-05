// Direct links into the IFS web client (Aurena) for objects the tools show. The page address is
// {installation}/main/ifsapplications/web/page/{Page}/{View};$filter={Key} eq '{value}'; the long path= and
// record= parts IFS adds when navigating only restore the navigation state (confirmed for routing addresses).
(function (root) {
  const PAGES = {
    routingAddress: { page: "RoutingAddresses", view: "RoutingAddressPage", key: "AddressName", value: (d) => d.addressName || d.name },
    routingRule: { page: "RoutingRules", view: "RoutingRulePage", key: "RuleName", value: (d) => d.ruleName || d.name }
  };

  /** The IFS web client address of an object, or null for a type without a known page. */
  function ifsObjectUrl(baseUrl, type, data) {
    const spec = PAGES[type];
    const value = spec && data ? spec.value(data) : null;
    if (!spec || !value || !baseUrl) return null;
    const origin = String(baseUrl).replace(/\/+$/, "");
    return `${origin}/main/ifsapplications/web/page/${spec.page}/${spec.view};$filter=${spec.key}%20eq%20'${encodeURIComponent(String(value).replace(/'/g, "''")).replace(/%27/g, "'")}'`;
  }

  const api = { ifsObjectUrl, PAGES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.IfsLinks = api;
})(typeof window !== "undefined" ? window : globalThis);
