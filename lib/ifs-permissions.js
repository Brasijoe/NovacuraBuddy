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

  const api = { listPermissionSets, grantProjection, endpoints };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") global.IfsPermissions = api;
})(typeof window !== "undefined" ? window : globalThis);
