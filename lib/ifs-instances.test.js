const test = require("node:test");
const assert = require("node:assert/strict");
const { createIfsInstanceStore } = require("./ifs-instances.js");

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
  }, key);

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
  }, key);

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
