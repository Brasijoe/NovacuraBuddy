const ASSET_COLOR = "#4031F8";
function normalizeToLF(text) {
  return text.replace(/\r\n/g, "\n");
}
async function postDesignerDataWithHardening(rest, orgId, itemId, body) {
  const path = `/admin/application/api/v2/organisations/${orgId}/items/${itemId}/designer`;
  let res;
  try {
    res = await rest.post(path, body);
  } catch (networkErr) {
    try {
      const verifyRes = await rest.get(path);
      if (verifyRes.ok) {
        const verified = await parseJsonResponse(verifyRes, "Could not verify designer data after a network error");
        if (verified.eTag) {
          return {
            ok: true,
            status: 200,
            headers: { get: (name) => name.toLowerCase() === "etag" ? `"${verified.eTag}"` : null },
            text: async () => ""
          };
        }
      }
    } catch {
    }
    throw networkErr;
  }
  if (res.status === 507) {
    res = await rest.post(path, body);
  }
  return res;
}
async function throwWithResponseBody(res, message) {
  const text = await res.text().catch(() => "");
  throw new Error(`${message} (${res.status})${text ? ": " + text : ""}`);
}
async function parseJsonResponse(res, context) {
  const text = await res.text();
  if (!text.trim()) {
    const headers = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });
    throw new Error(
      `${context}: Flow Connect responded ${res.status} ${res.statusText} with an EMPTY body \u2014 cannot read its response. Response headers: ${JSON.stringify(headers)}`
    );
  }
  return JSON.parse(text);
}
async function createAsset(rest, target) {
  const path = target.kind === "component" ? `/admin/application/api/v2/organisations/${target.orgId}/packages/${target.packageId}/assets` : `/admin/application/api/v2/organisations/${target.orgId}/packages/${target.packageId}/products`;
  const body = target.kind === "component" ? { name: target.name, description: target.description || "", color: ASSET_COLOR, tagIds: [], type: "component" } : { name: target.name, description: target.description || "", tagIds: [], icon: "default", color: ASSET_COLOR, type: "application", showInClients: true };
  const res = await rest.post(path, body);
  if (!res.ok) return throwWithResponseBody(res, `Could not create ${target.kind}`);
  return parseJsonResponse(res, `Could not create ${target.kind}`);
}
async function saveDesignerData(rest, orgId, itemId, dataArray, assetRefs, resultTypeExpression, startParametersExpression, isInbox) {
  const body = {
    assets: (assetRefs || []).map((r) => ({
      assetId: r.assetId,
      assetVersion: r.assetVersion,
      offeredParameterType: r.offeredParameterType ?? "{}"
    })),
    // Real gap fixed (spec §5/§6 Phase 4, C13/G30): this used to ALWAYS hardcode the generic "{}"
    // placeholder regardless of the flow's own real start parameters -- see
    // classicEmitter.ts's EmitConnectStepsResult.startParametersExpression doc comment for the
    // real value's own source and this fix's full citation.
    parameterTypeExpression: startParametersExpression && normalizeToLF(startParametersExpression) || "{}",
    resultTypeExpression: resultTypeExpression || "{}",
    errors: 0,
    isInbox: !!isInbox,
    hasSuitcase: false,
    architecture: "sequential",
    data: dataArray,
    // Real bug found live (2026-09-12): every push failed with a 400 ("The updates field is
    // required") -- masked at first by the moduleId/connector 400s that were ALSO present in the
    // same response and got fixed first. No real reference for this field exists anywhere in the
    // ported IFS Buddy source (it never sent one) -- this looks like a newer Flow Connect API
    // requirement. Best-effort empty array: satisfies "field is required" without asserting a
    // false diff against anything; if the real semantics turn out to need actual entries, the
    // next real error (or a step simply not landing) will say so plainly. Verify live.
    updates: []
  };
  const res = await postDesignerDataWithHardening(rest, orgId, itemId, body);
  if (!res.ok) return throwWithResponseBody(res, "Could not save designer data");
  const headerETag = res.headers?.get?.("etag");
  if (headerETag) return { eTag: headerETag.replace(/^"|"$/g, "") };
  return parseJsonResponse(res, "Could not save designer data");
}
async function createAndSaveAsset(rest, target, dataArray, assetRefs, resultTypeExpression, startParametersExpression, isInbox) {
  const asset = await createAsset(rest, target);
  const saved = await saveDesignerData(rest, target.orgId, asset.id, dataArray, assetRefs, resultTypeExpression, startParametersExpression, isInbox);
  return { itemId: asset.id, eTag: saved.eTag };
}
async function fetchExistingIds(rest, orgId, itemId) {
  try {
    const res = await rest.get(`/admin/application/api/v2/organisations/${orgId}/items/${itemId}/designer`);
    if (!res.ok) return /* @__PURE__ */ new Set();
    const body = await parseJsonResponse(res, "Could not load designer data for update diff");
    const ids = /* @__PURE__ */ new Set();
    for (const entry of body.data || []) {
      if ((entry.type === "step-created" || entry.type === "arrow-created") && entry.id) ids.add(entry.id);
      if (entry.type === "phrase-added" && entry.key) ids.add(phraseExistingId(entry.key));
    }
    return ids;
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
function phraseExistingId(key) {
  return `phrase:${key}`;
}
function buildUpdateDiff(freshData, existingIds) {
  const result = [];
  for (const entry of freshData) {
    if (entry.type === "phrase-added" && existingIds.has(phraseExistingId(entry.key))) continue;
    if (entry.type === "step-created" && existingIds.has(entry.id)) {
      result.push({ type: "configuration-changed", stepId: entry.id, configuration: entry.configuration });
      continue;
    }
    if (entry.type === "arrow-created" && existingIds.has(entry.id)) continue;
    result.push(entry);
  }
  return result;
}
function subworkflowUpdateWarnings(freshData) {
  const subworkflowIds = /* @__PURE__ */ new Set();
  for (const entry of freshData) {
    if (entry.type === "subworkflow-created" || entry.type === "subworkflow-changed") {
      subworkflowIds.add(entry.id);
    }
  }
  if (subworkflowIds.size === 0) return [];
  return [
    `Update-in-place does not yet diff subworkflow content: ${subworkflowIds.size} subworkflow(s) (${[...subworkflowIds].join(", ")}) are re-sent in full, so their inner steps/arrows may be duplicated on the target. Push this flow as a NEW flow instead, or verify the updated subworkflow's contents manually in Flow Connect Designer afterwards.`
  ];
}
async function commitPushedAsset(rest, orgId, itemId, message) {
  const res = await rest.get(`/admin/application/api/v2/organisations/${orgId}/items/${itemId}/designer`);
  if (!res.ok) return throwWithResponseBody(res, "Could not load designer data for commit");
  const body = await parseJsonResponse(res, "Could not load designer data for commit");
  if (!body.eTag) throw new Error("Could not commit asset \u2014 no eTag field in the designer response");
  const commitRes = await rest.post(`/admin/application/api/v2/organisations/${orgId}/items/${itemId}/commit`, {
    message: message || "Auto created by Flow designer",
    eTag: body.eTag
  });
  if (!commitRes.ok) return throwWithResponseBody(commitRes, "Could not commit asset");
}
async function validateAndPush(deps, rest, target, dataArray, assetRefs, _userDataDir, feature, resultTypeExpression, startParametersExpression, isInbox) {
  const validation = await deps.validateFlowImpl(dataArray);
  if (!validation.clean) {
    deps.logValidationFailureImpl({ feature, name: target.name, data: dataArray, errors: validation.errors });
  }
  const pushed = await createAndSaveAsset(rest, target, dataArray, assetRefs, resultTypeExpression, startParametersExpression, isInbox);
  await commitPushedAsset(rest, target.orgId, pushed.itemId);
  return { validation, pushed, warnings: [] };
}
async function validateAndUpdatePush(deps, rest, orgId, itemId, dataArray, assetRefs, feature, resultTypeExpression, startParametersExpression, isInbox) {
  const validation = await deps.validateFlowImpl(dataArray);
  if (!validation.clean) {
    deps.logValidationFailureImpl({ feature, name: `(update ${itemId})`, data: dataArray, errors: validation.errors });
  }
  const existingIds = await fetchExistingIds(rest, orgId, itemId);
  const diffedData = buildUpdateDiff(dataArray, existingIds);
  const warnings = subworkflowUpdateWarnings(dataArray);
  const saved = await saveDesignerData(rest, orgId, itemId, diffedData, assetRefs, resultTypeExpression, startParametersExpression, isInbox);
  await commitPushedAsset(rest, orgId, itemId);
  return { validation, pushed: { itemId, eTag: saved.eTag }, warnings };
}
export {
  createAsset,
  buildUpdateDiff,
  commitPushedAsset,
  createAndSaveAsset,
  phraseExistingId,
  saveDesignerData,
  subworkflowUpdateWarnings,
  validateAndPush,
  validateAndUpdatePush
};
