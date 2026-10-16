# IFS Projection Tracker — Design Spec

Date: 2026-10-16
Status: approved for planning

## 1. Purpose

A Chrome (MV3) browser extension that passively watches which IFS Cloud
projections (`*.svc`) get called while the user works in Aurena, shows them
live in a side panel, and — when a Novacura Flow Connect Designer tab is
also open — lets the user turn a traced (or manually searched) projection
into a Flow Connect module, push it into the Designer's open flow's package,
and activate it in that flow, without leaving the browser.

This is a sibling project to `IFS-Buddy` (`C:\dev\IFS-Buddy`), reusing
several of its proven, already-tested building blocks, but solving a
narrower problem at a different level: IFS-Buddy records a whole task's
traffic to generate a replayable Flow component. This tool only ever cares
*which projection* was touched, not the data that moved through it, and its
output is a Connect *module* (a FlowScript wrapper around one projection),
not a generated user flow.

## 2. Non-goals

- No request/response body capture, no `debugger` permission, no replay
  generation. (IFS-Buddy's recorder already does that; out of scope here.)
- No business-data access to IFS beyond projection *metadata*
  (`$metadata`, OpenAPI spec, `ProjectionExplorer.svc` catalog lookups) —
  same scope boundary IFS-Buddy's `ifs-oauth.js` already documents and
  enforces.
- No automatic FlowScript authoring (no generated call sites, no script
  steps). "Activate" means making the module available to the flow's
  FlowScript, nothing more.
- No visual/UX polish in v1. Functional, plain markup first; a design pass
  is a deliberate later phase.

## 3. Repository

New standalone repo: `C:\dev\ifs-flow-projection-tracker`. Chrome MV3
extension. Not part of `ifs-quick-report-deployer` (an unrelated Electron
app) — this ships as its own loadable extension, same pattern as
`flow-connect-tab-tree` / `flow-connect-package-exporter`.

Layout (mirrors IFS-Buddy's module-per-concern style):

```
manifest.json
background.js            Service worker: webRequest listeners, storage, orchestration
sidepanel.html/.css/.js  The panel UI (plain/functional in v1)
content/designer.js      Injected into build.novacura.com Designer tabs: refresh-button click
lib/
  projection-filter.js     Ported verbatim from IFS-Buddy
  excluded-projections.txt Ported verbatim from IFS-Buddy
  credential-crypto.js     Ported verbatim from IFS-Buddy
  ifs-instances.js         Multi-instance store + OAuth token fetch (ported subset of ifs-oauth.js)
  projection-search.js     ProjectionExplorer.svc lookups (ported subset of ifs-oauth.js)
  flow-modules.js          commitModule() sequence, ported from the documented flowModules.ts behavior
  flow-designer-tab.js     Parse packageId/itemId/orgId from a Designer tab; read/patch assets[]
  *.test.js                node --test, for every pure module above
```

## 4. Tracing

- `chrome.webRequest.onBeforeRequest`, `host_permissions` scoped to each
  configured IFS instance's base URL (not `<all_urls>` — narrower than
  IFS-Buddy, since no body capture is needed).
- A request is tracked only if its URL matches `*.svc` **and** passes the
  same exclusion filter IFS-Buddy uses: `lib/projection-filter.js` +
  `excluded-projections.txt`, ported verbatim (`isExcludedUrl`,
  case-insensitive match on the `.svc` segment, strips suffix).
- **On/off toggle** in the panel, persisted (`chrome.storage.local`,
  survives restart). When off, the listener still exists but short-circuits
  immediately — no partial state to reconcile when re-enabled.
- A traced hit is recorded per IFS instance (matched by request hostname
  against configured instances — see §5) as
  `{ projectionName, firstSeenAt, hitCount }`, deduplicated by name,
  `hitCount` incremented on repeat.
- Storage: `chrome.storage.session`, keyed per instance host. Cleared on
  browser restart; survives tab reloads/navigation (IFS-Buddy's own README
  flags reload-driven data loss as a real cost for this class of tool —
  this project deliberately avoids repeating it by not scoping storage to
  a tab or a single page load).

## 5. IFS instances (multi-instance login)

Ported from IFS-Buddy's `migration/credential-crypto.js` (unchanged) and
the OAuth client-credential slice of `migration/ifs-oauth.js`
(`ensureMasterKey`, `getIfsInstance`/`saveIfsInstance`/`deleteIfsInstance`,
`getIfsAuthToken`), adapted to this extension's own storage keys.

- Master password gates a PBKDF2-derived AES-GCM key; the key lives in
  `chrome.storage.session` once unlocked (not re-prompted every action
  within a browser session).
- Per instance: `{ name, baseUrl, authMethod, tokenEndpoint, clientId,
  encryptedSecret }`, `chrome.storage.local`, keyed by `baseUrl`.
- Panel section: list, add, edit, delete. A traced request whose host
  doesn't match any saved instance surfaces an inline "add this instance"
  prompt pre-filled with the host, rather than silently dropping the hit.
- **Scope boundary carried over unchanged**: every IFS call this project
  makes is metadata-only (projection catalog, `$metadata`, OpenAPI) — never
  business data.

## 6. Manual projection search

Independent of tracing. A search box (requires an unlocked instance):
queries `ProjectionExplorer.svc`'s `ProjExplorerQuerySet` by
`startswith(tolower(ProjectionName), ...)`, ported from `ifs-oauth.js`'s
`queryProjectionMeta` / `resolveCategorizedProjectionUrl` (the
Categories-dispatch logic: `"Integration"` → `*Int`, `"ExternalB2B"` →
`*B2b`, else `*Main` with fallback — a real bug IFS-Buddy already found and
fixed in this exact slice, ported as-is rather than re-derived).

## 7. Flow Designer tab detection

**`orgId` and `itemId` — confirmed real**, parsed directly from the
Designer tab's own URL path, per a real captured example:
`https://build.novacura.com/admin/design/designer/organizations/
{orgId}/items/{itemId}` (matches the same path `flow-connect-tab-tree`'s
`badgeFor()` already recognizes as "Asset/Module", extended here to
capture the ids rather than just classify the tab).

If path parsing ever fails (future URL-shape change), fall back to asking
the user to pick an org from `listOrganisations()`
(`GET /admin/security/api/v3/user/whoAmI`) rather than guessing — a
defensive fallback, not the expected path.

**`packageId` is not in that URL at all** — resolved by search, not parse,
using only already-confirmed endpoints: `GET .../organisations/{orgId}/
packages` to list every package, then for each one `GET .../packages/
{packageId}/assets` and `GET .../packages/{packageId}/products` (the same
two listing endpoints the module-commit sequence and the component/flow
creation logic already use) looking for an entry whose `id` matches the
tab's `itemId`. Cached per `itemId` once found, so it's a one-time cost per
Designer tab rather than per action. Flagged for live verification (§10) —
the listing entries are assumed to carry an `id` field matching the URL's
`itemId` verbatim, which hasn't been checked against a real multi-package
org yet.

The panel reflects Designer-tab presence as a live boolean; when absent,
Create/Activate controls are disabled with an inline reason rather than
hidden.

## 8. Module lifecycle: Create / Activate / Reload & Activate

**Status per projection row** (computed against the Designer tab's current
package + flow, when one is open):
- **Not created** — no module asset of that name in the package.
  → button: **Create**.
- **Created** — module asset exists, but its id is not in the open flow's
  current `assets[]`.
  → buttons: **Activate** (use the already-committed version as-is) and
  **Reload & Activate** (redownload + recommit first, see below).
- **Activated** — the module's id *is* in the flow's `assets[]`.
  - If that entry's `assetVersion` equals the module asset's current
    `mainBranch.headVersionId`: shown as plain **Activated**, no action
    needed.
  - If it's older (the module was recommitted since this flow last
    referenced it): shown as **Activated — update available**
    → button: **Reload & Activate** (bump the reference to the new
    version).

**Create** — fetch `$metadata` + OpenAPI for the projection (service URL
resolution via the same Categories-dispatch as §6), call Connect's
`POST /admin/code-gen/api/v1/flowscript/generate/Queryable`, then run
`commitModule()` (ported from the documented `flowModules.ts` sequence:
find-or-create asset by name → re-fetch full asset → three `text/plain`
writes keyed on the pre-commit `headVersionId` → validate on `branchId` →
update branch → commit branch (new `headVersionId`) → re-push designer XML
against the new version) against the Designer tab's `packageId`/`orgId`.

**Activate** — `GET` the open flow's current designer data
(`.../items/{itemId}/designer`), append `{ assetId, assetVersion:
headVersionId, offeredParameterType: "{}" }` to `assets[]` if not already
present, `POST` it back.

**Reload & Activate** — re-run Create's codegen+commit against the
*existing* module asset (same find-by-name step reuses it, so this always
produces a new version, never a duplicate asset), then run Activate's
append-or-bump against that new `assetId`/`assetVersion`.

## 9. Refresh-button toggle

After a successful Activate/Reload & Activate, `content/designer.js`
(injected into the Designer tab) attempts to locate and click a refresh
control. **Best-effort, explicitly unverified** (no real selector captured
yet) — on failure to find the control, degrades silently to a panel message
("Activated — refresh Designer manually"), never a hard error. Flagged for
live verification per §10.

## 10. Explicitly flagged for live verification (not assumed, not blocking)

1. The refresh button's real selector/structure in the Designer page.
2. Whether the package/product listing entries used to resolve `packageId`
   (§7) really carry an `id` matching the tab's `itemId` verbatim, across a
   real multi-package org.
3. Whether an `assets[]` entry's `assetVersion` staleness is visible/
   comparable the way §8 describes, once checked against a flow with a
   module added, recommitted, and re-opened.

Each ships with a visible fallback (manual nudge, user picker, or a plain
"Activated" without the staleness distinction) rather than a guess that
looks plausible and silently breaks.

## 11. Error handling

- No Designer tab open → Create/Activate disabled, reason shown inline.
- `orgId` unrecoverable → `listOrganisations()` picker, not a guess.
- Any step of the commit/activate sequence failing → surfaced with the
  real response body text, same `throwWithResponseBody` convention as
  `flowModules.ts` ("Flow Connect returns diagnostic detail in the body on
  failure — always read it before throwing").
- Refresh-button click failing → silent degrade, see §9.
- Wrong master password → retry with inline error, same pattern as
  `ifs-oauth.js`'s `ensureMasterKey`.

## 12. Testing

Following IFS-Buddy's convention (`node --test`): every pure/logic module
under `lib/` gets a `.test.js` — the ported filter/crypto modules keep
their upstream test coverage ported alongside them; the new modules
(`flow-modules.js`, `flow-designer-tab.js`, `ifs-instances.js`,
`projection-search.js`) get equivalent coverage written fresh. DOM-facing
glue (`sidepanel.js` rendering, `content/designer.js`'s click, the
`webRequest` wiring itself) is untested, matching IFS-Buddy's own stated
boundary for this class of code.

## 13. UI (v1)

Deliberately plain: a list (projection name, status badge, action
button(s)), an instance manager (list + add/edit/delete form), a search
box, and a tracking on/off toggle. No visual design pass in this iteration
— function first, by explicit request; a follow-up design pass is a
separate, later piece of work.
