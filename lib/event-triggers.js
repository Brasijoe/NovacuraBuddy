(function (global) {
  // Event Triggers: links a Novacura Flow automation to an IFS event. Three objects are created in IFS:
  //   1. a routing address (REST sender) that calls the automation's endpoint,
  //   2. a routing rule (application message, message function = the event id, a queue) that sends to
  //      that address,
  //   3. an event action of type application message on the event.
  // The call sequences below are what the IFS web client sends (captured 2026-11-05 on IFS Cloud via
  // a fetch hook): every object is created through a "virtual" entity, patched, then saved by an action.
  // Nothing here deletes anything.
  const req = (path, name) => (typeof require === "function" ? require(path) : global[name]);
  const IfsClient = req("./ifs-client.js", "IfsClient");
  const FlowDeps = req("./flow-deps.js", "FlowDeps");
  const XmlToJsonFlat = req("./xml-to-json-flat.js", "XmlToJsonFlat");

  const BASE = "/main/ifsapplications/projection/v1";
  const RA = `${BASE}/RoutingAddressesHandling.svc`;
  const RR = `${BASE}/RoutingRulesHandling.svc`;
  const EA = `${BASE}/NewEventActionHandling.svc`;
  const CC = `${BASE}/ConnectConfigurationHandling.svc`;
  const CE = `${BASE}/CustomEventHandling.svc`;

  const DEFAULTS = { senderInstance: "REST_SENDER1", transformer: XmlToJsonFlat.NAME, queue: "NOTIFICATIONS", accessKeyHeader: "x-api-key" };
  const NAME_PREFIX = "Nc";
  // Used when the column length can't be read from the IFS $metadata: short enough for any IFS name column.
  const DEFAULT_MAX_NAME = 30;

  const quote = (v) => String(v).replace(/'/g, "''");

  /** "Nc" + the automation name in CamelCase, letters and digits only, cut to `max` characters.
   *  "send order mail" -> "NcSendOrderMail". */
  function objectName(automationName, max = DEFAULT_MAX_NAME) {
    const words = String(automationName || "").split(/[^A-Za-z0-9]+/).filter(Boolean);
    const camel = words.map((w) => w[0].toUpperCase() + w.slice(1)).join("");
    return (NAME_PREFIX + camel).slice(0, Math.max(NAME_PREFIX.length, max));
  }

  /** The column length of an entity property from an OData $metadata document, or null. */
  function maxLengthOf(metadataXml, entityType, property) {
    const type = new RegExp(`<EntityType\\b[^>]*\\bName="${entityType}"[^>]*>([\\s\\S]*?)</EntityType>`).exec(metadataXml || "");
    if (!type) return null;
    const prop = new RegExp(`<Property\\b[^>]*\\bName="${property}"[^>]*>`).exec(type[1]);
    const len = prop && /\bMaxLength="(\d+)"/.exec(prop[0]);
    return len ? Number(len[1]) : null;
  }

  /** One header per line, NAME=VALUE (the IFS routing address format; Johannes 2026-11-05). */
  function headersText(accessKeyHeader, accessKey) {
    return [`${accessKeyHeader || DEFAULTS.accessKeyHeader}=${accessKey}`, "Accept=*/*"].join("\r\n");
  }

  /** The event description Johannes asked for. */
  const actionDescription = (automationName) => `Call Automation ${automationName} in Nc flow`;

  async function exists(client, entitySet, keyField, value) {
    const res = await client.get(`${entitySet}?$select=${keyField}&$filter=${keyField} eq '${quote(value)}'&$top=1`);
    return !!(res.value && res.value.length);
  }

  /** What would be created, and what already exists (read-only). The name limits are read from
   *  IFS's own $metadata; if that fails the short default is used. */
  async function plan(client, input) {
    const lengthOf = async (svc, type, field) => {
      try { return maxLengthOf(await client.getText(`${BASE}/${svc}/$metadata`), type, field); } catch { return null; }
    };
    const maxAddressName = input.maxAddressName || await lengthOf("RoutingAddressesHandling.svc", "RoutingAddress", "AddressName");
    const maxRuleName = input.maxRuleName || await lengthOf("RoutingRulesHandling.svc", "RoutingRule", "RuleName");
    const addressName = objectName(input.automationName, maxAddressName || DEFAULT_MAX_NAME);
    const ruleName = objectName(input.automationName, maxRuleName || DEFAULT_MAX_NAME);
    const [addressExists, ruleExists, transformerExists] = await Promise.all([
      exists(client, `${RA}/RoutingAddressSet`, "AddressName", addressName),
      exists(client, `${RR}/RoutingRuleSet`, "RuleName", ruleName),
      exists(client, `${CC}/ConnectTransformerSet`, "InstanceName", input.transformer || DEFAULTS.transformer)
    ]);
    return { addressName, ruleName, addressExists, ruleExists, transformerName: input.transformer || DEFAULTS.transformer, transformerExists, description: actionDescription(input.automationName) };
  }

  /** Step 0: the XSLT transformer C_XML_TO_JSON_FLAT that turns the IFS message XML into flat JSON for the
   *  automation. Created once per IFS instance, never changed when it exists. The sequence is what the IFS
   *  web client sends on Transformers > New (captured 2026-11-25): virtual record, validate the file type,
   *  upload the XSLT as the file content, save, clean up. */
  async function createTransformer(client, { name = XmlToJsonFlat.NAME, fileName = XmlToJsonFlat.FILE_NAME, xslt = XmlToJsonFlat.XSLT } = {}) {
    const VS = `${CC}/NewConnectorVirtualSet`;
    await IfsClient.step("Create transformer", () => client.getOData(`${VS}/IfsApp.ConnectConfigurationHandling.NewConnectorVirtual_Default()`));
    const created = await IfsClient.step("Create transformer", () => client.postOData(VS, { InstanceName: name, ConnectGroup: "Transformers", TransformerInstanceTypes: "XslTransformer", FileName: fileName }));
    const key = created && created.Objkey;
    if (!key) throw new Error("IFS did not return a key for the new transformer.");
    const virtual = `${VS}(Objkey='${key}')`;
    const record = await IfsClient.step("Create transformer", () => client.getOData(virtual));
    let etag = (record && record["@odata.etag"]) || created["@odata.etag"];
    await IfsClient.step("Check transformer file", () => client.postOData(`${CC}/ValidateFileType`, { ConnectGroup: "Transformers", TransformerInstanceTypes: "XslTransformer", FileName: fileName }));
    const b64 = (t) => (typeof Buffer !== "undefined" ? Buffer.from(t, "utf8").toString("base64") : btoa(unescape(encodeURIComponent(t))));
    await IfsClient.step("Upload transformer XSLT", () => client.patchText(`${virtual}/FileContent`, xslt, etag, { "x-ifs-content-disposition": `filename=${b64(fileName)}` }));
    await IfsClient.step("Save transformer", () => client.postOData(`${virtual}/IfsApp.ConnectConfigurationHandling.NewConnectorVirtual_NewConnector`, {}, etag), { preferIfsMessage: true });
    await IfsClient.step("Save transformer", () => client.postOData(`${virtual}/IfsApp.ConnectConfigurationHandling.NewConnectorVirtual_CleanupVirtualEntity`, {}, etag));
  }

  /** Step 1: the routing address (virtual record, patch, save, then the transformer as a second step). */
  async function createRoutingAddress(client, { name, endpoint, method, accessKey, accessKeyHeader, senderInstance, transformer }) {
    const created = await IfsClient.step("Create routing address", () => client.post(`${RA}/RoutingAddressVirtualSet`,
      { AddressName: name, TransportConnector: "Rest", Zip: false, EnvelopeResponse: false, Customized: false }));
    const key = created.Objkey;
    if (!key) throw new Error("IFS did not return a key for the new routing address.");
    const virtual = `${RA}/RoutingAddressVirtualSet(Objkey='${key}')`;
    await IfsClient.step("Set routing address data", () => client.patchJson(virtual, {
      SenderInstance: senderInstance || DEFAULTS.senderInstance,
      RestRootEndPoint: endpoint,
      AuthenticationMethod: "None",
      AdditionalHeaders: headersText(accessKeyHeader, accessKey),
      RestHttpMethod: String(method || "POST").toUpperCase()
    }, "*"));
    const action = (n) => client.post(`${virtual}/IfsApp.RoutingAddressesHandling.RoutingAddressVirtual_${n}`, {});
    await IfsClient.step("Save routing address", () => action("NewRoutingAddress"), { preferIfsMessage: true });
    await IfsClient.step("Save routing address", () => action("SaveTransformers"));
    await IfsClient.step("Save routing address", () => action("CleanupVirtualEntity"));
    if (transformer !== null) await addTransformer(client, name, transformer || DEFAULTS.transformer);
  }

  /** The assistant cannot save the transformer with the address; IFS does it afterwards on the saved one. */
  async function addTransformer(client, addressName, transformer) {
    const virtual = await IfsClient.step("Add transformer", () => client.post(`${RA}/TransformersVirtualSet`, {}));
    if (virtual && virtual.Objkey) {
      await client.post(`${RA}/TransformersVirtualSet(Objkey='${virtual.Objkey}')/IfsApp.RoutingAddressesHandling.TransformersVirtual_CleanupVirtualEntity`, {});
    }
    await IfsClient.step("Add transformer", () => client.post(`${RA}/SaveTransformer`,
      { AddressName: addressName, Transformers: `INSTANCE_NAME=${transformer}^`, TransformerType: "" }));
  }

  /** The rule's destination address list (also used to repair an existing rule whose list lacks the address). */
  async function saveDestinationAddress(client, ruleName, addressName) {
    await IfsClient.step("Set destination address", () => client.post(`${RR}/SaveDestinationAddresses`,
      { Addresses: `ADDRESS_NAME=${addressName}^`, RouteRule: ruleName }));
  }

  /** Step 2: the routing rule: application message, message function = event id, the queue, to the address. */
  async function createRoutingRule(client, { name, queue, eventId, addressName }) {
    await IfsClient.step("Create routing rule", () => client.post(`${RR}/RoutingRuleSet`,
      { RuleName: name, Direction: "Outbound", RouteType: "APPLICATION_MESSAGE", Enabled: true, Queue: queue || DEFAULTS.queue }));
    await IfsClient.step("Set message function condition", () => client.post(`${RR}/SaveContentBasedCondition`,
      { RuleName: name, SeqNo: null, SearchPath: "MESSAGE_FUNCTION", Op: "Equal", MatchQueryExpr: eventId, CrudAction: "New" }));
    await saveDestinationAddress(client, name, addressName);
  }

  /** Step 3: the event action (type application message) on the event, enabled and published. */
  async function createEventAction(client, { eventLuName, eventId, description }) {
    const created = await IfsClient.step("Create event action", () => client.post(`${EA}/NewEventActionVirtualSet`,
      { ActionEnable: false, Published: false, VisitedStep: false, EventId: eventId, EventLuName: eventLuName }));
    const key = created.Objkey;
    if (!key) throw new Error("IFS did not return a key for the new event action.");
    const virtual = `${EA}/NewEventActionVirtualSet(Objkey='${key}')`;
    await IfsClient.step("Create event action", () => client.post(`${EA}/GetId`, { EventLuName: eventLuName, EventId: eventId, Objkey: key }));
    // The same one-field patches the web client sends, in its order.
    for (const patch of [{ FndEventActionType: "ApplicationMessage" }, { Description: description }, { VisitedStep: true }, { ActionEnable: true }, { Published: true }]) {
      await IfsClient.step("Set event action data", () => client.patchJson(virtual, patch, "*"));
    }
    await IfsClient.step("Save event action", () => client.post(`${EA}/CreateNewEventAction`, { EventLuName: eventLuName, EventId: eventId, Objkey: key }));
    await IfsClient.step("Save event action", () => client.post(`${virtual}/IfsApp.NewEventActionHandling.NewEventActionVirtual_CleanupVirtualEntity`, {}));
  }


  /* --- Event variables: the automation's input variables mapped to columns of the IFS event --- */

  /** The single variables of a Flow input type expression `{ orderNo: text, optional qty: number }`:
   *  [{ name, type, optional }]. Only the top level of the record is read; anything else gives []. */
  function parseInputVariables(typeExpression) {
    const text = String(typeExpression || "").trim();
    if (!text.startsWith("{") || !text.endsWith("}")) return [];
    const inner = text.slice(1, -1);
    const parts = [];
    let depth = 0, start = 0, quote = null;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (quote) { if (c === quote && inner[i - 1] !== "\\") quote = null; continue; }
      if (c === '"' || c === "'") quote = c;
      else if ("{[(<".includes(c)) depth++;
      else if ("}])>".includes(c)) depth--;
      else if ((c === "," || c === ";") && depth === 0) { parts.push(inner.slice(start, i)); start = i + 1; }
    }
    parts.push(inner.slice(start));
    const vars = [];
    for (const part of parts) {
      const m = /^\s*(optional\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]+?)\s*$/.exec(part);
      if (m) vars.push({ name: m[2], type: m[3].replace(/\s+/g, " "), optional: !!m[1] });
    }
    return vars;
  }

  /** The automation's input variables, read from its designer data (GET only). */
  async function listAutomationInputs({ flowFetch, orgId, automationId }) {
    const res = await flowFetch(`${APP}/${orgId}/items/${automationId}/designer`);
    if (!res.ok) throw new Error(`Flow did not return the automation's input (HTTP ${res.status}).`);
    const designer = await res.json();
    return { typeExpression: (designer && designer.parameterTypeExpression) || "{}", variables: parseInputVariables(designer && designer.parameterTypeExpression) };
  }

  const words = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  /** The column whose name fits an input variable best (customsDeclarationDate -> CUSTOMS_DECLARATION_DATE),
   *  or null. Exact match ignoring case and separators first, then the best word overlap (at least 60%). */
  function suggestColumn(variableName, columns) {
    const flat = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
    const exact = columns.find((c) => flat(c.name) === flat(variableName));
    if (exact) return exact.name;
    const w = new Set(words(variableName));
    if (!w.size) return null;
    let best = null, bestScore = 0;
    for (const c of columns) {
      const cw = new Set(words(c.name));
      const common = [...w].filter((x) => cw.has(x)).length;
      const score = common / Math.max(w.size, cw.size);
      if (score > bestScore) { best = c.name; bestScore = score; }
    }
    return bestScore >= 0.6 ? best : null;
  }

  const eventPath = (luName, id) => `${CE}/FndEvents(EventLuName='${quote(luName)}',EventId='${quote(id)}')`;
  const isOn = (v) => v === true || String(v).toLowerCase() === "true";

  /** The columns an IFS event can hand over: [{ name, dataType, old, new }] (old / new = already activated). */
  async function listEventColumns(client, luName, id, pageSize = 1000, maxPages = 20) {
    const columns = [];
    for (let page = 0; page < maxPages; page++) {
      const res = await client.get(`${eventPath(luName, id)}/DictionarySysColumnsArray?$select=EventLuName,EventId,ColumnName,OldValue,NewValue,DataType&$skip=${page * pageSize}&$top=${pageSize}`);
      const rows = res.value || [];
      for (const r of rows) columns.push({ name: r.ColumnName, dataType: r.DataType || "", old: isOn(r.OldValue), new: isOn(r.NewValue) });
      if (rows.length < pageSize) break;
    }
    return columns.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The event parameters that exist already: [{ id, plsqlMethod }]. */
  async function listEventParameters(client, luName, id) {
    const res = await client.get(`${eventPath(luName, id)}/FndEventParameterArray?$select=Id,PlsqlMethod`);
    return (res.value || []).map((r) => ({ id: r.Id, plsqlMethod: r.PlsqlMethod || "" }));
  }

  /** Maps flow input variables to event columns. For each { id, column, which: "OLD" | "NEW" }:
   *  1. the column's old/new value is switched ON if it is off (never switched off, other columns untouched),
   *  2. the custom event parameter `id` (type STRING, PlsqlMethod "&OLD:COLUMN" / "&NEW:COLUMN") is created.
   *  An existing parameter is never changed: one with the same method counts as done, a different one is
   *  reported at the end as an error. Captured from the IFS web client 2026-11-25 (Custom Events). */
  async function applyEventParameters(client, { eventLuName, eventId, mappings }) {
    const columns = new Map((await listEventColumns(client, eventLuName, eventId)).map((c) => [c.name, { ...c }]));
    const existing = new Map((await listEventParameters(client, eventLuName, eventId)).map((p) => [p.id, p.plsqlMethod]));
    const conflicts = [];
    for (const m of mappings) {
      const which = String(m.which).toUpperCase() === "OLD" ? "OLD" : "NEW";
      const col = columns.get(m.column);
      if (!col) throw new Error(`The event has no column ${m.column}.`);
      const method = `&${which}:${m.column}`;
      if (existing.has(m.id)) {
        if (existing.get(m.id) !== method) conflicts.push(`${m.id} already exists with ${existing.get(m.id) || "another method"}, not changed (wanted ${method})`);
        continue;
      }
      const needsOn = which === "OLD" ? !col.old : !col.new;
      if (needsOn) {
        await IfsClient.step(`Activate ${m.column}`, () => client.postOData(`${CE}/UpdateDetailsOnFndEventParameter`,
          { EventLuName: eventLuName, EventId: eventId, ColumnName: m.column, OldValue: col.old || which === "OLD", NewValue: col.new || which === "NEW", DataType: col.dataType }));
        if (which === "OLD") col.old = true; else col.new = true;
      }
      await IfsClient.step(`Create event parameter ${m.id}`, () => client.postOData(`${eventPath(eventLuName, eventId)}/FndEventParameterArray`,
        { EventLuName: eventLuName, EventId: eventId, Id: m.id, IdType: "STRING", PlsqlMethod: method, CurrentValue: false, NewValue: false }));
      existing.set(m.id, method);
    }
    if (conflicts.length) throw new Error(conflicts.join("; "));
  }

  /** Runs the three steps in order. An object that already exists is reused, never changed:
   *  returns [{ step, status: "created" | "exists" | "failed", error }]. Stops at the first failure
   *  (the next steps need the previous ones). */
  async function link(client, input, onStep = () => {}) {
    const p = await plan(client, input);
    const results = [];
    // `fix` runs on an object that exists already: only the parts IFS lets you change later (the address's
    // transformer, the rule's destination address), never the header data (name, endpoint, headers).
    const run = async (step, skip, fn, fix) => {
      if (skip && fix) {
        try { await fix(); results.push({ step, status: "updated" }); }
        catch (err) { results.push({ step, status: "failed", error: err.message }); onStep(results[results.length - 1]); return false; }
        onStep(results[results.length - 1]);
        return true;
      }
      if (skip) { results.push({ step, status: "exists" }); onStep(results[results.length - 1]); return true; }
      try { await fn(); results.push({ step, status: "created" }); onStep(results[results.length - 1]); return true; }
      catch (err) { results.push({ step, status: "failed", error: err.message }); onStep(results[results.length - 1]); return false; }
    };
    // The routing address needs its transformer, so it is created first (only when this instance lacks it).
    if (!await run("Transformer " + p.transformerName, p.transformerExists, () => createTransformer(client, { name: p.transformerName }))) return results;
    if (!await run("Routing address", p.addressExists, () => createRoutingAddress(client, { ...input, name: p.addressName }),
      () => addTransformer(client, p.addressName, input.transformer || DEFAULTS.transformer))) return results;
    if (!await run("Routing rule", p.ruleExists, () => createRoutingRule(client, { name: p.ruleName, queue: input.queue, eventId: input.eventId, addressName: p.addressName }),
      () => saveDestinationAddress(client, p.ruleName, p.addressName))) return results;
    if (!await run("Event action", false, () => createEventAction(client, { eventLuName: input.eventLuName, eventId: input.eventId, description: p.description }))) return results;
    const mappings = (input.mappings || []).filter((m) => m && m.id && m.column);
    if (mappings.length) await run("Event variables", false, () => applyEventParameters(client, { eventLuName: input.eventLuName, eventId: input.eventId, mappings }));
    return results;
  }

  /* --- Flow side: automations with an active webhook, and the access keys --- */

  const APP = "/admin/application/api/v2/organisations";
  // The automation service is a separate host from build.novacura.com (seen live in the Flow web app).
  const AUTOMATIONS_API = "https://api.novacura.com";

  /** Automations (products of type automation) of the given packages that have a webhook enabled in at
   *  least one environment: { automations: [{ id, name, packageId, packageName, endpoints: [{ envId, envName, envType, url }] }],
   *  checked, failures: ["name: reason"] } (failed settings reads are reported, not hidden).
   *  The webhook settings are read per automation (GET only):
   *  https://api.novacura.com/automations//api/v1/organizations/{org}/appPackages/{pkg}/apps/{id}/settings -> { <envId>: { webHook: { url, isEnabled } } }.
   *  `environments` is FlowEnvironments.listEnvironments' result. */
  async function listAutomations({ flowFetch, orgId, packages, environments, onProgress = () => {} }) {
    const envList = environments || [];
    const envById = new Map(envList.map((e) => [e.id, e]));
    const found = [];
    for (const pkg of packages) {
      const res = await flowFetch(`${APP}/${orgId}/packages/${pkg.id}/products`);
      if (!res.ok) continue;
      for (const p of (await res.json()) || []) if (String(p.type).toLowerCase() === "automation") found.push({ id: p.id, name: p.name, packageId: pkg.id, packageName: pkg.name });
    }
    let done = 0;
    const failures = [];
    onProgress(0, found.length);
    const withSettings = await FlowDeps.mapWithConcurrency(found, 6, async (a) => {
      try {
        // The Flow web app sends an X-EnvId header (an environment id) with this call, and the answer can
        // depend on it (seen live: asking with one environment returned only that one for some automations),
        // so every environment of the organisation is asked and the answers are merged; an enabled webhook wins.
        const settings = {};
        let lastError = "no environment to ask with";
        let answered = false;
        for (const env of envList) {
          const res = await flowFetch(`${AUTOMATIONS_API}/automations//api/v1/organizations/${orgId}/appPackages/${a.packageId}/apps/${a.id}/settings`, { headers: { "X-EnvId": env.id, Accept: "application/json" } });
          if (!res.ok) { lastError = `HTTP ${res.status}`; continue; }
          const text = await res.text();
          let body;
          try { body = JSON.parse(text); } catch { lastError = `not JSON: ${text.slice(0, 60).replace(/\s+/g, " ")}`; continue; }
          answered = true;
          for (const [envId, v] of Object.entries(body || {})) {
            const known = settings[envId];
            if (!known || (v && v.webHook && v.webHook.isEnabled && !(known.webHook && known.webHook.isEnabled))) settings[envId] = v;
          }
        }
        if (!answered) throw new Error(lastError);
        const hooks = Object.values(settings || {}).filter((v) => v && v.webHook && v.webHook.url).map((v) => v.webHook.url);
        const endpoints = Object.entries(settings || {})
          .filter(([, v]) => v && v.webHook && v.webHook.isEnabled && v.webHook.url)
          .map(([envId, v]) => { const env = envById.get(envId); return { envId, envName: env ? env.name : envId, envType: env ? env.type : "unknown", url: v.webHook.url }; })
          .sort((x, y) => x.envName.localeCompare(y.envName));
        return { ...a, endpoints, hooks };
      } catch (err) {
        failures.push(`${a.name}: ${err.message}`);
        return { ...a, endpoints: [] };
      } finally {
        onProgress(++done, found.length);
      }
    });
    const automations = withSettings.filter((a) => a.endpoints.length).sort((x, y) => x.packageName.localeCompare(y.packageName) || x.name.localeCompare(y.name));
    // Every webhook URL of every automation (enabled or not): the dependency tracer maps IFS callers to automations with it.
    const webhooks = withSettings.flatMap((a) => (a.hooks || []).map((url) => ({ url, automationId: a.id, automationName: a.name, packageId: a.packageId, packageName: a.packageName })));
    return { automations: automations.map(({ hooks, ...rest }) => rest), checked: found.length, failures, webhooks };
  }

  /** The access keys of the organisation (name, expiry, package, environment; the secret itself is never
   *  returned by Flow after creation). */
  async function listAccessKeys({ flowFetch, orgId }) {
    const res = await flowFetch(`/admin/authentication/api/v1/access-key/organizationId/${orgId}`);
    if (!res.ok) return [];
    return ((await res.json()) || []).map((k) => ({ id: k.id, name: k.name, expirationDate: k.expirationDate, packageId: k.packageId, environmentId: k.environmentId }));
  }

  /* --- IFS side lists --- */

  /** Queues a routing rule can use: [{ name, description }]. */
  async function listQueues(client) {
    const res = await client.get(`${RR}/Reference_ConnectQueue?$select=InstanceName,Description`);
    return (res.value || []).map((q) => ({ name: q.InstanceName, description: q.Description || "" })).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The events an event action can be created on: [{ luName, id, description }] (paged, newest pages first read in full). */
  async function listEvents(client, pageSize = 1000, maxPages = 40) {
    const events = [];
    for (let page = 0; page < maxPages; page++) {
      const res = await client.get(`${EA}/Reference_FndEvent?$select=EventLuName,EventId,EventDescription&$top=${pageSize}&$skip=${page * pageSize}`);
      const rows = res.value || [];
      for (const e of rows) events.push({ luName: e.EventLuName, id: e.EventId, description: e.EventDescription || "" });
      if (rows.length < pageSize) break;
    }
    return events.sort((a, b) => a.luName.localeCompare(b.luName) || a.id.localeCompare(b.id));
  }

  const api = { objectName, maxLengthOf, headersText, actionDescription, plan, parseInputVariables, listAutomationInputs, suggestColumn, listEventColumns, listEventParameters, applyEventParameters, createTransformer, createRoutingAddress, addTransformer, createRoutingRule, createEventAction, link, listAutomations, listAccessKeys, listQueues, listEvents, DEFAULTS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.EventTriggers = api;
})(typeof window !== "undefined" ? window : globalThis);
