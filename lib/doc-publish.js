/* ============================================================
   Publishes a documentation bundle as a secret GitHub Gist an LLM can fetch by link, and removes
   it again once it has expired (default 8 hours). A secret gist is unlisted, not private: anyone
   with the URL can read it, so the link is the secret and the expiry is what limits the exposure.
   GitHub has no expiry for gists; the extension deletes them itself (on a timer and at startup),
   so a gist outlives its time only while the browser is closed.
   The only write calls are creating the gist and deleting a gist this extension created.
   ============================================================ */
(function (global) {
  const API = "https://api.github.com";
  const KEY = "flowDocPublished"; // [{ gistId, name, url, rawUrl, createdAt, expiresAt }]
  const DEFAULT_HOURS = 8;

  const headers = (token) => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" });

  async function failWith(res, what) {
    const text = await res.text().catch(() => "");
    const hint = res.status === 404 || res.status === 403 || res.status === 401
      ? " — the GitHub token in Basic Data needs the \"gist\" permission (classic token: gist scope; fine-grained: Gists read and write)" : "";
    throw new Error(`${what} (${res.status})${hint}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }

  function createPublisher({ storage, fetchImpl, now }) {
    const doFetch = (...a) => (fetchImpl || fetch)(...a);
    const clock = () => (now ? now() : Date.now());
    const list = async () => (await storage.get(KEY))[KEY] || [];
    const save = (items) => storage.set({ [KEY]: items });

    /** files: { "llm-context.md": text, ... }. Returns the stored entry. */
    async function publish({ token, name, files, hours = DEFAULT_HOURS }) {
      const body = { description: `${name} — Novacura Buddy flow documentation (expires ${new Date(clock() + hours * 3600e3).toISOString()})`, public: false, files: {} };
      for (const [file, content] of Object.entries(files)) body.files[file] = { content };
      const res = await doFetch(`${API}/gists`, { method: "POST", headers: headers(token), body: JSON.stringify(body) });
      if (!res.ok) await failWith(res, "Could not publish the documentation");
      const gist = await res.json();
      const primary = gist.files["llm-context.md"] || Object.values(gist.files)[0];
      const entry = {
        gistId: gist.id, name, url: gist.html_url, rawUrl: primary.raw_url,
        createdAt: new Date(clock()).toISOString(), expiresAt: new Date(clock() + hours * 3600e3).toISOString()
      };
      await save([...(await list()), entry]);
      return entry;
    }

    async function remove({ token, gistId }) {
      const res = await doFetch(`${API}/gists/${gistId}`, { method: "DELETE", headers: headers(token) });
      if (!res.ok && res.status !== 404) await failWith(res, "Could not delete the published documentation");
      await save((await list()).filter((e) => e.gistId !== gistId));
    }

    /** Deletes every expired gist. A failed delete stays listed and is retried next time. */
    async function sweep({ token }) {
      const expired = (await list()).filter((e) => Date.parse(e.expiresAt) <= clock());
      const failed = [];
      for (const e of expired) {
        try { await remove({ token, gistId: e.gistId }); } catch (err) { failed.push(`${e.name}: ${err.message}`); }
      }
      return { removed: expired.length - failed.length, failed };
    }

    return { publish, remove, sweep, list };
  }

  const api = { createPublisher, DEFAULT_HOURS, KEY };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.DocPublish = api;
})(typeof window !== "undefined" ? window : globalThis);
