// "Export for LLM" of the Flow dependency results: one Markdown file with an instruction block (the user writes
// what the LLM should produce), how to read the data, the chains grouped per Flow package and automation, and the
// same data as JSON. Pure functions, no IFS or Flow calls.
(function (root) {
  const FlowDeps = typeof require === "function" && typeof module !== "undefined" ? require("./flow-deps.js") : root.FlowDeps;

  /** One node as a plain object an LLM can read: no raw IFS rows, only the fields that carry meaning. */
  function describeNode(node) {
    const d = node.data || {};
    switch (node.type) {
      case "event": return { type: "event", eventId: d.eventId, entity: d.eventLuName };
      case "eventAction": return { type: "eventAction", actionType: d.actionType, actionNumber: d.actionNumber, enabled: d.enabled, published: d.published, bpaKey: d.matchedVia && d.matchedVia.type === "bpa" ? d.matchedVia.processKey : undefined };
      case "workflow": return { type: "workflow", processKey: d.processKey, version: d.version, task: d.matchedVia && d.matchedVia.taskName, calls: d.matchedVia && d.matchedVia.url };
      case "routingRule": return { type: "routingRule", name: d.ruleName, queue: d.queue, messageFunctions: d.messageFunctions, enabled: d.enabled };
      case "routingAddress": return { type: "routingAddress", name: d.addressName, restRootEndPoint: d.restRootEndPoint };
      case "pageCommand": return { type: "pageCommand", name: d.name || d.dataId, page: d.modelId };
      case "endpoint": return { type: "endpoint", url: d.url };
      default: return { type: node.type };
    }
  }

  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  const nodeText = (n) => {
    switch (n.type) {
      case "event": return `Event ${n.eventId}${n.entity ? ` (${n.entity})` : ""}`;
      case "eventAction": return `Event action ${n.actionType || ""}${n.bpaKey ? ` ${n.bpaKey}` : ""}${n.enabled === false ? " [NOT ENABLED]" : ""}${n.published === false ? " [NOT PUBLISHED]" : ""}`.trim();
      case "workflow": return `Workflow ${n.processKey} v${n.version}${n.task ? ` task "${n.task}"` : ""}`;
      case "routingRule": return `Routing rule ${n.name}${n.queue ? ` (queue ${n.queue}${n.messageFunctions && n.messageFunctions.length ? `, message function ${n.messageFunctions.join("/")}` : ""})` : ""}${n.enabled === false ? " [NOT ENABLED]" : ""}`;
      case "routingAddress": return `Routing address ${n.name}${n.restRootEndPoint ? ` -> ${n.restRootEndPoint}` : ""}`;
      case "pageCommand": return `Page command ${n.name}${n.page ? ` on ${n.page}` : ""}`;
      case "endpoint": return `Endpoint ${n.url || "(unknown)"}`;
      default: return n.type;
    }
  };

  /** `result` = a stored scan result, `flowIndex` = the Flow index (or null), `instanceName` = the IFS installation. */
  function buildLlmExport({ result, flowIndex, instanceName = "" }) {
    const blocks = FlowDeps.groupChainsByAutomation(result.chains, flowIndex);
    const packages = new Map();
    for (const block of blocks) {
      const pkg = (block.target && block.target.packageName) || (block.target ? "(App Library)" : /run\.novacura\.com|app\.novacura\.com/i.test(block.urls.join(" ")) ? "(Flow asset not found)" : "(not Novacura Flow)");
      if (!packages.has(pkg)) packages.set(pkg, []);
      packages.get(pkg).push(block);
    }
    const data = [...packages.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, list]) => ({
      package: name,
      automations: list.map((b) => ({
        name: b.target ? (b.target.automationName || b.target.assetName) : null,
        flow: b.target ? b.target.assetName : null,
        endpoints: b.urls,
        chains: b.chains.map((c) => c.nodes.map((n) => clean(describeNode(n))))
      }))
    }));

    const out = [];
    out.push("# Novacura Flow dependency data for LLM documentation", "");
    out.push("The user gives you the task in the chat. Use this file as the source data for it.", "");
    out.push("## How to read this data", "");
    out.push(
      "- The data comes from an IFS Cloud installation scan by the Novacura Buddy extension: it finds everything in IFS that calls Novacura Flow (run.novacura.com / app.novacura.com or other addresses).",
      "- A chain is one path from an IFS trigger to Flow: Event -> Event action -> (Workflow) -> (Routing rule -> Routing address) -> Endpoint. Application-message event actions go through a routing rule and routing address; BPA event actions go through a workflow that calls Flow. Page commands call workflows from client pages.",
      "- Chains are grouped by the Flow package and automation the endpoint belongs to (matched by the automation's webhook address). Chains whose endpoint matches no automation are listed under their own groups.",
      "- [NOT ENABLED] / [NOT PUBLISHED] mean the event action or routing rule exists but will not fire.",
      "- Do not invent anything that is not in the data; say what is unknown. The same data follows as JSON at the end.", "");
    out.push("## Scan", "", `- IFS installation: ${instanceName || result.baseUrl || "(unknown)"}`, `- Scanned: ${new Date(result.scannedAt).toISOString()}`, `- Searched for: ${(result.patterns || []).join(", ")}`, `- Chains: ${result.chains.length}`, "");
    out.push("## Dependencies per package and automation", "");
    for (const p of data) {
      out.push(`### Package: ${p.package}`, "");
      for (const a of p.automations) {
        out.push(`#### ${a.name ? `Automation: ${a.name}` : "Endpoint"}${a.flow && a.flow !== a.name ? ` (flow ${a.flow})` : ""}`, "");
        if (a.endpoints.length) out.push(`Endpoint(s): ${a.endpoints.join(", ")}`, "");
        a.chains.forEach((c, i) => out.push(`${i + 1}. ${c.map(nodeText).join(" -> ")}`));
        out.push("");
      }
    }
    const errors = result.errors || [];
    if (errors.length) out.push("## Parts the scan could not read", "", ...errors.map((e) => `- ${e.step} · ${e.item}: ${e.message}`), "");
    out.push("## Data as JSON", "", "```json", JSON.stringify(data, null, 1), "```", "");
    return out.join("\n");
  }

  const api = { describeNode, buildLlmExport };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.FlowDepsExport = api;
})(typeof window !== "undefined" ? window : globalThis);
