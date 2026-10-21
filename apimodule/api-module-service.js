/* ============================================================
   API Module Service — the background worker's part of the API
   Modules tab: fetching a spec (with the Basic Data instance's
   IFS token when the spec is served by a saved IFS instance) and
   saving the generated code as a module asset in the open flow's
   package (the same FlowModules path as "Create module").
   ============================================================ */
(function (global) {
  const IfsInstances = typeof require === "function" ? require("../lib/ifs-instances.js") : global.IfsInstances;
  const FlowModules = typeof require === "function" ? require("../lib/flow-modules.js") : global.FlowModules;

  /** GETs `url` and returns its text. A URL on a Basic Data IFS instance is fetched with that
   *  instance's IFS token (never a separate login); any other URL goes out with the browser's own
   *  cookies, so docs behind the user's SSO still load. The host permission for a non-IFS origin
   *  must already be granted (the panel asks from the click). */
  async function fetchSpec({ url, instanceStore, getMasterKey, fetchImpl }) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      throw new Error(`Not a valid URL: ${url}`);
    }
    if (parsed.protocol !== "https:") throw new Error("Only https:// URLs can be loaded. Download the file and use Upload instead.");
    const instance = IfsInstances.findInstanceForHost(await instanceStore.listInstances(), parsed.hostname);
    const headers = { Accept: "application/json, application/yaml, text/yaml, text/html;q=0.5, */*;q=0.1" };
    if (instance) {
      const token = await instanceStore.getIfsAuthToken(instance.baseUrl, await getMasterKey());
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await (fetchImpl || fetch)(parsed.href, { headers, credentials: instance ? "omit" : "include" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Loading ${parsed.href} failed (HTTP ${res.status})${body ? ": " + body.slice(0, 300) : ""}`);
    }
    return {
      text: await res.text(),
      url: res.url || parsed.href,
      contentType: (res.headers && res.headers.get && res.headers.get("content-type")) || "",
      instanceName: instance ? instance.name : null
    };
  }

  /** Finds or creates the module asset named `moduleName` in the package and commits `code` to it.
   *  Returns what the existing activate step needs. */
  async function saveModule({ flowFetch, orgId, packageId, moduleName, code, log }) {
    if (typeof moduleName !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(moduleName)) {
      throw new Error(`"${moduleName}" is not a valid module name (letters, digits and _ only, not starting with a digit) — nothing was changed.`);
    }
    if (typeof code !== "string" || !code.trim()) throw new Error("No module code was generated — nothing was changed.");
    const asset = await FlowModules.findOrCreateModule({ flowFetch, orgId, packageId, projectionName: moduleName });
    if (log) log("API module asset id =", asset.id, "— committing", code.length, "bytes of module code...");
    const newBranch = await FlowModules.commitModuleCode({ flowFetch, orgId, packageId, assetId: asset.id, flowScriptCode: code });
    return { assetId: asset.id, headVersionId: newBranch.headVersionId, projectionName: asset.name || moduleName };
  }

  const api = { fetchSpec, saveModule };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.ApiModuleService = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
