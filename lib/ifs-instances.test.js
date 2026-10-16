const test = require("node:test");
const assert = require("node:assert/strict");
const { createIfsInstanceStore, createOneShotPrompt, requestIfsToken, normalizeBaseUrl, findInstanceForHost } = require("./ifs-instances.js");

const okTokenFetch = async () => ({ ok: true, json: async () => ({ access_token: "t", expires_in: 3600 }) });

function fakeStorage(sharedLocal) {
  const local = sharedLocal || {};
  const session = {};
  return {
    local: {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (k in local) out[k] = local[k];
        return out;
      },
      async set(obj) { Object.assign(local, obj); }
    },
    session: {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (k in session) out[k] = session[k];
        return out;
      },
      async set(obj) { Object.assign(session, obj); }
    }
  };
}

test("ensureMasterKey sets up a new master password on first use", async () => {
  const store = createIfsInstanceStore(fakeStorage());
  const key = await store.ensureMasterKey(async () => "my-password");
  assert.ok(key);
});

test("ensureMasterKey reuses the cached key within the same session, no re-prompt", async () => {
  const store = createIfsInstanceStore(fakeStorage());
  let prompts = 0;
  const promptFn = async () => { prompts++; return "my-password"; };
  await store.ensureMasterKey(promptFn);
  await store.ensureMasterKey(promptFn);
  assert.equal(prompts, 1);
});

test("ensureMasterKey retries on a wrong password against an already-set one", async () => {
  // A real browser restart clears chrome.storage.session but keeps chrome.storage.local — the
  // salt/verifier survive, the unlocked session key does not. Sharing only `local` between two
  // independent storages (fresh `session` each) reproduces that, unlike sharing one fakeStorage
  // object wholesale (which would also carry the already-unlocked session key over and skip the
  // prompt entirely — not what "a fresh browser session" means).
  const localBacking = {};
  const store1 = createIfsInstanceStore(fakeStorage(localBacking));
  await store1.ensureMasterKey(async () => "right-password");

  const store2 = createIfsInstanceStore(fakeStorage(localBacking)); // fresh browser session: no cached session key
  let attempt = 0;
  const key = await store2.ensureMasterKey(async (isFirstTime, errorMessage) => {
    attempt++;
    if (attempt === 1) {
      assert.equal(isFirstTime, false);
      assert.equal(errorMessage, undefined);
      return "wrong-password";
    }
    assert.equal(errorMessage, "Incorrect master password, try again.");
    return "right-password";
  });
  assert.ok(key);
  assert.equal(attempt, 2);
});

test("saveInstance/listInstances/deleteInstance round-trip, secret stays encrypted at rest", async () => {
  const storage = fakeStorage();
  const store = createIfsInstanceStore(storage);
  const key = await store.ensureMasterKey(async () => "pw");

  await store.saveInstance("https://ifs.example.com", {
    name: "Test IFS",
    authMethod: "client_credentials",
    tokenEndpoint: "https://ifs.example.com/oauth/token",
    clientId: "client-1",
    secretPayload: { clientSecret: "s3cret" }
  }, key, { fetchImpl: okTokenFetch });

  const instances = await store.listInstances();
  assert.equal(instances.length, 1);
  assert.equal(instances[0].name, "Test IFS");
  assert.equal(instances[0].baseUrl, "https://ifs.example.com");
  assert.ok(!JSON.stringify(instances[0]).includes("s3cret"), "raw secret must never appear unencrypted");

  await store.deleteInstance("https://ifs.example.com");
  assert.equal((await store.listInstances()).length, 0);
});

test("getIfsAuthToken requests a client_credentials token and caches it", async () => {
  const storage = fakeStorage();
  const store = createIfsInstanceStore(storage);
  const key = await store.ensureMasterKey(async () => "pw");
  await store.saveInstance("https://ifs.example.com", {
    name: "Test IFS",
    authMethod: "client_credentials",
    tokenEndpoint: "https://ifs.example.com/oauth/token",
    clientId: "client-1",
    secretPayload: { clientSecret: "s3cret" }
  }, key, { fetchImpl: okTokenFetch });

  let calls = 0;
  const fakeFetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://ifs.example.com/oauth/token");
    const body = new URLSearchParams(options.body);
    assert.equal(body.get("grant_type"), "client_credentials");
    assert.equal(body.get("client_secret"), "s3cret");
    return { ok: true, json: async () => ({ access_token: "tok-123", expires_in: 3600 }) };
  };

  const token1 = await store.getIfsAuthToken("https://ifs.example.com", key, fakeFetch);
  const token2 = await store.getIfsAuthToken("https://ifs.example.com", key, fakeFetch);
  assert.equal(token1, "tok-123");
  assert.equal(token2, "tok-123");
  assert.equal(calls, 1, "second call must use the cache, not refetch");
});

test("getIfsAuthToken trims stray whitespace from an already-saved instance's endpoint, client id and secret", async () => {
  const storage = fakeStorage();
  const store = createIfsInstanceStore(storage);
  const key = await store.ensureMasterKey(async () => "pw");
  const fakeFetch = async (url, options) => {
    assert.equal(url, "https://ifs.example.com/oauth/token");
    const body = new URLSearchParams(options.body);
    assert.equal(body.get("client_id"), "client-1");
    assert.equal(body.get("client_secret"), "s3cret");
    return { ok: true, json: async () => ({ access_token: "tok", expires_in: 3600 }) };
  };
  await store.saveInstance("https://ifs.example.com", {
    name: "Test IFS",
    authMethod: "client_credentials",
    tokenEndpoint: " https://ifs.example.com/oauth/token\n",
    clientId: "client-1 ",
    secretPayload: { clientSecret: "s3cret\r\n" }
  }, key, { fetchImpl: fakeFetch });

  assert.equal(await store.getIfsAuthToken("https://ifs.example.com", key, fakeFetch), "tok");
});

test("createOneShotPrompt returns the password once, then null forever", async () => {
  const promptFn = createOneShotPrompt("my-password");
  assert.equal(await promptFn(false, undefined), "my-password");
  assert.equal(await promptFn(false, "Incorrect master password, try again."), null);
  assert.equal(await promptFn(false, "Incorrect master password, try again."), null);
});

test("a wrong password passed through createOneShotPrompt throws instead of looping forever", async () => {
  const localBacking = {};
  const store1 = createIfsInstanceStore(fakeStorage(localBacking));
  await store1.ensureMasterKey(async () => "right-password");

  // Fresh browser session (no cached session key), same salt/verifier already set in `local`.
  const store2 = createIfsInstanceStore(fakeStorage(localBacking));
  await assert.rejects(
    () => store2.ensureMasterKey(createOneShotPrompt("wrong-password")),
    (err) => err.code === "MASTER_PASSWORD_REQUIRED" && /Incorrect master password\./.test(err.message)
  );
});

test("an empty password field is 'no password', with a clear message — never a first-time password of ''", async () => {
  const localBacking = {};
  const store = createIfsInstanceStore(fakeStorage(localBacking));
  await assert.rejects(
    () => store.ensureMasterKey(createOneShotPrompt("")),
    (err) => err.code === "MASTER_PASSWORD_REQUIRED" && /Unlock field/.test(err.message)
  );
  assert.equal((await store.getLockStatus()).passwordSet, false);
});

test("getLockStatus reports locked after a browser-session reset, unlocked after the right password", async () => {
  const localBacking = {};
  await createIfsInstanceStore(fakeStorage(localBacking)).ensureMasterKey(async () => "pw");
  const store = createIfsInstanceStore(fakeStorage(localBacking));
  assert.deepEqual(await store.getLockStatus(), { passwordSet: true, unlocked: false });
  await store.ensureMasterKey(createOneShotPrompt("pw"));
  assert.deepEqual(await store.getLockStatus(), { passwordSet: true, unlocked: true });
});

test("requestIfsToken (the pre-save connection check) surfaces IAM's rejection text", async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => '{"error":"unauthorized_client"}' });
  await assert.rejects(
    () => requestIfsToken({ authMethod: "client_credentials", tokenEndpoint: "https://x/token", clientId: "c" }, { clientSecret: "s" }, fakeFetch),
    /IFS token request failed \(401\): \{"error":"unauthorized_client"\}/
  );
});

test("re-saving an instance drops its cached token, so new credentials are actually used", async () => {
  const store = createIfsInstanceStore(fakeStorage());
  const key = await store.ensureMasterKey(async () => "pw");
  const fields = (secret) => ({ name: "I", authMethod: "client_credentials", tokenEndpoint: "https://x/token", clientId: "c", secretPayload: { clientSecret: secret } });
  const fetchFor = (tok) => async () => ({ ok: true, json: async () => ({ access_token: tok, expires_in: 3600 }) });

  await store.saveInstance("https://x", fields("old"), key, { fetchImpl: okTokenFetch });
  assert.equal(await store.getIfsAuthToken("https://x", key, fetchFor("tok-old")), "tok-old");
  await store.saveInstance("https://x", fields("new"), key, { fetchImpl: okTokenFetch });
  assert.equal(await store.getIfsAuthToken("https://x", key, fetchFor("tok-new")), "tok-new");
});

const fields = (over) => ({ authMethod: "client_credentials", tokenEndpoint: "https://ifs.example.com/token", clientId: "c", secretPayload: { clientSecret: "s" }, ...over });

test("normalizeBaseUrl reduces any form to the origin without trailing slash", () => {
  assert.equal(normalizeBaseUrl("https://ifs.example.com/"), "https://ifs.example.com");
  assert.equal(normalizeBaseUrl(" https://IFS.example.com/main/ifsapplications "), "https://ifs.example.com");
  assert.throws(() => normalizeBaseUrl("not a url"));
});

test("a legacy trailing-slash key is migrated once and found under any spelling", async () => {
  const local = {};
  const store1 = createIfsInstanceStore(fakeStorage(local));
  const key = await store1.ensureMasterKey(async () => "pw");
  local.ifsInstances = { "https://ifs.example.com/": { name: "Old", authMethod: "client_credentials", tokenEndpoint: "t", clientId: "c", encryptedSecret: "x" } };

  const store = createIfsInstanceStore(fakeStorage(local));
  assert.deepEqual((await store.listInstances()).map((i) => i.baseUrl), ["https://ifs.example.com"]);
  assert.deepEqual(Object.keys(local.ifsInstances), ["https://ifs.example.com"], "migrated in storage");
  assert.equal((await store.getInstance("https://ifs.example.com/")).name, "Old");
  assert.equal((await store.getInstance("https://ifs.example.com")).name, "Old");
  void key;
});

test("saveInstance stores under the canonical key and defaults the name to the hostname", async () => {
  const local = {};
  const store = createIfsInstanceStore(fakeStorage(local));
  const key = await store.ensureMasterKey(async () => "pw");
  const saved = await store.saveInstance("https://ifs.example.com/", fields(), key, { fetchImpl: okTokenFetch });
  assert.equal(saved, "https://ifs.example.com");
  assert.equal(local.ifsInstances["https://ifs.example.com"].name, "ifs.example.com");
});

test("saveInstance runs the connection check and saves nothing when IFS rejects", async () => {
  const local = {};
  const store = createIfsInstanceStore(fakeStorage(local));
  const key = await store.ensureMasterKey(async () => "pw");
  const rejectFetch = async () => ({ ok: false, status: 401, text: async () => "unauthorized_client" });
  await assert.rejects(
    () => store.saveInstance("https://ifs.example.com", fields({ name: "X" }), key, { fetchImpl: rejectFetch }),
    /^Error: Connection check failed, instance not saved — IFS token request failed \(401\)/
  );
  assert.equal(await store.getInstance("https://ifs.example.com"), null);
});

test("findInstanceForHost matches by hostname", () => {
  const instances = [{ baseUrl: "https://a.example.com", name: "A" }];
  assert.equal(findInstanceForHost(instances, "a.example.com").name, "A");
  assert.equal(findInstanceForHost(instances, "b.example.com"), undefined);
});
