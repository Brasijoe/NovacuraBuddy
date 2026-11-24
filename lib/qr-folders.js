(function (global) {
  /** Customer folders for the Quick Report list. Pure functions over a plain state object
   *    { folders: [{ id, name }], assign: { reportId: folderId }, collapsed: { folderId: true } }
   *  so they can be unit tested; load/save use chrome.storage.sync (follows the user across PCs),
   *  falling back to local storage when sync is unavailable. Reports stay untouched in GitHub:
   *  folders only decide how the list is grouped. */
  const KEY = "qrFolders";
  const empty = () => ({ folders: [], assign: {}, collapsed: {} });
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  const clone = (s) => ({ folders: s.folders.map((f) => ({ ...f })), assign: { ...s.assign }, collapsed: { ...s.collapsed } });

  function normalize(raw) {
    const s = empty();
    if (!raw || typeof raw !== "object") return s;
    for (const f of Array.isArray(raw.folders) ? raw.folders : []) {
      if (f && typeof f.id === "string" && typeof f.name === "string" && f.name.trim()) s.folders.push({ id: f.id, name: f.name.trim() });
    }
    const ids = new Set(s.folders.map((f) => f.id));
    for (const [rid, fid] of Object.entries(raw.assign || {})) if (ids.has(fid)) s.assign[rid] = fid;
    for (const [fid, v] of Object.entries(raw.collapsed || {})) if (v && ids.has(fid)) s.collapsed[fid] = true;
    s.folders.sort(byName);
    return s;
  }

  const nameTaken = (state, name, exceptId) =>
    state.folders.some((f) => f.id !== exceptId && f.name.toLowerCase() === name.trim().toLowerCase());

  /** Returns { state, folder }; throws on an empty or duplicate name. */
  function addFolder(state, name) {
    const clean = String(name || "").trim();
    if (!clean) throw new Error("Give the folder a name.");
    if (nameTaken(state, clean)) throw new Error(`A folder named "${clean}" already exists.`);
    const next = clone(state);
    const taken = new Set(next.folders.map((f) => f.id));
    let id = "f" + Date.now().toString(36);
    for (let n = 2; taken.has(id); n++) id = `f${Date.now().toString(36)}${n}`;
    const folder = { id, name: clean };
    next.folders.push(folder);
    next.folders.sort(byName);
    return { state: next, folder };
  }

  function renameFolder(state, id, name) {
    const clean = String(name || "").trim();
    if (!clean) throw new Error("Give the folder a name.");
    if (nameTaken(state, clean, id)) throw new Error(`A folder named "${clean}" already exists.`);
    const next = clone(state);
    const f = next.folders.find((x) => x.id === id);
    if (f) f.name = clean;
    next.folders.sort(byName);
    return next;
  }

  /** Deleting a folder never deletes reports: they go back to "No folder". */
  function deleteFolder(state, id) {
    const next = clone(state);
    next.folders = next.folders.filter((f) => f.id !== id);
    for (const [rid, fid] of Object.entries(next.assign)) if (fid === id) delete next.assign[rid];
    delete next.collapsed[id];
    return next;
  }

  /** folderId null/unknown = back to "No folder". */
  function moveReport(state, reportId, folderId) {
    const next = clone(state);
    if (folderId && next.folders.some((f) => f.id === folderId)) next.assign[reportId] = folderId;
    else delete next.assign[reportId];
    return next;
  }

  function setCollapsed(state, id, collapsed) {
    const next = clone(state);
    if (collapsed) next.collapsed[id] = true; else delete next.collapsed[id];
    return next;
  }

  /** [{ folder|null, reports }] — every folder (even empty ones unless `hideEmpty`), then the
   *  unfiled reports (folder null). Report order inside a group is kept. */
  function group(state, reports, { hideEmpty = false } = {}) {
    const out = state.folders.map((folder) => ({ folder, reports: reports.filter((r) => state.assign[r.id] === folder.id) }));
    const known = new Set(state.folders.map((f) => f.id));
    out.push({ folder: null, reports: reports.filter((r) => !known.has(state.assign[r.id])) });
    return hideEmpty ? out.filter((g) => g.reports.length) : out;
  }

  async function load() {
    for (const area of ["sync", "local"]) {
      try {
        const got = await chrome.storage[area].get(KEY);
        if (got[KEY]) return normalize(got[KEY]);
      } catch (e) { /* try the next area */ }
    }
    return empty();
  }

  async function save(state) {
    try { await chrome.storage.sync.set({ [KEY]: state }); return; } catch (e) { /* too big or no sync: keep it local */ }
    await chrome.storage.local.set({ [KEY]: state });
  }

  const api = { KEY, empty, normalize, addFolder, renameFolder, deleteFolder, moveReport, setCollapsed, group, load, save };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.QrFolders = api;
})(typeof window !== "undefined" ? window : globalThis);
