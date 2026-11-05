const test = require("node:test");
const assert = require("node:assert/strict");
const SettingsBackup = require("./settings-backup.js");

test("a backup keeps only known settings and leaves secrets as stored", () => {
  const stored = { ifsInstances: { "https://a": { encryptedSecret: "xyz" } }, credentialSalt: "s", currentCalls: [1, 2], sessions: [3] };
  const backup = SettingsBackup.buildBackup(stored, { version: "0.4.2", now: new Date("2026-10-27T00:00:00Z") });
  assert.deepEqual(Object.keys(backup.data).sort(), ["credentialSalt", "ifsInstances"]);
  assert.equal(backup.data.ifsInstances["https://a"].encryptedSecret, "xyz");
  assert.equal(backup.exportedAt, "2026-10-27T00:00:00.000Z");
});

test("a backup round-trips through parseBackup", () => {
  const stored = { ifsInstances: { "https://a": {} }, githubSettings: { encryptedToken: "t" } };
  const data = SettingsBackup.parseBackup(JSON.stringify(SettingsBackup.buildBackup(stored)));
  assert.deepEqual(data, stored);
  assert.deepEqual(SettingsBackup.summarize(data), { instances: 1, github: true });
});

test("parseBackup rejects other files", () => {
  assert.throws(() => SettingsBackup.parseBackup("nope"), /valid JSON/);
  assert.throws(() => SettingsBackup.parseBackup("{}"), /isn't a Novacura Buddy/);
  assert.throws(() => SettingsBackup.parseBackup(JSON.stringify({ format: SettingsBackup.FORMAT, backupVersion: 1, data: {} })), /no settings/);
  assert.throws(() => SettingsBackup.parseBackup(JSON.stringify({ format: SettingsBackup.FORMAT, backupVersion: 9, data: { ifsInstances: {} } })), /newer/);
});
