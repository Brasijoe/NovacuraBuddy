(function (global) {
  const req = (path, name) => (typeof require === "function" ? require(path) : global[name]);
  const GhLibrary = req("./gh-library.js", "GhLibrary");

  /** Manually created Custom LUs, one JSON file each, in the same data repo as Quick Reports.
   *  Create only (user decision 2026-10-20): a library LU is saved once and never overwritten. */
  function createClLibrary({ token, repo, fetchImpl }) {
    const ghRepo = GhLibrary.createGhRepo({ token, repo, fetchImpl, conflictMessage: "This Custom LU is already in the library." });
    const ownPrefix = (login) => `custom-lus/${login}/`;

    function ownFiles(entries, login) {
      const prefix = ownPrefix(login);
      return entries
        .filter((e) => e.path.startsWith(prefix) && /^[^/]+\.json$/.test(e.path.slice(prefix.length)))
        .map((e) => ({ id: e.path.slice(prefix.length, -".json".length), sha: e.sha }));
    }

    async function list(login) {
      const files = ownFiles(await ghRepo.treeEntries(), login);
      const lus = await Promise.all(files.map(async (f) => {
        const data = JSON.parse(await ghRepo.readBlob(f.sha));
        return { id: f.id, name: data.name, prompt: data.prompt, attributes: data.attributes || [] };
      }));
      return lus.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }

    async function create(login, lu) {
      const existing = await list(login);
      const target = lu.name.toLowerCase();
      if (existing.some((x) => String(x.name).toLowerCase() === target)) {
        throw Object.assign(new Error(`"${lu.name}" is already in the library — library LUs are saved once and not changed.`), { code: "EXISTS" });
      }
      const taken = new Set(existing.map((x) => x.id));
      const base = GhLibrary.slugify(lu.name, "lu");
      let id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
      const file = {
        name: lu.name,
        prompt: lu.prompt,
        attributes: lu.attributes.map(({ name, prompt, type, length }) => (type === "STRING" ? { name, prompt, type, length } : { name, prompt, type }))
      };
      await ghRepo.putFile(`${ownPrefix(login)}${id}.json`, JSON.stringify(file, null, 2), undefined, `add Custom LU: ${lu.name}`);
      return { id, ...file };
    }

    return { list, create };
  }

  const api = { createClLibrary };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.ClLibrary = api;
})(typeof window !== "undefined" ? window : globalThis);
