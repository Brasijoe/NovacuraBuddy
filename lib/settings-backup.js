(function (global) {
  const FORMAT = "novacura-buddy-settings";
  const VERSION = 1;
  /** What a backup holds: the Basic Data (IFS instances with their encrypted secrets, the master
   *  password's salt and verifier, GitHub settings) and the small per-user settings. Scan results,
   *  recordings and caches are left out — they are rebuilt or too big to be worth carrying. */
  const BACKUP_KEYS = [
    "ifsInstances", "credentialSalt", "credentialVerifier", "githubSettings",
    "trackingEnabled", "flowDepsAddresses", "apiModulesState", "qrDeployments", "qrPermissionSetMemory",
    "confirmedFieldMappings", "lastFlowOrgId", "lastFlowOrgPackage", "mcMarksOff"
  ];

  /** Secrets stay encrypted with the master password exactly as stored; nothing is decrypted here. */
  function buildBackup(stored, { version, now = new Date() } = {}) {
    const data = {};
    for (const key of BACKUP_KEYS) if (stored[key] !== undefined) data[key] = stored[key];
    return { format: FORMAT, backupVersion: VERSION, extensionVersion: version || null, exportedAt: now.toISOString(), data };
  }

  /** Returns the key/value pairs to write, or throws when the file isn't a backup of ours. */
  function parseBackup(text) {
    let backup;
    try { backup = JSON.parse(text); } catch { throw new Error("That file isn't valid JSON — pick a Novacura Buddy settings backup."); }
    if (!backup || backup.format !== FORMAT || typeof backup.data !== "object" || !backup.data) {
      throw new Error("That file isn't a Novacura Buddy settings backup.");
    }
    if (backup.backupVersion > VERSION) throw new Error("This backup was made by a newer Novacura Buddy — update the extension first.");
    const data = {};
    for (const key of BACKUP_KEYS) if (backup.data[key] !== undefined) data[key] = backup.data[key];
    if (!Object.keys(data).length) throw new Error("The backup contains no settings.");
    return data;
  }

  function summarize(data) {
    const instances = Object.keys(data.ifsInstances || {}).length;
    return { instances, github: !!(data.githubSettings && data.githubSettings.encryptedToken) };
  }

  const api = { BACKUP_KEYS, FORMAT, buildBackup, parseBackup, summarize };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.SettingsBackup = api;
})(typeof window !== "undefined" ? window : globalThis);
