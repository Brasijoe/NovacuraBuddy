(function (global) {
  const PBKDF2_ITERATIONS = 250000;
  const SALT_BYTES = 16;
  const IV_BYTES = 12;
  const VERIFY_PLAINTEXT = "credential-store-verify";

  function toBase64(bytes) {
    let bin = "";
    const arr = new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    return btoa(bin);
  }

  function fromBase64(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  function generateSalt() {
    const salt = new Uint8Array(SALT_BYTES);
    crypto.getRandomValues(salt);
    return toBase64(salt);
  }

  async function deriveKey(password, saltB64) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: fromBase64(saltB64), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
      baseKey,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
  }

  async function exportKeyRaw(key) {
    const raw = await crypto.subtle.exportKey("raw", key);
    return toBase64(raw);
  }

  async function importKeyRaw(base64) {
    const raw = fromBase64(base64);
    return crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);
  }

  async function encryptText(key, plaintext) {
    const iv = new Uint8Array(IV_BYTES);
    crypto.getRandomValues(iv);
    const enc = new TextEncoder();
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
    return { iv: toBase64(iv), ciphertext: toBase64(ciphertext) };
  }

  async function decryptText(key, encrypted) {
    const iv = fromBase64(encrypted.iv);
    const ciphertext = fromBase64(encrypted.ciphertext);
    const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(plainBuf);
  }

  async function makeVerifier(key) {
    return encryptText(key, VERIFY_PLAINTEXT);
  }

  async function checkVerifier(key, verifier) {
    try {
      const text = await decryptText(key, verifier);
      return text === VERIFY_PLAINTEXT;
    } catch (e) {
      return false;
    }
  }

  const api = { generateSalt, deriveKey, exportKeyRaw, importKeyRaw, encryptText, decryptText, makeVerifier, checkVerifier };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.CredentialCrypto = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
