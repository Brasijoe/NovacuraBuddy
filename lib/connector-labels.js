/* ============================================================
   Connector labels — which connector each step of a flow uses, for the small
   labels the Flow Designer overlay draws above the steps (content/designer.js).
   Read-only: works on the flow's designer data, nothing is saved.
   A step uses a connector when its configuration carries a `connector` object
   ({ id, name, type }): Database, REST, PowerShell steps and so on.
   ============================================================ */
(function (global) {
  const FlowLinks = typeof require === "function" ? require("./flow-links.js") : global.FlowLinks;

  // Distinct, readable with white text on top (the label is drawn white on the colour).
  const PALETTE = ["#0c65f4", "#d9480f", "#2b8a3e", "#9c36b5", "#c2255c", "#0b7285", "#e67700", "#5f3dc4", "#364fc7", "#a61e4d", "#087f5b", "#862e9c"];

  function hashString(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = (Math.imul(h, 33) + text.charCodeAt(i)) >>> 0;
    return h;
  }

  /** The colour of a connector: the same connector gets the same colour in every flow. */
  function connectorColor(connector) {
    const key = String((connector && (connector.name || connector.id)) || "").toUpperCase();
    return PALETTE[hashString(key) % PALETTE.length];
  }

  function findConnectors(value, out, depth) {
    if (!value || typeof value !== "object" || depth > 12) return;
    if (Array.isArray(value)) { for (const v of value) findConnectors(v, out, depth + 1); return; }
    for (const [key, v] of Object.entries(value)) {
      if (key === "connector" && v && typeof v === "object" && (v.name || v.id)) out.set(v.id || v.name, { id: v.id || null, name: String(v.name || v.id), type: v.type || "" });
      else findConnectors(v, out, depth + 1);
    }
  }

  /** [{ id, label, connectors: [{ id, name, type, color }] }] for the steps of a designer document
   *  that use at least one connector, in the order the steps were created. */
  function stepConnectors(designerData) {
    const out = [];
    for (const e of FlowLinks.materialize(designerData && designerData.data).values()) {
      if (e.kind !== "step") continue;
      const found = new Map();
      findConnectors(e.configuration, found, 0);
      if (!found.size) continue;
      out.push({ id: e.id, label: e.label || (e.configuration && e.configuration.label) || "", connectors: [...found.values()].map((c) => ({ ...c, color: connectorColor(c) })) });
    }
    return out;
  }

  const api = { PALETTE, connectorColor, stepConnectors };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.ConnectorLabels = api;
})(typeof window !== "undefined" ? window : globalThis);
