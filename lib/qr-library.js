(function (global) {
  const req = (path, name) => (typeof require === "function" ? require(path) : global[name]);
  const GhLibrary = req("./gh-library.js", "GhLibrary");
  const { slugify } = GhLibrary;

  function createQrLibrary({ token, repo, fetchImpl }) {
    const ghRepo = GhLibrary.createGhRepo({
      token, repo, fetchImpl,
      conflictMessage: "This report changed on GitHub since you loaded it — reload before saving."
    });
    const { treeEntries, readBlob, putFile, deleteFile } = ghRepo;

    /** slug → { sql: entry, json: entry } for files directly inside `prefix`. */
    function groupBySlug(entries, prefix) {
      const groups = {};
      for (const e of entries) {
        if (!e.path.startsWith(prefix)) continue;
        const m = e.path.slice(prefix.length).match(/^([^/]+)\.(sql|json)$/);
        if (!m) continue;
        (groups[m[1]] = groups[m[1]] || {})[m[2]] = e;
      }
      return groups;
    }

    const ownPrefix = (login) => `quick-reports/${login}/`;

    async function list(login) {
      const groups = groupBySlug(await treeEntries(), ownPrefix(login));
      const reports = await Promise.all(Object.entries(groups)
        .filter(([, g]) => g.sql && g.json)
        .map(async ([slug, g]) => {
          const [metaText, content] = await Promise.all([readBlob(g.json.sha), readBlob(g.sql.sha)]);
          const meta = JSON.parse(metaText);
          return {
            id: meta.id || slug, name: meta.name || slug, tags: meta.tags || [],
            createdAt: meta.createdAt, updatedAt: meta.updatedAt, content,
            sqlSha: g.sql.sha, jsonSha: g.json.sha
          };
        }));
      return reports.sort((a, b) => a.name.localeCompare(b.name));
    }

    async function save(login, input, knownReports) {
      const name = String(input.name || "").trim();
      if (!name) throw new Error("Name can't be empty.");
      const target = name.toLowerCase();
      if ((knownReports || []).some((r) => r.id !== input.id && String(r.name).trim().toLowerCase() === target)) {
        throw new Error(`A Quick Report named "${name}" already exists.`);
      }

      let id = input.id;
      if (!id) {
        const taken = new Set(Object.keys(groupBySlug(await treeEntries(), ownPrefix(login))));
        const base = slugify(name);
        id = base;
        for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
      }

      const now = new Date().toISOString();
      const createdAt = input.id && input.createdAt ? input.createdAt : now;
      const message = `${input.id ? "update" : "add"} QR: ${name}`;
      const tags = input.tags || [];
      const prefix = ownPrefix(login);

      const sqlSha = await putFile(`${prefix}${id}.sql`, input.content, input.id ? input.sqlSha : undefined, message);
      let jsonSha;
      try {
        jsonSha = await putFile(`${prefix}${id}.json`, JSON.stringify({ id, name, tags, createdAt, updatedAt: now }, null, 2), input.id ? input.jsonSha : undefined, message);
      } catch (err) {
        throw Object.assign(new Error(`The SQL was saved, but its name/tags file wasn't (${err.message}). Reload the report list, then save again.`), { code: "PARTIAL_SAVE" });
      }
      return { id, name, tags, createdAt, updatedAt: now, content: input.content, sqlSha, jsonSha };
    }

    async function moveUnowned(login) {
      const entries = await treeEntries();
      const flat = groupBySlug(entries, "quick-reports/");
      const own = groupBySlug(entries, ownPrefix(login));
      const moved = [];
      const skipped = [];
      for (const [slug, g] of Object.entries(flat).sort(([a], [b]) => a.localeCompare(b))) {
        if (own[slug] || !g.sql || !g.json) { skipped.push(slug); continue; }
        const message = `move QR to ${login}: ${slug}`;
        try {
          const [sqlText, jsonText] = await Promise.all([readBlob(g.sql.sha), readBlob(g.json.sha)]);
          await putFile(`${ownPrefix(login)}${slug}.sql`, sqlText, undefined, message);
          await putFile(`${ownPrefix(login)}${slug}.json`, jsonText, undefined, message);
          await deleteFile(g.sql.path, g.sql.sha, message);
          await deleteFile(g.json.path, g.json.sha, message);
        } catch (err) {
          throw new Error(`Moving "${slug}" failed — ${err.message}${moved.length ? ` (already moved: ${moved.join(", ")})` : ""}`);
        }
        moved.push(slug);
      }
      return { moved, skipped };
    }

    return { whoAmI: ghRepo.whoAmI, checkAccess: ghRepo.checkAccess, list, save, moveUnowned };
  }

  const api = { createQrLibrary, slugify };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.QrLibrary = api;
})(typeof window !== "undefined" ? window : globalThis);
