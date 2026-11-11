(function (global) {
  // "Scan org for Quick Report usage": finds which Flow flows call IFS Quick Reports. A flow calls
  // one through the generated QuickReports module, as `QuickReports.QuickReport_<id>(...)`; the
  // number is the IFS Quick Report id. Read-only: Flow GETs and one IFS OData read for the names.
  const CALL_RE = /\bQuickReport_(\d+)\b/g;

  /** The Quick Report ids (strings, no duplicates) a text calls. */
  function findQuickReportIds(text) {
    const ids = new Set();
    for (const m of String(text || "").matchAll(CALL_RE)) ids.add(m[1]);
    return [...ids];
  }

  async function pool(items, concurrency, fn) {
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  }

  const SCAN_STEPS = [
    { id: "packages", label: "Read packages" },
    { id: "lists", label: "Read flow lists" },
    { id: "flows", label: "Read flows" },
    { id: "names", label: "Look up Quick Report names in IFS" }
  ];

  const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: "base" });

  /** Scans every flow of an organisation (all packages and the App Library).
   *  flow = { listPackages(), listAssets(packageId|null), readFlowIds(flowId) -> string[] }
   *  readNames(ids) -> { [id]: description } (optional; a failure only leaves the names empty).
   *  Result: { scannedAt, flowCount, reports: [{ id, name, functionName, flows: [{ flowId, name, type,
   *  packageId, packageName }] }], errors } with the reports by id. */
  async function runScan({ flow, readNames, onProgress, concurrency = 4 }) {
    const progress = (step, current, total) => onProgress && onProgress(step, current, total);
    const errors = [];
    progress("packages", 0, 1);
    const packages = await flow.listPackages();
    progress("packages", 1, 1);
    const locations = [{ id: null, name: "App Library" }, ...packages];
    const flows = [];
    let done = 0;
    progress("lists", 0, locations.length);
    await pool(locations, concurrency, async (loc) => {
      try {
        for (const a of await flow.listAssets(loc.id)) {
          if (a.type !== "module") flows.push({ flowId: a.id, name: a.name, type: a.type, packageId: loc.id, packageName: loc.name });
        }
      } catch (e) { errors.push(`${loc.name}: ${e.message}`); }
      progress("lists", ++done, locations.length);
    });

    const usage = new Map(); // id -> flows
    done = 0;
    progress("flows", 0, flows.length);
    await pool(flows, concurrency + 2, async (f) => {
      try {
        for (const id of await flow.readFlowIds(f.flowId)) {
          if (!usage.has(id)) usage.set(id, []);
          usage.get(id).push(f);
        }
      } catch (e) { errors.push(`Flow ${f.name}: ${e.message}`); }
      progress("flows", ++done, flows.length);
    });

    let names = {};
    progress("names", 0, 1);
    if (readNames && usage.size) {
      try { names = (await readNames([...usage.keys()])) || {}; } catch (e) { errors.push(`Quick Report names: ${e.message}`); }
    }
    progress("names", 1, 1);

    const reports = [...usage.entries()].map(([id, list]) => ({
      id, name: names[id] || "", functionName: `QuickReport_${id}`,
      flows: list.slice().sort((a, b) => byName(a, b) || String(a.packageName).localeCompare(String(b.packageName)))
    })).sort((a, b) => Number(a.id) - Number(b.id));
    return { scannedAt: new Date().toISOString(), flowCount: flows.length, reports, errors };
  }

  /** IFS OData path reading the descriptions of the given Quick Report ids. */
  function namesPath(ids) {
    const filter = ids.map((id) => `QuickReportId eq ${id}`).join(" or ");
    return `/main/ifsapplications/projection/v1/QuickReportHandling.svc/QuickReportSet?$select=QuickReportId,Description&$filter=${encodeURIComponent(filter)}`;
  }

  /** Reads the names in chunks. ifsGet(path) -> OData body. */
  async function readNames(ifsGet, ids, chunk = 25) {
    const out = {};
    for (let i = 0; i < ids.length; i += chunk) {
      const body = await ifsGet(namesPath(ids.slice(i, i + chunk)));
      for (const row of (body && body.value) || []) out[String(row.QuickReportId).replace(/\.0+$/, "")] = row.Description || "";
    }
    return out;
  }

  const api = { SCAN_STEPS, findQuickReportIds, runScan, namesPath, readNames };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.QrUsage = api;
})(typeof self !== "undefined" ? self : globalThis);
