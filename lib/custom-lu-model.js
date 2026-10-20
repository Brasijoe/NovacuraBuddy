(function (global) {
  // Pure rules for a Custom LU definition, shared by the editor page (live validation) and the
  // background (deploy). IFS stays the authority: ValidateLu / ValidateAttributeName still run.
  const TYPES = ["STRING", "NUMBER", "DATE", "DATETIME"];
  const TYPE_LABELS = { STRING: "String", NUMBER: "Number", DATE: "Date", DATETIME: "DateTime" };
  const DEFAULT_LENGTH = 100;
  const MAX_LENGTH = 4000;
  const MAX_LU_NAME_LENGTH = 30; // IFS limit on the entity ID

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
    if (name.length > MAX_LU_NAME_LENGTH) return `LU name: at most ${MAX_LU_NAME_LENGTH} characters (has ${name.length}).`;
    return "";
  }

  function attributeNameProblem(name) {
    if (!name) return "Attribute name can't be empty.";
    if (!/^[A-Z]/.test(name)) return "First letter should be an uppercase alpha character."; // IFS's own wording
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return "letters, digits and _ only.";
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

  const api = { TYPES, TYPE_LABELS, DEFAULT_LENGTH, MAX_LENGTH, MAX_LU_NAME_LENGTH, ifsDataType, toAttributeName, toProperCase, normalizeLu, validateLu, diffAttributes };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.CustomLuModel = api;
})(typeof window !== "undefined" ? window : globalThis);
