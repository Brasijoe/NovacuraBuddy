(function (global) {
  const req = (path, name) => (typeof require === "function" ? require(path) : global[name]);
  const IfsClient = req("./ifs-client.js", "IfsClient");
  const ClLibrary = req("./cl-library.js", "ClLibrary");
  const CustomLuModel = req("./custom-lu-model.js", "CustomLuModel");
  const CustomLuDeploy = req("./custom-lu-deploy.js", "CustomLuDeploy");

  /** Everything the background worker does for Custom LUs. IFS instances and the GitHub repo come
   *  from Basic Data (same stores as Quick Reports). */
  function createClService({ instanceStore, settings, history, fetchImpl, uuid }) {
    const instanceKey = (baseUrl) => new URL(String(baseUrl).trim()).origin;
    const newId = uuid || (() => crypto.randomUUID());
    const client = (baseUrl, masterKey) => IfsClient.forInstance({ instanceStore, baseUrl, masterKey, fetchImpl });

    async function libraryFor(masterKey) {
      const token = await settings.getToken(masterKey);
      const { repo, login } = await settings.get();
      return { lib: ClLibrary.createClLibrary({ token, repo, fetchImpl }), login };
    }

    function normalizedAndValid(input) {
      const lu = CustomLuModel.normalizeLu(input);
      const problems = CustomLuModel.validateLu(lu);
      if (problems.length) throw new Error(problems.map((p) => p.message).join(" "));
      return lu;
    }

    return {
      async listLibrary(masterKey) {
        const { lib, login } = await libraryFor(masterKey);
        return lib.list(login);
      },

      async createInLibrary(masterKey, input) {
        const lu = normalizedAndValid(input);
        const { lib, login } = await libraryFor(masterKey);
        return lib.create(login, lu);
      },

      listEnvironment: (baseUrl, masterKey) => CustomLuDeploy.listCustomLus(client(baseUrl, masterKey)),

      getEnvironmentLu: (baseUrl, masterKey, name) => CustomLuDeploy.getCustomLuDefinition(client(baseUrl, masterKey), name),

      async deploy(masterKey, { baseUrl, lus, permissionSetIds }, onProgress) {
        const ids = permissionSetIds || [];
        const results = await CustomLuDeploy.deployAll(client(baseUrl, masterKey), (lus || []).map(CustomLuModel.normalizeLu), { permissionSetIds: ids, uuid: newId, onProgress });
        if (results.some((r) => r.ok)) await history.rememberPermissionSets(instanceKey(baseUrl), ids);
        return results;
      }
    };
  }

  const api = { createClService };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.ClService = api;
})(typeof window !== "undefined" ? window : globalThis);
