/* ============================================================
   IFS Cloud Module Generation — credential storage, master
   password, IFS auth, IFS API calls, Flow module API calls,
   and orchestration.
   ============================================================ */
(function () {
  const IFS_INSTANCES_KEY = "ifsInstances";
  const CRED_SALT_KEY = "credentialSalt";
  const CRED_VERIFIER_KEY = "credentialVerifier";
  const SESSION_KEY_STORAGE = "credentialSessionKey";
  const CONFIRMED_MAPPINGS_KEY = "confirmedFieldMappings";
  // Semi-self-learning dependency mappings (feature request, 2026-08-08): a mapping only
  // auto-applies (skips the review modal) once the user has confirmed it this many times.
  // Below the threshold it's still shown every run so the user can change their mind.
  const CONFIRMED_MAPPING_THRESHOLD = 3;

  /* Diagnostic scaffolding: bisecting component-designer submission failures back to the last
   * state confirmed working live — plain script steps only, no dependency-reference
   * substitution, no If-Match header. Flip ONE thing on at a time and retest live rather than
   * guessing at several simultaneously. Remove all of this once every piece has been
   * individually re-verified. */
  const ENABLE_DEPENDENCY_SUBSTITUTION = true; // firstOrNull(Var).Field references between steps
  const ENABLE_USER_STEP_KINDS = {
    listSelection: true, // enabled 2026-08-12 for its own isolated live-test round, per user's explicit request — no composite key-ref matching or multi-select add-ons yet, see project_ifs_backlog.md
    text: true,
    number: true, // re-enabled after defaultValue "" -> null fix, confirmed live root cause 2026-08-07
    datetime: false
  };
  // Composite key-ref reconstruction (flow-keyref.js), designed + approved 2026-08-12. Case 1
  // only (single RECORD-kind prior-step match, see that file's own header comment) — off by
  // default, same "not yet live-tested" convention as everything else in this list, until a real
  // session confirms it end-to-end.
  const ENABLE_KEYREF_RECONSTRUCTION = false;

  // TEMPORARY WORKAROUND for a real Novacura Flow generator/compiler bug (found + reported to
  // Novacura, 2026-08-09; confirmed live). The generated FlowScript type for a struct like
  // CustomerDefaultsStructure gives most fields their own "= null" default (the generator's own
  // convention for "IFS's real payload may omit this field") — but Flow's compiler still rejects
  // a record literal missing ANY declared field regardless of that default ("field 'X' is
  // missing"), and several fields (enum-typed ones observed so far — OrderConfFlag, PickListFlag,
  // BackorderOption, etc.) get no default AND no `optional` marker from the generator at all,
  // even though IFS's own OData metadata (OpenAPI's "required" list) confirms they're genuinely
  // optional too — a gap in the generator's own default-injection logic, not ours.
  // applyOptionalFieldWorkaround rewrites the generated module source to add FlowScript's own
  // `optional` keyword to every field OpenAPI doesn't list as required, so the compiler's own
  // (already-correct-for-other-optional-fields) handling takes over instead of us guessing values.
  // UNDO this whole workaround (the flag, the function, its call site below) once Novacura fixes
  // their generator — user will confirm when that lands. See project_ifs_step_generation_status
  // memory (bugs #17/#18) for the investigation this came from.
  const ENABLE_OPTIONAL_FIELD_WORKAROUND = true;

  /** Rewrites every `type X = { ... }` declaration in flowScriptCode: for each field OpenAPI's
   *  schema for X does NOT list in its own "required" array, and which the generator didn't
   *  already mark `optional`, prefixes it with FlowScript's `optional` keyword. openApiJson is
   *  the raw fetched OpenAPI spec text — a missing/unparsable/empty spec is a safe no-op
   *  (returns flowScriptCode unchanged). A type with no matching OpenAPI schema (name not found
   *  under components.schemas/definitions) is left completely untouched — never guess. */
  function applyOptionalFieldWorkaround(flowScriptCode, openApiJson) {
    if (!flowScriptCode || !openApiJson) return flowScriptCode;
    let spec;
    try {
      spec = JSON.parse(openApiJson);
    } catch (e) {
      return flowScriptCode;
    }
    const schemas = (spec.components && spec.components.schemas) || spec.definitions || {};
    if (!schemas || Object.keys(schemas).length === 0) return flowScriptCode;

    // A type used as a Queryable's ROW type (e.g. `let Reference_CustOrdCust6 =
    // Queryable.Create<ODataQueryTranslation, CustOrdCust6, text>(...)`) is never constructed as
    // a `{...}` literal by generated code — it's only ever read back from a queried response, so
    // the "missing field in a literal" problem this workaround exists for never applies to it.
    // Real bug, 2026-08-09: applying it anyway marked CustOrdCust6's own KEY fields (Company,
    // CustomerNo — non-optional per that row type's own _Keys companion type) as optional too,
    // because OpenAPI's schema for a plain OData row type generally doesn't mark ANY field
    // required, keys included — a real quirk of IFS's OpenAPI generation for row/read types,
    // distinct from a genuinely-optional write-body/parameter structure like
    // CustomerDefaultsStructure. Any type matched here is skipped entirely, left exactly as
    // originally generated.
    const queryableRowTypeRe = /Queryable\.Create<[^,]+,\s*([A-Za-z0-9_]+)\s*,/g;
    const queryableRowTypes = new Set();
    let rowMatch;
    while ((rowMatch = queryableRowTypeRe.exec(flowScriptCode))) {
      queryableRowTypes.add(rowMatch[1]);
    }

    // Every `type Name = { ... }` block's brace range (end exclusive) and name.
    const typeBlockRe = /type\s+([A-Za-z0-9_]+)\s*=\s*\{/g;
    const blocks = [];
    let m;
    while ((m = typeBlockRe.exec(flowScriptCode))) {
      const braceStart = m.index + m[0].length - 1;
      let depth = 0;
      let end = -1;
      for (let i = braceStart; i < flowScriptCode.length; i++) {
        const c = flowScriptCode[i];
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end !== -1) blocks.push({ name: m[1], bodyStart: braceStart + 1, bodyEnd: end });
    }

    // Insertions collected as {pos, text}, applied in reverse position order so earlier offsets
    // in the same string stay valid as later ones are spliced in.
    const insertions = [];
    blocks.forEach((block) => {
      if (queryableRowTypes.has(block.name)) return; // a Queryable's row type — never touch
      const schema = schemas[block.name];
      if (!schema || !schema.properties) return; // no matching OpenAPI schema — leave untouched
      const required = new Set(schema.required || []);
      const body = flowScriptCode.slice(block.bodyStart, block.bodyEnd);
      let fieldStart = 0;
      let depth = 0;
      for (let i = 0; i <= body.length; i++) {
        const atEnd = i === body.length;
        const c = atEnd ? "," : body[i];
        if ("([{".includes(c)) depth++;
        else if (")]}".includes(c)) depth--;
        if ((c === "," && depth === 0) || atEnd) {
          const fieldText = body.slice(fieldStart, i);
          const trimmed = fieldText.replace(/^\s+/, "");
          const leadingWs = fieldText.length - trimmed.length;
          if (trimmed && !/^optional\s+/.test(trimmed)) {
            const colonIdx = trimmed.indexOf(":");
            const name = (colonIdx === -1 ? trimmed : trimmed.slice(0, colonIdx)).trim().replace(/^["']|["']$/g, "");
            if (name && schema.properties[name] && !required.has(name)) {
              insertions.push({ pos: block.bodyStart + fieldStart + leadingWs, text: "optional " });
            }
          }
          fieldStart = i + 1;
        }
      }
    });

    insertions.sort((a, b) => b.pos - a.pos);
    let result = flowScriptCode;
    insertions.forEach(({ pos, text }) => {
      result = result.slice(0, pos) + text + result.slice(pos);
    });
    return result;
  }

  // Same family/framing as ENABLE_OPTIONAL_FIELD_WORKAROUND above — a second, independent,
  // TEMPORARY workaround for a related Novacura generator gap, not a permanent feature. Delete
  // this flag + applyAnyTypedFieldWorkaround + its call site together once Novacura fixes it.
  const ENABLE_ANY_TYPED_FIELD_WORKAROUND = true;

  function escapeRegExpLocal(s) {
    return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /** TEMPORARY WORKAROUND, same family as applyOptionalFieldWorkaround above — real bug, live,
   *  2026-08-10: an action/function's own complex-typed parameter (e.g.
   *  CalculateAndFetchAvailableQty's ValidationRec — real IFS metadata (both CSDL and OpenAPI)
   *  declares it as IfsApp.CustomerOrderHandling.CustOrdLineValidation, a real struct with ~150
   *  real typed fields) gets generated as a bare `any` — Flow's generator drops the real type
   *  entirely for this parameter shape, even though both the OData metadata AND OpenAPI (the
   *  exact data this whole file already fetches for applyOptionalFieldWorkaround) have full
   *  field info. With no declared type anywhere for our own code to consult, a recorded numeric
   *  string (e.g. Identity4: "0", OData's Decimal-as-string convention) can't be told apart from
   *  a genuinely text one — server rejected it ("Invalid json type: STRING for Edm.Decimal
   *  property"). User's explicit framing for this fix: "fixes Broken code, not something
   *  entirely new" — same small, deletable-later, generation-time shape as
   *  applyOptionalFieldWorkaround, not a new runtime cross-referencing mechanism (an earlier,
   *  rejected approach scanned the whole module at record-literal-build time instead — abandoned
   *  for being both slow and the wrong layer to fix this at).
   *
   *  Fix: for each `type X = {...}` block whose containing type name has a matching OpenAPI
   *  schema (trying the exact name first, then with Flow's own generic "Request" suffix
   *  stripped — confirmed real: FlowScript's CalculateAndFetchAvailableQtyActionImportRequest
   *  <-> OpenAPI's CalculateAndFetchAvailableQtyActionImport), a field literally typed `any`
   *  whose OpenAPI counterpart is a `$ref` to a real object schema gets that field's TYPE
   *  replaced with the real type name — same field name, same position, only the type token
   *  changes. The referenced type itself is synthesized as a new `type X = {...}` block (appended
   *  at the end of the module) from OpenAPI's own property list, one level deep only (a property
   *  that's itself another unresolvable nested $ref stays untouched by this synthesis — matches
   *  this workaround's own deliberately bounded scope, same as applyOptionalFieldWorkaround never
   *  chasing anything beyond one type). Every synthesized field is marked `optional` — OpenAPI's
   *  own "required" list for this kind of structure is consistently empty in real captures (same
   *  observation applyOptionalFieldWorkaround is built on), used here too if a schema DOES list
   *  required fields. A field whose OpenAPI counterpart isn't a `$ref`, or whose $ref target has
   *  no `properties` (a plain scalar), is left as `any` untouched. */
  function applyAnyTypedFieldWorkaround(flowScriptCode, openApiJson) {
    if (!flowScriptCode || !openApiJson) return flowScriptCode;
    let spec;
    try {
      spec = JSON.parse(openApiJson);
    } catch (e) {
      return flowScriptCode;
    }
    const schemas = (spec.components && spec.components.schemas) || spec.definitions || {};
    if (!schemas || Object.keys(schemas).length === 0) return flowScriptCode;

    function refSchema(ref) {
      const name = ref.split("/").pop();
      return { name, schema: schemas[name] };
    }

    function flowTypeForProperty(propSchema) {
      if (!propSchema) return null;
      if (propSchema.$ref) {
        const { name, schema } = refSchema(propSchema.$ref);
        if (!schema || !Array.isArray(schema.enum)) return null; // nested non-enum object — not resolved here
        return `${name.split(".").pop()}.Value`;
      }
      if (propSchema.type === "string") return propSchema.format === "date-time" || propSchema.format === "date" ? "datetime" : "text";
      if (propSchema.type === "number" || propSchema.type === "integer") return "number";
      if (propSchema.type === "boolean") return "boolean";
      return null; // array/unknown-shape — not resolved here
    }

    function synthesizeTypeBody(schema) {
      const required = new Set(schema.required || []);
      const lines = Object.keys(schema.properties || {})
        .map((name) => {
          const flowType = flowTypeForProperty(schema.properties[name]);
          if (!flowType) return null;
          return `  ${required.has(name) ? "" : "optional "}${name}: ${flowType}`;
        })
        .filter(Boolean);
      return lines.length ? `{\n${lines.join(",\n")}\n}` : null;
    }

    // Every `type Name = { ... }` block's brace range + name — same scan shape as
    // applyOptionalFieldWorkaround above (deliberately not shared code between the two: each is
    // its own small, independently deletable workaround).
    const typeBlockRe = /type\s+([A-Za-z0-9_]+)\s*=\s*\{/g;
    const blocks = [];
    let m;
    while ((m = typeBlockRe.exec(flowScriptCode))) {
      const braceStart = m.index + m[0].length - 1;
      let depth = 0;
      let end = -1;
      for (let i = braceStart; i < flowScriptCode.length; i++) {
        const c = flowScriptCode[i];
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end !== -1) blocks.push({ name: m[1], bodyStart: braceStart + 1, bodyEnd: end });
    }
    const existingTypeNames = new Set(blocks.map((b) => b.name));

    const replacements = []; // {start, end, text} — applied in reverse position order
    const newTypeBlocks = []; // [{name, text}] — appended once at the end, deduped by name

    blocks.forEach((block) => {
      const schema = schemas[block.name] || schemas[block.name.replace(/Request$/, "")];
      if (!schema || !schema.properties) return;
      const body = flowScriptCode.slice(block.bodyStart, block.bodyEnd);

      Object.keys(schema.properties).forEach((name) => {
        const propSchema = schema.properties[name];
        if (!propSchema || !propSchema.$ref) return; // only the any-from-nested-object case
        const fieldRe = new RegExp(`\\b${escapeRegExpLocal(name)}\\s*:\\s*any\\b`);
        const fieldMatch = fieldRe.exec(body);
        if (!fieldMatch) return; // field isn't literally `any` here — already typed, or absent

        const { name: refName, schema: target } = refSchema(propSchema.$ref);
        if (!target || !target.properties) return; // enum $ref (no properties) or unresolvable
        const shortRefName = refName.split(".").pop();

        if (!existingTypeNames.has(shortRefName) && !newTypeBlocks.some((t) => t.name === shortRefName)) {
          const typeBody = synthesizeTypeBody(target);
          if (!typeBody) return;
          newTypeBlocks.push({ name: shortRefName, text: `type ${shortRefName} = ${typeBody};` });
        }
        const absoluteStart = block.bodyStart + fieldMatch.index;
        replacements.push({ start: absoluteStart, end: absoluteStart + fieldMatch[0].length, text: `${name}: ${shortRefName}` });
      });
    });

    if (replacements.length === 0) return flowScriptCode;
    replacements.sort((a, b) => b.start - a.start);
    let result = flowScriptCode;
    replacements.forEach((r) => {
      result = result.slice(0, r.start) + r.text + result.slice(r.end);
    });
    if (newTypeBlocks.length) {
      result += "\n\n" + newTypeBlocks.map((t) => t.text).join("\n\n") + "\n";
    }
    return result;
  }

  let cachedMasterKey = null; // in-memory CryptoKey cache for this page's lifetime

  async function getSessionKey() {
    if (cachedMasterKey) return cachedMasterKey;
    const { [SESSION_KEY_STORAGE]: exported } = await chrome.storage.session.get(SESSION_KEY_STORAGE);
    if (exported) {
      cachedMasterKey = await CredentialCrypto.importKeyRaw(exported);
      return cachedMasterKey;
    }
    return null;
  }

  async function setSessionKey(key) {
    cachedMasterKey = key;
    const exported = await CredentialCrypto.exportKeyRaw(key);
    await chrome.storage.session.set({ [SESSION_KEY_STORAGE]: exported });
  }

  async function hasMasterPasswordBeenSet() {
    const { [CRED_SALT_KEY]: salt } = await chrome.storage.local.get(CRED_SALT_KEY);
    return !!salt;
  }

  /** Returns a ready-to-use master key, prompting via promptFn only if not already cached this session.
   *  Retries on a wrong master password (re-prompting with an inline error) rather than throwing on the
   *  first bad attempt — the caller may already have created irreversible side effects (e.g. a Flow asset)
   *  before this is called, so a single mistyped password shouldn't force starting over. Cancelling the
   *  prompt (promptFn resolving null) still aborts immediately. */
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
        await chrome.storage.local.set({ [CRED_SALT_KEY]: salt, [CRED_VERIFIER_KEY]: verifier });
        await setSessionKey(key);
        return key;
      }

      const { [CRED_SALT_KEY]: salt, [CRED_VERIFIER_KEY]: verifier } = await chrome.storage.local.get([CRED_SALT_KEY, CRED_VERIFIER_KEY]);
      const key = await CredentialCrypto.deriveKey(password, salt);
      const ok = await CredentialCrypto.checkVerifier(key, verifier);
      if (ok) {
        await setSessionKey(key);
        return key;
      }
      errorMessage = "Incorrect master password, try again.";
    }
  }

  async function getIfsInstance(ifsBaseUrl) {
    const { [IFS_INSTANCES_KEY]: instances = {} } = await chrome.storage.local.get(IFS_INSTANCES_KEY);
    return instances[ifsBaseUrl] || null;
  }

  async function saveIfsInstance(ifsBaseUrl, authMethod, tokenEndpoint, clientId, secretPayload, masterKey) {
    const encryptedSecret = await CredentialCrypto.encryptText(masterKey, JSON.stringify(secretPayload));
    const { [IFS_INSTANCES_KEY]: instances = {} } = await chrome.storage.local.get(IFS_INSTANCES_KEY);
    instances[ifsBaseUrl] = { authMethod, tokenEndpoint, clientId, encryptedSecret };
    await chrome.storage.local.set({ [IFS_INSTANCES_KEY]: instances });
  }

  async function getDecryptedSecret(instance, masterKey) {
    const json = await CredentialCrypto.decryptText(masterKey, instance.encryptedSecret);
    return JSON.parse(json);
  }

  /* --- Master Password Modal --- */
  let mpModalOverlay = null;
  let pendingResolve = null; // resolve() of any in-flight promptMasterPassword() promise

  function ensureMpModalRoot() {
    if (mpModalOverlay) return;
    mpModalOverlay = document.createElement("div");
    mpModalOverlay.className = "modal-overlay";
    mpModalOverlay.style.display = "none";
    const panel = document.createElement("div");
    panel.className = "modal-panel mp-modal-panel";
    panel.onclick = (e) => e.stopPropagation();
    mpModalOverlay.appendChild(panel);
    document.body.appendChild(mpModalOverlay);
    mpModalOverlay._panel = panel;
  }

  // Both promptMasterPassword() and promptIfsCredentials() share the single mpModalOverlay
  // singleton (and its `pendingResolve` reentrancy guard). This must be called at the very
  // start of both, before building new content, so that opening EITHER prompt type always
  // resolves any still-pending prompt of either type (with null, i.e. treated as cancelled)
  // and leaves no stale onclick/resolver able to fire against the new prompt.
  function openMpOverlay() {
    ensureMpModalRoot();
    const panel = mpModalOverlay._panel;

    // A prior prompt (of either type) is still in-flight (its promise hasn't resolved yet)
    // and is about to have its DOM ripped out from under it below. Resolve it with null
    // (treat as cancelled) so its caller's promise never hangs.
    if (pendingResolve) {
      const stalePendingResolve = pendingResolve;
      pendingResolve = null;
      stalePendingResolve(null);
    }

    panel.innerHTML = "";
    mpModalOverlay.style.display = "flex";
    return panel;
  }

  function promptMasterPassword(isFirstTime, errorMessage) {
    const panel = openMpOverlay();

    return new Promise((resolve) => {
      pendingResolve = resolve;

      const header = document.createElement("div");
      header.className = "modal-header";
      const h2 = document.createElement("h2");
      h2.textContent = isFirstTime ? "Set a Master Password" : "Enter Master Password";
      header.appendChild(h2);

      const body = document.createElement("div");
      body.className = "modal-body";

      const hint = document.createElement("div");
      hint.className = "mp-hint";
      hint.textContent = isFirstTime
        ? "This password encrypts your stored IFS Cloud credentials. There is no recovery — if forgotten, stored IFS credentials must be re-entered."
        : "Unlocks your stored IFS Cloud credentials for this browser session.";

      const input = document.createElement("input");
      input.type = "password";
      input.autofocus = true;

      const errorBox = document.createElement("div");
      errorBox.className = "mp-error";
      if (errorMessage) {
        errorBox.textContent = errorMessage;
        errorBox.style.display = "block";
      } else {
        errorBox.style.display = "none";
      }

      body.append(fieldGroup("Master Password", input), hint, errorBox);

      const footer = document.createElement("div");
      footer.className = "modal-footer";
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "btn-action";
      cancelBtn.textContent = "Cancel";
      const submitBtn = document.createElement("button");
      submitBtn.className = "btn-primary";
      submitBtn.textContent = isFirstTime ? "Set Password" : "Unlock";
      footer.append(cancelBtn, submitBtn);

      const close = (value) => {
        pendingResolve = null;
        mpModalOverlay.style.display = "none";
        resolve(value);
      };

      cancelBtn.onclick = () => close(null);
      mpModalOverlay.onclick = (e) => { if (e.target === mpModalOverlay) close(null); };
      submitBtn.onclick = () => {
        if (!input.value) {
          errorBox.textContent = "Password cannot be empty.";
          errorBox.style.display = "block";
          return;
        }
        close(input.value);
      };
      input.onkeydown = (e) => { if (e.key === "Enter") submitBtn.onclick(); };

      panel.append(header, body, footer);
      input.focus();
    });
  }

  /** Reusable field-group builder, matching flow-asset.js's own (duplicated here since flow-asset.js doesn't expose it globally — both are tiny, single-purpose DOM helpers). */
  function fieldGroup(labelText, inputEl) {
    const group = document.createElement("div");
    group.className = "field-group";
    const label = document.createElement("label");
    label.textContent = labelText;
    group.append(label, inputEl);
    return group;
  }

  /* --- IFS Cloud OAuth token --- */
  const ifsTokenCache = {}; // ifsBaseUrl -> { token, expiresAt }

  async function getIfsAuthToken(ifsBaseUrl, masterKey) {
    const cached = ifsTokenCache[ifsBaseUrl];
    if (cached && cached.expiresAt > Date.now()) return cached.token;

    const instance = await getIfsInstance(ifsBaseUrl);
    if (!instance) throw new Error(`No stored IFS credentials for ${ifsBaseUrl}.`);
    const secret = await getDecryptedSecret(instance, masterKey);

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

    const res = await fetch(instance.tokenEndpoint, {
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
    ifsTokenCache[ifsBaseUrl] = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
    return data.access_token;
  }

  function clearIfsAuthToken(ifsBaseUrl) {
    delete ifsTokenCache[ifsBaseUrl];
  }

  /* --- IFS Cloud API calls --- */
  function resolveIfsUrl(ifsBaseUrl, urlOrPath) {
    return urlOrPath.startsWith("http") ? urlOrPath : ifsBaseUrl + urlOrPath;
  }

  /** Strips the trailing ".svc" filename segment off a projection path, e.g.
   *  "/main/ifsapplications/projection/v1/SalesQuotationHandling.svc" -> "/main/ifsapplications/projection/v1".
   *  This is what the code-gen service expects for its projectionSubPath input — passing the
   *  full .svc-including path there bakes a duplicated ".svc" segment into every generated
   *  call's URL (basePath already ends up including it once, and every Rows/action function
   *  it generates separately includes the .svc segment again in its own request template). */
  function dirnameOfPath(path) {
    const parts = String(path || "").split("/");
    return parts.slice(0, -1).join("/");
  }

  async function ifsFetch(ifsBaseUrl, path, token) {
    return fetch(ifsBaseUrl + path, { headers: { Authorization: `Bearer ${token}` } });
  }

  // Real confirmed-working query (captured 2026-08-06 from Flow Connect's own projection
  // picker): `startswith(tolower(ProjectionName),'customerorderaddressentity')` — tolower +
  // lowercased term, NOT toupper/uppercased. Real bug: our own toupper-based filter was
  // returning ZERO rows for at least this real Entity-kind projection (queryProjectionMeta
  // silently returning null, Categories never reaching resolveCategorizedProjectionUrl's fix,
  // so getServiceUrl still fell through to the wrong Main URL) even though the row genuinely
  // exists and IS found by the tolower form — confirmed by direct comparison against the
  // user's own captured real request, not guessed.
  async function queryProjectionMeta(ifsBaseUrl, token, projectionName) {
    const lower = projectionName.toLowerCase().replace(/'/g, "");
    const path = `/main/ifsapplications/projection/v1/ProjectionExplorer.svc/ProjExplorerQuerySet?$filter=startswith(tolower(ProjectionName),'${lower}')&$select=ProjectionName,Component,ApiClass,Active,Deprecated,Categories`;
    const res = await ifsFetch(ifsBaseUrl, path, token);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ProjectionExplorer query failed (${res.status})${text ? ": " + text : ""}`);
    }
    const data = await res.json();
    const rows = data.value || [];
    return rows.find((p) => p.ProjectionName.toUpperCase() === projectionName.toUpperCase()) || null;
  }

  /** Splits ProjExplorerQuerySet's own comma-separated Categories field into a clean list —
   *  confirmed real (2026-08-06): `selectedProjection.Categories.splitToTable(",")`. */
  function parseCategoryList(categoriesText) {
    return String(categoriesText || "").split(",").map((c) => c.trim()).filter(Boolean);
  }

  async function callProjectionExplorerFunction(ifsBaseUrl, token, functionName, projectionName) {
    const clean = projectionName.replace(/'/g, "");
    const res = await ifsFetch(ifsBaseUrl, `/main/ifsapplications/projection/v1/ProjectionExplorer.svc/${functionName}(ProjectionName='${clean}')`, token);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${functionName} failed (${res.status})${text ? ": " + text : ""}`);
    }
    const data = await res.json();
    return data.value || null;
  }

  /** Resolves a projection's real URL via ProjectionExplorer, keyed off its Categories —
   *  confirmed real (2026-08-06), ProjectionExplorer's own dispatch logic: a projection
   *  categorized "Integration" resolves via the `*Int` function, "ExternalB2B" via `*B2b`.
   *  Calling `*Main` for either was a real confirmed bug — a real Entity example
   *  (CustomerOrderAddressEntity, category "Integration") got a truthy-but-WRONG
   *  `/main/ifsapplications/entity/v1/...` URL back from GetServiceUrlMain (the correct one
   *  is under `/int/...`), so the old "only fall back to Int if Main returned nothing" logic
   *  never triggered — Main doesn't fail for an Integration-category projection, it just
   *  answers with the wrong URL. A projection with NEITHER category (the common case) still
   *  resolves via `*Main` directly, unchanged. A projection carrying BOTH categories at once
   *  (genuinely ambiguous) tries `*Main` first and only falls back to the category-specific
   *  function if `*Main` comes back empty — explicit instruction, 2026-08-06.
   *  `functionPrefix` is "GetServiceUrl" or "GetOpenApiV3Url" — both real functions share this
   *  exact Main/B2b/Int shape (confirmed real, see ProjectionExplorer's generated module
   *  source). */
  async function resolveCategorizedProjectionUrl(ifsBaseUrl, token, projectionName, categoriesText, functionPrefix) {
    const categories = parseCategoryList(categoriesText);
    const isIntegration = categories.includes("Integration");
    const isExternalB2B = categories.includes("ExternalB2B");
    const call = (suffix) => callProjectionExplorerFunction(ifsBaseUrl, token, `${functionPrefix}${suffix}`, projectionName);

    if (isIntegration && !isExternalB2B) return call("Int");
    if (isExternalB2B && !isIntegration) return call("B2b");

    const mainUrl = await call("Main");
    if (mainUrl) return mainUrl;
    if (isIntegration) return call("Int");
    if (isExternalB2B) return call("B2b");
    return null;
  }

  async function getServiceUrl(ifsBaseUrl, token, projectionName, categoriesText) {
    return resolveCategorizedProjectionUrl(ifsBaseUrl, token, projectionName, categoriesText, "GetServiceUrl");
  }

  async function getOpenApiUrl(ifsBaseUrl, token, projectionName, categoriesText) {
    return resolveCategorizedProjectionUrl(ifsBaseUrl, token, projectionName, categoriesText, "GetOpenApiV3Url");
  }

  async function fetchIfsText(url, token) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Fetch failed for ${url} (${res.status})${text ? ": " + text : ""}`);
    }
    return res.text();
  }

  async function getIfsCloudVersion(ifsBaseUrl, token) {
    const path = `/main/ifsapplications/projection/v1/FndSettings.svc/FndSettingsSet?$filter=Parameter eq 'FEATURE_UPDATE' or Parameter eq 'SERVICE_UPDATE'&$select=Parameter,Value`;
    const res = await ifsFetch(ifsBaseUrl, path, token);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`FndSettings query failed (${res.status})${text ? ": " + text : ""}`);
    }
    const data = await res.json();
    const rows = data.value || [];
    const feature = (rows.find((r) => r.Parameter === "FEATURE_UPDATE") || {}).Value || "";
    const service = (rows.find((r) => r.Parameter === "SERVICE_UPDATE") || {}).Value || "";
    return { featureVersion: feature, serviceVersion: service };
  }

  /* --- Flow code generation + module asset API (reuses flowFetch, exposed globally by flow-asset.js) --- */

  async function generateModuleCodeBinary(csdlXml, openApiJson, codeGenSubPath, importSourcePath, comment) {
    const payload = JSON.stringify({ csdlXml, openApiJson, projectionSubPath: codeGenSubPath });
    const payloadBytes = new TextEncoder().encode(payload);

    const res = await flowFetch("/admin/code-gen/api/v1/flowscript/generate/Queryable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payloadBytes
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Code generation failed (${res.status})${text ? ": " + text : ""}`);
    }
    const generatedCode = await res.text();

    const buildRes = await flowFetch("/admin/code-gen/build-number");
    const buildNo = buildRes.ok ? await buildRes.text() : "unknown";

    const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
    let header = `/*\r\n#importSource("${importSourcePath}")\r\nAuto generated code: ${timestamp} (build ${buildNo})\r\n`;
    if (comment) header += comment + "\r\n";
    header += "*/\r\n";
    return header + generatedCode;
  }

  async function findExistingModule(orgId, packageId, projectionName) {
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/packages/${packageId}/assets`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Could not list assets (${res.status})${text ? ": " + text : ""}`);
    }
    const assets = await res.json();
    const upperName = projectionName.toUpperCase();
    return (assets || []).find((a) => a.type === "module" && a.name.toUpperCase() === upperName) || null;
  }

  async function createModuleAsset(orgId, packageId, projectionName) {
    const body = JSON.stringify({
      name: projectionName,
      description: "Auto generated module.",
      color: "#4031F8", // distinct from other asset kinds' color — explicit instruction, 2026-08-06: modules only.
      type: "module",
      tagIds: []
    });
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/packages/${packageId}/assets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Could not create module (${res.status})${text ? ": " + text : ""}`);
    }
    return res.json();
  }

  async function getModuleAsset(orgId, packageId, assetId) {
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/packages/${packageId}/assets/${assetId}`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Could not load module (${res.status})${text ? ": " + text : ""}`);
    }
    return res.json();
  }

  function escapeXmlText(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  async function setModuleDesignerXml(orgId, assetId, moduleName, versionId, flowScriptCode) {
    const xml = `<Module><Name>${escapeXmlText(moduleName)}</Name><Source>${escapeXmlText(flowScriptCode)}</Source></Module>`;
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${assetId}/designerXml/${versionId}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "If-Match": "*" },
      body: xml
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Could not set designer XML (${res.status})${text ? ": " + text : ""}`);
    }
    return res.text();
  }

  async function setModuleTasks(orgId, assetId, versionId) {
    const tasks = '@{"$t":"NovaCura.Flow.Engine.Model.ConnectorTaskCollection","$v":1,"d":{}}';
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${assetId}/tasks/${versionId}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "If-Match": "*" },
      body: tasks
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Could not set module tasks (${res.status})${text ? ": " + text : ""}`);
    }
  }

  async function setModuleData(orgId, assetId, versionId, moduleName, code) {
    const body = JSON.stringify({ name: moduleName, source: code });
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${assetId}/data/${versionId}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "If-Match": "*" },
      body
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Could not set module data (${res.status})${text ? ": " + text : ""}`);
    }
  }

  async function commitModuleCode(orgId, packageId, assetId, flowScriptCode) {
    const asset = await getModuleAsset(orgId, packageId, assetId);
    if (asset.type !== "module") throw new Error("Asset is not a module.");
    const moduleName = asset.name;
    const headVersionId = asset.mainBranch.headVersionId;
    const branchId = asset.mainBranch.id;

    await setModuleDesignerXml(orgId, assetId, moduleName, headVersionId, flowScriptCode);
    await setModuleTasks(orgId, assetId, headVersionId);
    await setModuleData(orgId, assetId, headVersionId, moduleName, flowScriptCode);

    const validateRes = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${assetId}/branches/${branchId}/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assets: [] })
    });
    if (!validateRes.ok) {
      const text = await validateRes.text().catch(() => "");
      throw new Error(`Branch validation failed (${validateRes.status})${text ? ": " + text : ""}`);
    }
    const validation = await validateRes.json();

    const updateRes = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${assetId}/branches/${branchId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        headVersionId,
        parameterType: "{}",
        resultType: "{}",
        isInbox: false,
        snapshotToken: validation.snapshot,
        numberOfErrors: 0
      })
    });
    if (!updateRes.ok) {
      const text = await updateRes.text().catch(() => "");
      throw new Error(`Branch update failed (${updateRes.status})${text ? ": " + text : ""}`);
    }

    const commitRes = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${assetId}/branches/${branchId}/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ headVersionId, commitMessage: "Auto generated version." })
    });
    if (!commitRes.ok) {
      const text = await commitRes.text().catch(() => "");
      throw new Error(`Commit failed (${commitRes.status})${text ? ": " + text : ""}`);
    }
    const newBranch = await commitRes.json();

    await setModuleDesignerXml(orgId, assetId, moduleName, newBranch.headVersionId, flowScriptCode);
    return newBranch;
  }

  async function getFlowUserId() {
    const res = await flowFetch("/admin/security/api/v3/user/whoAmI");
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`whoAmI failed (${res.status})${text ? ": " + text : ""}`);
    }
    const data = await res.json();
    return (data.userBasicDto && data.userBasicDto.id) || "";
  }

  async function setComponentDesignerData(orgId, itemId, dataArray, assetRefs) {
    // No If-Match header — this is a brand-new component's first-ever designer save (never
    // needed one before user-step work started). Tried adding one after a 412 turned up on a
    // ground-truth capture, but that capture was an edit to an ALREADY-existing component with
    // real prior content, a different situation — reverted rather than layer more guessing on it.
    const body = JSON.stringify({
      assets: assetRefs || [],
      parameterTypeExpression: "{}",
      resultTypeExpression: "{}",
      errors: 0,
      isInbox: false,
      hasSuitcase: false,
      architecture: "sequential",
      data: dataArray
    });
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/items/${itemId}/designer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("setComponentDesignerData failed", { status: res.status, statusText: res.statusText, request: body, response: text });
      throw new Error(`Could not create component steps (${res.status})${text ? ": " + text : ""}`);
    }
    return res;
  }

  /** Builds the full designer data array (module-added + script steps + arrows) for every
   *  recorded call whose projection has a successfully generated module. Calls with no
   *  matching module (errored/skipped/deprecated projections) are silently left out — there's
   *  no module for their step to reference. */
  /** Stored shape used to be a plain array of confirmed mapping-key strings (a Set). It's now a
   *  per-key confirmation COUNT so a mapping only auto-applies once confirmed
   *  CONFIRMED_MAPPING_THRESHOLD times — below that it's shown again every run, re-editable.
   *  A stored array-of-strings (old shape) migrates to count=THRESHOLD per key: those mappings
   *  were already fully trusted under the old always-auto-apply behavior, so they keep
   *  auto-applying rather than making the user re-confirm them from zero. A stored array of
   *  [key, count] pairs (new shape) is read as-is. */
  function normalizeConfirmedMappings(stored) {
    if (!stored) return new Map();
    return new Map(
      stored.map((entry) => (Array.isArray(entry) ? entry : [entry, CONFIRMED_MAPPING_THRESHOLD]))
    );
  }

  function serializeConfirmedMappings(counts) {
    return Array.from(counts.entries());
  }

  /** Splits candidates into ones whose mapping has been confirmed enough times to auto-apply
   *  silently, and ones that still need the user's eyes (never confirmed, or confirmed fewer
   *  than CONFIRMED_MAPPING_THRESHOLD times). keyFn extracts each candidate's mapping key. */
  function partitionCandidatesByConfirmation(candidates, counts, keyFn) {
    const autoApply = [];
    const needsReview = [];
    candidates.forEach((c) => {
      const count = counts.get(keyFn(c)) || 0;
      (count >= CONFIRMED_MAPPING_THRESHOLD ? autoApply : needsReview).push(c);
    });
    return { autoApply, needsReview };
  }

  async function getConfirmedMappings() {
    const data = await chrome.storage.local.get(CONFIRMED_MAPPINGS_KEY);
    return normalizeConfirmedMappings(data[CONFIRMED_MAPPINGS_KEY]);
  }

  async function saveConfirmedMappings(counts) {
    await chrome.storage.local.set({ [CONFIRMED_MAPPINGS_KEY]: serializeConfirmedMappings(counts) });
  }

  /** Field-name-qualified before falling back to a bare search — same fix as
   *  FlowDependencyTracer.applyDependency and for the same reason: an unqualified
   *  `script.indexOf(literal)` matches whichever occurrence of that value comes first in the
   *  script text, which is wrong whenever two different fields share the same value (e.g. two
   *  "0" fields, or the same customer number repeated across several PATCH steps in one
   *  recording) — it substitutes into the wrong slot and corrupts the script. slotPath may be
   *  undefined for callers that don't have one, in which case this falls back straight to the
   *  bare-literal search. */
  function substituteLiteral(script, slotPath, literal, replacement) {
    const fieldName = FlowDependencyTracer.lastFieldName(slotPath);
    const qualified = fieldName ? `${fieldName}: ${literal}` : null;
    let idx = qualified ? script.indexOf(qualified) : -1;
    if (idx !== -1) {
      idx += qualified.length - literal.length; // point at the literal itself, past "FieldName: "
    } else {
      idx = script.indexOf(literal);
    }
    if (idx === -1) return script;
    return script.slice(0, idx) + replacement + script.slice(idx + literal.length);
  }

  /** Picks which two row fields describe a list-selection row: a readable one (name/description
   *  if one exists, else whatever else is available) for the large text, and the field whose
   *  value we actually need for the small text — matches the reference's own guidance
   *  ("largeRowText -> readable value like name/description", "smallRowText -> db value/id").
   *
   *  Real bug, live, 2026-08-12: the loose /name|desc/i substring match picked `luname` — IFS's
   *  own internal metadata field (present on nearly every entity, confirmed via real captures
   *  all session), NOT user-meaningful at all — because "luname" literally contains "name" as a
   *  substring. IFS's real API field names are consistently PascalCase (CustomerName,
   *  Description, LanguageCode, ...) except for a small, universal set of always-lowercase
   *  internal fields (luname, keyref, ...) — confirmed via every real JSON response seen this
   *  whole session. Excluding lowercase-starting fields before applying the name/desc heuristic
   *  is a reliable, general fix (not a one-off luname special-case) rather than trying to make
   *  the substring match itself cleverer. */
  function pickListDisplayFields(rowFields, idField) {
    const others = (rowFields || []).filter((f) => f !== idField);
    const meaningful = others.filter((f) => /^[A-Z]/.test(f));
    const largeField = meaningful.find((f) => /name|desc/i.test(f)) || meaningful[0] || others[0] || idField;
    return { largeField, smallField: idField };
  }

  /** No confirmed reference shape exists yet for boolean/unrecognized-type inputs — falls back
   *  to a text field rather than inventing an unverified control shape. */
  function createControlForKind(kind, targetVariableName, label, allowEmpty) {
    if (kind === "number") return FlowSteps.createNumericInputControl(targetVariableName, label, allowEmpty);
    if (kind === "datetime") return FlowSteps.createDateInputControl(targetVariableName, label, allowEmpty);
    return FlowSteps.createTextInputControl(targetVariableName, label, allowEmpty);
  }

  /* --- Dependency Review Modal --- */
  let depModalOverlay = null;

  function ensureDependencyModalRoot() {
    if (depModalOverlay) return;
    depModalOverlay = document.createElement("div");
    depModalOverlay.className = "modal-overlay";
    depModalOverlay.style.display = "none";
    const panel = document.createElement("div");
    panel.className = "modal-panel";
    panel.style.width = "480px";
    panel.onclick = (e) => e.stopPropagation();
    depModalOverlay.appendChild(panel);
    document.body.appendChild(depModalOverlay);
    depModalOverlay._panel = panel;
  }

  /** Builds one `<step-badge>.<field-path>` chunk — the step name gets its own pill so it reads
   *  as a distinct unit instead of running into the field path (real complaint 2026-08-10: a
   *  plain "GetCustomerOrderData.OrderNo" string reads as one undifferentiated blob). A nested
   *  field path (e.g. "ValidationRec.Identity4") stays joined as one piece — only the step/field
   *  boundary needed separating. */
  function buildStepFieldChunk(stepLabel, fieldPath) {
    const wrap = document.createElement("span");
    wrap.className = "dep-step-field";
    const stepBadge = document.createElement("span");
    stepBadge.className = "dep-step-badge";
    stepBadge.textContent = stepLabel;
    stepBadge.title = stepLabel; // full name on hover — the badge itself truncates when long
    const fieldSpan = document.createElement("span");
    fieldSpan.className = "dep-field-path";
    fieldSpan.textContent = fieldPath;
    wrap.append(stepBadge, fieldSpan);
    return wrap;
  }

  /** Builds a value chip (used in both the dependency-review and classify-remaining-values
   *  modals' meta rows) plus a small copy-icon button next to it. Real bug, 2026-08-11: a long
   *  value (JSON.stringify'd) had no length limit at all, so it forced the whole row wider than
   *  the fixed-width modal panel — pushed the checkbox/User-Input-Fixed toggle out of view
   *  entirely, no way to interact with that row. The chip itself is now CSS-truncated
   *  (max-width + ellipsis, see .dep-value-chip); this just supplies the two ways to still get at
   *  the full value: a native `title` tooltip on hover, and a copy button that puts it on the
   *  clipboard directly (mirrors renderErrorDetail's own copy-button pattern). Returns a
   *  DocumentFragment containing both elements, appendable wherever the bare chip used to go. */
  function buildValueChip(value) {
    const text = JSON.stringify(value);
    const chip = document.createElement("span");
    chip.className = "dep-value-chip";
    chip.textContent = text;
    chip.title = text;

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "dep-value-chip-copy";
    copyBtn.textContent = "⧉";
    copyBtn.title = "Copy full value";
    copyBtn.onclick = (e) => {
      e.preventDefault(); // this button can sit inside a <label> row (buildDependencyCandidateRow) — don't toggle the checkbox
      navigator.clipboard.writeText(text).then(() => {
        const original = copyBtn.textContent;
        copyBtn.textContent = "✓";
        setTimeout(() => { copyBtn.textContent = original; }, 1200);
      }).catch(() => {});
    };

    const frag = document.createDocumentFragment();
    frag.append(chip, copyBtn);
    return frag;
  }

  /** Builds one candidate row: fixed-position checkbox + a real Target/Source column pair (CSS
   *  grid, not flex — a flex row's checkbox/text relationship shifted around depending on
   *  content length before this, real complaint 2026-08-10) — the meta line (value + badges)
   *  spans both columns underneath. `c` is a group-item (see groupCandidatesByMapping) — display
   *  fields (stepIndex/slotPath/sourceLabel/... /value/viaListSelection/matchedByName) come from
   *  its first occurrence, c.occurrences carries every real one the row represents. Returns
   *  {row, checkbox}. */
  function buildDependencyCandidateRow(c, stepContexts, mappingCounts) {
    const row = document.createElement("label");
    row.className = "dep-candidate-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;

    const targetLabel = stepContexts[c.stepIndex].label;
    const targetChunk = buildStepFieldChunk(targetLabel, c.slotPath);
    targetChunk.classList.add("dep-col-target");
    const sourceChunk = buildStepFieldChunk(c.sourceLabel, c.sourceFieldPath);
    sourceChunk.classList.add("dep-col-source", "dep-step-field-source");

    const meta = document.createElement("div");
    meta.className = "dep-meta";
    meta.appendChild(buildValueChip(c.value));
    if (c.viaListSelection) {
      const badge = document.createElement("span");
      badge.className = "dep-badge dep-badge-list";
      badge.textContent = "pick from list";
      meta.appendChild(badge);
    }
    if (c.occurrences && c.occurrences.length > 1) {
      // Real request, 2026-08-10: don't ask to confirm the same mapping N times — one shared
      // row for the whole group instead (see groupCandidatesByMapping), with a count badge so
      // it's still visible that this applies in more than one place.
      const badge = document.createElement("span");
      badge.className = "dep-badge dep-badge-occurrences";
      badge.textContent = `×${c.occurrences.length}`;
      badge.title = `Applies to ${c.occurrences.length} places`;
      meta.appendChild(badge);
    }
    const count = mappingCounts && c.groupKey ? (mappingCounts.get(c.groupKey) || 0) : 0;
    if (count > 0) {
      const badge = document.createElement("span");
      badge.className = "dep-badge dep-badge-progress";
      badge.textContent = `confirmed ${count}/${CONFIRMED_MAPPING_THRESHOLD}x`;
      meta.appendChild(badge);
    }

    row.append(checkbox, targetChunk, sourceChunk, meta);
    return { row, checkbox };
  }

  /** Builds one tab's content: a Target/Source column header (once, above every row) followed by
   *  the candidate rows, or an empty-state message if `list` is empty — the pane itself is
   *  always built (never skipped) since which pane an empty tab shows still needs to render
   *  something when a user switches to it. Returns {container, checkboxes} — checkboxes is []
   *  for an empty pane. */
  function buildDependencyPane(list, stepContexts, mappingCounts, emptyMessage) {
    const container = document.createElement("div");
    container.className = "dep-pane";
    if (list.length === 0) {
      const empty = document.createElement("div");
      empty.className = "dep-empty";
      empty.textContent = emptyMessage;
      container.appendChild(empty);
      return { container, checkboxes: [] };
    }
    const colHeader = document.createElement("div");
    colHeader.className = "dep-columns-header";
    const spacer = document.createElement("span");
    const targetLabel = document.createElement("span");
    targetLabel.className = "dep-col-label";
    targetLabel.textContent = "Target";
    const sourceLabel = document.createElement("span");
    sourceLabel.className = "dep-col-label";
    sourceLabel.textContent = "Source";
    colHeader.append(spacer, targetLabel, sourceLabel);
    const rowsWrap = document.createElement("div");
    rowsWrap.className = "dep-section-rows";
    const checkboxes = list.map((c) => {
      const { row, checkbox } = buildDependencyCandidateRow(c, stepContexts, mappingCounts);
      rowsWrap.appendChild(row);
      return checkbox;
    });
    container.append(colHeader, rowsWrap);
    return { container, checkboxes };
  }

  /** Shows candidates not yet confirmed CONFIRMED_MAPPING_THRESHOLD times, lets the user pick
   *  which to apply this run, and returns the ones they kept checked (each subsequent confirm
   *  brings the mapping closer to auto-applying without review — see
   *  partitionCandidatesByConfirmation). Resolves immediately with [] if there's nothing to
   *  review. mappingCounts is optional — display-only, used to show a candidate's progress
   *  toward auto-apply.
   *
   *  Split into two tabs (requested 2026-08-10, after this session's own history of
   *  false-positive value-only matches made it clear the two signal strengths shouldn't look the
   *  same to the user): "Please Verify" (matched by value only — candidate.matchedByName false)
   *  shown FIRST/by default since it's the one that actually needs a human look; "High
   *  Confidence" (matched by both field name AND value) a click away. Both checkbox sets stay
   *  live regardless of which tab is showing (hidden via display:none, not removed), so
   *  switching tabs never loses a selection. */
  function reviewDependencyCandidates(candidates, stepContexts, mappingCounts) {
    if (candidates.length === 0) return Promise.resolve([]);
    ensureDependencyModalRoot();
    const panel = depModalOverlay._panel;
    panel.innerHTML = "";
    panel.style.width = "560px";
    panel.classList.add("dep-modal-dark");
    depModalOverlay.style.display = "flex";

    return new Promise((resolve) => {
      const header = document.createElement("div");
      header.className = "modal-header";
      const h2 = document.createElement("h2");
      h2.textContent = "Review Detected Step Dependencies";
      header.appendChild(h2);

      const body = document.createElement("div");
      body.className = "modal-body";
      const hint = document.createElement("div");
      hint.className = "mp-hint";
      hint.textContent = `These values look like they came from an earlier step's result. Confirming one applies it now and counts toward auto-applying it without review next time (after ${CONFIRMED_MAPPING_THRESHOLD} confirmations).`;
      body.appendChild(hint);

      const highConfidence = candidates.filter((c) => c.matchedByName);
      const toVerify = candidates.filter((c) => !c.matchedByName);

      const verifyPane = buildDependencyPane(toVerify, stepContexts, mappingCounts, "No matches need extra verification.");
      const highPane = buildDependencyPane(highConfidence, stepContexts, mappingCounts, "No high-confidence matches yet.");
      highPane.container.style.display = "none";

      const tabs = document.createElement("div");
      tabs.className = "dep-tabs";
      const verifyTab = document.createElement("button");
      verifyTab.type = "button";
      verifyTab.className = "dep-tab active";
      verifyTab.textContent = `Please Verify (${toVerify.length})`;
      const highTab = document.createElement("button");
      highTab.type = "button";
      highTab.className = "dep-tab";
      highTab.textContent = `High Confidence (${highConfidence.length})`;
      verifyTab.onclick = () => {
        verifyTab.classList.add("active");
        highTab.classList.remove("active");
        verifyPane.container.style.display = "";
        highPane.container.style.display = "none";
      };
      highTab.onclick = () => {
        highTab.classList.add("active");
        verifyTab.classList.remove("active");
        highPane.container.style.display = "";
        verifyPane.container.style.display = "none";
      };
      tabs.append(verifyTab, highTab);

      body.append(tabs, verifyPane.container, highPane.container);

      const orderedCandidates = toVerify.concat(highConfidence);
      const orderedCheckboxes = verifyPane.checkboxes.concat(highPane.checkboxes);

      const footer = document.createElement("div");
      footer.className = "modal-footer";
      const applyBtn = document.createElement("button");
      applyBtn.className = "btn-primary";
      applyBtn.textContent = "Apply Selected";
      applyBtn.onclick = () => {
        depModalOverlay.style.display = "none";
        resolve(orderedCandidates.filter((_, i) => orderedCheckboxes[i].checked));
      };
      footer.appendChild(applyBtn);

      panel.append(header, body, footer);
    });
  }

  /** Shows every leftover value group (unexplained by dependency tracing) and lets the user
   *  mark each as "User Input" (creates a prompt step for it) or "Fixed" (leave hardcoded).
   *  Defaults to "User Input" checked — surfacing genuine inputs is this feature's whole point,
   *  "Fixed" is the exception a user actively opts into. Resolves with the same groups, each
   *  annotated with isUserInput. */
  /** Builds one classify-row's User Input/Fixed segmented toggle. Two radios with the same
   *  `name` so only one is ever checked; styled as a two-button control via CSS
   *  (:has(input:checked)) rather than raw radio buttons, matching the rest of this modal's
   *  design language. Returns the User Input radio (its .checked is what the caller reads). */
  function buildUserInputChoiceToggle(groupIndex) {
    const toggle = document.createElement("div");
    toggle.className = "dep-choice-toggle";

    const userLabel = document.createElement("label");
    userLabel.className = "dep-choice-btn";
    const userRadio = document.createElement("input");
    userRadio.type = "radio";
    userRadio.name = `ui-group-${groupIndex}`;
    userRadio.checked = true;
    userLabel.append(userRadio, document.createTextNode("User Input"));

    const fixedLabel = document.createElement("label");
    fixedLabel.className = "dep-choice-btn";
    const fixedRadio = document.createElement("input");
    fixedRadio.type = "radio";
    fixedRadio.name = `ui-group-${groupIndex}`;
    fixedLabel.append(fixedRadio, document.createTextNode("Fixed"));

    toggle.append(userLabel, fixedLabel);
    return { toggle, userRadio };
  }

  function reviewUserInputGroups(groups) {
    if (groups.length === 0) return Promise.resolve([]);
    ensureDependencyModalRoot();
    const panel = depModalOverlay._panel;
    panel.innerHTML = "";
    panel.style.width = "520px";
    panel.classList.add("dep-modal-dark"); // same design language as the dependency review modal
    depModalOverlay.style.display = "flex";

    return new Promise((resolve) => {
      const header = document.createElement("div");
      header.className = "modal-header";
      const h2 = document.createElement("h2");
      h2.textContent = "Classify Remaining Values";
      header.appendChild(h2);

      const body = document.createElement("div");
      body.className = "modal-body";
      const hint = document.createElement("div");
      hint.className = "mp-hint";
      hint.textContent = "These values couldn't be traced to an earlier step. Mark each as user input (adds a prompt step) or fixed (leave hardcoded as recorded).";
      body.appendChild(hint);

      const rowsWrap = document.createElement("div");
      rowsWrap.className = "dep-section-rows";
      const userRadios = groups.map((g, i) => {
        const row = document.createElement("div");
        row.className = "dep-classify-row";

        const fieldChunk = buildStepFieldChunk(g.occurrences[0].stepLabel, g.fieldName);

        const meta = document.createElement("div");
        meta.className = "dep-meta";
        meta.appendChild(buildValueChip(g.value));
        if (g.occurrences.length > 1) {
          const badge = document.createElement("span");
          badge.className = "dep-badge dep-badge-occurrences";
          badge.textContent = `×${g.occurrences.length}`;
          badge.title = `Used in ${g.occurrences.length} places`;
          meta.appendChild(badge);
        }

        const { toggle, userRadio } = buildUserInputChoiceToggle(i);

        row.append(fieldChunk, meta, toggle);
        rowsWrap.appendChild(row);
        return userRadio;
      });
      body.appendChild(rowsWrap);

      const footer = document.createElement("div");
      footer.className = "modal-footer";
      const applyBtn = document.createElement("button");
      applyBtn.className = "btn-primary";
      applyBtn.textContent = "Continue";
      applyBtn.onclick = () => {
        depModalOverlay.style.display = "none";
        resolve(groups.map((g, i) => Object.assign({}, g, { isUserInput: userRadios[i].checked })));
      };
      footer.appendChild(applyBtn);

      panel.append(header, body, footer);
    });
  }

  /** Shows every detected-and-fully-matched composite key-ref candidate (flow-keyref.js, Case 1)
   *  and lets the user confirm or reject each — own standalone modal, deliberately NOT folded
   *  into the dependency-mapping or User Input ones (explicit design decision, 2026-08-12).
   *  Positioned between Dependency Review and Classify Remaining Values. A candidate only ever
   *  reaches this modal after already passing flow-keyref.js's own all-fields-match check
   *  (never a partial/guessed match), so defaults to confirmed/checked. Rejecting a row falls it
   *  through to Classify Remaining Values unchanged, same as if key-ref detection had never run
   *  at all. Resolves with the subset of candidates the user left checked. */
  function reviewKeyRefCandidates(candidates, stepContexts) {
    if (candidates.length === 0) return Promise.resolve([]);
    ensureDependencyModalRoot();
    const panel = depModalOverlay._panel;
    panel.innerHTML = "";
    panel.style.width = "560px";
    panel.classList.add("dep-modal-dark");
    depModalOverlay.style.display = "flex";

    return new Promise((resolve) => {
      const header = document.createElement("div");
      header.className = "modal-header";
      const h2 = document.createElement("h2");
      h2.textContent = "Review Reconstructed Composite Keys";
      header.appendChild(h2);

      const body = document.createElement("div");
      body.className = "modal-body";
      const hint = document.createElement("div");
      hint.className = "mp-hint";
      hint.textContent = "These values look like one of IFS's own composite key strings (e.g. \"CONTRACT=SLC1^ORDER_NO=...^\"), and every field inside matched an earlier step's result exactly. Confirming rebuilds the value live from that step instead of hardcoding it.";
      body.appendChild(hint);

      const rowsWrap = document.createElement("div");
      rowsWrap.className = "dep-section-rows";
      const checkboxes = candidates.map((c) => {
        const { row, checkbox } = buildKeyRefCandidateRow(c, stepContexts);
        rowsWrap.appendChild(row);
        return checkbox;
      });
      body.appendChild(rowsWrap);

      const footer = document.createElement("div");
      footer.className = "modal-footer";
      const applyBtn = document.createElement("button");
      applyBtn.className = "btn-primary";
      applyBtn.textContent = "Apply Selected";
      applyBtn.onclick = () => {
        depModalOverlay.style.display = "none";
        resolve(candidates.filter((_, i) => checkboxes[i].checked));
      };
      footer.appendChild(applyBtn);

      panel.append(header, body, footer);
    });
  }

  /** One key-ref candidate row: reuses .dep-candidate-row's check/target/source/meta grid shape
   *  (same as buildDependencyCandidateRow) — target is where the value is used, source is the
   *  prior step it got reconstructed from, meta shows the original recorded string plus the
   *  built expression. */
  function buildKeyRefCandidateRow(c, stepContexts) {
    const row = document.createElement("label");
    row.className = "dep-candidate-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;

    const targetChunk = buildStepFieldChunk(stepContexts[c.stepIndex].label, c.slotPath);
    targetChunk.classList.add("dep-col-target");
    const fieldCount = FlowKeyRef.parseKeyRefSegments(c.value).length;
    const sourceChunk = buildStepFieldChunk(c.keyRef.stepVarName, `${fieldCount} field${fieldCount === 1 ? "" : "s"}`);
    sourceChunk.classList.add("dep-col-source", "dep-step-field-source");

    const meta = document.createElement("div");
    meta.className = "dep-meta";
    meta.appendChild(buildValueChip(c.value));
    const expr = document.createElement("code");
    expr.className = "dep-value-chip"; // reuses the chip's own mono/truncation styling for the built expression too
    expr.textContent = c.keyRef.expression;
    expr.title = c.keyRef.expression;
    meta.appendChild(expr);

    row.append(checkbox, targetChunk, sourceChunk, meta);
    return { row, checkbox };
  }

  async function buildComponentSteps(session, moduleResults, userId, connector) {
    const byProjectionUpper = new Map(
      moduleResults.filter((r) => r.moduleId && r.flowScriptCode).map((r) => [r.projectionName.toUpperCase(), r])
    );

    // module-added entries and step/arrow entries are built as two separate arrays and
    // merged only at the end — addScriptStep's "is this the first step" check relies on
    // its own input array containing nothing but step-created/arrow-created entries.
    let modulesData = [];
    let stepsData = [];
    const addedModules = new Set();
    const stepContexts = []; // parallel to the script steps actually added, in order
    // Disambiguates a step's own display label when the SAME label comes up more than once in
    // this session — real bug, 2026-08-10: every $batch call gets the same hardcoded "BatchCall"
    // label (buildBatchCallScript), so a session with several batch calls made 3 genuinely
    // DIFFERENT dependency candidates (different target steps) look like the exact same mapping
    // shown 3 times in the review modal ("BatchCall.batch[0].0 ← ...OrderNo" x3) — nothing to do
    // with the modal itself, the underlying step labels really were indistinguishable. Not
    // specific to batch calls — any two calls that happen to share a label (e.g. the same entity
    // set fetched twice) get the same treatment. Also flows through to the real Flow step's own
    // displayed name (addScriptStep), which was equally ambiguous in Flow's own designer, not
    // just here.
    const usedStepLabels = new Map(); // label -> how many times seen so far
    // FlowScript's own `let` variable namespace is flat across the WHOLE flow, not scoped per
    // script step — real bug, live, 2026-08-11: buildNavigationQueryableScript's own internal
    // `let entity`/`let source` (and buildRawContextualCallScript's `let headers`) used the same
    // literal name every time, so two occurrences of the same call shape in one session collided
    // ("The identifier 'source' is already declared."). Shared across the whole loop below
    // (mutated in place by buildCallScript's own disambiguateLocalName calls), same scope as
    // usedStepLabels just above.
    const usedScriptLocalNames = new Set();
    // Top-level "assets" — the component's declared dependency on each module, separate from
    // the module-added entries inside `data`. Flow's own designer always populates this (one
    // entry per referenced module, carrying its current version id); we'd always sent `[]`.
    const assetRefs = [];
    // Mandatory directive, 2026-08-11: NEVER add a step whose script is just a commented-out
    // TODO placeholder — real bug, live, confirmed: buildCallScript's own `resolved: false`
    // returns were being fed to addScriptStep completely unconditionally, so a call we couldn't
    // resolve at all still showed up in the generated Flow as a real step containing
    // "// TODO: could not resolve a Flow function for GET ...", not caught until the user
    // actually opened the flow and found dead steps. Every skipped call is collected here instead
    // and surfaced as one clear, informative end-of-generation summary (step name + category) —
    // see the return statement below.
    const resolutionFailures = [];

    for (const call of session.calls || []) {
      const svcName = FlowCallScript.extractSvcName(call.url);
      if (!svcName) continue;
      const moduleInfo = byProjectionUpper.get(svcName.toUpperCase());
      if (!moduleInfo) continue;

      if (!addedModules.has(moduleInfo.projectionName)) {
        modulesData = FlowSteps.addModule(modulesData, moduleInfo.projectionName, moduleInfo.moduleId);
        assetRefs.push({
          assetId: moduleInfo.moduleId,
          assetVersion: moduleInfo.moduleVersionId,
          usedIndirectly: false,
          offeredParameterType: "any",
          requiredResultType: "any"
        });
        addedModules.add(moduleInfo.projectionName);
      }

      const resolved = FlowCallScript.buildCallScript(call, moduleInfo.projectionName, moduleInfo.flowScriptCode, usedScriptLocalNames);
      if (!resolved.resolved) {
        resolutionFailures.push({
          stepName: resolved.label || "Unknown",
          category: resolved.reason || "Unknown resolution failure",
          method: call.method,
          url: call.url
        });
        continue;
      }
      const method = String(call.method || "GET").toUpperCase();
      const type = method === "GET" ? "Get" : method.charAt(0) + method.slice(1).toLowerCase();
      const priorLabelCount = usedStepLabels.get(resolved.label) || 0;
      usedStepLabels.set(resolved.label, priorLabelCount + 1);
      // No space/parens — real bug, live, 2026-08-10: "This Output Variable naming is not
      // allowed in Flow: GetReference_CustOrderType (2)". This label doubles as the step's own
      // output-variable name in Flow, which only accepts a plain identifier — " (2)" isn't one.
      const stepLabel = priorLabelCount > 0 ? `${resolved.label}${priorLabelCount + 1}` : resolved.label;
      stepsData = FlowSteps.addScriptStep(stepsData, resolved.script, stepLabel, connector || null, null, userId, type, moduleInfo.projectionName);

      const stepEntry = stepsData.filter((d) => d.type === "step-created" && d.stepType === "script").slice(-1)[0];
      stepContexts.push({
        label: stepLabel,
        // Undisambiguated original label — flow-dependency-tracer.js's mappingKey uses this
        // (not `label`) to group repeats of "the same shaped call" (e.g. 3 $batch calls) into
        // one mapping, without needing to guess where a numeric disambiguation suffix ends and a
        // real name that happens to end in a digit begins.
        baseLabel: resolved.label,
        stepEntry,
        stepVarName: stepEntry.configuration.targetVariableName,
        resultKind: resolved.resultKind,
        responseBody: call.responseBody || null,
        valueSlots: resolved.valueSlots,
        // This step's own module (its `open X;`) — needed to qualify an enum fallback's
        // fromText(...) call when THIS step is a dependency-substitution target.
        moduleName: moduleInfo.projectionName,
        // This step's own declared field kinds (its result row type, or its function's return
        // type) — needed to know the SOURCE's real kind when THIS step is a dependency
        // candidate's source, so a text-declared field being substituted into an enum-typed
        // target can be converted rather than assumed already-matching. Confirmed live
        // 2026-08-08: GetCustomerDefaults.SupplyCountryDb.
        resultFields: resolved.resultFields || null
      });
    }

    if (stepsData.length === 0) return { data: [], assets: [], resolutionFailures };

    const usedVariableNames = new Set(stepContexts.map((c) => c.stepVarName));
    const listSelectionVars = new Map(); // sourceStepIndex -> variable name of its list-selection step

    // Nested (not a top-level helper) so it can insert a user step by reassigning the outer
    // `stepsData` in place — a top-level function taking stepsData as a parameter couldn't.
    /** Returns whether it actually substituted anything. Real bug, 2026-08-08: when a candidate
     *  needs list-selection (viaListSelection) but ENABLE_USER_STEP_KINDS.listSelection is off,
     *  this used to silently do nothing yet the caller still recorded the candidate as applied —
     *  findUnmappedSlots then excluded its slot from the classify pool as "already handled",
     *  so the value neither got substituted NOR ever offered for user-input classification: it
     *  just vanished, permanently hardcoded. Confirmed live via a real recorded session
     *  (Reference_CustOrdCust6, a $filter/$top=101 LOV-style search — correctly detected as a
     *  list source — feeding GetCustomerDefaults' CustomerNo). Callers must only treat a
     *  candidate as applied when this returns true, so a disabled-feature candidate falls
     *  through to the normal classify-as-user-input/fixed pool instead of disappearing. */
    function applyDependencyCandidate(candidate) {
      if (!candidate.viaListSelection) {
        const stepEntry = stepContexts[candidate.stepIndex].stepEntry;
        stepEntry.configuration.script = FlowDependencyTracer.applyDependency(stepEntry.configuration.script, candidate);
        return true;
      }

      if (!ENABLE_USER_STEP_KINDS.listSelection) return false; // leave hardcoded, skip entirely — see flag comment above

      let listVar = listSelectionVars.get(candidate.sourceStepIndex);
      if (!listVar) {
        const sourceCtx = stepContexts[candidate.sourceStepIndex];
        const { largeField, smallField } = pickListDisplayFields(candidate.sourceRowFields, candidate.sourceFieldPath);
        listVar = FlowUserInput.uniqueVariableName(FlowUserInput.variableNameFor(sourceCtx.label) + "Selection", usedVariableNames);
        // Real request, 2026-08-12: the control's own label was a hardcoded generic "List
        // selection" — same "Select <FieldName split into words>" convention already used for
        // text-input labels (FlowUserInput.controlLabelFor), e.g. "Select Language Code" for a
        // LanguageCode field, instead of a meaningless constant.
        const control = FlowSteps.createListSelectionControl(
          listVar, `Select ${FlowUserInput.controlLabelFor(candidate.sourceFieldPath)}`, sourceCtx.stepVarName, `{${largeField}}`, `{${smallField}}`, false
        );
        const beforeStepId = stepContexts[candidate.stepIndex].stepEntry.id;
        const result = FlowSteps.addUserStep(stepsData, beforeStepId, [control], `Select ${sourceCtx.label}`, userId);
        stepsData = result.data;
        listSelectionVars.set(candidate.sourceStepIndex, listVar);
      }

      const stepEntry = stepContexts[candidate.stepIndex].stepEntry;
      stepEntry.configuration.script = substituteLiteral(stepEntry.configuration.script, candidate.slotPath, candidate.slotLiteral, `${listVar}.${candidate.sourceFieldPath}`);
      return true;
    }

    const candidates = ENABLE_DEPENDENCY_SUBSTITUTION ? FlowDependencyTracer.findDependencies(stepContexts) : [];
    const appliedCandidates = [];

    if (candidates.length > 0) {
      const mappingCounts = await getConfirmedMappings();
      // Group candidates that represent the SAME underlying mapping (e.g. 3 separate $batch
      // calls in one session all mapping "batch[0].0" from the same source field) into one item
      // — real request, 2026-08-10: "if a batch calls the same function and mapping does not
      // change I do not want to verify mapping 3 times. One time is fine." Each group-item
      // carries every real occurrence; confirming/auto-applying a group applies ALL of them and
      // increments the shared confirmation count once, not once per occurrence.
      const groups = FlowDependencyTracer.groupCandidatesByMapping(candidates, stepContexts);
      const groupItems = groups.map((g) => Object.assign({}, g.occurrences[0], { occurrences: g.occurrences, groupKey: g.key }));
      const keyFn = (item) => item.groupKey;
      const { autoApply, needsReview } = partitionCandidatesByConfirmation(groupItems, mappingCounts, keyFn);

      const applyGroup = (item) => {
        let anyApplied = false;
        item.occurrences.forEach((c) => {
          if (applyDependencyCandidate(c)) {
            appliedCandidates.push(c);
            anyApplied = true;
          }
        });
        return anyApplied;
      };

      autoApply.forEach((item) => applyGroup(item));

      const userConfirmed = await reviewDependencyCandidates(needsReview, stepContexts, mappingCounts);
      if (userConfirmed.length > 0) {
        userConfirmed.forEach((item) => {
          if (!applyGroup(item)) return;
          mappingCounts.set(item.groupKey, (mappingCounts.get(item.groupKey) || 0) + 1);
        });
        await saveConfirmedMappings(mappingCounts);
      }
    }

    function isUserStepKindEnabled(kind) {
      if (kind === "number") return ENABLE_USER_STEP_KINDS.number;
      if (kind === "datetime") return ENABLE_USER_STEP_KINDS.datetime;
      return ENABLE_USER_STEP_KINDS.text; // text, boolean (falls back to text-input), anything else
    }

    const unmapped = FlowUserInput.findUnmappedSlots(stepContexts, appliedCandidates);

    // Composite key-ref reconstruction fallback (flow-keyref.js, Case 1) — only ever tried for a
    // value normal dependency matching already couldn't explain (runs against `unmapped`, never
    // competes with the dependency candidates above). Only PRIOR steps (stepContexts before this
    // value's own step) are eligible sources — a script step can only ever reference a variable
    // a step earlier in the same flow already computed. Flag-gated off by default.
    const keyRefCandidates = [];
    let stillUnmapped = unmapped;
    if (ENABLE_KEYREF_RECONSTRUCTION) {
      stillUnmapped = [];
      unmapped.forEach((item) => {
        const match = FlowKeyRef.tryReconstructKeyRef(item.value, stepContexts.slice(0, item.stepIndex));
        if (match) keyRefCandidates.push(Object.assign({}, item, { keyRef: match }));
        else stillUnmapped.push(item);
      });
    }

    if (keyRefCandidates.length > 0) {
      const confirmed = await reviewKeyRefCandidates(keyRefCandidates, stepContexts);
      const confirmedKeys = new Set(confirmed.map((c) => `${c.stepIndex}::${c.slotPath}`));
      keyRefCandidates.forEach((c) => {
        if (!confirmedKeys.has(`${c.stepIndex}::${c.slotPath}`)) {
          stillUnmapped.push(c); // rejected — falls through to Classify Remaining Values unchanged
          return;
        }
        const stepEntry = stepContexts[c.stepIndex].stepEntry;
        stepEntry.configuration.script = substituteLiteral(stepEntry.configuration.script, c.slotPath, c.slotLiteral, `(${c.keyRef.expression})`);
      });
    }

    // Groups whose kind isn't enabled are left out entirely — not just unapplied, never even
    // offered in the classify modal — so they stay hardcoded exactly as recorded.
    const valueGroups = FlowUserInput.groupUnmappedByValue(stillUnmapped).filter((g) => isUserStepKindEnabled(g.kind));
    if (valueGroups.length > 0) {
      const classified = await reviewUserInputGroups(valueGroups);
      const userInputGroups = classified.filter((g) => g.isUserInput);
      const insertionPoints = FlowUserInput.groupByInsertionPoint(userInputGroups);

      insertionPoints.forEach(({ stepIndex, groups }) => {
        const controls = groups.map((g) => {
          const varName = FlowUserInput.uniqueVariableName(FlowUserInput.variableNameFor(g.fieldName), usedVariableNames);
          const label = FlowUserInput.controlLabelFor(g.fieldName);
          const control = createControlForKind(g.kind, varName, label, g.nullable);
          g.occurrences.forEach((occ) => {
            const stepEntry = stepContexts[occ.stepIndex].stepEntry;
            // User-step controls always bind a text-typed FlowScript variable regardless of the
            // control widget shown (numeric-input is just client-side validation/formatting) —
            // substituting the bare variable into a number-typed record field is the same
            // "record literal is statically typed" mismatch already hit for enums and literal
            // numbers, just for a VARIABLE reference instead of a literal. val(text) -> number
            // converts it. Confirmed live 2026-08-07: bare `cProjectDiscount` in
            // `{CProjectDiscount: cProjectDiscount, ...}` 500'd; wrapKind (like-wildcard) and
            // number-kind wrapping are mutually exclusive — a like-wrapped slot is always text.
            // Same mismatch, different kind — real bug, live, 2026-08-10: "Argument
            // 'deliveryAddress' was expected to have type boolean?, but the expression has type
            // text." createControlForKind has no boolean-specific widget (falls back to a text
            // input, same "no confirmed reference shape yet" reasoning as its own comment), so a
            // boolean-kind user-input variable is ALSO always text-typed underneath — needs the
            // same text->boolean conversion convertKindMismatch already provides for a
            // dependency reference (added earlier the same day). Reused here rather than
            // duplicated, per this session's established practice.
            let replacement = varName;
            if (occ.wrapKind) replacement = FlowDependencyTracer.wrapLikeReference(varName, occ.wrapKind);
            else if (g.kind === "number") replacement = `val(${varName})`;
            else if (g.kind === "boolean") replacement = FlowDependencyTracer.convertKindMismatch(varName, "text", "boolean");
            stepEntry.configuration.script = substituteLiteral(stepEntry.configuration.script, occ.slotPath, occ.slotLiteral, replacement);
          });
          return control;
        });

        const beforeStepId = stepContexts[stepIndex].stepEntry.id;
        const stepLabel = groups.length > 1 ? "Enter Details" : `Enter ${FlowUserInput.controlLabelFor(groups[0].fieldName)}`;
        const result = FlowSteps.addUserStep(stepsData, beforeStepId, controls, stepLabel, userId);
        stepsData = result.data;
      });
    }

    stepsData = FlowSteps.addEndStep(stepsData);
    return { data: modulesData.concat(stepsData), assets: assetRefs, resolutionFailures };
  }

  async function updateModuleDescription(orgId, packageId, assetId, description) {
    const asset = await getModuleAsset(orgId, packageId, assetId);
    if (asset.type !== "module") throw new Error("Asset is not a module.");
    const body = JSON.stringify({
      name: asset.name,
      description,
      color: asset.color,
      type: asset.type,
      tagIds: asset.tagIds
    });
    const res = await flowFetch(`/admin/application/api/v2/organisations/${orgId}/packages/${packageId}/assets/${assetId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Could not update module description (${res.status})${text ? ": " + text : ""}`);
    }
    return res.json();
  }

  /* --- Session/projection helpers --- */
  function extractIfsBaseUrl(url) {
    const idx = url.indexOf("/main/ifsapplications/projection");
    return idx !== -1 ? url.slice(0, idx) : null;
  }

  function getSessionIfsBaseUrl(session) {
    for (const call of session.calls || []) {
      const base = extractIfsBaseUrl(call.url || "");
      if (base) return base;
    }
    return null;
  }

  /** Excluded projections (see excluded-projections.txt) are still recorded in full so their
   *  response data is available to the dependency tracer, but they never get turned into
   *  Flow modules or steps of their own. */
  async function loadExcludedProjections() {
    try {
      const res = await fetch(chrome.runtime.getURL("recorder/excluded-projections.txt"));
      return ProjectionFilter.parseExcludedList(await res.text());
    } catch (e) {
      return new Set();
    }
  }

  /* --- Credential Setup Form (reuses the master-password modal's overlay) --- */
  function promptIfsCredentials(ifsBaseUrl, prefill) {
    const panel = openMpOverlay();
    panel.classList.add("mp-modal-panel");

    return new Promise((resolve) => {
      pendingResolve = resolve;
      const header = document.createElement("div");
      header.className = "modal-header";
      const h2 = document.createElement("h2");
      h2.textContent = "IFS Cloud Credentials";
      header.appendChild(h2);

      const body = document.createElement("div");
      body.className = "modal-body";

      const urlLabel = document.createElement("div");
      urlLabel.className = "mp-hint";
      urlLabel.textContent = ifsBaseUrl;

      const methodToggle = document.createElement("div");
      methodToggle.className = "ifs-auth-method-toggle";
      const ccLabel = document.createElement("label");
      const ccRadio = document.createElement("input");
      ccRadio.type = "radio";
      ccRadio.name = "ifs-auth-method";
      ccRadio.value = "client_credentials";
      ccLabel.append(ccRadio, document.createTextNode("Client Credentials"));
      const pwLabel = document.createElement("label");
      const pwRadio = document.createElement("input");
      pwRadio.type = "radio";
      pwRadio.name = "ifs-auth-method";
      pwRadio.value = "password";
      pwLabel.append(pwRadio, document.createTextNode("Username + Password"));
      methodToggle.append(ccLabel, pwLabel);

      const tokenEndpointInput = document.createElement("input");
      tokenEndpointInput.type = "text";
      const clientIdInput = document.createElement("input");
      clientIdInput.type = "text";
      const clientSecretInput = document.createElement("input");
      clientSecretInput.type = "password";
      const usernameInput = document.createElement("input");
      usernameInput.type = "text";
      const passwordInput = document.createElement("input");
      passwordInput.type = "password";

      const clientSecretGroup = fieldGroup("Client Secret", clientSecretInput);
      const usernameGroup = fieldGroup("Username", usernameInput);
      const passwordGroup = fieldGroup("Password", passwordInput);

      const errorBox = document.createElement("div");
      errorBox.className = "mp-error";
      errorBox.style.display = "none";

      function applyPrefill() {
        if (!prefill) {
          ccRadio.checked = true;
          return;
        }
        (prefill.authMethod === "password" ? pwRadio : ccRadio).checked = true;
        tokenEndpointInput.value = prefill.tokenEndpoint || "";
        clientIdInput.value = prefill.clientId || "";
      }

      function updateVisibility() {
        const isPassword = pwRadio.checked;
        usernameGroup.style.display = isPassword ? "flex" : "none";
        passwordGroup.style.display = isPassword ? "flex" : "none";
      }
      ccRadio.onchange = updateVisibility;
      pwRadio.onchange = updateVisibility;
      applyPrefill();
      updateVisibility();

      body.append(
        urlLabel,
        methodToggle,
        fieldGroup("Token Endpoint", tokenEndpointInput),
        fieldGroup("Client ID", clientIdInput),
        clientSecretGroup,
        usernameGroup,
        passwordGroup,
        errorBox
      );

      const footer = document.createElement("div");
      footer.className = "modal-footer";
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "btn-action";
      cancelBtn.textContent = "Cancel";
      const submitBtn = document.createElement("button");
      submitBtn.className = "btn-primary";
      submitBtn.textContent = "Save & Continue";
      footer.append(cancelBtn, submitBtn);

      const close = (value) => {
        pendingResolve = null;
        mpModalOverlay.style.display = "none";
        resolve(value);
      };
      cancelBtn.onclick = () => close(null);
      mpModalOverlay.onclick = (e) => { if (e.target === mpModalOverlay) close(null); };

      submitBtn.onclick = async () => {
        errorBox.style.display = "none";
        const authMethod = pwRadio.checked ? "password" : "client_credentials";
        const tokenEndpoint = tokenEndpointInput.value.trim();
        const clientId = clientIdInput.value.trim();
        const secretPayload = authMethod === "client_credentials"
          ? { clientSecret: clientSecretInput.value }
          : { clientSecret: clientSecretInput.value || undefined, username: usernameInput.value.trim(), password: passwordInput.value };

        if (!tokenEndpoint || !clientId) {
          errorBox.textContent = "Token endpoint and Client ID are required.";
          errorBox.style.display = "block";
          return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = "Validating…";
        try {
          const params = new URLSearchParams();
          params.set("client_id", clientId);
          if (authMethod === "client_credentials") {
            params.set("grant_type", "client_credentials");
            params.set("client_secret", secretPayload.clientSecret);
          } else {
            params.set("grant_type", "password");
            if (secretPayload.clientSecret) params.set("client_secret", secretPayload.clientSecret);
            params.set("username", secretPayload.username);
            params.set("password", secretPayload.password);
          }
          const res = await fetch(tokenEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params.toString()
          });
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`Validation failed (${res.status})${text ? ": " + text : ""}`);
          }
          close({ authMethod, tokenEndpoint, clientId, secretPayload });
        } catch (err) {
          errorBox.textContent = err.message;
          errorBox.style.display = "block";
          submitBtn.disabled = false;
          submitBtn.textContent = "Save & Continue";
        }
      };

      panel.append(header, body, footer);
    });
  }

  async function ensureIfsAccess(ifsBaseUrl) {
    const masterKey = await ensureMasterKey(promptMasterPassword);
    let instance = await getIfsInstance(ifsBaseUrl);

    while (true) {
      if (instance) {
        try {
          await getIfsAuthToken(ifsBaseUrl, masterKey);
          return masterKey;
        } catch (err) {
          const result = await promptIfsCredentials(ifsBaseUrl, instance);
          if (!result) throw new Error("IFS credential setup cancelled.");
          await saveIfsInstance(ifsBaseUrl, result.authMethod, result.tokenEndpoint, result.clientId, result.secretPayload, masterKey);
          clearIfsAuthToken(ifsBaseUrl);
          instance = await getIfsInstance(ifsBaseUrl);
        }
      } else {
        const result = await promptIfsCredentials(ifsBaseUrl, null);
        if (!result) throw new Error("IFS credential setup cancelled.");
        await saveIfsInstance(ifsBaseUrl, result.authMethod, result.tokenEndpoint, result.clientId, result.secretPayload, masterKey);
        instance = await getIfsInstance(ifsBaseUrl);
      }
    }
  }

  /* --- Progress UI --- */
  let progressOverlay = null;
  let progressListEl = null;
  let progressFooterEl = null;

  function ensureProgressModalRoot() {
    if (progressOverlay) return;
    progressOverlay = document.createElement("div");
    progressOverlay.className = "modal-overlay";
    progressOverlay.style.display = "none";
    const panel = document.createElement("div");
    panel.className = "modal-panel";
    panel.style.width = "480px";
    panel.onclick = (e) => e.stopPropagation();

    const header = document.createElement("div");
    header.className = "modal-header";
    const h2 = document.createElement("h2");
    h2.textContent = "Generating Flow Modules";
    header.appendChild(h2);

    const body = document.createElement("div");
    body.className = "modal-body";
    progressListEl = document.createElement("div");
    progressListEl.className = "ifs-progress-list";
    body.appendChild(progressListEl);

    progressFooterEl = document.createElement("div");
    progressFooterEl.className = "modal-footer";

    panel.append(header, body, progressFooterEl);
    progressOverlay.appendChild(panel);
    document.body.appendChild(progressOverlay);
  }

  function renderProgressRow(name) {
    const row = document.createElement("div");
    row.className = "ifs-progress-row";
    const nameEl = document.createElement("span");
    nameEl.className = "name";
    nameEl.textContent = name;
    const statusEl = document.createElement("span");
    statusEl.className = "status pending";
    statusEl.textContent = "Pending";
    row.append(nameEl, statusEl);
    progressListEl.appendChild(row);
    return statusEl;
  }

  function setRowStatus(statusEl, cls, text) {
    statusEl.className = `status ${cls}`;
    statusEl.textContent = text;
  }

  /** Renders a full, scrollable, copyable error message — server error responses can be long
   *  (full response bodies), and a plain text node cuts off or wraps unreadably. Always also
   *  logged to the console (uncut) since that's the most reliable way to grab the whole thing. */
  function renderErrorDetail(container, label, text) {
    console.error(label ? `${label}: ${text}` : text);

    const wrap = document.createElement("div");
    wrap.className = "mp-error";
    wrap.style.display = "block";

    const pre = document.createElement("pre");
    pre.className = "error-detail-pre";
    pre.textContent = label ? `${label}: ${text}` : text;

    const copyBtn = document.createElement("button");
    copyBtn.className = "btn-tool";
    copyBtn.textContent = "Copy";
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(pre.textContent).then(() => {
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
      }).catch(() => {});
    };

    wrap.append(pre, copyBtn);
    container.appendChild(wrap);
    return wrap;
  }

  async function processProjection(ifsBaseUrl, masterKey, orgId, packageId, projectionName, ifsVersionComment, statusEl) {
    setRowStatus(statusEl, "working", "Checking IFS…");
    const token = await getIfsAuthToken(ifsBaseUrl, masterKey);
    const meta = await queryProjectionMeta(ifsBaseUrl, token, projectionName);

    if (meta && meta.Deprecated) {
      setRowStatus(statusEl, "skipped", "Skipped (deprecated)");
      return { outcome: "skipped", projectionName };
    }

    const warnInactive = !meta || meta.Active !== "Yes";

    setRowStatus(statusEl, "working", "Resolving service URL…");
    const serviceUrl = await getServiceUrl(ifsBaseUrl, token, projectionName, meta && meta.Categories);
    if (!serviceUrl) {
      setRowStatus(statusEl, "error", "No service URL");
      return { outcome: "error", projectionName, message: "No Main, Integration, or ExternalB2B service URL found." };
    }

    setRowStatus(statusEl, "working", "Fetching CSDL…");
    const csdl = await fetchIfsText(resolveIfsUrl(ifsBaseUrl, serviceUrl) + "/$metadata", token);

    setRowStatus(statusEl, "working", "Resolving OpenAPI spec…");
    const openApiUrl = await getOpenApiUrl(ifsBaseUrl, token, projectionName, meta && meta.Categories);
    const openApiJson = openApiUrl ? await fetchIfsText(resolveIfsUrl(ifsBaseUrl, openApiUrl), token) : "";

    setRowStatus(statusEl, "working", "Generating code…");
    const projectionSubPath = serviceUrl.startsWith("http") ? new URL(serviceUrl).pathname : serviceUrl;
    const codeGenSubPath = dirnameOfPath(projectionSubPath);
    const generatedFlowScriptCode = await generateModuleCodeBinary(csdl, openApiJson, codeGenSubPath, projectionSubPath, ifsVersionComment);
    const optionalFieldFixedCode = ENABLE_OPTIONAL_FIELD_WORKAROUND
      ? applyOptionalFieldWorkaround(generatedFlowScriptCode, openApiJson)
      : generatedFlowScriptCode;
    const flowScriptCode = ENABLE_ANY_TYPED_FIELD_WORKAROUND
      ? applyAnyTypedFieldWorkaround(optionalFieldFixedCode, openApiJson)
      : optionalFieldFixedCode;

    setRowStatus(statusEl, "working", "Finding module…");
    let module = await findExistingModule(orgId, packageId, projectionName);
    if (!module) {
      setRowStatus(statusEl, "working", "Creating module…");
      module = await createModuleAsset(orgId, packageId, projectionName);
    }

    setRowStatus(statusEl, "working", "Committing code…");
    const newBranch = await commitModuleCode(orgId, packageId, module.id, flowScriptCode);
    await updateModuleDescription(orgId, packageId, module.id, `${ifsVersionComment}\r\nAuto generated module.`);

    if (warnInactive) {
      setRowStatus(statusEl, "warning", "Done — activate in IFS");
      return { outcome: "warning", projectionName, moduleId: module.id, moduleVersionId: newBranch.headVersionId, flowScriptCode, message: "Projection is not active in IFS." };
    }

    setRowStatus(statusEl, "done", "Done");
    return { outcome: "done", projectionName, moduleId: module.id, moduleVersionId: newBranch.headVersionId, flowScriptCode };
  }

  async function startModuleGeneration(session, orgId, packageId, componentAsset, connector) {
    ensureProgressModalRoot();
    progressListEl.innerHTML = "";
    progressFooterEl.innerHTML = "";
    progressOverlay.style.display = "flex";

    // Top-level error boundary: flow-asset.js calls startModuleGeneration() without
    // await/.then/.catch (fire-and-forget), so any throw not already handled by a more
    // specific inner try/catch below would otherwise become an unhandled promise
    // rejection and leave the progress modal open forever with no way to dismiss it.
    try {
      const ifsBaseUrl = getSessionIfsBaseUrl(session);
      const excludedProjections = await loadExcludedProjections();
      const projections = FlowAssetHeuristic.distinctProjectionNames(session.calls || [])
        .filter((name) => !excludedProjections.has(name.toUpperCase()));

      if (!ifsBaseUrl || projections.length === 0) {
        finishProgress(componentAsset, [], orgId);
        return;
      }

      let masterKey;
      try {
        masterKey = await ensureIfsAccess(ifsBaseUrl);
      } catch (err) {
        progressListEl.innerHTML = "";
        renderErrorDetail(progressListEl, "Could not set up IFS Cloud access", err.message);
        finishProgress(componentAsset, [], orgId, true);
        return;
      }

      let ifsVersionComment = "";
      try {
        const token = await getIfsAuthToken(ifsBaseUrl, masterKey);
        const version = await getIfsCloudVersion(ifsBaseUrl, token);
        ifsVersionComment = `IFS Cloud ${version.featureVersion} (${version.serviceVersion}).`;
      } catch (err) {
        ifsVersionComment = "";
      }

      const rows = projections.map((name) => ({ name, statusEl: renderProgressRow(name) }));
      const results = [];
      for (const row of rows) {
        try {
          const result = await processProjection(ifsBaseUrl, masterKey, orgId, packageId, row.name, ifsVersionComment, row.statusEl);
          results.push(result);
        } catch (err) {
          setRowStatus(row.statusEl, "error", "Error");
          results.push({ outcome: "error", projectionName: row.name, message: err.message });
        }
      }

      const stepsStatusEl = renderProgressRow("Component steps");
      try {
        setRowStatus(stepsStatusEl, "working", "Creating steps…");
        const userId = await getFlowUserId().catch(() => "");
        const { data: stepsData, assets: stepAssets, resolutionFailures } = await buildComponentSteps(session, results, userId, connector);
        if (stepsData.length > 0) {
          await setComponentDesignerData(orgId, componentAsset.id, stepsData, stepAssets);
          setRowStatus(stepsStatusEl, "done", resolutionFailures.length > 0 ? `Done, ${resolutionFailures.length} call(s) skipped` : "Done");
        } else {
          setRowStatus(stepsStatusEl, "skipped", "No steps");
        }
        // Mandatory directive, 2026-08-11: a call we couldn't resolve into a real step is never
        // silently dropped OR added as dead TODO-commented script — it's collected during
        // generation (buildComponentSteps) and surfaced here as one clear, informative,
        // copyable summary (step name + error category per call) instead.
        if (resolutionFailures.length > 0) {
          const summaryText = `${resolutionFailures.length} call(s) could not be turned into a step:\n` +
            resolutionFailures.map((f) => `- ${f.stepName}: ${f.category} (${f.method} ${f.url})`).join("\n");
          renderErrorDetail(progressListEl, null, summaryText);
        }
      } catch (err) {
        setRowStatus(stepsStatusEl, "error", "Error");
        results.push({ outcome: "error", projectionName: "Component steps", message: err.message });
      }

      finishProgress(componentAsset, results, orgId);
    } catch (err) {
      renderErrorDetail(progressListEl, "Module generation failed unexpectedly", err && err.message ? err.message : err);
      progressFooterEl.innerHTML = "";
      finishProgress(componentAsset, [], orgId, true);
    }
  }

  function finishProgress(componentAsset, results, orgId, skipTally) {
    if (!skipTally) {
      const counts = { done: 0, warning: 0, skipped: 0, error: 0 };
      results.forEach((r) => { counts[r.outcome] = (counts[r.outcome] || 0) + 1; });

      const summary = document.createElement("div");
      summary.className = "ifs-summary";
      summary.textContent = `Component asset "${componentAsset.name}" created. Modules: ${counts.done} created/updated, ${counts.warning} need activation in IFS, ${counts.skipped} skipped (deprecated), ${counts.error} failed.`;
      progressListEl.appendChild(summary);

      results.filter((r) => r.message).forEach((r) => {
        renderErrorDetail(progressListEl, r.projectionName, r.message);
      });
    }

    const closeBtn = document.createElement("button");
    closeBtn.className = "btn-action";
    closeBtn.textContent = "Close";
    closeBtn.onclick = () => { progressOverlay.style.display = "none"; };

    // The component asset was already created in Flow before module generation started,
    // so give the user a way to navigate to it regardless of how module generation went
    // (matches the "Open in Flow" link flow-asset.js's showSuccess() used to show before
    // this orchestrator replaced that success view — see FLOW_BASE note below).
    const openBtn = document.createElement("button");
    openBtn.className = "btn-primary";
    openBtn.textContent = "Open in Flow";
    openBtn.onclick = () => {
      // flow-asset.js defines FLOW_BASE but doesn't expose it globally; matching its
      // literal here rather than refactoring flow-asset.js just to export it.
      const FLOW_BASE = "https://build.novacura.com";
      window.open(`${FLOW_BASE}/admin/design/designer/organizations/${orgId}/items/${componentAsset.id}`, "_blank", "noopener");
    };

    progressFooterEl.append(closeBtn, openBtn);
  }

  if (typeof window !== "undefined") window.startModuleGeneration = startModuleGeneration;

  // Guarded Node export — this file is otherwise a browser-only IIFE (DOM/chrome.* APIs used
  // throughout function bodies), but parseCategoryList/resolveCategorizedProjectionUrl's
  // category-list parsing is pure and worth unit testing (see ifs-modules.test.js). Only
  // activates under Node; no effect in the real extension.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      parseCategoryList,
      resolveCategorizedProjectionUrl,
      queryProjectionMeta,
      substituteLiteral,
      normalizeConfirmedMappings,
      serializeConfirmedMappings,
      partitionCandidatesByConfirmation,
      CONFIRMED_MAPPING_THRESHOLD,
      applyOptionalFieldWorkaround,
      applyAnyTypedFieldWorkaround,
      pickListDisplayFields
    };
  }
})();
