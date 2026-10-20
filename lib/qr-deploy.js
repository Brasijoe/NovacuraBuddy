(function (global) {
  // Ported from the Electron Quick Report Deployer (ifsEndpoints.ts / quickReportDeploy.ts). The
  // create and update sequences and the GrantProjections payload were CONFIRMED by HAR captures
  // (2026-09-08/09); see ifsEndpoints.ts in that repo for the full capture notes. Do not "tidy"
  // payloads here (e.g. the trailing "^") without a new capture.
  const QR = "/main/ifsapplications/projection/v1/QuickReportHandling.svc";
  const PS = "/main/ifsapplications/projection/v1/PermissionSetHandling.svc";
  const IFS_MANAGED_DELIVERY_TYPE = "IFSManaged";

  const escapeODataString = (value) => String(value).replace(/'/g, "''");

  const endpoints = {
    findQuickReportByName: (name) =>
      `${QR}/QuickReportSet?$select=QuickReportId,Description&$filter=` +
      encodeURIComponent(`Description eq '${escapeODataString(name)}'`),
    listPermissionSets: () => `${PS}/PermissionSets?$select=Role,Description,FndRoleDeliveryType`,
    grantProjection: () => `${PS}/GrantProjections`,
    grantProjectionBody: (quickReportId, role) => ({ Projections: `PROJECTION_NAME=${quickReportProjectionName(quickReportId)}^`, Role: role }),
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

  function createIfsClient({ baseUrl, getToken, clearToken, fetchImpl }) {
    const doFetch = fetchImpl || ((...args) => fetch(...args));

    async function request(path, init, retried) {
      const token = await getToken();
      const res = await doFetch(baseUrl + path, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
      // A cached token can expire mid-session; one fresh token, never a loop.
      if (res.status === 401 && !retried) {
        clearToken();
        return request(path, init, true);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`IFS request failed (${path.split("?")[0]}, ${res.status})${text ? ": " + text : ""}`);
      }
      return res;
    }
    const bodyOf = async (res) => (res.status === 204 ? undefined : res.json());

    return {
      get: async (path) => (await request(path, { method: "GET" })).json(),
      post: async (path, body) =>
        bodyOf(await request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })),
      patchText: async (path, text, etag) => {
        await request(path, { method: "PATCH", headers: { "Content-Type": "application/octet-stream", "If-Match": etag }, body: text });
      },
      patchJson: async (path, body, etag) =>
        bodyOf(await request(path, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json;IEEE754Compatible=true",
            Accept: "application/json;odata.metadata=full;IEEE754Compatible=true",
            "If-Match": etag
          },
          body: JSON.stringify(body)
        }))
    };
  }

  /** Runs one named deploy step; a failure is re-labelled so the user sees which step broke. */
  async function step(name, fn) {
    try {
      return await fn();
    } catch (err) {
      if (!err.step) {
        err.step = name;
        err.message = `${name} failed — ${err.message}`;
      }
      throw err;
    }
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
      await step(`Grant to permission set ${role}`, () =>
        client.post(endpoints.grantProjection(), endpoints.grantProjectionBody(quickReportId, role)));
    }
    return { status: "deployed", quickReportId };
  }

  async function listPermissionSets(client) {
    const res = await step("Load permission sets", () => client.get(endpoints.listPermissionSets()));
    return (res.value || [])
      .filter((row) => row.FndRoleDeliveryType !== IFS_MANAGED_DELIVERY_TYPE)
      .map((row) => ({ id: row.Role, name: row.Description || row.Role }));
  }

  const api = { createIfsClient, deployQuickReport, listPermissionSets, normalizeQuickReportId, quickReportProjectionName, endpoints };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.QrDeploy = api;
})(typeof window !== "undefined" ? window : globalThis);
