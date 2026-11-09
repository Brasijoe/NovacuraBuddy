/* Classic REST method call -> call of a function in a module generated from the API's OpenAPI spec
 * (API Modules generator). Used only when the user gave a spec for the call's connector; anything
 * that cannot be mapped safely returns null and the caller keeps today's translation.
 *
 * spec = { moduleName, basePath, signatures: [{ id, operationId, method, path, summary, fnName,
 *          args: [{ name, arg, in: "path"|"query"|"body"|"header", optional }], returnsJson }] }
 */
import { adaptMethodParameter, buildRestCallBodyTemplate } from "./classicMethodCallDecoder.js";
import { renderInputValue } from "./classicCallScriptDecoder.js";

const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, "");

/** "/a/{x}/b?q={y}" -> { key: "/a/{}/b", placeholders: ["x"], query: [{ key: "q", placeholder: "y" }] } */
function parseTemplate(path) {
  const [rawPath, rawQuery = ""] = String(path || "").split("?");
  const placeholders = [];
  const key = ("/" + rawPath.trim().replace(/^\/+|\/+$/g, ""))
    .replace(/\{([^}]*)\}/g, (_, name) => {
      placeholders.push(name.trim());
      return "{}";
    })
    .toLowerCase();
  const query = rawQuery.split("&").filter(Boolean).map((pair) => {
    const [k, v = ""] = pair.split("=");
    const m = v.match(/^\{([^}]*)\}$/);
    return { key: decodeURIComponent(k), placeholder: m ? m[1].trim() : null, constant: m ? null : decodeURIComponent(v) };
  });
  return { key, placeholders, query };
}

/** The spec function a Classic call uses: by method + path of the REST project's operation when
 *  one is known (exact, then by path suffix since the spec's server base path may be part of the
 *  .ncrcp resource), else by the Classic display name against operationId / function name /
 *  summary. Returns { sig, how } or null. */
function matchSpecOperation(spec, displayName, identifier, restProjectOperation) {
  const sigs = spec.signatures || [];
  if (restProjectOperation && restProjectOperation.resourcePath) {
    const method = String(restProjectOperation.httpMethod || "").toLowerCase();
    const resource = parseTemplate(restProjectOperation.resourcePath).key;
    const sameMethod = sigs.filter((s) => s.method === method);
    const full = (s) => parseTemplate(`${spec.basePath || ""}/${s.path}`).key;
    const exact = sameMethod.filter((s) => full(s) === resource || parseTemplate(s.path).key === resource);
    if (exact.length === 1) return { sig: exact[0], how: `${method.toUpperCase()} ${exact[0].path}` };
    const suffix = sameMethod.filter((s) => {
      const k = parseTemplate(s.path).key;
      return resource.endsWith(k) || k.endsWith(resource);
    });
    if (suffix.length === 1) return { sig: suffix[0], how: `${method.toUpperCase()} ${suffix[0].path}` };
  }
  for (const name of [displayName, identifier]) {
    const n = norm(name);
    if (!n) continue;
    const byId = sigs.filter((s) => norm(s.operationId) === n || norm(s.fnName) === n || norm(s.id) === n);
    if (byId.length === 1) return { sig: byId[0], how: `operation '${byId[0].operationId || byId[0].fnName}' by name` };
    const bySummary = sigs.filter((s) => norm(s.summary) === n);
    if (bySummary.length === 1) return { sig: bySummary[0], how: `operation '${bySummary[0].operationId || bySummary[0].fnName}' by summary` };
  }
  return null;
}

/** "repoid" abbreviates "repositoryid": same first letter, letters in order, same last letter. */
function isAbbreviation(short, long) {
  if (!short || !long || short.length >= long.length || short[0] !== long[0] || short[short.length - 1] !== long[long.length - 1]) return false;
  let i = 0;
  for (const ch of long) if (ch === short[i]) i++;
  return i === short.length;
}

const HEADER_LIKE = /^(cookie|authorization|x[-_].*|apikey|api[-_]?key|accept[-_]language)$/i;

/** Classic name of a top-level REST input: "parameter_RepoId" -> "RepoId". */
const classicParamName = (p) => String(p.identifier || "").replace(/^parameter_/i, "");

/**
 * Builds the script step for a Classic REST call through the generated module, or null when it
 * cannot be done safely (then the caller keeps the normal translation). `notes` collects why.
 */
function buildSpecRestCall(spec, operation, restProjectOperation, notes) {
  const label = operation.displayName || operation.identifier || "";
  const matched = matchSpecOperation(spec, operation.displayName, operation.identifier, restProjectOperation);
  if (!matched) {
    notes.push(`'${label}' has no matching operation in the ${spec.moduleName} spec, kept as a REST connector call`);
    return null;
  }
  const { sig, how } = matched;
  if (!sig.returnsJson && sig.method !== "delete") {
    notes.push(`'${label}' matches ${how} but its response is not JSON (file, text or headers only), kept as a REST connector call`);
    return null;
  }
  const outputChildren = operation.output && operation.output.children ? operation.output.children.map((c) => c.identifier) : [];
  if (outputChildren.length && !outputChildren.includes("OK")) {
    notes.push(`'${label}' reads response headers (${outputChildren.join(", ")}) that the module function does not return, kept as a REST connector call`);
    return null;
  }

  const inputs = (operation.methodCallInputs || []).map((p) => ({ raw: p, adapted: adaptMethodParameter(p), name: classicParamName(p) }));
  const simple = inputs.filter((i) => /^parameter_/i.test(i.raw.identifier || ""));
  const headerRecords = inputs.filter((i) => /^headers/i.test(i.raw.identifier || ""));
  const bodyCandidates = inputs.filter((i) => !simple.includes(i) && !headerRecords.includes(i));
  const used = new Set();
  const values = new Map(); // spec arg name -> FlowScript expression
  const take = (input) => {
    used.add(input);
    return renderInputValue(input.adapted);
  };
  const assigned = (i) => i.adapted.mode !== "Unassigned";

  // Placeholders of the .ncrcp resource map onto the spec's path params by position, query keys by name.
  if (restProjectOperation && restProjectOperation.resourcePath) {
    const tpl = parseTemplate(restProjectOperation.resourcePath);
    const specPathArgs = sig.args.filter((a) => a.in === "path");
    const specPlaceholders = parseTemplate(sig.path).placeholders;
    const offset = Math.max(0, tpl.placeholders.length - specPlaceholders.length);
    specPathArgs.forEach((a) => {
      const pos = specPlaceholders.findIndex((p) => p === a.name);
      const classicName = pos >= 0 ? tpl.placeholders[pos + offset] : null;
      const input = classicName && simple.find((i) => norm(i.name) === norm(classicName) && assigned(i));
      if (input) values.set(a.name, take(input));
    });
    for (const q of tpl.query) {
      const a = sig.args.find((x) => x.in === "query" && norm(x.name) === norm(q.key));
      if (!a || values.has(a.name)) continue;
      if (q.placeholder) {
        const input = simple.find((i) => norm(i.name) === norm(q.placeholder) && assigned(i));
        if (input) values.set(a.name, take(input));
      } else if (q.constant != null) values.set(a.name, JSON.stringify(q.constant));
    }
  }
  // Everything else by name, then by an abbreviated name (RepoId -> repositoryId) when only one fits.
  for (const a of sig.args.filter((x) => x.in !== "body" && !values.has(x.name))) {
    const input = simple.find((i) => !used.has(i) && assigned(i) && (norm(i.name) === norm(a.name) || norm(i.name) === norm(a.arg)));
    if (input) values.set(a.name, take(input));
  }
  for (const a of sig.args.filter((x) => x.in !== "body" && !values.has(x.name))) {
    const fits = simple.filter((i) => !used.has(i) && assigned(i) && isAbbreviation(norm(i.name), norm(a.name)));
    if (fits.length !== 1) continue;
    values.set(a.name, take(fits[0]));
    notes.push(`'${label}': Classic input '${fits[0].name}' passed as ${a.in} parameter '${a.name}' (similar name), check it`);
  }
  const bodyArg = sig.args.find((a) => a.in === "body");
  if (bodyArg) {
    const candidates = bodyCandidates.filter(assigned);
    if (candidates.length === 1) {
      const { template, warnings } = buildRestCallBodyTemplate(candidates[0].raw);
      used.add(candidates[0]);
      values.set(bodyArg.name, template);
      for (const w of warnings) notes.push(`'${label}': ${w}`);
    }
  }

  const missing = sig.args.filter((a) => !a.optional && !values.has(a.name));
  if (missing.length) {
    notes.push(`'${label}' matches ${how}, but no Classic input was found for ${missing.map((a) => `${a.in} '${a.name}'`).join(", ")}, kept as a REST connector call`);
    return null;
  }

  const extraHeaders = [];
  for (const i of simple.filter((x) => !used.has(x) && assigned(x))) {
    if (HEADER_LIKE.test(i.name)) extraHeaders.push(`{ Name: ${JSON.stringify(i.name.replace(/_/g, "-"))}, Value: ${take(i)} }`);
    else notes.push(`'${label}': Classic input '${i.name}' has no parameter in the spec operation ${how} and is not passed, check it`);
  }
  if (headerRecords.some((h) => h.adapted.children.some((c) => c.mode !== "Unassigned"))) {
    notes.push(`'${label}': the Classic call sets custom headers whose names are not in the export, add them to the module call's headers argument if needed`);
  }

  const lastProvided = sig.args.reduce((last, a, i) => (values.has(a.name) ? i : last), -1);
  const positional = sig.args.slice(0, lastProvided + 1).map((a) => values.has(a.name) ? values.get(a.name) : "null");
  if (extraHeaders.length) {
    // Fill the optional arguments in front of `headers` so it stays last.
    const rest = sig.args.slice(lastProvided + 1).map(() => "null");
    positional.push(...rest, `[${extraHeaders.join(", ")}]`);
  }
  const call = `${sig.fnName}(${positional.join(", ")})`;
  const script = [
    `open ${spec.moduleName};`,
    `// ${sig.method.toUpperCase()} ${sig.path} via module ${spec.moduleName} (generated from the API spec). Non-2xx responses raise an error.`,
    `return { OK: ${call}, HttpStatusCode: 200, ReasonPhrase: 'OK' };`
  ].join("\n");
  notes.push(`'${label}' now calls ${spec.moduleName}.${sig.fnName} (${how}); errors raise instead of returning a status code, check any branch on HttpStatusCode`);
  return { script, fnName: sig.fnName };
}

export { buildSpecRestCall, matchSpecOperation, parseTemplate };
