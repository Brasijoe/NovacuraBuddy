(function (global) {
  const req = (path, name) => (typeof require === "function" ? require(path) : global[name]);
  const IfsClient = req("./ifs-client.js", "IfsClient");
  const IfsPermissions = req("./ifs-permissions.js", "IfsPermissions");
  const CustomLuModel = req("./custom-lu-model.js", "CustomLuModel");

  // Captured 2026-10-20 from the IFS web client (two HARs, ifscloud.flowington.com) unless marked
  // UNCONFIRMED. Keep payload key order exactly as captured.
  const EC = "/main/ifsapplications/projection/v1/EntityConfigHandling.svc";
  const LU_TYPE = "CUSTOM_LU";
  const PAGE = 100;
  const CREATE_LU_SELECT = "Lu,LuType,Objgrants,Prompt,Module,UsedDb,PublishedDb,SynchronizedDb,EnabledRowkey,LogicalUnitType,CreateProjectionDb,PackgName,TimestampTzRef,SiteTimeZoneRef,Excluded,RowkeyInEntity,CountAttributes,LuTypeName,HasTranslatableText,HasUnusedData,HasUnusedTable,AddedToPackage,luname,keyref";

  const lit = (value) => encodeURIComponent(String(value).replace(/'/g, "''"));
  const luKey = (lu) => `CustomLusSet(Lu='${lit(lu)}',LuType=IfsApp.EntityConfigHandling.CustomObjectsType'${LU_TYPE}')`;
  const virtualKey = (objkey) => `CustomAttributesVirtuals(Objkey='${lit(objkey)}')`;

  const endpoints = {
    listCustomLus: (skip) => `${EC}/CustomLusSet?$select=Lu,LuType,Objgrants,luname,keyref&use-timezone-filter=false&$skip=${skip}&$top=${PAGE}`,
    getCustomLu: (lu) => `${EC}/${luKey(lu)}?$select=Lu,LuType,Prompt,PublishedDb,SynchronizedDb`,
    customLuAttributes: (lu) => `${EC}/${luKey(lu)}/CustomFieldAttributesArray?$select=AttributeName,DataType,DataLength,Prompt,Published`,
    validateLu: (lu) => `${EC}/ValidateLu(Lu='${lit(lu)}')`,
    createCustomLu: () => `${EC}/CustomLusSet?select-fields=${CREATE_LU_SELECT}`,
    createCustomLuBody: (lu) => ({ Lu: lu.name, Module: "CONFIG", Prompt: lu.prompt, UsedDb: false, SynchronizedDb: false, EnabledRowkey: false, CreateProjectionDb: true, PublishedDb: false }),
    validateAttributeName: (name) => `${EC}/ValidateAttributeName(AttributeName='${lit(name)}')`,
    createAttributeVirtual: () => `${EC}/CustomAttributesVirtuals`,
    createAttributeVirtualBody: (luName) => ({
      Swap: false, Insertable: true, Updatable: true, Queryable: true, EnabledOnReports: false, EnabledOnOutboundMsgs: false,
      Private: false, IsValidName: false, Multiline: false, ClickableHyperlink: false, TempRefTypeOne: false, TempRefTypeTwo: false,
      TempRefTypeThree: false, EnableOk: true, EditMode: false, HasVirtualUpdated: false, HasEnumUpdated: true, Lu: luName,
      LuType: LU_TYPE, DataType: "STRING", DefaultValueType: "NO_DEFAULT_VALUE", DataLength: "100", HasChanged: "FALSE", HasNewItem: "FALSE"
    }),
    cleanDisplayTextVirtual: () => `${EC}/CleanDisplayTextVirtual`,
    attributeVirtual: (objkey) => `${EC}/${virtualKey(objkey)}`,
    createCustomAttributes: (objkey) => `${EC}/${virtualKey(objkey)}/IfsApp.EntityConfigHandling.CustomAttributesVirtual_CreateCustomAttributes`,
    cleanupAttributeVirtual: (objkey) => `${EC}/${virtualKey(objkey)}/IfsApp.EntityConfigHandling.CustomAttributesVirtual_CleanupVirtualEntity`,
    batch: () => `${EC}/$batch`,
    approve: () => `${EC}/Approve`,
    publish: () => `${EC}/Publish`,
    luBody: (luName) => ({ Lu: luName, LuType: LU_TYPE })
  };

  const step = (name, fn) => IfsClient.step(name, fn, { preferIfsMessage: true });
  /** A step that tells `onStep` its name before it runs, so the UI can show live progress. */
  const reportingStep = (onStep) => (name, fn) => {
    if (onStep) onStep(name);
    return step(name, fn);
  };
  const fail = (name, message) => Object.assign(new Error(`${name} failed — ${message}`), { step: name });

  /** The virtual PATCHes for one attribute, in the web client's order. */
  function attributePatches(attr) {
    const patches = [{ CustomAttributeType: "PERSISTENT_FIELD" }, { TextFormat: "UNFORMATTED" }];
    if (attr.type === "STRING") patches.push({ DataLength: String(attr.length) });
    // UNCONFIRMED: Number PATCH shape mirrors the captured DATE one; IFS set NumberFormat itself.
    if (attr.type === "NUMBER") patches.push({ DataType: "NUMBER", Indexed: false });
    if (attr.type === "DATE") patches.push({ DataType: "DATE", Indexed: false }, { DateFormat: "DATE" });
    // UNCONFIRMED: DateFormat "DATETIME" is a guess the user approved (2026-10-20); fix after a live run.
    if (attr.type === "DATETIME") patches.push({ DataType: "DATE", Indexed: false }, { DateFormat: "DATETIME" });
    patches.push({ AttributeName: attr.name, Prompt: attr.prompt });
    return patches;
  }

  /** Builds the ApproveAttribute $batch exactly as the web client sends it (one changeset). */
  function approveAttributesBatch(luName, attributeNames, uuid) {
    const batch = uuid();
    const changeset = uuid();
    const parts = attributeNames.map((name, i) => [
      `--${changeset}`, "Content-Type: application/http", "Content-Transfer-Encoding:binary", `Content-Id: ${i + 1}`, "",
      "POST ApproveAttribute HTTP/1.1", "Accept:application/json;odata.metadata=full;IEEE754Compatible=true", "Content-Type: application/json;IEEE754Compatible=true", "",
      JSON.stringify({ Lu: luName, LuType: LU_TYPE, AttributeName: name }), ""
    ].join("\r\n"));
    const text = [`--${batch}`, `Content-Type: multipart/mixed;boundary=${changeset}`, "", ...parts, `--${changeset}--`, `--${batch}--`, ""].join("\r\n");
    return { boundary: batch, text };
  }

  /** A $batch answers 200 even when a part failed; the part's own status line decides. */
  function checkBatchResponse(text) {
    const statuses = [...String(text).matchAll(/HTTP\/1\.1 (\d{3})/g)];
    if (!statuses.length) throw new Error("IFS $batch response had no part status.");
    const bad = statuses.find((m) => Number(m[1]) >= 300);
    if (!bad) return;
    const json = String(text).slice(bad.index).match(/\{[\s\S]*\}/);
    throw Object.assign(new Error(`IFS $batch part failed (${bad[1]})`), json ? { body: json[0] } : {});
  }

  // UNCONFIRMED: a missing LU answers 404 (standard OData; not captured).
  async function findCustomLu(client, name) {
    try {
      return await client.getOData(endpoints.getCustomLu(name));
    } catch (err) {
      if (err.status === 404) return null;
      throw Object.assign(err, { message: `Check for an existing LU failed — ${IfsClient.ifsErrorMessage(err) || err.message}`, step: "Check for an existing LU" });
    }
  }

  async function readAttributes(client, name, run = step) {
    const res = await run("Read existing attributes", () => client.getOData(endpoints.customLuAttributes(name)));
    return (res && res.value) || [];
  }

  async function createAttribute(client, luName, attr, run) {
    const label = `Attribute ${attr.name}`;
    await run(`${label}: validate name`, async () => {
      const answer = await client.getOData(endpoints.validateAttributeName(attr.name));
      if (answer && answer.value) throw new Error(answer.value); // 200 = invalid, the value says why; 204 = valid
    });
    const virtual = await run(`${label}: create draft`, () => client.postOData(endpoints.createAttributeVirtual(), endpoints.createAttributeVirtualBody(luName)));
    if (!virtual || !virtual.Objkey || !virtual["@odata.etag"]) throw fail(`${label}: create draft`, "IFS response did not include an Objkey and @odata.etag.");
    const etag = virtual["@odata.etag"];
    let failure = null;
    try {
      await run(`${label}: prepare draft`, () => client.postOData(endpoints.cleanDisplayTextVirtual(), {}));
      for (const body of attributePatches(attr)) {
        await run(`${label}: set ${Object.keys(body).join(", ")}`, () => client.patchOData(endpoints.attributeVirtual(virtual.Objkey), body, etag));
      }
      await run(`${label}: save`, () => client.postOData(endpoints.createCustomAttributes(virtual.Objkey), {}, etag));
    } catch (err) {
      failure = err;
      throw err;
    } finally {
      try {
        await run(`${label}: clean up draft`, () => client.postOData(endpoints.cleanupAttributeVirtual(virtual.Objkey), {}, etag));
      } catch (cleanupErr) {
        if (!failure) throw cleanupErr; // the original failure is what the user needs to see
      }
    }
  }

  async function deployCustomLu(client, { lu, permissionSetIds, uuid, onStep }) {
    const problems = CustomLuModel.validateLu(lu);
    if (problems.length) throw new Error(problems.map((p) => p.message).join(" "));
    const run = reportingStep(onStep);

    if (onStep) onStep("Check for an existing LU");
    const existing = await findCustomLu(client, lu.name);
    if (!existing) {
      await run("Validate LU name", async () => {
        const answer = await client.getOData(endpoints.validateLu(lu.name));
        if (answer && answer.value) throw new Error(answer.value);
      });
      await run("Create LU", () => client.postOData(endpoints.createCustomLu(), endpoints.createCustomLuBody(lu)));
    }

    // UNCONFIRMED: PublishedDb/SynchronizedDb as the LU's "needs approve+publish" state (HAR 2026-10-20: an LU with an unpublished added attribute showed PublishedDb:true, SynchronizedDb:false).
    const luOutOfSync = !!existing && (existing.PublishedDb !== true || existing.SynchronizedDb !== true);

    const rows = existing ? await readAttributes(client, lu.name, run) : [];
    const diff = CustomLuModel.diffAttributes(lu.attributes, rows);
    for (const attr of diff.toCreate) await createAttribute(client, lu.name, attr, run);

    const approved = [...diff.toCreate.map((a) => a.name), ...diff.unapproved.filter((n) => !diff.toCreate.some((a) => a.name === n))];
    if (approved.length) {
      await run("Approve attributes", async () => {
        const { boundary, text } = approveAttributesBatch(lu.name, approved, uuid);
        checkBatchResponse(await client.postBatch(endpoints.batch(), boundary, text));
      });
    }
    const publish = approved.length > 0 || luOutOfSync;
    if (publish) {
      await run("Approve LU", () => client.postOData(endpoints.approve(), endpoints.luBody(lu.name)));
      await run("Publish LU", () => client.postOData(endpoints.publish(), endpoints.luBody(lu.name)));
    }

    // The LU is deployed by now, so a failed grant is reported next to the success instead of
    // turning the whole LU red.
    const granted = [];
    const grantErrors = [];
    for (const role of permissionSetIds || []) {
      if (onStep) onStep(`Grant to permission set ${role}`);
      try {
        await IfsPermissions.grantProjection(client, CustomLuModel.projectionName(lu.name), role);
        granted.push(role);
      } catch (err) {
        grantErrors.push({ role, message: err.message });
      }
    }

    return { name: lu.name, createdLu: !existing, created: diff.toCreate.map((a) => a.name), skipped: diff.skipped, mismatches: diff.mismatches, approved, published: publish, granted, grantErrors };
  }

  /** `onProgress({ name, index, total, step })` fires before every IFS step of every LU. */
  async function deployAll(client, lus, { onProgress, ...options } = {}) {
    const results = [];
    for (const [index, lu] of lus.entries()) {
      const onStep = onProgress && ((stepName) => onProgress({ name: lu.name, index, total: lus.length, step: stepName }));
      try {
        results.push({ name: lu.name, ok: true, outcome: await deployCustomLu(client, { lu, ...options, onStep }) });
      } catch (err) {
        results.push({ name: lu.name, ok: false, error: err.message });
      }
    }
    return results;
  }

  async function listCustomLus(client) {
    const names = [];
    for (let skip = 0; ; skip += PAGE) {
      const res = await step("Load Custom LUs", () => client.getOData(endpoints.listCustomLus(skip)));
      const rows = (res && res.value) || [];
      for (const row of rows) if (row.LuType === LU_TYPE) names.push({ name: row.Lu });
      if (rows.length < PAGE) break;
    }
    return names.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function getCustomLuDefinition(client, name) {
    const lu = await findCustomLu(client, name);
    if (!lu) throw new Error(`Custom LU "${name}" was not found on this instance.`);
    const rows = await readAttributes(client, name);
    return {
      name,
      prompt: lu.Prompt || name,
      attributes: rows.map((r) => {
        const attr = { name: r.AttributeName, prompt: r.Prompt || "", type: r.DataType };
        if (r.DataType === "STRING" && r.DataLength != null) attr.length = Number(r.DataLength);
        attr.published = !!r.Published;
        return attr;
      })
    };
  }

  const api = { deployCustomLu, deployAll, listCustomLus, getCustomLuDefinition, approveAttributesBatch, checkBatchResponse, attributePatches, endpoints };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.CustomLuDeploy = api;
})(typeof window !== "undefined" ? window : globalThis);
