# API Modules (REST API docs → Flowscript modules) — Implementation Plan

**Goal:** A fifth side-panel tab that loads an OpenAPI 3.x / Swagger 2.0 description, lets the user pick operations, generates a Flowscript module shaped like Connect's OData modules (list GETs as Queryables) and creates/commits it in the open Flow package.

**Architecture:** Pure logic in new UMD-style modules under `apimodule/` (testable with `node --test`, loaded by `<script>` in the side panel). The panel loads and parses the spec and generates the code. The background worker only does what needs credentials: fetching a spec from a Basic Data IFS instance (with that instance's token) and creating/committing/activating the module through the open Designer tab, the same `captureDesignerTab` → `resolvePackageIdFor` → `FlowModules` path as "Create module".

**Tech Stack:** Chrome MV3, plain JS (no build step), `node:test`, vendored `js-yaml` 4.1.0 (UMD).

**Spec:** `docs/superpowers/specs/2026-10-21-api-docs-to-flowscript-design.md`

**Reference module (read-only):** a Connect-generated OData module (`CustomerOrderHandling`), used for the runtime helpers (`Header`, `HandleHeaders`, `MergeHeaders`, `addBasePath`, `GetResponse`…, `RemapInput`, `fromTextFunction`, enum modules, `recordMappingFunction`, `renamerFunction`) and the `Queryable.Create<Translation, Row, text>(translation, rowsFn)` pattern.

## Global Constraints

- Plain JS only, no bundler, no new npm dependencies; every module uses the existing `(function (global) { ... })(typeof window !== "undefined" ? window : globalThis);` wrapper.
- Third-party code only from `lib/vendor/`, pinned and recorded in `lib/vendor/VENDOR.md`.
- IFS connections (a spec served by an IFS instance) use Basic Data instances and their stored credentials, never a separate login.
- Flow login, org and package come from the open Designer tab (as everywhere else); no Designer tab → button disabled with the shared `designerBlockReason` hint.
- Existing files only get additive edits (tab button/section/scripts, `TABS`, `importScripts`, two message cases, test glob). Firefox build untouched.
- All existing tests keep passing.

## Review Focus

- The Flowscript preamble can't be compiled in Node. The first generated Petstore module must be pasted/created in a Designer and the compiler's complaints fed back (Task 6).
- A `where` condition sent to the API as a query parameter must NOT also be applied in memory (e.g. `where limit = 10` would otherwise drop every row, since rows have no `limit` field).
- Field names that are not identifiers (`first-name`, `@type`) stay quoted in record types, so JSON round-trips unchanged.
- Recursive schemas (`Category.parent: Category`) must not loop the generator.

---

### Task 1: Vendor js-yaml + spec loading
**Files:** `lib/vendor/js-yaml.min.js`, `lib/vendor/VENDOR.md`, `apimodule/spec-load.js` (+test)
- `parseSpecText(text, yaml)` → object (JSON first, YAML fallback); `detectSpecVersion(doc)` → `{ kind: "oas3"|"swagger2", version }` or throws a readable error.
- `findSpecUrlInHtml(html, pageUrl)` → spec URL from a Swagger UI / Redoc / RapiDoc page, or null.

### Task 2: Swagger 2.0 → OpenAPI 3
**Files:** `apimodule/swagger2-to-oas3.js` (+test)
- servers from host/basePath/schemes; definitions/parameters/responses → components; body/formData → requestBody; response schema → content; `$ref` rewrite; `collectionFormat` kept as `x-collectionFormat`.

### Task 3: Spec model
**Files:** `apimodule/spec-model.js` (+test)
- `buildModel(oas3)` → `{ title, version, basePath, operations[], schemas, warnings[] }`; local `$ref` resolution, `allOf` merge, path-level params merged into operations, operation ids made unique.
- `listShape(schema)` → `{ wrapper: null|"items"|…, item }` or null: decides Queryable vs. function.

### Task 4: Flowscript type mapping
**Files:** `apimodule/flow-types.js` (+test)
- `createTypeRegistry()`: names/emits record types and enum modules for component and inline schemas, cycle-safe; `flowTypeOf(schema, hintName)` → Flowscript type text; identifier sanitizing, field-label quoting, reserved-word handling.

### Task 5: Emitter + runtime
**Files:** `apimodule/flow-runtime.js`, `apimodule/flow-emit.js` (+test, golden file `apimodule/fixtures/swagger-petstore-oas3.flowscript`)
- `generateModule(model, { selectedIds, moduleName, importSource, generatorVersion, now })` → source text. Header, preamble, enum modules, types, record mappers, Queryables (with/without path params), plain functions for every selected operation.

### Task 6: Live check in the Designer (Johannes)
- Create the Petstore module from Task 5's golden file in a Designer flow; run `select * from SwaggerPetstore.findPetsByStatus where status = ...` and one write. Fix the preamble from the compiler/runtime feedback before Task 7 ships.

### Task 7: Background + side-panel tab
**Files:** `panels/api-modules.js` (new), `sidepanel.html`, `sidepanel.js`, `sidepanel.css` (only if needed), `background.js`, `package.json`
- Messages: `API_FETCH_SPEC { url, masterPassword }` (uses the matching Basic Data instance's token when the URL is on one; otherwise a plain fetch after the panel obtained the host permission from the click), `API_CREATE_MODULE { moduleName, code }` (find-or-create + commit + activate + Designer refresh), module existence via the existing `GET_MODULE_STATUSES`.
- Tab: source picker (current tab / URL / file / paste), summary, module name, select-all + per-tag + per-operation checkboxes (all ticked), warnings, Preview, Create/Update module.

### Task 8: PR
- `npm test` green; PR with the Petstore module attached for the live check.
