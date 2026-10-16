(function (global) {
  const CredentialCrypto = typeof require === "function" ? require("./credential-crypto.js") : global.CredentialCrypto;

  const IFS_INSTANCES_KEY = "ifsInstances";
  const CRED_SALT_KEY = "credentialSalt";
  const CRED_VERIFIER_KEY = "credentialVerifier";
  const SESSION_KEY_STORAGE = "credentialSessionKey";

  /** One OAuth token request against an instance's token endpoint — shared by the normal token
   *  path and the connection check run before an instance is saved. Values are trimmed here, not
   *  just on save: a space or line break pasted along with one makes IAM answer
   *  "unauthorized_client", and instances saved before trimming existed would otherwise keep
   *  failing until re-entered. (IFS Buddy trims these too.) */
  async function requestIfsToken({ authMethod, tokenEndpoint, clientId }, secret, fetchImpl) {
    const clean = (v) => (typeof v === "string" ? v.trim() : v);
    const params = new URLSearchParams();
    params.set("client_id", clean(clientId));
    if (authMethod === "client_credentials") {
      params.set("grant_type", "client_credentials");
      params.set("client_secret", clean(secret.clientSecret));
    } else {
      params.set("grant_type", "password");
      if (secret.clientSecret) params.set("client_secret", clean(secret.clientSecret));
      params.set("username", secret.username);
      params.set("password", secret.password);
    }

    const doFetch = fetchImpl || fetch;
    const res = await doFetch(clean(tokenEndpoint), {
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
    return { token: data.access_token, expiresIn: data.expires_in };
  }

  /** The one spelling of an instance key: the origin, no trailing slash — what the recorder
   *  derives from recorded calls and what every `baseUrl + path` concatenation expects. */
  function normalizeBaseUrl(url) {
    return new URL(String(url).trim()).origin;
  }

  function findInstanceForHost(instances, hostname) {
    return (instances || []).find((i) => {
      try { return new URL(i.baseUrl).hostname === hostname; } catch { return false; }
    });
  }

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
        if (password == null) {
          const err = new Error(errorMessage
            ? "Incorrect master password."
            : "Master password needed to unlock your saved IFS credentials — enter it in the Unlock field.");
          err.code = "MASTER_PASSWORD_REQUIRED";
          throw err;
        }

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

    /** Reads the instance map, rewriting legacy keys (e.g. a trailing slash) to the canonical
     *  form once. A legacy key never overwrites an entry already stored canonically. */
    async function readInstances() {
      const { [IFS_INSTANCES_KEY]: stored = {} } = await storage.local.get(IFS_INSTANCES_KEY);
      const instances = {};
      let migrated = false;
      for (const [key, value] of Object.entries(stored)) {
        let canonical = key;
        try { canonical = normalizeBaseUrl(key); } catch { /* keep unparseable keys as-is */ }
        if (canonical !== key) migrated = true;
        if (!(canonical in instances) || canonical === key) instances[canonical] = value;
      }
      if (migrated) await storage.local.set({ [IFS_INSTANCES_KEY]: instances });
      return instances;
    }

    async function listInstances() {
      const instances = await readInstances();
      return Object.entries(instances).map(([baseUrl, instance]) => ({ baseUrl, ...instance }));
    }

    async function getInstance(baseUrl) {
      const key = normalizeBaseUrl(baseUrl);
      const instance = (await readInstances())[key];
      return instance ? { baseUrl: key, ...instance } : null;
    }

    async function saveInstance(baseUrl, fields, masterKey, options = {}) {
      const key = normalizeBaseUrl(baseUrl);
      const { name, authMethod, tokenEndpoint, clientId, secretPayload } = fields;
      try {
        await requestIfsToken({ authMethod, tokenEndpoint, clientId }, secretPayload, options.fetchImpl);
      } catch (e) {
        throw new Error(`Connection check failed, instance not saved — ${e.message}`);
      }
      const clean = (v) => (typeof v === "string" ? v.trim() : v);
      const encryptedSecret = await CredentialCrypto.encryptText(masterKey, JSON.stringify(secretPayload));
      const instances = await readInstances();
      instances[key] = {
        name: clean(name) || new URL(key).hostname,
        authMethod, tokenEndpoint: clean(tokenEndpoint), clientId: clean(clientId), encryptedSecret
      };
      await storage.local.set({ [IFS_INSTANCES_KEY]: instances });
      delete ifsTokenCache[key]; // a re-saved instance must not keep using the old credentials' token
      return key;
    }

    async function deleteInstance(baseUrl) {
      const key = normalizeBaseUrl(baseUrl);
      const instances = await readInstances();
      delete instances[key];
      await storage.local.set({ [IFS_INSTANCES_KEY]: instances });
      delete ifsTokenCache[key];
    }

    async function getDecryptedSecret(baseUrl, masterKey) {
      const instance = await getInstance(baseUrl);
      if (!instance) throw new Error(`No stored IFS credentials for ${normalizeBaseUrl(baseUrl)}.`);
      const json = await CredentialCrypto.decryptText(masterKey, instance.encryptedSecret);
      return { instance, secret: JSON.parse(json) };
    }

    async function getIfsAuthToken(baseUrl, masterKey, fetchImpl) {
      const key = normalizeBaseUrl(baseUrl);
      const cached = ifsTokenCache[key];
      if (cached && cached.expiresAt > Date.now()) return cached.token;

      const { instance, secret } = await getDecryptedSecret(key, masterKey);
      const { token, expiresIn } = await requestIfsToken(instance, secret, fetchImpl);
      ifsTokenCache[key] = { token, expiresAt: Date.now() + (expiresIn - 60) * 1000 };
      return token;
    }

    function clearIfsAuthToken(baseUrl) {
      delete ifsTokenCache[normalizeBaseUrl(baseUrl)];
    }

    async function getLockStatus() {
      return { passwordSet: await hasMasterPasswordBeenSet(), unlocked: !!(await getSessionKey()) };
    }

    return { ensureMasterKey, getLockStatus, listInstances, getInstance, saveInstance, deleteInstance, getIfsAuthToken, clearIfsAuthToken };
  }

  /** Adapts a single already-known password into the promptFn shape `ensureMasterKey` expects,
   *  without its interactive retry loop ever spinning: the password is offered exactly once: a
   *  wrong password on that first attempt makes every later call return null, so the loop's own
   *  `if (password == null) throw ...` ends it on the very next iteration instead of re-offering
   *  the same wrong password forever. */
  function createOneShotPrompt(password) {
    let offered = false;
    return async () => {
      if (offered) return null;
      offered = true;
      // An empty field is "no password given", never a password — otherwise a first-time setup
      // would silently set the master password to "".
      return password ? password : null;
    };
  }

  const api = { createIfsInstanceStore, createOneShotPrompt, requestIfsToken, normalizeBaseUrl, findInstanceForHost };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.IfsInstances = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
