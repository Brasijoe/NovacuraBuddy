(function (global) {
  const DEPLOYMENTS_KEY = "qrDeployments";
  const MEMORY_KEY = "qrPermissionSetMemory";

  /** Local deploy history (replaces the Electron app's SQLite deployments + permission_set_memory
   *  tables). One entry per (report, instance), like deploymentsRepo.upsertDeployment. Instance
   *  keys are the canonical Basic Data keys (origin, no trailing slash). */
  function createQrHistory(storage) {
    const read = async (key, fallback) => {
      const { [key]: value } = await storage.get(key);
      return value === undefined ? fallback : value;
    };
    const newestFirst = (list) => list.slice().sort((a, b) => b.deployedAt.localeCompare(a.deployedAt));

    async function record({ qrId, instanceKey, quickReportId, permissionSetIds, deployedAt }) {
      const entry = { qrId, instanceKey, quickReportId, permissionSetIds: [...permissionSetIds], deployedAt: deployedAt || new Date().toISOString() };
      const list = (await read(DEPLOYMENTS_KEY, [])).filter((e) => !(e.qrId === qrId && e.instanceKey === instanceKey));
      list.push(entry);
      const memory = await read(MEMORY_KEY, {});
      memory[instanceKey] = [...permissionSetIds];
      await storage.set({ [DEPLOYMENTS_KEY]: list, [MEMORY_KEY]: memory });
      return entry;
    }

    async function latestFor(qrId, instanceKey) {
      return (await read(DEPLOYMENTS_KEY, [])).find((e) => e.qrId === qrId && e.instanceKey === instanceKey) || null;
    }

    const listForReport = async (qrId) => newestFirst((await read(DEPLOYMENTS_KEY, [])).filter((e) => e.qrId === qrId));
    const listForInstance = async (instanceKey) => newestFirst((await read(DEPLOYMENTS_KEY, [])).filter((e) => e.instanceKey === instanceKey));
    const getPermissionSetMemory = async (instanceKey) => (await read(MEMORY_KEY, {}))[instanceKey] || [];

    return { record, latestFor, listForReport, listForInstance, getPermissionSetMemory };
  }

  const api = { createQrHistory };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.QrHistory = api;
})(typeof window !== "undefined" ? window : globalThis);
