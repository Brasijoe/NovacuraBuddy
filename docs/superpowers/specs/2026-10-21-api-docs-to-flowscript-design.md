# API Docs → Flowscript modules — Design Spec

Date: 2026-10-21
Status: draft for review
Branch: `claude/project-thread-q042ox`

## 1. Purpose

A fifth side-panel tab, **API Modules**, that reads a REST API description (OpenAPI 3.x or
Swagger 2.0) and generates a Novacura Flow module from it, shaped like the modules Connect's own
OData code-gen produces for IFS projections (reference: a generated `CustomerOrderHandling`
module). The result is created and committed as a module asset in the Flow package of the open
Designer tab, exactly like the Projection Tracker's "Create module".

Novacura has no generic REST generator, so this extension writes the Flowscript itself. Nothing
is sent to `/admin/code-gen`.

Success looks like:

- I open the tab, point it at a spec (current tab's URL, a URL I type, an uploaded or pasted
  `.json`/`.yaml`), and see the API's operations grouped by tag, all ticked.
- I untick what I don't need, give the module a name, press **Create module**, and the module
  appears in the Designer.
- In a script step, `select * from Pets where status = Petstore.PetStatus.sold` works: `status`
  goes to the API as `?status=sold`, and any other condition is applied to the returned rows.
- Writes are plain functions: `Petstore.addPet(input)`, `Petstore.deletePet(petId)`.
- All existing tests keep passing.

## 2. Decisions (agreed with Johannes, 2026-10-21)

| Topic | Decision |
|---|---|
| Formats | OpenAPI 3.0 / 3.1 and Swagger 2.0. Swagger 2.0 is normalized to OpenAPI 3 first, so there is one generator. Postman, HAR, RAML, API Blueprint, HTML/PDF docs: out of scope. |
| Input | URL of the active browser tab, typed URL, file upload (`.json`, `.yaml`, `.yml`), paste. |
| Auth + base URL | Not in the module. Both live in the Flow connector. The module only carries the base *path* (see 5.1). |
| Operation picker | Every operation listed, all ticked by default, with a tick/untick-all toggle (plus per-tag toggles). |
| Target | Module asset in the current Flow package, created or updated through `lib/flow-modules.js`. |
| `where` on a REST Queryable | Hybrid: `=` / `in` on a declared query parameter goes into the URL; everything else (other fields, `like`, `<`/`>`, `order by`, `select`) is applied in memory to the returned rows. |

## 3. Isolation (another working copy will be merged later)

All new logic goes in new files. Existing files get only small additive edits:

- `sidepanel.html`: one tab button, one `<section>`, a few `<script>` tags.
- `sidepanel.js`: add `"api-modules"` to `TABS`.
- `background.js`: one `importScripts(...)` line and one message case (`CREATE_API_MODULE`)
  that reuses the existing `captureDesignerTab` / `resolvePackageIdFor` / `boundFlowFetch` /
  `FlowModules.findOrCreateModule` / `commitModuleCode` path.
- `package.json`: add `apimodule/*.test.js` to the `test` script.
- `manifest.json`: no change. Fetching a spec from another host uses the already-declared
  `optional_host_permissions: ["https://*/*"]` via `chrome.permissions.request` for that origin.
- Firefox build (`firefox/`) is not touched.

New files:

```
apimodule/spec-load.js        parse JSON/YAML text, detect format + version
apimodule/swagger2-to-oas3.js normalize Swagger 2.0 → OpenAPI 3 (the subset we use)
apimodule/spec-model.js       resolve local $refs, build {schemas, operations, tags, basePath}
apimodule/flow-types.js       JSON Schema → Flowscript types/enums, name sanitizing
apimodule/flow-emit.js        emit the module source (runtime preamble + types + Queryables + functions)
apimodule/runtime.flowscript.js  the fixed Flowscript preamble as a JS string (see 5.2)
apimodule/*.test.js
panels/api-modules.js         the side-panel tab
lib/vendor/js-yaml.min.js     js-yaml 4.1.0, dist/js-yaml.min.js (UMD), recorded in VENDOR.md
```

## 4. Pipeline

1. **Load.** Text from the source. If it starts with `{` → `JSON.parse`, else `jsyaml.load`.
   The active-tab option uses `chrome.tabs.query({active, lastFocusedWindow})`; if the page is a
   Swagger UI / Redoc page rather than the raw spec, we look for the spec URL in the page
   (`<redoc spec-url>`, Swagger UI `url=` config) and fall back to telling the user to open the
   raw `openapi.json`.
2. **Detect.** `openapi: 3.x` → as is; `swagger: "2.0"` → normalize; anything else → clear error.
3. **Normalize Swagger 2.0.** `host`/`basePath`/`schemes` → `servers`; `definitions` →
   `components.schemas`; `in: body` param → `requestBody`; `in: formData` → form `requestBody`;
   response `schema` → `content["application/json"].schema`; `$ref` paths rewritten.
4. **Model.** Resolve local `$ref`s (`#/components/...`), with a cycle guard. External `$ref`s
   (other files/URLs) are reported as unsupported for v1. `allOf` is merged; `oneOf`/`anyOf`
   become `{}` (untyped record) with a comment. Each operation becomes
   `{ id, method, path, tag, summary, pathParams, queryParams, headerParams, body, response }`.
5. **Pick.** The tab shows operations grouped by tag, all ticked.
6. **Emit.** Only ticked operations, and only the schemas they reach, are emitted.
7. **Save.** Background message `CREATE_API_MODULE { moduleName, code }` → find or create the
   module asset, commit, then the existing activate/refresh flow.

## 5. Generated module

### 5.1 Header and base path

```
/*
Source: <spec URL, "uploaded: <file name>" or "pasted text">
API: <info.title> <info.version> (OpenAPI 3.0.4)
Auto generated code: 2026-10-21 11:30:00 (NovacuraBuddy <extension version>)
Base URL and authentication come from the connector; this module only adds the base path below.
*/
let basePath = 'v2';
open Seq;
```

`basePath` is the *path* of `servers[0].url` (`https://petstore.example.com/v2` → `v2`). The
connector supplies scheme, host and auth, exactly like `main/ifsapplications/projection/v1` in the
OData modules.

### 5.2 Fixed runtime preamble

Copied in style and naming from the OData module so Flow developers recognise it: `Header` type,
`HandleHeaders`, `MergeHeaders`, `addBasePath`, `GetResponse`/`PostResponse`/`PutResponse`/
`PatchResponse`/`DeleteResponse`, `HandleHTTPResponse`. Differences:

- `HandleFailedRequest` does not assume IFS's error shape: it reports status code, reason phrase
  and the raw body (trimmed).
- `DeleteResponse` accepts 200/202/204.
- New: `buildQueryParams(params: {name: text, value: text?}*)` → `a=1&b=x` (URL-encoded, nulls
  skipped, arrays repeated as `a=1&a=2`).
- New: the REST query translation and in-memory evaluator (5.4).

### 5.3 Name and type mapping

- **Names.** Operation function name = `operationId`, else `<method><PathInPascalCase>`
  (`GET /pets/{petId}` → `getPetsByPetId`). Invalid characters → `_`; leading digit → `_` prefix;
  clashes get `_2`, `_3`. Schema names keep their component name.
- **Types.** `string` → `text`; `string` + `date`/`date-time` → `datetime`; `integer`/`number` →
  `number`; `boolean` → `boolean`; `array` → `T*`; `object` with `properties` → record type;
  `object` without properties / `additionalProperties` only → `{}`; `binary` → `binary`.
  Non-required properties → `name: T? = null` (as in the OData output); in request types →
  `optional name: T`.
- **Enums.** A string enum becomes a module like the OData ones:
  `module PetStatus { type Value = available | pending | sold; let values ...; let fromText ... }`
  so `where status = PetStatus.sold` compiles. Enum values that aren't valid identifiers are
  sanitized and the original kept for serialization.

### 5.4 GET → Queryable (the hybrid)

A GET becomes a **Queryable** when its 200 response is an array, or an object wrapping one array
property (`value`, `items`, `data`, `results`, `content`, `records`, in that order; otherwise the
first array property, if there is exactly one). Every other GET stays a plain function.

- **No path params:** `let Pets = Queryable.Create<RestQueryTranslation, Pet, RestQuery>(restTranslation(['status','tags']), getPetsRows);`
  The list passed in is the operation's query parameters.
- **With path params:** a function returning a Queryable, like `MessageArray_From…` in the OData
  module: `function OwnerPets(ownerId: text) { return Queryable.Create<...>(..., getOwnerPetsRows(ownerId, _)); }`
- **Required query params** that are not path params are also arguments of such a function (they
  can't be left to a `where`).
- The plain function is still emitted too (`listPets(status: text? = null, limit: number? = null, headers)`)
  so a script can call the endpoint directly.

The translation compiles a `where` clause into a value of type `RestQuery`, instead of OData
filter text:

```
type RestQuery = {
    params: { name: text, value: text }*,   // conditions sent to the API
    test: {} -> boolean                      // conditions applied to each returned row
}
```

- `eq(field, literal)` where `field` is a declared query param → goes to `params`.
- `in(field, values)` on a declared query param → `params`, repeated (`status=a&status=b`).
- `conj(a, b)` merges both sides' params and ANDs their tests.
- Anything else (`neq`, `gt`, `ge`, `lt`, `le`, `like`, `disj`, a field that isn't a query param,
  `eq` inside an `or`) → no params, only `test`.

The rows function: builds the URL from `path + buildQueryParams(q.filter.params)`, calls
`GetResponse`, unwraps the array, keeps rows where `q.filter.test(row)`, then applies `order by`
and `select`/aliases in memory (same `renamerFunction` idea as the OData module). `group by` /
aggregates raise `error "group by is not supported on REST data sources"` in v1.

**Spike first (Task 1 of the plan).** The OData modules only ever use `text` as the third type
argument of `Queryable.Create`. Before building the emitter we write this preamble by hand for
one small public API (Swagger Petstore) and test it in the Designer, to confirm that a record
with a function field works as the compiled type. Fallback if it doesn't: compile to text in a
small fixed format and parse it in the rows function. The Flowscript surface (`select ... where`)
stays the same either way.

**Paging.** v1 makes one request. If the spec declares `page`/`pageSize`/`limit`/`offset`/
`cursor`-style params, they are normal query params the user can set in `where`. Automatic
"fetch all pages" is a later phase.

### 5.5 Other operations → functions

Same shape as the OData `_Create`/`_Update`/`_Delete` functions:

```
/** POST /pet — Add a new pet to the store */
function addPet(input: PetInsertRequest, headers: Header* = []): Pet {
    let __raw = JSON.deserialize<{}>(PostResponse(`/pet`, JSON.serialize(input), headers));
    return unsafeCast<Pet>(__raw);
}
```

Argument order: path params, required query params, `input` (request body, if any), optional
query params with `= null`, declared header params with `= null`, `headers: Header* = []`.
Responses without a JSON schema return `text`. A `multipart/form-data` or binary body uses the
`...Binary` helpers.

## 6. Side-panel tab

```
[ Source: (•) Current tab  ( ) URL  ( ) File  ( ) Paste ]  [Load]
Petstore 1.0.0 · OpenAPI 3.0.3 · 19 operations · base path /v2
Module name: [Petstore      ]
[x] Select all
 ▾ [x] pet (8)
     [x] GET  /pet/findByStatus   findPetsByStatus     Queryable
     [x] POST /pet                addPet
 ▸ [x] store (4)
 ▸ [x] user (7)
Warnings (2): external $ref skipped in Order.items …
[Preview code]  [Create module]
```

- Needs an open Designer tab, same as the tracker (button disabled with the same hint otherwise).
- Module name defaults to `info.title` sanitized to an identifier.
- If the module already exists in the package, the button reads **Update module** and asks for
  confirmation before overwriting.
- "Preview code" opens the generated source in a read-only textarea with a Copy button.
- The last loaded spec URL and the tick state are remembered per spec URL in
  `chrome.storage.local`.

## 7. Tests (`node --test`)

- Spec loading: JSON, YAML, Swagger 2.0 vs 3.0 vs 3.1 detection, bad input errors.
- Swagger 2.0 normalization on the Petstore 2.0 spec (fixture) matches a hand-written 3.0 shape.
- `$ref` resolution incl. a cycle; `allOf` merge.
- Name sanitizing and clash suffixes.
- Type mapping table (each row of 5.3).
- Queryable detection: bare array, each wrapper key, non-list GET.
- Emitter golden test: Petstore 3.0 fixture → expected `.flowscript` file, checked in.
- Picker: unticked operations and schemas only they reach are not emitted.

The generated Flowscript cannot be compiled in Node; the spike plus one manual check of the
Petstore module in the Designer covers that.

## 8. Out of scope for v1

Postman/HAR/RAML/API Blueprint/HTML/PDF input; external `$ref`s; auth; automatic paging;
`group by`/aggregates on REST Queryables; `oneOf`/`anyOf` as typed unions; webhooks/callbacks;
the Firefox build.

## 9. Open points (defaults chosen, easy to change)

1. Tab name **API Modules**.
2. Plain list GETs are emitted both as a Queryable and as a plain function.
3. The header names the source in a plain comment, not `#importSource(...)`: Connect reads that directive for IFS projections, and a REST spec URL there could confuse it.
