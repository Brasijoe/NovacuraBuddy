# Quick Report Deployer merge + update notice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the IFS Quick Report Deployer (Electron) into the NovacuraBuddy Chrome extension as a fourth function, with a per-user GitHub-backed report library, and add a "new version available" banner backed by GitHub Releases.

**Architecture:** Pure logic lives in small UMD-style modules under `lib/` (testable with `node --test`, loaded by `importScripts` in the background worker or `<script>` in pages). The background worker owns every credentialed call (IFS, GitHub) and answers `chrome.runtime` messages; the side panel tab and the full-page editor only render and send messages — the same split the existing tracker/recorder use.

**Tech Stack:** Chrome MV3, plain JS (no build step), `node:test`, vendored `fuse.js` 7.0.0 (UMD) and `sql-formatter` 15.8.2 (UMD), GitHub REST API, IFS OData REST.

**Spec:** `docs/superpowers/specs/2026-10-19-quick-report-deployer-merge-design.md`

**Source being ported (read-only reference):** `C:\Users\johan\Documents\IFS Cloud Projekt\IFS Quick Report Deployer\.worktrees\quick-report-deployer-impl\src\main\` — `ifs/quickReportDeploy.ts`, `ifs/ifsEndpoints.ts`, `ifs/ifsClient.ts`, `ifs/permissionSets.ts`, `qr/qrFileStore.ts`, `qr/searchIndex.ts`, `db/deploymentsRepo.ts`.

## Global Constraints

- Plain JS only, no bundler, no new npm dependencies; every module uses the existing wrapper `(function (global) { ... module.exports / global.X ... })(typeof window !== "undefined" ? window : globalThis);`
- MV3 forbids remote scripts: third-party code only from `lib/vendor/`, pinned versions, recorded in `lib/vendor/VENDOR.md`.
- Data repo default: `Brasijoe/ifs-quick-report-deployer-data`. Per-user path: `quick-reports/<github-login>/<slug>.sql` + `<slug>.json`; `.json` shape `{ id, name, tags, createdAt, updatedAt }` (2-space JSON), unchanged from the Electron app.
- Commit messages in the data repo: `add QR: <name>`, `update QR: <name>`, `move QR to <login>: <slug>`.
- Update source: `https://api.github.com/repos/Brasijoe/NovacuraBuddy/releases/latest`; release asset name `NovacuraBuddy-v<version>.zip`; tag `v<version>`; check interval 6 h.
- No partial history: a deploy that did not finish writes nothing locally.
- Never overwrite on GitHub without the loaded `sha`; a conflict is an error shown to the user.
- GitHub token and master password never appear in logs.
- Firefox build (`firefox/`) is not touched.
- All existing tests (`npm test`, 474 at plan time) keep passing after every task.

## Review Focus

- Non-ASCII text (ä ö ü ß €) in report names or SQL must survive a save → list round trip through GitHub's base64 unchanged (Task 4 test).
- After the user installs an update, the old "v0.2.0 available" banner must disappear on its own, not linger from cached update info (Task 6 test + Task 8 wiring).
- A save where `.sql` succeeds but `.json` fails must tell the user to reload, and the next save after reloading must succeed (Task 4 test).
- An IFS token that expires mid-session (401) must not fail the deploy: clear the cached token and retry once (Task 2 test).
- Two names that slug the same ("My Report", "my report!") must not overwrite each other; same name in different case is a name collision (Task 4 tests).

---

### Task 1: Vendored libraries + search wrapper

**Files:**
- Create: `lib/vendor/fuse.min.js`, `lib/vendor/sql-formatter.min.js`, `lib/vendor/VENDOR.md`
- Create: `lib/qr-search.js`
- Test: `lib/qr-search.test.js`

**Interfaces:**
- Produces: global `Fuse` (page), global `sqlFormatter` with `sqlFormatter.format(sql, { language: "plsql" })` (page); `QrSearch.createQrSearch(reports, FuseCtor) → { search(term) → report[] }`.

- [ ] **Step 1: Fetch the exact vendor builds**

Run in a scratch directory (not the repo). `REPO` = the NovacuraBuddy checkout, `SCRATCH` = the session scratchpad:

```bash
REPO="/c/Users/johan/Documents/IFS Cloud Projekt/NovacuraBuddy"
cd "$SCRATCH" && mkdir vendor-dl && cd vendor-dl
npm pack fuse.js@7.0.0 sql-formatter@15.8.2
tar -xzf fuse.js-7.0.0.tgz && mv package fuse && tar -xzf sql-formatter-15.8.2.tgz && mv package sqlf
ls fuse/dist sqlf/dist
```

Expected: `fuse/dist/fuse.min.js` and `sqlf/dist/sql-formatter.min.js` exist. If `fuse.min.js` (UMD) is missing, STOP and report — do not substitute an ESM/CJS build.

- [ ] **Step 2: Copy and verify they load as UMD in Node**

```bash
cp fuse/dist/fuse.min.js "$REPO/lib/vendor/fuse.min.js"
cp sqlf/dist/sql-formatter.min.js "$REPO/lib/vendor/sql-formatter.min.js"
node -e "const F=require('$REPO/lib/vendor/fuse.min.js'); console.log(typeof F, typeof require('$REPO/lib/vendor/sql-formatter.min.js').format)"
```

Expected: `function function`.

- [ ] **Step 3: Write `lib/vendor/VENDOR.md`**

```markdown
# Vendored third-party code

MV3 extensions can't load remote scripts, so these are pinned local copies. Update only by
re-running `npm pack <pkg>@<version>` and copying the same file.

| File | Package | Version | Source file | Page global |
|---|---|---|---|---|
| fuse.min.js | fuse.js | 7.0.0 | dist/fuse.min.js (UMD) | `Fuse` |
| sql-formatter.min.js | sql-formatter | 15.8.2 | dist/sql-formatter.min.js (UMD) | `sqlFormatter` |
```

- [ ] **Step 4: Write the failing test `lib/qr-search.test.js`**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const Fuse = require("./vendor/fuse.min.js");
const { createQrSearch } = require("./qr-search.js");

const reports = [
  { id: "open-orders", name: "Open customer orders", content: "SELECT * FROM customer_order WHERE state = 'Released'" },
  { id: "stock", name: "Stock per site", content: "SELECT contract, SUM(qty_onhand) FROM inventory_part_in_stock GROUP BY contract" }
];

test("empty or blank term returns every report in original order", () => {
  const search = createQrSearch(reports, Fuse);
  assert.deepEqual(search.search("").map((r) => r.id), ["open-orders", "stock"]);
  assert.deepEqual(search.search("   ").map((r) => r.id), ["open-orders", "stock"]);
});

test("matches on name and on SQL body, fuzzily", () => {
  const search = createQrSearch(reports, Fuse);
  assert.deepEqual(search.search("custmer").map((r) => r.id), ["open-orders"]);
  assert.deepEqual(search.search("qty_onhand").map((r) => r.id), ["stock"]);
});
```

- [ ] **Step 5: Run it, expect FAIL**

Run: `node --test lib/qr-search.test.js`
Expected: FAIL — `Cannot find module './qr-search.js'`.

- [ ] **Step 6: Implement `lib/qr-search.js`**

```js
(function (global) {
  /** In-memory fuzzy search over Quick Reports — same Fuse options as the Electron app's
   *  searchIndex.ts. `FuseCtor` is injected: the page passes its vendored global `Fuse`, tests
   *  pass the required module. */
  function createQrSearch(reports, FuseCtor) {
    const fuse = new FuseCtor(reports, { keys: ["name", "content"], threshold: 0.35, ignoreLocation: true });
    return {
      search(term) {
        if (!term || !term.trim()) return reports;
        return fuse.search(term).map((result) => result.item);
      }
    };
  }

  const api = { createQrSearch };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.QrSearch = api;
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 7: Run tests, expect PASS**

Run: `node --test lib/qr-search.test.js && npm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add lib/vendor lib/qr-search.js lib/qr-search.test.js
git commit -m "feat(quick-reports): vendor fuse.js + sql-formatter, add report search"
```

---

### Task 2: IFS deploy sequence (`lib/qr-deploy.js`)

**Files:**
- Create: `lib/qr-deploy.js`
- Test: `lib/qr-deploy.test.js`

**Interfaces:**
- Produces:
  - `QrDeploy.createIfsClient({ baseUrl, getToken: () => Promise<string>, clearToken: () => void, fetchImpl? }) → { get(path), post(path, body), patchText(path, text, etag), patchJson(path, body, etag) }`
  - `QrDeploy.deployQuickReport(client, { report: { id, name, content }, priorQuickReportId?: string|null, forceQuickReportId?: string|null, permissionSetIds: string[] }) → Promise<{ status: "deployed", quickReportId } | { status: "needsConfirmation", existingQuickReportId, existingDescription }>`
  - `QrDeploy.listPermissionSets(client) → Promise<{ id, name }[]>` (IFS-managed sets removed)
  - Errors thrown carry `err.step` (human step name) and a message starting with `<step> failed — `.

- [ ] **Step 1: Write the failing tests `lib/qr-deploy.test.js`**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { createIfsClient, deployQuickReport, listPermissionSets } = require("./qr-deploy.js");

const BASE_URL = "https://ifs.example.com";
const PREFIX = "/main/ifsapplications/projection/v1/";
const report = { id: "my-report", name: "My Report", content: "SELECT 1 FROM DUAL" };

function res(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body))
  };
}

/** Fake IFS: answers the confirmed QuickReportHandling / PermissionSetHandling calls.
 *  `override(call)` may return a response to replace the default for one call. */
function fakeIfs({ existing = [], newId = "516435.0", override } = {}) {
  const calls = [];
  let lob = 0;
  const fetchImpl = async (url, init) => {
    const call = { method: init.method, path: url.replace(BASE_URL, ""), headers: init.headers, body: init.body };
    calls.push(call);
    const forced = override && override(call, calls);
    if (forced) return forced;
    const { method, path } = call;
    if (method === "GET" && path.includes("QuickReportSet?$select")) return res(200, { value: existing });
    if (method === "POST" && path.endsWith("/FndTempLobs")) { lob++; return res(201, { LobId: `LOB-${lob}`, "@odata.etag": `ETAG-${lob}` }); }
    if (method === "PATCH" && path.endsWith("/ClobData")) return res(204);
    if (method === "POST" && path.endsWith("/CheckSqlExpressionAction")) return res(204);
    if (method === "POST" && path.endsWith("/QuickReportVirtualSet")) return res(201, { Objkey: "OBJ-1" });
    if (method === "POST" && path.endsWith("/SaveNewAction")) return res(200, { value: newId });
    if (method === "POST" && path.includes("CleanupVirtualEntity")) return res(204);
    if (method === "GET" && /QuickReportSet\(QuickReportId=\d+\)$/.test(path)) return res(200, { "@odata.etag": "QR-ETAG" });
    if (method === "PATCH" && path.includes("QuickReportSet(QuickReportId=")) return res(200, { QuickReportId: "900" });
    if (method === "POST" && path.endsWith("/GrantProjections")) return res(204);
    if (method === "GET" && path.includes("PermissionSets?")) {
      return res(200, { value: [
        { Role: "SALES", Description: "Sales users", FndRoleDeliveryType: null },
        { Role: "FND_ADMIN", Description: "IFS admin", FndRoleDeliveryType: "IFSManaged" },
        { Role: "NODESC", Description: null, FndRoleDeliveryType: "Customer" }
      ] });
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { fetchImpl, calls };
}

const sig = (c) => `${c.method} ${c.path.replace(PREFIX, "").split("?")[0]}`;

function clientFor(fake, tokens = ["T1"]) {
  let i = 0;
  const state = { cleared: 0 };
  const client = createIfsClient({
    baseUrl: BASE_URL,
    getToken: async () => tokens[Math.min(i++, tokens.length - 1)],
    clearToken: () => { state.cleared++; },
    fetchImpl: fake.fetchImpl
  });
  return { client, state };
}

test("first deploy runs the confirmed create sequence, then one grant per permission set", async () => {
  const fake = fakeIfs();
  const { client } = clientFor(fake);
  const outcome = await deployQuickReport(client, { report, permissionSetIds: ["SALES", "NODESC"] });
  assert.deepEqual(outcome, { status: "deployed", quickReportId: "516435" });
  assert.deepEqual(fake.calls.map(sig), [
    "GET QuickReportHandling.svc/QuickReportSet",
    "POST QuickReportHandling.svc/FndTempLobs",
    "PATCH QuickReportHandling.svc/FndTempLobs(LobId='LOB-1')/ClobData",
    "POST QuickReportHandling.svc/CheckSqlExpressionAction",
    "POST QuickReportHandling.svc/QuickReportVirtualSet",
    "POST QuickReportHandling.svc/FndTempLobs",
    "PATCH QuickReportHandling.svc/FndTempLobs(LobId='LOB-2')/ClobData",
    "POST QuickReportHandling.svc/CheckSqlExpressionAction",
    "POST QuickReportHandling.svc/SaveNewAction",
    "POST QuickReportHandling.svc/QuickReportVirtualSet(Objkey='OBJ-1')/IfsApp.QuickReportHandling.QuickReportVirtual_CleanupVirtualEntity",
    "POST PermissionSetHandling.svc/GrantProjections",
    "POST PermissionSetHandling.svc/GrantProjections"
  ]);
  const clob = fake.calls[2];
  assert.equal(clob.body, "SELECT 1 FROM DUAL");
  assert.equal(clob.headers["If-Match"], "ETAG-1");
  assert.equal(clob.headers["Content-Type"], "application/octet-stream");
  assert.equal(clob.headers.Authorization, "Bearer T1");
  assert.deepEqual(JSON.parse(fake.calls[4].body), { Description: "My Report", QrType: "SQLStatement", SqlExpression: "SELECT 1 FROM DUAL" });
  assert.deepEqual(JSON.parse(fake.calls[10].body), { Projections: "PROJECTION_NAME=QuickReport516435^", Role: "SALES" });
  assert.deepEqual(JSON.parse(fake.calls[11].body), { Projections: "PROJECTION_NAME=QuickReport516435^", Role: "NODESC" });
});

test("a same-named report on the instance asks for confirmation and writes nothing", async () => {
  const fake = fakeIfs({ existing: [{ QuickReportId: "42.0", Description: "My Report" }] });
  const { client } = clientFor(fake);
  const outcome = await deployQuickReport(client, { report, permissionSetIds: ["SALES"] });
  assert.deepEqual(outcome, { status: "needsConfirmation", existingQuickReportId: "42", existingDescription: "My Report" });
  assert.deepEqual(fake.calls.map((c) => c.method), ["GET"]);
});

test("the name lookup escapes single quotes in the OData filter", async () => {
  const fake = fakeIfs();
  const { client } = clientFor(fake);
  await deployQuickReport(client, { report: { ...report, name: "Bob's report" }, permissionSetIds: [] });
  assert.ok(decodeURIComponent(fake.calls[0].path).includes("Description eq 'Bob''s report'"));
});

test("forceQuickReportId updates that record via GET etag + PATCH, no name lookup", async () => {
  const fake = fakeIfs();
  const { client } = clientFor(fake);
  const outcome = await deployQuickReport(client, { report, forceQuickReportId: "900", permissionSetIds: [] });
  assert.deepEqual(outcome, { status: "deployed", quickReportId: "900" });
  assert.deepEqual(fake.calls.map(sig), [
    "POST QuickReportHandling.svc/FndTempLobs",
    "PATCH QuickReportHandling.svc/FndTempLobs(LobId='LOB-1')/ClobData",
    "POST QuickReportHandling.svc/CheckSqlExpressionAction",
    "GET QuickReportHandling.svc/QuickReportSet(QuickReportId=900)",
    "PATCH QuickReportHandling.svc/QuickReportSet(QuickReportId=900)"
  ]);
  const patch = fake.calls[4];
  assert.equal(patch.headers["If-Match"], "QR-ETAG");
  assert.equal(patch.headers["Content-Type"], "application/json;IEEE754Compatible=true");
  assert.ok(patch.path.includes("?select-fields=Description,QuickReportId"));
  assert.deepEqual(JSON.parse(patch.body), { Description: "My Report", SqlExpression: "SELECT 1 FROM DUAL" });
});

test("a prior deployment id takes the update path too", async () => {
  const fake = fakeIfs();
  const { client } = clientFor(fake);
  await deployQuickReport(client, { report, priorQuickReportId: "900", permissionSetIds: [] });
  assert.ok(!fake.calls.some((c) => c.path.includes("$filter")));
});

test("a validation failure names the step and carries IFS's error text", async () => {
  const fake = fakeIfs({ override: (c) => (c.path.endsWith("/CheckSqlExpressionAction") ? res(400, "ORA-00942: table or view does not exist") : null) });
  const { client } = clientFor(fake);
  await assert.rejects(deployQuickReport(client, { report, permissionSetIds: [] }), (err) => {
    assert.equal(err.step, "Validate SQL");
    assert.match(err.message, /^Validate SQL failed — /);
    assert.match(err.message, /ORA-00942/);
    return true;
  });
});

test("a SaveNewAction failure still cleans up the draft, and the save error wins", async () => {
  const fake = fakeIfs({ override: (c) => (c.path.endsWith("/SaveNewAction") ? res(409, "FND_RECORD_EXIST") : null) });
  const { client } = clientFor(fake);
  await assert.rejects(deployQuickReport(client, { report, permissionSetIds: [] }), (err) => err.step === "Save new report");
  assert.ok(fake.calls.some((c) => c.path.includes("CleanupVirtualEntity")));
});

test("a 401 clears the cached token and retries once with a fresh one", async () => {
  const fake = fakeIfs({ override: (c, calls) => (calls.length === 1 ? res(401, "expired") : null) });
  const { client, state } = clientFor(fake, ["OLD", "NEW"]);
  await deployQuickReport(client, { report, permissionSetIds: [] });
  assert.equal(state.cleared, 1);
  assert.equal(fake.calls[0].headers.Authorization, "Bearer OLD");
  assert.equal(fake.calls[1].headers.Authorization, "Bearer NEW");
});

test("a second 401 in a row is an error, not a loop", async () => {
  const fake = fakeIfs({ override: () => res(401, "nope") });
  const { client } = clientFor(fake, ["A", "B", "C"]);
  await assert.rejects(deployQuickReport(client, { report, permissionSetIds: [] }), /401/);
  assert.equal(fake.calls.length, 2);
});

test("listPermissionSets drops IFS-managed sets and falls back to Role for a missing name", async () => {
  const { client } = clientFor(fakeIfs());
  assert.deepEqual(await listPermissionSets(client), [
    { id: "SALES", name: "Sales users" },
    { id: "NODESC", name: "NODESC" }
  ]);
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `node --test lib/qr-deploy.test.js`
Expected: FAIL — `Cannot find module './qr-deploy.js'`.

- [ ] **Step 3: Implement `lib/qr-deploy.js`**

```js
(function (global) {
  // Ported from the Electron Quick Report Deployer (ifsEndpoints.ts / quickReportDeploy.ts). The
  // create and update sequences and the GrantProjections payload were CONFIRMED by HAR captures
  // (2026-09-08/09); see ifsEndpoints.ts in that repo for the full capture notes. Do not "tidy"
  // payloads here (e.g. the trailing "^") without a new capture.
  const QR = "/main/ifsapplications/projection/v1/QuickReportHandling.svc";
  const PS = "/main/ifsapplications/projection/v1/PermissionSetHandling.svc";
  const IFS_MANAGED_DELIVERY_TYPE = "IFSManaged";

  const escapeODataString = (value) => String(value).replace(/'/g, "''");

  const endpoints = {
    findQuickReportByName: (name) =>
      `${QR}/QuickReportSet?$select=QuickReportId,Description&$filter=` +
      encodeURIComponent(`Description eq '${escapeODataString(name)}'`),
    listPermissionSets: () => `${PS}/PermissionSets?$select=Role,Description,FndRoleDeliveryType`,
    grantProjection: () => `${PS}/GrantProjections`,
    grantProjectionBody: (quickReportId, role) => ({ Projections: `PROJECTION_NAME=QuickReport${quickReportId}^`, Role: role }),
    createTempLob: () => `${QR}/FndTempLobs`,
    createTempLobBody: () => ({ CreatedByModule: "QuickReportHandling" }),
    tempLobClobData: (lobId) => `${QR}/FndTempLobs(LobId='${lobId}')/ClobData`,
    checkSqlExpression: () => `${QR}/CheckSqlExpressionAction`,
    checkSqlExpressionBody: (lobId) => ({ SqlStatementTempLobId: lobId }),
    createQuickReportVirtual: () => `${QR}/QuickReportVirtualSet`,
    createQuickReportVirtualBody: (name, sql) => ({ Description: name, QrType: "SQLStatement", SqlExpression: sql }),
    saveNewAction: () => `${QR}/SaveNewAction`,
    saveNewActionBody: (objkey) => ({ Objkey: objkey }),
    cleanupVirtualEntity: (objkey) =>
      `${QR}/QuickReportVirtualSet(Objkey='${objkey}')/IfsApp.QuickReportHandling.QuickReportVirtual_CleanupVirtualEntity`,
    getQuickReport: (id) => `${QR}/QuickReportSet(QuickReportId=${id})`,
    updateQuickReport: (id) =>
      `${QR}/QuickReportSet(QuickReportId=${id})` +
      "?select-fields=Description,QuickReportId,QrType,FileName,CategoryId,DomainId,ProjectionName,InstanceName,SqlExpression,Objgrants,Query,Comments,QrTypeDb,ClientName,luname,keyref",
    updateQuickReportBody: (name, sql) => ({ Description: name, SqlExpression: sql })
  };

  /** Some IFS responses serialize the numeric QuickReportId as "516435.0". */
  const normalizeQuickReportId = (raw) => String(raw).replace(/\.0+$/, "");

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
        throw new Error(`IFS request failed (${path.split("?")[0]}, ${res.status})${text ? ": " + text : ""}`);
      }
      return res;
    }
    const bodyOf = async (res) => (res.status === 204 ? undefined : res.json());

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
        }))
    };
  }

  /** Runs one named deploy step; a failure is re-labelled so the user sees which step broke. */
  async function step(name, fn) {
    try {
      return await fn();
    } catch (err) {
      if (!err.step) {
        err.step = name;
        err.message = `${name} failed — ${err.message}`;
      }
      throw err;
    }
  }

  async function uploadAndValidateSql(client, sql) {
    const lob = await step("Upload SQL", async () => {
      const created = await client.post(endpoints.createTempLob(), endpoints.createTempLobBody());
      if (!created || !created.LobId) throw new Error("IFS FndTempLobs response did not include a LobId.");
      if (!created["@odata.etag"]) throw new Error("IFS FndTempLobs response did not include an @odata.etag.");
      await client.patchText(endpoints.tempLobClobData(created.LobId), sql, created["@odata.etag"]);
      return created;
    });
    await step("Validate SQL", () => client.post(endpoints.checkSqlExpression(), endpoints.checkSqlExpressionBody(lob.LobId)));
  }

  async function createOnIfs(client, report) {
    await uploadAndValidateSql(client, report.content);
    const virtual = await step("Create report draft", () =>
      client.post(endpoints.createQuickReportVirtual(), endpoints.createQuickReportVirtualBody(report.name, report.content)));
    if (!virtual || !virtual.Objkey) throw Object.assign(new Error("Create report draft failed — IFS response did not include an Objkey."), { step: "Create report draft" });

    let failure = null;
    try {
      await uploadAndValidateSql(client, report.content);
      const saved = await step("Save new report", () => client.post(endpoints.saveNewAction(), endpoints.saveNewActionBody(virtual.Objkey)));
      if (!saved || !saved.value) throw Object.assign(new Error("Save new report failed — IFS response did not include a QuickReportId."), { step: "Save new report" });
      return normalizeQuickReportId(saved.value);
    } catch (err) {
      failure = err;
      throw err;
    } finally {
      try {
        await step("Clean up report draft", () => client.post(endpoints.cleanupVirtualEntity(virtual.Objkey), {}));
      } catch (cleanupErr) {
        if (!failure) throw cleanupErr; // the original failure is what the user needs to see
      }
    }
  }

  async function updateOnIfs(client, quickReportId, report) {
    await uploadAndValidateSql(client, report.content);
    const current = await step("Read current report", () => client.get(endpoints.getQuickReport(quickReportId)));
    if (!current || !current["@odata.etag"]) throw Object.assign(new Error("Read current report failed — IFS response did not include an @odata.etag."), { step: "Read current report" });
    const updated = await step("Update report", () =>
      client.patchJson(endpoints.updateQuickReport(quickReportId), endpoints.updateQuickReportBody(report.name, report.content), current["@odata.etag"]));
    return normalizeQuickReportId((updated && updated.QuickReportId) || quickReportId);
  }

  async function findExistingByName(client, name) {
    const result = await step("Check for an existing report", () => client.get(endpoints.findQuickReportByName(name)));
    const match = result && result.value && result.value[0];
    return match ? { quickReportId: normalizeQuickReportId(match.QuickReportId), description: match.Description } : null;
  }

  async function deployQuickReport(client, { report, priorQuickReportId, forceQuickReportId, permissionSetIds }) {
    let quickReportId;
    const targetId = priorQuickReportId || forceQuickReportId;
    if (targetId) {
      quickReportId = await updateOnIfs(client, targetId, report);
    } else {
      const existing = await findExistingByName(client, report.name);
      if (existing) {
        return { status: "needsConfirmation", existingQuickReportId: existing.quickReportId, existingDescription: existing.description };
      }
      quickReportId = await createOnIfs(client, report);
    }
    for (const role of permissionSetIds) {
      await step(`Grant to permission set ${role}`, () =>
        client.post(endpoints.grantProjection(), endpoints.grantProjectionBody(quickReportId, role)));
    }
    return { status: "deployed", quickReportId };
  }

  async function listPermissionSets(client) {
    const res = await step("Load permission sets", () => client.get(endpoints.listPermissionSets()));
    return (res.value || [])
      .filter((row) => row.FndRoleDeliveryType !== IFS_MANAGED_DELIVERY_TYPE)
      .map((row) => ({ id: row.Role, name: row.Description || row.Role }));
  }

  const api = { createIfsClient, deployQuickReport, listPermissionSets, normalizeQuickReportId, endpoints };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.QrDeploy = api;
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `node --test lib/qr-deploy.test.js && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/qr-deploy.js lib/qr-deploy.test.js
git commit -m "feat(quick-reports): port the IFS Quick Report deploy sequence"
```

---

### Task 3: Deploy history store (`lib/qr-history.js`)

**Files:**
- Create: `lib/qr-history.js`
- Test: `lib/qr-history.test.js`

**Interfaces:**
- Consumes: a `chrome.storage.local`-like object `{ get(key) → Promise<{[key]: value}>, set(obj) → Promise }`.
- Produces: `QrHistory.createQrHistory(storage) → { record({ qrId, instanceKey, quickReportId, permissionSetIds, deployedAt? }), latestFor(qrId, instanceKey) → entry|null, listForReport(qrId) → entry[], listForInstance(instanceKey) → entry[], getPermissionSetMemory(instanceKey) → string[] }`. Entry = `{ qrId, instanceKey, quickReportId, permissionSetIds, deployedAt }` (ISO string). Lists are newest first.

- [ ] **Step 1: Write the failing test `lib/qr-history.test.js`**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { createQrHistory } = require("./qr-history.js");

function fakeStorage() {
  const data = {};
  return { data, get: async (k) => ({ [k]: data[k] }), set: async (o) => { Object.assign(data, o); } };
}

const A = "https://a.example.com";
const B = "https://b.example.com";

test("record keeps one entry per (report, instance) — redeploy replaces it", async () => {
  const h = createQrHistory(fakeStorage());
  await h.record({ qrId: "r1", instanceKey: A, quickReportId: "10", permissionSetIds: ["S"], deployedAt: "2026-10-01T10:00:00.000Z" });
  await h.record({ qrId: "r1", instanceKey: A, quickReportId: "10", permissionSetIds: ["S", "T"], deployedAt: "2026-10-02T10:00:00.000Z" });
  const list = await h.listForReport("r1");
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].permissionSetIds, ["S", "T"]);
  assert.equal(list[0].deployedAt, "2026-10-02T10:00:00.000Z");
});

test("latestFor finds the instance-specific entry, null when none", async () => {
  const h = createQrHistory(fakeStorage());
  await h.record({ qrId: "r1", instanceKey: A, quickReportId: "10", permissionSetIds: [] });
  assert.equal((await h.latestFor("r1", A)).quickReportId, "10");
  assert.equal(await h.latestFor("r1", B), null);
});

test("lists are newest first, per report and per instance", async () => {
  const h = createQrHistory(fakeStorage());
  await h.record({ qrId: "r1", instanceKey: A, quickReportId: "1", permissionSetIds: [], deployedAt: "2026-10-01T00:00:00.000Z" });
  await h.record({ qrId: "r1", instanceKey: B, quickReportId: "2", permissionSetIds: [], deployedAt: "2026-10-03T00:00:00.000Z" });
  await h.record({ qrId: "r2", instanceKey: A, quickReportId: "3", permissionSetIds: [], deployedAt: "2026-10-02T00:00:00.000Z" });
  assert.deepEqual((await h.listForReport("r1")).map((e) => e.quickReportId), ["2", "1"]);
  assert.deepEqual((await h.listForInstance(A)).map((e) => e.quickReportId), ["3", "1"]);
});

test("record also remembers the permission sets per instance", async () => {
  const h = createQrHistory(fakeStorage());
  assert.deepEqual(await h.getPermissionSetMemory(A), []);
  await h.record({ qrId: "r1", instanceKey: A, quickReportId: "1", permissionSetIds: ["S", "T"] });
  assert.deepEqual(await h.getPermissionSetMemory(A), ["S", "T"]);
  assert.deepEqual(await h.getPermissionSetMemory(B), []);
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `node --test lib/qr-history.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/qr-history.js`**

```js
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
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `node --test lib/qr-history.test.js && npm test`

- [ ] **Step 5: Commit**

```bash
git add lib/qr-history.js lib/qr-history.test.js
git commit -m "feat(quick-reports): local deploy history and permission-set memory"
```

---

### Task 4: GitHub report library (`lib/qr-library.js`)

**Files:**
- Create: `lib/qr-library.js`
- Test: `lib/qr-library.test.js`

**Interfaces:**
- Produces: `QrLibrary.createQrLibrary({ token, repo, fetchImpl? }) → {`
  - `whoAmI() → Promise<string>` (login)
  - `checkAccess() → Promise<void>`
  - `list(login) → Promise<Report[]>` sorted by name
  - `save(login, input, knownReports) → Promise<Report>`; `input = { id: string|null, name, content, tags: string[], sqlSha?, jsonSha?, createdAt? }`
  - `moveUnowned(login) → Promise<{ moved: string[], skipped: string[] }>` `}`
  - `Report = { id, name, tags, createdAt, updatedAt, content, sqlSha, jsonSha }`
  - Errors: `err.code === "CONFLICT"` (stale sha), `err.code === "PARTIAL_SAVE"` (.sql saved, .json not), plain errors with user-facing text for 401/404/rate limit.
- Also exports `slugify(name)`.

- [ ] **Step 1: Write the failing tests `lib/qr-library.test.js`**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { createQrLibrary, slugify } = require("./qr-library.js");

const REPO = "team/qr-data";

function res(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (body === undefined ? "" : JSON.stringify(body))
  };
}

/** In-memory GitHub: tree, blobs and the contents API with real sha checks. */
function fakeGitHub({ login = "alice", files = {}, failPut, respond } = {}) {
  let n = 0;
  const store = new Map();
  for (const [p, c] of Object.entries(files)) store.set(p, { sha: `sha${++n}`, content: c });
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    const path = decodeURIComponent(new URL(url).pathname);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body, headers: init.headers });
    if (respond) { const r = respond(method, path); if (r) return r; }
    if (path === "/user") return res(200, { login });
    if (path === `/repos/${REPO}`) return res(200, { default_branch: "main" });
    if (path === `/repos/${REPO}/git/trees/main`) {
      return res(200, { truncated: false, tree: [...store].map(([p, f]) => ({ path: p, type: "blob", sha: f.sha })) });
    }
    const blob = path.match(new RegExp(`^/repos/${REPO}/git/blobs/(.+)$`));
    if (blob) {
      const f = [...store.values()].find((x) => x.sha === blob[1]);
      if (!f) return res(404, { message: "Not Found" });
      const b64 = Buffer.from(f.content, "utf8").toString("base64").replace(/(.{60})/g, "$1\n");
      return res(200, { encoding: "base64", content: b64 });
    }
    const contents = path.match(new RegExp(`^/repos/${REPO}/contents/(.+)$`));
    if (contents) {
      const p = contents[1];
      const cur = store.get(p);
      if (failPut && failPut(p, method)) return res(500, { message: "boom" });
      if (method === "PUT") {
        if (cur && !body.sha) return res(422, { message: "\"sha\" wasn't supplied." });
        if (cur && body.sha !== cur.sha) return res(409, { message: "does not match" });
        const sha = `sha${++n}`;
        store.set(p, { sha, content: Buffer.from(body.content, "base64").toString("utf8") });
        return res(cur ? 200 : 201, { content: { path: p, sha } });
      }
      if (method === "DELETE") {
        if (!cur || body.sha !== cur.sha) return res(409, { message: "does not match" });
        store.delete(p);
        return res(200, { commit: {} });
      }
    }
    return res(404, { message: "Not Found" });
  };
  return { fetchImpl, calls, store };
}

const meta = (id, name) => JSON.stringify({ id, name, tags: ["t"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" }, null, 2);
const lib = (gh) => createQrLibrary({ token: "ghp_x", repo: REPO, fetchImpl: gh.fetchImpl });

test("whoAmI returns the token's login and sends the token as a bearer header", async () => {
  const gh = fakeGitHub();
  assert.equal(await lib(gh).whoAmI(), "alice");
  assert.equal(gh.calls[0].headers.Authorization, "Bearer ghp_x");
});

test("checkAccess explains a missing repo; a rejected token and the rate limit get their own text", async () => {
  await assert.rejects(lib(fakeGitHub({ respond: (m, p) => (p === `/repos/${REPO}` ? res(404, {}) : null) })).checkAccess(), /No access to team\/qr-data/);
  await assert.rejects(lib(fakeGitHub({ respond: () => res(401, {}) })).whoAmI(), /GitHub token rejected/);
  await assert.rejects(
    lib(fakeGitHub({ respond: () => res(403, {}, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1760000000" }) })).whoAmI(),
    /rate limit/
  );
});

test("list returns only the user's own folder, with content and shas", async () => {
  const gh = fakeGitHub({ files: {
    "quick-reports/alice/a.sql": "SELECT 'Größe €' FROM dual",
    "quick-reports/alice/a.json": meta("a", "Ärger-Report"),
    "quick-reports/bob/b.sql": "SELECT 2 FROM dual",
    "quick-reports/bob/b.json": meta("b", "B"),
    "quick-reports/c.sql": "SELECT 3 FROM dual",
    "quick-reports/c.json": meta("c", "C")
  } });
  const reports = await lib(gh).list("alice");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].id, "a");
  assert.equal(reports[0].name, "Ärger-Report");
  assert.equal(reports[0].content, "SELECT 'Größe €' FROM dual");
  assert.deepEqual(reports[0].tags, ["t"]);
  assert.equal(reports[0].sqlSha, gh.store.get("quick-reports/alice/a.sql").sha);
  assert.equal(reports[0].jsonSha, gh.store.get("quick-reports/alice/a.json").sha);
});

test("save of a new report writes .sql then .json in the user's folder, non-ASCII intact", async () => {
  const gh = fakeGitHub();
  const saved = await lib(gh).save("alice", { id: null, name: "Größe Report", content: "SELECT 'ü' FROM dual", tags: ["x"] }, []);
  assert.equal(saved.id, "gr-e-report");
  const puts = gh.calls.filter((c) => c.method === "PUT");
  assert.deepEqual(puts.map((c) => c.path), [
    `/repos/${REPO}/contents/quick-reports/alice/gr-e-report.sql`,
    `/repos/${REPO}/contents/quick-reports/alice/gr-e-report.json`
  ]);
  assert.equal(puts[0].body.message, "add QR: Größe Report");
  assert.equal(puts[0].body.branch, "main");
  assert.equal(puts[0].body.sha, undefined);
  const json = JSON.parse(gh.store.get("quick-reports/alice/gr-e-report.json").content);
  assert.deepEqual(Object.keys(json), ["id", "name", "tags", "createdAt", "updatedAt"]);
  assert.equal(json.name, "Größe Report");
  const again = await lib(gh).list("alice");
  assert.equal(again[0].content, "SELECT 'ü' FROM dual");
  assert.equal(saved.sqlSha, gh.store.get("quick-reports/alice/gr-e-report.sql").sha);
});

test("a new report whose slug is taken gets -2", async () => {
  const gh = fakeGitHub({ files: { "quick-reports/alice/my-report.sql": "x", "quick-reports/alice/my-report.json": meta("my-report", "My Report") } });
  const saved = await lib(gh).save("alice", { id: null, name: "my report!", content: "y", tags: [] }, [{ id: "my-report", name: "My Report" }]);
  assert.equal(saved.id, "my-report-2");
});

test("same name in different case is a collision; renaming to itself is not", async () => {
  const gh = fakeGitHub();
  const known = [{ id: "my-report", name: "My Report" }];
  await assert.rejects(lib(gh).save("alice", { id: null, name: " my report ", content: "y", tags: [] }, known), /A Quick Report named "my report" already exists/);
  assert.equal(gh.calls.filter((c) => c.method === "PUT").length, 0);
});

test("update sends the loaded shas, keeps createdAt, uses the update message", async () => {
  const gh = fakeGitHub({ files: { "quick-reports/alice/a.sql": "old", "quick-reports/alice/a.json": meta("a", "A") } });
  const [loaded] = await lib(gh).list("alice");
  const saved = await lib(gh).save("alice", { ...loaded, content: "new" }, [loaded]);
  assert.equal(saved.createdAt, "2026-01-01T00:00:00.000Z");
  assert.notEqual(saved.updatedAt, loaded.updatedAt);
  const puts = gh.calls.filter((c) => c.method === "PUT");
  assert.equal(puts[0].body.message, "update QR: A");
  assert.equal(puts[0].body.sha, loaded.sqlSha);
  assert.equal(gh.store.get("quick-reports/alice/a.sql").content, "new");
});

test("a stale sha is a CONFLICT and nothing is overwritten", async () => {
  const gh = fakeGitHub({ files: { "quick-reports/alice/a.sql": "theirs", "quick-reports/alice/a.json": meta("a", "A") } });
  const [loaded] = await lib(gh).list("alice");
  await assert.rejects(lib(gh).save("alice", { ...loaded, sqlSha: "stale", content: "mine" }, [loaded]), (err) => {
    assert.equal(err.code, "CONFLICT");
    assert.match(err.message, /changed on GitHub/);
    return true;
  });
  assert.equal(gh.store.get("quick-reports/alice/a.sql").content, "theirs");
});

test(".sql saved but .json failed: PARTIAL_SAVE, and a save after reloading succeeds", async () => {
  let failJson = true;
  const gh = fakeGitHub({
    files: { "quick-reports/alice/a.sql": "v1", "quick-reports/alice/a.json": meta("a", "A") },
    failPut: (p) => failJson && p.endsWith(".json")
  });
  const [loaded] = await lib(gh).list("alice");
  await assert.rejects(lib(gh).save("alice", { ...loaded, content: "v2" }, [loaded]), (err) => {
    assert.equal(err.code, "PARTIAL_SAVE");
    assert.match(err.message, /reload/i);
    return true;
  });
  failJson = false;
  const [reloaded] = await lib(gh).list("alice");
  const saved = await lib(gh).save("alice", { ...reloaded, content: "v3" }, [reloaded]);
  assert.equal(saved.content, "v3");
});

test("moveUnowned moves flat reports into the user's folder and skips slugs already there", async () => {
  const gh = fakeGitHub({ files: {
    "quick-reports/a.sql": "flat a", "quick-reports/a.json": meta("a", "A flat"),
    "quick-reports/c.sql": "flat c", "quick-reports/c.json": meta("c", "C"),
    "quick-reports/alice/a.sql": "mine", "quick-reports/alice/a.json": meta("a", "A mine")
  } });
  const result = await lib(gh).moveUnowned("alice");
  assert.deepEqual(result, { moved: ["c"], skipped: ["a"] });
  assert.equal(gh.store.get("quick-reports/alice/c.sql").content, "flat c");
  assert.ok(!gh.store.has("quick-reports/c.sql"));
  assert.ok(!gh.store.has("quick-reports/c.json"));
  assert.equal(gh.store.get("quick-reports/alice/a.sql").content, "mine");
  assert.ok(gh.store.has("quick-reports/a.sql"));
  assert.ok(gh.calls.some((c) => c.method === "PUT" && c.body.message === "move QR to alice: c"));
});

test("slugify matches the Electron app's rule", () => {
  assert.equal(slugify("  My Report! "), "my-report");
  assert.equal(slugify("!!!"), "report");
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `node --test lib/qr-library.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/qr-library.js`**

```js
(function (global) {
  const API = "https://api.github.com";

  /** Same rule as the Electron app's qrFileStore.slugify, so existing files keep their ids. */
  function slugify(name) {
    const slug = String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return slug || "report";
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

  function createQrLibrary({ token, repo, fetchImpl }) {
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
        return Object.assign(new Error("This report changed on GitHub since you loaded it — reload before saving."), { code: "CONFLICT" });
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

    /** slug → { sql: entry, json: entry } for files directly inside `prefix`. */
    function groupBySlug(entries, prefix) {
      const groups = {};
      for (const e of entries) {
        if (!e.path.startsWith(prefix)) continue;
        const m = e.path.slice(prefix.length).match(/^([^/]+)\.(sql|json)$/);
        if (!m) continue;
        (groups[m[1]] = groups[m[1]] || {})[m[2]] = e;
      }
      return groups;
    }

    const ownPrefix = (login) => `quick-reports/${login}/`;

    async function list(login) {
      const groups = groupBySlug(await treeEntries(), ownPrefix(login));
      const reports = await Promise.all(Object.entries(groups)
        .filter(([, g]) => g.sql && g.json)
        .map(async ([slug, g]) => {
          const [metaText, content] = await Promise.all([readBlob(g.json.sha), readBlob(g.sql.sha)]);
          const meta = JSON.parse(metaText);
          return {
            id: meta.id || slug, name: meta.name || slug, tags: meta.tags || [],
            createdAt: meta.createdAt, updatedAt: meta.updatedAt, content,
            sqlSha: g.sql.sha, jsonSha: g.json.sha
          };
        }));
      return reports.sort((a, b) => a.name.localeCompare(b.name));
    }

    async function putFile(path, text, sha, message) {
      const body = { message, content: utf8ToBase64(text), branch: await branch() };
      if (sha) body.sha = sha;
      return (await gh("PUT", `/repos/${repo}/contents/${encodePath(path)}`, body)).content.sha;
    }

    async function deleteFile(path, sha, message) {
      await gh("DELETE", `/repos/${repo}/contents/${encodePath(path)}`, { message, sha, branch: await branch() });
    }

    async function save(login, input, knownReports) {
      const name = String(input.name || "").trim();
      if (!name) throw new Error("Name can't be empty.");
      const target = name.toLowerCase();
      if ((knownReports || []).some((r) => r.id !== input.id && String(r.name).trim().toLowerCase() === target)) {
        throw new Error(`A Quick Report named "${name}" already exists.`);
      }

      let id = input.id;
      if (!id) {
        const taken = new Set(Object.keys(groupBySlug(await treeEntries(), ownPrefix(login))));
        const base = slugify(name);
        id = base;
        for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
      }

      const now = new Date().toISOString();
      const createdAt = input.id && input.createdAt ? input.createdAt : now;
      const message = `${input.id ? "update" : "add"} QR: ${name}`;
      const tags = input.tags || [];
      const prefix = ownPrefix(login);

      const sqlSha = await putFile(`${prefix}${id}.sql`, input.content, input.id ? input.sqlSha : undefined, message);
      let jsonSha;
      try {
        jsonSha = await putFile(`${prefix}${id}.json`, JSON.stringify({ id, name, tags, createdAt, updatedAt: now }, null, 2), input.id ? input.jsonSha : undefined, message);
      } catch (err) {
        throw Object.assign(new Error(`The SQL was saved, but its name/tags file wasn't (${err.message}). Reload the report list, then save again.`), { code: "PARTIAL_SAVE" });
      }
      return { id, name, tags, createdAt, updatedAt: now, content: input.content, sqlSha, jsonSha };
    }

    async function moveUnowned(login) {
      const entries = await treeEntries();
      const flat = groupBySlug(entries, "quick-reports/");
      const own = groupBySlug(entries, ownPrefix(login));
      const moved = [];
      const skipped = [];
      for (const [slug, g] of Object.entries(flat).sort(([a], [b]) => a.localeCompare(b))) {
        if (own[slug] || !g.sql || !g.json) { skipped.push(slug); continue; }
        const message = `move QR to ${login}: ${slug}`;
        try {
          const [sqlText, jsonText] = await Promise.all([readBlob(g.sql.sha), readBlob(g.json.sha)]);
          await putFile(`${ownPrefix(login)}${slug}.sql`, sqlText, undefined, message);
          await putFile(`${ownPrefix(login)}${slug}.json`, jsonText, undefined, message);
          await deleteFile(g.sql.path, g.sql.sha, message);
          await deleteFile(g.json.path, g.json.sha, message);
        } catch (err) {
          throw new Error(`Moving "${slug}" failed — ${err.message}${moved.length ? ` (already moved: ${moved.join(", ")})` : ""}`);
        }
        moved.push(slug);
      }
      return { moved, skipped };
    }

    return { whoAmI, checkAccess, list, save, moveUnowned };
  }

  const api = { createQrLibrary, slugify };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.QrLibrary = api;
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `node --test lib/qr-library.test.js && npm test`
Expected: all pass. If the `gr-e-report` slug assertion fails, the slug rule differs from `slugify` above — fix the code, not the test (the rule must equal the Electron app's).

- [ ] **Step 5: Commit**

```bash
git add lib/qr-library.js lib/qr-library.test.js
git commit -m "feat(quick-reports): GitHub-backed per-user Quick Report library"
```

---

### Task 5: GitHub settings store (`lib/github-settings.js`)

**Files:**
- Create: `lib/github-settings.js`
- Test: `lib/github-settings.test.js`

**Interfaces:**
- Consumes: `CredentialCrypto.encryptText(key, text)`, `CredentialCrypto.decryptText(key, enc)` from `lib/credential-crypto.js`.
- Produces: `GithubSettings.DEFAULT_REPO`; `GithubSettings.createGithubSettings(storage) → { get() → { repo, login, hasToken }, save({ token, repo }, masterKey, verify: (token, repo) => Promise<login>) → { repo, login }, getToken(masterKey) → Promise<string> }`. `getToken` throws `err.code === "GITHUB_NOT_CONFIGURED"` when nothing is saved.

- [ ] **Step 1: Write the failing test `lib/github-settings.test.js`**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const CredentialCrypto = require("./credential-crypto.js");
const { createGithubSettings, DEFAULT_REPO } = require("./github-settings.js");

function fakeStorage() {
  const data = {};
  return { data, get: async (k) => ({ [k]: data[k] }), set: async (o) => { Object.assign(data, o); } };
}
const key = () => CredentialCrypto.deriveKey("pw", CredentialCrypto.generateSalt());

test("defaults: shared data repo, no login, no token", async () => {
  assert.equal(DEFAULT_REPO, "Brasijoe/ifs-quick-report-deployer-data");
  assert.deepEqual(await createGithubSettings(fakeStorage()).get(), { repo: DEFAULT_REPO, login: null, hasToken: false });
});

test("save verifies first, trims, stores the login and only an encrypted token", async () => {
  const storage = fakeStorage();
  const s = createGithubSettings(storage);
  const k = await key();
  const seen = [];
  const result = await s.save({ token: "  ghp_secret \n", repo: " team/qr-data " }, k, async (t, r) => { seen.push([t, r]); return "alice"; });
  assert.deepEqual(seen, [["ghp_secret", "team/qr-data"]]);
  assert.deepEqual(result, { repo: "team/qr-data", login: "alice" });
  assert.ok(!JSON.stringify(storage.data).includes("ghp_secret"));
  assert.deepEqual(await s.get(), { repo: "team/qr-data", login: "alice", hasToken: true });
  assert.equal(await s.getToken(k), "ghp_secret");
});

test("a bad repo name is refused before any check", async () => {
  const s = createGithubSettings(fakeStorage());
  let called = false;
  await assert.rejects(s.save({ token: "t", repo: "not a repo" }, await key(), async () => { called = true; return "x"; }), /owner\/name/);
  assert.equal(called, false);
});

test("a failed check stores nothing", async () => {
  const storage = fakeStorage();
  const s = createGithubSettings(storage);
  await assert.rejects(s.save({ token: "t", repo: "a/b" }, await key(), async () => { throw new Error("GitHub token rejected"); }),
    /GitHub check failed, settings not saved — GitHub token rejected/);
  assert.deepEqual(storage.data, {});
});

test("getToken without a saved token says where to add one", async () => {
  await assert.rejects(createGithubSettings(fakeStorage()).getToken(await key()), (err) => err.code === "GITHUB_NOT_CONFIGURED" && /Basic Data/.test(err.message));
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `node --test lib/github-settings.test.js`

- [ ] **Step 3: Implement `lib/github-settings.js`**

```js
(function (global) {
  const CredentialCrypto = typeof require === "function" ? require("./credential-crypto.js") : global.CredentialCrypto;
  const KEY = "githubSettings";
  const DEFAULT_REPO = "Brasijoe/ifs-quick-report-deployer-data";

  /** GitHub token for the Quick Report library, encrypted with the same master key as the IFS
   *  client secrets. The login is resolved once at save time (`verify`), so it can only change
   *  together with the token. */
  function createGithubSettings(storage) {
    const read = async () => (await storage.get(KEY))[KEY] || {};

    async function get() {
      const s = await read();
      return { repo: s.repo || DEFAULT_REPO, login: s.login || null, hasToken: !!s.encryptedToken };
    }

    async function save({ token, repo }, masterKey, verify) {
      const cleanToken = String(token || "").trim();
      const cleanRepo = String(repo || "").trim() || DEFAULT_REPO;
      if (!cleanToken) throw new Error("Enter a GitHub token.");
      if (!/^[\w.-]+\/[\w.-]+$/.test(cleanRepo)) throw new Error(`"${cleanRepo}" isn't a repo name — use owner/name.`);
      let login;
      try {
        login = await verify(cleanToken, cleanRepo);
      } catch (e) {
        throw new Error(`GitHub check failed, settings not saved — ${e.message}`);
      }
      const encryptedToken = await CredentialCrypto.encryptText(masterKey, cleanToken);
      await storage.set({ [KEY]: { repo: cleanRepo, login, encryptedToken } });
      return { repo: cleanRepo, login };
    }

    async function getToken(masterKey) {
      const s = await read();
      if (!s.encryptedToken) {
        throw Object.assign(new Error("No GitHub token saved — add one in Basic Data to use Quick Reports."), { code: "GITHUB_NOT_CONFIGURED" });
      }
      return CredentialCrypto.decryptText(masterKey, s.encryptedToken);
    }

    return { get, save, getToken };
  }

  const api = { createGithubSettings, DEFAULT_REPO };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.GithubSettings = api;
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `node --test lib/github-settings.test.js && npm test`

- [ ] **Step 5: Commit**

```bash
git add lib/github-settings.js lib/github-settings.test.js
git commit -m "feat(quick-reports): encrypted GitHub token + data repo settings"
```

---

### Task 6: Update check (`lib/update-check.js`)

**Files:**
- Create: `lib/update-check.js`
- Test: `lib/update-check.test.js`

**Interfaces:**
- Produces: `UpdateCheck.RELEASES_URL`, `UpdateCheck.compareVersions(a, b) → -1|0|1`, `UpdateCheck.checkForUpdate(currentVersion, fetchImpl?) → Promise<{ available: boolean, currentVersion, version?, zipUrl?: string|null, htmlUrl?, reason? }>` (never throws).

- [ ] **Step 1: Write the failing test `lib/update-check.test.js`**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { compareVersions, checkForUpdate, RELEASES_URL } = require("./update-check.js");

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const release = (tag, assets = []) => ({ tag_name: tag, html_url: `https://github.com/Brasijoe/NovacuraBuddy/releases/tag/${tag}`, assets });

test("compareVersions is numeric and ignores a leading v", () => {
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("v1.2.0", "1.2"), 0);
  assert.equal(compareVersions("1.2.3", "1.3.0"), -1);
});

test("newer release: available, with the zip asset's download url", async () => {
  let url;
  const info = await checkForUpdate("0.1.0", async (u) => { url = u; return res(200, release("v0.2.0", [
    { name: "other.zip", browser_download_url: "https://x/other.zip" },
    { name: "NovacuraBuddy-v0.2.0.zip", browser_download_url: "https://x/nb.zip" }
  ])); });
  assert.equal(url, RELEASES_URL);
  assert.deepEqual(info, {
    available: true, currentVersion: "0.1.0", version: "0.2.0", zipUrl: "https://x/nb.zip",
    htmlUrl: "https://github.com/Brasijoe/NovacuraBuddy/releases/tag/v0.2.0"
  });
});

test("release without the zip asset falls back to the release page", async () => {
  const info = await checkForUpdate("0.1.0", async () => res(200, release("v0.2.0")));
  assert.equal(info.available, true);
  assert.equal(info.zipUrl, null);
});

test("same or older release: not available (covers the just-installed update)", async () => {
  assert.equal((await checkForUpdate("0.2.0", async () => res(200, release("v0.2.0")))).available, false);
  assert.equal((await checkForUpdate("0.3.0", async () => res(200, release("v0.2.0")))).available, false);
});

test("no releases yet (404) and network errors are quiet", async () => {
  assert.deepEqual(await checkForUpdate("0.1.0", async () => res(404, {})), { available: false, currentVersion: "0.1.0", reason: "HTTP 404" });
  const err = await checkForUpdate("0.1.0", async () => { throw new Error("offline"); });
  assert.equal(err.available, false);
  assert.equal(err.reason, "offline");
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `node --test lib/update-check.test.js`

- [ ] **Step 3: Implement `lib/update-check.js`**

```js
(function (global) {
  const RELEASES_URL = "https://api.github.com/repos/Brasijoe/NovacuraBuddy/releases/latest";

  const parts = (v) => String(v).trim().replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);

  function compareVersions(a, b) {
    const pa = parts(a);
    const pb = parts(b);
    for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  }

  /** Latest GitHub Release vs the installed version. Never throws: a failed check just means
   *  "no banner". `currentVersion` is echoed so a stored result can be recognised as stale once
   *  the user has installed the update. */
  async function checkForUpdate(currentVersion, fetchImpl) {
    const doFetch = fetchImpl || ((...args) => fetch(...args));
    try {
      const res = await doFetch(RELEASES_URL, { headers: { Accept: "application/vnd.github+json" } });
      if (!res.ok) return { available: false, currentVersion, reason: `HTTP ${res.status}` };
      const rel = await res.json();
      const version = String(rel.tag_name || "").replace(/^v/i, "");
      if (!version || compareVersions(version, currentVersion) <= 0) return { available: false, currentVersion };
      const asset = (rel.assets || []).find((a) => a.name === `NovacuraBuddy-v${version}.zip`);
      return { available: true, currentVersion, version, zipUrl: asset ? asset.browser_download_url : null, htmlUrl: rel.html_url };
    } catch (e) {
      return { available: false, currentVersion, reason: e.message };
    }
  }

  const api = { RELEASES_URL, compareVersions, checkForUpdate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.UpdateCheck = api;
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `node --test lib/update-check.test.js && npm test`

- [ ] **Step 5: Commit**

```bash
git add lib/update-check.js lib/update-check.test.js
git commit -m "feat: check GitHub Releases for a newer NovacuraBuddy version"
```

---

### Task 7: Quick Report service (`lib/qr-service.js`)

Orchestration used by the background worker; keeps `background.js` a thin router.

**Files:**
- Create: `lib/qr-service.js`
- Test: `lib/qr-service.test.js`

**Interfaces:**
- Consumes: `QrDeploy` (Task 2), `QrHistory` instance (Task 3), `QrLibrary` (Task 4), `GithubSettings` instance (Task 5), and the existing instance store's `getIfsAuthToken(baseUrl, masterKey, fetchImpl)` / `clearIfsAuthToken(baseUrl)`.
- Produces: `QrService.createQrService({ instanceStore, settings, history, cacheStorage, fetchImpl? }) → {`
  - `getGithubSettings() → { repo, login, hasToken }`
  - `saveGithubSettings({ token, repo }, masterKey) → { repo, login }`
  - `listReports(masterKey) → { reports, fetchedAt }` (also refreshes the cache)
  - `getCachedReports() → { login, reports, fetchedAt } | null` (null if cache belongs to another login)
  - `saveReport(masterKey, input) → Report`
  - `moveUnowned(masterKey) → { moved, skipped }`
  - `listPermissionSets(baseUrl, masterKey) → { sets, remembered }`
  - `deploy(masterKey, { baseUrl, report, permissionSetIds, forceQuickReportId }) → outcome` (records history only on `deployed`)
  - `historyForReport(qrId)`, `historyForInstance(baseUrl)` `}`

- [ ] **Step 1: Write the failing test `lib/qr-service.test.js`**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const CredentialCrypto = require("./credential-crypto.js");
const { createGithubSettings } = require("./github-settings.js");
const { createQrHistory } = require("./qr-history.js");
const { createQrService } = require("./qr-service.js");

const IFS = "https://ifs.example.com";

function fakeStorage() {
  const data = {};
  return { data, get: async (k) => ({ [k]: data[k] }), set: async (o) => { Object.assign(data, o); } };
}
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body ?? "") });

/** One fetch for both hosts: a tiny GitHub (alice, one report) and a tiny IFS. */
function fakeNet({ ifsExisting = [] } = {}) {
  const calls = [];
  const files = new Map([
    ["quick-reports/alice/r1.sql", { sha: "s1", content: "SELECT 1 FROM dual" }],
    ["quick-reports/alice/r1.json", { sha: "s2", content: JSON.stringify({ id: "r1", name: "Report One", tags: [], createdAt: "c", updatedAt: "u" }) }]
  ]);
  let lob = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const path = decodeURIComponent(u.pathname) + u.search;
    calls.push({ host: u.host, method, path });
    if (u.host === "api.github.com") {
      if (path === "/user") return res(200, { login: "alice" });
      if (path === "/repos/team/qr-data") return res(200, { default_branch: "main" });
      if (path.startsWith("/repos/team/qr-data/git/trees/main")) return res(200, { tree: [...files].map(([p, f]) => ({ path: p, type: "blob", sha: f.sha })) });
      const blob = path.match(/git\/blobs\/(.+)$/);
      if (blob) { const f = [...files.values()].find((x) => x.sha === blob[1]); return res(200, { content: Buffer.from(f.content).toString("base64") }); }
      if (method === "PUT") return res(201, { content: { sha: `new-${calls.length}` } });
    }
    if (u.host === "ifs.example.com") {
      if (method === "GET" && path.includes("QuickReportSet?$select")) return res(200, { value: ifsExisting });
      if (method === "GET" && path.includes("PermissionSets?")) return res(200, { value: [{ Role: "SALES", Description: "Sales", FndRoleDeliveryType: null }] });
      if (method === "POST" && path.endsWith("/FndTempLobs")) { lob++; return res(201, { LobId: `L${lob}`, "@odata.etag": `E${lob}` }); }
      if (method === "PATCH" && path.endsWith("/ClobData")) return res(204);
      if (method === "POST" && path.endsWith("/CheckSqlExpressionAction")) return res(204);
      if (method === "POST" && path.endsWith("/QuickReportVirtualSet")) return res(201, { Objkey: "O1" });
      if (method === "POST" && path.endsWith("/SaveNewAction")) return res(200, { value: "77" });
      if (method === "POST" && path.includes("CleanupVirtualEntity")) return res(204);
      if (method === "GET" && /QuickReportSet\(QuickReportId=77\)$/.test(path)) return res(200, { "@odata.etag": "QE" });
      if (method === "PATCH" && path.includes("QuickReportSet(QuickReportId=77)")) return res(200, { QuickReportId: "77" });
      if (method === "POST" && path.endsWith("/GrantProjections")) return res(204);
    }
    throw new Error(`unexpected ${method} ${u.host}${path}`);
  };
  return { fetchImpl, calls };
}

async function setup(netOpts) {
  const net = fakeNet(netOpts);
  const local = fakeStorage();
  const settings = createGithubSettings(local);
  const masterKey = await CredentialCrypto.deriveKey("pw", CredentialCrypto.generateSalt());
  const instanceStore = { getIfsAuthToken: async () => "IFS-T", clearIfsAuthToken: () => {} };
  const service = createQrService({ instanceStore, settings, history: createQrHistory(local), cacheStorage: local, fetchImpl: net.fetchImpl });
  return { net, local, service, masterKey };
}

const report = { id: "r1", name: "Report One", content: "SELECT 1 FROM dual" };

test("without a GitHub token, listing explains where to add one", async () => {
  const { service, masterKey } = await setup();
  await assert.rejects(service.listReports(masterKey), (e) => e.code === "GITHUB_NOT_CONFIGURED");
});

test("saveGithubSettings checks repo access and the login, then lists that user's reports and caches them", async () => {
  const { service, masterKey } = await setup();
  assert.deepEqual(await service.saveGithubSettings({ token: "ghp", repo: "team/qr-data" }, masterKey), { repo: "team/qr-data", login: "alice" });
  const { reports } = await service.listReports(masterKey);
  assert.deepEqual(reports.map((r) => r.id), ["r1"]);
  const cache = await service.getCachedReports();
  assert.equal(cache.login, "alice");
  assert.deepEqual(cache.reports.map((r) => r.id), ["r1"]);
});

test("saveReport checks names against the cached list", async () => {
  const { service, masterKey } = await setup();
  await service.saveGithubSettings({ token: "ghp", repo: "team/qr-data" }, masterKey);
  await service.listReports(masterKey);
  await assert.rejects(service.saveReport(masterKey, { id: null, name: "report one", content: "x", tags: [] }), /already exists/);
  const saved = await service.saveReport(masterKey, { id: null, name: "Report Two", content: "x", tags: [] });
  assert.equal(saved.id, "report-two");
  assert.deepEqual((await service.getCachedReports()).reports.map((r) => r.id), ["r1", "report-two"]);
});

test("deploy records history + memory; the next deploy updates the same IFS record without a name lookup", async () => {
  const { service, masterKey, net } = await setup();
  const first = await service.deploy(masterKey, { baseUrl: `${IFS}/`, report, permissionSetIds: ["SALES"] });
  assert.deepEqual(first, { status: "deployed", quickReportId: "77" });
  const [entry] = await service.historyForReport("r1");
  assert.equal(entry.instanceKey, IFS);
  assert.equal(entry.quickReportId, "77");
  assert.deepEqual((await service.listPermissionSets(IFS, masterKey)).remembered, ["SALES"]);

  net.calls.length = 0;
  await service.deploy(masterKey, { baseUrl: IFS, report, permissionSetIds: [] });
  assert.ok(!net.calls.some((c) => c.path.includes("$filter")));
  assert.ok(net.calls.some((c) => c.method === "PATCH" && c.path.includes("QuickReportSet(QuickReportId=77)")));
});

test("needsConfirmation and failures write no history", async () => {
  const { service, masterKey } = await setup({ ifsExisting: [{ QuickReportId: "5", Description: "Report One" }] });
  const outcome = await service.deploy(masterKey, { baseUrl: IFS, report, permissionSetIds: [] });
  assert.equal(outcome.status, "needsConfirmation");
  assert.deepEqual(await service.historyForInstance(IFS), []);
});

test("listPermissionSets returns the sets and an empty memory at first", async () => {
  const { service, masterKey } = await setup();
  assert.deepEqual(await service.listPermissionSets(IFS, masterKey), { sets: [{ id: "SALES", name: "Sales" }], remembered: [] });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `node --test lib/qr-service.test.js`

- [ ] **Step 3: Implement `lib/qr-service.js`**

```js
(function (global) {
  const req = (path, name) => (typeof require === "function" ? require(path) : global[name]);
  const QrDeploy = req("./qr-deploy.js", "QrDeploy");
  const QrLibrary = req("./qr-library.js", "QrLibrary");

  const CACHE_KEY = "qrCache"; // { login, reports, fetchedAt }

  /** Everything the background worker does for Quick Reports, behind one object so the message
   *  router stays thin and the flows are testable without Chrome. */
  function createQrService({ instanceStore, settings, history, cacheStorage, fetchImpl }) {
    const instanceKey = (baseUrl) => new URL(String(baseUrl).trim()).origin;

    async function libraryFor(masterKey) {
      const token = await settings.getToken(masterKey);
      const { repo, login } = await settings.get();
      return { lib: QrLibrary.createQrLibrary({ token, repo, fetchImpl }), login };
    }

    async function readCache() {
      return (await cacheStorage.get(CACHE_KEY))[CACHE_KEY] || null;
    }
    async function writeCache(login, reports) {
      const cache = { login, reports, fetchedAt: Date.now() };
      await cacheStorage.set({ [CACHE_KEY]: cache });
      return cache;
    }

    function ifsClient(baseUrl, masterKey) {
      return QrDeploy.createIfsClient({
        baseUrl: instanceKey(baseUrl),
        getToken: () => instanceStore.getIfsAuthToken(baseUrl, masterKey, fetchImpl),
        clearToken: () => instanceStore.clearIfsAuthToken(baseUrl),
        fetchImpl
      });
    }

    return {
      getGithubSettings: () => settings.get(),

      saveGithubSettings: ({ token, repo }, masterKey) =>
        settings.save({ token, repo }, masterKey, async (cleanToken, cleanRepo) => {
          const lib = QrLibrary.createQrLibrary({ token: cleanToken, repo: cleanRepo, fetchImpl });
          await lib.checkAccess();
          return lib.whoAmI();
        }),

      async listReports(masterKey) {
        const { lib, login } = await libraryFor(masterKey);
        const cache = await writeCache(login, await lib.list(login));
        return { reports: cache.reports, fetchedAt: cache.fetchedAt };
      },

      async getCachedReports() {
        const cache = await readCache();
        const { login } = await settings.get();
        return cache && cache.login === login ? cache : null;
      },

      async saveReport(masterKey, input) {
        const { lib, login } = await libraryFor(masterKey);
        const cache = await readCache();
        const known = cache && cache.login === login ? cache.reports : await lib.list(login);
        const saved = await lib.save(login, input, known);
        await writeCache(login, [...known.filter((r) => r.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)));
        return saved;
      },

      async moveUnowned(masterKey) {
        const { lib, login } = await libraryFor(masterKey);
        return lib.moveUnowned(login);
      },

      async listPermissionSets(baseUrl, masterKey) {
        const sets = await QrDeploy.listPermissionSets(ifsClient(baseUrl, masterKey));
        return { sets, remembered: await history.getPermissionSetMemory(instanceKey(baseUrl)) };
      },

      async deploy(masterKey, { baseUrl, report, permissionSetIds, forceQuickReportId }) {
        const key = instanceKey(baseUrl);
        const prior = await history.latestFor(report.id, key);
        const outcome = await QrDeploy.deployQuickReport(ifsClient(baseUrl, masterKey), {
          report: { id: report.id, name: report.name, content: report.content },
          priorQuickReportId: prior ? prior.quickReportId : null,
          forceQuickReportId: forceQuickReportId || null,
          permissionSetIds: permissionSetIds || []
        });
        if (outcome.status === "deployed") {
          await history.record({ qrId: report.id, instanceKey: key, quickReportId: outcome.quickReportId, permissionSetIds: permissionSetIds || [] });
        }
        return outcome;
      },

      historyForReport: (qrId) => history.listForReport(qrId),
      historyForInstance: (baseUrl) => history.listForInstance(instanceKey(baseUrl))
    };
  }

  const api = { createQrService };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.QrService = api;
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `node --test lib/qr-service.test.js && npm test`

- [ ] **Step 5: Commit**

```bash
git add lib/qr-service.js lib/qr-service.test.js
git commit -m "feat(quick-reports): service tying library, deploy and history together"
```

---

### Task 8: Background + manifest wiring

**Files:**
- Modify: `background.js` (importScripts list at top; new constants/functions after `instanceStore` creation; new `case`s in the `onMessage` switch before `default:`; the log redaction line; the `catch` response)
- Modify: `manifest.json`
- Modify: `manifest.test.js`

**Interfaces:**
- Consumes: Tasks 3, 5, 6, 7.
- Produces (messages, all answer `{ ok, ... }`; errors `{ ok: false, error, needsMasterPassword, code }`):
  - `QR_GET_SETTINGS` → `{ repo, login, hasToken }`
  - `QR_SAVE_SETTINGS { token, repo, masterPassword }` → `{ repo, login }`
  - `QR_LIST { masterPassword }` → `{ reports, fetchedAt }`
  - `QR_LIST_CACHED` → `{ cache }`
  - `QR_SAVE { report, masterPassword }` → `{ report }`
  - `QR_MOVE_UNOWNED { masterPassword }` → `{ moved, skipped }`
  - `QR_PERMISSION_SETS { baseUrl, masterPassword }` → `{ sets, remembered }`
  - `QR_DEPLOY { baseUrl, report, permissionSetIds, forceQuickReportId, masterPassword }` → `{ outcome }`
  - `QR_HISTORY { qrId } | { baseUrl }` → `{ deployments }`
  - `GET_UPDATE_INFO` → `{ info, dismissed }`; `DISMISS_UPDATE { version }` → `{}`

- [ ] **Step 1: Write the failing manifest tests (append to `manifest.test.js`)**

```js
const fs = require("node:fs");
const path = require("node:path");

test("manifest grants what Quick Reports and the update check need", () => {
  assert.ok(manifest.permissions.includes("downloads"));
  assert.ok(manifest.host_permissions.includes("https://api.github.com/*"));
});

test("every script background.js imports exists", () => {
  const src = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
  const block = src.match(/importScripts\(([\s\S]*?)\);/)[1];
  const files = [...block.matchAll(/"([^"]+\.js)"/g)].map((m) => m[1]);
  for (const f of ["lib/qr-deploy.js", "lib/qr-history.js", "lib/qr-library.js", "lib/github-settings.js", "lib/qr-service.js", "lib/update-check.js"]) {
    assert.ok(files.includes(f), `importScripts is missing ${f}`);
  }
  for (const f of files) assert.ok(fs.existsSync(path.join(__dirname, f)), `${f} does not exist`);
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `node --test manifest.test.js`
Expected: FAIL on `downloads` and on the missing imports.

- [ ] **Step 3: Update `manifest.json`**

Add `"downloads"` to the end of `permissions` and `"https://api.github.com/*"` to `host_permissions`, keeping the existing one-line array style:

```json
  "permissions": ["storage", "sidePanel", "webRequest", "debugger", "alarms", "unlimitedStorage", "tabs", "downloads"],
  "host_permissions": ["https://build.novacura.com/*", "https://api.github.com/*"],
```

- [ ] **Step 4: Wire `background.js`**

Extend the `importScripts(...)` list (append after `"lib/flow-token.js"`):

```js
  "lib/flow-token.js",
  "lib/qr-deploy.js",
  "lib/qr-history.js",
  "lib/qr-library.js",
  "lib/github-settings.js",
  "lib/qr-service.js",
  "lib/update-check.js"
```

Directly after the `globalThis.__recorderInstanceStore = instanceStore;` line add:

```js
const qrService = QrService.createQrService({
  instanceStore,
  settings: GithubSettings.createGithubSettings(chrome.storage.local),
  history: QrHistory.createQrHistory(chrome.storage.local),
  cacheStorage: chrome.storage.local
});

// Update notice: the result is stored so the side panel only reads it. `currentVersion` in the
// stored info makes it stale the moment the user installs the update (no lingering banner).
const UPDATE_INFO_KEY = "updateInfo";
const UPDATE_DISMISSED_KEY = "updateDismissed";
const UPDATE_ALARM = "update-check";
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function runUpdateCheck() {
  const info = await UpdateCheck.checkForUpdate(chrome.runtime.getManifest().version);
  if (info.reason) log("Update check:", info.reason);
  const stored = { ...info, checkedAt: Date.now() };
  await chrome.storage.local.set({ [UPDATE_INFO_KEY]: stored });
  return stored;
}

async function refreshUpdateInfoIfStale() {
  const { [UPDATE_INFO_KEY]: info } = await chrome.storage.local.get(UPDATE_INFO_KEY);
  const fresh = info && Date.now() - info.checkedAt < UPDATE_INTERVAL_MS && info.currentVersion === chrome.runtime.getManifest().version;
  return fresh ? info : runUpdateCheck();
}

chrome.alarms.get(UPDATE_ALARM, (existing) => {
  if (!existing) chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: UPDATE_INTERVAL_MS / 60000 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) runUpdateCheck().catch((e) => logError("Update check failed:", e.message));
});
refreshUpdateInfoIfStale().catch((e) => logError("Update check failed:", e.message));
```

Replace the log-redaction lines inside the listener:

```js
      const { masterPassword, fields, token, report, ...safeMessage } = message;
      log("Message:", message.type, fields ? { ...safeMessage, fields: { ...fields, secretPayload: "[redacted]" } } : safeMessage, report ? { report: report.id } : "");
```

Directly after those two redaction lines add the master-key helper:

```js
      const masterKey = () => instanceStore.ensureMasterKey(IfsInstances.createOneShotPrompt(message.masterPassword));
```

Add these cases before `default:`:

```js
        case "QR_GET_SETTINGS":
          return sendResponse({ ok: true, ...(await qrService.getGithubSettings()) });
        case "QR_SAVE_SETTINGS":
          return sendResponse({ ok: true, ...(await qrService.saveGithubSettings({ token: message.token, repo: message.repo }, await masterKey())) });
        case "QR_LIST":
          return sendResponse({ ok: true, ...(await qrService.listReports(await masterKey())) });
        case "QR_LIST_CACHED":
          return sendResponse({ ok: true, cache: await qrService.getCachedReports() });
        case "QR_SAVE":
          return sendResponse({ ok: true, report: await qrService.saveReport(await masterKey(), message.report) });
        case "QR_MOVE_UNOWNED":
          return sendResponse({ ok: true, ...(await qrService.moveUnowned(await masterKey())) });
        case "QR_PERMISSION_SETS":
          return sendResponse({ ok: true, ...(await qrService.listPermissionSets(message.baseUrl, await masterKey())) });
        case "QR_DEPLOY":
          return sendResponse({ ok: true, outcome: await qrService.deploy(await masterKey(), message) });
        case "QR_HISTORY":
          return sendResponse({
            ok: true,
            deployments: message.qrId ? await qrService.historyForReport(message.qrId) : await qrService.historyForInstance(message.baseUrl)
          });
        case "GET_UPDATE_INFO": {
          const info = await refreshUpdateInfoIfStale();
          const { [UPDATE_DISMISSED_KEY]: dismissedVersion } = await chrome.storage.local.get(UPDATE_DISMISSED_KEY);
          return sendResponse({ ok: true, info, dismissed: !!info.available && info.version === dismissedVersion });
        }
        case "DISMISS_UPDATE":
          await chrome.storage.local.set({ [UPDATE_DISMISSED_KEY]: message.version });
          return sendResponse({ ok: true });
```

Change the `catch` response line to also pass the error code:

```js
      sendResponse({ ok: false, error: e.message, code: e.code, needsMasterPassword: e.code === "MASTER_PASSWORD_REQUIRED" });
```

Note: `QR_DEPLOY` passes the whole `message` to `qrService.deploy`; it only reads `baseUrl, report, permissionSetIds, forceQuickReportId`.

- [ ] **Step 5: Run tests, expect PASS; check the token can't be logged**

Run: `npm test`
Run: `grep -n "log(\"Message:\"" background.js` — confirm the destructuring line above it removes `token`, `masterPassword`, `fields`, `report`.

- [ ] **Step 6: Load-check the worker**

In Chrome: `chrome://extensions` → NovacuraBuddy → Reload → "service worker" link → Console. Expected: no errors; within a few seconds either nothing or a line `[IFS Projection Tracker] Update check: HTTP 404` (no release exists yet — that is correct and quiet).

- [ ] **Step 7: Commit**

```bash
git add background.js manifest.json manifest.test.js
git commit -m "feat(quick-reports): background messages, update alarm, manifest permissions"
```

---

### Task 9: Basic Data — GitHub section

**Files:**
- Modify: `sidepanel.html` (inside `<section id="panel-basic-data">`, after `</form>` of `#instanceForm`)
- Modify: `panels/basic-data.js` (append)
- Modify: `sidepanel.js` (call `refreshGithubStatus()` at init)

**Interfaces:**
- Consumes: messages `QR_GET_SETTINGS`, `QR_SAVE_SETTINGS`, `QR_MOVE_UNOWNED`; `send`, `actionOrShowError`, `showNotice`, `masterPasswordOf` from `panels/common.js`.
- Produces: global `refreshGithubStatus()`; sets global `qrLoadedOnce = false` after a save (declared in Task 10's `panels/quick-reports.js`; guard with `typeof`).

- [ ] **Step 1: Add markup to `sidepanel.html`**

```html
      <hr class="section-divider" />
      <h2>GitHub (Quick Reports)</h2>
      <p id="githubStatus" class="list-count"></p>
      <form id="githubForm" class="instance-form">
        <input id="githubRepo" placeholder="owner/repo" required />
        <input id="githubToken" type="password" placeholder="GitHub personal access token (repo access)" required />
        <input id="githubMasterPassword" type="password" placeholder="Master password (if locked)" />
        <button type="submit" class="btn-primary">Save GitHub settings</button>
      </form>
      <button id="githubMoveBtn" class="btn-ghost" hidden title="One-time: move reports saved before per-user folders into your own folder">Move unowned reports into my folder</button>
```

- [ ] **Step 2: Append to `panels/basic-data.js`**

```js
async function refreshGithubStatus() {
  const response = await send({ type: "QR_GET_SETTINGS" });
  if (!response.ok) return;
  const repoField = document.getElementById("githubRepo");
  if (!repoField.value) repoField.value = response.repo;
  document.getElementById("githubStatus").textContent = response.hasToken
    ? `Connected as ${response.login} → ${response.repo}`
    : "No GitHub token saved yet — Quick Reports need one.";
  document.getElementById("githubMoveBtn").hidden = !response.hasToken;
}

document.getElementById("githubForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = "Checking GitHub…";
  const response = await actionOrShowError({
    type: "QR_SAVE_SETTINGS",
    repo: document.getElementById("githubRepo").value,
    token: document.getElementById("githubToken").value,
    masterPassword: document.getElementById("githubMasterPassword").value || masterPasswordOf()
  });
  submitBtn.disabled = false;
  submitBtn.textContent = "Save GitHub settings";
  if (!response) return;
  document.getElementById("githubToken").value = "";
  document.getElementById("githubMasterPassword").value = "";
  showNotice(`GitHub OK — saved as ${response.login} for ${response.repo}.`);
  if (typeof qrLoadedOnce !== "undefined") qrLoadedOnce = false; // Quick Reports tab reloads on next open
  refreshGithubStatus();
  refreshLockStatus();
});

// Two clicks instead of a confirm() dialog: the move rewrites files in the shared repo.
document.getElementById("githubMoveBtn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  if (!btn.dataset.armed) {
    btn.dataset.armed = "1";
    btn.textContent = "Click again to move them now";
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = "Move unowned reports into my folder"; }, 5000);
    return;
  }
  delete btn.dataset.armed;
  btn.disabled = true;
  btn.textContent = "Moving…";
  const response = await actionOrShowError({ type: "QR_MOVE_UNOWNED", masterPassword: masterPasswordOf() });
  btn.disabled = false;
  btn.textContent = "Move unowned reports into my folder";
  if (!response) return;
  const skipped = response.skipped.length ? ` Skipped (already in your folder or incomplete): ${response.skipped.join(", ")}.` : "";
  showNotice(`Moved ${response.moved.length} report(s) into your folder.${skipped}`);
  if (typeof qrLoadedOnce !== "undefined") qrLoadedOnce = false;
});
```

- [ ] **Step 3: Call it at init in `sidepanel.js`**

After `refreshInstances();` add:

```js
refreshGithubStatus();
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: still all pass (UI has no unit tests; nothing should break).

- [ ] **Step 5: Manual check**

Reload the extension, open the side panel → Basic Data. Expected: "No GitHub token saved yet…" and the repo field pre-filled with `Brasijoe/ifs-quick-report-deployer-data`. Save a real token: notice "GitHub OK — saved as <login> …", status line updates, Move button appears. Save a wrong token: red banner "GitHub check failed, settings not saved — GitHub token rejected — check it in Basic Data."

- [ ] **Step 6: Commit**

```bash
git add sidepanel.html panels/basic-data.js sidepanel.js
git commit -m "feat(quick-reports): GitHub token + data repo settings in Basic Data"
```

---

### Task 10: Quick Reports tab, shared deploy form, update banner

**Files:**
- Create: `panels/qr-deploy-form.js`, `panels/quick-reports.js`, `panels/update-banner.js`
- Modify: `sidepanel.html` (tab button, panel section, update banner div, script tags)
- Modify: `sidepanel.js` (TABS list, first-open load, init calls)
- Modify: `sidepanel.css` (append Quick Reports styles; let tabs wrap)

**Interfaces:**
- Consumes: messages from Task 8; `send`, `showError`, `showNotice`, `clearError`, `sendOrShowError`, `masterPasswordOf` (`panels/common.js`); globals `Fuse` and `QrSearch` (Task 1).
- Produces: `renderDeployForm(container, getReport, { send, onDeployed, onError })` where `getReport()` returns `{ id, name, content }` or `null` (null → "save first" error); `onDeployed({ baseUrl, status, quickReportId })`. Globals `qrLoadedOnce`, `refreshQuickReports()`, `initQuickReportsPanel()`, `openQrEditor(id|null)`, `refreshUpdateBanner()`.

- [ ] **Step 1: Create `panels/qr-deploy-form.js`**

```js
/** Instance → permission sets → Deploy, shared by the Quick Reports tab and the editor page.
 *  `getReport()` returns the report to deploy, or null when it can't be deployed yet (unsaved
 *  edits). Never writes history — the background does that after a finished deploy. */
function renderDeployForm(container, getReport, { send, onDeployed, onError }) {
  container.innerHTML = "";
  container.classList.add("deploy-form");

  const select = document.createElement("select");
  const sets = document.createElement("div");
  sets.className = "checklist";
  const actions = document.createElement("div");
  actions.className = "deploy-actions";
  const deployBtn = document.createElement("button");
  deployBtn.className = "btn-primary";
  deployBtn.textContent = "Deploy";
  deployBtn.disabled = true;
  actions.appendChild(deployBtn);
  container.append(select, sets, actions);

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

  select.onchange = async () => {
    sets.textContent = "";
    deployBtn.disabled = true;
    if (!select.value) return;
    sets.textContent = "Loading permission sets…";
    const response = await send({ type: "QR_PERMISSION_SETS", baseUrl: select.value, masterPassword: "" });
    sets.textContent = "";
    if (!response.ok) return onError(explain(response));
    const remembered = new Set(response.remembered);
    if (!response.sets.length) sets.textContent = "No customer permission sets on this instance — the report deploys without grants.";
    for (const ps of response.sets) {
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = ps.id;
      box.checked = remembered.has(ps.id);
      label.append(box, document.createTextNode(` ${ps.name}`));
      sets.appendChild(label);
    }
    deployBtn.disabled = false;
  };

  function explain(response) {
    return response.needsMasterPassword
      ? "Saved credentials are locked — unlock them in the NovacuraBuddy side panel, then try again."
      : response.error;
  }

  async function deploy(forceQuickReportId) {
    const report = getReport();
    if (!report) return onError("Save your changes before deploying — Deploy sends the saved version.");
    const baseUrl = select.value;
    const origin = new URL(baseUrl).origin;
    // Must run inside the click's user gesture, before any other await.
    const granted = await new Promise((resolve) => chrome.permissions.request({ origins: [origin + "/*"] }, resolve));
    if (!granted) return onError(`Permission for ${origin} was not granted — can't deploy there.`);
    const permissionSetIds = [...sets.querySelectorAll("input:checked")].map((b) => b.value);
    deployBtn.disabled = true;
    deployBtn.textContent = "Deploying…";
    const response = await send({ type: "QR_DEPLOY", baseUrl, report, permissionSetIds, forceQuickReportId, masterPassword: "" });
    deployBtn.disabled = false;
    deployBtn.textContent = "Deploy";
    if (!response.ok) return onError(explain(response));
    if (response.outcome.status === "needsConfirmation") return askOverwrite(response.outcome);
    onDeployed({ baseUrl, ...response.outcome });
  }

  function askOverwrite({ existingQuickReportId, existingDescription }) {
    const box = document.createElement("div");
    box.className = "banner banner-warning";
    const text = document.createElement("span");
    text.textContent = `A Quick Report named "${existingDescription}" already exists on this instance (id ${existingQuickReportId}). Overwrite it?`;
    const yes = document.createElement("button");
    yes.className = "btn-primary";
    yes.textContent = "Overwrite";
    yes.onclick = () => { box.remove(); deploy(existingQuickReportId); };
    const no = document.createElement("button");
    no.className = "btn-ghost";
    no.textContent = "Cancel";
    no.onclick = () => box.remove();
    box.append(text, yes, no);
    container.appendChild(box);
  }

  deployBtn.onclick = () => deploy();
}
```

- [ ] **Step 2: Create `panels/quick-reports.js`**

```js
let qrReports = [];
let qrSearch = null;
let qrLoadedOnce = false;

function openQrEditor(id) {
  chrome.tabs.create({ url: chrome.runtime.getURL("qr-editor.html" + (id ? `?id=${encodeURIComponent(id)}` : "")) });
}

function setQrReports(reports, fetchedAt) {
  qrReports = reports;
  qrSearch = QrSearch.createQrSearch(reports, Fuse);
  document.getElementById("qrRefreshed").textContent = fetchedAt ? `Last refreshed ${new Date(fetchedAt).toLocaleString()}` : "";
  renderQrList();
}

function renderQrList() {
  const shown = qrSearch ? qrSearch.search(document.getElementById("qrSearch").value) : [];
  document.getElementById("qrCount").textContent = qrReports.length ? `${shown.length} of ${qrReports.length}` : "";
  const list = document.getElementById("qrList");
  list.innerHTML = "";
  for (const report of shown) {
    const li = document.createElement("li");
    li.className = "qr-item";

    const head = document.createElement("div");
    head.className = "qr-head";
    const name = document.createElement("span");
    name.className = "qr-name";
    name.textContent = report.name;
    const deployBtn = document.createElement("button");
    deployBtn.textContent = "Deploy";
    const editBtn = document.createElement("button");
    editBtn.className = "btn-ghost";
    editBtn.textContent = "Edit";
    editBtn.onclick = () => openQrEditor(report.id);
    head.append(name, deployBtn, editBtn);

    const preview = document.createElement("div");
    preview.className = "qr-preview";
    preview.textContent = report.content.replace(/\s+/g, " ").trim().slice(0, 160);
    preview.title = report.content;

    const form = document.createElement("div");
    form.hidden = true;
    deployBtn.onclick = () => {
      form.hidden = !form.hidden;
      if (!form.hidden) {
        renderDeployForm(form, () => report, {
          send,
          onDeployed: (result) => showNotice(`Deployed "${report.name}" — Quick Report id ${result.quickReportId}.`),
          onError: (message) => showError(message, true)
        });
      }
    };

    li.append(head, preview, form);
    list.appendChild(li);
  }
}

async function refreshQuickReports() {
  qrLoadedOnce = true;
  const hint = document.getElementById("qrSetupHint");
  const settings = await send({ type: "QR_GET_SETTINGS" });
  if (!settings.ok) return showError(settings.error, true);
  if (!settings.hasToken) {
    hint.textContent = "Add a GitHub token in Basic Data to see your Quick Reports.";
    hint.hidden = false;
    setQrReports([], null);
    return;
  }
  hint.hidden = true;

  const cached = await send({ type: "QR_LIST_CACHED" });
  if (cached.ok && cached.cache) setQrReports(cached.cache.reports, cached.cache.fetchedAt);

  const btn = document.getElementById("qrRefreshBtn");
  btn.disabled = true;
  btn.textContent = "Refreshing…";
  const fresh = await sendOrShowError({ type: "QR_LIST", masterPassword: masterPasswordOf() }, true);
  btn.disabled = false;
  btn.textContent = "Refresh";
  if (fresh) setQrReports(fresh.reports, fresh.fetchedAt);
}

function initQuickReportsPanel() {
  document.getElementById("qrSearch").addEventListener("input", renderQrList);
  document.getElementById("qrRefreshBtn").addEventListener("click", () => { clearError(true); refreshQuickReports(); });
  document.getElementById("qrNewBtn").addEventListener("click", () => openQrEditor(null));
}
```

- [ ] **Step 3: Create `panels/update-banner.js`**

```js
async function refreshUpdateBanner() {
  const el = document.getElementById("updateBanner");
  const response = await send({ type: "GET_UPDATE_INFO" });
  if (!response.ok || !response.info || !response.info.available || response.dismissed) {
    el.hidden = true;
    return;
  }
  const { version, zipUrl, htmlUrl } = response.info;
  el.innerHTML = "";

  const text = document.createElement("span");
  text.textContent = `NovacuraBuddy v${version} is available.`;

  const howTo = document.createElement("p");
  howTo.className = "update-howto";
  howTo.hidden = true;
  howTo.textContent = "Unzip it over your NovacuraBuddy folder (replace the files — same folder keeps your saved instances and settings), then open chrome://extensions and click Reload on NovacuraBuddy.";

  const download = document.createElement("button");
  download.className = "btn-primary";
  download.textContent = "Download";
  download.onclick = () => {
    if (zipUrl) chrome.downloads.download({ url: zipUrl, filename: `NovacuraBuddy-v${version}.zip` });
    else chrome.tabs.create({ url: htmlUrl });
    howTo.hidden = false;
  };

  const howToBtn = document.createElement("button");
  howToBtn.className = "btn-ghost";
  howToBtn.textContent = "How to install";
  howToBtn.onclick = () => { howTo.hidden = !howTo.hidden; };

  const later = document.createElement("button");
  later.className = "btn-ghost";
  later.textContent = "Later";
  later.onclick = async () => { await send({ type: "DISMISS_UPDATE", version }); el.hidden = true; };

  el.append(text, download, howToBtn, later, howTo);
  el.hidden = false;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.updateInfo) refreshUpdateBanner();
});
```

- [ ] **Step 4: Update `sidepanel.html`**

After `<div id="unmatchedHosts"></div>` add:

```html
    <div id="updateBanner" class="banner banner-success update-banner" hidden></div>
```

In the `<nav class="tabs">` add after the Traffic Recorder button:

```html
      <button id="tab-quick-reports" class="tab" role="tab">Quick Reports</button>
```

Before `<section id="panel-basic-data" ...>` add:

```html
    <section id="panel-quick-reports" role="tabpanel" hidden>
      <div class="search-row">
        <input id="qrSearch" placeholder="Search Quick Reports (name or SQL)…" />
        <button id="qrRefreshBtn">Refresh</button>
      </div>
      <div class="list-toolbar">
        <span class="list-count" id="qrCount"></span>
        <button id="qrNewBtn" class="btn-primary">New report</button>
      </div>
      <span class="list-count" id="qrRefreshed"></span>
      <div id="qrSetupHint" class="empty-state" hidden></div>
      <hr class="section-divider" />
      <ul id="qrList" class="qr-list"></ul>
    </section>
```

Replace the script block at the end of `<body>` with (order matters — vendor and lib first, `sidepanel.js` last):

```html
    <script src="lib/vendor/fuse.min.js"></script>
    <script src="lib/qr-search.js"></script>
    <script src="panels/common.js"></script>
    <script src="panels/tracker.js"></script>
    <script src="panels/basic-data.js"></script>
    <script src="panels/recorder.js"></script>
    <script src="panels/qr-deploy-form.js"></script>
    <script src="panels/quick-reports.js"></script>
    <script src="panels/update-banner.js"></script>
    <script src="sidepanel.js"></script>
```

- [ ] **Step 5: Update `sidepanel.js`**

```js
const TABS = ["tracker", "recorder", "quick-reports", "basic-data"];
```

Inside `showTab(name)`, after the `try { localStorage... }` line:

```js
  if (name === "quick-reports" && !qrLoadedOnce) refreshQuickReports();
```

After `initRecorderPanel();` add:

```js
initQuickReportsPanel();
refreshUpdateBanner();
```

`showTab(initialTab)` runs before `initQuickReportsPanel()`; that is fine — `refreshQuickReports` only needs the DOM and `send`, both ready.

- [ ] **Step 6: Append to `sidepanel.css`**

First read `.projection-card` in `sidepanel.css` and reuse its exact `background`, `border-radius`, `padding` and `box-shadow` values for `.qr-item` (the values below are the expected ones; if the file differs, use the file's).

```css
/* ---------- quick reports ---------- */
.tabs { flex-wrap: wrap; }
.qr-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.qr-item { display: flex; flex-direction: column; gap: 6px; padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: var(--surface); box-shadow: var(--shadow-raised); }
.qr-head { display: flex; align-items: center; gap: var(--space-2); }
.qr-name { flex: 1; font-weight: 600; overflow-wrap: anywhere; }
.qr-preview { font-family: var(--font-mono); font-size: 12px; color: var(--ink-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.deploy-form { display: flex; flex-direction: column; gap: var(--space-2); }
.checklist { display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; font-size: 13px; }
.deploy-actions { display: flex; gap: var(--space-2); }
.update-banner { flex-wrap: wrap; }
.update-howto { flex-basis: 100%; margin: 0; font-size: 12px; }
```

- [ ] **Step 7: Run tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 8: Manual check (needs Task 9's token saved)**

Reload the extension, open the side panel:
1. Four tabs visible, wrapping instead of overflowing at the narrowest panel width.
2. Quick Reports tab: list loads (your folder only); typing filters live; "Last refreshed …" shown.
3. Deploy on a row → instance select → permission sets load, IFS-managed sets absent → Deploy → green notice with the IFS id. Deploy again → no overwrite question (history used).
4. With credentials locked (restart browser), Refresh shows the locked message, not a crash.
5. No update banner (no release exists yet).

- [ ] **Step 9: Commit**

```bash
git add panels/qr-deploy-form.js panels/quick-reports.js panels/update-banner.js sidepanel.html sidepanel.js sidepanel.css
git commit -m "feat(quick-reports): Quick Reports side-panel tab, deploy form, update banner"
```

---

### Task 11: Full-page editor

**Files:**
- Create: `qr-editor.html`, `qr-editor.js`, `qr-editor.css`

**Interfaces:**
- Consumes: `renderDeployForm` (Task 10), messages `LIST_INSTANCES`, `QR_LIST`, `QR_LIST_CACHED`, `QR_SAVE`, `QR_HISTORY` (Task 8), `send`/`showError`/`showNotice`/`clearError` (`panels/common.js`), global `sqlFormatter` (Task 1).
- Produces: page opened by `openQrEditor(id)` at `qr-editor.html?id=<slug>` (no `id` = new report).

- [ ] **Step 1: Create `qr-editor.html`**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Quick Report editor</title>
    <link rel="stylesheet" href="sidepanel.css" />
    <link rel="stylesheet" href="qr-editor.css" />
  </head>
  <body class="qr-editor-page">
    <div id="error" class="banner banner-error" hidden title="Click to dismiss"></div>
    <div id="notice" class="banner banner-success" hidden></div>

    <header class="topbar"><h1 id="editorTitle">New Quick Report</h1></header>

    <div class="editor-grid">
      <section class="editor-main">
        <input id="qrName" placeholder="Report name" />
        <input id="qrTags" placeholder="Tags, comma separated" />
        <textarea id="qrSql" spellcheck="false" placeholder="SELECT …"></textarea>
        <div class="editor-actions">
          <button id="beautifyBtn">Beautify</button>
          <button id="saveBtn" class="btn-primary">Save</button>
        </div>
      </section>

      <aside class="editor-side">
        <h2>Deploy</h2>
        <p id="deployHint" class="list-count">Save the report before deploying it.</p>
        <div id="deployForm"></div>

        <h2>Deploy history</h2>
        <table class="history-table" id="historyTable">
          <thead><tr><th>Instance</th><th>Quick Report id</th><th>Deployed</th></tr></thead>
          <tbody></tbody>
        </table>

        <h2>By instance</h2>
        <select id="byInstanceSelect"></select>
        <table class="history-table" id="byInstanceTable">
          <thead><tr><th>Report</th><th>Quick Report id</th><th>Deployed</th></tr></thead>
          <tbody></tbody>
        </table>
      </aside>
    </div>

    <script src="lib/vendor/sql-formatter.min.js"></script>
    <script src="panels/common.js"></script>
    <script src="panels/qr-deploy-form.js"></script>
    <script src="qr-editor.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `qr-editor.js`**

```js
// Full-page Quick Report editor. Shares panels/common.js (send/showError/showNotice) and the
// deploy form with the side panel; all GitHub/IFS work happens in the background worker.
const els = {
  title: document.getElementById("editorTitle"),
  name: document.getElementById("qrName"),
  tags: document.getElementById("qrTags"),
  sql: document.getElementById("qrSql"),
  save: document.getElementById("saveBtn"),
  beautify: document.getElementById("beautifyBtn"),
  deployHint: document.getElementById("deployHint"),
  deployForm: document.getElementById("deployForm"),
  history: document.querySelector("#historyTable tbody"),
  byInstanceSelect: document.getElementById("byInstanceSelect"),
  byInstance: document.querySelector("#byInstanceTable tbody")
};

let editing = { id: null, sqlSha: null, jsonSha: null, createdAt: null };
let dirty = false;
let instancesByUrl = {};
let reportNames = {};

const fmt = (iso) => new Date(iso).toLocaleString();
const instanceName = (key) => (instancesByUrl[key] ? instancesByUrl[key].name : key);
const parseTags = () => els.tags.value.split(",").map((t) => t.trim()).filter(Boolean);

function explain(response) {
  return response.needsMasterPassword
    ? "Saved credentials are locked — unlock them in the NovacuraBuddy side panel, then try again."
    : response.error;
}

function fillTable(tbody, rows) {
  tbody.innerHTML = "";
  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.className = "empty-state";
    td.textContent = "Nothing deployed yet.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const cells of rows) {
    const tr = document.createElement("tr");
    for (const cell of cells) {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

async function refreshHistory() {
  if (!editing.id) return fillTable(els.history, []);
  const response = await send({ type: "QR_HISTORY", qrId: editing.id });
  if (!response.ok) return showError(response.error, true);
  fillTable(els.history, response.deployments.map((d) => [instanceName(d.instanceKey), d.quickReportId, fmt(d.deployedAt)]));
}

async function refreshByInstance() {
  if (!els.byInstanceSelect.value) return fillTable(els.byInstance, []);
  const response = await send({ type: "QR_HISTORY", baseUrl: els.byInstanceSelect.value });
  if (!response.ok) return showError(response.error, true);
  fillTable(els.byInstance, response.deployments.map((d) => [reportNames[d.qrId] || d.qrId, d.quickReportId, fmt(d.deployedAt)]));
}

function renderDeploy() {
  els.deployHint.hidden = !!editing.id;
  if (!editing.id) { els.deployForm.innerHTML = ""; return; }
  renderDeployForm(els.deployForm, () => (dirty ? null : { id: editing.id, name: els.name.value.trim(), content: els.sql.value }), {
    send,
    onDeployed: (result) => {
      showNotice(`Deployed — Quick Report id ${result.quickReportId} on ${instanceName(result.baseUrl)}.`);
      refreshHistory();
      refreshByInstance();
    },
    onError: (message) => showError(message, true)
  });
}

function applyReport(report) {
  editing = { id: report.id, sqlSha: report.sqlSha, jsonSha: report.jsonSha, createdAt: report.createdAt };
  reportNames[report.id] = report.name;
  els.name.value = report.name;
  els.tags.value = (report.tags || []).join(", ");
  els.sql.value = report.content;
  els.title.textContent = report.name;
  document.title = `${report.name} — Quick Report`;
  window.history.replaceState(null, "", `?id=${encodeURIComponent(report.id)}`);
  dirty = false;
  renderDeploy();
  refreshHistory();
}

async function loadInstances() {
  const response = await send({ type: "LIST_INSTANCES" });
  if (!response.ok) return showError(response.error, true);
  instancesByUrl = Object.fromEntries(response.instances.map((i) => [i.baseUrl, i]));
  els.byInstanceSelect.innerHTML = "";
  els.byInstanceSelect.append(new Option("Choose an IFS instance…", ""));
  for (const i of response.instances) els.byInstanceSelect.append(new Option(i.name, i.baseUrl));
}

async function loadReports() {
  const id = new URLSearchParams(location.search).get("id");
  let reports;
  const response = await send({ type: "QR_LIST", masterPassword: "" });
  if (response.ok) {
    reports = response.reports;
  } else {
    const cached = await send({ type: "QR_LIST_CACHED" });
    reports = cached.ok && cached.cache ? cached.cache.reports : [];
    showError(`${explain(response)} — showing the last cached copy; saving may be refused until the list loads.`, true);
  }
  reportNames = Object.fromEntries(reports.map((r) => [r.id, r.name]));
  if (!id) return renderDeploy();
  const report = reports.find((r) => r.id === id);
  if (!report) return showError(`Quick Report "${id}" wasn't found in your folder.`, true);
  applyReport(report);
}

els.save.addEventListener("click", async () => {
  const name = els.name.value.trim();
  if (!name) return showError("Give the report a name first.", true);
  els.save.disabled = true;
  els.save.textContent = "Saving…";
  const response = await send({
    type: "QR_SAVE",
    masterPassword: "",
    report: { id: editing.id, name, content: els.sql.value, tags: parseTags(), sqlSha: editing.sqlSha, jsonSha: editing.jsonSha, createdAt: editing.createdAt }
  });
  els.save.disabled = false;
  els.save.textContent = "Save";
  if (!response.ok) return showError(explain(response), true);
  clearError(true);
  applyReport(response.report);
  showNotice("Saved to GitHub.");
});

els.beautify.addEventListener("click", () => {
  try {
    els.sql.value = sqlFormatter.format(els.sql.value, { language: "plsql" });
    dirty = true;
  } catch (e) {
    showError(`Beautify couldn't parse this SQL: ${e.message}`, true);
  }
});

for (const field of [els.name, els.tags, els.sql]) field.addEventListener("input", () => { dirty = true; });
els.byInstanceSelect.addEventListener("change", refreshByInstance);
window.addEventListener("beforeunload", (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ""; }
});

(async () => {
  await loadInstances();
  await loadReports();
})();
```

- [ ] **Step 3: Create `qr-editor.css`**

```css
/* Wide layout only — colors, type and components come from sidepanel.css. */
.qr-editor-page { max-width: 1400px; margin: 0 auto; padding: var(--space-3); }
.qr-editor-page h1 { font-family: var(--font-sans-head); font-size: 20px; margin: 0; }
.editor-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); gap: var(--space-4); margin-top: var(--space-3); }
@media (max-width: 900px) { .editor-grid { grid-template-columns: 1fr; } }
.editor-main, .editor-side { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
#qrSql { font-family: var(--font-mono); font-size: 13px; min-height: 60vh; resize: vertical; tab-size: 2; }
.editor-actions { display: flex; gap: var(--space-2); justify-content: flex-end; }
.history-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.history-table th { text-align: left; color: var(--ink-muted); font-weight: 600; border-bottom: 1px solid var(--surface-raised); padding: 4px 6px; }
.history-table td { border-bottom: 1px solid var(--surface-raised); padding: 4px 6px; overflow-wrap: anywhere; }
```

- [ ] **Step 4: Run tests**

Run: `npm test`

- [ ] **Step 5: Manual check**

1. Side panel → Quick Reports → Edit on a report: editor tab opens with name, tags, SQL; deploy history table filled from Task 10's deploy.
2. Change SQL, try Deploy → "Save your changes before deploying…". Save → "Saved to GitHub."; commit `update QR: <name>` visible in the data repo under `quick-reports/<login>/`.
3. Beautify formats SQL; broken SQL shows the parse error banner instead of throwing.
4. Open the same report in two tabs; save in one, then save in the other → "This report changed on GitHub since you loaded it — reload before saving."; GitHub content is the first tab's.
5. "New report" from the side panel → empty editor; Save creates `add QR: <name>`; Deploy becomes available.
6. Overwrite path: deploy a new report whose name already exists on the instance → overwrite banner → Overwrite → deployed with the existing id.
7. By instance: choose an instance → its deployed reports with names.
8. Light and dark system theme both readable.

- [ ] **Step 6: Commit**

```bash
git add qr-editor.html qr-editor.js qr-editor.css
git commit -m "feat(quick-reports): full-page Quick Report editor"
```

---

### Task 12: Release script

**Files:**
- Create: `scripts/release-files.js`, `scripts/release-files.test.js`, `scripts/release.js`
- Modify: `package.json` (test glob + release script), `.gitignore` (create if missing: add `NovacuraBuddy-v*.zip`)

**Interfaces:**
- Consumes: `UpdateCheck.compareVersions` (Task 6).
- Produces: `collectReleaseFiles(rootDir) → string[]` (sorted, `/`-separated); `npm run release -- <x.y.z> [--dry-run]`.

- [ ] **Step 1: Write the failing test `scripts/release-files.test.js`**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { collectReleaseFiles } = require("./release-files.js");

test("ships the extension, never tests, docs, firefox, scripts, dot-files or package files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nb-files-"));
  const files = [
    "manifest.json", "background.js", "sidepanel.html", "qr-editor.html",
    "lib/qr-deploy.js", "lib/qr-deploy.test.js", "lib/vendor/fuse.min.js", "lib/vendor/VENDOR.md",
    "recorder/viewer.js", "icons/icon16.png",
    "docs/superpowers/specs/x.md", "firefox/manifest.json", "scripts/release.js", "node_modules/a/index.js",
    ".git/HEAD", ".gitignore", "package.json", "package-lock.json", "manifest.test.js", "NovacuraBuddy-v0.1.0.zip"
  ];
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), "x");
  }
  assert.deepEqual(collectReleaseFiles(root), [
    "background.js", "icons/icon16.png", "lib/qr-deploy.js", "lib/vendor/VENDOR.md", "lib/vendor/fuse.min.js",
    "manifest.json", "qr-editor.html", "recorder/viewer.js", "sidepanel.html"
  ]);
});
```

- [ ] **Step 2: Add the test glob and script to `package.json`, run, expect FAIL**

```json
{
  "name": "ifs-flow-projection-tracker",
  "private": true,
  "scripts": {
    "test": "node --test lib/*.test.js recorder/*.test.js scripts/*.test.js manifest.test.js",
    "release": "node scripts/release.js"
  }
}
```

Run: `node --test scripts/release-files.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `scripts/release-files.js`**

```js
const fs = require("node:fs");
const path = require("node:path");

const EXCLUDED_ROOT_DIRS = new Set(["node_modules", "docs", "firefox", "scripts", "dist"]);
const EXCLUDED_ROOT_FILES = new Set(["package.json", "package-lock.json"]);

/** Files that make up the installable extension, relative to `rootDir`, sorted. */
function collectReleaseFiles(rootDir) {
  const out = [];
  (function walk(rel) {
    for (const entry of fs.readdirSync(path.join(rootDir, rel), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const atRoot = !rel;
      if (entry.isDirectory()) {
        if (atRoot && EXCLUDED_ROOT_DIRS.has(entry.name)) continue;
        walk(relPath);
        continue;
      }
      if (entry.name.endsWith(".test.js")) continue;
      if (atRoot && (EXCLUDED_ROOT_FILES.has(entry.name) || entry.name.endsWith(".zip") || entry.name.endsWith(".md"))) continue;
      out.push(relPath);
    }
  })("");
  return out.sort();
}

module.exports = { collectReleaseFiles };
```

- [ ] **Step 4: Run, expect PASS**

Run: `node --test scripts/release-files.test.js`

- [ ] **Step 5: Implement `scripts/release.js`**

```js
// Cuts a NovacuraBuddy release: bump manifest version, test, zip, commit, tag, push, and publish a
// GitHub Release with the zip — the asset the in-extension update banner downloads.
// Usage: npm run release -- 0.2.0 [--dry-run]
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { collectReleaseFiles } = require("./release-files.js");
const { compareVersions } = require("../lib/update-check.js");

const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}
const run = (cmd, cmdArgs, opts = {}) => execFileSync(cmd, cmdArgs, { cwd: root, stdio: "inherit", ...opts });
const out = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { cwd: root, encoding: "utf8" }).trim();

if (!/^\d+\.\d+\.\d+$/.test(version || "")) fail("usage: npm run release -- <x.y.z> [--dry-run]");

const manifestPath = path.join(root, "manifest.json");
const manifestText = fs.readFileSync(manifestPath, "utf8");
const current = JSON.parse(manifestText).version;
if (compareVersions(version, current) <= 0) fail(`version ${version} must be newer than the current ${current}.`);

const files = collectReleaseFiles(root);
const zipName = `NovacuraBuddy-v${version}.zip`;
if (dryRun) {
  console.log(files.join("\n"));
  console.log(`\n${files.length} files would go into ${zipName} (current version ${current}).`);
  process.exit(0);
}

if (out("git", ["branch", "--show-current"]) !== "master") fail("releases are cut from master — switch to master first.");
if (out("git", ["status", "--porcelain"])) fail("working tree isn't clean — commit or stash first.");

run("npm", ["test"], { shell: true });

fs.writeFileSync(manifestPath, manifestText.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`));

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "nb-release-"));
for (const f of files) {
  const dest = path.join(stage, f);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(root, f), dest);
}
const zipPath = path.join(root, zipName);
run("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zipPath}' -Force`]);

run("git", ["commit", "-am", `chore: release v${version}`]);
run("git", ["tag", `v${version}`]);
run("git", ["push", "origin", "master", `v${version}`]);
run("gh", ["release", "create", `v${version}`, zipPath, "--title", `v${version}`, "--generate-notes"]);

fs.rmSync(zipPath, { force: true });
fs.rmSync(stage, { recursive: true, force: true });
console.log(`Released v${version}.`);
```

- [ ] **Step 6: Add `.gitignore` entry**

Append (create the file if missing):

```
NovacuraBuddy-v*.zip
```

- [ ] **Step 7: Run tests + dry run**

Run: `npm test`
Run: `npm run release -- 0.2.0 --dry-run`
Expected: file list with `manifest.json`, `background.js`, `lib/...`, `qr-editor.html`, no `*.test.js`, no `docs/`, no `firefox/`; last line `… files would go into NovacuraBuddy-v0.2.0.zip (current version 0.1.0).`

- [ ] **Step 8: Commit**

```bash
git add scripts package.json .gitignore
git commit -m "chore: release script publishing the zip the update banner downloads"
```

---

### Task 13: Live verification + spec status

Manual, with the user. Nothing here is automated.

- [ ] **Step 1: Full test run**

Run: `npm test` — record the count (474 + new).

- [ ] **Step 2: Live checklist (user, real IFS test instance + real token)**

1. Basic Data: save token → "Connected as <login>". Move unowned reports → existing flat reports appear in your folder on GitHub and in the tab.
2. Quick Reports tab: search, Refresh, Deploy (new name → created; same report again → updated, no question; another report with a name that exists on IFS → overwrite question).
3. Editor: save, conflict between two tabs, beautify, history, by-instance.
4. Update banner: after merge to master, run `npm run release -- 0.2.0`; on a second install still at 0.1.0 (or by temporarily setting `manifest.json` to `0.1.0` locally and reloading) the banner shows within one panel open; Download saves `NovacuraBuddy-v0.2.0.zip`; after unzipping over the folder and Reload, the banner is gone.

- [ ] **Step 3: Update spec status**

Change the spec's `Status:` line to `implemented — live-verified <date>` (or list what failed) and commit:

```bash
git add docs/superpowers/specs/2026-10-19-quick-report-deployer-merge-design.md
git commit -m "docs: record live verification of the Quick Report Deployer merge"
```
