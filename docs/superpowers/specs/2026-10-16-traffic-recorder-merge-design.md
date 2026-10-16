# Traffic Recorder merge — Design Spec

Date: 2026-10-16
Status: draft for review
Branch: `feat/traffic-recorder-merge` (based on `fix/global-asset-package`)

## 1. Purpose

Bring IFS Buddy's **Traffic Recorder** (debugger-based IFS traffic recording, the recorded-sessions
list, and the full Traffic Explorer with everything behind it, including Flow component generation)
into this extension as a **second, independent function** next to the Projection Tracker. The two
functions share **one set of basic data**: IFS instances, their encrypted credentials, and the
master password. Nothing else is shared or merged.

Success looks like:

- The side panel has three tabs — **Projection Tracker**, **Traffic Recorder**, **Basic Data** —
  with one consistent look.
- The recorder behaves exactly as it does in IFS Buddy: start/stop, recorded sessions with open /
  rename / delete, and the Traffic Explorer opened from a session with all its functionality
  unchanged. The only difference is where it reads IFS instances and credentials from.
- An IFS instance is defined once, in Basic Data, and both functions use it.
- Traffic to an IFS host that has no instance yet raises a notice with a way to save it right there.

## 2. Decisions (agreed 2026-10-16)

- **D1** Only IFS Buddy's recorder is merged. Its migration part is not. IFS Buddy itself stays
  untouched as its own extension.
- **D2** The recorder keeps the `debugger` permission (body capture), including Chrome's "is
  debugging this browser" bar while recording. The Tracker keeps its lightweight `webRequest`
  tracing; the two don't depend on each other.
- **D3** Sessions recorded earlier in IFS Buddy are not migrated (separate extension storage).
- **D4** Firefox is out of scope. The `firefox/` build is not changed by this work.
- **D5** Integration approach: **copy the recorder in 1:1 and change only one narrow seam** — the
  instance/credential access in `ifs-modules.js` — so it goes through the shared basic-data module.
  Rejected: copying with zero changes (two writers of the same instance store, duplicate instances
  from the URL mismatch below) and rewriting the recorder (~7,000 lines of proven logic at risk).

## 3. Structure and tabs

**Side panel** (`sidepanel.html`) becomes a three-tab shell. One shared header for all tabs:
Novacura logo, Locked/Unlocked chip, current instance selector, and the error/notice banners. The
last active tab is remembered (`chrome.storage.local`, per-viewer convenience).

- **Projection Tracker** — everything the tab does today: tracking toggle, search, projection
  list, Create (create + activate), Activate, Reload & Activate, Designer refresh, Designer/session
  hints. **Visual change only:** projection rows become cards in the recorder's "Recorded Sessions"
  style — title (projection name), a meta line (`status · N hits · first seen hh:mm`), and the
  existing action buttons on the right. Current colours and status chips stay.
- **Traffic Recorder** — Start / Stop / open-viewer buttons, status bar (`Ready to record` /
  `Recording… N calls`), and the "Recorded Sessions" cards with open, inline rename, and delete
  (confirm), as in IFS Buddy's popup. Clicking a card opens `recorder/viewer.html?s=<id>` in a new
  browser tab. Restyled with this extension's design tokens; behaviour unchanged.
- **Basic Data** — the instance management currently inside the Tracker tab: instance list with
  Test and Delete, the add form (connection check before save), and the Unlock row.

**Files**

- `sidepanel.js` keeps only the tab shell and the shared header (instance selector, lock chip,
  banners, `send`/`actionOrShowError` helpers, shared via a small `panels/common.js`).
- `panels/tracker.js`, `panels/recorder.js`, `panels/basic-data.js` — one module per tab, moved
  out of today's `sidepanel.js` (tracker, basic data) or ported from IFS Buddy's `popup.js`
  (recorder).
- `recorder/` — IFS Buddy's `recorder/` copied in: `viewer.html/.css/.js`, `json-grid.js`,
  `flow-*.js`, `ifs-modules.js`, `excluded-projections.txt`, their tests. `viewer.html` loads
  `credential-crypto.js` and `projection-filter.js` from `lib/` instead of its own copies —
  verified identical code (crypto differs only by a header comment), so there is exactly one copy
  of the crypto. The recorder keeps its **own** `excluded-projections.txt`: it deliberately differs
  from the Tracker's (the Tracker additionally hides AppearanceConfiguration, ClientContext,
  Translations, ClientNavigator), and changing it would change the Explorer's behaviour. Not
  copied: `Infos/`, `docs/`, `icons/` (reference material / duplicates).
- `lib/recorder-capture.js` — the recording part of IFS Buddy's `background.js` (debugger
  attach/detach, CDP `Network.*` capture, in-flight map, keep-alive, badge, finalize session).

**Manifest** — adds `debugger`, `alarms`, `unlimitedStorage`, `tabs` permissions. The toolbar badge
shows `REC` while recording.

## 4. Basic data (shared instance store)

`lib/ifs-instances.js` is the single owner of instance data. Storage keys and record format stay
exactly as both codebases already use them (`ifsInstances`, `credentialSalt`,
`credentialVerifier`, `credentialSessionKey`; `{ name, authMethod, tokenEndpoint, clientId,
encryptedSecret }`), so the recorder's copied code reads the same data.

- **Canonical instance key:** the URL's origin **without** a trailing slash
  (`https://ifscloud.flowington.com`). That is what the recorder derives from recorded calls
  (`extractIfsBaseUrl`), and what both functions' path concatenation expects. Every store entry
  point normalizes its `baseUrl` argument; existing entries stored with a trailing slash are
  migrated to the canonical key once, on first read. The Tracker's own per-instance keys (tracked
  projections in session storage) use the same canonical form.
- **Name:** an instance always has a name. One saved from the recorder's credentials dialog (which
  has no name field) gets the hostname as its name; it can be renamed in Basic Data.
- **One write path:** saving always goes through the store's save, which trims values, runs the
  connection check, and drops a cached IFS token for that instance. The master password, unlock
  state, and session key are the store's; unlocking in the side panel also unlocks the Traffic
  Explorer and vice versa (same `credentialSessionKey`).

## 5. Recorder integration

**The seam in `recorder/ifs-modules.js`** — its own copies of `getIfsInstance`, `saveIfsInstance`,
`getDecryptedSecret`, `ensureMasterKey` (storage part) and `getIfsAuthToken` are replaced by calls
to the shared store (loaded into `viewer.html` via `lib/credential-crypto.js` +
`lib/ifs-instances.js`). What stays the recorder's own: its master-password modal and its
`promptIfsCredentials` dialog (they are UI, not data) — they now hand their result to the shared
store, so "save it then and there" from inside the Explorer keeps working and lands in Basic Data.
`ensureIfsAccess`'s flow (check token, re-prompt on failure, save) is unchanged in behaviour.
Everything else in `recorder/` is unchanged.

**Background** — `background.js` loads `lib/recorder-capture.js`. One message router handles both
functions; the recorder's message types are routed to it unchanged: `START_RECORDING`,
`STOP_RECORDING`, `GET_STATUS`, `OPEN_VIEWER`, `GET_FLOW_TOKEN`, `CLEAR_FLOW_TOKEN`. Recording
state lives in `chrome.storage.session` (`isRecording`, `currentCalls`, `callCounter`) and
finalized sessions in `chrome.storage.local` (`sessions`), exactly as in IFS Buddy.

**Flow Connect token for the Explorer** — `GET_FLOW_TOKEN` is answered from the token the
extension already sniffs via `webRequest` (with its JWT-expiry handling) instead of IFS Buddy's
separate debugger attach to a Designer tab. If no token has been seen yet, the error says to open
or click into a `build.novacura.com` tab, like the Tracker's. `CLEAR_FLOW_TOKEN` clears it.

## 6. Unknown IFS instance

When IFS traffic hits a host with no instance in Basic Data — seen by the Tracker's `webRequest`
listener (today's unmatched-host list) or by the recorder's captured calls (checked when a session
is finalized) — the shared header shows a notice: "IFS instance `<host>` isn't set up yet" with
**Save now**. Save now switches to Basic Data with the add form pre-filled (base URL = canonical
origin, name = hostname); saving there runs the normal connection check. Dismissing hides the
notice for that host for the browser session.

## 7. Error handling

- Recorder errors keep IFS Buddy's own handling inside the Explorer. In the side panel, recorder
  actions (Start/Stop, rename, delete, open) use the same sticky action-error banner as the Tracker.
- Debugger attach failures on restricted tabs stay silently ignored (as in IFS Buddy); if not a
  single tab could be attached, Start reports it instead of showing "Recording…" with nothing
  recorded.
- Basic-data errors (locked, wrong password, connection check) surface identically in all tabs via
  the shared header.

## 8. Testing

- Copied recorder tests run unchanged (`recorder/*.test.js`), plus `lib/` tests.
- New unit tests: base-URL normalization and one-time key migration; name defaulting; the
  `ifs-modules` seam (instance read/save/token go through the shared store, verified with a fake
  storage); recorder-capture message routing (`START`/`STOP`/`GET_STATUS`), session finalize; the
  unknown-host notice logic (Tracker and recorder sources).
- Manual live checks: record a session on the real IFS instance, open it in the Explorer, generate
  a Flow component from it using the Basic Data instance without re-entering credentials; Tracker
  Create/Activate still work; an unknown host raises the notice and Save now stores it.

## 9. Out of scope

IFS Buddy's migration tool; Firefox; migrating old IFS Buddy sessions; any change to the Traffic
Explorer's behaviour or to the Tracker's behaviour beyond the card restyle.
