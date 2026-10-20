# Custom LU Deployer — Design Spec

Date: 2026-10-20
Status: implemented on feat/custom-lu-deployer — live check pending (see §9)
Branch: `feat/custom-lu-deployer` (based on `master` feb261d)

## 1. Purpose

Create, extend and deploy IFS Cloud **Custom Logical Units** (Custom LUs) from NovacuraBuddy:
create the LU and its attributes, approve, publish, grant the LU's projection to permission sets,
and then create the matching Flow Connect module. Three ways in:

1. **New** — define an LU by hand. Saved (create only) to the same GitHub data repo as Quick
   Reports, so it can be picked again and deployed to other instances.
2. **Existing** — pick a Custom LU that exists on the selected IFS instance and add attributes to it.
3. **Import** — read a Flow properties export and turn its Table properties into LUs. Flow Classic
   User properties are merged into one `UserProperties` LU.

Success looks like:

- A "Custom LUs" side-panel tab lists my library LUs and the selected instance's Custom LUs, and
  offers New and Import Properties.
- A full-page editor (`cl-editor.html`) shows each LU with one row per attribute; type (String /
  Number / Date / DateTime) and length (String only) are editable before anything is sent to IFS.
- Deploy runs the HAR-captured IFS sequence and ends with the LU published and granted; a Module
  button then creates the Flow module through the shared `createAndActivateModule`.
- Every failed step shows its real IFS error; nothing is reported as success unless IFS returned 2xx.
- All existing tests (526) keep passing after the shared pieces are extracted from Quick Reports.

## 2. Non-goals

- Changing the type/length of, or deleting, an attribute that already exists in IFS. The editor shows
  existing attributes read-only with the text: *"Deleting or changing attributes must be done in IFS."*
- Writing changes to a library LU back to GitHub. Library save is **create only**.
- Saving imported LUs to the library.
- Importing `TableValues` (row data). Only the LU shape is created.
- Cleanup/rollback of a half-deployed LU (see §7).
- Firefox build (`firefox/`) — not updated, same as the Quick Reports merge.

## 3. Reused, not duplicated

User rule: Projection Tracker, Quick Reports and this feature share code. Extract, don't copy.

| Need | Source today | After |
|---|---|---|
| IFS instances, credentials, master password | `lib/ifs-instances.js` (Basic Data) | unchanged, reused |
| GitHub token + data repo | `lib/github-settings.js` (Basic Data) | unchanged, reused |
| GitHub library (list/save per login) | `lib/qr-library.js` | generic `lib/gh-library.js` parameterised by folder prefix + file (de)serialiser; `qr-library.js` becomes a thin wrapper with prefix `quick-reports/` |
| Permission sets list + grant | `lib/qr-deploy.js` (`listPermissionSets`, `grantProjection*`) | `lib/ifs-permissions.js`; `qr-deploy.js` imports it |
| Permission-set picker UI | `panels/qr-deploy-form.js` | picker part moved to `panels/permission-picker.js`; QR deploy form uses it |
| IFS REST client (bearer token, If-Match, 401 retry) | `createIfsClient` in `lib/qr-deploy.js` | `lib/ifs-client.js`; both deployers use it |
| Flow module creation + Designer block reason | `panels/common.js` | unchanged, reused |

Quick Reports behaviour must not change; its existing tests are the guard.

## 4. Screens and flow

### Side panel — "Custom LUs" tab (`panels/custom-lus.js`)

- Instance picker (Basic Data instances).
- **Library** list: my LUs from `custom-lus/<github-login>/`, searchable. Pick → Deploy or Open in editor.
- **Environment** list: Custom LUs on the selected instance (`GET CustomLusSet?$select=Lu,LuType,...`).
  Pick → open editor in Existing mode. Each row also has a **Module** button.
- **New** → editor in New mode. **Import Properties** → file picker → editor in Import mode.

### Editor page — `cl-editor.html` / `cl-editor.js`

One block per LU: LU name, prompt, attribute table (name, prompt, type, length).

| Mode | LU name | Existing attributes | New rows | Save to library | Deploy |
|---|---|---|---|---|---|
| New | editable | — | yes | yes (create only) | all |
| Existing | read-only | read-only + IFS note | yes | no | new rows only |
| Import | editable per block, checkbox per block | — | yes | no | checked blocks |
| Library | read-only | — | no | already saved (create only) | all |

Types: **String** (length, default 100, max 4000), **Number**, **Date**, **DateTime**.

### Deploy (shared form, editor and side panel)

Permission sets via the shared picker → Deploy → per-LU step list with status → on success a
**Module** button calling `createAndActivateModule(baseUrl, <LuName>)`. Designer blocking is
reported through `designerBlockReason`, as in Quick Reports.

Deploy runs in the background service worker via a new message type `CL_DEPLOY` (mirrors `QR_DEPLOY`),
with the same host-permission request before sending.

## 5. Data

### Library file — `custom-lus/<github-login>/<slug>.json`

```json
{ "name": "CustomPageName", "prompt": "Custom Page Name",
  "attributes": [ { "name": "QTY",   "prompt": "Qty",   "type": "NUMBER" },
                  { "name": "NOTE",  "prompt": "Note",  "type": "STRING", "length": 100 },
                  { "name": "DUE",   "prompt": "Due",   "type": "DATE" },
                  { "name": "STAMP", "prompt": "Stamp", "type": "DATETIME" } ] }
```

Save refuses when the slug already exists ("already in library") — never overwrites.

### Library LU deployed where the LU already exists

Load the instance's attributes (`GET CustomLusSet(...)/CustomFieldAttributesArray`), add only the
missing ones. An attribute that exists with a different type/length is shown as a warning and left
untouched (same rule as Existing mode).

### Names

Attribute names are uppercased (IFS does this). Prompt defaults to proper case computed locally
(matches the captured `ToProperCase` result). Invalid names are flagged in the editor before deploy;
IFS validation calls (§6) still run and their errors are shown verbatim.

## 6. IFS sequence — `lib/custom-lu-deploy.js`

Base: `/main/ifsapplications/projection/v1/EntityConfigHandling.svc`. Captured 2026-10-20 (two HARs,
instance `ifscloud.flowington.com`) unless marked **UNCONFIRMED**. Payloads keep captured key order.

1. **LU** (skipped when it already exists):
   existence check `GET CustomLusSet(Lu='<Lu>',LuType=...CUSTOM_LU)` (404 = new — standard OData, not captured: **UNCONFIRMED**) → `GET ValidateLu(Lu='<Lu>')` → `POST CustomLusSet?select-fields=<captured field list, verbatim>` body
   `{Lu, Module:"CONFIG", Prompt, UsedDb:false, SynchronizedDb:false, EnabledRowkey:false, CreateProjectionDb:true, PublishedDb:false}`.
2. **Per new attribute:**
   - `GET ValidateAttributeName(AttributeName='<NAME>')`: **204 = valid; 200 = invalid**, the body's
     `value` is the reason (e.g. "The value of [Name] is invalid. First letter should be an uppercase
     alpha character") and becomes the step error. (`GetAttributeNameLength` is informational in the
     web client and is not called.)
   - `POST CustomAttributesVirtuals` with the captured default body (`Lu`, `LuType:"CUSTOM_LU"`, `DataType:"STRING"`, `DataLength:"100"`, …) → `Objkey` + `@odata.etag`
   - `POST CleanDisplayTextVirtual` body `{}` (sent by the web client right after the virtual is created)
   - `PATCH CustomAttributesVirtuals(Objkey=...)` with `If-Match: <virtual etag>` (the etag stays the same
     for every PATCH in the captures), in captured order:
     `{CustomAttributeType:"PERSISTENT_FIELD"}` → `{TextFormat:"UNFORMATTED"}` → type PATCHes → `{AttributeName, Prompt}`
   - type PATCHes:

     | Type | PATCHes after TextFormat | Source |
     |---|---|---|
     | String | `{DataLength:"<n>"}` | captured (`"4000"`) |
     | Number | `{DataType:"NUMBER", Indexed:false}` | **UNCONFIRMED** shape (mirrors the captured DATE PATCH; the virtual's GET showed `DataType:"NUMBER"`, `NumberFormat:"UNFORMATTED"` set by IFS) |
     | Date | `{DataType:"DATE", Indexed:false}` → `{DateFormat:"DATE"}` | captured |
     | DateTime | `{DataType:"DATE", Indexed:false}` → `{DateFormat:"DATETIME"}` | **UNCONFIRMED (guess, user-approved)** |
   - `POST CustomAttributesVirtuals(Objkey=...)/IfsApp.EntityConfigHandling.CustomAttributesVirtual_CreateCustomAttributes` body `{}`, `If-Match` virtual etag
   - `POST .../IfsApp.EntityConfigHandling.CustomAttributesVirtual_CleanupVirtualEntity` body `{}`, `If-Match` virtual etag — always runs, also after a failure (like the Quick Report draft cleanup)

   All EntityConfigHandling JSON calls send `Content-Type: application/json;IEEE754Compatible=true`,
   `Accept: application/json;odata.metadata=full;IEEE754Compatible=true`, `Prefer: wait=99999` (captured).
   Auth is the Basic Data bearer token, same as Quick Reports (no XSRF token needed).
3. **Approve attributes:** one `$batch` (`multipart/mixed`, one changeset) with
   `POST ApproveAttribute {Lu, LuType:"CUSTOM_LU", AttributeName}` per new attribute, plus every existing
   attribute with `Published: false` (left over from an earlier failed run), as the web client sends it.
   Each part's status is checked; a non-2xx part fails the step.
4. **Approve LU:** `POST Approve {Lu, LuType:"CUSTOM_LU"}`. (Fails with `ORA-20105 ... CFLU_NO_PERS_APPROV`
   when no attribute is approved — that is why step 3 comes first.)
5. **Publish:** `POST Publish {Lu, LuType:"CUSTOM_LU"}`.
6. **Grant:** `POST PermissionSetHandling.svc/GrantProjections {Projections:"PROJECTION_NAME=CustomProjection<first 22 chars of Lu>^", Role}` (live 2026-10-20; the Flow module uses the same name)
   per selected set, via `lib/ifs-permissions.js`. Projection name = LU name 1:1 — **UNCONFIRMED**
   (user statement, not traced).

Existing-LU reads: `GET CustomLusSet?$select=Lu,LuType,Objgrants,luname,keyref` (list) and
`GET CustomLusSet(Lu='<Lu>',LuType=IfsApp.EntityConfigHandling.CustomObjectsType'CUSTOM_LU')/CustomFieldAttributesArray`
(attributes: `AttributeName`, `DataType`, `DataLength`, `Published`).

## 7. Errors

- Each step goes through the shared `step(name, fn)` wrapper: first failure stops that LU and shows
  step name + IFS `error.details[].message` verbatim (fallback `error.message`, then HTTP status).
- Import batch: LUs deploy sequentially; one failing LU does not stop the rest. Per-LU result shown.
- No rollback. A half-deployed LU stays unapproved in IFS; re-running Deploy resumes because the
  LU and already-created attributes are skipped (§5).
- UNCONFIRMED calls fail loudly like any other — never swallowed, never shown as success.

## 8. Flow properties import — `lib/flow-properties.js`

- **Connect export** (array of `{Name, Type, Scope, Columns?, TableValues?, Value?}`, confirmed from
  `Properties.json`): `Type: "Table"` → one LU block, `Columns` → String attributes (length 100,
  editable). Text/scalar properties are skipped. `TableValues` is never read into the UI.
- **Flow Classic User properties** → one `UserProperties` LU, wide layout: one column per distinct
  user-property name (union) plus `USER_ID`. Built 2026-10-20 from the user's sample: the export has
  the same shape as Connect's, and every non-Table property with `Scope: "User"` goes into this LU.
- **Selection (both exports):** every importable table from the properties file — Connect Table properties and, once built, each Flow Classic table plus the merged `UserProperties` block — is listed with a checkbox; only ticked ones are deployed (user requirement 2026-10-20).
- Bad JSON / nothing importable → plain error, not an empty editor.

Note: Flow properties exports can contain secrets in `TableValues` (seen in `Properties.json`).
Test fixtures must be synthetic; real exports are never committed (repo is public).

### 8a. FlowProperties module — `lib/flow-properties-module.js` (user requirement 2026-10-20)

- Import mode only: the deploy form has a **Create FlowProperties Asset** toggle. When ticked, after
  the deploy every LU that deployed OK (✓) goes into one Flow module named `FlowProperties` at
  organisation level (App Library, no package). It is not added to any flow.
- Code comes from **Flow's code generator** (user choice): per LU, the projection
  `CustomProjection<first 22 chars>` is fetched from IFS (metadata + OpenAPI) and generated as for the
  Module button. Kept: the shared prelude (everything up to `GetTypeMismatchErrorMessage`) once, and per
  LU only `let <Entity>Set` plus the declarations it references (entity type, `get<Entity>SetRows`).
  Dropped: Reference_, ByKey, Create/Update/Delete/Copy and the `#importSource` header.
- **Merge** (user choice): each LU's code sits between `// >>> FlowProperties: <Lu>` and
  `// <<< FlowProperties: <Lu>`; a re-import replaces that LU's block, others stay, the prelude is the
  newest. A declaration another LU defines identically is kept once; a different one with the same
  name leaves that LU out with a warning. A `FlowProperties` module not made by NovacuraBuddy is never
  overwritten.
- Organisation = the last Flow Designer tab opened (remembered in `chrome.storage.local`), so it works
  from the editor page. UNCONFIRMED: reading the existing module via GET `items/{id}/designerXml/{head}`.
- A projection not yet visible right after Publish shows as a per-LU warning; deploying again with
  the toggle on retries it.

## 9. Testing

- `node --test` units with a mocked IFS client:
  - call order + payloads per type (String / Number / Date / DateTime)
  - skip existing LU and existing attributes; mismatch warning
  - `$batch` body build + per-part status parsing
  - first-failure stop; batch isolation across LUs
  - generic GitHub library: prefix isolation, create-only conflict
  - Connect properties parser edge cases
- Existing 526 tests stay green after the extraction (§3).
- Live checklist (user): new LU with all four types → published + granted + module; existing LU add
  attribute; library LU to second instance; import from `Properties.json`; DateTime confirmation;
  projection-name confirmation.
