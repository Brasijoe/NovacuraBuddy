(function (global) {
  const CredentialCrypto = typeof require === "function" ? require("./credential-crypto.js") : global.CredentialCrypto;

  const IFS_INSTANCES_KEY = "ifsInstances";
  const CRED_SALT_KEY = "credentialSalt";
  const CRED_VERIFIER_KEY = "credentialVerifier";
  const SESSION_KEY_STORAGE = "credentialSessionKey";

  function createIfsInstanceStore(storage) {
    let cachedMasterKey = null;
    const ifsTokenCache = {}; // baseUrl -> { token, expiresAt }

    async function getSessionKey() {
      if (cachedMasterKey) return cachedMasterKey;
      const { [SESSION_KEY_STORAGE]: exported } = await storage.session.get(SESSION_KEY_STORAGE);
      if (exported) {
        cachedMasterKey = await CredentialCrypto.importKeyRaw(exported);
        return cachedMasterKey;
      }
      return null;
    }

    async function setSessionKey(key) {
      cachedMasterKey = key;
      const exported = await CredentialCrypto.exportKeyRaw(key);
      await storage.session.set({ [SESSION_KEY_STORAGE]: exported });
    }

    async function hasMasterPasswordBeenSet() {
      const { [CRED_SALT_KEY]: salt } = await storage.local.get(CRED_SALT_KEY);
      return !!salt;
    }

    async function ensureMasterKey(promptFn) {
      const existing = await getSessionKey();
      if (existing) return existing;

      const isFirstTime = !(await hasMasterPasswordBeenSet());
      let errorMessage;
      while (true) {
        const password = await promptFn(isFirstTime, errorMessage);
        if (password == null) throw new Error("Master password entry cancelled.");

        if (isFirstTime) {
          const salt = CredentialCrypto.generateSalt();
          const key = await CredentialCrypto.deriveKey(password, salt);
          const verifier = await CredentialCrypto.makeVerifier(key);
          await storage.local.set({ [CRED_SALT_KEY]: salt, [CRED_VERIFIER_KEY]: verifier });
          await setSessionKey(key);
          return key;
        }

        const { [CRED_SALT_KEY]: salt, [CRED_VERIFIER_KEY]: verifier } = await storage.local.get([CRED_SALT_KEY, CRED_VERIFIER_KEY]);
        const key = await CredentialCrypto.deriveKey(password, salt);
        const ok = await CredentialCrypto.checkVerifier(key, verifier);
        if (ok) {
          await setSessionKey(key);
          return key;
        }
        errorMessage = "Incorrect master password, try again.";
      }
    }

    async function listInstances() {
      const { [IFS_INSTANCES_KEY]: instances = {} } = await storage.local.get(IFS_INSTANCES_KEY);
      return Object.entries(instances).map(([baseUrl, instance]) => ({ baseUrl, ...instance }));
    }

    async function saveInstance(baseUrl, fields, masterKey) {
      const { name, authMethod, tokenEndpoint, clientId, secretPayload } = fields;
      const encryptedSecret = await CredentialCrypto.encryptText(masterKey, JSON.stringify(secretPayload));
      const { [IFS_INSTANCES_KEY]: instances = {} } = await storage.local.get(IFS_INSTANCES_KEY);
      instances[baseUrl] = { name, authMethod, tokenEndpoint, clientId, encryptedSecret };
      await storage.local.set({ [IFS_INSTANCES_KEY]: instances });
    }

    async function deleteInstance(baseUrl) {
      const { [IFS_INSTANCES_KEY]: instances = {} } = await storage.local.get(IFS_INSTANCES_KEY);
      delete instances[baseUrl];
      await storage.local.set({ [IFS_INSTANCES_KEY]: instances });
      delete ifsTokenCache[baseUrl];
    }

    async function getDecryptedSecret(baseUrl, masterKey) {
      const { [IFS_INSTANCES_KEY]: instances = {} } = await storage.local.get(IFS_INSTANCES_KEY);
      const instance = instances[baseUrl];
      if (!instance) throw new Error(`No stored IFS credentials for ${baseUrl}.`);
      const json = await CredentialCrypto.decryptText(masterKey, instance.encryptedSecret);
      return { instance, secret: JSON.parse(json) };
    }

    async function getIfsAuthToken(baseUrl, masterKey, fetchImpl) {
      const cached = ifsTokenCache[baseUrl];
      if (cached && cached.expiresAt > Date.now()) return cached.token;

      const { instance, secret } = await getDecryptedSecret(baseUrl, masterKey);

      const params = new URLSearchParams();
      params.set("client_id", instance.clientId);
      if (instance.authMethod === "client_credentials") {
        params.set("grant_type", "client_credentials");
        params.set("client_secret", secret.clientSecret);
      } else {
        params.set("grant_type", "password");
        if (secret.clientSecret) params.set("client_secret", secret.clientSecret);
        params.set("username", secret.username);
        params.set("password", secret.password);
      }

      const doFetch = fetchImpl || fetch;
      const res = await doFetch(instance.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString()
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`IFS token request failed (${res.status})${text ? ": " + text : ""}`);
      }
      const data = await res.json();
      if (!data.access_token || !data.expires_in) {
        throw new Error("IFS token response was missing access_token or expires_in.");
      }
      ifsTokenCache[baseUrl] = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
      return data.access_token;
    }

    function clearIfsAuthToken(baseUrl) {
      delete ifsTokenCache[baseUrl];
    }

    return { ensureMasterKey, listInstances, saveInstance, deleteInstance, getIfsAuthToken, clearIfsAuthToken };
  }

  const api = { createIfsInstanceStore };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.IfsInstances = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
