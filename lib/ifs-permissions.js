(function (global) {
  const req = (path, name) => (typeof require === "function" ? require(path) : global[name]);
  const IfsClient = req("./ifs-client.js", "IfsClient");

  // GrantProjections payload CONFIRMED by the Quick Report HAR captures (2026-09-08/09); keep the
  // trailing "^". Shared by Quick Reports and Custom LUs.
  const PS = "/main/ifsapplications/projection/v1/PermissionSetHandling.svc";
  const IFS_MANAGED_DELIVERY_TYPE = "IFSManaged";

  const endpoints = {
    listPermissionSets: () => `${PS}/PermissionSets?$select=Role,Description,FndRoleDeliveryType`,
    grantProjection: () => `${PS}/GrantProjections`,
    grantProjectionBody: (projectionName, role) => ({ Projections: `PROJECTION_NAME=${projectionName}^`, Role: role })
  };

  async function listPermissionSets(client) {
    const res = await IfsClient.step("Load permission sets", () => client.get(endpoints.listPermissionSets()));
    return (res.value || [])
      .filter((row) => row.FndRoleDeliveryType !== IFS_MANAGED_DELIVERY_TYPE)
      .map((row) => ({ id: row.Role, name: row.Description || row.Role }));
  }

  function grantProjection(client, projectionName, role) {
    return IfsClient.step(`Grant to permission set ${role}`, () =>
      client.post(endpoints.grantProjection(), endpoints.grantProjectionBody(projectionName, role)));
  }

  // Read side of the permission check. Entity and field names come from the generated
  // PermissionSetHandling module (read 2026-10-27); the entity SET names are looked up in $metadata
  // instead of assumed. Live behaviour still to be confirmed.
  const quote = (v) => String(v).replace(/'/g, "''");

  /** Entity type name -> entity set name, from the projection's $metadata. */
  async function entitySets(client) {
    const xml = await client.getText(`${PS}/$metadata`);
    const sets = {};
    for (const m of xml.matchAll(/<EntitySet\b[^>]*\bName="([^"]+)"[^>]*\bEntityType="([^"]+)"/g)) sets[m[2].split(".").pop()] = m[1];
    for (const m of xml.matchAll(/<EntitySet\b[^>]*\bEntityType="([^"]+)"[^>]*\bName="([^"]+)"/g)) sets[m[1].split(".").pop()] = m[2];
    return sets;
  }

  /** Every row of an OData query, following @odata.nextLink. */
  async function getAll(client, path) {
    const rows = [];
    let next = path;
    for (let pages = 0; next && pages < 200; pages++) {
      const res = await client.get(next);
      rows.push(...(res.value || []));
      const link = res["@odata.nextLink"];
      next = link ? (/^https?:/i.test(link) ? new URL(link).pathname + new URL(link).search : link) : null;
    }
    return rows;
  }

  function setOf(sets, entity) {
    if (!sets[entity]) throw new Error(`The IFS projection PermissionSetHandling has no ${entity} entity set.`);
    return sets[entity];
  }

  async function listUsers(client, sets) {
    const rows = await IfsClient.step("Load IFS users", () =>
      getAll(client, `${PS}/${setOf(sets, "User")}?$select=Identity,Description,Active&$filter=Active eq true&$orderby=Identity`));
    return rows.map((r) => ({ id: r.Identity, name: r.Description || r.Identity }));
  }

  /** Projections a user may use (effective, including those inherited through permission sets). */
  async function userProjections(client, sets, identity) {
    const rows = await IfsClient.step(`Load grants of user ${identity}`, () =>
      getAll(client, `${PS}/${setOf(sets, "UsersGrantedProjection")}?$filter=GrantedUser eq '${quote(identity)}'&$select=Projection,AccessLevel,PermSetGrantingProj,PermSetGrantedToUser`));
    return rows.map((r) => ({ projection: r.Projection, level: r.AccessLevel, via: r.PermSetGrantingProj || r.PermSetGrantedToUser || null }));
  }

  /** Projections granted by permission sets, directly or through the sets they contain. */
  async function permissionSetProjections(client, sets, roles) {
    const out = [];
    for (const role of roles) {
      const rows = await IfsClient.step(`Load grants of permission set ${role}`, () =>
        getAll(client, `${PS}/${setOf(sets, "AllGrantedProjections")}?$filter=Root eq '${quote(role)}'&$select=Projection,SourcePermissionSet,AccessLevel`));
      for (const r of rows) out.push({ projection: r.Projection, level: r.AccessLevel, via: r.SourcePermissionSet || role });
    }
    return out;
  }

  /** The customer permission sets granted to a user, directly or through other sets. */
  async function userPermissionSets(client, sets, identity) {
    const rows = await IfsClient.step(`Load permission sets of user ${identity}`, () =>
      getAll(client, `${PS}/${setOf(sets, "GrantedPermissionSetsQuery")}?$filter=Grantee eq '${quote(identity)}'&$select=GrantedRole,Description,FndRoleDeliveryType`));
    return rows.filter((r) => r.FndRoleDeliveryType !== IFS_MANAGED_DELIVERY_TYPE)
      .map((r) => ({ id: r.GrantedRole, name: r.Description || r.GrantedRole }));
  }

  /** The permission sets that grant a projection directly: [{ role, managed }] (managed = IFS-delivered,
   *  cannot be edited). The delivery type is filtered here, not in the query: an enum filter
   *  needs the enum's namespace syntax. */
  async function permissionSetsGranting(client, sets, projection) {
    const rows = await getAll(client, `${PS}/${setOf(sets, "ProjectionGrant")}?$filter=Projection eq '${quote(projection)}'&$select=Role,FndRoleDeliveryType`);
    const byRole = new Map();
    for (const r of rows) byRole.set(r.Role, { role: r.Role, managed: r.FndRoleDeliveryType === IFS_MANAGED_DELIVERY_TYPE });
    return [...byRole.values()];
  }

  // Write side of the permission check. GrantProjections is confirmed (Quick Reports); the
  // RevokeProjection action (body { Role, Projection }) and creating a UserGrant ({ Identity, Role })
  // come from the generated PermissionSetHandling module and are not yet confirmed live.
  function revokeProjection(client, projectionName, role) {
    return IfsClient.step(`Remove from permission set ${role}`, () =>
      client.post(`${PS}/RevokeProjection`, { Role: role, Projection: projectionName }));
  }

  function assignPermissionSet(client, sets, identity, role) {
    return IfsClient.step(`Give permission set ${role} to user ${identity}`, () =>
      client.post(`${PS}/${setOf(sets, "UserGrant")}`, { Identity: identity, Role: role }));
  }

  /** Runs planned changes one by one and stops at the first failure.
   *  change: { type: "grant" | "revoke" | "assign", projection, role, user }
   *  -> { results: [{ change, ok, error? }] } */
  async function applyChanges(client, sets, changes) {
    const results = [];
    for (const change of changes) {
      try {
        if (change.type === "grant") await grantProjection(client, change.projection, change.role);
        else if (change.type === "revoke") await revokeProjection(client, change.projection, change.role);
        else if (change.type === "assign") await assignPermissionSet(client, sets, change.user, change.role);
        else throw new Error(`Unknown change type ${change.type}`);
        results.push({ change, ok: true });
      } catch (e) {
        results.push({ change, ok: false, error: e.message });
        break;
      }
    }
    return { results };
  }

  const api = { revokeProjection, assignPermissionSet, applyChanges, listPermissionSets, grantProjection, endpoints, entitySets, userPermissionSets, listUsers, userProjections, permissionSetProjections, permissionSetsGranting };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.IfsPermissions = api;
})(typeof window !== "undefined" ? window : globalThis);
