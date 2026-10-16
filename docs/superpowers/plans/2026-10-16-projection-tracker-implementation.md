# IFS Projection Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Chrome MV3 extension that passively traces IFS Cloud `.svc` projection calls, shows them in a side panel, and — when a Novacura Flow Connect Designer tab is open — turns a traced or searched projection into a Connect module, pushes it to that Designer tab's package, and activates it in the open flow.

**Architecture:** A service-worker background script owns all `chrome.webRequest`/`chrome.storage`/`fetch` state; every piece of actual logic (filtering, credential crypto, IFS projection lookup, Flow Connect REST calls, module commit, designer-tab id resolution, status computation) lives in dependency-injected, Node-testable pure modules under `lib/`, ported from the already-proven `IFS-Buddy` project. The side panel and the Designer-tab content script are thin UI/DOM glue that only talk to the background script via `chrome.runtime` messages.

**Tech Stack:** Chrome Extension Manifest V3 (service worker, side panel API, webRequest, content scripts), vanilla JS (no bundler — matches `IFS-Buddy`'s own dependency-free style), Node's built-in `node:test` + `node:assert/strict` for every pure module.

**Spec:** `docs/superpowers/specs/2026-10-16-projection-tracker-design.md`

## Global Constraints

- No `debugger` permission anywhere in this project (spec §1/§7a) — Flow Connect auth and all tracing use `webRequest`/`fetch` only.
- Every IFS Cloud call this project makes is projection-metadata-only (catalog lookup, `$metadata`, OpenAPI spec) — never business data (spec §2, §6).
- `.svc` tracking filter must reuse `IFS-Buddy`'s exact exclusion semantics: case-insensitive match on the `.svc` segment, with or without the suffix (spec §4, ported from `projection-filter.js`).
- Every Flow Connect write is followed by a commit when the spec's sequence says so — an uncommitted draft is treated as a bug, not an acceptable resting state (spec §8, §11).
- Every thrown error from a failed Flow Connect/IFS call must include the real response body text, never just a status code (spec §11, the `throwWithResponseBody` convention).
- Every unresolved/best-effort behavior (refresh-button click, `assetVersion` staleness, `extraHeaders` token capture) degrades silently to a user-visible message — never a hard crash (spec §9, §10, §11).
- v1 UI is plain/functional markup only — no visual design pass (spec §13).

## Review Focus

- A projection hit twice in one session must increment `hitCount` on the same row, never create a duplicate row (spec §4) — Task 7.
- Toggling tracking off must not erase already-recorded rows, only stop new ones from being added (spec §4) — Task 7.
- Matching a projection name against an exclusion entry or an existing module asset must be case-insensitive (ported upstream behavior, e.g. `ProjectionName.toUpperCase()`) — Tasks 2, 9.
- Acting (Create/Activate) with no Designer tab open, or one that's navigated away mid-action, must fail with an inline reason, never an unhandled rejection (spec §7, §11) — Tasks 8, 11.
- "Reload & Activate" on a row already in `assets[]` must bump that entry's `assetVersion` in place, never append a second entry for the same `assetId` (spec §8) — Task 8.

---

## File Structure

```
manifest.json
background.js                 Service worker: webRequest wiring, message router, orchestration
sidepanel.html / .css / .js    Panel UI (plain/functional)
content/designer.js            Injected into build.novacura.com: refresh-button click
lib/
  projection-filter.js          Ported verbatim from IFS-Buddy
  projection-filter.test.js
  excluded-projections.txt     Ported verbatim from IFS-Buddy
  credential-crypto.js         Ported verbatim from IFS-Buddy
  credential-crypto.test.js
  ifs-instances.js             Multi-instance store, master-password key, IFS OAuth token
  ifs-instances.test.js
  projection-search.js         ProjectionExplorer.svc resolution + codegen input fetch
  projection-search.test.js
  flow-connect-rest.js         flowFetch() + throwWithResponseBody()
  flow-connect-rest.test.js
  flow-token.js                Bearer-token extraction from sniffed headers + TTL cache
  flow-token.test.js
  tracking.js                  Pure session-list dedupe/hitCount logic
  tracking.test.js
  flow-designer-tab.js         URL parsing, packageId resolution, designer data GET/PATCH/commit, status
  flow-designer-tab.test.js
  flow-modules.js              Module asset find/create + commitModuleCode() sequence + codegen call
  flow-modules.test.js
icons/
  icon16.png, icon48.png, icon128.png
package.json
```

---

### Task 1: Extension scaffold

**Files:**
- Create: `manifest.json`
- Create: `package.json`
- Create: `background.js` (stub)
- Create: `sidepanel.html`, `sidepanel.css`, `sidepanel.js` (stub)
- Create: `content/designer.js` (stub)
- Create: `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png` (placeholder square PNGs)
- Test: `manifest.test.js`

**Interfaces:**
- Produces: a loadable MV3 extension shell; every later task fills in `background.js`/`sidepanel.js`/`content/designer.js` without touching `manifest.json` again.

- [ ] **Step 1: Write the failing test for manifest shape**

```js
// manifest.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const manifest = require("./manifest.json");

test("manifest declares MV3 with the required surfaces", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, "background.js");
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  assert.ok(manifest.permissions.includes("storage"));
  assert.ok(manifest.permissions.includes("sidePanel"));
  assert.ok(manifest.permissions.includes("webRequest"));
  assert.ok(manifest.host_permissions.includes("https://build.novacura.com/*"));
  assert.ok(manifest.optional_host_permissions.includes("https://*/*"));
  assert.equal(manifest.content_scripts[0].js[0], "content/designer.js");
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://build.novacura.com/*"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test manifest.test.js`
Expected: FAIL — `Cannot find module './manifest.json'` (or similar) since the file doesn't exist yet.

- [ ] **Step 3: Write `manifest.json`, `package.json`, and the stub files**

```json
// manifest.json
{
  "manifest_version": 3,
  "name": "IFS Projection Tracker",
  "version": "0.1.0",
  "description": "Traces IFS Cloud projection calls and turns them into Novacura Flow Connect modules.",
  "permissions": ["storage", "sidePanel", "webRequest"],
  "host_permissions": ["https://build.novacura.com/*"],
  "optional_host_permissions": ["https://*/*"],
  "background": { "service_worker": "background.js" },
  "side_panel": { "default_path": "sidepanel.html" },
  "action": { "default_title": "IFS Projection Tracker" },
  "content_scripts": [
    { "matches": ["https://build.novacura.com/*"], "js": ["content/designer.js"], "run_at": "document_idle" }
  ],
  "icons": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
}
```

```json
// package.json
{
  "name": "ifs-flow-projection-tracker",
  "private": true,
  "scripts": { "test": "node --test lib/" }
}
```

```js
// background.js (stub — filled in by Tasks 7, 8, 11, 12)
chrome.runtime.onInstalled.addListener(() => {
  console.log("IFS Projection Tracker installed.");
});
```

```html
<!-- sidepanel.html (stub — filled in by Task 13) -->
<!doctype html>
<html>
  <head><meta charset="utf-8"><link rel="stylesheet" href="sidepanel.css"></head>
  <body>
    <div id="app">Loading…</div>
    <script src="sidepanel.js"></script>
  </body>
</html>
```

```css
/* sidepanel.css (stub) */
body { font: 13px system-ui, sans-serif; margin: 0; padding: 8px; }
```

```js
// sidepanel.js (stub — filled in by Task 13)
document.getElementById("app").textContent = "IFS Projection Tracker";
```

```js
// content/designer.js (stub — filled in by Task 11)
// Injected into build.novacura.com; see Task 11 for the refresh-button click handler.
```

Also create three minimal valid 1x1 PNG files at `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png` (any placeholder square icon — Chrome requires the files to exist and be valid images, not any specific artwork).

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test manifest.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add manifest.json package.json background.js sidepanel.html sidepanel.css sidepanel.js content/designer.js icons/ manifest.test.js
git commit -m "chore: scaffold MV3 extension shell"
```

---

### Task 2: Port `projection-filter.js`

**Files:**
- Create: `lib/projection-filter.js`
- Create: `lib/excluded-projections.txt`
- Test: `lib/projection-filter.test.js`

**Interfaces:**
- Produces: `parseExcludedList(text): Set<string>`, `extractSvcName(url): string|null`, `isExcludedUrl(url, excludedSet): boolean` — consumed by Task 7's tracking wiring and Task 9's `findExistingModule`.

- [ ] **Step 1: Write the failing tests (ported verbatim from IFS-Buddy)**

```js
// lib/projection-filter.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseExcludedList, extractSvcName, isExcludedUrl } = require("./projection-filter.js");

test("parseExcludedList skips comments and blank lines", () => {
  const text = "# comment\n\nUserProfileService.svc\n  FrameworkServices.svc  \n";
  const set = parseExcludedList(text);
  assert.equal(set.size, 2);
  assert.ok(set.has("USERPROFILESERVICE"));
  assert.ok(set.has("FRAMEWORKSERVICES"));
});

test("parseExcludedList strips .svc suffix case-insensitively", () => {
  const set = parseExcludedList("FooBar.SVC");
  assert.ok(set.has("FOOBAR"));
});

test("extractSvcName reads the service name from a projection URL", () => {
  const url = "https://x.example.com/main/ifsapplications/projection/v1/UserProfileService.svc/Users";
  assert.equal(extractSvcName(url), "UserProfileService");
});

test("extractSvcName returns null when no .svc segment present", () => {
  assert.equal(extractSvcName("https://x.example.com/foo/bar"), null);
});

test("isExcludedUrl matches an excluded service case-insensitively", () => {
  const set = parseExcludedList("UserProfileService.svc");
  const url = "https://x.example.com/main/ifsapplications/projection/v1/userprofileservice.svc/Users";
  assert.equal(isExcludedUrl(url, set), true);
});

test("isExcludedUrl returns false for a non-excluded service", () => {
  const set = parseExcludedList("UserProfileService.svc");
  const url = "https://x.example.com/main/ifsapplications/projection/v1/CustomerOrders.svc/Orders";
  assert.equal(isExcludedUrl(url, set), false);
});

test("isExcludedUrl returns false when the exclusion set is empty", () => {
  assert.equal(isExcludedUrl("https://x.example.com/UserProfileService.svc", new Set()), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test lib/projection-filter.test.js`
Expected: FAIL — `Cannot find module './projection-filter.js'`

- [ ] **Step 3: Create `lib/projection-filter.js` (ported verbatim from `C:\dev\IFS-Buddy\recorder\projection-filter.js`) and `lib/excluded-projections.txt`**

```js
// lib/projection-filter.js
(function (global) {
  function parseExcludedList(text) {
    const set = new Set();
    for (const rawLine of String(text || "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      set.add(line.replace(/\.svc$/i, "").toUpperCase());
    }
    return set;
  }

  function extractSvcName(url) {
    const m = String(url || "").match(/([A-Za-z0-9_]+)\.svc/i);
    return m ? m[1] : null;
  }

  function isExcludedUrl(url, excludedSet) {
    if (!excludedSet || excludedSet.size === 0) return false;
    const name = extractSvcName(url);
    return !!name && excludedSet.has(name.toUpperCase());
  }

  const api = { parseExcludedList, extractSvcName, isExcludedUrl };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.ProjectionFilter = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
```

```
# lib/excluded-projections.txt
# Projections excluded from the tracked list and from module creation
# (still filtered out before ever being shown), one per line. Lines
# starting with # and blank lines are ignored. Matching is
# case-insensitive against the .svc segment of the request URL,
# with or without the ".svc" suffix.
UserProfileService.svc
FrameworkServices.svc
BookmarkService.svc
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test lib/projection-filter.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/projection-filter.js lib/projection-filter.test.js lib/excluded-projections.txt
git commit -m "feat: port projection-filter.js from IFS-Buddy"
```

---

### Task 3: Port `credential-crypto.js`

**Files:**
- Create: `lib/credential-crypto.js`
- Test: `lib/credential-crypto.test.js`

**Interfaces:**
- Produces: `generateSalt()`, `deriveKey(password, saltB64)`, `exportKeyRaw(key)`, `importKeyRaw(base64)`, `encryptText(key, plaintext)`, `decryptText(key, encrypted)`, `makeVerifier(key)`, `checkVerifier(key, verifier)` — consumed by Task 4's `ifs-instances.js`.

- [ ] **Step 1: Write the failing tests (ported verbatim from IFS-Buddy)**

```js
// lib/credential-crypto.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  generateSalt, deriveKey, exportKeyRaw, importKeyRaw,
  encryptText, decryptText, makeVerifier, checkVerifier
} = require("./credential-crypto.js");

test("generateSalt produces a base64 string decoding to 16 bytes", () => {
  const salt = generateSalt();
  assert.equal(Buffer.from(salt, "base64").length, 16);
});

test("deriveKey is deterministic for the same password+salt", async () => {
  const salt = generateSalt();
  const key1 = await deriveKey("correct horse battery staple", salt);
  const key2 = await deriveKey("correct horse battery staple", salt);
  const enc = await encryptText(key1, "hello world");
  assert.equal(await decryptText(key2, enc), "hello world");
});

test("deriveKey with a different password produces an incompatible key", async () => {
  const salt = generateSalt();
  const key1 = await deriveKey("password-one", salt);
  const key2 = await deriveKey("password-two", salt);
  const enc = await encryptText(key1, "secret");
  await assert.rejects(() => decryptText(key2, enc));
});

test("encryptText/decryptText round-trips unicode", async () => {
  const salt = generateSalt();
  const key = await deriveKey("pw", salt);
  const enc = await encryptText(key, "münchen — client_secret_123!");
  assert.equal(await decryptText(key, enc), "münchen — client_secret_123!");
});

test("exportKeyRaw/importKeyRaw round-trips a usable key", async () => {
  const salt = generateSalt();
  const key = await deriveKey("pw", salt);
  const reimported = await importKeyRaw(await exportKeyRaw(key));
  const enc = await encryptText(key, "roundtrip test");
  assert.equal(await decryptText(reimported, enc), "roundtrip test");
});

test("makeVerifier/checkVerifier accepts the correct key and rejects a wrong one", async () => {
  const salt = generateSalt();
  const rightKey = await deriveKey("right", salt);
  const wrongKey = await deriveKey("wrong", salt);
  const verifier = await makeVerifier(rightKey);
  assert.equal(await checkVerifier(rightKey, verifier), true);
  assert.equal(await checkVerifier(wrongKey, verifier), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test lib/credential-crypto.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Create `lib/credential-crypto.js` (ported verbatim from `C:\dev\IFS-Buddy\migration\credential-crypto.js`)**

```js
// lib/credential-crypto.js
(function (global) {
  const PBKDF2_ITERATIONS = 250000;
  const SALT_BYTES = 16;
  const IV_BYTES = 12;
  const VERIFY_PLAINTEXT = "credential-store-verify";

  function toBase64(bytes) {
    let bin = "";
    const arr = new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    return btoa(bin);
  }

  function fromBase64(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  function generateSalt() {
    const salt = new Uint8Array(SALT_BYTES);
    crypto.getRandomValues(salt);
    return toBase64(salt);
  }

  async function deriveKey(password, saltB64) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: fromBase64(saltB64), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
      baseKey,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
  }

  async function exportKeyRaw(key) {
    const raw = await crypto.subtle.exportKey("raw", key);
    return toBase64(raw);
  }

  async function importKeyRaw(base64) {
    const raw = fromBase64(base64);
    return crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);
  }

  async function encryptText(key, plaintext) {
    const iv = new Uint8Array(IV_BYTES);
    crypto.getRandomValues(iv);
    const enc = new TextEncoder();
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
    return { iv: toBase64(iv), ciphertext: toBase64(ciphertext) };
  }

  async function decryptText(key, encrypted) {
    const iv = fromBase64(encrypted.iv);
    const ciphertext = fromBase64(encrypted.ciphertext);
    const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(plainBuf);
  }

  async function makeVerifier(key) {
    return encryptText(key, VERIFY_PLAINTEXT);
  }

  async function checkVerifier(key, verifier) {
    try {
      const text = await decryptText(key, verifier);
      return text === VERIFY_PLAINTEXT;
    } catch (e) {
      return false;
    }
  }

  const api = { generateSalt, deriveKey, exportKeyRaw, importKeyRaw, encryptText, decryptText, makeVerifier, checkVerifier };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.CredentialCrypto = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test lib/credential-crypto.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/credential-crypto.js lib/credential-crypto.test.js
git commit -m "feat: port credential-crypto.js from IFS-Buddy"
```

---

### Task 4: `lib/ifs-instances.js` — multi-instance store, master key, OAuth token

**Files:**
- Create: `lib/ifs-instances.js`
- Test: `lib/ifs-instances.test.js`

**Interfaces:**
- Consumes: `CredentialCrypto` from Task 3 (`generateSalt`, `deriveKey`, `makeVerifier`, `checkVerifier`, `encryptText`, `decryptText`, `exportKeyRaw`, `importKeyRaw`).
- Produces: `createIfsInstanceStore(storage)` returning `{ ensureMasterKey(promptFn), listInstances(), saveInstance(baseUrl, fields, masterKey), deleteInstance(baseUrl), getIfsAuthToken(baseUrl, masterKey), clearIfsAuthToken(baseUrl) }`. `storage` is an injected object shaped like `{ local: {get(keys), set(obj)}, session: {get(keys), set(obj)} }` (a real `chrome.storage` in production, an in-memory fake in tests). Consumed by Task 12 (background message router) and Task 5 (`projection-search.js` callers pass the resolved token through, no direct dependency).

- [ ] **Step 1: Write the failing tests, with an in-memory fake storage**

```js
// lib/ifs-instances.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { createIfsInstanceStore } = require("./ifs-instances.js");

function fakeStorage() {
  const local = {};
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
  const storage = fakeStorage();
  const store1 = createIfsInstanceStore(storage);
  await store1.ensureMasterKey(async () => "right-password");

  const store2 = createIfsInstanceStore(storage); // simulates a fresh service-worker restart: no in-memory cache
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test lib/ifs-instances.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `lib/ifs-instances.js` (ported from `C:\dev\IFS-Buddy\migration\ifs-oauth.js` lines 1-157, adapted to injected storage/fetch and a `name` field)**

```js
// lib/ifs-instances.js
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test lib/ifs-instances.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/ifs-instances.js lib/ifs-instances.test.js
git commit -m "feat: multi-instance IFS credential store with master-password encryption"
```

---

### Task 5: `lib/projection-search.js` — ProjectionExplorer resolution + codegen inputs

**Files:**
- Create: `lib/projection-search.js`
- Test: `lib/projection-search.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure, fetch-only, token passed in by the caller — Task 12 supplies it from `ifs-instances.js`'s `getIfsAuthToken`).
- Produces: `queryProjectionMeta(baseUrl, token, projectionName, fetchImpl)`, `getServiceUrl`, `getOpenApiUrl`, `fetchProjectionCodegenInputs(baseUrl, token, projectionName, fetchImpl)` returning `{ csdl, openApiJson, projectionSubPath, codeGenSubPath }` — consumed by Task 9's `generateModuleCode`.

- [ ] **Step 1: Write the failing tests**

```js
// lib/projection-search.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  queryProjectionMeta, parseCategoryList, resolveCategorizedProjectionUrl,
  getServiceUrl, getOpenApiUrl, fetchProjectionCodegenInputs, dirnameOfPath
} = require("./projection-search.js");

function jsonResponse(body) {
  return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
}

test("queryProjectionMeta queries with tolower + lowercased term and matches case-insensitively", async () => {
  let requestedUrl = null;
  const fakeFetch = async (url) => {
    requestedUrl = url;
    return jsonResponse({ value: [{ ProjectionName: "SalesQuotationHandling", Categories: "" }] });
  };
  const meta = await queryProjectionMeta("https://ifs.example.com", "tok", "SalesQuotationHandling", fakeFetch);
  assert.ok(requestedUrl.includes("startswith(tolower(ProjectionName),'salesquotationhandling')"));
  assert.equal(meta.ProjectionName, "SalesQuotationHandling");
});

test("dirnameOfPath strips the trailing .svc filename segment", () => {
  assert.equal(dirnameOfPath("/main/ifsapplications/projection/v1/SalesQuotationHandling.svc"), "/main/ifsapplications/projection/v1");
});

test("resolveCategorizedProjectionUrl calls the Int function for an Integration-only projection", async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return jsonResponse({ value: "/int/some/url" });
  };
  const url = await resolveCategorizedProjectionUrl("https://ifs.example.com", "tok", "CustomerOrderAddressEntity", "Integration", "GetServiceUrl", fakeFetch);
  assert.equal(url, "/int/some/url");
  assert.ok(calls[0].includes("GetServiceUrlInt("));
});

test("resolveCategorizedProjectionUrl tries Main first for an uncategorized projection", async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return jsonResponse({ value: "/main/some/url" });
  };
  const url = await resolveCategorizedProjectionUrl("https://ifs.example.com", "tok", "SalesQuotationHandling", "", "GetServiceUrl", fakeFetch);
  assert.equal(url, "/main/some/url");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("GetServiceUrlMain("));
});

test("resolveCategorizedProjectionUrl falls back to Int only when Main returns empty for a dual-category projection", async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    if (url.includes("Main")) return jsonResponse({ value: null });
    return jsonResponse({ value: "/int/fallback" });
  };
  const url = await resolveCategorizedProjectionUrl("https://ifs.example.com", "tok", "X", "Integration,ExternalB2B", "GetServiceUrl", fakeFetch);
  assert.equal(url, "/int/fallback");
  assert.equal(calls.length, 2);
});

test("fetchProjectionCodegenInputs assembles csdl + openApiJson + sub-paths", async () => {
  const fakeFetch = async (url) => {
    if (url.includes("ProjExplorerQuerySet")) return jsonResponse({ value: [{ ProjectionName: "SalesQuotationHandling", Categories: "" }] });
    if (url.includes("GetServiceUrlMain")) return jsonResponse({ value: "/main/ifsapplications/projection/v1/SalesQuotationHandling.svc" });
    if (url.includes("GetOpenApiV3UrlMain")) return jsonResponse({ value: "/main/ifsapplications/projection/v1/SalesQuotationHandling.svc/openapi.json" });
    if (url.includes("$metadata")) return { ok: true, text: async () => "<csdl/>" };
    if (url.includes("openapi.json")) return { ok: true, text: async () => "{}" };
    throw new Error("unexpected url " + url);
  };
  const result = await fetchProjectionCodegenInputs("https://ifs.example.com", "tok", "SalesQuotationHandling", fakeFetch);
  assert.equal(result.csdl, "<csdl/>");
  assert.equal(result.openApiJson, "{}");
  assert.equal(result.projectionSubPath, "/main/ifsapplications/projection/v1/SalesQuotationHandling.svc");
  assert.equal(result.codeGenSubPath, "/main/ifsapplications/projection/v1");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test lib/projection-search.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `lib/projection-search.js` (ported from `ifs-oauth.js` lines 159-272, `fetchImpl` injected instead of global `fetch`)**

```js
// lib/projection-search.js
(function (global) {
  function resolveIfsUrl(baseUrl, urlOrPath) {
    return urlOrPath.startsWith("http") ? urlOrPath : baseUrl + urlOrPath;
  }

  function dirnameOfPath(path) {
    const parts = String(path || "").split("/");
    return parts.slice(0, -1).join("/");
  }

  async function ifsFetch(baseUrl, path, token, fetchImpl) {
    return (fetchImpl || fetch)(baseUrl + path, { headers: { Authorization: `Bearer ${token}` } });
  }

  async function fetchIfsText(url, token, fetchImpl) {
    const res = await (fetchImpl || fetch)(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Fetch failed for ${url} (${res.status})${text ? ": " + text : ""}`);
    }
    return res.text();
  }

  function parseCategoryList(categoriesText) {
    return String(categoriesText || "").split(",").map((c) => c.trim()).filter(Boolean);
  }

  async function queryProjectionMeta(baseUrl, token, projectionName, fetchImpl) {
    const lower = projectionName.toLowerCase().replace(/'/g, "");
    const path = `/main/ifsapplications/projection/v1/ProjectionExplorer.svc/ProjExplorerQuerySet?$filter=startswith(tolower(ProjectionName),'${lower}')&$select=ProjectionName,Component,ApiClass,Active,Deprecated,Categories`;
    const res = await ifsFetch(baseUrl, path, token, fetchImpl);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ProjectionExplorer query failed (${res.status})${text ? ": " + text : ""}`);
    }
    const data = await res.json();
    const rows = data.value || [];
    return rows.find((p) => p.ProjectionName.toUpperCase() === projectionName.toUpperCase()) || null;
  }

  async function callProjectionExplorerFunction(baseUrl, token, functionName, projectionName, fetchImpl) {
    const clean = projectionName.replace(/'/g, "");
    const res = await ifsFetch(baseUrl, `/main/ifsapplications/projection/v1/ProjectionExplorer.svc/${functionName}(ProjectionName='${clean}')`, token, fetchImpl);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${functionName} failed (${res.status})${text ? ": " + text : ""}`);
    }
    const data = await res.json();
    return data.value || null;
  }

  async function resolveCategorizedProjectionUrl(baseUrl, token, projectionName, categoriesText, functionPrefix, fetchImpl) {
    const categories = parseCategoryList(categoriesText);
    const isIntegration = categories.includes("Integration");
    const isExternalB2B = categories.includes("ExternalB2B");
    const call = (suffix) => callProjectionExplorerFunction(baseUrl, token, `${functionPrefix}${suffix}`, projectionName, fetchImpl);

    if (isIntegration && !isExternalB2B) return call("Int");
    if (isExternalB2B && !isIntegration) return call("B2b");

    const mainUrl = await call("Main");
    if (mainUrl) return mainUrl;
    if (isIntegration) return call("Int");
    if (isExternalB2B) return call("B2b");
    return null;
  }

  async function getServiceUrl(baseUrl, token, projectionName, categoriesText, fetchImpl) {
    return resolveCategorizedProjectionUrl(baseUrl, token, projectionName, categoriesText, "GetServiceUrl", fetchImpl);
  }

  async function getOpenApiUrl(baseUrl, token, projectionName, categoriesText, fetchImpl) {
    return resolveCategorizedProjectionUrl(baseUrl, token, projectionName, categoriesText, "GetOpenApiV3Url", fetchImpl);
  }

  async function fetchProjectionCodegenInputs(baseUrl, token, projectionName, fetchImpl) {
    const meta = await queryProjectionMeta(baseUrl, token, projectionName, fetchImpl);
    const serviceUrl = await getServiceUrl(baseUrl, token, projectionName, meta && meta.Categories, fetchImpl);
    if (!serviceUrl) throw new Error(`No Main, Integration, or ExternalB2B service URL found for projection '${projectionName}'.`);

    const csdl = await fetchIfsText(resolveIfsUrl(baseUrl, serviceUrl) + "/$metadata", token, fetchImpl);

    const openApiUrl = await getOpenApiUrl(baseUrl, token, projectionName, meta && meta.Categories, fetchImpl);
    const openApiJson = openApiUrl ? await fetchIfsText(resolveIfsUrl(baseUrl, openApiUrl), token, fetchImpl) : "";

    const projectionSubPath = serviceUrl.startsWith("http") ? new URL(serviceUrl).pathname : serviceUrl;
    const codeGenSubPath = dirnameOfPath(projectionSubPath);

    return { csdl, openApiJson, projectionSubPath, codeGenSubPath };
  }

  const api = {
    resolveIfsUrl, dirnameOfPath, ifsFetch, fetchIfsText, parseCategoryList,
    queryProjectionMeta, resolveCategorizedProjectionUrl, getServiceUrl, getOpenApiUrl,
    fetchProjectionCodegenInputs
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.ProjectionSearch = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test lib/projection-search.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/projection-search.js lib/projection-search.test.js
git commit -m "feat: ProjectionExplorer resolution and codegen input fetch"
```

---

### Task 6: `lib/flow-connect-rest.js` — `flowFetch` + error convention

**Files:**
- Create: `lib/flow-connect-rest.js`
- Test: `lib/flow-connect-rest.test.js`

**Interfaces:**
- Produces: `flowFetch(token, path, options, fetchImpl)` → `Response` (adds `Authorization`/`X-Origin`, base URL prefix), `throwWithResponseBody(res, message)` → never returns, throws `Error` with the real body text appended. Consumed by Tasks 8 and 9.

- [ ] **Step 1: Write the failing tests**

```js
// lib/flow-connect-rest.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { flowFetch, throwWithResponseBody } = require("./flow-connect-rest.js");

test("flowFetch prefixes the base URL and sends Authorization + X-Origin", async () => {
  let seenUrl, seenHeaders;
  const fakeFetch = async (url, options) => {
    seenUrl = url;
    seenHeaders = options.headers;
    return { ok: true };
  };
  await flowFetch("tok-123", "/admin/security/api/v3/user/whoAmI", {}, fakeFetch);
  assert.equal(seenUrl, "https://build.novacura.com/admin/security/api/v3/user/whoAmI");
  assert.equal(seenHeaders.Authorization, "Bearer tok-123");
  assert.equal(seenHeaders["X-Origin"], "HubWebApp");
});

test("flowFetch preserves caller-supplied headers alongside the required ones", async () => {
  let seenHeaders;
  const fakeFetch = async (url, options) => { seenHeaders = options.headers; return { ok: true }; };
  await flowFetch("tok", "/path", { headers: { "Content-Type": "text/plain", "If-Match": "*" } }, fakeFetch);
  assert.equal(seenHeaders["Content-Type"], "text/plain");
  assert.equal(seenHeaders["If-Match"], "*");
  assert.equal(seenHeaders.Authorization, "Bearer tok");
});

test("throwWithResponseBody reads and appends the real response body text", async () => {
  const res = { status: 400, text: async () => "Assets[0].OfferedParameterType is required." };
  await assert.rejects(
    () => throwWithResponseBody(res, "Could not save designer data"),
    (err) => {
      assert.equal(err.message, "Could not save designer data (400): Assets[0].OfferedParameterType is required.");
      return true;
    }
  );
});

test("throwWithResponseBody tolerates an unreadable body", async () => {
  const res = { status: 500, text: async () => { throw new Error("stream closed"); } };
  await assert.rejects(
    () => throwWithResponseBody(res, "Commit failed"),
    (err) => { assert.equal(err.message, "Commit failed (500)"); return true; }
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test lib/flow-connect-rest.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `lib/flow-connect-rest.js`**

```js
// lib/flow-connect-rest.js
(function (global) {
  const FLOW_CONNECT_BASE_URL = "https://build.novacura.com";
  const X_ORIGIN = "HubWebApp";

  async function flowFetch(token, path, options, fetchImpl) {
    options = options || {};
    const headers = Object.assign({}, options.headers, { Authorization: `Bearer ${token}`, "X-Origin": X_ORIGIN });
    return (fetchImpl || fetch)(FLOW_CONNECT_BASE_URL + path, Object.assign({}, options, { headers }));
  }

  async function throwWithResponseBody(res, message) {
    const text = await res.text().catch(() => "");
    throw new Error(`${message} (${res.status})${text ? ": " + text : ""}`);
  }

  const api = { FLOW_CONNECT_BASE_URL, X_ORIGIN, flowFetch, throwWithResponseBody };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.FlowConnectRest = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test lib/flow-connect-rest.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/flow-connect-rest.js lib/flow-connect-rest.test.js
git commit -m "feat: flowFetch helper with the Connect auth/error conventions"
```

---

### Task 7: `lib/tracking.js` — pure session-list logic (Review Focus: dedupe, on/off)

**Files:**
- Create: `lib/tracking.js`
- Test: `lib/tracking.test.js`

**Interfaces:**
- Consumes: `isExcludedUrl`, `extractSvcName` from Task 2.
- Produces: `shouldTrackUrl(url, trackingEnabled, excludedSet): boolean`, `upsertTrackedProjection(list, projectionName, now): newList` — consumed by Task 12's `webRequest` wiring.

- [ ] **Step 1: Write the failing tests**

```js
// lib/tracking.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseExcludedList } = require("./projection-filter.js");
const { shouldTrackUrl, upsertTrackedProjection } = require("./tracking.js");

test("shouldTrackUrl is false while tracking is disabled, even for a trackable .svc URL", () => {
  const set = parseExcludedList("");
  assert.equal(shouldTrackUrl("https://ifs.example.com/.../SalesQuotationHandling.svc/Rows", false, set), false);
});

test("shouldTrackUrl is false for a non-.svc URL", () => {
  const set = parseExcludedList("");
  assert.equal(shouldTrackUrl("https://ifs.example.com/static/app.js", true, set), false);
});

test("shouldTrackUrl is false for an excluded .svc", () => {
  const set = parseExcludedList("UserProfileService.svc");
  assert.equal(shouldTrackUrl("https://ifs.example.com/.../UserProfileService.svc/Rows", true, set), false);
});

test("shouldTrackUrl is true for a non-excluded .svc while tracking is enabled", () => {
  const set = parseExcludedList("UserProfileService.svc");
  assert.equal(shouldTrackUrl("https://ifs.example.com/.../SalesQuotationHandling.svc/Rows", true, set), true);
});

test("upsertTrackedProjection adds a new row with hitCount 1", () => {
  const list = upsertTrackedProjection([], "SalesQuotationHandling", 1000);
  assert.deepEqual(list, [{ projectionName: "SalesQuotationHandling", firstSeenAt: 1000, hitCount: 1 }]);
});

test("upsertTrackedProjection increments hitCount on a repeat hit instead of duplicating the row", () => {
  let list = upsertTrackedProjection([], "SalesQuotationHandling", 1000);
  list = upsertTrackedProjection(list, "SalesQuotationHandling", 2000);
  assert.equal(list.length, 1);
  assert.equal(list[0].hitCount, 2);
  assert.equal(list[0].firstSeenAt, 1000, "firstSeenAt must not change on a repeat hit");
});

test("upsertTrackedProjection matches an existing row case-insensitively", () => {
  let list = upsertTrackedProjection([], "SalesQuotationHandling", 1000);
  list = upsertTrackedProjection(list, "saleSQuotationHandling", 2000);
  assert.equal(list.length, 1);
  assert.equal(list[0].hitCount, 2);
});

test("disabling tracking leaves an already-recorded list untouched, it only gates new upserts", () => {
  const set = parseExcludedList("");
  const url = "https://ifs.example.com/.../SalesQuotationHandling.svc/Rows";
  let list = upsertTrackedProjection([], "SalesQuotationHandling", 1000);

  // background.js's real call site: only upsert when shouldTrackUrl says to.
  if (shouldTrackUrl(url, /* trackingEnabled */ false, set)) {
    list = upsertTrackedProjection(list, "SalesQuotationHandling", 2000);
  }

  assert.deepEqual(list, [{ projectionName: "SalesQuotationHandling", firstSeenAt: 1000, hitCount: 1 }]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test lib/tracking.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `lib/tracking.js`**

```js
// lib/tracking.js
(function (global) {
  const ProjectionFilter = typeof require === "function" ? require("./projection-filter.js") : global.ProjectionFilter;

  function shouldTrackUrl(url, trackingEnabled, excludedSet) {
    if (!trackingEnabled) return false;
    if (!ProjectionFilter.extractSvcName(url)) return false;
    return !ProjectionFilter.isExcludedUrl(url, excludedSet);
  }

  function upsertTrackedProjection(list, projectionName, now) {
    const upper = projectionName.toUpperCase();
    const idx = list.findIndex((row) => row.projectionName.toUpperCase() === upper);
    if (idx === -1) {
      return [...list, { projectionName, firstSeenAt: now, hitCount: 1 }];
    }
    const next = list.slice();
    next[idx] = { ...next[idx], hitCount: next[idx].hitCount + 1 };
    return next;
  }

  const api = { shouldTrackUrl, upsertTrackedProjection };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.Tracking = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test lib/tracking.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/tracking.js lib/tracking.test.js
git commit -m "feat: pure tracking filter + dedupe logic"
```

---

### Task 8: `lib/flow-designer-tab.js` — URL parsing, packageId resolution, designer data, status

**Files:**
- Create: `lib/flow-designer-tab.js`
- Test: `lib/flow-designer-tab.test.js`

**Interfaces:**
- Consumes: a `flowFetch`-shaped function `(path, options) => Promise<Response>` injected by the caller (Task 12 binds Task 6's `flowFetch` with a token).
- Produces: `parseDesignerTabUrl(url): {orgId, itemId}|null`, `resolvePackageId({flowFetch, orgId, itemId}): Promise<string|null>`, `getDesignerData({flowFetch, orgId, itemId}): Promise<object>`, `buildAssetRef({assetId, headVersionId})`, `patchAssetsList(existingAssets, ref): {assets, changed}`, `computeModuleStatus(moduleAsset, flowAssets): "not_created"|"created"|"activated"|"activated_stale"`, `activateModule({flowFetch, orgId, itemId, assetId, headVersionId}): Promise<void>` (GET → patch → POST → commit). Consumed by Task 12.

- [ ] **Step 1: Write the failing tests**

```js
// lib/flow-designer-tab.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseDesignerTabUrl, resolvePackageId, getDesignerData, buildAssetRef,
  patchAssetsList, computeModuleStatus, activateModule
} = require("./flow-designer-tab.js");

test("parseDesignerTabUrl extracts orgId and itemId from a real Designer URL", () => {
  const url = "https://build.novacura.com/admin/design/designer/organizations/09b7b161-907a-4e6f-bfb4-6c6ea6f9b794/items/7cb1cbab-0849-4e16-925f-14623f6ec5df";
  assert.deepEqual(parseDesignerTabUrl(url), {
    orgId: "09b7b161-907a-4e6f-bfb4-6c6ea6f9b794",
    itemId: "7cb1cbab-0849-4e16-925f-14623f6ec5df"
  });
});

test("parseDesignerTabUrl returns null for an unrelated URL", () => {
  assert.equal(parseDesignerTabUrl("https://build.novacura.com/admin/other/page"), null);
});

function jsonResponse(body) { return { ok: true, json: async () => body }; }

test("resolvePackageId finds the package whose assets[] contains the itemId", async () => {
  const flowFetch = async (path) => {
    if (path.endsWith("/packages")) return jsonResponse([{ id: "pkg-1" }, { id: "pkg-2" }]);
    if (path.includes("pkg-1/assets")) return jsonResponse([{ id: "other-item" }]);
    if (path.includes("pkg-1/products")) return jsonResponse([]);
    if (path.includes("pkg-2/assets")) return jsonResponse([{ id: "item-123" }]);
    if (path.includes("pkg-2/products")) return jsonResponse([]);
    throw new Error("unexpected path " + path);
  };
  const packageId = await resolvePackageId({ flowFetch, orgId: "org-1", itemId: "item-123" });
  assert.equal(packageId, "pkg-2");
});

test("resolvePackageId also checks products[] (top-level flows), not just assets[]", async () => {
  const flowFetch = async (path) => {
    if (path.endsWith("/packages")) return jsonResponse([{ id: "pkg-1" }]);
    if (path.includes("/assets")) return jsonResponse([]);
    if (path.includes("/products")) return jsonResponse([{ id: "item-123" }]);
    throw new Error("unexpected path " + path);
  };
  const packageId = await resolvePackageId({ flowFetch, orgId: "org-1", itemId: "item-123" });
  assert.equal(packageId, "pkg-1");
});

test("resolvePackageId returns null when no package contains the itemId", async () => {
  const flowFetch = async (path) => {
    if (path.endsWith("/packages")) return jsonResponse([{ id: "pkg-1" }]);
    return jsonResponse([]);
  };
  assert.equal(await resolvePackageId({ flowFetch, orgId: "org-1", itemId: "missing" }), null);
});

test("buildAssetRef shapes the designer assets[] entry", () => {
  assert.deepEqual(buildAssetRef({ assetId: "a1", headVersionId: "v1" }), {
    assetId: "a1", assetVersion: "v1", offeredParameterType: "{}"
  });
});

test("patchAssetsList appends a new ref when the assetId isn't present", () => {
  const { assets, changed } = patchAssetsList([], { assetId: "a1", assetVersion: "v1", offeredParameterType: "{}" });
  assert.equal(changed, true);
  assert.deepEqual(assets, [{ assetId: "a1", assetVersion: "v1", offeredParameterType: "{}" }]);
});

test("patchAssetsList bumps an existing ref's version in place, never appends a duplicate", () => {
  const existing = [{ assetId: "a1", assetVersion: "v1", offeredParameterType: "{}" }];
  const { assets, changed } = patchAssetsList(existing, { assetId: "a1", assetVersion: "v2", offeredParameterType: "{}" });
  assert.equal(changed, true);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].assetVersion, "v2");
});

test("patchAssetsList is a no-op when the ref already matches exactly", () => {
  const existing = [{ assetId: "a1", assetVersion: "v1", offeredParameterType: "{}" }];
  const { assets, changed } = patchAssetsList(existing, { assetId: "a1", assetVersion: "v1", offeredParameterType: "{}" });
  assert.equal(changed, false);
  assert.deepEqual(assets, existing);
});

test("computeModuleStatus reports not_created when no module asset exists", () => {
  assert.equal(computeModuleStatus(null, []), "not_created");
});

test("computeModuleStatus reports created when the module asset exists but isn't referenced by the flow", () => {
  const moduleAsset = { id: "a1", mainBranch: { headVersionId: "v1" } };
  assert.equal(computeModuleStatus(moduleAsset, [{ assetId: "other" }]), "created");
});

test("computeModuleStatus reports activated when the flow references the current version", () => {
  const moduleAsset = { id: "a1", mainBranch: { headVersionId: "v1" } };
  assert.equal(computeModuleStatus(moduleAsset, [{ assetId: "a1", assetVersion: "v1" }]), "activated");
});

test("computeModuleStatus reports activated_stale when the flow references an older version", () => {
  const moduleAsset = { id: "a1", mainBranch: { headVersionId: "v2" } };
  assert.equal(computeModuleStatus(moduleAsset, [{ assetId: "a1", assetVersion: "v1" }]), "activated_stale");
});

test("activateModule GETs designer data, patches assets[], POSTs it back, and commits with the body's eTag", async () => {
  const calls = [];
  const designerBody = {
    data: [{ type: "step-created" }],
    assets: [],
    parameterTypeExpression: "{}",
    resultTypeExpression: "{}",
    eTag: "\"etag-abc\""
  };
  const flowFetch = async (path, options) => {
    calls.push({ path, method: (options && options.method) || "GET", body: options && options.body });
    if (path.endsWith("/designer") && (!options || !options.method)) {
      return { ok: true, json: async () => designerBody };
    }
    if (path.endsWith("/designer")) return { ok: true };
    if (path.endsWith("/commit")) return { ok: true };
    throw new Error("unexpected call " + path);
  };
  await activateModule({ flowFetch, orgId: "org-1", itemId: "item-1", assetId: "a1", headVersionId: "v1" });

  assert.equal(calls[0].path, "/admin/application/api/v2/organisations/org-1/items/item-1/designer");
  assert.equal(calls[0].method, "GET");

  const postedBody = JSON.parse(calls[1].body);
  assert.deepEqual(postedBody.assets, [{ assetId: "a1", assetVersion: "v1", offeredParameterType: "{}" }]);
  assert.deepEqual(postedBody.data, designerBody.data);

  const commitBody = JSON.parse(calls[2].body);
  assert.equal(commitBody.eTag, "\"etag-abc\"");
  assert.equal(calls[2].path, "/admin/application/api/v2/organisations/org-1/items/item-1/commit");
});

test("activateModule skips the POST+commit entirely when the ref already matches (no-op)", async () => {
  const calls = [];
  const designerBody = {
    data: [], assets: [{ assetId: "a1", assetVersion: "v1", offeredParameterType: "{}" }],
    parameterTypeExpression: "{}", resultTypeExpression: "{}", eTag: "\"etag-abc\""
  };
  const flowFetch = async (path, options) => {
    calls.push({ path, method: (options && options.method) || "GET" });
    return { ok: true, json: async () => designerBody };
  };
  await activateModule({ flowFetch, orgId: "org-1", itemId: "item-1", assetId: "a1", headVersionId: "v1" });
  assert.equal(calls.length, 1, "only the initial GET should happen when nothing changed");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test lib/flow-designer-tab.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `lib/flow-designer-tab.js`**

```js
// lib/flow-designer-tab.js
(function (global) {
  const DESIGNER_URL_RE = /\/admin\/design\/designer\/organizations\/([^/]+)\/items\/([^/?#]+)/;

  function parseDesignerTabUrl(url) {
    const m = DESIGNER_URL_RE.exec(String(url || ""));
    if (!m) return null;
    return { orgId: m[1], itemId: m[2] };
  }

  async function resolvePackageId({ flowFetch, orgId, itemId }) {
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/packages`);
    if (!res.ok) throw new Error(`Could not list packages (${res.status})`);
    const packages = await res.json();

    for (const pkg of packages) {
      for (const kind of ["assets", "products"]) {
        const listRes = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/packages/${pkg.id}/${kind}`);
        if (!listRes.ok) continue;
        const items = await listRes.json();
        if ((items || []).some((item) => item.id === itemId)) return pkg.id;
      }
    }
    return null;
  }

  async function getDesignerData({ flowFetch, orgId, itemId }) {
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${itemId}/designer`);
    if (!res.ok) throw new Error(`Could not load designer data (${res.status})`);
    return res.json();
  }

  function buildAssetRef({ assetId, headVersionId }) {
    return { assetId, assetVersion: headVersionId, offeredParameterType: "{}" };
  }

  function patchAssetsList(existingAssets, ref) {
    const idx = (existingAssets || []).findIndex((a) => a.assetId === ref.assetId);
    if (idx === -1) {
      return { assets: [...(existingAssets || []), ref], changed: true };
    }
    const current = existingAssets[idx];
    if (current.assetVersion === ref.assetVersion && current.offeredParameterType === ref.offeredParameterType) {
      return { assets: existingAssets, changed: false };
    }
    const next = existingAssets.slice();
    next[idx] = ref;
    return { assets: next, changed: true };
  }

  function computeModuleStatus(moduleAsset, flowAssets) {
    if (!moduleAsset) return "not_created";
    const ref = (flowAssets || []).find((a) => a.assetId === moduleAsset.id);
    if (!ref) return "created";
    return ref.assetVersion === moduleAsset.mainBranch.headVersionId ? "activated" : "activated_stale";
  }

  async function activateModule({ flowFetch, orgId, itemId, assetId, headVersionId }) {
    const designerData = await getDesignerData({ flowFetch, orgId, itemId });
    const ref = buildAssetRef({ assetId, headVersionId });
    const { assets, changed } = patchAssetsList(designerData.assets, ref);
    if (!changed) return;

    const payload = {
      assets,
      parameterTypeExpression: designerData.parameterTypeExpression || "{}",
      resultTypeExpression: designerData.resultTypeExpression || "{}",
      errors: 0,
      isInbox: !!designerData.isInbox,
      hasSuitcase: !!designerData.hasSuitcase,
      architecture: designerData.architecture || "sequential",
      data: designerData.data
    };
    const postRes = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${itemId}/designer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!postRes.ok) throw new Error(`Could not save designer data (${postRes.status})`);

    const commitRes = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${itemId}/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Activated by IFS Projection Tracker", eTag: designerData.eTag })
    });
    if (!commitRes.ok) throw new Error(`Could not commit activation (${commitRes.status})`);
  }

  const api = {
    parseDesignerTabUrl, resolvePackageId, getDesignerData, buildAssetRef,
    patchAssetsList, computeModuleStatus, activateModule
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.FlowDesignerTab = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test lib/flow-designer-tab.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/flow-designer-tab.js lib/flow-designer-tab.test.js
git commit -m "feat: Designer tab id resolution, designer-data activate, module status"
```

---

### Task 9: `lib/flow-modules.js` — module asset find/create + commit sequence + codegen

**Files:**
- Create: `lib/flow-modules.js`
- Test: `lib/flow-modules.test.js`

**Interfaces:**
- Consumes: a `flowFetch`-shaped function (same contract as Task 8).
- Produces: `findExistingModule({flowFetch, orgId, packageId, projectionName})`, `createModuleAsset({flowFetch, orgId, packageId, projectionName})`, `findOrCreateModule({flowFetch, orgId, packageId, projectionName})`, `getModuleAsset({flowFetch, orgId, packageId, assetId})`, `generateModuleCode({flowFetch, csdlXml, openApiJson, codeGenSubPath, importSourcePath})`, `commitModuleCode({flowFetch, orgId, packageId, assetId, flowScriptCode})` → `{headVersionId, ...}`. Consumed by Task 12.

- [ ] **Step 1: Write the failing tests**

```js
// lib/flow-modules.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  findExistingModule, createModuleAsset, findOrCreateModule, getModuleAsset,
  generateModuleCode, commitModuleCode
} = require("./flow-modules.js");

function jsonResponse(body) { return { ok: true, json: async () => body }; }

test("findExistingModule matches an existing module asset by name, case-insensitively", async () => {
  const flowFetch = async () => jsonResponse([
    { id: "a1", type: "module", name: "SalesQuotationHandling" },
    { id: "a2", type: "component", name: "Other" }
  ]);
  const found = await findExistingModule({ flowFetch, orgId: "org-1", packageId: "pkg-1", projectionName: "salesquotationhandling" });
  assert.equal(found.id, "a1");
});

test("findExistingModule returns null when no module asset matches", async () => {
  const flowFetch = async () => jsonResponse([]);
  assert.equal(await findExistingModule({ flowFetch, orgId: "org-1", packageId: "pkg-1", projectionName: "X" }), null);
});

test("createModuleAsset POSTs with the module color/type and description", async () => {
  let posted;
  const flowFetch = async (path, options) => {
    posted = { path, body: JSON.parse(options.body) };
    return jsonResponse({ id: "a1", type: "module", name: "SalesQuotationHandling" });
  };
  const asset = await createModuleAsset({ flowFetch, orgId: "org-1", packageId: "pkg-1", projectionName: "SalesQuotationHandling" });
  assert.equal(asset.id, "a1");
  assert.equal(posted.body.type, "module");
  assert.equal(posted.body.color, "#4031F8");
  assert.equal(posted.body.name, "SalesQuotationHandling");
});

test("findOrCreateModule reuses an existing module instead of creating a duplicate", async () => {
  let createCalled = false;
  const flowFetch = async (path, options) => {
    if (options && options.method === "POST") { createCalled = true; return jsonResponse({ id: "new" }); }
    return jsonResponse([{ id: "existing", type: "module", name: "SalesQuotationHandling" }]);
  };
  const asset = await findOrCreateModule({ flowFetch, orgId: "org-1", packageId: "pkg-1", projectionName: "SalesQuotationHandling" });
  assert.equal(asset.id, "existing");
  assert.equal(createCalled, false);
});

test("generateModuleCode posts csdl+openApiJson and prefixes a generated-header comment", async () => {
  const flowFetch = async (path, options) => {
    if (path.includes("generate/Queryable")) {
      const body = JSON.parse(new TextDecoder().decode(options.body));
      assert.equal(body.csdlXml, "<csdl/>");
      assert.equal(body.projectionSubPath, "/main/ifsapplications/projection/v1");
      return { ok: true, text: async () => "function Foo(): text { return \"\"; }" };
    }
    if (path.includes("build-number")) return { ok: true, text: async () => "42" };
    throw new Error("unexpected " + path);
  };
  const code = await generateModuleCode({
    flowFetch, csdlXml: "<csdl/>", openApiJson: "{}",
    codeGenSubPath: "/main/ifsapplications/projection/v1",
    importSourcePath: "/main/ifsapplications/projection/v1/SalesQuotationHandling.svc"
  });
  assert.ok(code.includes("build 42"));
  assert.ok(code.includes("function Foo(): text"));
});

test("commitModuleCode runs the full write/validate/update/commit/re-push sequence keyed on branchId vs headVersionId", async () => {
  const calls = [];
  const asset = { id: "a1", type: "module", name: "SalesQuotationHandling", mainBranch: { id: "branch-1", headVersionId: "v1" } };
  const flowFetch = async (path, options) => {
    calls.push({ path, method: (options && options.method) || "GET" });
    if (path.endsWith("/assets/a1")) return jsonResponse(asset);
    if (path.includes("/designerXml/")) return { ok: true, text: async () => "" };
    if (path.includes("/tasks/")) return { ok: true };
    if (path.includes("/data/")) return { ok: true };
    if (path.includes("/validate")) return jsonResponse({ snapshot: "snap-1" });
    if (path.includes("/branches/branch-1") && options.method === "PUT") return { ok: true };
    if (path.endsWith("/commit")) return jsonResponse({ headVersionId: "v2" });
    throw new Error("unexpected call " + path);
  };

  const result = await commitModuleCode({ flowFetch, orgId: "org-1", packageId: "pkg-1", assetId: "a1", flowScriptCode: "function Foo() {}" });
  assert.equal(result.headVersionId, "v2");

  const designerXmlCalls = calls.filter((c) => c.path.includes("/designerXml/"));
  assert.equal(designerXmlCalls.length, 2, "designerXml must be written once pre-commit (v1) and once post-commit (v2)");
  assert.ok(designerXmlCalls[0].path.endsWith("/designerXml/v1"));
  assert.ok(designerXmlCalls[1].path.endsWith("/designerXml/v2"));

  const validateCall = calls.find((c) => c.path.includes("/validate"));
  assert.ok(validateCall.path.includes("/branches/branch-1/validate"), "validate is keyed on branchId, not headVersionId");
});

test("getModuleAsset returns whatever asset is at that id, without itself checking its type", async () => {
  const flowFetch = async () => jsonResponse({ id: "a1", type: "component" });
  const asset = await getModuleAsset({ flowFetch, orgId: "org-1", packageId: "pkg-1", assetId: "a1" });
  assert.equal(asset.type, "component"); // the type check is commitModuleCode's job, asserted below
});

test("commitModuleCode throws if the asset at assetId isn't a module", async () => {
  const flowFetch = async () => jsonResponse({ id: "a1", type: "component", mainBranch: { id: "b1", headVersionId: "v1" } });
  await assert.rejects(
    () => commitModuleCode({ flowFetch, orgId: "org-1", packageId: "pkg-1", assetId: "a1", flowScriptCode: "function F() {}" }),
    /Asset is not a module/
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test lib/flow-modules.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `lib/flow-modules.js` (ported from `C:\dev\IFS-Buddy\recorder\ifs-modules.js` lines 846-1009)**

```js
// lib/flow-modules.js
(function (global) {
  function escapeXmlText(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  async function findExistingModule({ flowFetch, orgId, packageId, projectionName }) {
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/packages/${packageId}/assets`);
    if (!res.ok) throw new Error(`Could not list assets (${res.status})`);
    const assets = await res.json();
    const upper = projectionName.toUpperCase();
    return (assets || []).find((a) => a.type === "module" && a.name.toUpperCase() === upper) || null;
  }

  async function createModuleAsset({ flowFetch, orgId, packageId, projectionName }) {
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/packages/${packageId}/assets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: projectionName,
        description: "Auto generated module.",
        color: "#4031F8",
        type: "module",
        tagIds: []
      })
    });
    if (!res.ok) throw new Error(`Could not create module (${res.status})`);
    return res.json();
  }

  async function findOrCreateModule({ flowFetch, orgId, packageId, projectionName }) {
    const existing = await findExistingModule({ flowFetch, orgId, packageId, projectionName });
    if (existing) return existing;
    return createModuleAsset({ flowFetch, orgId, packageId, projectionName });
  }

  async function getModuleAsset({ flowFetch, orgId, packageId, assetId }) {
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/packages/${packageId}/assets/${assetId}`);
    if (!res.ok) throw new Error(`Could not load module (${res.status})`);
    return res.json();
  }

  async function setModuleDesignerXml({ flowFetch, orgId, assetId, moduleName, versionId, flowScriptCode }) {
    const xml = `<Module><Name>${escapeXmlText(moduleName)}</Name><Source>${escapeXmlText(flowScriptCode)}</Source></Module>`;
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${assetId}/designerXml/${versionId}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "If-Match": "*" },
      body: xml
    });
    if (!res.ok) throw new Error(`Could not set designer XML (${res.status})`);
  }

  async function setModuleTasks({ flowFetch, orgId, assetId, versionId }) {
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${assetId}/tasks/${versionId}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "If-Match": "*" },
      body: '@{"$t":"NovaCura.Flow.Engine.Model.ConnectorTaskCollection","$v":1,"d":{}}'
    });
    if (!res.ok) throw new Error(`Could not set module tasks (${res.status})`);
  }

  async function setModuleData({ flowFetch, orgId, assetId, versionId, moduleName, code }) {
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${assetId}/data/${versionId}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "If-Match": "*" },
      body: JSON.stringify({ name: moduleName, source: code })
    });
    if (!res.ok) throw new Error(`Could not set module data (${res.status})`);
  }

  async function commitModuleCode({ flowFetch, orgId, packageId, assetId, flowScriptCode }) {
    const asset = await getModuleAsset({ flowFetch, orgId, packageId, assetId });
    if (asset.type !== "module") throw new Error("Asset is not a module.");
    const moduleName = asset.name;
    const headVersionId = asset.mainBranch.headVersionId;
    const branchId = asset.mainBranch.id;

    await setModuleDesignerXml({ flowFetch, orgId, assetId, moduleName, versionId: headVersionId, flowScriptCode });
    await setModuleTasks({ flowFetch, orgId, assetId, versionId: headVersionId });
    await setModuleData({ flowFetch, orgId, assetId, versionId: headVersionId, moduleName, code: flowScriptCode });

    const validateRes = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${assetId}/branches/${branchId}/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assets: [] })
    });
    if (!validateRes.ok) throw new Error(`Branch validation failed (${validateRes.status})`);
    const validation = await validateRes.json();

    const updateRes = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${assetId}/branches/${branchId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        headVersionId, parameterType: "{}", resultType: "{}",
        isInbox: false, snapshotToken: validation.snapshot, numberOfErrors: 0
      })
    });
    if (!updateRes.ok) throw new Error(`Branch update failed (${updateRes.status})`);

    const commitRes = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${assetId}/branches/${branchId}/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ headVersionId, commitMessage: "Auto generated version." })
    });
    if (!commitRes.ok) throw new Error(`Commit failed (${commitRes.status})`);
    const newBranch = await commitRes.json();

    await setModuleDesignerXml({ flowFetch, orgId, assetId, moduleName, versionId: newBranch.headVersionId, flowScriptCode });
    return newBranch;
  }

  async function generateModuleCode({ flowFetch, csdlXml, openApiJson, codeGenSubPath, importSourcePath }) {
    const payloadBytes = new TextEncoder().encode(JSON.stringify({ csdlXml, openApiJson, projectionSubPath: codeGenSubPath }));
    const res = await flowFetch("/admin/code-gen/api/v1/flowscript/generate/Queryable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payloadBytes
    });
    if (!res.ok) throw new Error(`Code generation failed (${res.status})`);
    const generatedCode = await res.text();

    const buildRes = await flowFetch("/admin/code-gen/build-number");
    const buildNo = buildRes.ok ? await buildRes.text() : "unknown";

    const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
    const header = `/*\r\n#importSource("${importSourcePath}")\r\nAuto generated code: ${timestamp} (build ${buildNo})\r\n*/\r\n`;
    return header + generatedCode;
  }

  const api = { findExistingModule, createModuleAsset, findOrCreateModule, getModuleAsset, commitModuleCode, generateModuleCode };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.FlowModules = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test lib/flow-modules.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/flow-modules.js lib/flow-modules.test.js
git commit -m "feat: module asset find/create, codegen, and commit sequence"
```

---

### Task 10: `lib/flow-token.js` — bearer extraction + TTL cache (Review Focus item 4's fallback)

**Files:**
- Create: `lib/flow-token.js`
- Test: `lib/flow-token.test.js`

**Interfaces:**
- Produces: `extractBearerToken(headers): string|null` (pure header-list parsing), `createTokenCache(ttlMs, now)` returning `{get(), set(token), clear()}` (pure, `now` injectable for tests). Consumed by Task 11's `webRequest` wiring.

- [ ] **Step 1: Write the failing tests**

```js
// lib/flow-token.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { extractBearerToken, createTokenCache } = require("./flow-token.js");

test("extractBearerToken reads the Authorization header from a webRequest-style header list", () => {
  const headers = [{ name: "Content-Type", value: "application/json" }, { name: "Authorization", value: "Bearer abc123" }];
  assert.equal(extractBearerToken(headers), "abc123");
});

test("extractBearerToken is case-insensitive on both header name and the Bearer prefix", () => {
  const headers = [{ name: "authorization", value: "bearer xyz" }];
  assert.equal(extractBearerToken(headers), "xyz");
});

test("extractBearerToken returns null when no Authorization header is present", () => {
  assert.equal(extractBearerToken([{ name: "Content-Type", value: "application/json" }]), null);
});

test("extractBearerToken returns null for a non-Bearer Authorization header", () => {
  assert.equal(extractBearerToken([{ name: "Authorization", value: "Basic xyz" }]), null);
});

test("createTokenCache returns the token until the TTL elapses", () => {
  let now = 1000;
  const cache = createTokenCache(45 * 60 * 1000, () => now);
  cache.set("tok-1");
  assert.equal(cache.get(), "tok-1");
  now += 45 * 60 * 1000 - 1;
  assert.equal(cache.get(), "tok-1");
  now += 2;
  assert.equal(cache.get(), null, "expired token must not be returned");
});

test("createTokenCache.clear() forces the next get() to return null", () => {
  const cache = createTokenCache(1000, () => 0);
  cache.set("tok-1");
  cache.clear();
  assert.equal(cache.get(), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test lib/flow-token.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `lib/flow-token.js`**

```js
// lib/flow-token.js
(function (global) {
  function extractBearerToken(headers) {
    for (const h of headers || []) {
      if (String(h.name).toLowerCase() === "authorization") {
        const m = /^bearer\s+(.+)$/i.exec(h.value || "");
        if (m) return m[1];
      }
    }
    return null;
  }

  function createTokenCache(ttlMs, now) {
    const nowFn = now || Date.now;
    let token = null;
    let expiresAt = 0;
    return {
      get() {
        return token && nowFn() < expiresAt ? token : null;
      },
      set(newToken) {
        token = newToken;
        expiresAt = nowFn() + ttlMs;
      },
      clear() {
        token = null;
        expiresAt = 0;
      }
    };
  }

  const api = { extractBearerToken, createTokenCache };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.FlowToken = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test lib/flow-token.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/flow-token.js lib/flow-token.test.js
git commit -m "feat: bearer-token extraction and TTL cache for the sniffed Connect session"
```

---

### Task 11: `content/designer.js` — best-effort refresh-button click

**Files:**
- Modify: `content/designer.js`

**Interfaces:**
- Consumes: a `chrome.runtime.onMessage` request `{ type: "CLICK_REFRESH" }` from `background.js` (Task 12).
- Produces: replies `{ clicked: true }` or `{ clicked: false }` — never throws across the message boundary.

No automated test for this file — it's DOM-facing glue with no real selector confirmed yet (spec §9, §10 item 1), matching IFS-Buddy's own stated boundary for this class of code (spec §12). Manual verification happens once a real Designer tab is available (tracked as the spec's open item).

- [ ] **Step 1: Implement the best-effort click handler**

```js
// content/designer.js
// Injected into build.novacura.com. Best-effort, unverified selector — see
// docs/superpowers/specs/2026-10-16-projection-tracker-design.md §9/§10.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "CLICK_REFRESH") return;

  try {
    const candidate =
      document.querySelector('[data-testid="refresh-button"]') ||
      document.querySelector('button[title="Refresh"]') ||
      document.querySelector('button[aria-label="Refresh"]');

    if (candidate) {
      candidate.click();
      sendResponse({ clicked: true });
    } else {
      sendResponse({ clicked: false });
    }
  } catch (e) {
    sendResponse({ clicked: false });
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add content/designer.js
git commit -m "feat: best-effort Designer refresh-button click (unverified selector)"
```

---

### Task 12: `background.js` — webRequest wiring + message router

**Files:**
- Modify: `background.js`

**Interfaces:**
- Consumes: every `lib/` module from Tasks 2-10.
- Produces: the `chrome.runtime.onMessage` API the side panel (Task 13) calls: `LIST_INSTANCES`, `SAVE_INSTANCE` (`{baseUrl, fields, masterPassword}`, requests the host permission before storing), `DELETE_INSTANCE`, `GET_UNMATCHED_HOSTS`, `SET_TRACKING_ENABLED` (`{enabled}`), `GET_TRACKED` (`{baseUrl}`), `SEARCH_PROJECTION` (`{baseUrl, term, masterPassword}`), `GET_DESIGNER_STATUS`, `GET_MODULE_STATUS` (`{projectionName}`) → `{status, assetId, headVersionId}`, `CREATE_MODULE` (`{baseUrl, projectionName, masterPassword}`), `ACTIVATE_MODULE` (`{assetId, headVersionId}`), `RELOAD_AND_ACTIVATE` (`{baseUrl, projectionName, masterPassword}`).

This task is the integration glue — it is not independently unit-testable without a real `chrome.*` environment, matching IFS-Buddy's own stated DOM/chrome-API testing boundary (spec §12). Correctness here rests on the already-tested `lib/` functions it calls; this task's own verification is the manual smoke test at the end of Task 13.

- [ ] **Step 1: Implement `background.js`**

```js
// background.js
importScripts(
  "lib/credential-crypto.js",
  "lib/projection-filter.js",
  "lib/ifs-instances.js",
  "lib/projection-search.js",
  "lib/flow-connect-rest.js",
  "lib/tracking.js",
  "lib/flow-designer-tab.js",
  "lib/flow-modules.js",
  "lib/flow-token.js"
);

const TRACKING_ENABLED_KEY = "trackingEnabled";
const TRACKED_PROJECTIONS_PREFIX = "tracked:"; // + baseUrl, chrome.storage.session

const instanceStore = IfsInstances.createIfsInstanceStore({ local: chrome.storage.local, session: chrome.storage.session });
const flowToken = FlowToken.createTokenCache(45 * 60 * 1000);
let excludedSet = ProjectionFilter.parseExcludedList(""); // populated in init()
let designerTabState = null; // { tabId, orgId, itemId, packageId }

async function init() {
  const text = await (await fetch(chrome.runtime.getURL("lib/excluded-projections.txt"))).text();
  excludedSet = ProjectionFilter.parseExcludedList(text);
}
init();

async function isTrackingEnabled() {
  const { [TRACKING_ENABLED_KEY]: enabled = true } = await chrome.storage.local.get(TRACKING_ENABLED_KEY);
  return enabled;
}

function instanceForHost(instances, hostname) {
  return instances.find((i) => {
    try { return new URL(i.baseUrl).hostname === hostname; } catch { return false; }
  });
}

const UNMATCHED_HOSTS_KEY = "unmatchedHosts";

async function recordUnmatchedHost(hostname) {
  const { [UNMATCHED_HOSTS_KEY]: hosts = [] } = await chrome.storage.session.get(UNMATCHED_HOSTS_KEY);
  if (hosts.includes(hostname)) return;
  await chrome.storage.session.set({ [UNMATCHED_HOSTS_KEY]: [...hosts, hostname] });
}

chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    const enabled = await isTrackingEnabled();
    if (!Tracking.shouldTrackUrl(details.url, enabled, excludedSet)) return;

    const hostname = new URL(details.url).hostname;
    const instances = await instanceStore.listInstances();
    const instance = instanceForHost(instances, hostname);
    if (!instance) {
      await recordUnmatchedHost(hostname); // side panel's GET_UNMATCHED_HOSTS surfaces an "add this instance" prompt
      return;
    }

    const projectionName = ProjectionFilter.extractSvcName(details.url);
    const key = TRACKED_PROJECTIONS_PREFIX + instance.baseUrl;
    const { [key]: list = [] } = await chrome.storage.session.get(key);
    const next = Tracking.upsertTrackedProjection(list, projectionName, Date.now());
    await chrome.storage.session.set({ [key]: next });
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const token = FlowToken.extractBearerToken(details.requestHeaders);
    if (token) flowToken.set(token);
    return {};
  },
  { urls: ["https://build.novacura.com/*"] },
  ["requestHeaders", "extraHeaders"]
);

async function refreshDesignerTabState() {
  const tabs = await chrome.tabs.query({ url: "https://build.novacura.com/admin/design/designer/*" });
  if (!tabs.length) {
    designerTabState = null;
    return;
  }
  const parsed = FlowDesignerTab.parseDesignerTabUrl(tabs[0].url);
  if (!parsed) {
    designerTabState = null;
    return;
  }
  designerTabState = { tabId: tabs[0].id, orgId: parsed.orgId, itemId: parsed.itemId, packageId: null };
}

chrome.tabs.onUpdated.addListener(() => refreshDesignerTabState());
chrome.tabs.onRemoved.addListener(() => refreshDesignerTabState());

function boundFlowFetch() {
  const token = flowToken.get();
  if (!token) throw new Error("No Novacura Flow session found yet — open or interact with the Designer tab first.");
  return (path, options) => FlowConnectRest.flowFetch(token, path, options);
}

async function ensureDesignerPackageId() {
  if (!designerTabState) throw new Error("No Flow Designer tab is open.");
  if (!designerTabState.packageId) {
    designerTabState.packageId = await FlowDesignerTab.resolvePackageId({
      flowFetch: boundFlowFetch(), orgId: designerTabState.orgId, itemId: designerTabState.itemId
    });
  }
  if (!designerTabState.packageId) throw new Error("Could not find which package the open flow belongs to.");
  return designerTabState.packageId;
}

async function handleCreateModule({ baseUrl, projectionName, masterPassword }) {
  const packageId = await ensureDesignerPackageId();
  const flowFetch = boundFlowFetch();
  const masterKey = await instanceStore.ensureMasterKey(async () => masterPassword);
  const ifsToken = await instanceStore.getIfsAuthToken(baseUrl, masterKey);

  const inputs = await ProjectionSearch.fetchProjectionCodegenInputs(baseUrl, ifsToken, projectionName);
  const code = await FlowModules.generateModuleCode({
    flowFetch, csdlXml: inputs.csdl, openApiJson: inputs.openApiJson,
    codeGenSubPath: inputs.codeGenSubPath, importSourcePath: inputs.projectionSubPath
  });
  const asset = await FlowModules.findOrCreateModule({ flowFetch, orgId: designerTabState.orgId, packageId, projectionName });
  const newBranch = await FlowModules.commitModuleCode({ flowFetch, orgId: designerTabState.orgId, packageId, assetId: asset.id, flowScriptCode: code });
  return { assetId: asset.id, headVersionId: newBranch.headVersionId };
}

async function handleActivateModule({ assetId, headVersionId }) {
  if (!designerTabState) throw new Error("No Flow Designer tab is open.");
  const flowFetch = boundFlowFetch();
  await FlowDesignerTab.activateModule({ flowFetch, orgId: designerTabState.orgId, itemId: designerTabState.itemId, assetId, headVersionId });
  try {
    const [response] = await chrome.tabs.sendMessage(designerTabState.tabId, { type: "CLICK_REFRESH" });
    return { refreshed: !!(response && response.clicked) };
  } catch (e) {
    return { refreshed: false };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case "LIST_INSTANCES":
          return sendResponse({ ok: true, instances: await instanceStore.listInstances() });
        case "SAVE_INSTANCE": {
          // Tracking an instance's host requires the actual (not just declared) host permission —
          // optional_host_permissions in the manifest only makes requesting it possible, it grants nothing
          // by itself. Without this, webRequest silently never fires for that host at all.
          const origin = new URL(message.baseUrl).origin + "/*";
          const granted = await chrome.permissions.request({ origins: [origin] });
          if (!granted) return sendResponse({ ok: false, error: `Permission for ${origin} was not granted — tracking for this instance won't work.` });
          await instanceStore.saveInstance(message.baseUrl, message.fields, await instanceStore.ensureMasterKey(async () => message.masterPassword));
          return sendResponse({ ok: true });
        }
        case "DELETE_INSTANCE":
          await instanceStore.deleteInstance(message.baseUrl);
          return sendResponse({ ok: true });
        case "GET_UNMATCHED_HOSTS": {
          const { [UNMATCHED_HOSTS_KEY]: hosts = [] } = await chrome.storage.session.get(UNMATCHED_HOSTS_KEY);
          return sendResponse({ ok: true, hosts });
        }
        case "SET_TRACKING_ENABLED":
          await chrome.storage.local.set({ [TRACKING_ENABLED_KEY]: message.enabled });
          return sendResponse({ ok: true });
        case "GET_TRACKED": {
          const key = TRACKED_PROJECTIONS_PREFIX + message.baseUrl;
          const { [key]: list = [] } = await chrome.storage.session.get(key);
          return sendResponse({ ok: true, tracked: list });
        }
        case "SEARCH_PROJECTION": {
          const masterKey = await instanceStore.ensureMasterKey(async () => message.masterPassword);
          const token = await instanceStore.getIfsAuthToken(message.baseUrl, masterKey);
          const meta = await ProjectionSearch.queryProjectionMeta(message.baseUrl, token, message.term);
          return sendResponse({ ok: true, meta });
        }
        case "GET_DESIGNER_STATUS":
          return sendResponse({ ok: true, open: !!designerTabState, hasFlowToken: !!flowToken.get() });
        case "GET_MODULE_STATUS": {
          if (!designerTabState) return sendResponse({ ok: true, status: "not_created", assetId: null, headVersionId: null });
          const packageId = await ensureDesignerPackageId();
          const flowFetch = boundFlowFetch();
          const moduleAsset = await FlowModules.findExistingModule({ flowFetch, orgId: designerTabState.orgId, packageId, projectionName: message.projectionName });
          const designerData = await FlowDesignerTab.getDesignerData({ flowFetch, orgId: designerTabState.orgId, itemId: designerTabState.itemId });
          const status = FlowDesignerTab.computeModuleStatus(moduleAsset, designerData.assets);
          return sendResponse({
            ok: true,
            status,
            assetId: moduleAsset ? moduleAsset.id : null,
            headVersionId: moduleAsset ? moduleAsset.mainBranch.headVersionId : null
          });
        }
        case "CREATE_MODULE":
          return sendResponse({ ok: true, result: await handleCreateModule(message) });
        case "ACTIVATE_MODULE":
        case "RELOAD_AND_ACTIVATE":
          if (message.type === "RELOAD_AND_ACTIVATE") {
            const created = await handleCreateModule(message);
            return sendResponse({ ok: true, result: await handleActivateModule(created) });
          }
          return sendResponse({ ok: true, result: await handleActivateModule(message) });
        default:
          return sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (e) {
      if (/\(401\)/.test(e.message)) flowToken.clear();
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // keep the message channel open for the async response
});
```

- [ ] **Step 2: Load the extension unpacked and smoke-test the message router**

Run (manual, no automated harness for this step): `chrome://extensions` → Developer mode → Load unpacked → select this folder → open the service worker's console → run `chrome.runtime.sendMessage({type: "LIST_INSTANCES"}, console.log)`.
Expected: `{ok: true, instances: []}` logged, no thrown error.

- [ ] **Step 3: Commit**

```bash
git add background.js
git commit -m "feat: wire webRequest tracking, token sniffing, and the message router"
```

---

### Task 13: Side panel UI (plain/functional, per spec §13)

**Files:**
- Modify: `sidepanel.html`, `sidepanel.css`, `sidepanel.js`

**Interfaces:**
- Consumes: every `background.js` message type from Task 12.
- Produces: the user-facing panel. No automated test (DOM rendering, matches the project's stated boundary); verified by the manual walkthrough in Step 2.

- [ ] **Step 1: Implement the panel**

```html
<!-- sidepanel.html -->
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="sidepanel.css" />
  </head>
  <body>
    <section id="instances">
      <h2>IFS Instances</h2>
      <ul id="instanceList"></ul>
      <form id="instanceForm">
        <input id="instanceName" placeholder="Name" required />
        <input id="instanceBaseUrl" placeholder="https://ifs.example.com" required />
        <input id="instanceTokenEndpoint" placeholder="Token endpoint" required />
        <input id="instanceClientId" placeholder="Client ID" required />
        <input id="instanceClientSecret" placeholder="Client secret" type="password" required />
        <input id="masterPassword" placeholder="Master password" type="password" required />
        <button type="submit">Add instance</button>
      </form>
    </section>

    <section id="tracking">
      <label><input type="checkbox" id="trackingToggle" /> Tracking enabled</label>
    </section>

    <section id="search">
      <input id="searchTerm" placeholder="Search a projection…" />
      <button id="searchBtn">Search</button>
    </section>

    <section id="unmatchedHosts"></section>

    <section id="designerStatus"></section>

    <section id="projections">
      <h2>Traced / found projections</h2>
      <ul id="projectionList"></ul>
    </section>

    <script src="sidepanel.js"></script>
  </body>
</html>
```

```css
/* sidepanel.css */
body { font: 13px system-ui, sans-serif; margin: 0; padding: 8px; }
h2 { font-size: 13px; margin: 12px 0 4px; }
ul { list-style: none; margin: 0; padding: 0; }
li { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; border-bottom: 1px solid #ddd; }
.status { font-size: 11px; padding: 1px 6px; border-radius: 3px; background: #eee; }
button { cursor: pointer; }
```

```js
// sidepanel.js
function send(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

let currentBaseUrl = null;

async function refreshInstances() {
  const { instances } = await send({ type: "LIST_INSTANCES" });
  const list = document.getElementById("instanceList");
  list.innerHTML = "";
  for (const instance of instances) {
    const li = document.createElement("li");
    li.textContent = `${instance.name} (${instance.baseUrl})`;
    const selectBtn = document.createElement("button");
    selectBtn.textContent = "Select";
    selectBtn.onclick = () => { currentBaseUrl = instance.baseUrl; refreshProjections(); };
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.onclick = async () => { await send({ type: "DELETE_INSTANCE", baseUrl: instance.baseUrl }); refreshInstances(); };
    li.append(selectBtn, deleteBtn);
    list.appendChild(li);
  }
  if (!currentBaseUrl && instances.length) currentBaseUrl = instances[0].baseUrl;
}

document.getElementById("instanceForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await send({
    type: "SAVE_INSTANCE",
    baseUrl: document.getElementById("instanceBaseUrl").value,
    masterPassword: document.getElementById("masterPassword").value,
    fields: {
      name: document.getElementById("instanceName").value,
      authMethod: "client_credentials",
      tokenEndpoint: document.getElementById("instanceTokenEndpoint").value,
      clientId: document.getElementById("instanceClientId").value,
      secretPayload: { clientSecret: document.getElementById("instanceClientSecret").value }
    }
  });
  e.target.reset();
  refreshInstances();
});

document.getElementById("trackingToggle").addEventListener("change", (e) => {
  send({ type: "SET_TRACKING_ENABLED", enabled: e.target.checked });
});

function statusLabel(status) {
  return { not_created: "Not created", created: "Created", activated: "Activated", activated_stale: "Activated — update available" }[status] || status;
}

const masterPasswordOf = () => document.getElementById("masterPassword").value;

async function renderProjectionRow(container, name) {
  const [{ status, assetId, headVersionId }, { open }] = await Promise.all([
    send({ type: "GET_MODULE_STATUS", projectionName: name }),
    send({ type: "GET_DESIGNER_STATUS" })
  ]);

  const li = document.createElement("li");
  const label = document.createElement("span");
  label.textContent = name;
  const badge = document.createElement("span");
  badge.className = "status";
  badge.textContent = statusLabel(status);

  const actions = document.createElement("span");
  const disabledTitle = open ? "" : "Open or interact with the Designer tab first";

  if (status === "not_created") {
    const btn = document.createElement("button");
    btn.textContent = "Create";
    btn.disabled = !open;
    btn.title = disabledTitle;
    btn.onclick = () => send({ type: "CREATE_MODULE", baseUrl: currentBaseUrl, projectionName: name, masterPassword: masterPasswordOf() }).then(refreshProjections);
    actions.appendChild(btn);
  } else {
    if (status === "created") {
      const activateBtn = document.createElement("button");
      activateBtn.textContent = "Activate";
      activateBtn.disabled = !open;
      activateBtn.title = disabledTitle;
      activateBtn.onclick = () => send({ type: "ACTIVATE_MODULE", assetId, headVersionId }).then(refreshProjections);
      actions.appendChild(activateBtn);
    }
    const reloadBtn = document.createElement("button");
    reloadBtn.textContent = "Reload & Activate";
    reloadBtn.disabled = !open;
    reloadBtn.title = disabledTitle;
    reloadBtn.onclick = () => send({ type: "RELOAD_AND_ACTIVATE", baseUrl: currentBaseUrl, projectionName: name, masterPassword: masterPasswordOf() }).then(refreshProjections);
    actions.appendChild(reloadBtn);
  }

  li.append(label, badge, actions);
  container.appendChild(li);
}

async function refreshProjections() {
  if (!currentBaseUrl) return;
  const { tracked } = await send({ type: "GET_TRACKED", baseUrl: currentBaseUrl });
  const container = document.getElementById("projectionList");
  container.innerHTML = "";
  const sorted = tracked.slice().sort((a, b) => b.firstSeenAt - a.firstSeenAt);
  for (const row of sorted) {
    await renderProjectionRow(container, row.projectionName);
  }
}

async function refreshUnmatchedHosts() {
  const { hosts } = await send({ type: "GET_UNMATCHED_HOSTS" });
  const container = document.getElementById("unmatchedHosts");
  container.innerHTML = "";
  for (const host of hosts) {
    const p = document.createElement("p");
    p.textContent = `Traced calls to "${host}" don't match any saved instance. `;
    const btn = document.createElement("button");
    btn.textContent = "Add this instance";
    btn.onclick = () => {
      document.getElementById("instanceBaseUrl").value = `https://${host}`;
      document.getElementById("instanceBaseUrl").focus();
    };
    p.appendChild(btn);
    container.appendChild(p);
  }
}

document.getElementById("searchBtn").addEventListener("click", async () => {
  const term = document.getElementById("searchTerm").value.trim();
  if (!term || !currentBaseUrl) return;
  const { meta } = await send({ type: "SEARCH_PROJECTION", baseUrl: currentBaseUrl, term, masterPassword: masterPasswordOf() });
  if (meta) await renderProjectionRow(document.getElementById("projectionList"), meta.ProjectionName);
});

refreshInstances();
refreshProjections();
refreshUnmatchedHosts();
setInterval(() => { refreshProjections(); refreshUnmatchedHosts(); }, 5000);
```

- [ ] **Step 2: Manual smoke-test walkthrough**

Run (manual): load unpacked, open the side panel, add a real IFS instance, browse Aurena to trigger a `.svc` call, confirm it appears in the panel; open a real Flow Connect Designer tab for a package, confirm "Create" enables; click Create, confirm a module asset appears in Connect; click Activate, confirm the flow's `assets[]` now contains it (inspect via the Designer's own network tab or a `GET .../designer` call).
Expected: each step produces the described visible result. Any mismatch against §7a (token never captured), §10 item 2 (`packageId` resolution), or §9 (refresh click) is expected per the spec's own flagged unknowns — note what actually happened against each, since that's exactly the live verification the spec asked for.

- [ ] **Step 3: Commit**

```bash
git add sidepanel.html sidepanel.css sidepanel.js
git commit -m "feat: plain functional side panel UI"
```
