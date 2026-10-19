(function (global) {
  const API = "https://api.github.com";

  /** Same rule as the Electron app's qrFileStore.slugify, so existing files keep their ids. */
  function slugify(name) {
    const slug = String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return slug || "report";
  }

  // GitHub's contents/blobs APIs speak base64 of the raw bytes; btoa/atob alone would break on
  // anything outside Latin-1 (ä, €, …), so go through UTF-8 bytes explicitly.
  function utf8ToBase64(text) {
    let binary = "";
    for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  function base64ToUtf8(b64) {
    const binary = atob(String(b64).replace(/\s/g, ""));
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  }

  const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");

  function createQrLibrary({ token, repo, fetchImpl }) {
    const doFetch = fetchImpl || ((...args) => fetch(...args));
    let branchPromise = null;

    async function gh(method, path, body) {
      const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
      if (body) headers["Content-Type"] = "application/json";
      const res = await doFetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      if (res.ok) return res.status === 204 ? undefined : res.json();
      throw await toError(res, method, path);
    }

    async function toError(res, method, path) {
      if (res.status === 401) return new Error("GitHub token rejected — check it in Basic Data.");
      if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
        const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
        return new Error(`GitHub rate limit reached — try again after ${new Date(reset).toLocaleTimeString()}.`);
      }
      if ((res.status === 409 || res.status === 422) && path.includes("/contents/")) {
        return Object.assign(new Error("This report changed on GitHub since you loaded it — reload before saving."), { code: "CONFLICT" });
      }
      if (res.status === 404 && path === `/repos/${repo}`) return new Error(`No access to ${repo} (or it doesn't exist) — check the repo name and the token's permissions.`);
      const text = await res.text().catch(() => "");
      return new Error(`GitHub request failed (${method} ${path.split("?")[0]}, ${res.status})${text ? ": " + text : ""}`);
    }

    const whoAmI = async () => (await gh("GET", "/user")).login;
    const checkAccess = async () => { await branch(); };

    function branch() {
      if (!branchPromise) {
        branchPromise = gh("GET", `/repos/${repo}`).then((r) => r.default_branch).catch((e) => { branchPromise = null; throw e; });
      }
      return branchPromise;
    }

    async function treeEntries() {
      const tree = await gh("GET", `/repos/${repo}/git/trees/${encodeURIComponent(await branch())}?recursive=1`);
      return (tree.tree || []).filter((e) => e.type === "blob");
    }

    const readBlob = async (sha) => base64ToUtf8((await gh("GET", `/repos/${repo}/git/blobs/${sha}`)).content);

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

    async function putFile(path, text, sha, message) {
      const body = { message, content: utf8ToBase64(text), branch: await branch() };
      if (sha) body.sha = sha;
      return (await gh("PUT", `/repos/${repo}/contents/${encodePath(path)}`, body)).content.sha;
    }

    async function deleteFile(path, sha, message) {
      await gh("DELETE", `/repos/${repo}/contents/${encodePath(path)}`, { message, sha, branch: await branch() });
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

    return { whoAmI, checkAccess, list, save, moveUnowned };
  }

  const api = { createQrLibrary, slugify };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.QrLibrary = api;
})(typeof window !== "undefined" ? window : globalThis);
