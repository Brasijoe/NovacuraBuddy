(function (global) {
  // Flow dependency scanner: finds every IFS object that calls Novacura Flow (run.novacura.com /
  // app.novacura.com) and links them into chains Event -> Event Action -> Workflow -> Routing
  // Address -> Flow endpoint. Same pipeline as the HPHG Flow Mapper, with the HPHG keyword
  // replaced by the Flow hosts and the HPHG grouping replaced by grouping per Flow endpoint.
  // Read-only by construction: the scan only ever gets an object with get/getText.

  const FLOW_HOSTS = ["run.novacura.com", "app.novacura.com"];
  const PROJ = "/main/ifsapplications/projection/v1";
  const DIAGRAM_FETCH_CONCURRENCY = 5;
  const FLOW_URL_RE = /(?:https?:\/\/)?(?:run|app)\.novacura\.com(?:[/?#][^\s"'<>\\]*)?/gi;

  /** The Flow hosts named anywhere in a value (object values are searched as JSON). */
  function matchedHosts(value) {
    if (value === null || value === undefined) return [];
    const text = (typeof value === "string" ? value : JSON.stringify(value)).toLowerCase();
    return FLOW_HOSTS.filter((h) => text.includes(h));
  }

  /** Every Flow URL in a value, as written (scheme added when missing), without duplicates. */
  function findFlowUrls(value) {
    if (value === null || value === undefined) return [];
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const found = new Set();
    for (const m of text.match(FLOW_URL_RE) || []) {
      const url = m.replace(/[.,;:)\]}]+$/, "");
      found.add(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    }
    return [...found];
  }

  /** Group key for an endpoint: lower-case host + path, no query/fragment, no trailing slash. */
  function endpointKey(url) {
    try {
      const u = new URL(url);
      return (u.host + u.pathname).replace(/\/+$/, "").toLowerCase();
    } catch {
      return String(url).toLowerCase();
    }
  }

  function decodeXml(text) {
    return String(text)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&amp;/g, "&");
  }

  function attr(tagText, name) {
    const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tagText);
    return m ? decodeXml(m[2] !== undefined ? m[2] : m[3]) : null;
  }

  /** camunda:inputParameter name -> value (a string, or a key/value object for camunda:map). */
  function inputParameters(taskXml) {
    const params = {};
    const re = /<(?:[\w-]+:)?inputParameter\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?inputParameter>)/g;
    let m;
    while ((m = re.exec(taskXml))) {
      const name = attr(m[1], "name");
      if (!name) continue;
      const body = m[2] || "";
      if (/<(?:[\w-]+:)?map\b/.test(body)) {
        const entries = {};
        const entryRe = /<(?:[\w-]+:)?entry\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?entry>)/g;
        let e;
        while ((e = entryRe.exec(body))) {
          const key = attr(e[1], "key");
          if (key) entries[key] = decodeXml(e[2] || "").trim();
        }
        params[name] = entries;
      } else {
        params[name] = decodeXml(body).trim();
      }
    }
    return params;
  }

  /** The mapper's BPMN step without a DOM (the service worker has none): service tasks, calls via a
   *  matched Routing Address (indirect) and calls straight to a Flow URL (direct). A Flow URL that
   *  sits anywhere else in the diagram (a script, a non-service task) is a direct match too. */
  function parseBpmnDiagram(xml, routingAddressNames) {
    const indirectMatches = [];
    const directMatches = [];
    const serviceTasks = [];
    const addressNames = new Set(routingAddressNames || []);
    const taskRe = /<((?:[\w-]+:)?serviceTask)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
    const claimed = new Set();
    let m;
    while ((m = taskRe.exec(xml || ""))) {
      const taskId = attr(m[2], "id");
      const taskName = attr(m[2], "name");
      serviceTasks.push({ id: taskId, name: taskName });
      const params = inputParameters(m[3] || "");
      if (params.ifsBpaProjectionName === "RoutingAddressesHandling") {
        const addressName = params.ifsBpaProjectionParameters && params.ifsBpaProjectionParameters.AddressName;
        if (addressName && addressNames.has(addressName)) indirectMatches.push({ taskId, taskName, addressName });
      }
      const url = params.ifsBpaHttpConnectionUrl;
      if (typeof url === "string" && matchedHosts(url).length) {
        directMatches.push({ taskId, taskName, url, matchedHosts: matchedHosts(url) });
        for (const u of findFlowUrls(url)) claimed.add(u);
      }
    }
    for (const url of findFlowUrls(decodeXml(xml || ""))) {
      if (!claimed.has(url)) directMatches.push({ taskId: null, taskName: null, url, matchedHosts: matchedHosts(url) });
    }
    return { indirectMatches, directMatches, serviceTasks };
  }

  // The mapper's DataId heuristic (confirmed live 2026-08-24): the ProcessKey is everything after
  // "Workflow_", without a trailing "_<n>".
  const WORKFLOW_DATA_ID_PATTERN = /^command:.*Workflow_([A-Za-z0-9]+?)(?:_\d+)?$/;
  function extractWorkflowNameFromDataId(dataId) {
    const match = dataId ? WORKFLOW_DATA_ID_PATTERN.exec(dataId) : null;
    return match ? match[1] : null;
  }

  async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  }

  function endpointNode(hosts, url) {
    return { type: "endpoint", data: { matchedHosts: hosts || [], url: url || null } };
  }

  /** The mapper's chain builder: every matched object ends up in at least one chain. */
  function buildChains({ routingAddresses = [], workflows = [], eventActions = [], events = [], pageCommands = [] }) {
    const chains = [];
    let counter = 0;
    const add = (nodes) => chains.push({ id: `chain-${++counter}`, nodes });
    const eventByKey = new Map(events.map((e) => [`${e.eventLuName}::${e.eventId}`, e]));
    const routingAddressByName = new Map(routingAddresses.map((r) => [r.addressName, r]));
    const workflowsByProcessKey = new Map();
    for (const wf of workflows) {
      if (!workflowsByProcessKey.has(wf.processKey)) workflowsByProcessKey.set(wf.processKey, []);
      workflowsByProcessKey.get(wf.processKey).push(wf);
    }

    function workflowNodes(wf) {
      const nodes = [{ type: "workflow", data: wf }];
      if (wf.matchedVia.type === "indirect") {
        const ra = routingAddressByName.get(wf.matchedVia.addressName);
        if (ra) nodes.push({ type: "routingAddress", data: ra });
        nodes.push(endpointNode(ra ? ra.matchedHosts : [], ra ? ra.restRootEndPoint : null));
      } else {
        nodes.push(endpointNode(wf.matchedVia.matchedHosts, wf.matchedVia.url));
      }
      return nodes;
    }

    for (const action of eventActions) {
      const event = eventByKey.get(`${action.eventLuName}::${action.eventId}`) || null;
      const lead = [];
      if (event) lead.push({ type: "event", data: event });
      lead.push({ type: "eventAction", data: action });
      if (action.matchedVia.type === "bpa") {
        for (const wf of workflowsByProcessKey.get(action.matchedVia.processKey) || []) add([...lead, ...workflowNodes(wf)]);
      } else {
        const urls = findFlowUrls(action.raw);
        add([...lead, endpointNode(action.matchedVia.matchedHosts, urls[0] || null)]);
      }
    }

    for (const cmd of pageCommands) {
      for (const wf of workflowsByProcessKey.get(cmd.matchedProcessKey) || []) add([{ type: "pageCommand", data: cmd }, ...workflowNodes(wf)]);
    }

    // Nothing found is silently dropped: an uncalled workflow or routing address is a short chain.
    const reachedWorkflows = new Set(chains.flatMap((c) => c.nodes.filter((n) => n.type === "workflow").map((n) => n.data)));
    for (const wf of workflows) if (!reachedWorkflows.has(wf)) add(workflowNodes(wf));

    const reachedAddresses = new Set(chains.flatMap((c) => c.nodes.filter((n) => n.type === "routingAddress").map((n) => n.data.addressName)));
    for (const ra of routingAddresses) {
      if (!reachedAddresses.has(ra.addressName)) add([{ type: "routingAddress", data: ra }, endpointNode(ra.matchedHosts, ra.restRootEndPoint)]);
    }
    return chains;
  }

  /** Replaces the mapper's HPHG grouping: one group per Flow endpoint a chain calls. A chain
   *  whose endpoint URL can't be read goes to "unknown" — shown, never dropped. */
  function groupChainsByEndpoint(chains) {
    const groups = {};
    const unknown = [];
    for (const chain of chains) {
      const end = chain.nodes[chain.nodes.length - 1];
      const urls = end && end.type === "endpoint" && end.data.url ? findFlowUrls(end.data.url) : [];
      if (!urls.length) { unknown.push(chain); continue; }
      const keys = new Set(urls.map(endpointKey));
      for (const key of keys) (groups[key] = groups[key] || []).push(chain);
    }
    return { groups, unknown };
  }

  /** The scan itself. `ifs` needs only get(path) -> JSON and getText(path) -> string. */
  async function runScan({ ifs, onProgress = () => {} }) {
    const errors = [];

    onProgress("Routing addresses", 0, 1);
    const routingRaw = await ifs.get(`${PROJ}/RoutingAddressesHandling.svc/RoutingAddressSet`);
    const routingAddresses = (routingRaw.value || [])
      .map((row) => ({ keyref: row.keyref, addressName: row.AddressName, restRootEndPoint: row.RestRootEndPoint, matchedHosts: matchedHosts(row.RestRootEndPoint), raw: row }))
      .filter((r) => r.matchedHosts.length);
    onProgress("Routing addresses", 1, 1);

    onProgress("Workflows", 0, 1);
    const workflowsRaw = await ifs.get(`${PROJ}/WorkFlowBpmnHandling.svc/BpmnVersionSet`);
    // DeployStatus is Active / Inactive / Undeployed (live, 2026-08); only Active runs.
    const deployed = (workflowsRaw.value || []).filter((row) => row.DeployStatus === "Active");
    const addressNames = routingAddresses.map((r) => r.addressName);
    let done = 0;
    onProgress("Workflows", 0, deployed.length);
    const diagrams = await mapWithConcurrency(deployed, DIAGRAM_FETCH_CONCURRENCY, async (row) => {
      try {
        // Returns the raw BPMN XML as text, not JSON (confirmed live in the mapper).
        const xml = await ifs.getText(`${PROJ}/WorkFlowBpmnHandling.svc/BpmnVersionSet(ProcessKey='${encodeURIComponent(row.ProcessKey)}',Version='${encodeURIComponent(row.Version)}')/BpaDiagram`);
        return { row, parsed: parseBpmnDiagram(xml, addressNames) };
      } catch (err) {
        errors.push({ step: "Workflows", item: `${row.ProcessKey} v${row.Version}`, message: err.message });
        return { row, parsed: null };
      } finally {
        onProgress("Workflows", ++done, deployed.length);
      }
    });

    const workflows = [];
    for (const { row, parsed } of diagrams) {
      if (!parsed) continue;
      const base = { processKey: row.ProcessKey, version: row.Version, description: row.Description || null, serviceTasks: parsed.serviceTasks };
      const seen = new Set();
      for (const match of parsed.indirectMatches) {
        if (seen.has(`i:${match.addressName}`)) continue;
        seen.add(`i:${match.addressName}`);
        workflows.push({ ...base, matchedVia: { type: "indirect", addressName: match.addressName, taskName: match.taskName } });
      }
      for (const match of parsed.directMatches) {
        if (seen.has(`d:${match.url}`)) continue;
        seen.add(`d:${match.url}`);
        workflows.push({ ...base, matchedVia: { type: "direct", url: match.url, matchedHosts: match.matchedHosts, taskName: match.taskName } });
      }
    }

    onProgress("Event actions", 0, 1);
    const actionsRaw = await ifs.get(
      `${PROJ}/EventActionHandling.svc/FndEventActions` +
      "?$select=FndEventActionType,EventLuName,EventId,ActionNumber,BpaKey,SqlStatement,RestEndPoint,Url,ToEmail,CcEmail,BccEmail,AdditionalHeaderParams,QueryParams" +
      "&$expand=EventIdRef"
    );
    const matchedProcessKeys = new Set(workflows.map((w) => w.processKey));
    const eventActions = [];
    const events = new Map();
    for (const row of actionsRaw.value || []) {
      const { EventIdRef, ...raw } = row;
      let matchedVia = null;
      if (row.FndEventActionType === "BPA" && row.BpaKey && matchedProcessKeys.has(row.BpaKey)) {
        matchedVia = { type: "bpa", processKey: row.BpaKey };
      } else {
        const hosts = matchedHosts(raw);
        if (hosts.length) matchedVia = { type: "direct", matchedHosts: hosts };
      }
      if (!matchedVia) continue;
      eventActions.push({ eventLuName: row.EventLuName, eventId: row.EventId, actionNumber: row.ActionNumber, actionType: row.FndEventActionType, matchedVia, raw });
      if (EventIdRef) {
        events.set(`${row.EventLuName}::${row.EventId}`, { eventLuName: EventIdRef.EventLuName, eventId: EventIdRef.EventId, eventType: EventIdRef.EventType, ...EventIdRef });
      }
    }
    onProgress("Event actions", 1, 1);

    onProgress("Page commands", 0, 1);
    const pageCommands = [];
    try {
      const configRaw = await ifs.get(
        `${PROJ}/ConfigurationHandling.svc/ConfigModelData` +
        "?$filter=Status eq IfsApp.ConfigurationHandling.PageStatusEnum'Published' and Artifact eq 'command'"
      );
      for (const row of configRaw.value || []) {
        const name = extractWorkflowNameFromDataId(row.DataId);
        if (name && matchedProcessKeys.has(name)) {
          pageCommands.push({ modelId: row.ModelId, dataId: row.DataId, name: row.Name, layerNo: row.LayerNo, matchedProcessKey: name });
        }
      }
    } catch (err) {
      errors.push({ step: "Page commands", item: "ConfigModelData", message: err.message });
    }
    onProgress("Page commands", 1, 1);

    const chains = buildChains({ routingAddresses, workflows, eventActions, events: [...events.values()], pageCommands });
    return {
      chains,
      grouped: groupChainsByEndpoint(chains),
      errors,
      counts: { routingAddresses: routingAddresses.length, workflowsScanned: deployed.length, workflows: workflows.length, eventActions: eventActions.length, pageCommands: pageCommands.length },
      scannedAt: new Date().toISOString()
    };
  }

  const api = { FLOW_HOSTS, matchedHosts, findFlowUrls, endpointKey, parseBpmnDiagram, extractWorkflowNameFromDataId, mapWithConcurrency, buildChains, groupChainsByEndpoint, runScan };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.FlowDeps = api;
})(typeof window !== "undefined" ? window : globalThis);
