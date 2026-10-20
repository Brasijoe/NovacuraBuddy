# Traffic Recorder Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add IFS Buddy's Traffic Recorder to the extension as a second, independent function (own side-panel tab) that shares one Basic Data instance store with the Projection Tracker.

**Architecture:** The recorder is copied in 1:1 under `recorder/`; only the instance/credential functions inside `recorder/ifs-modules.js` are replaced by calls to the shared `lib/ifs-instances.js` store. Recording (debugger capture) moves from IFS Buddy's `background.js` into `lib/recorder-capture.js`, routed through this extension's single message router. The side panel becomes a three-tab shell (Tracker / Recorder / Basic Data) built from classic-script panel files that share globals, matching the existing `sidepanel.js` idiom.

**Tech Stack:** Chrome MV3 extension, plain JS (classic scripts, `(function (global) { ... })(...)` UMD-style libs), `node --test` for unit tests. No bundler, no dependencies.

**Spec:** `docs/superpowers/specs/2026-10-16-traffic-recorder-merge-design.md`

**Source of the recorder:** `C:\Users\johan\Documents\IFS Cloud Projekt\IFS Buddy` (read-only; never modify it). Referred to below as `$BUDDY`.

## Global Constraints

- Firefox is out of scope: do not modify anything under `firefox/`.
- IFS Buddy (`$BUDDY`) is never modified.
- Everything under `recorder/` stays byte-identical to `$BUDDY/recorder/` except the seam in `recorder/ifs-modules.js` (Task 3) and the script paths in `recorder/viewer.html` (Task 2).
- Storage keys stay exactly: `ifsInstances`, `credentialSalt`, `credentialVerifier`, `credentialSessionKey` (instances/credentials); `sessions` in `chrome.storage.local`; `isRecording`, `currentCalls`, `callCounter` in `chrome.storage.session` (recorder).
- Canonical instance key: `new URL(x).origin` — origin **without** trailing slash.
- Instance record shape: `{ name, authMethod, tokenEndpoint, clientId, encryptedSecret }`.
- Source files use CRLF line endings — keep them (check with `file <path>`; write CRLF when editing).
- Match JSON key order of captured Connect payloads (not touched here, but don't reorder existing payload builders).
- Tests run with: `node --test lib/*.test.js recorder/*.test.js manifest.test.js`

## Review Focus

- **Instance saved by the Tracker before this change (key `https://host/` with slash)** — must still be found by both functions after the one-time migration, and the Tracker's tracked list for it must still show. Pinned in Task 1 (migration test).
- **Recorder's "credentials missing" dialog saving an instance** — must land in Basic Data under the canonical key with a hostname name, not as a second, nameless duplicate. Pinned in Task 3 (seam test).
- **Recorder message types reaching the router** — the old router answered every unknown type with an error; if both answer, the recorder gets a random response. Pinned in Task 4 (`isRecorderMessage` test + router order).
- **Start recording with no attachable tab** (only `chrome://` tabs open) — must report it, not show "Recording…" capturing nothing. Pinned in Task 4.
- **Recorded traffic to an IFS host with no instance** — must raise the unknown-instance notice. Pinned in Task 4 (`unmatchedHostsInCalls` test).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `lib/ifs-instances.js` | modify | Shared basic-data store: canonical keys + migration, `getInstance`, name default, connection check on save, `findInstanceForHost` |
| `lib/recorder-capture.js` | create | Recording: debugger attach/detach, CDP capture, keep-alive, badge, sessions; recorder message handling |
| `lib/recorder-capture.test.js` | create | Pure-helper tests (`isRecorderMessage`, `unmatchedHostsInCalls`, `truncate`) |
| `background.js` | modify | Load recorder-capture, route recorder messages, answer `GET_FLOW_TOKEN`/`CLEAR_FLOW_TOKEN`, use store's save |
| `manifest.json` | modify | Permissions `debugger`, `alarms`, `unlimitedStorage`, `tabs` |
| `recorder/*` | create (copy) | IFS Buddy recorder, verbatim except seam + script paths |
| `panels/common.js` | create | Shared panel helpers moved out of `sidepanel.js` (send, banners, runAction, instance state) |
| `panels/basic-data.js` | create | Basic Data tab (instances, add form, unlock) |
| `panels/tracker.js` | create | Projection Tracker tab (moved from `sidepanel.js`, card rows) |
| `panels/recorder.js` | create | Traffic Recorder tab (ported from `$BUDDY/popup.js`) |
| `sidepanel.js` | rewrite | Tab shell, shared header, unknown-instance notice, polling |
| `sidepanel.html` / `sidepanel.css` | modify | Three-tab layout, card styles |
| `package.json` | modify | Test script includes `recorder/` |

---

### Task 1: Shared basic-data store (canonical keys, migration, name, connection check)

**Files:**
- Modify: `lib/ifs-instances.js`
- Modify: `lib/ifs-instances.test.js`
- Modify: `background.js` (`SAVE_INSTANCE`, `instanceForHost`)

**Interfaces:**
- Produces (all on the store returned by `createIfsInstanceStore(storage)`):
  - `getInstance(baseUrl) -> Promise<{ baseUrl, name, authMethod, tokenEndpoint, clientId, encryptedSecret } | null>`
  - `saveInstance(baseUrl, fields, masterKey, options?) -> Promise<string /* canonical baseUrl */>` — `fields = { name?, authMethod, tokenEndpoint, clientId, secretPayload }`; runs the connection check first (`options.fetchImpl` for tests); throws `Error("Connection check failed, instance not saved — <reason>")` on failure; `name` defaults to the hostname.
  - `listInstances()` returns canonical `baseUrl`s (migrates legacy keys first).
- Produces (module exports): `normalizeBaseUrl(url) -> string`, `findInstanceForHost(instances, hostname) -> instance | undefined`.

- [ ] **Step 1: Write the failing tests** — append to `lib/ifs-instances.test.js` (keep CRLF):

```js
const { normalizeBaseUrl, findInstanceForHost } = require("./ifs-instances.js");

const okTokenFetch = async () => ({ ok: true, json: async () => ({ access_token: "t", expires_in: 3600 }) });
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
```

Existing tests that call `store.saveInstance(...)` without a check: pass `{ fetchImpl: okTokenFetch }` as 4th argument (the two `getIfsAuthToken` tests and the re-save test). In the trimming test the token endpoint has stray whitespace — the check request uses `clean()`, so the same `fakeFetch` that asserts the trimmed values works as `fetchImpl` for the save and for `getIfsAuthToken`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/ifs-instances.test.js`
Expected: FAIL — `normalizeBaseUrl is not a function` / `store.getInstance is not a function`.

- [ ] **Step 3: Implement in `lib/ifs-instances.js`**

Add above `createIfsInstanceStore`:

```js
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
```

Inside `createIfsInstanceStore`, replace `listInstances`, `saveInstance`, `deleteInstance`, `getDecryptedSecret` and the key handling of `getIfsAuthToken`/`clearIfsAuthToken` with:

```js
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
```

In `getIfsAuthToken` and `clearIfsAuthToken`, key the cache by `normalizeBaseUrl(baseUrl)`. Add `getInstance` to the returned object; add `normalizeBaseUrl, findInstanceForHost` to `api`.

- [ ] **Step 4: Update `background.js`**

- `SAVE_INSTANCE`: delete the inline `try { await IfsInstances.requestIfsToken(...) } catch ...` block (the store now checks). Keep the permission check. The save line stays `await instanceStore.saveInstance(message.baseUrl, message.fields, <masterKey>)`.
- Replace the local `instanceForHost` function with `IfsInstances.findInstanceForHost` at its call site, and key tracked projections by the canonical `instance.baseUrl` (already canonical after migration).

- [ ] **Step 5: Run all tests**

Run: `node --test lib/*.test.js manifest.test.js`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add lib/ifs-instances.js lib/ifs-instances.test.js background.js
git commit -m "feat: shared basic-data store — canonical instance keys with migration, name default, connection check on save"
```

---

### Task 2: Copy the recorder in verbatim

**Files:**
- Create: `recorder/` (copied), `recorder/viewer.html` script paths
- Modify: `package.json`

**Interfaces:**
- Produces: `recorder/viewer.html` loads `../lib/credential-crypto.js`, `../lib/projection-filter.js`, `../lib/ifs-instances.js` (globals `CredentialCrypto`, `ProjectionFilter`, `IfsInstances`) before `ifs-modules.js`.

- [ ] **Step 1: Copy**

```bash
cd "/c/Users/johan/Documents/IFS Cloud Projekt"
mkdir -p NovacuraBuddy/recorder
for f in viewer.html viewer.css viewer.js json-grid.js excluded-projections.txt \
         flow-asset-heuristic.js flow-asset-heuristic.test.js flow-asset.js \
         flow-call-optimizer.js flow-call-optimizer.test.js flow-call-script.js flow-call-script.test.js \
         flow-dependency-tracer.js flow-dependency-tracer.test.js flow-keyref.js flow-keyref.test.js \
         flow-steps.js flow-steps.test.js flow-user-input.js flow-user-input.test.js \
         ifs-modules.js ifs-modules.test.js; do
  cp "IFS Buddy/recorder/$f" "NovacuraBuddy/recorder/$f"
done
```

Not copied: `credential-crypto.js(+test)`, `projection-filter.js(+test)` (identical copies live in `lib/`), `package.json`, `Infos/`, `docs/`, `icons/`.

- [ ] **Step 2: Point `recorder/viewer.html` at the shared libs**

Replace `<script src="projection-filter.js"></script>` with `<script src="../lib/projection-filter.js"></script>` and `<script src="credential-crypto.js"></script>` with:

```html
  <script src="../lib/credential-crypto.js"></script>
  <script src="../lib/ifs-instances.js"></script>
```

(Keep its position: before `ifs-modules.js`.)

- [ ] **Step 3: Test script** — `package.json`:

```json
  "scripts": { "test": "node --test lib/*.test.js recorder/*.test.js manifest.test.js" }
```

- [ ] **Step 4: Run all tests**

Run: `node --test lib/*.test.js recorder/*.test.js manifest.test.js`
Expected: all pass (the recorder's own suites run unchanged; `$BUDDY` ran 380 including the two suites not copied).

- [ ] **Step 5: Commit**

```bash
git add recorder package.json
git commit -m "feat: copy IFS Buddy's Traffic Recorder in verbatim (shared crypto/filter from lib/)"
```

---

### Task 3: The seam — recorder instance/credential access through Basic Data

**Files:**
- Modify: `recorder/ifs-modules.js` (lines ~290–363 and ~485–526 in the copied file: `cachedMasterKey` … `getDecryptedSecret`, `ifsTokenCache` … `clearIfsAuthToken`)
- Modify: `recorder/ifs-modules.test.js`

**Interfaces:**
- Consumes: `IfsInstances.createIfsInstanceStore`, store `ensureMasterKey`, `getInstance`, `saveInstance`, `getIfsAuthToken`, `clearIfsAuthToken` (Task 1).
- Produces: unchanged recorder-internal signatures — `ensureMasterKey(promptFn)`, `getIfsInstance(ifsBaseUrl)`, `saveIfsInstance(ifsBaseUrl, authMethod, tokenEndpoint, clientId, secretPayload, masterKey)`, `getIfsAuthToken(ifsBaseUrl, masterKey)`, `clearIfsAuthToken(ifsBaseUrl)` — now also exported under Node for tests.

- [ ] **Step 1: Write the failing test** — append to `recorder/ifs-modules.test.js`:

```js
test("the recorder's instance functions read and write the shared Basic Data store", async () => {
  const local = {}, session = {};
  const area = (backing) => ({
    async get(keys) { const out = {}; for (const k of [].concat(keys)) if (k in backing) out[k] = backing[k]; return out; },
    async set(obj) { Object.assign(backing, obj); }
  });
  global.chrome = { storage: { local: area(local), session: area(session) } };
  global.CredentialCrypto = require("../lib/credential-crypto.js");
  global.IfsInstances = require("../lib/ifs-instances.js");
  global.fetch = async () => ({ ok: true, json: async () => ({ access_token: "tok", expires_in: 3600 }) });
  delete require.cache[require.resolve("./ifs-modules.js")];
  const mod = require("./ifs-modules.js");

  const key = await mod.ensureMasterKey(async () => "pw");
  await mod.saveIfsInstance("https://ifs.example.com", "client_credentials", "https://ifs.example.com/token", "client-1", { clientSecret: "s" }, key);

  assert.deepEqual(Object.keys(local.ifsInstances), ["https://ifs.example.com"]);
  assert.equal(local.ifsInstances["https://ifs.example.com"].name, "ifs.example.com", "named, not a nameless duplicate");
  assert.equal((await mod.getIfsInstance("https://ifs.example.com/")).clientId, "client-1");
  assert.equal(await mod.getIfsAuthToken("https://ifs.example.com", key), "tok");
  delete global.chrome; delete global.fetch;
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test recorder/ifs-modules.test.js`
Expected: FAIL — `mod.ensureMasterKey is not a function`.

- [ ] **Step 3: Replace the seam in `recorder/ifs-modules.js`**

Replace the block from `let cachedMasterKey = null;` through the end of `getDecryptedSecret(...)` with:

```js
  /* --- Basic Data seam (NovacuraBuddy) ---
   * IFS instances, credentials and the master password come from the extension's shared
   * Basic Data store (lib/ifs-instances.js), which the Projection Tracker uses too. Same storage
   * keys as before; the store adds canonical instance keys, names, trimming and the connection
   * check. The prompts below (promptMasterPassword / promptIfsCredentials) stay the recorder's own
   * UI and hand their results to the store. Created lazily: chrome.* doesn't exist at require time
   * under Node. */
  let sharedStore = null;
  function basicData() {
    if (!sharedStore) {
      sharedStore = IfsInstances.createIfsInstanceStore({ local: chrome.storage.local, session: chrome.storage.session });
    }
    return sharedStore;
  }

  async function ensureMasterKey(promptFn) {
    return basicData().ensureMasterKey(promptFn);
  }

  async function getIfsInstance(ifsBaseUrl) {
    return basicData().getInstance(ifsBaseUrl);
  }

  async function saveIfsInstance(ifsBaseUrl, authMethod, tokenEndpoint, clientId, secretPayload, masterKey) {
    await basicData().saveInstance(ifsBaseUrl, { authMethod, tokenEndpoint, clientId, secretPayload }, masterKey);
  }
```

Replace the block from `const ifsTokenCache = {};` through the end of `clearIfsAuthToken(...)` with:

```js
  async function getIfsAuthToken(ifsBaseUrl, masterKey) {
    return basicData().getIfsAuthToken(ifsBaseUrl, masterKey);
  }

  function clearIfsAuthToken(ifsBaseUrl) {
    basicData().clearIfsAuthToken(ifsBaseUrl);
  }
```

Remove the now-unused constants `IFS_INSTANCES_KEY`, `CRED_SALT_KEY`, `CRED_VERIFIER_KEY`, `SESSION_KEY_STORAGE` at the top only if nothing else in the file references them (`grep -n` each; leave any still used). Add to the Node `module.exports` object: `ensureMasterKey, getIfsInstance, saveIfsInstance, getIfsAuthToken, clearIfsAuthToken`.

Note: `ensureIfsAccess` saves via `saveIfsInstance`, which now runs the connection check and throws `Connection check failed, …` on bad credentials. Its existing loop catches token failures for an *existing* instance; for the save itself, wrap nothing — the thrown error surfaces in the Explorer's existing error path, which is the intended "not saved" signal.

- [ ] **Step 4: Run all tests**

Run: `node --test lib/*.test.js recorder/*.test.js manifest.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add recorder/ifs-modules.js recorder/ifs-modules.test.js
git commit -m "feat: recorder reads IFS instances and credentials from Basic Data"
```

---

### Task 4: Recording in the background

**Files:**
- Create: `lib/recorder-capture.js`, `lib/recorder-capture.test.js`
- Modify: `background.js`, `manifest.json`, `manifest.test.js`

**Interfaces:**
- Produces (global `RecorderCapture` / Node exports):
  - `isRecorderMessage(type) -> boolean` — true for `START_RECORDING`, `STOP_RECORDING`, `GET_STATUS`, `OPEN_VIEWER`
  - `handleMessage(msg, sendResponse) -> true | undefined` (same contract as an `onMessage` listener body)
  - `unmatchedHostsInCalls(calls, instances) -> string[]` — distinct hostnames of `/main/ifsapplications/projection` calls with no matching instance
  - `truncate(str) -> string|null`
  - `init()` — restore state after a worker restart
- Consumes: `IfsInstances.findInstanceForHost` (Task 1).

- [ ] **Step 1: Write the failing tests** — `lib/recorder-capture.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { isRecorderMessage, unmatchedHostsInCalls, truncate } = require("./recorder-capture.js");

test("isRecorderMessage claims exactly the recorder's message types", () => {
  for (const t of ["START_RECORDING", "STOP_RECORDING", "GET_STATUS", "OPEN_VIEWER"]) assert.equal(isRecorderMessage(t), true);
  for (const t of ["GET_FLOW_TOKEN", "GET_TRACKED", "CREATE_MODULE", undefined]) assert.equal(isRecorderMessage(t), false);
});

test("unmatchedHostsInCalls lists IFS hosts without an instance, once each", () => {
  const calls = [
    { url: "https://known.example.com/main/ifsapplications/projection/v1/A.svc/X" },
    { url: "https://new.example.com/main/ifsapplications/projection/v1/B.svc/Y" },
    { url: "https://new.example.com/main/ifsapplications/projection/v1/C.svc/Z" },
    { url: "https://cdn.example.com/script.js" }
  ];
  const instances = [{ baseUrl: "https://known.example.com", name: "K" }];
  assert.deepEqual(unmatchedHostsInCalls(calls, instances), ["new.example.com"]);
});

test("truncate caps very large bodies", () => {
  assert.equal(truncate(null), null);
  assert.ok(truncate("x".repeat(2000000)).length < 2000000);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test lib/recorder-capture.test.js`
Expected: FAIL — `Cannot find module './recorder-capture.js'`.

- [ ] **Step 3: Create `lib/recorder-capture.js`**

Wrap in the same UMD shape as the other libs:

```js
(function (global) {
  const IfsInstances = typeof require === "function" ? require("./ifs-instances.js") : global.IfsInstances;
  const RECORDER_MESSAGES = new Set(["START_RECORDING", "STOP_RECORDING", "GET_STATUS", "OPEN_VIEWER"]);
  const hasChrome = typeof chrome !== "undefined" && !!chrome.debugger;

  function isRecorderMessage(type) {
    return RECORDER_MESSAGES.has(type);
  }

  function unmatchedHostsInCalls(calls, instances) {
    const hosts = new Set();
    for (const call of calls || []) {
      const url = call.url || "";
      if (!url.includes("/main/ifsapplications/projection")) continue;
      let host;
      try { host = new URL(url).hostname; } catch { continue; }
      if (!IfsInstances.findInstanceForHost(instances, host)) hosts.add(host);
    }
    return [...hosts];
  }

  // ---- copied from $BUDDY/background.js (recording part), verbatim unless noted ----
  // ...
})(typeof window !== "undefined" ? window : globalThis);
```

Into the `// ---- copied ...` region, copy **verbatim** from `$BUDDY/background.js`:
- constants `URL_FILTER`, `CDP_VERSION`, `MAX_BODY_CHARS` and state `isRecording`, `currentCalls`, `callCounter`, `attachedTabs`, `inflight`, `persistTimer`, `keepAliveTimer`;
- functions `init`, `updateBadge`, `startKeepAlive`, `stopKeepAlive`, `attachAllTabs`, `attachTab`, `detachAllTabs`, `safeAtob`, `truncate`, `pushCall`, `schedulePersist`, `finalizeSession`;
- the listeners `chrome.alarms.onAlarm…`, `chrome.tabs.onUpdated/onCreated/onRemoved…` (recording ones), `chrome.debugger.onDetach…`, `chrome.debugger.onEvent…` (the capture switch).

Do **not** copy the Flow-token capture (`getCachedFlowAuthToken` … `doCaptureFlowAuthToken`, `FLOW_URL_PATTERN`, `FLOW_TOKEN_CACHE_TTL_MS`, `pendingFlowTokenCapture`) or the router. Wrap every listener registration in `if (hasChrome) { ... }` so the file loads under Node.

Then add the recorder message handling (cases copied from `$BUDDY/background.js`'s router, with two changes marked):

```js
  async function attachAllTabsCounting() {
    await attachAllTabs();
    return attachedTabs.size;
  }

  function handleMessage(msg, sendResponse) {
    switch (msg.type) {
      case "START_RECORDING":
        (async () => {
          isRecording = true;
          currentCalls = [];
          inflight.clear();
          await chrome.storage.session.set({ isRecording: true, currentCalls: [] });
          updateBadge();
          startKeepAlive();
          // NovacuraBuddy: report when no tab could be attached, instead of "recording" nothing.
          const attached = await attachAllTabsCounting();
          sendResponse(attached > 0 ? { ok: true } : { ok: true, warning: "No tab could be attached — open an IFS tab (http/https) and it will be picked up." });
        })();
        return true;
      case "STOP_RECORDING":
        (async () => {
          // verbatim body of $BUDDY's STOP_RECORDING case up to and including
          // `const session = await finalizeSession();` and the storage.session reset
          // NovacuraBuddy: hosts in this session without a Basic Data instance
          const instances = await global.__recorderInstanceStore.listInstances();
          const unmatchedHosts = unmatchedHostsInCalls(session.calls, instances);
          sendResponse({ ok: true, session, unmatchedHosts });
        })();
        return true;
      case "GET_STATUS":
        sendResponse({ recording: isRecording, callCount: currentCalls.length, attachedTabs: attachedTabs.size });
        return undefined;
      case "OPEN_VIEWER":
        chrome.tabs.create({ url: chrome.runtime.getURL("recorder/viewer.html" + (msg.sessionId ? "?s=" + msg.sessionId : "")) });
        sendResponse({ ok: true });
        return undefined;
    }
    return undefined;
  }

  const api = { isRecorderMessage, handleMessage, unmatchedHostsInCalls, truncate, init };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.RecorderCapture = api;
```

In the `STOP_RECORDING` case, the commented line is a copy instruction, not a placeholder: paste `$BUDDY/background.js` STOP_RECORDING's statements from `isRecording = false;` through `await chrome.storage.session.set({ isRecording: false, currentCalls: [] });` in place of the two comment lines. `global.__recorderInstanceStore` is set by `background.js` (Step 4) to the shared store.

- [ ] **Step 4: Wire into `background.js`**

- Add `"lib/recorder-capture.js"` to `importScripts(...)` after `"lib/ifs-instances.js"`.
- After `const instanceStore = ...;` add `globalThis.__recorderInstanceStore = instanceStore;` and call `RecorderCapture.init();` inside `init()` after `restorePersistedState()`.
- In the `chrome.runtime.onMessage` listener, **first statement inside the async IIFE after `await ready;`**:

```js
      if (RecorderCapture.isRecorderMessage(message.type)) {
        // The recorder answers these itself; this router must not answer them too (the old
        // default branch replied "Unknown message type", racing the recorder's real reply).
        // The listener already returns true, so the async reply is allowed.
        RecorderCapture.handleMessage(message, (response) => {
          if (message.type === "STOP_RECORDING" && response && response.unmatchedHosts) {
            response.unmatchedHosts.forEach((host) => recordUnmatchedHost(host));
          }
          sendResponse(response);
        });
        return;
      }
```

- Add router cases for the Explorer's token requests:

```js
        case "GET_FLOW_TOKEN": {
          const token = flowToken.get();
          if (!token) return sendResponse({ ok: false, error: "No Novacura Flow session found yet — open or click into a build.novacura.com tab first." });
          return sendResponse({ ok: true, token });
        }
        case "CLEAR_FLOW_TOKEN":
          flowToken.clear();
          await chrome.storage.session.remove(FLOW_TOKEN_PERSIST_KEY);
          return sendResponse({ ok: true });
```

- [ ] **Step 5: Manifest** — `manifest.json` permissions become:

```json
  "permissions": ["storage", "sidePanel", "webRequest", "debugger", "alarms", "unlimitedStorage", "tabs"],
```

Update `manifest.test.js` if it asserts the permission list (match the new list exactly).

- [ ] **Step 6: Run all tests**

Run: `node --test lib/*.test.js recorder/*.test.js manifest.test.js`
Expected: all pass. Also `node --check background.js`.

- [ ] **Step 7: Commit**

```bash
git add lib/recorder-capture.js lib/recorder-capture.test.js background.js manifest.json manifest.test.js
git commit -m "feat: recorder capture in the background — debugger recording, sessions, Flow token from the shared sniffer"
```

---

### Task 5: Side panel becomes a three-tab shell (Tracker + Basic Data split out, no behaviour change)

**Files:**
- Create: `panels/common.js`, `panels/basic-data.js`, `panels/tracker.js`
- Rewrite: `sidepanel.js`
- Modify: `sidepanel.html`, `sidepanel.css`

**Interfaces:**
- Produces (globals in `panels/common.js`): `send(message)`, `showError(message, sticky)`, `clearError(force)`, `showNotice(message)`, `sendOrShowError(message, sticky)`, `actionOrShowError(message)`, `runAction(btn, busyLabel, action)`, `masterPasswordOf()`, state `currentBaseUrl`, `currentInstances`, `refreshLockStatus()`, `updateCurrentInstanceLabel()`.
- Produces: `panels/basic-data.js` → `refreshInstances()`, `prefillInstanceForm({ baseUrl, name })`; `panels/tracker.js` → `refreshProjections()`, `resetProjectionList()`, `initTrackingToggle()`; `sidepanel.js` → `showTab(name)` with `name` in `"tracker" | "recorder" | "basic-data"`.

- [ ] **Step 1: Move code (cut/paste, no edits)**
  - `panels/common.js`: from `sidepanel.js` — `send`, the sticky-error block (`errorIsSticky`, `showNotice`, `showError`, `clearError`, the error-banner click listener), `sendOrShowError`, `currentBaseUrl`, `currentInstances`, `updateCurrentInstanceLabel`, `masterPasswordOf`, `refreshLockStatus`, `unlock` + its two listeners, `actionOrShowError`, `runAction`.
  - `panels/basic-data.js`: `refreshInstances`, the `instanceForm` submit listener.
  - `panels/tracker.js`: `searchResultNames`, `initTrackingToggle` + trackingToggle listener, `statusLabel`, `rowElements`, `projectionListEl`, `resetProjectionList`, `buildProjectionRow`, `renderActions`, `upsertProjectionRow`, `refreshProjections`, clear-trace and search listeners.
  - In `refreshInstances`' row click handler, `resetProjectionList()`/`refreshProjections()` stay (tracker globals are loaded before it runs).

- [ ] **Step 2: `panels/basic-data.js` gains the prefill used by the unknown-instance notice**

```js
function prefillInstanceForm({ baseUrl, name }) {
  document.getElementById("instanceBaseUrl").value = baseUrl;
  document.getElementById("instanceName").value = name;
  document.getElementById("instanceTokenEndpoint").focus();
}
```

- [ ] **Step 3: New `sidepanel.js` (shell)**

```js
const TAB_KEY = "activeTab";
const TABS = ["tracker", "recorder", "basic-data"];

function showTab(name) {
  for (const tab of TABS) {
    document.getElementById(`tab-${tab}`).classList.toggle("is-active", tab === name);
    document.getElementById(`panel-${tab}`).hidden = tab !== name;
  }
  try { localStorage.setItem(TAB_KEY, name); } catch { /* per-viewer convenience only */ }
}

for (const tab of TABS) document.getElementById(`tab-${tab}`).addEventListener("click", () => showTab(tab));

let initialTab = "tracker";
try { initialTab = TABS.includes(localStorage.getItem(TAB_KEY)) ? localStorage.getItem(TAB_KEY) : "tracker"; } catch { /* default */ }
showTab(initialTab);

initTrackingToggle();
refreshLockStatus();
refreshInstances();
refreshProjections();
setInterval(() => { refreshProjections(); refreshLockStatus(); }, 5000);
```

(`refreshUnmatchedHosts` moves to Task 8; until then remove its call and the `#unmatchedHosts` container stays empty.)

- [ ] **Step 4: `sidepanel.html` layout**

Header keeps the banners, the instance label, and the lock chip; the tracking toggle moves into the tracker panel. Then:

```html
    <nav class="tabs" role="tablist">
      <button id="tab-tracker" class="tab" role="tab">Projection Tracker</button>
      <button id="tab-recorder" class="tab" role="tab">Traffic Recorder</button>
      <button id="tab-basic-data" class="tab" role="tab">Basic Data</button>
    </nav>

    <section id="panel-tracker" role="tabpanel" hidden> <!-- tracking toggle, search row, unmatchedHosts, main list (moved as-is) --> </section>
    <section id="panel-recorder" role="tabpanel" hidden><!-- Task 6 --></section>
    <section id="panel-basic-data" role="tabpanel" hidden> <!-- unlockRow, instanceList, instanceForm (moved as-is, no <details> wrapper) --> </section>

    <script src="panels/common.js"></script>
    <script src="panels/tracker.js"></script>
    <script src="panels/basic-data.js"></script>
    <script src="sidepanel.js"></script>
```

The comments mark where the existing markup is moved, element for element (ids unchanged). The recorder section stays empty until Task 6.

- [ ] **Step 5: Styles** — add to `sidepanel.css`, using existing tokens:

```css
/* ---------- tabs ---------- */
.tabs { display: flex; gap: var(--space-1); border-bottom: 1px solid var(--surface-raised); }
.tab { border: none; border-bottom: 2px solid transparent; border-radius: 0; background: none; color: var(--ink-muted); padding: var(--space-2) var(--space-3); font-weight: 600; }
.tab:hover:not(:disabled) { color: var(--accent); border-color: transparent; }
.tab.is-active { color: var(--accent); border-bottom-color: var(--accent); }
```

(If `--space-1` doesn't exist in `:root`, use `4px`.)

- [ ] **Step 6: Verify**

Run: `node --check panels/common.js && node --check panels/tracker.js && node --check panels/basic-data.js && node --check sidepanel.js` and `node --test lib/*.test.js recorder/*.test.js manifest.test.js`. Manual: reload the extension; Tracker tab behaves exactly as before (search, Create, Activate, lock chip); Basic Data tab lists instances, Test works, Add runs the connection check; tab choice survives reopening the panel.

- [ ] **Step 7: Commit**

```bash
git add panels sidepanel.js sidepanel.html sidepanel.css
git commit -m "refactor: side panel as a tab shell — Tracker and Basic Data split into panel files"
```

---

### Task 6: Traffic Recorder tab

**Files:**
- Create: `panels/recorder.js`
- Modify: `sidepanel.html` (`#panel-recorder`, script tag), `sidepanel.css`, `sidepanel.js` (init call)

**Interfaces:**
- Consumes: `send`, `actionOrShowError`, `showError`, `showNotice` (Task 5); messages `START_RECORDING`, `STOP_RECORDING` (`{ ok, session, unmatchedHosts }`), `GET_STATUS`, `OPEN_VIEWER` (Task 4).
- Produces: `initRecorderPanel()`.

- [ ] **Step 1: Markup** — `#panel-recorder`:

```html
      <div class="recorder-controls">
        <button id="startBtn" class="btn-primary">● Start</button>
        <button id="stopBtn" disabled>■ Stop</button>
        <button id="viewerBtn" title="Open Full Viewer">Open viewer</button>
      </div>
      <div id="recStatusBar" class="status-bar"><span class="status-indicator"></span><span id="recStatusText">Ready to record</span></div>
      <h2>Recorded Sessions</h2>
      <div id="sessionList" class="session-list"></div>
```

Add `<script src="panels/recorder.js"></script>` before `sidepanel.js`; call `initRecorderPanel();` in `sidepanel.js` after `refreshProjections();`.

- [ ] **Step 2: `panels/recorder.js`** — port of `$BUDDY/popup.js`'s recorder part, ids prefixed where they'd collide, errors through the shared banner:

```js
let recPollTimer = null;

function updateRecorderStatus() {
  send({ type: "GET_STATUS" }).then((res) => {
    if (!res || res.recording === undefined) return;
    document.getElementById("startBtn").disabled = res.recording;
    document.getElementById("stopBtn").disabled = !res.recording;
    const bar = document.getElementById("recStatusBar");
    const txt = document.getElementById("recStatusText");
    if (res.recording) {
      bar.className = "status-bar recording";
      txt.textContent = `Recording (${res.callCount} calls captured)`;
    } else {
      bar.className = "status-bar";
      if (!txt.textContent.startsWith("Saved")) txt.textContent = "Ready to record";
    }
  });
}

function startRecorderPolling() { stopRecorderPolling(); recPollTimer = setInterval(updateRecorderStatus, 800); }
function stopRecorderPolling() { if (recPollTimer) clearInterval(recPollTimer); recPollTimer = null; }

async function getSessions() {
  const { sessions = [] } = await chrome.storage.local.get("sessions");
  return sessions;
}
const saveSessions = (s) => chrome.storage.local.set({ sessions: s });

async function renderSessions() {
  const list = document.getElementById("sessionList");
  const sessions = await getSessions();
  list.innerHTML = "";
  if (!sessions.length) {
    list.innerHTML = '<div class="empty-state">No recorded sessions yet.</div>';
    return;
  }
  for (const s of sessions) list.appendChild(buildSessionCard(s));
}
```

`buildSessionCard(s)`: copy the body of `$BUDDY/popup.js`'s `sessions.forEach((s) => { ... })` callback verbatim (card, `sess-info` with title + meta, `OPEN_VIEWER` on click, inline rename with Enter/Escape/blur, delete with `confirm`), ending in `return item;` instead of `list.appendChild(item);`.

```js
function initRecorderPanel() {
  document.getElementById("startBtn").onclick = async () => {
    const res = await actionOrShowError({ type: "START_RECORDING" });
    if (res && res.warning) showError(res.warning, true);
    updateRecorderStatus();
    startRecorderPolling();
  };
  document.getElementById("stopBtn").onclick = async () => {
    const res = await actionOrShowError({ type: "STOP_RECORDING" });
    stopRecorderPolling();
    updateRecorderStatus();
    renderSessions();
    if (res && res.session) {
      document.getElementById("recStatusText").textContent = `Saved "${res.session.name}" (${res.session.calls.length} calls)`;
    }
  };
  document.getElementById("viewerBtn").onclick = () => send({ type: "OPEN_VIEWER" });
  updateRecorderStatus();
  renderSessions();
  send({ type: "GET_STATUS" }).then((res) => { if (res && res.recording) startRecorderPolling(); });
}
```

- [ ] **Step 3: Styles** — card list in the tracker's light/dark tokens (recorder's popup was dark-only):

```css
/* ---------- recorder ---------- */
.recorder-controls { display: flex; gap: var(--space-2); }
.status-bar { display: flex; align-items: center; gap: var(--space-2); font-size: 12px; color: var(--ink-muted); }
.status-indicator { width: 7px; height: 7px; border-radius: 50%; background: var(--neutral); }
.status-bar.recording { color: var(--accent-orange); font-weight: 600; }
.status-bar.recording .status-indicator { background: var(--accent-orange); }
.session-list { display: flex; flex-direction: column; gap: var(--space-2); }
.sess-item { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3); border: 1px solid var(--surface-raised); border-radius: var(--radius-md); background: var(--surface); box-shadow: var(--shadow-raised); }
.sess-item:hover { border-color: var(--accent-soft); }
.sess-info { flex: 1; min-width: 0; cursor: pointer; }
.sess-title { font-weight: 600; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sess-meta { font-size: 11px; color: var(--ink-muted); margin-top: 2px; }
.icon-btn { border: none; background: none; padding: 4px; color: var(--ink-muted); }
.icon-btn:hover:not(:disabled) { color: var(--accent); }
.icon-btn.del:hover:not(:disabled) { color: var(--accent-red); }
input.rename-input { width: 100%; }
.empty-state { color: var(--ink-muted); font-size: 12px; padding: var(--space-3); text-align: center; }
```

- [ ] **Step 4: Verify**

`node --check panels/recorder.js`; full test run. Manual: reload extension → Recorder tab → Start (yellow debug bar appears, badge `REC`), click around in IFS, status counts up → Stop → "Saved …" and a new card → click card opens the Traffic Explorer with the calls → rename (Enter) and delete (confirm) work.

- [ ] **Step 5: Commit**

```bash
git add panels/recorder.js sidepanel.html sidepanel.css sidepanel.js
git commit -m "feat: Traffic Recorder tab — start/stop, status, recorded sessions with open/rename/delete"
```

---

### Task 7: Tracker rows as cards

**Files:**
- Modify: `panels/tracker.js` (`buildProjectionRow`, `upsertProjectionRow`), `sidepanel.css`

**Interfaces:**
- Consumes: tracked rows `{ projectionName, firstSeenAt, hitCount }` from `GET_TRACKED`; statuses from `GET_MODULE_STATUSES`; `statusLabel`, `renderActions` unchanged.

- [ ] **Step 1: Card markup** — `buildProjectionRow()` returns the same `{ row, name, status, actions, lastStatus }` object (all callers keep working), built as a card:

```js
function buildProjectionRow() {
  const row = document.createElement("li");
  row.className = "sess-item projection-card";

  const info = document.createElement("div");
  info.className = "sess-info";
  const name = document.createElement("div");
  name.className = "sess-title proj-name";
  const meta = document.createElement("div");
  meta.className = "sess-meta";
  const status = document.createElement("span");
  status.className = "status";
  const metaText = document.createElement("span");
  metaText.className = "proj-meta-text";
  meta.append(status, metaText);
  info.append(name, meta);

  const actions = document.createElement("span");
  actions.className = "proj-actions";

  row.append(info, actions);
  return { row, name, status, metaText, actions, lastStatus: null };
}
```

- [ ] **Step 2: Meta line** — in `refreshProjections`, keep a map `trackedByName` (upper-cased name → tracked row) built from `trackedResponse.tracked`, and after `upsertProjectionRow(name, ...)` set:

```js
    const tracked = trackedByName.get(name.toUpperCase());
    const entry = rowElements.get(name.toUpperCase());
    entry.metaText.textContent = tracked
      ? ` · ${tracked.hitCount} hit${tracked.hitCount === 1 ? "" : "s"} · first seen ${new Date(tracked.firstSeenAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : " · from search";
```

- [ ] **Step 3: Styles** — the list becomes a flex column like `.session-list`; remove the grid/`display: contents` rules for `.projection-row` (no longer used):

```css
.projection-list { display: flex; flex-direction: column; gap: var(--space-2); list-style: none; padding: 0; margin: 0; }
.projection-card .proj-actions { display: flex; gap: var(--space-2); flex-shrink: 0; }
```

Status chip colours (`.status-*`) are unchanged.

- [ ] **Step 4: Verify** — full test run; manual: tracked projections show as cards with name, status chip, hits, first-seen time; Create/Activate/Reload & Activate buttons unchanged and working; search results show "from search".

- [ ] **Step 5: Commit**

```bash
git add panels/tracker.js sidepanel.css
git commit -m "feat: Projection Tracker rows as cards, matching the recorded-sessions look"
```

---

### Task 8: Unknown-instance notice in the shared header

**Files:**
- Modify: `sidepanel.js`, `sidepanel.html`, `background.js`, `sidepanel.css`

**Interfaces:**
- Consumes: `GET_UNMATCHED_HOSTS` (`{ hosts: string[] }`, fed by the Tracker's webRequest listener and by `STOP_RECORDING`, Task 4); `showTab` (Task 5); `prefillInstanceForm` (Task 5).
- Produces: message `DISMISS_UNMATCHED_HOST { host }`.

- [ ] **Step 1: Background** — add router case:

```js
        case "DISMISS_UNMATCHED_HOST": {
          const { [UNMATCHED_HOSTS_KEY]: hosts = [] } = await chrome.storage.session.get(UNMATCHED_HOSTS_KEY);
          await chrome.storage.session.set({ [UNMATCHED_HOSTS_KEY]: hosts.filter((h) => h !== message.host) });
          return sendResponse({ ok: true });
        }
```

Also: after a successful `SAVE_INSTANCE`, remove the saved instance's hostname from `UNMATCHED_HOSTS_KEY` the same way (so the notice clears itself).

- [ ] **Step 2: Header container** — move `<div id="unmatchedHosts"></div>` out of the tracker panel into the header area, directly under `#designerHint`.

- [ ] **Step 3: `sidepanel.js`**

```js
async function refreshUnmatchedHosts() {
  const response = await send({ type: "GET_UNMATCHED_HOSTS" });
  if (!response || !response.ok) return;
  const container = document.getElementById("unmatchedHosts");
  container.innerHTML = "";
  for (const host of response.hosts) {
    const notice = document.createElement("div");
    notice.className = "banner banner-warning";
    const label = document.createElement("span");
    label.textContent = `IFS instance ${host} isn't set up yet.`;
    const save = document.createElement("button");
    save.textContent = "Save now";
    save.className = "btn-primary";
    save.onclick = () => {
      showTab("basic-data");
      prefillInstanceForm({ baseUrl: `https://${host}`, name: host });
    };
    const dismiss = document.createElement("button");
    dismiss.textContent = "Dismiss";
    dismiss.className = "btn-ghost";
    dismiss.onclick = async () => { await send({ type: "DISMISS_UNMATCHED_HOST", host }); refreshUnmatchedHosts(); };
    notice.append(label, save, dismiss);
    container.appendChild(notice);
  }
}
```

Call `refreshUnmatchedHosts()` at startup and in the 5 s interval; after Stop in `panels/recorder.js` call it too (`if (typeof refreshUnmatchedHosts === "function") refreshUnmatchedHosts();`).

- [ ] **Step 4: Style**

```css
.banner-warning { display: flex; align-items: center; gap: var(--space-2); background: #fff6ee; color: #7a3b0a; border: 1px solid var(--accent-orange); }
.banner-warning span { flex: 1; }
@media (prefers-color-scheme: dark) { .banner-warning { background: rgba(253, 110, 21, 0.12); color: #ffc89e; } }
```

- [ ] **Step 5: Verify** — full test run; manual: record a session against a host not in Basic Data → notice appears after Stop → Save now opens Basic Data with URL and name filled → saving (connection check) removes the notice; Dismiss hides it for the session; Tracker traffic to an unknown host raises the same notice.

- [ ] **Step 6: Commit**

```bash
git add sidepanel.js sidepanel.html sidepanel.css background.js panels/recorder.js
git commit -m "feat: unknown IFS instance notice for Tracker and Recorder with Save now"
```

---

### Task 9: End-to-end live check and docs

**Files:**
- Modify: `docs/superpowers/specs/2026-10-16-traffic-recorder-merge-design.md` (status line)

- [ ] **Step 1: Full test run** — `node --test lib/*.test.js recorder/*.test.js manifest.test.js`; all pass.

- [ ] **Step 2: Live checklist (user runs, report results)**
  1. Reload extension, reopen side panel; three tabs, consistent look; last tab remembered.
  2. Basic Data: the pre-existing instance shows once (migrated, no slash duplicate); Test → OK.
  3. Tracker: Create/Activate on a Designer flow works as before; cards render.
  4. Recorder: record on the real IFS instance → session card → opens Explorer → generate a Flow component from it **without** being asked for IFS credentials (Basic Data instance used); master password asked at most once (shared unlock).
  5. Unknown host notice → Save now → saved.

- [ ] **Step 3: Mark spec implemented** — change `Status: draft for review` to `Status: implemented (2026-10-16), live-verified items: <list from Step 2>`.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-10-16-traffic-recorder-merge-design.md
git commit -m "docs: traffic recorder merge implemented"
```
