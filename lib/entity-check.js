(function (global) {
  // Entity Check: the IFS projections ("entities") a flow, a package or a whole organisation uses,
  // and whether each is enabled (Active) in an IFS instance. Pure helpers plus the IFS calls; the
  // background reads Flow. Reading is safe; the toggle is the only write (one projection, one click).
  const EXPLORER = "/main/ifsapplications/projection/v1/ProjectionExplorer.svc";
  const SELECT = "ProjectionName,Component,Active,Deprecated,Categories";
  const PROJECTION_URL = /\/([A-Za-z0-9_]+)\.svc\b/g;

  /** Projection names a text refers to (every `…/Name.svc` URL, which also covers a module's import source). */
  function namesInText(text) {
    const names = new Set();
    for (const m of String(text || "").matchAll(PROJECTION_URL)) names.add(m[1]);
    return [...names];
  }

  /** Adds one source's projection names to `usage` (Map name -> Set of where used). */
  function addUsage(usage, names, where) {
    for (const n of names) {
      if (!usage.has(n)) usage.set(n, new Set());
      usage.get(n).add(where);
    }
    return usage;
  }

  const flagOf = (v) => v === true || /^(true|1|y|yes|true_?)$/i.test(String(v));

  /** IFS row (or null) -> "enabled" | "disabled" | "missing". */
  function stateOf(row) {
    if (!row) return "missing";
    return flagOf(row.Active) ? "enabled" : "disabled";
  }

  /** usage: Map name -> Set(where); metaByName: { lowerName: row|null }; -> sorted result rows. */
  function buildRows(usage, metaByName) {
    return [...usage].map(([name, where]) => {
      const meta = metaByName[name.toLowerCase()] || null;
      return { projection: name, usedIn: [...where].sort(), state: stateOf(meta), deprecated: !!meta && flagOf(meta.Deprecated), component: meta ? meta.Component || "" : "" };
    }).sort((a, b) => a.projection.localeCompare(b.projection));
  }

  /** Realtime search: every word must occur in the name, the component, the state or a usage. */
  function matches(row, query) {
    const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const hay = `${row.projection} ${row.component} ${row.state} ${row.usedIn.join(" ")}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  }

  const q = (s) => String(s).replace(/'/g, "''");

  /** Reads the explorer rows of the given projections in chunks (one request per chunk). */
  async function readMeta(client, names, chunk = 15) {
    const out = {};
    for (let i = 0; i < names.length; i += chunk) {
      const filter = names.slice(i, i + chunk).map((n) => `tolower(ProjectionName) eq '${q(n.toLowerCase())}'`).join(" or ");
      const res = await client.get(`${EXPLORER}/ProjExplorerQuerySet?$filter=${encodeURIComponent(filter)}&$select=${SELECT}`);
      for (const row of res.value || []) out[String(row.ProjectionName).toLowerCase()] = row;
    }
    return out;
  }

  /** EXPERIMENTAL write (not confirmed by an IFS capture yet): PATCH Active on the explorer row,
   *  then read it back. Throws when IFS refuses or the flag did not change. */
  async function setActive(client, projection, active) {
    const key = `${EXPLORER}/ProjExplorerQuerySet(ProjectionName='${q(projection)}')`;
    const current = await client.getOData(key);
    const etag = current && (current["@odata.etag"] || current["@odata.etag".toLowerCase()]);
    await client.patchOData(key, { Active: !!active }, etag || "*");
    const after = (await readMeta(client, [projection]))[projection.toLowerCase()];
    if (stateOf(after) !== (active ? "enabled" : "disabled")) throw new Error(`IFS accepted the call but ${projection} is still ${stateOf(after)}. This write is not confirmed for your IFS version.`);
    return after;
  }

  const api = { namesInText, addUsage, stateOf, buildRows, matches, readMeta, setActive };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.EntityCheck = api;
})(typeof window !== "undefined" ? window : globalThis);
