# Quick Report Deployer merge + update notice — Design Spec

Date: 2026-10-19
Status: draft for review
Branch: `feat/quick-report-deployer` (based on `fix/global-asset-package`)

## 1. Purpose

Bring the **IFS Quick Report Deployer** (Electron app, branch `quick-report-deployer-impl` of
`Brasijoe/ifs-quick-report-deployer`) into this extension as a **fourth function** next to
Projection Tracker, Traffic Recorder and Basic Data. Same rules as the recorder merge: IFS
instances, credentials and the master password come from Basic Data; the look follows
`sidepanel.css`. Additionally, the extension tells the user when a newer GitHub Release exists and
offers the download.

This is a **port**, not a git merge: the deployer is TypeScript/React/SQLite, this extension is
plain JS with no build step. The Electron app itself is left untouched (its other features —
migration, WASM validator, Flow properties importer — stay there).

Success looks like:

- A "Quick Reports" side-panel tab lists *my* Quick Reports from the shared GitHub data repo,
  searchable as I type, and can deploy one to any Basic Data instance.
- An "Open editor" full browser tab edits name + SQL (with Beautify), saves to GitHub, deploys,
  and shows deploy history.
- A deploy runs the same, already live-confirmed IFS REST sequence as the Electron app.
- When a newer release of NovacuraBuddy is published on GitHub, the side panel shows a banner with
  a Download button.
- All existing tests keep passing.

## 2. Decisions (agreed in brainstorming)

| Topic | Decision |
|---|---|
| Quick Report storage | Existing private repo `Brasijoe/ifs-quick-report-deployer-data`, via GitHub REST API |
| Per-user split | Folder per user: `quick-reports/<github-login>/`. User = login of the GitHub token (`GET /user`). Tidiness, not privacy — repo members can still see all folders on github.com |
| Existing flat reports | One-time, user-triggered "Move unowned reports into my folder" in Basic Data |
| Layout | Side-panel tab (list, search, Refresh, quick Deploy, Open editor) + full-page editor tab |
| Deploy history / permission-set memory | Local, `chrome.storage.local`, per instance |
| Versioning | GitHub Releases of `Brasijoe/NovacuraBuddy` (public), tag `v<manifest version>` |
| Update check timing | Only on browser startup |
| Update install | Banner + download of release zip; user unzips over folder and reloads (Chrome cannot self-update an unpacked extension) |
| Dropped from deployer | Command palette, SQLite, Electron safeStorage, its own instance store + token code |
| Out of scope | Firefox build, "show teammates' reports" toggle, automatic update install |

## 3. Components

All new code is plain JS in the existing UMD-ish style (`(function (global) { ... })`, usable from
`require` in tests and as globals in pages).

### 3.1 `lib/qr-deploy.js`
Port of `src/main/ifs/quickReportDeploy.ts` + `ifsEndpoints.ts` + the REST helpers of
`ifsClient.ts` (GET/POST/PATCH text/PATCH JSON with bearer token and ETag). Takes an instance and
a token provider from `ifs-instances.js` instead of its own auth. Keeps, unchanged in behaviour:

- temp-LOB upload + `CheckSqlExpressionAction` validation,
- create flow / update flow (PATCH existing record),
- `needsConfirmation` outcome when a report with the same description exists, retried with
  `forceQuickReportId`,
- deploy + grant of the Quick Report projection to the selected permission sets,
- trailing-`.0` QuickReportId normalization,
- permission-set listing with IFS-managed sets excluded.

Returns a plain outcome object; it does **not** write history itself (caller does, see 4.3), so
the module stays free of storage.

### 3.2 `lib/qr-library.js`
GitHub data-repo client. Inputs: token, repo (`owner/name`), `fetch`.

- `whoAmI()` — `GET /user`, returns login. Called when the token is saved in Basic Data (together
  with a repo-access check); the login is stored next to the encrypted token, so a changed token
  always re-resolves because it can only change through that save.
- `list(login)` — default branch via `GET /repos/{repo}`, then one
  `GET /git/trees/{branch}?recursive=1`, filter to `quick-reports/<login>/*.json|*.sql`, fetch
  blobs, return `{ id, name, tags, createdAt, updatedAt, content, sqlSha, jsonSha }[]`.
- `save(login, report)` — `PUT /contents/...` for `.sql` then `.json`; new report: no `sha`,
  message `add QR: <name>`; existing: with stored `sha`, message `update QR: <name>`. A 409/422
  response becomes a `ConflictError` ("changed on GitHub — reload before saving").
- `moveUnowned(login)` — for each flat `quick-reports/<slug>.{sql,json}`: create under the user
  folder, then delete the original (with its `sha`). Reports whose slug already exists in the
  user folder are skipped and reported, never overwritten.
- Slug generation and the `.json` shape (`{ id, name, tags, createdAt, updatedAt }`) are copied
  from `qrFileStore.ts` so the files stay compatible.

### 3.3 `lib/qr-history.js`
`chrome.storage.local` store (storage injected for tests):

- deployments: `{ qrId, instanceKey, quickReportId, permissionSetIds, deployedAt }`, upsert per
  `(qrId, instanceKey)` like `deploymentsRepo.ts`,
- permission-set memory: last used set ids per instance,
- queries: by report, by instance.

`instanceKey` is the canonical Basic Data key (origin without slash). Renaming an instance in
Basic Data does not orphan history.

### 3.4 `lib/update-check.js`
- `compareVersions(a, b)` — numeric semver compare, tolerant of a leading `v`.
- `checkForUpdate(currentVersion, fetch)` — `GET https://api.github.com/repos/Brasijoe/NovacuraBuddy/releases/latest`;
  returns `{ available, version, zipUrl, htmlUrl }`. `zipUrl` = the release asset named
  `NovacuraBuddy-v<version>.zip`, falling back to the release page if absent. No token. 404 (no
  releases yet) and network errors → `{ available: false }` plus a debug log line.
- Background: runs **only on browser startup** (`chrome.runtime.onStartup`, user decision
  2026-10-19) — no timer, no check on panel open. Result stored in `chrome.storage.local`
  (`updateInfo`, incl. `currentVersion`), so the side panel just reads it; stored info whose
  `currentVersion` differs from the installed version is ignored (no banner after updating).

### 3.5 `lib/vendor/`
Pinned local copies of `fuse.js` (UMD build) and `sql-formatter` (standalone build), with a
`VENDOR.md` naming exact versions and sources. MV3 forbids remote scripts.

### 3.6 `panels/quick-reports.js` + side-panel tab
Tab "Quick Reports" in `sidepanel.html`, wired like the other panels. Contents: search box, report
list (name + one-line SQL preview), Refresh, "last refreshed …", per-row Deploy and Open editor,
"New report" (opens editor). Deploy opens an inline deploy form (instance select grouped like
Basic Data → permission-set checklist → Deploy) using the shared component classes.

### 3.7 `qr-editor.html` / `qr-editor.js`
Full-page tab opened via `chrome.tabs.create` with `?id=<slug>` (or none for a new report).
Name field, SQL textarea (monospace), Beautify, Save, Deploy (same deploy form), deploy-history
table for this report, and a "by instance" view (all deployments on one instance). Styles:
`sidepanel.css` tokens/components plus a small `qr-editor.css` for the wide layout only.

### 3.8 Basic Data additions
- GitHub token field, encrypted with the master password exactly like IFS client secrets
  (`credential-crypto.js`), plus a "Check" button calling `whoAmI()`.
- Data repo field, default `Brasijoe/ifs-quick-report-deployer-data`.
- "Move unowned reports into my folder" button with a confirm step and a result summary.

### 3.9 Update banner
Top of the side panel, above the tabs, hidden unless `updateInfo.available`. Text
"NovacuraBuddy v<x> available" + Download (`chrome.downloads.download(zipUrl)`) + "How to install"
hint (unzip over the extension folder, reload in `chrome://extensions`) + dismiss (per version).

### 3.10 Manifest + release script
- `permissions`: add `downloads`.
- `host_permissions`: add `https://api.github.com/*`. Download URLs (`github.com`,
  `objects.githubusercontent.com`) are handled by `chrome.downloads` and need no host permission.
- `npm run release -- <version>`: bump `manifest.json` version, run tests, zip the extension
  (excluding `*.test.js`, `docs/`, `firefox/`, `node_modules/`, dot-files) to
  `NovacuraBuddy-v<version>.zip`, commit, tag `v<version>`, `gh release create` with the zip.
  Script in `scripts/release.js` (Node, no new dependencies; zipping via PowerShell
  `Compress-Archive` on Windows).

## 4. Data flow

### 4.1 Load list
Tab open / Refresh → need GitHub token → master password unlocked? (else the existing unlock
prompt) → `whoAmI` → `list(login)` → build Fuse index → render. The list is cached in
`chrome.storage.local` and shown with "last refreshed …" when offline or before the fetch returns.

### 4.2 Save
Editor Save → `save(login, report)` with loaded `sha`s → on success update cache and stored
`sha`s; on `ConflictError` show the message and keep the editor contents untouched.

### 4.3 Deploy
Select instance → host permission is normally already granted when the instance was saved in
Basic Data (`panels/basic-data.js`); if `chrome.permissions.contains` says no, request it from the
Deploy click's own user gesture → token
from `ifs-instances.js` → list permission sets (pre-check from memory) → `qr-deploy` run →
`needsConfirmation` → ask "A Quick Report named X already exists (id N). Overwrite?" → retry with
`forceQuickReportId` → on `deployed` write history + memory. On failure: show the failing step
name and IFS error text; write nothing.

### 4.4 Update check
Browser startup (`chrome.runtime.onStartup`) → `checkForUpdate` → `updateInfo` in storage → side
panel reads it on open and on `chrome.storage.onChanged`.

## 5. Error handling

- No GitHub token / locked master password → tab shows a one-line prompt pointing to Basic Data
  or unlock; no request is made.
- GitHub 401 → "GitHub token rejected — check it in Basic Data". 404 on repo → "No access to
  <repo>". Rate limit (403 with `x-ratelimit-remaining: 0`) → message with reset time.
- Save conflict → section 4.2. Never auto-overwrite.
- Deploy → step-named error, no partial history (deployer rule kept).
- Update check → silent, debug log only.

## 6. Testing

`node --test`, fake `fetch` and fake storage, in the existing style:

- `qr-deploy.test.js` — port of `quickReportDeploy.test.ts` (286 lines) + permission-set tests.
- `qr-library.test.js` — list filtered to own folder, create vs update (`sha`), 409/422 →
  `ConflictError`, `whoAmI` cache invalidation on token change, `moveUnowned` incl. skip on clash.
- `qr-history.test.js` — upsert, memory, queries.
- `update-check.test.js` — version compare, asset pick, 404/no release, network error.
- `manifest.test.js` — extended for new permissions and files.
- Release script: dry-run mode tested for the file list it would zip.

Manual live check: deploy a report to a test instance (new + overwrite path), save conflict
between two browsers, one real release `v0.2.0` and its banner/download on an older install.
