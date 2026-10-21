(function (global) {
  const API = "https://api.github.com";

  /** Same rule as the Electron app's qrFileStore.slugify, so existing files keep their ids. */
  function slugify(name, fallback = "report") {
    const slug = String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return slug || fallback;
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

  /** Access to one GitHub data repo (the Quick Reports / Custom LU library). `conflictMessage` is
   *  what a 409/422 on a file write means for the caller. */
  function createGhRepo({ token, repo, fetchImpl, conflictMessage }) {
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
        return Object.assign(new Error(conflictMessage), { code: "CONFLICT" });
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

    async function putFile(path, text, sha, message) {
      const body = { message, content: utf8ToBase64(text), branch: await branch() };
      if (sha) body.sha = sha;
      return (await gh("PUT", `/repos/${repo}/contents/${encodePath(path)}`, body)).content.sha;
    }

    async function deleteFile(path, sha, message) {
      await gh("DELETE", `/repos/${repo}/contents/${encodePath(path)}`, { message, sha, branch: await branch() });
    }

    return { whoAmI, checkAccess, treeEntries, readBlob, putFile, deleteFile };
  }

  const api = { createGhRepo, slugify, utf8ToBase64, base64ToUtf8 };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.GhLibrary = api;
})(typeof window !== "undefined" ? window : globalThis);
