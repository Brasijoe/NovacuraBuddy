(function (global) {
  const CredentialCrypto = typeof require === "function" ? require("./credential-crypto.js") : global.CredentialCrypto;
  const KEY = "githubSettings";
  const DEFAULT_REPO = "Brasijoe/ifs-quick-report-deployer-data";

  /** GitHub token for the Quick Report library, encrypted with the same master key as the IFS
   *  client secrets. The login is resolved once at save time (`verify`), so it can only change
   *  together with the token. */
  function createGithubSettings(storage) {
    const read = async () => (await storage.get(KEY))[KEY] || {};

    async function get() {
      const s = await read();
      return { repo: s.repo || DEFAULT_REPO, login: s.login || null, hasToken: !!s.encryptedToken };
    }

    async function save({ token, repo }, masterKey, verify) {
      const cleanToken = String(token || "").trim();
      const cleanRepo = String(repo || "").trim() || DEFAULT_REPO;
      if (!cleanToken) throw new Error("Enter a GitHub token.");
      if (!/^[\w.-]+\/[\w.-]+$/.test(cleanRepo)) throw new Error(`"${cleanRepo}" isn't a repo name — use owner/name.`);
      let login;
      try {
        login = await verify(cleanToken, cleanRepo);
      } catch (e) {
        throw new Error(`GitHub check failed, settings not saved — ${e.message}`);
      }
      const encryptedToken = await CredentialCrypto.encryptText(masterKey, cleanToken);
      await storage.set({ [KEY]: { repo: cleanRepo, login, encryptedToken } });
      return { repo: cleanRepo, login };
    }

    async function getToken(masterKey) {
      const s = await read();
      if (!s.encryptedToken) {
        throw Object.assign(new Error("No GitHub token saved — add one in Basic Data to use Quick Reports."), { code: "GITHUB_NOT_CONFIGURED" });
      }
      return CredentialCrypto.decryptText(masterKey, s.encryptedToken);
    }

    return { get, save, getToken };
  }

  const api = { createGithubSettings, DEFAULT_REPO };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.GithubSettings = api;
})(typeof window !== "undefined" ? window : globalThis);
