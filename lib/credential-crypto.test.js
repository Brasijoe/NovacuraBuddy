const test = require("node:test");
const assert = require("node:assert/strict");
const {
  generateSalt, deriveKey, exportKeyRaw, importKeyRaw,
  encryptText, decryptText, makeVerifier, checkVerifier
} = require("./credential-crypto.js");

test("generateSalt produces a base64 string decoding to 16 bytes", () => {
  const salt = generateSalt();
  assert.equal(Buffer.from(salt, "base64").length, 16);
});

test("deriveKey is deterministic for the same password+salt", async () => {
  const salt = generateSalt();
  const key1 = await deriveKey("correct horse battery staple", salt);
  const key2 = await deriveKey("correct horse battery staple", salt);
  const enc = await encryptText(key1, "hello world");
  assert.equal(await decryptText(key2, enc), "hello world");
});

test("deriveKey with a different password produces an incompatible key", async () => {
  const salt = generateSalt();
  const key1 = await deriveKey("password-one", salt);
  const key2 = await deriveKey("password-two", salt);
  const enc = await encryptText(key1, "secret");
  await assert.rejects(() => decryptText(key2, enc));
});

test("encryptText/decryptText round-trips unicode", async () => {
  const salt = generateSalt();
  const key = await deriveKey("pw", salt);
  const enc = await encryptText(key, "münchen — client_secret_123!");
  assert.equal(await decryptText(key, enc), "münchen — client_secret_123!");
});

test("exportKeyRaw/importKeyRaw round-trips a usable key", async () => {
  const salt = generateSalt();
  const key = await deriveKey("pw", salt);
  const reimported = await importKeyRaw(await exportKeyRaw(key));
  const enc = await encryptText(key, "roundtrip test");
  assert.equal(await decryptText(reimported, enc), "roundtrip test");
});

test("makeVerifier/checkVerifier accepts the correct key and rejects a wrong one", async () => {
  const salt = generateSalt();
  const rightKey = await deriveKey("right", salt);
  const wrongKey = await deriveKey("wrong", salt);
  const verifier = await makeVerifier(rightKey);
  assert.equal(await checkVerifier(rightKey, verifier), true);
  assert.equal(await checkVerifier(wrongKey, verifier), false);
});
