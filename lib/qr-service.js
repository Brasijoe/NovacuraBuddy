(function (global) {
  const req = (path, name) => (typeof require === "function" ? require(path) : global[name]);
  const QrDeploy = req("./qr-deploy.js", "QrDeploy");
  const QrLibrary = req("./qr-library.js", "QrLibrary");

  const CACHE_KEY = "qrCache"; // { login, repo, reports, fetchedAt }

  /** Everything the background worker does for Quick Reports, behind one object so the message
   *  router stays thin and the flows are testable without Chrome. */
  function createQrService({ instanceStore, settings, history, cacheStorage, fetchImpl }) {
    const instanceKey = (baseUrl) => new URL(String(baseUrl).trim()).origin;

    async function libraryFor(masterKey) {
      const token = await settings.getToken(masterKey);
      const { repo, login } = await settings.get();
      return { lib: QrLibrary.createQrLibrary({ token, repo, fetchImpl }), login, repo };
    }

    async function readCache() {
      return (await cacheStorage.get(CACHE_KEY))[CACHE_KEY] || null;
    }
    async function writeCache(login, repo, reports) {
      const cache = { login, repo, reports, fetchedAt: Date.now() };
      await cacheStorage.set({ [CACHE_KEY]: cache });
      return cache;
    }

    function ifsClient(baseUrl, masterKey) {
      return QrDeploy.createIfsClient({
        baseUrl: instanceKey(baseUrl),
        getToken: () => instanceStore.getIfsAuthToken(baseUrl, masterKey, fetchImpl),
        clearToken: () => instanceStore.clearIfsAuthToken(baseUrl),
        fetchImpl
      });
    }

    return {
      getGithubSettings: () => settings.get(),

      saveGithubSettings: ({ token, repo }, masterKey) =>
        settings.save({ token, repo }, masterKey, async (cleanToken, cleanRepo) => {
          const lib = QrLibrary.createQrLibrary({ token: cleanToken, repo: cleanRepo, fetchImpl });
          await lib.checkAccess();
          return lib.whoAmI();
        }),

      async listReports(masterKey) {
        const { lib, login, repo } = await libraryFor(masterKey);
        const cache = await writeCache(login, repo, await lib.list(login));
        return { reports: cache.reports, fetchedAt: cache.fetchedAt };
      },

      async getCachedReports() {
        const cache = await readCache();
        const { login, repo } = await settings.get();
        return cache && cache.login === login && cache.repo === repo ? cache : null;
      },

      async saveReport(masterKey, input) {
        const { lib, login, repo } = await libraryFor(masterKey);
        const cache = await readCache();
        const known = cache && cache.login === login && cache.repo === repo ? cache.reports : await lib.list(login);
        const saved = await lib.save(login, input, known);
        await writeCache(login, repo, [...known.filter((r) => r.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)));
        return saved;
      },

      async moveUnowned(masterKey) {
        const { lib, login } = await libraryFor(masterKey);
        return lib.moveUnowned(login);
      },

      async listPermissionSets(baseUrl, masterKey) {
        const sets = await QrDeploy.listPermissionSets(ifsClient(baseUrl, masterKey));
        return { sets, remembered: await history.getPermissionSetMemory(instanceKey(baseUrl)) };
      },

      async deploy(masterKey, { baseUrl, report, permissionSetIds, forceQuickReportId }) {
        const key = instanceKey(baseUrl);
        const prior = await history.latestFor(report.id, key);
        const outcome = await QrDeploy.deployQuickReport(ifsClient(baseUrl, masterKey), {
          report: { id: report.id, name: report.name, content: report.content },
          priorQuickReportId: prior ? prior.quickReportId : null,
          forceQuickReportId: forceQuickReportId || null,
          permissionSetIds: permissionSetIds || []
        });
        if (outcome.status === "deployed") {
          await history.record({ qrId: report.id, instanceKey: key, quickReportId: outcome.quickReportId, permissionSetIds: permissionSetIds || [] });
        }
        return outcome;
      },

      historyForReport: (qrId) => history.listForReport(qrId),
      historyForInstance: (baseUrl) => history.listForInstance(instanceKey(baseUrl))
    };
  }

  const api = { createQrService };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.QrService = api;
})(typeof window !== "undefined" ? window : globalThis);
