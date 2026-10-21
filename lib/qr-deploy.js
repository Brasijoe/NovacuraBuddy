(function (global) {
  const req = (path, name) => (typeof require === "function" ? require(path) : global[name]);
  const IfsClient = req("./ifs-client.js", "IfsClient");
  const IfsPermissions = req("./ifs-permissions.js", "IfsPermissions");
  const { step } = IfsClient;

  // Ported from the Electron Quick Report Deployer (ifsEndpoints.ts / quickReportDeploy.ts). The
  // create and update sequences and the GrantProjections payload were CONFIRMED by HAR captures
  // (2026-09-08/09); see ifsEndpoints.ts in that repo for the full capture notes. Do not "tidy"
  // payloads here (e.g. the trailing "^") without a new capture.
  const QR = "/main/ifsapplications/projection/v1/QuickReportHandling.svc";

  const escapeODataString = (value) => String(value).replace(/'/g, "''");

  const endpoints = {
    findQuickReportByName: (name) =>
      `${QR}/QuickReportSet?$select=QuickReportId,Description&$filter=` +
      encodeURIComponent(`Description eq '${escapeODataString(name)}'`),
    listPermissionSets: () => IfsPermissions.endpoints.listPermissionSets(),
    grantProjection: () => IfsPermissions.endpoints.grantProjection(),
    grantProjectionBody: (quickReportId, role) => IfsPermissions.endpoints.grantProjectionBody(quickReportProjectionName(quickReportId), role),
    createTempLob: () => `${QR}/FndTempLobs`,
    createTempLobBody: () => ({ CreatedByModule: "QuickReportHandling" }),
    tempLobClobData: (lobId) => `${QR}/FndTempLobs(LobId='${lobId}')/ClobData`,
    checkSqlExpression: () => `${QR}/CheckSqlExpressionAction`,
    checkSqlExpressionBody: (lobId) => ({ SqlStatementTempLobId: lobId }),
    createQuickReportVirtual: () => `${QR}/QuickReportVirtualSet`,
    createQuickReportVirtualBody: (name, sql) => ({ Description: name, QrType: "SQLStatement", SqlExpression: sql }),
    saveNewAction: () => `${QR}/SaveNewAction`,
    saveNewActionBody: (objkey) => ({ Objkey: objkey }),
    cleanupVirtualEntity: (objkey) =>
      `${QR}/QuickReportVirtualSet(Objkey='${objkey}')/IfsApp.QuickReportHandling.QuickReportVirtual_CleanupVirtualEntity`,
    getQuickReport: (id) => `${QR}/QuickReportSet(QuickReportId=${id})`,
    updateQuickReport: (id) =>
      `${QR}/QuickReportSet(QuickReportId=${id})` +
      "?select-fields=Description,QuickReportId,QrType,FileName,CategoryId,DomainId,ProjectionName,InstanceName,SqlExpression,Objgrants,Query,Comments,QrTypeDb,ClientName,luname,keyref",
    updateQuickReportBody: (name, sql) => ({ Description: name, SqlExpression: sql })
  };

  /** Some IFS responses serialize the numeric QuickReportId as "516435.0". */
  const normalizeQuickReportId = (raw) => String(raw).replace(/\.0+$/, "");
  /** The IFS projection a deployed Quick Report gets — granted on deploy, and the one a Flow
   *  module is generated from. */
  function quickReportProjectionName(quickReportId) {
    return `QuickReport${normalizeQuickReportId(quickReportId)}`;
  }

  async function uploadAndValidateSql(client, sql) {
    const lob = await step("Upload SQL", async () => {
      const created = await client.post(endpoints.createTempLob(), endpoints.createTempLobBody());
      if (!created || !created.LobId) throw new Error("IFS FndTempLobs response did not include a LobId.");
      if (!created["@odata.etag"]) throw new Error("IFS FndTempLobs response did not include an @odata.etag.");
      await client.patchText(endpoints.tempLobClobData(created.LobId), sql, created["@odata.etag"]);
      return created;
    });
    await step("Validate SQL", () => client.post(endpoints.checkSqlExpression(), endpoints.checkSqlExpressionBody(lob.LobId)));
  }

  async function createOnIfs(client, report) {
    await uploadAndValidateSql(client, report.content);
    const virtual = await step("Create report draft", () =>
      client.post(endpoints.createQuickReportVirtual(), endpoints.createQuickReportVirtualBody(report.name, report.content)));
    if (!virtual || !virtual.Objkey) throw Object.assign(new Error("Create report draft failed — IFS response did not include an Objkey."), { step: "Create report draft" });

    let failure = null;
    try {
      await uploadAndValidateSql(client, report.content);
      const saved = await step("Save new report", () => client.post(endpoints.saveNewAction(), endpoints.saveNewActionBody(virtual.Objkey)));
      if (!saved || !saved.value) throw Object.assign(new Error("Save new report failed — IFS response did not include a QuickReportId."), { step: "Save new report" });
      return normalizeQuickReportId(saved.value);
    } catch (err) {
      failure = err;
      throw err;
    } finally {
      try {
        await step("Clean up report draft", () => client.post(endpoints.cleanupVirtualEntity(virtual.Objkey), {}));
      } catch (cleanupErr) {
        if (!failure) throw cleanupErr; // the original failure is what the user needs to see
      }
    }
  }

  async function updateOnIfs(client, quickReportId, report) {
    await uploadAndValidateSql(client, report.content);
    const current = await step("Read current report", () => client.get(endpoints.getQuickReport(quickReportId)));
    if (!current || !current["@odata.etag"]) throw Object.assign(new Error("Read current report failed — IFS response did not include an @odata.etag."), { step: "Read current report" });
    const updated = await step("Update report", () =>
      client.patchJson(endpoints.updateQuickReport(quickReportId), endpoints.updateQuickReportBody(report.name, report.content), current["@odata.etag"]));
    return normalizeQuickReportId((updated && updated.QuickReportId) || quickReportId);
  }

  async function findExistingByName(client, name) {
    const result = await step("Check for an existing report", () => client.get(endpoints.findQuickReportByName(name)));
    const match = result && result.value && result.value[0];
    return match ? { quickReportId: normalizeQuickReportId(match.QuickReportId), description: match.Description } : null;
  }

  async function deployQuickReport(client, { report, priorQuickReportId, forceQuickReportId, permissionSetIds }) {
    let quickReportId;
    const targetId = priorQuickReportId || forceQuickReportId;
    if (targetId) {
      quickReportId = await updateOnIfs(client, targetId, report);
    } else {
      const existing = await findExistingByName(client, report.name);
      if (existing) {
        return { status: "needsConfirmation", existingQuickReportId: existing.quickReportId, existingDescription: existing.description };
      }
      quickReportId = await createOnIfs(client, report);
    }
    for (const role of permissionSetIds) {
      await IfsPermissions.grantProjection(client, quickReportProjectionName(quickReportId), role);
    }
    return { status: "deployed", quickReportId };
  }

  const api = {
    createIfsClient: IfsClient.createIfsClient,
    deployQuickReport,
    listPermissionSets: IfsPermissions.listPermissionSets,
    normalizeQuickReportId,
    quickReportProjectionName,
    endpoints
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.QrDeploy = api;
})(typeof window !== "undefined" ? window : globalThis);
