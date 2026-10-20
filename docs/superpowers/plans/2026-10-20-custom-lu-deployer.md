# Custom LU Deployer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create, extend and deploy IFS Cloud Custom LUs from NovacuraBuddy (create → attributes → approve → publish → grant → Flow module), with a create-only GitHub library and a Flow properties importer.

**Architecture:** Pure logic in `lib/` (UMD files: `module.exports` for node tests, `global.X` for the service worker and pages), all IFS/GitHub I/O in the background service worker behind new `CL_*` messages, UI in a new side-panel tab plus a full-page editor `cl-editor.html`. Shared pieces are first extracted from the Quick Reports code (IFS client, permission sets/grant, GitHub repo access, permission picker) so both features use one implementation.

**Tech Stack:** Chrome MV3 extension, plain JS (no build step), `node --test` (`npm test`).

**Spec:** `docs/superpowers/specs/2026-10-20-custom-lu-deployer-design.md`

**Repo:** `C:\Users\johan\Documents\IFS Cloud Projekt\NovacuraBuddy`, branch `feat/custom-lu-deployer`. Run every command from the repo root.

## Global Constraints

- Plain JS, no build step, no new dependencies. Every `lib/*.js` file uses the existing UMD wrapper: `(function (global) { … const api = {…}; if (typeof module !== "undefined" && module.exports) module.exports = api; if (typeof global !== "undefined") global.<Name> = api; })(typeof window !== "undefined" ? window : globalThis);`
- Cross-file `lib` dependencies use `const req = (path, name) => (typeof require === "function" ? require(path) : global[name]);` (as in `lib/qr-service.js`). In the service worker, `importScripts` order must load a dependency before its user.
- Quick Reports behaviour must not change. All 526 existing tests stay green after every task.
- IFS payloads keep the captured key order exactly; do not "tidy" them.
- Calls marked **UNCONFIRMED** in the spec carry an `// UNCONFIRMED:` comment in code: the String/Number/Date/DateTime type PATCHes for Number and DateTime, the 404 existence check, projection name = LU name.
- Errors surface verbatim; nothing is reported as success unless IFS returned 2xx. Never swallow an error to make a deploy look clean.
- Test fixtures are synthetic. Never commit a real Flow properties export or HAR (the repo is public; real exports contain passwords).
- Firefox build (`firefox/`) is not touched.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **LU or attribute names with spaces, quotes or umlauts** (typed by hand or from a properties column such as `"API Endpoint"`) — must be blocked or converted before any call, never sent into an OData key literal or `PROJECTION_NAME=…^`. Pinned in Task 4 (`validateLu`) and Task 6 (`columnToAttributeName`).
2. **Library/import LU deployed where an attribute already exists with another type or length** — the attribute is skipped and reported as a mismatch warning, never re-created or changed. Pinned in Task 4 (`diffAttributes`) and Task 5 (deploy with existing attributes).
3. **IFS fails in the middle of an attribute** (e.g. a PATCH returns 400) — the draft cleanup still runs, and the user sees the original IFS message, not the cleanup's. Pinned in Task 5.
4. **`$batch` answers 200 but a part inside failed** — the Approve-attributes step fails with the part's IFS message. Pinned in Task 5.
5. **Re-run after a failed deploy** (LU exists, some attributes created but not approved) — the LU and existing attributes are skipped, unapproved ones are approved, and Approve/Publish run. Pinned in Task 5.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `lib/ifs-client.js` | create | IFS REST client (bearer token, 401 retry, OData JSON + `$batch` helpers), `step()`, `ifsErrorMessage()`, `forInstance()` |
| `lib/ifs-permissions.js` | create | list permission sets, grant a projection to a permission set |
| `lib/qr-deploy.js` | modify | use the two files above; public API unchanged |
| `lib/qr-service.js` | modify | IFS client via `IfsClient.forInstance` |
| `lib/qr-history.js` | modify | `rememberPermissionSets()` (shared permission-set memory) |
| `lib/gh-library.js` | create | GitHub repo access (tree, blobs, contents PUT/DELETE, errors), `slugify` |
| `lib/qr-library.js` | modify | built on `gh-library.js`; public API unchanged |
| `lib/custom-lu-model.js` | create | pure: types, name rules, normalize, validate, diff against IFS attributes |
| `lib/cl-library.js` | create | create-only Custom LU library under `custom-lus/<login>/` |
| `lib/custom-lu-deploy.js` | create | EntityConfigHandling endpoints, deploy sequence, `$batch` build/check, reads |
| `lib/flow-properties.js` | create | Flow Connect properties export → LU definitions |
| `lib/cl-service.js` | create | background-side orchestration for all `CL_*` messages |
| `background.js` | modify | importScripts, `PERMISSION_SETS` + `CL_*` messages |
| `manifest.test.js` | modify | new scripts imported/exist; HTML script tags exist |
| `panels/common.js` | modify | `explainLocked()` |
| `panels/permission-picker.js` | create | instance select + permission-set checklist (shared) |
| `panels/qr-deploy-form.js` | modify | uses the shared picker |
| `panels/cl-deploy-form.js` | create | Custom LU deploy form + per-LU results + Module button |
| `cl-editor.html`, `cl-editor.js`, `cl-editor.css` | create | full-page editor (modes new / library / existing / import) |
| `panels/custom-lus.js` | create | side-panel tab |
| `sidepanel.html`, `sidepanel.js`, `qr-editor.html` | modify | script tags, new tab |

---

### Task 1: Extract the IFS client and permission calls

**Files:**
- Create: `lib/ifs-client.js`, `lib/ifs-client.test.js`, `lib/ifs-permissions.js`, `lib/ifs-permissions.test.js`
- Modify: `lib/qr-deploy.js`, `lib/qr-service.js`, `background.js` (importScripts), `sidepanel.html` (script tags), `manifest.test.js`

**Interfaces:**
- Produces:
  - `IfsClient.createIfsClient({ baseUrl, getToken, clearToken, fetchImpl })` → `{ get(path), post(path, body), patchText(path, text, etag), patchJson(path, body, etag), getOData(path), postOData(path, body, etag?), patchOData(path, body, etag), postBatch(path, boundary, text) → Promise<string> }`. A non-2xx response throws an `Error` with `.status` (number) and `.body` (response text).
  - `IfsClient.step(name, fn, { preferIfsMessage } = {})` → result of `fn`; on failure sets `err.step = name` and `err.message = "<name> failed — <message>"`, where `<message>` is `ifsErrorMessage(err)` when `preferIfsMessage` and available, else the original message.
  - `IfsClient.ifsErrorMessage(err)` → `string | null` (IFS `error.details[].message` joined by a space, else `error.message`).
  - `IfsClient.forInstance({ instanceStore, baseUrl, masterKey, fetchImpl })` → client for the instance origin.
  - `IfsPermissions.listPermissionSets(client)` → `[{ id, name }]` (IFS-managed sets filtered out).
  - `IfsPermissions.grantProjection(client, projectionName, role)` → step `"Grant to permission set <role>"`.
  - `IfsPermissions.endpoints.{ listPermissionSets(), grantProjection(), grantProjectionBody(projectionName, role) }`.

- [ ] **Step 1: Write the failing tests**

`lib/ifs-client.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { createIfsClient, step, ifsErrorMessage, forInstance } = require("./ifs-client.js");

const BASE = "https://ifs.example.com";
const res = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
  text: async () => (body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body))
});

function recorder(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, ...init }); return responder(url, init, calls); };
  return { calls, client: createIfsClient({ baseUrl: BASE, getToken: async () => "tok", clearToken: () => {}, fetchImpl }) };
}

test("postOData sends the EntityConfigHandling headers, bearer token and If-Match", async () => {
  const { calls, client } = recorder(() => res(200, { ok: 1 }));
  const out = await client.postOData("/x", { A: 1 }, 'W/"E1"');
  assert.deepEqual(out, { ok: 1 });
  assert.equal(calls[0].url, BASE + "/x");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].body, '{"A":1}');
  assert.deepEqual(calls[0].headers, {
    "Content-Type": "application/json;IEEE754Compatible=true",
    Accept: "application/json;odata.metadata=full;IEEE754Compatible=true",
    Prefer: "wait=99999",
    "If-Match": 'W/"E1"',
    Authorization: "Bearer tok"
  });
});

test("postOData without an etag sends no If-Match", async () => {
  const { calls, client } = recorder(() => res(204));
  assert.equal(await client.postOData("/x", {}), undefined);
  assert.equal("If-Match" in calls[0].headers, false);
});

test("patchOData sends PATCH with If-Match", async () => {
  const { calls, client } = recorder(() => res(200, {}));
  await client.patchOData("/v", { B: 2 }, "E");
  assert.equal(calls[0].method, "PATCH");
  assert.equal(calls[0].headers["If-Match"], "E");
});

test("getOData returns undefined on 204 and the JSON on 200", async () => {
  const { client } = recorder((url) => (url.endsWith("/a") ? res(204) : res(200, { value: "x" })));
  assert.equal(await client.getOData("/a"), undefined);
  assert.deepEqual(await client.getOData("/b"), { value: "x" });
});

test("postBatch sends multipart and returns the raw text", async () => {
  const { calls, client } = recorder(() => res(200, "--batch_1\r\nHTTP/1.1 204 No Content\r\n"));
  const text = await client.postBatch("/$batch", "B1", "BODY");
  assert.equal(text, "--batch_1\r\nHTTP/1.1 204 No Content\r\n");
  assert.equal(calls[0].headers["Content-Type"], "multipart/mixed;boundary=B1");
  assert.equal(calls[0].body, "BODY");
});

test("a failed request carries status and body", async () => {
  const body = { error: { code: "DATABASE_ERROR", message: "Database error occurred.", details: [{ code: 20105, message: "ORA-20105: no attribute" }] } };
  const { client } = recorder(() => res(500, body));
  await assert.rejects(client.postOData("/Approve", {}), (err) => {
    assert.equal(err.status, 500);
    assert.equal(err.body, JSON.stringify(body));
    assert.match(err.message, /^IFS request failed \(\/Approve, 500\)/);
    return true;
  });
});

test("ifsErrorMessage prefers details, then message, else null", () => {
  assert.equal(ifsErrorMessage({ body: JSON.stringify({ error: { message: "m", details: [{ message: "d1" }, { message: "d2" }] } }) }), "d1 d2");
  assert.equal(ifsErrorMessage({ body: JSON.stringify({ error: { message: "only" } }) }), "only");
  assert.equal(ifsErrorMessage({ body: "not json" }), null);
  assert.equal(ifsErrorMessage(new Error("x")), null);
});

test("step labels the failure; preferIfsMessage uses the IFS text", async () => {
  const err = Object.assign(new Error("IFS request failed (/Approve, 500): {...}"), { body: JSON.stringify({ error: { details: [{ message: "ORA-20105: no attribute" }] } }) });
  await assert.rejects(step("Approve LU", async () => { throw err; }, { preferIfsMessage: true }), /^Error: Approve LU failed — ORA-20105: no attribute$/);
  await assert.rejects(step("Other", async () => { throw new Error("plain"); }), /^Error: Other failed — plain$/);
});

test("step keeps the first label when nested", async () => {
  await assert.rejects(step("Outer", () => step("Inner", async () => { throw new Error("x"); })), /^Error: Inner failed — x$/);
});

test("forInstance targets the instance origin and uses the store's token", async () => {
  const calls = [];
  const instanceStore = {
    getIfsAuthToken: async (baseUrl, masterKey) => { calls.push(["token", baseUrl, masterKey]); return "T"; },
    clearIfsAuthToken: () => {}
  };
  const fetchImpl = async (url, init) => { calls.push(["fetch", url, init.headers.Authorization]); return res(200, {}); };
  const client = forInstance({ instanceStore, baseUrl: " https://ifs.example.com/main/ ", masterKey: "K", fetchImpl });
  await client.get("/p");
  assert.deepEqual(calls, [["token", " https://ifs.example.com/main/ ", "K"], ["fetch", "https://ifs.example.com/p", "Bearer T"]]);
});
```

`lib/ifs-permissions.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { listPermissionSets, grantProjection, endpoints } = require("./ifs-permissions.js");

test("grantProjection posts the captured GrantProjections payload", async () => {
  const calls = [];
  const client = { post: async (path, body) => { calls.push({ path, body }); } };
  await grantProjection(client, "CustomPageName", "SALES");
  assert.deepEqual(calls, [{
    path: "/main/ifsapplications/projection/v1/PermissionSetHandling.svc/GrantProjections",
    body: { Projections: "PROJECTION_NAME=CustomPageName^", Role: "SALES" }
  }]);
});

test("grantProjection failure names the permission set", async () => {
  const client = { post: async () => { throw new Error("boom"); } };
  await assert.rejects(grantProjection(client, "X", "SALES"), /^Error: Grant to permission set SALES failed — boom$/);
});

test("listPermissionSets drops IFS-managed sets and falls back to the role id", async () => {
  const client = { get: async (path) => {
    assert.equal(path, endpoints.listPermissionSets());
    return { value: [
      { Role: "SALES", Description: "Sales users", FndRoleDeliveryType: null },
      { Role: "FND_ADMIN", Description: "IFS admin", FndRoleDeliveryType: "IFSManaged" },
      { Role: "NODESC", Description: null, FndRoleDeliveryType: "Customer" }
    ] };
  } };
  assert.deepEqual(await listPermissionSets(client), [{ id: "SALES", name: "Sales users" }, { id: "NODESC", name: "NODESC" }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/ifs-client.test.js lib/ifs-permissions.test.js`
Expected: FAIL with `Cannot find module './ifs-client.js'` / `'./ifs-permissions.js'`.

- [ ] **Step 3: Create `lib/ifs-client.js`**

```js
(function (global) {
  // The one IFS REST client. Moved out of qr-deploy.js so Quick Reports and Custom LUs share it.
  // The OData helpers send what the IFS web client sends to EntityConfigHandling (captured
  // 2026-10-20): IEEE754Compatible JSON, full metadata, Prefer: wait=99999.
  const ODATA_JSON = "application/json;IEEE754Compatible=true";
  const ODATA_ACCEPT = "application/json;odata.metadata=full;IEEE754Compatible=true";

  function createIfsClient({ baseUrl, getToken, clearToken, fetchImpl }) {
    const doFetch = fetchImpl || ((...args) => fetch(...args));

    async function request(path, init, retried) {
      const token = await getToken();
      const res = await doFetch(baseUrl + path, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
      // A cached token can expire mid-session; one fresh token, never a loop.
      if (res.status === 401 && !retried) {
        clearToken();
        return request(path, init, true);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw Object.assign(new Error(`IFS request failed (${path.split("?")[0]}, ${res.status})${text ? ": " + text : ""}`), { status: res.status, body: text });
      }
      return res;
    }
    const bodyOf = async (res) => (res.status === 204 ? undefined : res.json());
    const odataHeaders = (etag) => ({ "Content-Type": ODATA_JSON, Accept: ODATA_ACCEPT, Prefer: "wait=99999", ...(etag ? { "If-Match": etag } : {}) });

    return {
      get: async (path) => (await request(path, { method: "GET" })).json(),
      post: async (path, body) =>
        bodyOf(await request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })),
      patchText: async (path, text, etag) => {
        await request(path, { method: "PATCH", headers: { "Content-Type": "application/octet-stream", "If-Match": etag }, body: text });
      },
      patchJson: async (path, body, etag) =>
        bodyOf(await request(path, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json;IEEE754Compatible=true",
            Accept: "application/json;odata.metadata=full;IEEE754Compatible=true",
            "If-Match": etag
          },
          body: JSON.stringify(body)
        })),
      getOData: async (path) => bodyOf(await request(path, { method: "GET", headers: { Accept: ODATA_ACCEPT, Prefer: "wait=99999" } })),
      postOData: async (path, body, etag) => bodyOf(await request(path, { method: "POST", headers: odataHeaders(etag), body: JSON.stringify(body) })),
      patchOData: async (path, body, etag) => bodyOf(await request(path, { method: "PATCH", headers: odataHeaders(etag), body: JSON.stringify(body) })),
      postBatch: async (path, boundary, text) =>
        (await request(path, {
          method: "POST",
          headers: { "Content-Type": `multipart/mixed;boundary=${boundary}`, Accept: "application/json, text/plain, */*", Prefer: "wait=99999" },
          body: text
        })).text()
    };
  }

  /** The message IFS put in an error body (details first — that is where the ORA- text is). */
  function ifsErrorMessage(err) {
    if (!err || !err.body) return null;
    try {
      const e = JSON.parse(err.body).error || {};
      const details = (e.details || []).map((d) => d && d.message).filter(Boolean);
      return details.length ? details.join(" ") : e.message || null;
    } catch {
      return null;
    }
  }

  /** Runs one named deploy step; a failure is re-labelled so the user sees which step broke. */
  async function step(name, fn, { preferIfsMessage } = {}) {
    try {
      return await fn();
    } catch (err) {
      if (!err.step) {
        err.step = name;
        err.message = `${name} failed — ${(preferIfsMessage && ifsErrorMessage(err)) || err.message}`;
      }
      throw err;
    }
  }

  /** A client for a Basic Data instance: its origin, its stored client-credentials token. */
  function forInstance({ instanceStore, baseUrl, masterKey, fetchImpl }) {
    return createIfsClient({
      baseUrl: new URL(String(baseUrl).trim()).origin,
      getToken: () => instanceStore.getIfsAuthToken(baseUrl, masterKey, fetchImpl),
      clearToken: () => instanceStore.clearIfsAuthToken(baseUrl),
      fetchImpl
    });
  }

  const api = { createIfsClient, step, ifsErrorMessage, forInstance };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.IfsClient = api;
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Create `lib/ifs-permissions.js`**

```js
(function (global) {
  const req = (path, name) => (typeof require === "function" ? require(path) : global[name]);
  const IfsClient = req("./ifs-client.js", "IfsClient");

  // GrantProjections payload CONFIRMED by the Quick Report HAR captures (2026-09-08/09); keep the
  // trailing "^". Shared by Quick Reports and Custom LUs.
  const PS = "/main/ifsapplications/projection/v1/PermissionSetHandling.svc";
  const IFS_MANAGED_DELIVERY_TYPE = "IFSManaged";

  const endpoints = {
    listPermissionSets: () => `${PS}/PermissionSets?$select=Role,Description,FndRoleDeliveryType`,
    grantProjection: () => `${PS}/GrantProjections`,
    grantProjectionBody: (projectionName, role) => ({ Projections: `PROJECTION_NAME=${projectionName}^`, Role: role })
  };

  async function listPermissionSets(client) {
    const res = await IfsClient.step("Load permission sets", () => client.get(endpoints.listPermissionSets()));
    return (res.value || [])
      .filter((row) => row.FndRoleDeliveryType !== IFS_MANAGED_DELIVERY_TYPE)
      .map((row) => ({ id: row.Role, name: row.Description || row.Role }));
  }

  function grantProjection(client, projectionName, role) {
    return IfsClient.step(`Grant to permission set ${role}`, () =>
      client.post(endpoints.grantProjection(), endpoints.grantProjectionBody(projectionName, role)));
  }

  const api = { listPermissionSets, grantProjection, endpoints };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.IfsPermissions = api;
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 5: Run the new tests**

Run: `node --test lib/ifs-client.test.js lib/ifs-permissions.test.js`
Expected: PASS (13 tests).

- [ ] **Step 6: Make `lib/qr-deploy.js` use them**

In `lib/qr-deploy.js`:

1. Directly after `(function (global) {` add:
```js
  const req = (path, name) => (typeof require === "function" ? require(path) : global[name]);
  const IfsClient = req("./ifs-client.js", "IfsClient");
  const IfsPermissions = req("./ifs-permissions.js", "IfsPermissions");
  const { step } = IfsClient;
```
2. Delete the lines `const PS = …`, `const IFS_MANAGED_DELIVERY_TYPE = "IFSManaged";`.
3. In `endpoints`, replace the three permission entries with:
```js
    listPermissionSets: () => IfsPermissions.endpoints.listPermissionSets(),
    grantProjection: () => IfsPermissions.endpoints.grantProjection(),
    grantProjectionBody: (quickReportId, role) => IfsPermissions.endpoints.grantProjectionBody(quickReportProjectionName(quickReportId), role),
```
4. Delete the whole `function createIfsClient(…) { … }` and the whole `async function step(name, fn) { … }` (now in `ifs-client.js`).
5. In `deployQuickReport`, replace the grant loop body with:
```js
    for (const role of permissionSetIds) {
      await IfsPermissions.grantProjection(client, quickReportProjectionName(quickReportId), role);
    }
```
6. Delete `async function listPermissionSets(client) { … }`.
7. Replace the `api` line with:
```js
  const api = {
    createIfsClient: IfsClient.createIfsClient,
    deployQuickReport,
    listPermissionSets: IfsPermissions.listPermissionSets,
    normalizeQuickReportId,
    quickReportProjectionName,
    endpoints
  };
```

- [ ] **Step 7: Make `lib/qr-service.js` use `forInstance`**

In `lib/qr-service.js` add after the `QrLibrary` line:
```js
  const IfsClient = req("./ifs-client.js", "IfsClient");
```
and replace the body of `function ifsClient(baseUrl, masterKey)` with:
```js
      return IfsClient.forInstance({ instanceStore, baseUrl, masterKey, fetchImpl });
```

- [ ] **Step 8: Load the new scripts in the worker and the side panel**

`background.js` importScripts: insert `"lib/ifs-client.js",` and `"lib/ifs-permissions.js",` directly before `"lib/qr-deploy.js",`.

`sidepanel.html`: replace `<script src="lib/qr-deploy.js"></script>` with:
```html
    <script src="lib/ifs-client.js"></script>
    <script src="lib/ifs-permissions.js"></script>
    <script src="lib/qr-deploy.js"></script>
```

`manifest.test.js`: in the test "every script background.js imports exists", extend the required list to
`["lib/ifs-client.js", "lib/ifs-permissions.js", "lib/qr-deploy.js", "lib/qr-history.js", "lib/qr-library.js", "lib/github-settings.js", "lib/qr-service.js", "lib/update-check.js"]`, and add after it:

```js
test("importScripts loads the IFS client before its users", () => {
  const src = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
  const block = src.match(/importScripts\(([\s\S]*?)\);/)[1];
  const files = [...block.matchAll(/"([^"]+\.js)"/g)].map((m) => m[1]);
  const at = (f) => files.indexOf(f);
  assert.ok(at("lib/ifs-client.js") < at("lib/ifs-permissions.js"));
  assert.ok(at("lib/ifs-permissions.js") < at("lib/qr-deploy.js"));
});

test("every <script src> in the extension pages exists", () => {
  for (const page of ["sidepanel.html", "qr-editor.html"]) {
    const html = fs.readFileSync(path.join(__dirname, page), "utf8");
    for (const m of html.matchAll(/<script src="([^"]+)"/g)) assert.ok(fs.existsSync(path.join(__dirname, m[1])), `${page}: ${m[1]} does not exist`);
  }
});
```

- [ ] **Step 9: Run the whole suite**

Run: `npm test`
Expected: PASS, 541 tests (526 + 13 new + 2 manifest), 0 fail.

- [ ] **Step 10: Commit**

```bash
git add lib/ifs-client.js lib/ifs-client.test.js lib/ifs-permissions.js lib/ifs-permissions.test.js lib/qr-deploy.js lib/qr-service.js background.js sidepanel.html manifest.test.js
git commit -m "refactor: shared IFS client and permission-set calls

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Extract GitHub repo access and add the Custom LU library

**Files:**
- Create: `lib/gh-library.js`, `lib/cl-library.js`, `lib/cl-library.test.js`
- Modify: `lib/qr-library.js`, `background.js`, `manifest.test.js`

**Interfaces:**
- Produces:
  - `GhLibrary.createGhRepo({ token, repo, fetchImpl, conflictMessage })` → `{ whoAmI(), checkAccess(), treeEntries() → [{path, sha, type}], readBlob(sha) → string, putFile(path, text, sha?, message) → newSha, deleteFile(path, sha, message) }`. A 409/422 on `/contents/` throws `Error(conflictMessage)` with `code: "CONFLICT"`.
  - `GhLibrary.slugify(name, fallback = "report")`.
  - `ClLibrary.createClLibrary({ token, repo, fetchImpl })` → `{ list(login) → [{ id, name, prompt, attributes }], create(login, lu) → { id, name, prompt, attributes } }`. `lu` is already normalized (Task 3 shape). Duplicate name (case-insensitive) throws `code: "EXISTS"`.

- [ ] **Step 1: Write the failing test** — `lib/cl-library.test.js`

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { createClLibrary } = require("./cl-library.js");

const REPO = "team/qr-data";
const res = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
  text: async () => JSON.stringify(body ?? "")
});

/** Minimal in-memory GitHub: tree, blobs, contents PUT with GitHub's sha rules. */
function fakeGitHub(files = {}) {
  let n = 0;
  const store = new Map(Object.entries(files).map(([p, c]) => [p, { sha: `sha${++n}`, content: c }]));
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    const path = decodeURIComponent(new URL(url).pathname);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (path === `/repos/${REPO}`) return res(200, { default_branch: "main" });
    if (path === `/repos/${REPO}/git/trees/main`) return res(200, { tree: [...store].map(([p, f]) => ({ path: p, type: "blob", sha: f.sha })) });
    const blob = path.match(/\/git\/blobs\/(.+)$/);
    if (blob) return res(200, { content: Buffer.from([...store.values()].find((f) => f.sha === blob[1]).content).toString("base64") });
    const contents = path.match(new RegExp(`^/repos/${REPO}/contents/(.+)$`));
    if (contents && method === "PUT") {
      if (store.has(contents[1]) && !body.sha) return res(422, { message: "sha wasn't supplied" });
      const sha = `sha${++n}`;
      store.set(contents[1], { sha, content: Buffer.from(body.content, "base64").toString("utf8") });
      return res(201, { content: { sha } });
    }
    return res(404, { message: "Not Found" });
  };
  return { fetchImpl, store, calls };
}

const lu = {
  name: "CustomPageName",
  prompt: "Custom Page Name",
  attributes: [
    { name: "NOTE", prompt: "Note", type: "STRING", length: 100 },
    { name: "QTY", prompt: "Qty", type: "NUMBER" }
  ]
};

test("create writes one JSON file under custom-lus/<login>/ and list reads it back", async () => {
  const gh = fakeGitHub({ "quick-reports/alice/r1.json": "{}", "custom-lus/bob/x.json": JSON.stringify({ name: "BobLu", attributes: [] }) });
  const lib = createClLibrary({ token: "t", repo: REPO, fetchImpl: gh.fetchImpl });
  const saved = await lib.create("alice", lu);
  assert.equal(saved.id, "custompagename");
  assert.deepEqual(JSON.parse(gh.store.get("custom-lus/alice/custompagename.json").content), {
    name: "CustomPageName",
    prompt: "Custom Page Name",
    attributes: [
      { name: "NOTE", prompt: "Note", type: "STRING", length: 100 },
      { name: "QTY", prompt: "Qty", type: "NUMBER" }
    ]
  });
  assert.equal(gh.calls.find((c) => c.method === "PUT").body.message, "add Custom LU: CustomPageName");
  const listed = await lib.list("alice");
  assert.deepEqual(listed, [{ id: "custompagename", name: "CustomPageName", prompt: "Custom Page Name", attributes: lu.attributes }]);
});

test("create refuses a name already in my library (case-insensitive) without writing", async () => {
  const gh = fakeGitHub({ "custom-lus/alice/custompagename.json": JSON.stringify(lu) });
  const lib = createClLibrary({ token: "t", repo: REPO, fetchImpl: gh.fetchImpl });
  await assert.rejects(lib.create("alice", { ...lu, name: "CUSTOMPAGENAME" }), (err) => err.code === "EXISTS" && /already in the library/.test(err.message));
  assert.equal(gh.calls.some((c) => c.method === "PUT"), false);
});

test("a different user's LU with the same name does not block mine", async () => {
  const gh = fakeGitHub({ "custom-lus/bob/custompagename.json": JSON.stringify(lu) });
  const lib = createClLibrary({ token: "t", repo: REPO, fetchImpl: gh.fetchImpl });
  assert.equal((await lib.create("alice", lu)).id, "custompagename");
});

test("slug collision with a different name gets a numbered id", async () => {
  const gh = fakeGitHub({ "custom-lus/alice/custom-page-name.json": JSON.stringify({ ...lu, name: "Custom_Page_Name" }) });
  const lib = createClLibrary({ token: "t", repo: REPO, fetchImpl: gh.fetchImpl });
  assert.equal((await lib.create("alice", { ...lu, name: "Custom-Page-Name" })).id, "custom-page-name-2");
});

test("a file created between list and PUT surfaces the library conflict message", async () => {
  const gh = fakeGitHub({});
  const lib = createClLibrary({ token: "t", repo: REPO, fetchImpl: async (url, init = {}) => {
    if ((init.method || "GET") === "PUT") return res(422, { message: "sha wasn't supplied" });
    return gh.fetchImpl(url, init);
  } });
  await assert.rejects(lib.create("alice", lu), (err) => err.code === "CONFLICT" && err.message === "This Custom LU is already in the library.");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test lib/cl-library.test.js`
Expected: FAIL with `Cannot find module './cl-library.js'`.

- [ ] **Step 3: Create `lib/gh-library.js`** (moved verbatim from `qr-library.js`, conflict text injectable)

```js
(function (global) {
  const API = "https://api.github.com";

  /** Same rule as the Electron app's qrFileStore.slugify, so existing files keep their ids. */
  function slugify(name, fallback = "report") {
    const slug = String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return slug || fallback;
  }

  // GitHub's contents/blobs APIs speak base64 of the raw bytes; btoa/atob alone would break on
  // anything outside Latin-1 (ä, €, …), so go through UTF-8 bytes explicitly.
  function utf8ToBase64(text) {
    let binary = "";
    for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  function base64ToUtf8(b64) {
    const binary = atob(String(b64).replace(/\s/g, ""));
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  }

  const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");

  /** Access to one GitHub data repo (the Quick Reports / Custom LU library). `conflictMessage` is
   *  what a 409/422 on a file write means for the caller. */
  function createGhRepo({ token, repo, fetchImpl, conflictMessage }) {
    const doFetch = fetchImpl || ((...args) => fetch(...args));
    let branchPromise = null;

    async function gh(method, path, body) {
      const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
      if (body) headers["Content-Type"] = "application/json";
      const res = await doFetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      if (res.ok) return res.status === 204 ? undefined : res.json();
      throw await toError(res, method, path);
    }

    async function toError(res, method, path) {
      if (res.status === 401) return new Error("GitHub token rejected — check it in Basic Data.");
      if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
        const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
        return new Error(`GitHub rate limit reached — try again after ${new Date(reset).toLocaleTimeString()}.`);
      }
      if ((res.status === 409 || res.status === 422) && path.includes("/contents/")) {
        return Object.assign(new Error(conflictMessage), { code: "CONFLICT" });
      }
      if (res.status === 404 && path === `/repos/${repo}`) return new Error(`No access to ${repo} (or it doesn't exist) — check the repo name and the token's permissions.`);
      const text = await res.text().catch(() => "");
      return new Error(`GitHub request failed (${method} ${path.split("?")[0]}, ${res.status})${text ? ": " + text : ""}`);
    }

    const whoAmI = async () => (await gh("GET", "/user")).login;
    const checkAccess = async () => { await branch(); };

    function branch() {
      if (!branchPromise) {
        branchPromise = gh("GET", `/repos/${repo}`).then((r) => r.default_branch).catch((e) => { branchPromise = null; throw e; });
      }
      return branchPromise;
    }

    async function treeEntries() {
      const tree = await gh("GET", `/repos/${repo}/git/trees/${encodeURIComponent(await branch())}?recursive=1`);
      return (tree.tree || []).filter((e) => e.type === "blob");
    }

    const readBlob = async (sha) => base64ToUtf8((await gh("GET", `/repos/${repo}/git/blobs/${sha}`)).content);

    async function putFile(path, text, sha, message) {
      const body = { message, content: utf8ToBase64(text), branch: await branch() };
      if (sha) body.sha = sha;
      return (await gh("PUT", `/repos/${repo}/contents/${encodePath(path)}`, body)).content.sha;
    }

    async function deleteFile(path, sha, message) {
      await gh("DELETE", `/repos/${repo}/contents/${encodePath(path)}`, { message, sha, branch: await branch() });
    }

    return { whoAmI, checkAccess, treeEntries, readBlob, putFile, deleteFile };
  }

  const api = { createGhRepo, slugify, utf8ToBase64, base64ToUtf8 };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.GhLibrary = api;
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Rebuild `lib/qr-library.js` on it**

Replace the top of `lib/qr-library.js` — everything from `(function (global) {` down to and including the closing `}` of `async function deleteFile(...) {...}` inside `createQrLibrary` — so the file reads:

```js
(function (global) {
  const req = (path, name) => (typeof require === "function" ? require(path) : global[name]);
  const GhLibrary = req("./gh-library.js", "GhLibrary");
  const { slugify } = GhLibrary;

  function createQrLibrary({ token, repo, fetchImpl }) {
    const ghRepo = GhLibrary.createGhRepo({
      token, repo, fetchImpl,
      conflictMessage: "This report changed on GitHub since you loaded it — reload before saving."
    });
    const { treeEntries, readBlob, putFile, deleteFile } = ghRepo;

    /** slug → { sql: entry, json: entry } for files directly inside `prefix`. */
    function groupBySlug(entries, prefix) {
```

Keep `groupBySlug`, `ownPrefix`, `list`, `save`, `moveUnowned` exactly as they are. Change the return line of `createQrLibrary` to:
```js
    return { whoAmI: ghRepo.whoAmI, checkAccess: ghRepo.checkAccess, list, save, moveUnowned };
```
The `api` line stays `const api = { createQrLibrary, slugify };`. Delete the now-unused `API`, `utf8ToBase64`, `base64ToUtf8`, `encodePath`, `gh`, `toError`, `whoAmI`, `checkAccess`, `branch`, `branchPromise`, `doFetch` definitions from this file.

- [ ] **Step 5: Run the Quick Reports library tests**

Run: `node --test lib/qr-library.test.js lib/qr-service.test.js`
Expected: PASS (all existing tests unchanged).

- [ ] **Step 6: Create `lib/cl-library.js`**

```js
(function (global) {
  const req = (path, name) => (typeof require === "function" ? require(path) : global[name]);
  const GhLibrary = req("./gh-library.js", "GhLibrary");

  /** Manually created Custom LUs, one JSON file each, in the same data repo as Quick Reports.
   *  Create only (user decision 2026-10-20): a library LU is saved once and never overwritten. */
  function createClLibrary({ token, repo, fetchImpl }) {
    const ghRepo = GhLibrary.createGhRepo({ token, repo, fetchImpl, conflictMessage: "This Custom LU is already in the library." });
    const ownPrefix = (login) => `custom-lus/${login}/`;

    function ownFiles(entries, login) {
      const prefix = ownPrefix(login);
      return entries
        .filter((e) => e.path.startsWith(prefix) && /^[^/]+\.json$/.test(e.path.slice(prefix.length)))
        .map((e) => ({ id: e.path.slice(prefix.length, -".json".length), sha: e.sha }));
    }

    async function list(login) {
      const files = ownFiles(await ghRepo.treeEntries(), login);
      const lus = await Promise.all(files.map(async (f) => {
        const data = JSON.parse(await ghRepo.readBlob(f.sha));
        return { id: f.id, name: data.name, prompt: data.prompt, attributes: data.attributes || [] };
      }));
      return lus.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }

    async function create(login, lu) {
      const existing = await list(login);
      const target = lu.name.toLowerCase();
      if (existing.some((x) => String(x.name).toLowerCase() === target)) {
        throw Object.assign(new Error(`"${lu.name}" is already in the library — library LUs are saved once and not changed.`), { code: "EXISTS" });
      }
      const taken = new Set(existing.map((x) => x.id));
      const base = GhLibrary.slugify(lu.name, "lu");
      let id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
      const file = {
        name: lu.name,
        prompt: lu.prompt,
        attributes: lu.attributes.map(({ name, prompt, type, length }) => (type === "STRING" ? { name, prompt, type, length } : { name, prompt, type }))
      };
      await ghRepo.putFile(`${ownPrefix(login)}${id}.json`, JSON.stringify(file, null, 2), undefined, `add Custom LU: ${lu.name}`);
      return { id, ...file };
    }

    return { list, create };
  }

  const api = { createClLibrary };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.ClLibrary = api;
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 7: Run the new test**

Run: `node --test lib/cl-library.test.js`
Expected: PASS (5 tests).

- [ ] **Step 8: Wire the scripts**

`background.js` importScripts: insert `"lib/gh-library.js",` directly before `"lib/qr-library.js",`, and `"lib/cl-library.js",` directly after `"lib/qr-library.js",`.

`manifest.test.js`: add `"lib/gh-library.js"`, `"lib/cl-library.js"` to the required list, and in "importScripts loads the IFS client before its users" add:
```js
  assert.ok(at("lib/gh-library.js") < at("lib/qr-library.js"));
  assert.ok(at("lib/gh-library.js") < at("lib/cl-library.js"));
```

- [ ] **Step 9: Run the whole suite**

Run: `npm test`
Expected: PASS, 546 tests, 0 fail.

- [ ] **Step 10: Commit**

```bash
git add lib/gh-library.js lib/qr-library.js lib/cl-library.js lib/cl-library.test.js background.js manifest.test.js
git commit -m "feat: create-only Custom LU library on shared GitHub repo access

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Custom LU model (types, names, validation, diff)

**Files:**
- Create: `lib/custom-lu-model.js`, `lib/custom-lu-model.test.js`
- Modify: `background.js`, `manifest.test.js`

**Interfaces:**
- Produces (`CustomLuModel`):
  - constants `TYPES = ["STRING","NUMBER","DATE","DATETIME"]`, `TYPE_LABELS`, `DEFAULT_LENGTH = 100`, `MAX_LENGTH = 4000`
  - `toAttributeName(raw)` → trimmed upper case; `toProperCase(name)` → `"Customattrname"` style
  - `normalizeLu(input)` → `{ name, prompt, attributes: [{ name, prompt, type, length? }] }` (`length` only for STRING, a Number; default 100)
  - `validateLu(lu)` → `[{ index, field, message }]` (`index` -1 = LU level); empty = valid
  - `diffAttributes(desired, existingRows)` where rows are IFS `CustomFieldAttributesArray` rows `{ AttributeName, DataType, DataLength, Published }` → `{ toCreate: [attr], skipped: [name], mismatches: [{ name, message }], unapproved: [name] }`
  - `ifsDataType(type)` → `"DATE"` for DATETIME, else the type

- [ ] **Step 1: Write the failing test** — `lib/custom-lu-model.test.js`

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("./custom-lu-model.js");

test("toProperCase matches what IFS ToProperCase returned in the captures", () => {
  assert.equal(M.toProperCase("CUSTOMATTRNAME"), "Customattrname");
  assert.equal(M.toProperCase("VDSF311DCXYVC"), "Vdsf311dcxyvc");
  assert.equal(M.toProperCase(""), "");
});

test("normalizeLu trims, upper-cases attribute names, defaults prompts and String length", () => {
  assert.deepEqual(M.normalizeLu({
    name: "  Demo ", prompt: "",
    attributes: [
      { name: " note ", prompt: "", type: "string" },
      { name: "qty", prompt: "Quantity", type: "NUMBER", length: 50 },
      { name: "due", type: "DATETIME" },
      { name: "big", type: "STRING", length: "4000" }
    ]
  }), {
    name: "Demo", prompt: "Demo",
    attributes: [
      { name: "NOTE", prompt: "Note", type: "STRING", length: 100 },
      { name: "QTY", prompt: "Quantity", type: "NUMBER" },
      { name: "DUE", prompt: "Due", type: "DATETIME" },
      { name: "BIG", prompt: "Big", type: "STRING", length: 4000 }
    ]
  });
});

test("validateLu accepts a clean LU", () => {
  assert.deepEqual(M.validateLu(M.normalizeLu({ name: "CustomPageName", attributes: [{ name: "A1", type: "DATE" }] })), []);
});

test("validateLu flags names that would break OData keys or PROJECTION_NAME", () => {
  const messages = (lu) => M.validateLu(M.normalizeLu(lu)).map((p) => p.message);
  assert.deepEqual(messages({ name: "", attributes: [{ name: "A", type: "STRING" }] }), ["LU name can't be empty."]);
  for (const bad of ["My LU", "O'Brien", "Müller", "1Lu", "Lu^X"]) {
    assert.deepEqual(messages({ name: bad, attributes: [{ name: "A", type: "STRING" }] }), ["LU name: letters, digits and _ only, starting with a letter."], bad);
  }
  assert.deepEqual(messages({ name: "Lu", attributes: [{ name: "1231", type: "STRING" }] }), ["1231: First letter should be an uppercase alpha character."]);
  assert.deepEqual(messages({ name: "Lu", attributes: [{ name: "API ENDPOINT", type: "STRING" }] }), ["API ENDPOINT: letters, digits and _ only."]);
  assert.deepEqual(messages({ name: "Lu", attributes: [{ name: "ÄRGER", type: "STRING" }] }), ["ÄRGER: First letter should be an uppercase alpha character."]);
  assert.deepEqual(messages({ name: "Lu", attributes: [{ name: "", type: "STRING" }] }), ["Row 1: Attribute name can't be empty."]);
});

test("validateLu flags empty attribute list, duplicates, bad type and bad length", () => {
  const problems = (lu) => M.validateLu(M.normalizeLu(lu));
  assert.deepEqual(problems({ name: "Lu", attributes: [] }).map((p) => p.message), ["Add at least one attribute."]);
  assert.deepEqual(problems({ name: "Lu", attributes: [{ name: "A", type: "STRING" }, { name: "a", type: "NUMBER" }] }).map((p) => [p.index, p.message]), [[1, "A: used twice."]]);
  assert.deepEqual(problems({ name: "Lu", attributes: [{ name: "A", type: "BLOB" }] }).map((p) => p.field), ["type"]);
  for (const length of [0, 4001, 2.5, "abc"]) {
    assert.deepEqual(problems({ name: "Lu", attributes: [{ name: "A", type: "STRING", length }] }).map((p) => p.message), ["A: length must be a whole number from 1 to 4000."], String(length));
  }
});

test("diffAttributes creates only missing attributes and warns on type/length differences", () => {
  const desired = M.normalizeLu({ name: "Lu", attributes: [
    { name: "NOTE", type: "STRING", length: 100 },
    { name: "QTY", type: "STRING" },
    { name: "DUE", type: "DATETIME" },
    { name: "LONG", type: "STRING", length: 200 },
    { name: "NEW1", type: "NUMBER" }
  ] }).attributes;
  const rows = [
    { AttributeName: "NOTE", DataType: "STRING", DataLength: "100", Published: true },
    { AttributeName: "QTY", DataType: "NUMBER", DataLength: null, Published: true },
    { AttributeName: "DUE", DataType: "DATE", DataLength: null, Published: true },
    { AttributeName: "LONG", DataType: "STRING", DataLength: "4000", Published: false },
    { AttributeName: "OTHER", DataType: "STRING", DataLength: "10", Published: false }
  ];
  const diff = M.diffAttributes(desired, rows);
  assert.deepEqual(diff.toCreate.map((a) => a.name), ["NEW1"]);
  assert.deepEqual(diff.skipped, ["NOTE", "QTY", "DUE", "LONG"]);
  assert.deepEqual(diff.mismatches, [
    { name: "QTY", message: "QTY exists as NUMBER, not String — left unchanged." },
    { name: "LONG", message: "LONG exists with length 4000, not 200 — left unchanged." }
  ]);
  assert.deepEqual(diff.unapproved, ["LONG", "OTHER"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test lib/custom-lu-model.test.js`
Expected: FAIL with `Cannot find module './custom-lu-model.js'`.

- [ ] **Step 3: Create `lib/custom-lu-model.js`**

```js
(function (global) {
  // Pure rules for a Custom LU definition, shared by the editor page (live validation) and the
  // background (deploy). IFS stays the authority: ValidateLu / ValidateAttributeName still run.
  const TYPES = ["STRING", "NUMBER", "DATE", "DATETIME"];
  const TYPE_LABELS = { STRING: "String", NUMBER: "Number", DATE: "Date", DATETIME: "DateTime" };
  const DEFAULT_LENGTH = 100;
  const MAX_LENGTH = 4000;

  /** DateTime is a DATE attribute with a different DateFormat in IFS. */
  const ifsDataType = (type) => (type === "DATETIME" ? "DATE" : type);
  const toAttributeName = (raw) => String(raw == null ? "" : raw).trim().toUpperCase();
  const toProperCase = (name) => {
    const s = String(name);
    return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : "";
  };

  function normalizeAttribute(a) {
    const name = toAttributeName(a.name);
    const type = String(a.type || "STRING").trim().toUpperCase();
    const out = { name, prompt: String(a.prompt || "").trim() || toProperCase(name), type };
    if (type === "STRING") out.length = a.length === undefined || a.length === null || a.length === "" ? DEFAULT_LENGTH : Number(a.length);
    return out;
  }

  function normalizeLu(lu) {
    const name = String(lu.name || "").trim();
    return { name, prompt: String(lu.prompt || "").trim() || name, attributes: (lu.attributes || []).map(normalizeAttribute) };
  }

  // The LU name ends up inside OData key literals ('…') and in PROJECTION_NAME=…^, so only plain
  // identifier characters get through.
  function luNameProblem(name) {
    if (!name) return "LU name can't be empty.";
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) return "LU name: letters, digits and _ only, starting with a letter.";
    return "";
  }

  function attributeNameProblem(name) {
    if (!name) return "Attribute name can't be empty.";
    if (!/^[A-Z]/.test(name)) return "First letter should be an uppercase alpha character."; // IFS's own wording
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return "Attribute name: letters, digits and _ only.";
    return "";
  }

  function validateLu(lu) {
    const problems = [];
    const luProblem = luNameProblem(lu.name);
    if (luProblem) problems.push({ index: -1, field: "name", message: luProblem });
    if (!lu.attributes.length) problems.push({ index: -1, field: "attributes", message: "Add at least one attribute." });
    const seen = new Set();
    lu.attributes.forEach((a, index) => {
      const label = a.name || `Row ${index + 1}`;
      const nameProblem = attributeNameProblem(a.name);
      if (nameProblem) problems.push({ index, field: "name", message: `${label}: ${nameProblem}` });
      else if (seen.has(a.name)) problems.push({ index, field: "name", message: `${a.name}: used twice.` });
      seen.add(a.name);
      if (!TYPES.includes(a.type)) problems.push({ index, field: "type", message: `${label}: unknown type ${a.type}.` });
      if (a.type === "STRING" && !(Number.isInteger(a.length) && a.length >= 1 && a.length <= MAX_LENGTH)) {
        problems.push({ index, field: "length", message: `${label}: length must be a whole number from 1 to ${MAX_LENGTH}.` });
      }
    });
    return problems;
  }

  /** What to do with `desired` attributes on an LU that already has `existingRows` in IFS:
   *  create the missing ones, never touch existing ones (type/length differences are warnings),
   *  and approve existing attributes left unpublished by an earlier failed run. */
  function diffAttributes(desired, existingRows) {
    const byName = new Map(existingRows.map((r) => [String(r.AttributeName).toUpperCase(), r]));
    const toCreate = [];
    const skipped = [];
    const mismatches = [];
    for (const a of desired) {
      const row = byName.get(a.name);
      if (!row) { toCreate.push(a); continue; }
      skipped.push(a.name);
      if (row.DataType !== ifsDataType(a.type)) {
        mismatches.push({ name: a.name, message: `${a.name} exists as ${row.DataType}, not ${TYPE_LABELS[a.type] || a.type} — left unchanged.` });
      } else if (a.type === "STRING" && String(row.DataLength) !== String(a.length)) {
        mismatches.push({ name: a.name, message: `${a.name} exists with length ${row.DataLength}, not ${a.length} — left unchanged.` });
      }
    }
    const unapproved = existingRows.filter((r) => r.Published === false).map((r) => String(r.AttributeName).toUpperCase());
    return { toCreate, skipped, mismatches, unapproved };
  }

  const api = { TYPES, TYPE_LABELS, DEFAULT_LENGTH, MAX_LENGTH, ifsDataType, toAttributeName, toProperCase, normalizeLu, validateLu, diffAttributes };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.CustomLuModel = api;
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run the test**

Run: `node --test lib/custom-lu-model.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Wire the script**

`background.js` importScripts: add `"lib/custom-lu-model.js",` directly after `"lib/cl-library.js",`. `manifest.test.js`: add `"lib/custom-lu-model.js"` to the required list.

- [ ] **Step 6: Run the whole suite, then commit**

Run: `npm test` — Expected: PASS, 553 tests.

```bash
git add lib/custom-lu-model.js lib/custom-lu-model.test.js background.js manifest.test.js
git commit -m "feat: Custom LU model — types, name rules, validation, attribute diff

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Custom LU deploy sequence

**Files:**
- Create: `lib/custom-lu-deploy.js`, `lib/custom-lu-deploy.test.js`
- Modify: `background.js`, `manifest.test.js`

**Interfaces:**
- Consumes: `IfsClient.step`, client methods `getOData/postOData/patchOData/postBatch/post` (Task 1); `IfsPermissions.grantProjection` (Task 1); `CustomLuModel.validateLu/diffAttributes` (Task 3).
- Produces (`CustomLuDeploy`):
  - `deployCustomLu(client, { lu, permissionSetIds, uuid })` → `{ name, createdLu: boolean, created: [name], skipped: [name], mismatches: [{name, message}], approved: [name], published: boolean, granted: [role] }`; `lu` is normalized. Throws on the first failing step.
  - `deployAll(client, lus, { permissionSetIds, uuid })` → `[{ name, ok: true, outcome } | { name, ok: false, error }]`, sequential, failures isolated.
  - `listCustomLus(client)` → `[{ name }]` sorted.
  - `getCustomLuDefinition(client, name)` → `{ name, prompt, attributes: [{ name, prompt, type, length?, published }] }`.
  - `approveAttributesBatch(luName, names, uuid)` → `{ boundary, text }`; `checkBatchResponse(text)` (throws with `.body` set to the failing part's JSON).
  - `endpoints` (object of path builders).

- [ ] **Step 1: Write the failing test** — `lib/custom-lu-deploy.test.js`

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { createIfsClient } = require("./ifs-client.js");
const { deployCustomLu, deployAll, listCustomLus, getCustomLuDefinition, approveAttributesBatch, checkBatchResponse } = require("./custom-lu-deploy.js");
const { normalizeLu } = require("./custom-lu-model.js");

const BASE = "https://ifs.example.com";
const res = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
  text: async () => (body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body))
});

// Captured 2026-10-20 (ApproveAttribute $batch answer), boundaries kept.
const BATCH_OK = "--batch_252648d5\r\nContent-Type: multipart/mixed; boundary=changeset_927d5c87\r\n\r\n--changeset_927d5c87\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\nContent-ID: 1\r\n\r\nHTTP/1.1 204 No Content\r\nOData-Version: 4.0\r\nContent-Length: 0\r\n\r\n\r\n--changeset_927d5c87--\r\n--batch_252648d5--\r\n";

function fakeIfs({ existingLu = false, existingAttributes = [], override } = {}) {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    const call = { method: init.method, path: decodeURIComponent(url.replace(BASE, "")), headers: init.headers || {}, body: init.body };
    calls.push(call);
    const forced = override && override(call, calls);
    if (forced) return forced;
    const { method, path } = call;
    if (method === "GET" && /\/CustomLusSet\(Lu='[^']*',LuType=[^)]*\)\?\$select=/.test(path)) {
      return existingLu ? res(200, { Lu: "Demo", Prompt: "Demo LU" }) : res(404, { error: { code: "NOT_FOUND", message: "Not found" } });
    }
    if (method === "GET" && path.includes("/CustomFieldAttributesArray")) return res(200, { value: existingAttributes });
    if (method === "GET" && path.includes("/ValidateLu(")) return res(204);
    if (method === "GET" && path.includes("/ValidateAttributeName(")) return res(204);
    if (method === "POST" && path.includes("/CustomLusSet?select-fields=")) return res(201, { Lu: "Demo" });
    if (method === "POST" && path.endsWith("/CustomAttributesVirtuals")) { n++; return res(201, { Objkey: `OBJ${n}`, "@odata.etag": `W/"E${n}"` }); }
    if (method === "POST" && path.endsWith("/CleanDisplayTextVirtual")) return res(204);
    if (method === "PATCH" && path.includes("/CustomAttributesVirtuals(Objkey=")) return res(200, {});
    if (method === "POST" && path.endsWith("_CreateCustomAttributes")) return res(204);
    if (method === "POST" && path.endsWith("_CleanupVirtualEntity")) return res(204);
    if (method === "POST" && path.endsWith("/$batch")) return res(200, BATCH_OK);
    if (method === "POST" && (path.endsWith("/Approve") || path.endsWith("/Publish"))) return res(204);
    if (method === "POST" && path.endsWith("/GrantProjections")) return res(204);
    throw new Error(`unexpected ${method} ${path}`);
  };
  const client = createIfsClient({ baseUrl: BASE, getToken: async () => "tok", clearToken: () => {}, fetchImpl });
  return { client, calls };
}

/** "POST CustomAttributesVirtuals(OBJ)/…_CreateCustomAttributes" style labels for order checks. */
function label(c) {
  const p = c.path.replace(/^.*\.svc\//, "").replace(/\?.*$/, "").replace(/\(Objkey='[^']+'\)/, "(OBJ)").replace(/^CustomLusSet\([^/]*\)/, "CustomLusSet(key)").replace("IfsApp.EntityConfigHandling.CustomAttributesVirtual", "…");
  return `${c.method} ${p}`;
}

const uuid = (() => { let i = 0; return () => `u${++i}`; });
const demo = (attributes) => normalizeLu({ name: "Demo", prompt: "Demo LU", attributes });

test("new LU with one String attribute: full captured sequence, then grant", async () => {
  const { client, calls } = fakeIfs();
  const outcome = await deployCustomLu(client, { lu: demo([{ name: "NOTE", prompt: "Note", type: "STRING", length: 4000 }]), permissionSetIds: ["SALES"], uuid: uuid() });
  assert.deepEqual(calls.map(label), [
    "GET CustomLusSet(key)",
    "GET ValidateLu(Lu='Demo')",
    "POST CustomLusSet",
    "GET ValidateAttributeName(AttributeName='NOTE')",
    "POST CustomAttributesVirtuals",
    "POST CleanDisplayTextVirtual",
    "PATCH CustomAttributesVirtuals(OBJ)",
    "PATCH CustomAttributesVirtuals(OBJ)",
    "PATCH CustomAttributesVirtuals(OBJ)",
    "PATCH CustomAttributesVirtuals(OBJ)",
    "POST CustomAttributesVirtuals(OBJ)/…_CreateCustomAttributes",
    "POST CustomAttributesVirtuals(OBJ)/…_CleanupVirtualEntity",
    "POST $batch",
    "POST Approve",
    "POST Publish",
    "POST GrantProjections"
  ]);
  const create = calls.find((c) => label(c) === "POST CustomLusSet");
  assert.equal(create.body, '{"Lu":"Demo","Module":"CONFIG","Prompt":"Demo LU","UsedDb":false,"SynchronizedDb":false,"EnabledRowkey":false,"CreateProjectionDb":true,"PublishedDb":false}');
  assert.match(create.path, /\?select-fields=Lu,LuType,Objgrants,Prompt,Module,UsedDb,PublishedDb,SynchronizedDb,EnabledRowkey,LogicalUnitType,CreateProjectionDb,PackgName,TimestampTzRef,SiteTimeZoneRef,Excluded,RowkeyInEntity,CountAttributes,LuTypeName,HasTranslatableText,HasUnusedData,HasUnusedTable,AddedToPackage,luname,keyref$/);
  const virtual = calls.find((c) => label(c) === "POST CustomAttributesVirtuals");
  assert.equal(virtual.body, '{"Swap":false,"Insertable":true,"Updatable":true,"Queryable":true,"EnabledOnReports":false,"EnabledOnOutboundMsgs":false,"Private":false,"IsValidName":false,"Multiline":false,"ClickableHyperlink":false,"TempRefTypeOne":false,"TempRefTypeTwo":false,"TempRefTypeThree":false,"EnableOk":true,"EditMode":false,"HasVirtualUpdated":false,"HasEnumUpdated":true,"Lu":"Demo","LuType":"CUSTOM_LU","DataType":"STRING","DefaultValueType":"NO_DEFAULT_VALUE","DataLength":"100","HasChanged":"FALSE","HasNewItem":"FALSE"}');
  const patches = calls.filter((c) => c.method === "PATCH");
  assert.deepEqual(patches.map((c) => c.body), ['{"CustomAttributeType":"PERSISTENT_FIELD"}', '{"TextFormat":"UNFORMATTED"}', '{"DataLength":"4000"}', '{"AttributeName":"NOTE","Prompt":"Note"}']);
  for (const c of [...patches, ...calls.filter((x) => /_(Create|Cleanup)/.test(x.path))]) assert.equal(c.headers["If-Match"], 'W/"E1"');
  assert.equal(calls.find((c) => label(c) === "POST Approve").body, '{"Lu":"Demo","LuType":"CUSTOM_LU"}');
  assert.equal(calls.find((c) => label(c) === "POST GrantProjections").body, '{"Projections":"PROJECTION_NAME=Demo^","Role":"SALES"}');
  assert.deepEqual(outcome, { name: "Demo", createdLu: true, created: ["NOTE"], skipped: [], mismatches: [], approved: ["NOTE"], published: true, granted: ["SALES"] });
});

test("type PATCHes for Number, Date and DateTime", async () => {
  const { client, calls } = fakeIfs();
  await deployCustomLu(client, { lu: demo([{ name: "QTY", type: "NUMBER" }, { name: "DUE", type: "DATE" }, { name: "STAMP", type: "DATETIME" }]), permissionSetIds: [], uuid: uuid() });
  const byObj = {};
  for (const c of calls.filter((x) => x.method === "PATCH")) (byObj[c.path] = byObj[c.path] || []).push(c.body);
  assert.deepEqual(Object.values(byObj), [
    ['{"CustomAttributeType":"PERSISTENT_FIELD"}', '{"TextFormat":"UNFORMATTED"}', '{"DataType":"NUMBER","Indexed":false}', '{"AttributeName":"QTY","Prompt":"Qty"}'],
    ['{"CustomAttributeType":"PERSISTENT_FIELD"}', '{"TextFormat":"UNFORMATTED"}', '{"DataType":"DATE","Indexed":false}', '{"DateFormat":"DATE"}', '{"AttributeName":"DUE","Prompt":"Due"}'],
    ['{"CustomAttributeType":"PERSISTENT_FIELD"}', '{"TextFormat":"UNFORMATTED"}', '{"DataType":"DATE","Indexed":false}', '{"DateFormat":"DATETIME"}', '{"AttributeName":"STAMP","Prompt":"Stamp"}']
  ]);
});

test("ApproveAttribute $batch body matches the captured web-client request", () => {
  const { boundary, text } = approveAttributesBatch("CustomPageName", ["CUSTOMATTRNAME"], uuid());
  assert.equal(boundary, "u1");
  assert.equal(text,
    "--u1\r\nContent-Type: multipart/mixed;boundary=u2\r\n\r\n--u2\r\nContent-Type: application/http\r\nContent-Transfer-Encoding:binary\r\nContent-Id: 1\r\n\r\n" +
    "POST ApproveAttribute HTTP/1.1\r\nAccept:application/json;odata.metadata=full;IEEE754Compatible=true\r\nContent-Type: application/json;IEEE754Compatible=true\r\n\r\n" +
    '{"Lu":"CustomPageName","LuType":"CUSTOM_LU","AttributeName":"CUSTOMATTRNAME"}\r\n\r\n--u2--\r\n--u1--\r\n');
});

test("one $batch approves several attributes with numbered parts", () => {
  const { text } = approveAttributesBatch("Lu", ["A", "B"], uuid());
  assert.equal((text.match(/POST ApproveAttribute/g) || []).length, 2);
  assert.match(text, /Content-Id: 2\r\n/);
});

test("checkBatchResponse: ok, no status, failing part with IFS message", () => {
  checkBatchResponse(BATCH_OK);
  assert.throws(() => checkBatchResponse("garbage"), /no part status/);
  const failing = "--b\r\nHTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\n\r\n{\"error\":{\"code\":\"X\",\"message\":\"m\",\"details\":[{\"message\":\"ORA-1: nope\"}]}}\r\n--b--";
  assert.throws(() => checkBatchResponse(failing), (err) => /\(400\)/.test(err.message) && JSON.parse(err.body).error.details[0].message === "ORA-1: nope");
});

test("a failing part inside a 200 $batch fails the approve step with the IFS text", async () => {
  const failing = "--b\r\nHTTP/1.1 400 Bad Request\r\n\r\n{\"error\":{\"details\":[{\"message\":\"ORA-2: cannot approve\"}]}}\r\n--b--";
  const { client, calls } = fakeIfs({ override: (c) => (c.path.endsWith("/$batch") ? res(200, failing) : null) });
  await assert.rejects(deployCustomLu(client, { lu: demo([{ name: "A", type: "NUMBER" }]), permissionSetIds: [], uuid: uuid() }), /^Error: Approve attributes failed — ORA-2: cannot approve$/);
  assert.equal(calls.some((c) => c.path.endsWith("/Approve")), false);
});

test("IFS rejecting an attribute name stops before creating a draft", async () => {
  const { client, calls } = fakeIfs({ override: (c) => (c.path.includes("ValidateAttributeName(") ? res(200, { value: "The value of [Name] is invalid. First letter should be an uppercase alpha character" }) : null) });
  await assert.rejects(deployCustomLu(client, { lu: demo([{ name: "A", type: "NUMBER" }]), permissionSetIds: [], uuid: uuid() }), /^Error: Attribute A: validate name failed — The value of \[Name\] is invalid/);
  assert.equal(calls.some((c) => c.path.endsWith("/CustomAttributesVirtuals")), false);
});

test("a failing PATCH still cleans up the draft and reports the PATCH error", async () => {
  const { client, calls } = fakeIfs({ override: (c) => (c.method === "PATCH" && c.body.includes("TextFormat") ? res(400, { error: { message: "bad format" } }) : null) });
  await assert.rejects(deployCustomLu(client, { lu: demo([{ name: "A", type: "NUMBER" }]), permissionSetIds: [], uuid: uuid() }), /^Error: Attribute A: set TextFormat failed — bad format$/);
  assert.ok(calls.some((c) => c.path.endsWith("_CleanupVirtualEntity")));
  assert.equal(calls.some((c) => c.path.endsWith("_CreateCustomAttributes")), false);
});

test("a failing cleanup after a failure does not hide the original error", async () => {
  const { client } = fakeIfs({ override: (c) => {
    if (c.method === "PATCH") return res(400, { error: { message: "first" } });
    if (c.path.endsWith("_CleanupVirtualEntity")) return res(500, { error: { message: "cleanup" } });
    return null;
  } });
  await assert.rejects(deployCustomLu(client, { lu: demo([{ name: "A", type: "NUMBER" }]), permissionSetIds: [], uuid: uuid() }), /set CustomAttributeType failed — first$/);
});

test("Approve LU error shows the ORA text verbatim", async () => {
  const body = { error: { code: "DATABASE_ERROR", message: "Database error occurred. Contact administrator.", details: [{ code: 20105, message: "ORA-20105: CustomLus.CFLU_NO_PERS_APPROV: There must be at least one persistent attribute in order to approve \"Demo\"." }] } };
  const { client } = fakeIfs({ override: (c) => (c.path.endsWith("/Approve") ? res(500, body) : null) });
  await assert.rejects(deployCustomLu(client, { lu: demo([{ name: "A", type: "NUMBER" }]), permissionSetIds: [], uuid: uuid() }),
    /^Error: Approve LU failed — ORA-20105: CustomLus\.CFLU_NO_PERS_APPROV: There must be at least one persistent attribute in order to approve "Demo"\.$/);
});

test("existing LU: skips LU creation and existing attributes, warns on mismatch, approves leftovers", async () => {
  const { client, calls } = fakeIfs({ existingLu: true, existingAttributes: [
    { AttributeName: "NOTE", DataType: "STRING", DataLength: "100", Published: true },
    { AttributeName: "QTY", DataType: "STRING", DataLength: "100", Published: false }
  ] });
  const outcome = await deployCustomLu(client, { lu: demo([{ name: "NOTE", type: "STRING" }, { name: "QTY", type: "NUMBER" }, { name: "DUE", type: "DATE" }]), permissionSetIds: [], uuid: uuid() });
  assert.equal(calls.some((c) => c.path.includes("ValidateLu(") || c.path.includes("select-fields=")), false);
  assert.deepEqual(outcome.created, ["DUE"]);
  assert.deepEqual(outcome.skipped, ["NOTE", "QTY"]);
  assert.deepEqual(outcome.mismatches.map((m) => m.name), ["QTY"]);
  assert.deepEqual(outcome.approved, ["DUE", "QTY"]);
  assert.equal(outcome.createdLu, false);
  const batch = calls.find((c) => c.path.endsWith("/$batch")).body;
  assert.match(batch, /"AttributeName":"DUE"/);
  assert.match(batch, /"AttributeName":"QTY"/);
});

test("existing LU with nothing new and nothing unapproved only grants", async () => {
  const { client, calls } = fakeIfs({ existingLu: true, existingAttributes: [{ AttributeName: "NOTE", DataType: "STRING", DataLength: "100", Published: true }] });
  const outcome = await deployCustomLu(client, { lu: demo([{ name: "NOTE", type: "STRING" }]), permissionSetIds: ["SALES"], uuid: uuid() });
  assert.deepEqual(calls.map(label), ["GET CustomLusSet(key)", "GET CustomLusSet(key)/CustomFieldAttributesArray", "POST GrantProjections"]);
  assert.equal(outcome.published, false);
});

test("an invalid definition is refused before any IFS call", async () => {
  const { client, calls } = fakeIfs();
  await assert.rejects(deployCustomLu(client, { lu: demo([{ name: "1A", type: "STRING" }]), permissionSetIds: [], uuid: uuid() }), /First letter should be an uppercase alpha character/);
  assert.equal(calls.length, 0);
});

test("deployAll isolates failures per LU", async () => {
  const { client } = fakeIfs({ override: (c) => (c.path.includes("ValidateLu(Lu='Bad')") ? res(500, { error: { message: "nope" } }) : null) });
  const results = await deployAll(client, [normalizeLu({ name: "Bad", attributes: [{ name: "A", type: "NUMBER" }] }), demo([{ name: "B", type: "NUMBER" }])], { permissionSetIds: [], uuid: uuid() });
  assert.deepEqual(results.map((r) => [r.name, r.ok]), [["Bad", false], ["Demo", true]]);
  assert.equal(results[0].error, "Validate LU name failed — nope");
});

test("listCustomLus pages through CustomLusSet and keeps CUSTOM_LU rows", async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ Lu: `Lu${String(i).padStart(3, "0")}`, LuType: "CUSTOM_LU" }));
  const { client, calls } = fakeIfs({ override: (c) => {
    if (!c.path.includes("/CustomLusSet?$select=")) return null;
    return c.path.includes("$skip=0") ? res(200, { value: page1 }) : res(200, { value: [{ Lu: "Zed", LuType: "CUSTOM_LU" }, { Lu: "Other", LuType: "CUSTOM_PAGE" }] });
  } });
  const lus = await listCustomLus(client);
  assert.equal(lus.length, 101);
  assert.equal(lus[100].name, "Zed");
  assert.equal(calls.length, 2);
  assert.match(calls[0].path, /CustomLusSet\?\$select=Lu,LuType,Objgrants,luname,keyref&use-timezone-filter=false&\$skip=0&\$top=100$/);
});

test("getCustomLuDefinition maps IFS attribute rows", async () => {
  const { client } = fakeIfs({ existingLu: true, existingAttributes: [
    { AttributeName: "NOTE", DataType: "STRING", DataLength: "4000", Prompt: "Note", Published: true },
    { AttributeName: "QWE", DataType: "NUMBER", DataLength: null, Prompt: "Qwe", Published: false }
  ] });
  assert.deepEqual(await getCustomLuDefinition(client, "Demo"), {
    name: "Demo", prompt: "Demo LU",
    attributes: [
      { name: "NOTE", prompt: "Note", type: "STRING", length: 4000, published: true },
      { name: "QWE", prompt: "Qwe", type: "NUMBER", published: false }
    ]
  });
});

test("getCustomLuDefinition on a missing LU says so", async () => {
  const { client } = fakeIfs();
  await assert.rejects(getCustomLuDefinition(client, "Demo"), /Custom LU "Demo" was not found on this instance\./);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test lib/custom-lu-deploy.test.js`
Expected: FAIL with `Cannot find module './custom-lu-deploy.js'`.

- [ ] **Step 3: Create `lib/custom-lu-deploy.js`**

```js
(function (global) {
  const req = (path, name) => (typeof require === "function" ? require(path) : global[name]);
  const IfsClient = req("./ifs-client.js", "IfsClient");
  const IfsPermissions = req("./ifs-permissions.js", "IfsPermissions");
  const CustomLuModel = req("./custom-lu-model.js", "CustomLuModel");

  // Captured 2026-10-20 from the IFS web client (two HARs, ifscloud.flowington.com) unless marked
  // UNCONFIRMED. Keep payload key order exactly as captured.
  const EC = "/main/ifsapplications/projection/v1/EntityConfigHandling.svc";
  const LU_TYPE = "CUSTOM_LU";
  const PAGE = 100;
  const CREATE_LU_SELECT = "Lu,LuType,Objgrants,Prompt,Module,UsedDb,PublishedDb,SynchronizedDb,EnabledRowkey,LogicalUnitType,CreateProjectionDb,PackgName,TimestampTzRef,SiteTimeZoneRef,Excluded,RowkeyInEntity,CountAttributes,LuTypeName,HasTranslatableText,HasUnusedData,HasUnusedTable,AddedToPackage,luname,keyref";

  const lit = (value) => encodeURIComponent(String(value).replace(/'/g, "''"));
  const luKey = (lu) => `CustomLusSet(Lu='${lit(lu)}',LuType=IfsApp.EntityConfigHandling.CustomObjectsType'${LU_TYPE}')`;
  const virtualKey = (objkey) => `CustomAttributesVirtuals(Objkey='${lit(objkey)}')`;

  const endpoints = {
    listCustomLus: (skip) => `${EC}/CustomLusSet?$select=Lu,LuType,Objgrants,luname,keyref&use-timezone-filter=false&$skip=${skip}&$top=${PAGE}`,
    getCustomLu: (lu) => `${EC}/${luKey(lu)}?$select=Lu,LuType,Prompt`,
    customLuAttributes: (lu) => `${EC}/${luKey(lu)}/CustomFieldAttributesArray?$select=AttributeName,DataType,DataLength,Prompt,Published`,
    validateLu: (lu) => `${EC}/ValidateLu(Lu='${lit(lu)}')`,
    createCustomLu: () => `${EC}/CustomLusSet?select-fields=${CREATE_LU_SELECT}`,
    createCustomLuBody: (lu) => ({ Lu: lu.name, Module: "CONFIG", Prompt: lu.prompt, UsedDb: false, SynchronizedDb: false, EnabledRowkey: false, CreateProjectionDb: true, PublishedDb: false }),
    validateAttributeName: (name) => `${EC}/ValidateAttributeName(AttributeName='${lit(name)}')`,
    createAttributeVirtual: () => `${EC}/CustomAttributesVirtuals`,
    createAttributeVirtualBody: (luName) => ({
      Swap: false, Insertable: true, Updatable: true, Queryable: true, EnabledOnReports: false, EnabledOnOutboundMsgs: false,
      Private: false, IsValidName: false, Multiline: false, ClickableHyperlink: false, TempRefTypeOne: false, TempRefTypeTwo: false,
      TempRefTypeThree: false, EnableOk: true, EditMode: false, HasVirtualUpdated: false, HasEnumUpdated: true, Lu: luName,
      LuType: LU_TYPE, DataType: "STRING", DefaultValueType: "NO_DEFAULT_VALUE", DataLength: "100", HasChanged: "FALSE", HasNewItem: "FALSE"
    }),
    cleanDisplayTextVirtual: () => `${EC}/CleanDisplayTextVirtual`,
    attributeVirtual: (objkey) => `${EC}/${virtualKey(objkey)}`,
    createCustomAttributes: (objkey) => `${EC}/${virtualKey(objkey)}/IfsApp.EntityConfigHandling.CustomAttributesVirtual_CreateCustomAttributes`,
    cleanupAttributeVirtual: (objkey) => `${EC}/${virtualKey(objkey)}/IfsApp.EntityConfigHandling.CustomAttributesVirtual_CleanupVirtualEntity`,
    batch: () => `${EC}/$batch`,
    approve: () => `${EC}/Approve`,
    publish: () => `${EC}/Publish`,
    luBody: (luName) => ({ Lu: luName, LuType: LU_TYPE })
  };

  const step = (name, fn) => IfsClient.step(name, fn, { preferIfsMessage: true });
  const fail = (name, message) => Object.assign(new Error(`${name} failed — ${message}`), { step: name });

  /** The virtual PATCHes for one attribute, in the web client's order. */
  function attributePatches(attr) {
    const patches = [{ CustomAttributeType: "PERSISTENT_FIELD" }, { TextFormat: "UNFORMATTED" }];
    if (attr.type === "STRING") patches.push({ DataLength: String(attr.length) });
    // UNCONFIRMED: Number PATCH shape mirrors the captured DATE one; IFS set NumberFormat itself.
    if (attr.type === "NUMBER") patches.push({ DataType: "NUMBER", Indexed: false });
    if (attr.type === "DATE") patches.push({ DataType: "DATE", Indexed: false }, { DateFormat: "DATE" });
    // UNCONFIRMED: DateFormat "DATETIME" is a guess the user approved (2026-10-20); fix after a live run.
    if (attr.type === "DATETIME") patches.push({ DataType: "DATE", Indexed: false }, { DateFormat: "DATETIME" });
    patches.push({ AttributeName: attr.name, Prompt: attr.prompt });
    return patches;
  }

  /** Builds the ApproveAttribute $batch exactly as the web client sends it (one changeset). */
  function approveAttributesBatch(luName, attributeNames, uuid) {
    const batch = uuid();
    const changeset = uuid();
    const parts = attributeNames.map((name, i) => [
      `--${changeset}`, "Content-Type: application/http", "Content-Transfer-Encoding:binary", `Content-Id: ${i + 1}`, "",
      "POST ApproveAttribute HTTP/1.1", "Accept:application/json;odata.metadata=full;IEEE754Compatible=true", "Content-Type: application/json;IEEE754Compatible=true", "",
      JSON.stringify({ Lu: luName, LuType: LU_TYPE, AttributeName: name }), ""
    ].join("\r\n"));
    const text = [`--${batch}`, `Content-Type: multipart/mixed;boundary=${changeset}`, "", ...parts, `--${changeset}--`, `--${batch}--`, ""].join("\r\n");
    return { boundary: batch, text };
  }

  /** A $batch answers 200 even when a part failed; the part's own status line decides. */
  function checkBatchResponse(text) {
    const statuses = [...String(text).matchAll(/HTTP\/1\.1 (\d{3})/g)];
    if (!statuses.length) throw new Error("IFS $batch response had no part status.");
    const bad = statuses.find((m) => Number(m[1]) >= 300);
    if (!bad) return;
    const json = String(text).slice(bad.index).match(/\{[\s\S]*\}/);
    throw Object.assign(new Error(`IFS $batch part failed (${bad[1]})`), json ? { body: json[0] } : {});
  }

  // UNCONFIRMED: a missing LU answers 404 (standard OData; not captured).
  async function findCustomLu(client, name) {
    try {
      return await client.getOData(endpoints.getCustomLu(name));
    } catch (err) {
      if (err.status === 404) return null;
      throw Object.assign(err, { message: `Check for an existing LU failed — ${IfsClient.ifsErrorMessage(err) || err.message}`, step: "Check for an existing LU" });
    }
  }

  async function readAttributes(client, name) {
    const res = await step("Read existing attributes", () => client.getOData(endpoints.customLuAttributes(name)));
    return (res && res.value) || [];
  }

  async function createAttribute(client, luName, attr) {
    const label = `Attribute ${attr.name}`;
    await step(`${label}: validate name`, async () => {
      const answer = await client.getOData(endpoints.validateAttributeName(attr.name));
      if (answer && answer.value) throw new Error(answer.value); // 200 = invalid, the value says why; 204 = valid
    });
    const virtual = await step(`${label}: create draft`, () => client.postOData(endpoints.createAttributeVirtual(), endpoints.createAttributeVirtualBody(luName)));
    if (!virtual || !virtual.Objkey || !virtual["@odata.etag"]) throw fail(`${label}: create draft`, "IFS response did not include an Objkey and @odata.etag.");
    const etag = virtual["@odata.etag"];
    let failure = null;
    try {
      await step(`${label}: prepare draft`, () => client.postOData(endpoints.cleanDisplayTextVirtual(), {}));
      for (const body of attributePatches(attr)) {
        await step(`${label}: set ${Object.keys(body).join(", ")}`, () => client.patchOData(endpoints.attributeVirtual(virtual.Objkey), body, etag));
      }
      await step(`${label}: save`, () => client.postOData(endpoints.createCustomAttributes(virtual.Objkey), {}, etag));
    } catch (err) {
      failure = err;
      throw err;
    } finally {
      try {
        await step(`${label}: clean up draft`, () => client.postOData(endpoints.cleanupAttributeVirtual(virtual.Objkey), {}, etag));
      } catch (cleanupErr) {
        if (!failure) throw cleanupErr; // the original failure is what the user needs to see
      }
    }
  }

  async function deployCustomLu(client, { lu, permissionSetIds, uuid }) {
    const problems = CustomLuModel.validateLu(lu);
    if (problems.length) throw new Error(problems.map((p) => p.message).join(" "));

    const existing = await findCustomLu(client, lu.name);
    if (!existing) {
      await step("Validate LU name", async () => {
        const answer = await client.getOData(endpoints.validateLu(lu.name));
        if (answer && answer.value) throw new Error(answer.value);
      });
      await step("Create LU", () => client.postOData(endpoints.createCustomLu(), endpoints.createCustomLuBody(lu)));
    }

    const rows = existing ? await readAttributes(client, lu.name) : [];
    const diff = CustomLuModel.diffAttributes(lu.attributes, rows);
    for (const attr of diff.toCreate) await createAttribute(client, lu.name, attr);

    const approved = [...diff.toCreate.map((a) => a.name), ...diff.unapproved.filter((n) => !diff.toCreate.some((a) => a.name === n))];
    if (approved.length) {
      await step("Approve attributes", async () => {
        const { boundary, text } = approveAttributesBatch(lu.name, approved, uuid);
        checkBatchResponse(await client.postBatch(endpoints.batch(), boundary, text));
      });
      await step("Approve LU", () => client.postOData(endpoints.approve(), endpoints.luBody(lu.name)));
      await step("Publish LU", () => client.postOData(endpoints.publish(), endpoints.luBody(lu.name)));
    }

    // UNCONFIRMED: the LU's projection is named exactly like the LU (user statement, not traced).
    const granted = [];
    for (const role of permissionSetIds || []) {
      await IfsPermissions.grantProjection(client, lu.name, role);
      granted.push(role);
    }

    return { name: lu.name, createdLu: !existing, created: diff.toCreate.map((a) => a.name), skipped: diff.skipped, mismatches: diff.mismatches, approved, published: approved.length > 0, granted };
  }

  async function deployAll(client, lus, options) {
    const results = [];
    for (const lu of lus) {
      try {
        results.push({ name: lu.name, ok: true, outcome: await deployCustomLu(client, { lu, ...options }) });
      } catch (err) {
        results.push({ name: lu.name, ok: false, error: err.message });
      }
    }
    return results;
  }

  async function listCustomLus(client) {
    const names = [];
    for (let skip = 0; ; skip += PAGE) {
      const res = await step("Load Custom LUs", () => client.getOData(endpoints.listCustomLus(skip)));
      const rows = (res && res.value) || [];
      for (const row of rows) if (row.LuType === LU_TYPE) names.push({ name: row.Lu });
      if (rows.length < PAGE) break;
    }
    return names.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function getCustomLuDefinition(client, name) {
    const lu = await findCustomLu(client, name);
    if (!lu) throw new Error(`Custom LU "${name}" was not found on this instance.`);
    const rows = await readAttributes(client, name);
    return {
      name,
      prompt: lu.Prompt || name,
      attributes: rows.map((r) => {
        const attr = { name: r.AttributeName, prompt: r.Prompt || "", type: r.DataType };
        if (r.DataType === "STRING" && r.DataLength != null) attr.length = Number(r.DataLength);
        attr.published = !!r.Published;
        return attr;
      })
    };
  }

  const api = { deployCustomLu, deployAll, listCustomLus, getCustomLuDefinition, approveAttributesBatch, checkBatchResponse, attributePatches, endpoints };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.CustomLuDeploy = api;
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run the test**

Run: `node --test lib/custom-lu-deploy.test.js`
Expected: PASS (17 tests). If a sequence assertion fails, fix the implementation, never the captured strings in the test.

- [ ] **Step 5: Wire the script**

`background.js` importScripts: add `"lib/custom-lu-deploy.js",` directly after `"lib/custom-lu-model.js",`. `manifest.test.js`: add `"lib/custom-lu-deploy.js"` to the required list and `assert.ok(at("lib/custom-lu-model.js") < at("lib/custom-lu-deploy.js"));` to the order test.

- [ ] **Step 6: Run the whole suite, then commit**

Run: `npm test` — Expected: PASS, 570 tests.

```bash
git add lib/custom-lu-deploy.js lib/custom-lu-deploy.test.js background.js manifest.test.js
git commit -m "feat: Custom LU deploy sequence from the captured EntityConfigHandling calls

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Flow Connect properties import

**Files:**
- Create: `lib/flow-properties.js`, `lib/flow-properties.test.js`

**Interfaces:**
- Consumes: `CustomLuModel.DEFAULT_LENGTH` (Task 3).
- Produces (`FlowProperties`): `parseConnectProperties(text)` → `[{ source, name, prompt, attributes: [{ name, prompt, type: "STRING", length: 100 }] }]`; `columnToAttributeName(column)`.

Flow Classic User properties are **not** in this task (blocked on the user's sample, spec §8); they get their own plan once the sample exists.

- [ ] **Step 1: Write the failing test** — `lib/flow-properties.test.js` (synthetic fixture, no real export)

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseConnectProperties, columnToAttributeName } = require("./flow-properties.js");

const sample = [
  { Name: "SOME_PATH", Type: "Text", Scope: "Global", Value: "\\\\server\\share" },
  { Name: "IntegCredentials", Type: "Table", Scope: "Global", Columns: ["Integration", "UserName", "API Endpoint"], TableValues: "[{'Integration': 'X', 'UserName': 'u', 'API Endpoint': 'https://example.com'}]" },
  { Name: "EmptyTable", Type: "Table", Scope: "Global", Columns: [], TableValues: "[]" },
  { Name: "NoColumns", Type: "Table", Scope: "Global" },
  null
];

test("Table properties become String-attribute LUs; TableValues is never used", () => {
  const lus = parseConnectProperties(JSON.stringify(sample));
  assert.deepEqual(lus, [{
    source: "IntegCredentials",
    name: "IntegCredentials",
    prompt: "IntegCredentials",
    attributes: [
      { name: "INTEGRATION", prompt: "Integration", type: "STRING", length: 100 },
      { name: "USERNAME", prompt: "UserName", type: "STRING", length: 100 },
      { name: "API_ENDPOINT", prompt: "API Endpoint", type: "STRING", length: 100 }
    ]
  }]);
  assert.equal(JSON.stringify(lus).includes("example.com"), false);
});

test("a UTF-8 BOM is accepted", () => {
  assert.equal(parseConnectProperties("\uFEFF" + JSON.stringify(sample)).length, 1);
});

test("columnToAttributeName makes IFS-safe names", () => {
  assert.equal(columnToAttributeName(" API Endpoint "), "API_ENDPOINT");
  assert.equal(columnToAttributeName("a-b.c"), "A_B_C");
  assert.equal(columnToAttributeName("__x__"), "X");
});

test("bad input gives a plain error, never an empty list", () => {
  assert.throws(() => parseConnectProperties("{nope"), /^Error: File is not valid JSON\.$/);
  assert.throws(() => parseConnectProperties('{"Name":"x"}'), /^Error: Expected a JSON array of Flow properties\.$/);
  assert.throws(() => parseConnectProperties(JSON.stringify([{ Name: "t", Type: "Text" }])), /^Error: No Table-type properties found in this file\.$/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test lib/flow-properties.test.js`
Expected: FAIL with `Cannot find module './flow-properties.js'`.

- [ ] **Step 3: Create `lib/flow-properties.js`**

```js
(function (global) {
  const req = (path, name) => (typeof require === "function" ? require(path) : global[name]);
  const CustomLuModel = req("./custom-lu-model.js", "CustomLuModel");

  /** Column header → IFS attribute name: upper case, anything but A-Z/0-9/_ becomes "_". */
  function columnToAttributeName(column) {
    return String(column).trim().toUpperCase().replace(/[^A-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  }

  /** Flow Connect properties export (array of {Name, Type, Scope, Columns?, TableValues?, Value?})
   *  → one LU definition per Table property. Only the shape is imported: TableValues (row data,
   *  can hold passwords) is never read. */
  function parseConnectProperties(text) {
    let data;
    try {
      data = JSON.parse(String(text).replace(/^\uFEFF/, ""));
    } catch {
      throw new Error("File is not valid JSON.");
    }
    if (!Array.isArray(data)) throw new Error("Expected a JSON array of Flow properties.");
    const lus = [];
    for (const row of data) {
      if (!row || typeof row !== "object" || row.Type !== "Table") continue;
      if (typeof row.Name !== "string" || !Array.isArray(row.Columns)) continue;
      const columns = row.Columns.filter((c) => typeof c === "string" && c.trim());
      if (!columns.length) continue;
      const name = row.Name.trim();
      lus.push({
        source: row.Name,
        name,
        prompt: name,
        attributes: columns.map((c) => ({ name: columnToAttributeName(c), prompt: c.trim(), type: "STRING", length: CustomLuModel.DEFAULT_LENGTH }))
      });
    }
    if (!lus.length) throw new Error("No Table-type properties found in this file.");
    return lus;
  }

  const api = { parseConnectProperties, columnToAttributeName };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.FlowProperties = api;
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run the whole suite, then commit**

Run: `npm test` — Expected: PASS, 574 tests.

```bash
git add lib/flow-properties.js lib/flow-properties.test.js
git commit -m "feat: import Flow Connect Table properties as Custom LU definitions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Background service and messages

**Files:**
- Create: `lib/cl-service.js`, `lib/cl-service.test.js`
- Modify: `lib/qr-history.js`, `lib/qr-history.test.js`, `background.js`, `panels/qr-deploy-form.js` (message rename), `manifest.test.js`

**Interfaces:**
- Consumes: `IfsClient.forInstance` (Task 1), `ClLibrary.createClLibrary` (Task 2), `CustomLuModel.normalizeLu/validateLu` (Task 3), `CustomLuDeploy.deployAll/listCustomLus/getCustomLuDefinition` (Task 4).
- Produces:
  - `QrHistory` instance gains `rememberPermissionSets(instanceKey, ids)`.
  - `ClService.createClService({ instanceStore, settings, history, fetchImpl, uuid })` → `{ listLibrary(masterKey), createInLibrary(masterKey, lu), listEnvironment(baseUrl, masterKey), getEnvironmentLu(baseUrl, masterKey, name), deploy(masterKey, { baseUrl, lus, permissionSetIds }) }`.
  - Messages (all answer `{ ok: false, error, needsMasterPassword }` on failure, via the existing router catch):
    - `PERMISSION_SETS {baseUrl}` → `{ ok, sets, remembered }` (renamed from `QR_PERMISSION_SETS`)
    - `CL_LIBRARY` → `{ ok, lus }`
    - `CL_CREATE {lu}` → `{ ok, lu }`
    - `CL_ENV_LIST {baseUrl}` → `{ ok, lus: [{name}] }`
    - `CL_ENV_GET {baseUrl, name}` → `{ ok, lu }`
    - `CL_DEPLOY {baseUrl, lus, permissionSetIds}` → `{ ok, results }`

- [ ] **Step 1: Write the failing tests**

Append to `lib/qr-history.test.js`:

```js
test("rememberPermissionSets updates the shared memory without a deployment", async () => {
  const data = {};
  const storage = { get: async (k) => ({ [k]: data[k] }), set: async (o) => { Object.assign(data, o); } };
  const history = require("./qr-history.js").createQrHistory(storage);
  await history.rememberPermissionSets("https://ifs.example.com", ["SALES", "HR"]);
  assert.deepEqual(await history.getPermissionSetMemory("https://ifs.example.com"), ["SALES", "HR"]);
  assert.deepEqual(await history.listAll(), []);
});
```

Create `lib/cl-service.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { createQrHistory } = require("./qr-history.js");
const { createClService } = require("./cl-service.js");

const IFS = "https://ifs.example.com";
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body ?? "")) });

function setup({ ifs } = {}) {
  const data = {};
  const storage = { get: async (k) => ({ [k]: data[k] }), set: async (o) => { Object.assign(data, o); } };
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ host: u.host, method: init.method || "GET", path: decodeURIComponent(u.pathname) + u.search });
    if (u.host === "api.github.com") {
      if (u.pathname === "/repos/team/qr-data") return res(200, { default_branch: "main" });
      if (u.pathname.startsWith("/repos/team/qr-data/git/trees/")) return res(200, { tree: [] });
      if (init.method === "PUT") return res(201, { content: { sha: "s" } });
    }
    if (u.host === "ifs.example.com" && ifs) return ifs(init.method || "GET", decodeURIComponent(u.pathname) + u.search);
    throw new Error(`unexpected ${init.method} ${url}`);
  };
  const service = createClService({
    instanceStore: { getIfsAuthToken: async () => "T", clearIfsAuthToken: () => {} },
    settings: { getToken: async () => "gh", get: async () => ({ repo: "team/qr-data", login: "alice" }) },
    history: createQrHistory(storage),
    fetchImpl,
    uuid: () => "b"
  });
  return { service, calls, history: createQrHistory(storage) };
}

test("createInLibrary normalizes and saves under my login", async () => {
  const { service, calls } = setup();
  const saved = await service.createInLibrary("K", { name: " Demo ", attributes: [{ name: "note", type: "STRING" }] });
  assert.deepEqual(saved, { id: "demo", name: "Demo", prompt: "Demo", attributes: [{ name: "NOTE", prompt: "Note", type: "STRING", length: 100 }] });
  assert.ok(calls.some((c) => c.method === "PUT" && c.path === "/repos/team/qr-data/contents/custom-lus/alice/demo.json"));
});

test("createInLibrary refuses an invalid LU before calling GitHub", async () => {
  const { service, calls } = setup();
  await assert.rejects(service.createInLibrary("K", { name: "My LU", attributes: [{ name: "A", type: "STRING" }] }), /LU name: letters, digits and _ only/);
  assert.equal(calls.length, 0);
});

test("deploy remembers permission sets only when an LU deployed", async () => {
  const ok = (m, p) => {
    if (m === "GET" && p.includes("?$select=Lu,LuType,Prompt")) return res(404, {});
    if (m === "GET") return res(204);
    if (p.endsWith("/CustomAttributesVirtuals")) return res(201, { Objkey: "O", "@odata.etag": "E" });
    if (p.endsWith("/$batch")) return res(200, "HTTP/1.1 204 No Content");
    return res(204);
  };
  const good = setup({ ifs: ok });
  const results = await good.service.deploy("K", { baseUrl: IFS + "/main", lus: [{ name: "Demo", attributes: [{ name: "a", type: "NUMBER" }] }], permissionSetIds: ["SALES"] });
  assert.deepEqual(results.map((r) => r.ok), [true]);
  assert.deepEqual(await good.history.getPermissionSetMemory(IFS), ["SALES"]);

  const bad = setup({ ifs: () => res(500, { error: { message: "down" } }) });
  const failed = await bad.service.deploy("K", { baseUrl: IFS, lus: [{ name: "Demo", attributes: [{ name: "A", type: "NUMBER" }] }], permissionSetIds: ["SALES"] });
  assert.equal(failed[0].ok, false);
  assert.deepEqual(await bad.history.getPermissionSetMemory(IFS), []);
});

test("listEnvironment and getEnvironmentLu read the instance", async () => {
  const { service } = setup({ ifs: (m, p) => {
    if (p.includes("/CustomLusSet?$select=")) return res(200, { value: [{ Lu: "Demo", LuType: "CUSTOM_LU" }] });
    if (p.includes("?$select=Lu,LuType,Prompt")) return res(200, { Lu: "Demo", Prompt: "Demo" });
    if (p.includes("/CustomFieldAttributesArray")) return res(200, { value: [{ AttributeName: "A", DataType: "NUMBER", Prompt: "A", Published: true }] });
    throw new Error(p);
  } });
  assert.deepEqual(await service.listEnvironment(IFS, "K"), [{ name: "Demo" }]);
  assert.equal((await service.getEnvironmentLu(IFS, "K", "Demo")).attributes[0].type, "NUMBER");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test lib/cl-service.test.js lib/qr-history.test.js`
Expected: FAIL — `Cannot find module './cl-service.js'` and `history.rememberPermissionSets is not a function`.

- [ ] **Step 3: Add `rememberPermissionSets` to `lib/qr-history.js`**

Inside `createQrHistory`, after `getPermissionSetMemory`, add:
```js
    /** Permission-set memory is shared by Quick Reports and Custom LUs (one picker, one memory). */
    async function rememberPermissionSets(instanceKey, permissionSetIds) {
      const memory = await read(MEMORY_KEY, {});
      memory[instanceKey] = [...permissionSetIds];
      await storage.set({ [MEMORY_KEY]: memory });
    }
```
and change the return line to:
```js
    return { record, latestFor, listForReport, listForInstance, listAll, getPermissionSetMemory, rememberPermissionSets };
```

- [ ] **Step 4: Create `lib/cl-service.js`**

```js
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

      async deploy(masterKey, { baseUrl, lus, permissionSetIds }) {
        const ids = permissionSetIds || [];
        const results = await CustomLuDeploy.deployAll(client(baseUrl, masterKey), (lus || []).map(CustomLuModel.normalizeLu), { permissionSetIds: ids, uuid: newId });
        if (results.some((r) => r.ok)) await history.rememberPermissionSets(instanceKey(baseUrl), ids);
        return results;
      }
    };
  }

  const api = { createClService };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.ClService = api;
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 5: Run the tests**

Run: `node --test lib/cl-service.test.js lib/qr-history.test.js`
Expected: PASS.

- [ ] **Step 6: Wire the background worker**

1. importScripts: add `"lib/cl-service.js",` directly after `"lib/qr-service.js",`.
2. Replace
```js
const qrService = QrService.createQrService({
  instanceStore,
  settings: GithubSettings.createGithubSettings(chrome.storage.local),
  history: QrHistory.createQrHistory(chrome.storage.local),
  cacheStorage: chrome.storage.local
});
```
with
```js
const githubSettings = GithubSettings.createGithubSettings(chrome.storage.local);
const qrHistory = QrHistory.createQrHistory(chrome.storage.local);
const qrService = QrService.createQrService({ instanceStore, settings: githubSettings, history: qrHistory, cacheStorage: chrome.storage.local });
const clService = ClService.createClService({ instanceStore, settings: githubSettings, history: qrHistory });
```
3. In the message switch, replace `case "QR_PERMISSION_SETS":` with `case "PERMISSION_SETS":` (same body), and add after the `QR_HISTORY` case:
```js
        case "CL_LIBRARY":
          return sendResponse({ ok: true, lus: await clService.listLibrary(await masterKey()) });
        case "CL_CREATE":
          return sendResponse({ ok: true, lu: await clService.createInLibrary(await masterKey(), message.lu) });
        case "CL_ENV_LIST":
          return sendResponse({ ok: true, lus: await clService.listEnvironment(message.baseUrl, await masterKey()) });
        case "CL_ENV_GET":
          return sendResponse({ ok: true, lu: await clService.getEnvironmentLu(message.baseUrl, await masterKey(), message.name) });
        case "CL_DEPLOY":
          return sendResponse({ ok: true, results: await clService.deploy(await masterKey(), message) });
```
4. `panels/qr-deploy-form.js`: change `type: "QR_PERMISSION_SETS"` to `type: "PERMISSION_SETS"`.
5. Verify nothing else uses the old name: `git grep -n QR_PERMISSION_SETS -- ':!firefox'` → no output.
6. `manifest.test.js`: add `"lib/cl-service.js"` to the required list, and to the order test:
```js
  for (const dep of ["lib/ifs-client.js", "lib/cl-library.js", "lib/custom-lu-model.js", "lib/custom-lu-deploy.js"]) assert.ok(at(dep) < at("lib/cl-service.js"), dep);
```

- [ ] **Step 7: Run the whole suite, then commit**

Run: `npm test` — Expected: PASS, 579 tests.

```bash
git add lib/cl-service.js lib/cl-service.test.js lib/qr-history.js lib/qr-history.test.js background.js panels/qr-deploy-form.js manifest.test.js
git commit -m "feat: Custom LU background service and CL_* messages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Shared permission picker + Custom LU deploy form

**Files:**
- Create: `panels/permission-picker.js`, `panels/cl-deploy-form.js`
- Modify: `panels/common.js`, `panels/qr-deploy-form.js`, `sidepanel.html`, `qr-editor.html`, `sidepanel.css`, `manifest.test.js`

**Interfaces:**
- Consumes: messages `LIST_INSTANCES`, `PERMISSION_SETS`, `CL_DEPLOY`, `GET_DESIGNER_STATUS` (Task 6 / existing); `createAndActivateModule`, `designerBlockReason`, `showError` (`panels/common.js`).
- Produces:
  - `explainLocked(response)` in `panels/common.js` → user text for a failed response.
  - `renderPermissionPicker(container, { send, onError, emptySetsText, onChange })` → `{ baseUrl() → string, selectedIds() → string[], instanceLabel(baseUrl) → string }`; `onChange(ready: boolean)` fires on every instance change (false first, true once sets loaded).
  - `renderClDeployForm(container, getLus, { send, onError, onClose? })`; `getLus()` returns normalized LU definitions or `null` (it reports why itself).

No DOM test harness exists in this repo; these files are checked by the static script-tag test plus the manual check in Step 6.

- [ ] **Step 1: Make `panels/common.js` safe on pages without the side panel's unlock UI, add `explainLocked`**

`cl-editor.html` (Task 8) loads `common.js` and its Module button calls `createAndActivateModule`, which reads `#unlockPassword`/`#masterPassword`; a `needsMasterPassword` answer calls `refreshLockStatus`, which writes `#unlockRow`/`#lockStatus`. None of these exist on the editor page, so both would throw. Fix:

Replace
```js
const masterPasswordOf = () =>
  document.getElementById("unlockPassword").value || document.getElementById("masterPassword").value;
```
with
```js
const fieldValue = (id) => { const el = document.getElementById(id); return el ? el.value : ""; };
const masterPasswordOf = () => fieldValue("unlockPassword") || fieldValue("masterPassword");
```
and make the first line inside `async function refreshLockStatus() {`:
```js
  if (!document.getElementById("unlockRow")) return; // pages without the unlock UI (editor tabs)
```
Then append at the end of the file:

```js
/** The text for a failed background response; a locked credential store gets the unlock hint. */
function explainLocked(response) {
  return response.needsMasterPassword
    ? "Saved credentials are locked — unlock them in the NovacuraBuddy side panel, then try again."
    : response.error;
}
```

- [ ] **Step 2: Create `panels/permission-picker.js`** (logic moved from `qr-deploy-form.js`)

```js
/** Instance select + permission-set checklist, shared by the Quick Report and Custom LU deploy
 *  forms. Instances come from Basic Data; ticks are pre-set from the per-instance memory. */
function renderPermissionPicker(container, { send, onError, emptySetsText, onChange }) {
  const select = document.createElement("select");
  const sets = document.createElement("div");
  sets.className = "checklist";
  container.append(select, sets);

  (async () => {
    const response = await send({ type: "LIST_INSTANCES" });
    if (!response.ok) return onError(response.error);
    const instances = response.instances.slice().sort((a, b) => a.name.localeCompare(b.name));
    if (!instances.length) {
      sets.textContent = "No IFS instances yet — add one in Basic Data.";
      select.hidden = true;
      return;
    }
    select.append(new Option("Choose an IFS instance…", ""));
    for (const instance of instances) select.append(new Option(instance.name, instance.baseUrl));
  })();

  let selectToken = 0; // bumped on every change so a slow response for a previous instance is ignored
  select.onchange = async () => {
    const token = ++selectToken;
    onChange(false);
    sets.textContent = "";
    if (!select.value) return;
    sets.textContent = "Loading permission sets…";
    const response = await send({ type: "PERMISSION_SETS", baseUrl: select.value, masterPassword: "" });
    if (token !== selectToken) return;
    sets.textContent = "";
    if (!response.ok) return onError(explainLocked(response));
    const remembered = new Set(response.remembered);
    if (!response.sets.length) sets.textContent = emptySetsText;
    for (const ps of response.sets) {
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = ps.id;
      box.checked = remembered.has(ps.id);
      label.append(box, document.createTextNode(` ${ps.name}`));
      sets.appendChild(label);
    }
    onChange(true);
  };

  return {
    baseUrl: () => select.value,
    selectedIds: () => [...sets.querySelectorAll("input:checked")].map((b) => b.value),
    instanceLabel: (baseUrl) => {
      const option = [...select.options].find((o) => o.value === baseUrl);
      return option ? option.text : baseUrl;
    }
  };
}
```

- [ ] **Step 3: Make `panels/qr-deploy-form.js` use the picker**

In `renderDeployForm`:
1. Delete the `const select = …;`, `const sets = …;`, `sets.className = "checklist";` lines, the whole `(async () => { const response = await send({ type: "LIST_INSTANCES" }); … })();` block, the `let selectToken = 0;` line, the `const instanceLabel = …` function, the whole `select.onchange = async () => { … };` block, and the local `function explain(response) { … }`.
2. Replace `container.append(select, sets, actions);` with:
```js
  const picker = renderPermissionPicker(container, {
    send,
    onError,
    emptySetsText: "No customer permission sets on this instance — the report deploys without grants.",
    onChange: (ready) => {
      removeConfirmBox();
      removeSuccessBox();
      deployBtn.disabled = !ready;
    }
  });
  container.append(actions);
```
   Move this block **below** the definitions of `removeConfirmBox` and `removeSuccessBox` (they must exist before `onChange` can fire — it only fires on user change, but keep definitions first for readability).
3. In `showDeployed`, replace `instanceLabel(baseUrl)` with `picker.instanceLabel(baseUrl)`; in `deploy()` replace `select.value` with `picker.baseUrl()`, `[...sets.querySelectorAll("input:checked")].map((b) => b.value)` with `picker.selectedIds()`, every `explain(response)` with `explainLocked(response)`, and in the `onDeployed` call `instanceLabel(baseUrl)` with `picker.instanceLabel(baseUrl)`.
4. Update the header comment's first line to: `/** Instance → permission sets (shared picker) → Deploy, shared by the Quick Reports tab and the editor page.`

- [ ] **Step 4: Create `panels/cl-deploy-form.js`**

```js
/** Instance → permission sets → Deploy for Custom LUs, used by the editor page and the side panel.
 *  Shows one result line per LU (green = deployed, red = the IFS error verbatim) with a Module
 *  button that creates the Flow module through the shared createAndActivateModule. */
function renderClDeployForm(container, getLus, { send, onError, onClose }) {
  container.innerHTML = "";
  container.classList.add("deploy-form");

  const actions = document.createElement("div");
  actions.className = "deploy-actions";
  const deployBtn = document.createElement("button");
  deployBtn.className = "btn-primary";
  deployBtn.textContent = "Deploy";
  deployBtn.disabled = true;
  actions.appendChild(deployBtn);
  if (onClose) {
    const closeBtn = document.createElement("button");
    closeBtn.className = "btn-ghost";
    closeBtn.textContent = "Close";
    closeBtn.onclick = onClose;
    actions.appendChild(closeBtn);
  }
  const results = document.createElement("ul");
  results.className = "cl-results";

  const picker = renderPermissionPicker(container, {
    send,
    onError,
    emptySetsText: "No customer permission sets on this instance — the LU deploys without grants.",
    onChange: (ready) => { deployBtn.disabled = !ready; results.innerHTML = ""; }
  });
  container.append(actions, results);

  function summary(outcome) {
    const parts = [];
    parts.push(outcome.createdLu ? "LU created" : "LU existed");
    parts.push(outcome.created.length ? `${outcome.created.length} attribute(s) added` : "no new attributes");
    if (outcome.published) parts.push("approved & published");
    if (outcome.granted.length) parts.push(`granted to ${outcome.granted.join(", ")}`);
    return parts.join(" · ");
  }

  async function createModule(baseUrl, name, btn) {
    const designer = await send({ type: "GET_DESIGNER_STATUS" });
    const blocked = designer && designer.ok !== false ? designerBlockReason(designer) : "";
    if (blocked) return onError(blocked);
    btn.disabled = true;
    btn.textContent = "Creating & activating…";
    const response = await createAndActivateModule(baseUrl, name);
    btn.disabled = false;
    btn.textContent = "Module";
    if (response) btn.insertAdjacentText("afterend", ` ✓ Module ${name} created & activated in the open flow.`);
  }

  function renderResults(list, baseUrl) {
    results.innerHTML = "";
    for (const r of list) {
      const li = document.createElement("li");
      if (r.ok) {
        li.className = "banner banner-deployed";
        li.setAttribute("role", "status");
        li.textContent = `✓ ${r.name} on ${picker.instanceLabel(baseUrl)} — ${summary(r.outcome)}.`;
        for (const m of r.outcome.mismatches) {
          const warn = document.createElement("div");
          warn.className = "cl-warning";
          warn.textContent = `⚠ ${m.message}`;
          li.appendChild(warn);
        }
        const moduleBtn = document.createElement("button");
        moduleBtn.textContent = "Module";
        moduleBtn.onclick = () => createModule(baseUrl, r.name, moduleBtn);
        li.appendChild(moduleBtn);
      } else {
        li.className = "banner banner-error";
        li.setAttribute("role", "alert");
        li.textContent = `✗ ${r.name} — ${r.error}`;
      }
      results.appendChild(li);
    }
  }

  deployBtn.onclick = async () => {
    const lus = getLus();
    if (!lus) return;
    const baseUrl = picker.baseUrl();
    const origin = new URL(baseUrl).origin;
    // Must run inside the click's user gesture, before any other await.
    const granted = await new Promise((resolve) => chrome.permissions.request({ origins: [origin + "/*"] }, resolve));
    if (!granted) return onError(`Permission for ${origin} was not granted — can't deploy there.`);
    results.innerHTML = "";
    deployBtn.disabled = true;
    deployBtn.textContent = "Deploying…";
    const response = await send({ type: "CL_DEPLOY", baseUrl, lus, permissionSetIds: picker.selectedIds(), masterPassword: "" });
    deployBtn.disabled = false;
    deployBtn.textContent = "Deploy";
    if (!response.ok) return onError(explainLocked(response));
    renderResults(response.results, baseUrl);
  };
}
```

- [ ] **Step 5: Script tags and CSS**

`sidepanel.html` and `qr-editor.html`: insert `<script src="panels/permission-picker.js"></script>` directly before `<script src="panels/qr-deploy-form.js"></script>`. In `sidepanel.html` also add `<script src="panels/cl-deploy-form.js"></script>` directly after `panels/qr-deploy-form.js`.

`sidepanel.css`: append
```css
.cl-results { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.cl-results li { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
.cl-warning { font-weight: 400; color: var(--ink); }
```

`manifest.test.js`: add
```js
test("pages load the shared picker before the forms that use it", () => {
  for (const page of ["sidepanel.html", "qr-editor.html"]) {
    const html = fs.readFileSync(path.join(__dirname, page), "utf8");
    const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(srcs.indexOf("panels/common.js") < srcs.indexOf("panels/permission-picker.js"), page);
    assert.ok(srcs.indexOf("panels/permission-picker.js") < srcs.indexOf("panels/qr-deploy-form.js"), page);
  }
});
```

- [ ] **Step 6: Run the suite and check Quick Reports by hand**

Run: `npm test` — Expected: PASS, 580 tests.

Manual (load unpacked from the repo folder in `chrome://extensions`, reload): Quick Reports tab → Deploy on a report → instance list appears, picking an instance loads permission sets with remembered ticks, Close works. The editor page (`Edit`) shows the same deploy form. Note the result in the commit body if anything differs.

- [ ] **Step 7: Commit**

```bash
git add panels/common.js panels/permission-picker.js panels/qr-deploy-form.js panels/cl-deploy-form.js sidepanel.html qr-editor.html sidepanel.css manifest.test.js
git commit -m "feat: shared permission picker and Custom LU deploy form

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Editor page (`cl-editor.html`)

**Files:**
- Create: `cl-editor.html`, `cl-editor.js`, `cl-editor.css`
- Modify: `manifest.test.js`

**Interfaces:**
- Consumes: `CustomLuModel` (Task 3), `FlowProperties` (Task 5), `renderClDeployForm` (Task 7), messages `CL_LIBRARY`, `CL_CREATE`, `CL_ENV_GET` (Task 6), `send/showError/showNotice/explainLocked` (`panels/common.js`).
- Produces: page URL contract used by Task 9:
  - `cl-editor.html?mode=new`
  - `cl-editor.html?mode=library&id=<slug>`
  - `cl-editor.html?mode=existing&baseUrl=<encoded>&lu=<name>`
  - `cl-editor.html?mode=import`

- [ ] **Step 1: Extend the static page test (fails first)**

In `manifest.test.js`, change the page list in "every <script src> in the extension pages exists" to `["sidepanel.html", "qr-editor.html", "cl-editor.html"]`, and add:
```js
test("the Custom LU editor loads its libraries before cl-editor.js", () => {
  const html = fs.readFileSync(path.join(__dirname, "cl-editor.html"), "utf8");
  const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  const order = ["lib/custom-lu-model.js", "lib/flow-properties.js", "panels/common.js", "panels/permission-picker.js", "panels/cl-deploy-form.js", "cl-editor.js"];
  assert.deepEqual(srcs.filter((s) => order.includes(s)), order);
});
```
Run: `node --test manifest.test.js` — Expected: FAIL (`ENOENT … cl-editor.html`).

- [ ] **Step 2: Create `cl-editor.html`**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Custom LU editor</title>
    <link rel="stylesheet" href="sidepanel.css" />
    <link rel="stylesheet" href="qr-editor.css" />
    <link rel="stylesheet" href="cl-editor.css" />
  </head>
  <body class="qr-editor-page">
    <div id="error" class="banner banner-error" hidden title="Click to dismiss"></div>
    <div id="notice" class="banner banner-success" hidden></div>

    <header class="topbar"><h1 id="editorTitle">New Custom LU</h1></header>

    <div class="editor-grid">
      <section class="editor-main">
        <p id="modeHint" class="list-count"></p>
        <div id="importRow" hidden>
          <label class="btn-like">Choose Flow properties file (.json) <input id="importFile" type="file" accept=".json,application/json" hidden /></label>
        </div>
        <div id="luBlocks"></div>
        <div class="editor-actions">
          <button id="saveBtn" class="btn-primary" hidden>Save to library</button>
        </div>
      </section>

      <aside class="editor-side">
        <h2>Deploy</h2>
        <p class="list-count">Creates the LU and new attributes, approves, publishes, and grants the LU's projection.</p>
        <div id="deployForm"></div>
      </aside>
    </div>

    <script src="lib/custom-lu-model.js"></script>
    <script src="lib/flow-properties.js"></script>
    <script src="panels/common.js"></script>
    <script src="panels/permission-picker.js"></script>
    <script src="panels/cl-deploy-form.js"></script>
    <script src="cl-editor.js"></script>
  </body>
</html>
```

Note: `panels/common.js` reads `#error` at load (`document.getElementById("error").addEventListener`) and defines `unlockBtnEl`/`unlockPasswordEl` guarded by null checks; `refreshProjections` is not defined on this page, so this page never calls `runAction`.

- [ ] **Step 3: Create `cl-editor.css`**

```css
/* Custom LU editor: attribute table on top of qr-editor.css's layout. */
.lu-block { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3); border: 1px solid var(--surface-raised); border-radius: var(--radius-md); background: var(--surface); margin-bottom: var(--space-3); }
.lu-head { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.lu-head input[type="text"] { flex: 1 1 200px; }
.attr-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.attr-table th { text-align: left; color: var(--ink-muted); font-weight: 600; padding: 4px 6px; border-bottom: 1px solid var(--surface-raised); }
.attr-table td { padding: 4px 6px; border-bottom: 1px solid var(--surface-raised); }
.attr-table input, .attr-table select { width: 100%; box-sizing: border-box; }
.attr-table input[type="number"] { max-width: 90px; }
.attr-table tr.is-locked td { color: var(--ink-muted); }
.lu-problems { margin: 0; padding-left: 18px; color: var(--accent-red, #b91c1c); font-size: 13px; }
.lu-note { font-size: 13px; color: var(--ink-muted); margin: 0; }
.btn-like { display: inline-block; cursor: pointer; padding: 6px 12px; border: 1px solid var(--surface-raised); border-radius: var(--radius-md); }
```

- [ ] **Step 4: Create `cl-editor.js`**

```js
// Full-page Custom LU editor. Modes (URL ?mode=): new | library | existing | import.
// All GitHub/IFS work happens in the background worker (CL_* messages).
const params = new URLSearchParams(location.search);
const mode = ["new", "library", "existing", "import"].includes(params.get("mode")) ? params.get("mode") : "new";

const els = {
  title: document.getElementById("editorTitle"),
  modeHint: document.getElementById("modeHint"),
  importRow: document.getElementById("importRow"),
  importFile: document.getElementById("importFile"),
  blocks: document.getElementById("luBlocks"),
  save: document.getElementById("saveBtn"),
  deployForm: document.getElementById("deployForm")
};

const TYPE_OPTIONS = CustomLuModel.TYPES.map((t) => [t, CustomLuModel.TYPE_LABELS[t]]);
const EXISTING_NOTE = "Deleting or changing attributes must be done in IFS.";

/** Editor state: one block per LU. Locked attributes exist already (IFS or library) and are shown read-only. */
let blocks = [];

function newAttribute() {
  return { name: "", prompt: "", type: "STRING", length: CustomLuModel.DEFAULT_LENGTH, locked: false };
}

function block(lu, { nameLocked = false, attributesLocked = false, checked = true, source = null } = {}) {
  return {
    name: lu.name || "",
    prompt: lu.prompt || "",
    nameLocked,
    checked,
    source,
    attributes: (lu.attributes || []).map((a) => ({
      name: a.name, prompt: a.prompt || "", type: a.type,
      length: a.length === undefined ? CustomLuModel.DEFAULT_LENGTH : a.length,
      locked: attributesLocked
    }))
  };
}

/** The definition deploy/save sends: in Existing mode only the new rows (deploy skips what IFS has). */
function definitionOf(b) {
  const attributes = b.attributes.filter((a) => (mode === "existing" ? !a.locked : true));
  return CustomLuModel.normalizeLu({ name: b.name, prompt: b.prompt, attributes });
}

const problemsOf = (b) => CustomLuModel.validateLu(definitionOf(b));
const activeBlocks = () => blocks.filter((b) => (mode === "import" ? b.checked : true));

function input(value, { type = "text", placeholder = "", disabled = false, onInput }) {
  const el = document.createElement("input");
  el.type = type;
  el.value = value === undefined || value === null ? "" : String(value);
  el.placeholder = placeholder;
  el.disabled = disabled;
  if (onInput) el.oninput = () => { onInput(el.value); refreshProblems(); };
  return el;
}

function typeSelect(attr, disabled, onPick) {
  const select = document.createElement("select");
  select.disabled = disabled;
  const known = TYPE_OPTIONS.some(([v]) => v === attr.type);
  for (const [value, label] of known ? TYPE_OPTIONS : [[attr.type, attr.type], ...TYPE_OPTIONS]) select.append(new Option(label, value));
  select.value = attr.type;
  select.onchange = () => onPick(select.value);
  return select;
}

function renderBlock(b, index) {
  const wrap = document.createElement("div");
  wrap.className = "lu-block";

  const head = document.createElement("div");
  head.className = "lu-head";
  if (mode === "import") {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = b.checked;
    box.title = "Deploy this LU";
    box.onchange = () => { b.checked = box.checked; refreshProblems(); };
    head.appendChild(box);
  }
  head.append(
    input(b.name, { placeholder: "LU name, e.g. CustomPageName", disabled: b.nameLocked, onInput: (v) => { b.name = v; } }),
    input(b.prompt, { placeholder: "Prompt (defaults to the name)", disabled: b.nameLocked, onInput: (v) => { b.prompt = v; } })
  );
  if (b.source && b.source !== b.name) head.appendChild(document.createTextNode(` from property ${b.source}`));
  wrap.appendChild(head);

  if (b.attributes.some((a) => a.locked)) {
    const note = document.createElement("p");
    note.className = "lu-note";
    note.textContent = mode === "library" ? "Library LUs are saved once and not changed." : EXISTING_NOTE;
    wrap.appendChild(note);
  }

  const table = document.createElement("table");
  table.className = "attr-table";
  table.innerHTML = "<thead><tr><th>Attribute</th><th>Prompt</th><th>Type</th><th>Length</th><th></th></tr></thead>";
  const tbody = document.createElement("tbody");
  b.attributes.forEach((a, i) => {
    const tr = document.createElement("tr");
    if (a.locked) tr.className = "is-locked";
    const length = input(a.type === "STRING" ? a.length : "", { type: "number", disabled: a.locked || a.type !== "STRING", onInput: (v) => { a.length = v; } });
    const cells = [
      input(a.name, { placeholder: "NAME", disabled: a.locked, onInput: (v) => { a.name = v; } }),
      input(a.prompt, { placeholder: "Prompt", disabled: a.locked, onInput: (v) => { a.prompt = v; } }),
      typeSelect(a, a.locked, (v) => {
        a.type = v;
        if (v === "STRING" && (a.length === "" || a.length === undefined)) a.length = CustomLuModel.DEFAULT_LENGTH;
        render();
      }),
      length
    ];
    const remove = document.createElement("button");
    remove.className = "btn-ghost";
    remove.textContent = "Remove";
    remove.hidden = a.locked;
    remove.onclick = () => { b.attributes.splice(i, 1); render(); };
    cells.push(remove);
    for (const c of cells) { const td = document.createElement("td"); td.appendChild(c); tr.appendChild(td); }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);

  if (mode !== "library") {
    const add = document.createElement("button");
    add.textContent = "Add attribute";
    add.onclick = () => { b.attributes.push(newAttribute()); render(); };
    wrap.appendChild(add);
  }

  const problems = document.createElement("ul");
  problems.className = "lu-problems";
  problems.dataset.block = String(index);
  wrap.appendChild(problems);
  return wrap;
}

function refreshProblems() {
  blocks.forEach((b, index) => {
    const ul = els.blocks.querySelector(`.lu-problems[data-block="${index}"]`);
    if (!ul) return;
    ul.innerHTML = "";
    if (mode === "import" && !b.checked) return;
    for (const p of problemsOf(b)) {
      const li = document.createElement("li");
      li.textContent = p.message;
      ul.appendChild(li);
    }
  });
  els.save.disabled = mode !== "new" || !blocks.length || problemsOf(blocks[0]).length > 0;
}

function render() {
  els.blocks.innerHTML = "";
  blocks.forEach((b, i) => els.blocks.appendChild(renderBlock(b, i)));
  refreshProblems();
}

/** What the deploy form sends; null (with the reason shown) while something is invalid. */
function lusToDeploy() {
  const chosen = activeBlocks();
  if (!chosen.length) { showError(mode === "import" ? "Tick at least one LU to deploy." : "Nothing to deploy yet.", true); return null; }
  const broken = chosen.filter((b) => problemsOf(b).length);
  if (broken.length) { showError(`Fix the marked fields first (${broken.map((b) => b.name || "unnamed LU").join(", ")}).`, true); return null; }
  return chosen.map(definitionOf);
}

async function save() {
  els.save.disabled = true;
  els.save.textContent = "Saving…";
  const response = await send({ type: "CL_CREATE", lu: definitionOf(blocks[0]), masterPassword: "" });
  els.save.textContent = "Save to library";
  if (!response.ok) { refreshProblems(); return showError(explainLocked(response), true); }
  showNotice(`Saved "${response.lu.name}" to your library.`);
  history.replaceState(null, "", `?mode=library&id=${encodeURIComponent(response.lu.id)}`);
  location.reload();
}

async function loadLibrary(id) {
  const response = await send({ type: "CL_LIBRARY", masterPassword: "" });
  if (!response.ok) return showError(explainLocked(response), true);
  const lu = response.lus.find((x) => x.id === id);
  if (!lu) return showError(`Library LU "${id}" was not found — it may belong to another GitHub user.`, true);
  blocks = [block(lu, { nameLocked: true, attributesLocked: true })];
  els.title.textContent = `Library LU: ${lu.name}`;
  render();
}

async function loadExisting(baseUrl, name) {
  els.modeHint.textContent = "Loading the LU from IFS…";
  const origin = new URL(baseUrl).origin;
  const has = await new Promise((resolve) => chrome.permissions.contains({ origins: [origin + "/*"] }, resolve));
  if (!has) { els.modeHint.textContent = ""; return showError(`No permission for ${origin} yet — open the LU from the side panel's instance list once.`, true); }
  const response = await send({ type: "CL_ENV_GET", baseUrl, name, masterPassword: "" });
  if (!response.ok) { els.modeHint.textContent = ""; return showError(explainLocked(response), true); }
  blocks = [block(response.lu, { nameLocked: true, attributesLocked: true })];
  blocks[0].attributes.push(newAttribute());
  els.title.textContent = `Add attributes: ${response.lu.name}`;
  els.modeHint.textContent = `On ${origin}. ${EXISTING_NOTE}`;
  render();
}

function importFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      blocks = FlowProperties.parseConnectProperties(String(reader.result)).map((lu) => block(lu, { source: lu.source }));
      els.modeHint.textContent = `${blocks.length} Table propert${blocks.length === 1 ? "y" : "ies"} from ${file.name}. Imported LUs are not saved to the library.`;
      render();
    } catch (err) {
      blocks = [];
      render();
      showError(err.message, true);
    }
  };
  reader.onerror = () => showError(`Could not read ${file.name}.`, true);
  reader.readAsText(file);
}

function start() {
  renderClDeployForm(els.deployForm, lusToDeploy, { send, onError: (message) => showError(message, true) });
  if (mode === "new") {
    els.title.textContent = "New Custom LU";
    els.save.hidden = false;
    els.save.onclick = save;
    blocks = [block({ name: "", attributes: [newAttribute()] })];
    els.modeHint.textContent = "Save stores it once in your GitHub library; Deploy sends it to an IFS instance.";
    render();
  } else if (mode === "library") {
    loadLibrary(params.get("id") || "");
  } else if (mode === "existing") {
    loadExisting(params.get("baseUrl") || "", params.get("lu") || "");
  } else {
    els.title.textContent = "Import Flow properties";
    els.importRow.hidden = false;
    els.importFile.onchange = () => { if (els.importFile.files[0]) importFile(els.importFile.files[0]); };
    render();
  }
}

start();
```

- [ ] **Step 5: Run the suite**

Run: `npm test` — Expected: PASS, 581 tests.

- [ ] **Step 6: Manual check**

Reload the unpacked extension. Open `chrome-extension://<id>/cl-editor.html?mode=new` (id from `chrome://extensions`):
- Empty name shows "LU name can't be empty."; typing `My LU` shows the letters/digits message; `CustomTest` clears it.
- Attribute `1abc` shows "First letter should be an uppercase alpha character."; Type Number disables Length; DateTime is in the list.
- `?mode=import`, choose a synthetic file with one Table property (e.g. the test fixture saved locally) → one block, checkbox ticked, columns as String 100.

- [ ] **Step 7: Commit**

```bash
git add cl-editor.html cl-editor.js cl-editor.css manifest.test.js
git commit -m "feat: Custom LU editor page (new, library, existing, import)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Side-panel tab "Custom LUs"

**Files:**
- Create: `panels/custom-lus.js`
- Modify: `sidepanel.html`, `sidepanel.js`, `manifest.test.js`, `docs/superpowers/specs/2026-10-20-custom-lu-deployer-design.md` (status line)

**Interfaces:**
- Consumes: messages `CL_LIBRARY`, `CL_ENV_LIST`, `LIST_INSTANCES`, `GET_DESIGNER_STATUS`; `renderClDeployForm` (Task 7); editor URL contract (Task 8); `createAndActivateModule`, `designerBlockReason`, `showError`, `explainLocked`, `send` (`panels/common.js`).
- Produces: `initCustomLusPanel()`, `refreshCustomLus()`, flag `clLoadedOnce`.

- [ ] **Step 1: Add the tab markup to `sidepanel.html`**

In `<nav class="tabs">` add, after the Quick Reports tab button:
```html
      <button id="tab-custom-lus" class="tab" role="tab">Custom LUs</button>
```
After the `panel-quick-reports` section add:
```html
    <section id="panel-custom-lus" role="tabpanel" hidden>
      <div class="list-toolbar">
        <button id="clNewBtn" class="btn-primary">New LU</button>
        <button id="clImportBtn">Import Properties</button>
        <button id="clRefreshBtn">Refresh</button>
      </div>
      <h2>My library</h2>
      <div id="clLibraryHint" class="empty-state" hidden></div>
      <ul id="clLibraryList" class="qr-list"></ul>
      <hr class="section-divider" />
      <h2>On an IFS instance</h2>
      <select id="clInstanceSelect"></select>
      <div id="clEnvHint" class="empty-state" hidden></div>
      <ul id="clEnvList" class="qr-list"></ul>
    </section>
```
Add `<script src="panels/custom-lus.js"></script>` directly after `<script src="panels/quick-reports.js"></script>`.

- [ ] **Step 2: Create `panels/custom-lus.js`**

```js
let clLoadedOnce = false;
let clOpenForm = null; // the one expanded deploy form in the library list: { close() }

function openClEditor(query) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`cl-editor.html?${query}`) });
}

function clHint(id, text) {
  const el = document.getElementById(id);
  el.textContent = text || "";
  el.hidden = !text;
}

function buildClLibraryRow(lu) {
  const li = document.createElement("li");
  li.className = "qr-item";
  const head = document.createElement("div");
  head.className = "qr-head";
  const name = document.createElement("span");
  name.className = "qr-name";
  name.textContent = lu.name;
  const count = document.createElement("span");
  count.className = "list-count";
  count.textContent = `${lu.attributes.length} attribute(s)`;
  const deployBtn = document.createElement("button");
  deployBtn.textContent = "Deploy";
  const openBtn = document.createElement("button");
  openBtn.className = "btn-ghost";
  openBtn.textContent = "Open";
  openBtn.onclick = () => openClEditor(`mode=library&id=${encodeURIComponent(lu.id)}`);
  head.append(name, count, deployBtn, openBtn);

  const form = document.createElement("div");
  form.hidden = true;
  const panel = {
    close() { form.hidden = true; deployBtn.textContent = "Deploy"; if (clOpenForm === panel) clOpenForm = null; }
  };
  deployBtn.onclick = () => {
    if (!form.hidden) return panel.close();
    if (clOpenForm) clOpenForm.close();
    form.hidden = false;
    deployBtn.textContent = "Close";
    clOpenForm = panel;
    renderClDeployForm(form, () => [lu], { send, onClose: () => panel.close(), onError: (message) => showError(message, true) });
  };
  li.append(head, form);
  return li;
}

async function refreshClLibrary() {
  const list = document.getElementById("clLibraryList");
  clHint("clLibraryHint", "Loading…");
  const response = await send({ type: "CL_LIBRARY", masterPassword: "" });
  list.innerHTML = "";
  clOpenForm = null;
  if (!response.ok) return clHint("clLibraryHint", `${explainLocked(response)} (GitHub settings are in Basic Data.)`);
  clHint("clLibraryHint", response.lus.length ? "" : "No saved LUs yet — New LU creates one.");
  for (const lu of response.lus) list.appendChild(buildClLibraryRow(lu));
}

async function createClModule(baseUrl, name, btn) {
  const designer = await send({ type: "GET_DESIGNER_STATUS" });
  const blocked = designer && designer.ok !== false ? designerBlockReason(designer) : "";
  if (blocked) return showError(blocked, true);
  btn.disabled = true;
  btn.textContent = "Creating & activating…";
  const response = await createAndActivateModule(baseUrl, name);
  btn.disabled = false;
  btn.textContent = "Module";
  if (response) showNotice(`Module ${name} created & activated in the open flow.`);
}

function buildClEnvRow(baseUrl, lu) {
  const li = document.createElement("li");
  li.className = "qr-item";
  const head = document.createElement("div");
  head.className = "qr-head";
  const name = document.createElement("span");
  name.className = "qr-name";
  name.textContent = lu.name;
  const addBtn = document.createElement("button");
  addBtn.textContent = "Add attributes";
  addBtn.onclick = () => openClEditor(`mode=existing&baseUrl=${encodeURIComponent(baseUrl)}&lu=${encodeURIComponent(lu.name)}`);
  const moduleBtn = document.createElement("button");
  moduleBtn.textContent = "Module";
  moduleBtn.onclick = () => createClModule(baseUrl, lu.name, moduleBtn);
  head.append(name, addBtn, moduleBtn);
  li.appendChild(head);
  return li;
}

let clEnvToken = 0; // a slow answer for a previously chosen instance is ignored
async function refreshClEnvironment() {
  const select = document.getElementById("clInstanceSelect");
  const list = document.getElementById("clEnvList");
  const token = ++clEnvToken;
  list.innerHTML = "";
  if (!select.value) return clHint("clEnvHint", "");
  const baseUrl = select.value;
  const origin = new URL(baseUrl).origin;
  // The change event is the user gesture chrome.permissions.request needs; ask before any other await.
  const granted = await new Promise((resolve) => chrome.permissions.request({ origins: [origin + "/*"] }, resolve));
  if (token !== clEnvToken) return;
  if (!granted) return clHint("clEnvHint", `Permission for ${origin} was not granted — can't read its Custom LUs.`);
  clHint("clEnvHint", "Loading…");
  const response = await send({ type: "CL_ENV_LIST", baseUrl, masterPassword: "" });
  if (token !== clEnvToken) return;
  if (!response.ok) return clHint("clEnvHint", explainLocked(response));
  clHint("clEnvHint", response.lus.length ? "" : "No Custom LUs on this instance yet.");
  for (const lu of response.lus) list.appendChild(buildClEnvRow(baseUrl, lu));
}

async function fillClInstances() {
  const select = document.getElementById("clInstanceSelect");
  const previous = select.value;
  const response = await send({ type: "LIST_INSTANCES" });
  select.innerHTML = "";
  if (!response.ok) return clHint("clEnvHint", response.error);
  const instances = response.instances.slice().sort((a, b) => a.name.localeCompare(b.name));
  if (!instances.length) { select.hidden = true; return clHint("clEnvHint", "No IFS instances yet — add one in Basic Data."); }
  select.hidden = false;
  select.append(new Option("Choose an IFS instance…", ""));
  for (const instance of instances) select.append(new Option(instance.name, instance.baseUrl));
  if (instances.some((i) => i.baseUrl === previous)) select.value = previous;
}

function refreshCustomLus() {
  clLoadedOnce = true;
  refreshClLibrary();
  fillClInstances();
}

function initCustomLusPanel() {
  document.getElementById("clNewBtn").onclick = () => openClEditor("mode=new");
  document.getElementById("clImportBtn").onclick = () => openClEditor("mode=import");
  document.getElementById("clRefreshBtn").onclick = () => { refreshClLibrary(); refreshClEnvironment(); };
  document.getElementById("clInstanceSelect").onchange = refreshClEnvironment;
}
```

- [ ] **Step 3: Register the tab in `sidepanel.js`**

1. `const TABS = ["tracker", "recorder", "quick-reports", "custom-lus", "basic-data"];`
2. In `showTab`, after the Quick Reports line add:
```js
  if (name === "custom-lus" && !clLoadedOnce) refreshCustomLus();
```
3. After `initQuickReportsPanel();` add `initCustomLusPanel();`.

`showTab(initialTab)` runs before `initCustomLusPanel()`; `refreshCustomLus` only needs the DOM and `send`, so restoring the tab on open still works. The Refresh/New buttons get their handlers right after.

- [ ] **Step 4: Extend `manifest.test.js`**

```js
test("side panel has the Custom LUs tab and loads its scripts in order", () => {
  const html = fs.readFileSync(path.join(__dirname, "sidepanel.html"), "utf8");
  assert.match(html, /id="tab-custom-lus"/);
  assert.match(html, /id="panel-custom-lus"/);
  const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(srcs.indexOf("panels/cl-deploy-form.js") < srcs.indexOf("panels/custom-lus.js"));
  assert.ok(srcs.indexOf("panels/custom-lus.js") < srcs.indexOf("sidepanel.js"));
  const js = fs.readFileSync(path.join(__dirname, "sidepanel.js"), "utf8");
  assert.match(js, /"custom-lus"/);
  assert.match(js, /initCustomLusPanel\(\)/);
});
```

- [ ] **Step 5: Run the suite**

Run: `npm test` — Expected: PASS, 582 tests.

- [ ] **Step 6: Mark the spec implemented**

In the spec, change `Status: draft for review` to `Status: implemented on feat/custom-lu-deployer — live check pending (see §9)`.

- [ ] **Step 7: Manual smoke check**

Reload the unpacked extension → Custom LUs tab:
- "My library" loads (or shows the GitHub hint); New LU / Import Properties open the editor tab.
- Choosing an instance asks for host permission once, then lists its Custom LUs; Add attributes opens the editor in Existing mode with existing rows read-only and the "Deleting or changing attributes must be done in IFS." note.
- Quick Reports tab still works (deploy form opens, permission sets load).
- The tab bar may wrap to two rows at the default panel width (known parked issue) — note it, don't fix here.

- [ ] **Step 8: Commit**

```bash
git add panels/custom-lus.js sidepanel.html sidepanel.js manifest.test.js docs/superpowers/specs/2026-10-20-custom-lu-deployer-design.md
git commit -m "feat: Custom LUs side-panel tab

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Live checklist (user, after Task 9)

On a test IFS instance, with HAR recording on:
1. New LU with String(4000), Number, Date, DateTime → published, granted, Module button creates the module. Confirms: Number PATCH, DateTime `DateFormat:"DATETIME"`, projection name = LU name.
2. Existing LU → add one attribute → Approve/Publish again.
3. Save a new LU to the library → deploy it to a second instance.
4. Import a Flow properties export → deploy two ticked LUs, one with a bad column name fixed in the editor.
5. Deploy a library LU where an attribute exists with another type → mismatch warning, attribute untouched.

Any UNCONFIRMED call that fails: send the HAR, fix the one payload, keep the rest.

## Follow-up (separate plan)

Flow Classic import, once the user's Classic sample is available (spec §8):
- Classic User properties → one `UserProperties` LU (wide layout + `USER_ID`).
- The user picks which tables to import: every Classic table (and the merged `UserProperties` block) is listed with a checkbox before anything is deployed. The editor's Import mode already renders one checkbox per LU block and deploys only ticked ones (Task 8), so the Classic parser only has to return blocks; the selection UI is reused, not rebuilt.
