(function (global) {
  // Postman collection (v2.1) from the command of a Flow REST step ({ type: "rest-call", method,
  // urlExpression, headers: [{ include, name, valueTemplate }], bodyType, bodyExpression, connector }),
  // with the flow's variables written in. The connector's base URL and credentials are not part of the
  // step: the URL starts with a collection variable per connector, auth is left to Postman.
  // Pure text work: nothing is sent anywhere.

  const SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";
  const PATH = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/;

  /** A value as the test panel / Variables tab writes it ("text", 12, null, true, Date("...")) -> JS value. */
  function fromLiteral(raw) {
    const t = raw === undefined || raw === null ? "null" : String(raw).trim();
    if (t === "null" || t === "") return null;
    let m = /^"([\s\S]*)"$/.exec(t);
    if (m) return m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return Number(t);
    if (t === "true" || t === "false") return t === "true";
    m = /^Date\("([^"]*)"\)$/.exec(t);
    if (m) return m[1];
    return t;
  }

  /** { "Rec__field": literal } -> lookup("Rec.field") -> { found, value } (names ignore case). */
  function makeLookup(rawValues) {
    const map = new Map(Object.entries(rawValues || {}).map(([k, v]) => [k.toLowerCase(), v]));
    return (path) => {
      const key = String(path).split(".").join("__").toLowerCase();
      return map.has(key) ? { found: true, value: fromLiteral(map.get(key)) } : { found: false };
    };
  }

  const varName = (path) => String(path).replace(/\./g, "_");

  /** "{AnalyzeUrl}/x?id={Rec.id}" with the values written in; an expression that is not a known
   *  variable becomes a Postman variable {{name}}. */
  function fillTemplate(template, lookup) {
    return String(template || "").replace(/\{([^{}]+)\}/g, (all, expr) => {
      const e = expr.trim();
      if (!PATH.test(e)) return `{{${e}}}`;
      const hit = lookup(e);
      return hit.found ? (hit.value === null ? "" : String(hit.value)) : `{{${varName(e)}}}`;
    });
  }

  /** A JSON-like record expression (bodyType "jsonSerialized") with variable paths outside strings
   *  replaced by their values as JSON; unknown ones become "{{name}}". Pretty-printed when it parses. */
  function jsonBody(expr, lookup) {
    const text = String(expr || "");
    let out = "";
    for (let i = 0; i < text.length;) {
      const c = text[i];
      if (c === '"') { // a string literal stays as written
        let j = i + 1;
        while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
        out += text.slice(i, j + 1); i = j + 1; continue;
      }
      const m = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*/.exec(text.slice(i));
      if (m && !/[\w.]/.test(text[i - 1] || "")) {
        const word = m[0];
        if (/^(true|false|null)$/.test(word)) out += word;
        else { const hit = lookup(word); out += hit.found ? JSON.stringify(hit.value) : JSON.stringify(`{{${varName(word)}}}`); }
        i += word.length; continue;
      }
      out += c; i++;
    }
    try { return { text: JSON.stringify(JSON.parse(out), null, 2), json: true }; } catch { return { text: out.trim(), json: false }; }
  }

  /** The request body of a REST command, or null for none. */
  function requestBody(cmd, lookup) {
    const expr = String(cmd.bodyExpression || "").trim();
    if (!expr) return null;
    if (cmd.bodyType === "jsonSerialized") return jsonBody(expr, lookup);
    if (cmd.bodyType === "textFromVariable") {
      const hit = PATH.test(expr) ? lookup(expr) : { found: false };
      const text = hit.found ? (hit.value === null ? "" : typeof hit.value === "string" ? hit.value : JSON.stringify(hit.value)) : `{{${varName(expr)}}}`;
      let json = false;
      try { JSON.parse(text); json = true; } catch { /* plain text */ }
      return { text, json };
    }
    return { text: fillTemplate(expr, lookup), json: false };
  }

  const baseVar = (connector) => `baseUrl_${String((connector && connector.name) || "connector").replace(/[^\w]+/g, "_")}`;

  /** One Postman request item for a REST step. */
  function requestItem(label, cmd, rawValues) {
    const lookup = makeLookup(rawValues);
    let url = fillTemplate(cmd.urlExpression, lookup);
    if (!/^https?:\/\//i.test(url) && !/^\{\{/.test(url)) url = `{{${baseVar(cmd.connector)}}}/${url.replace(/^\/+/, "")}`;
    const header = (cmd.headers || []).filter((h) => h && h.include !== false && h.name)
      .map((h) => ({ key: h.name, value: fillTemplate(h.valueTemplate, lookup), type: "text" }));
    const request = { method: String(cmd.method || "get").toUpperCase(), header, url: { raw: url } };
    const body = requestBody(cmd, lookup);
    if (body) request.body = { mode: "raw", raw: body.text, ...(body.json ? { options: { raw: { language: "json" } } } : {}) };
    const connector = cmd.connector ? `Connector: ${cmd.connector.name}. ` : "";
    request.description = `${connector}From the Flow step "${label}". Set the connector's base URL variable and its authentication in Postman.`;
    return { name: label, request };
  }

  /** A Postman collection (v2.1) with one request per step: steps [{ label, command }]. */
  function buildCollection(name, steps, rawValues) {
    const items = steps.map((s) => requestItem(s.label, s.command, rawValues));
    const vars = new Map();
    for (const s of steps) if (s.command.connector || !/^https?:/i.test(s.command.urlExpression || "")) vars.set(baseVar(s.command.connector), "");
    for (const it of items) {
      const all = JSON.stringify(it.request);
      for (const m of all.matchAll(/\{\{([\w.]+)\}\}/g)) if (!vars.has(m[1])) vars.set(m[1], "");
    }
    return {
      info: { name, schema: SCHEMA, description: "Generated by Novacura Buddy from a Flow REST step." },
      item: items,
      variable: [...vars].map(([key, value]) => ({ key, value }))
    };
  }

  /** The "Request" section of a logged HTTP call as the Diagnostic panel shows it:
   *    Type: GET / Url: https://... / Sent: ... / Headers: (one "\tName:value" per line) / Body: ... (or "-")
   *  -> { method, url, headers: [{ name, value }], body: string|null }. */
  function parseLoggedRequest(text) {
    const lines = String(text || "").replace(/\r/g, "").split("\n");
    const out = { method: "GET", url: "", headers: [], body: null };
    let mode = "";
    const bodyLines = [];
    for (const line of lines) {
      if (mode === "body") { bodyLines.push(line); continue; }
      let m;
      if ((m = /^Type:\s*(.*)$/.exec(line))) out.method = m[1].trim().toUpperCase() || "GET";
      else if ((m = /^Url:\s*(.*)$/.exec(line))) out.url = m[1].trim();
      else if (/^Headers:\s*$/.test(line)) mode = "headers";
      else if ((m = /^Body:\s?(.*)$/.exec(line))) { mode = "body"; bodyLines.push(m[1]); }
      else if (mode === "headers" && (m = /^\s+([^:\s][^:]*):(.*)$/.exec(line))) out.headers.push({ name: m[1].trim(), value: m[2].trim() });
    }
    const body = bodyLines.join("\n").trim();
    out.body = body === "" || body === "-" ? null : body;
    return out;
  }

  /** A URL as Postman's import reads it: { raw, protocol, host: [..], port?, path: [..], query: [{ key, value }] }.
   *  Parsed by hand: the text stays as logged (spaces and quotes unencoded; Postman encodes on send). */
  function postmanUrl(raw) {
    const url = String(raw || "").trim();
    const m = /^(?:([A-Za-z][\w+.-]*):\/\/)?([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#.*)?$/.exec(url);
    if (!m) return { raw: url };
    const [, protocol, authority, path, query] = m;
    const hp = /^(.*?)(?::(\d+))?$/.exec(authority);
    const out = { raw: url };
    if (protocol) out.protocol = protocol;
    out.host = hp[1] ? hp[1].split(".") : [];
    if (hp[2]) out.port = hp[2];
    out.path = path.split("/").filter(Boolean);
    if (query !== undefined) {
      out.query = query.split("&").filter(Boolean).map((pair) => {
        const i = pair.indexOf("=");
        return i < 0 ? { key: pair, value: null } : { key: pair.slice(0, i), value: pair.slice(i + 1) };
      });
    }
    return out;
  }

  /** A Postman collection (v2.1) with the one request of a logged HTTP call. A header value the log
   *  masks ("*****") becomes a Postman variable {{header-name}} (Authorization: "Bearer {{token}}"). */
  function collectionFromLog(name, request) {
    const vars = new Map();
    const header = request.headers.map((h) => {
      let value = h.value;
      if (/\*{3,}/.test(value)) {
        const key = /^authorization$/i.test(h.name) ? "token" : h.name.toLowerCase().replace(/[^\w]+/g, "_");
        vars.set(key, "");
        value = value.replace(/\*{3,}/, `{{${key}}}`);
      }
      return { key: h.name, value, type: "text" };
    });
    const item = { name, request: { method: request.method, header, url: postmanUrl(request.url) } };
    if (request.body !== null) {
      let json = false;
      try { JSON.parse(request.body); json = true; } catch { /* plain text */ }
      item.request.body = { mode: "raw", raw: json ? JSON.stringify(JSON.parse(request.body), null, 2) : request.body, ...(json ? { options: { raw: { language: "json" } } } : {}) };
    }
    item.request.description = "From a call logged in the Flow client's Diagnostic panel. Masked headers are Postman variables: set them in the collection.";
    return { info: { name, schema: SCHEMA, description: "Generated by Novacura Buddy from a logged Flow HTTP call." }, item: [item], variable: [...vars].map(([key, value]) => ({ key, value })) };
  }

  const api = { postmanUrl, parseLoggedRequest, collectionFromLog, fromLiteral, fillTemplate, jsonBody, requestBody, requestItem, buildCollection };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.RestPostman = api;
})(typeof window !== "undefined" ? window : globalThis);
