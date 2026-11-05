const EOCD_SIGNATURE = 101010256;
const CENTRAL_DIR_SIGNATURE = 33639248;
const LOCAL_FILE_SIGNATURE = 67324752;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  throw new Error("ZipLite: expected a Uint8Array/Buffer");
}
function findEndOfCentralDirectory(bytes) {
  const maxCommentLength = 65535;
  const minPos = Math.max(0, bytes.length - 22 - maxCommentLength);
  for (let i = bytes.length - 22; i >= minPos; i--) {
    if (bytes[i] === 80 && bytes[i + 1] === 75 && bytes[i + 2] === 5 && bytes[i + 3] === 6) {
      return i;
    }
  }
  return -1;
}
function parseZipEntries(input) {
  const bytes = toUint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdPos = findEndOfCentralDirectory(bytes);
  if (eocdPos === -1) throw new Error("ZipLite: no End Of Central Directory record found \u2014 not a valid zip");
  if (view.getUint32(eocdPos, true) !== EOCD_SIGNATURE) throw new Error("ZipLite: EOCD signature mismatch");
  const totalEntries = view.getUint16(eocdPos + 10, true);
  let centralDirOffset = view.getUint32(eocdPos + 16, true);
  const entries = [];
  for (let n = 0; n < totalEntries; n++) {
    if (view.getUint32(centralDirOffset, true) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error(`ZipLite: central directory signature mismatch for entry ${n} at offset ${centralDirOffset}`);
    }
    const method = view.getUint16(centralDirOffset + 10, true);
    const crc32 = view.getUint32(centralDirOffset + 16, true);
    const compressedSize = view.getUint32(centralDirOffset + 20, true);
    const uncompressedSize = view.getUint32(centralDirOffset + 24, true);
    const nameLength = view.getUint16(centralDirOffset + 28, true);
    const extraLength = view.getUint16(centralDirOffset + 30, true);
    const commentLength = view.getUint16(centralDirOffset + 32, true);
    const localHeaderOffset = view.getUint32(centralDirOffset + 42, true);
    const nameBytes = bytes.subarray(centralDirOffset + 46, centralDirOffset + 46 + nameLength);
    const name = new TextDecoder("utf-8").decode(nameBytes);
    entries.push({ name, method, crc32, compressedSize, uncompressedSize, compressedOffset: 0, localHeaderOffset });
    centralDirOffset += 46 + nameLength + extraLength + commentLength;
  }
  return entries.map((entry) => {
    if (view.getUint32(entry.localHeaderOffset, true) !== LOCAL_FILE_SIGNATURE) {
      throw new Error(`ZipLite: local file header signature mismatch for "${entry.name}"`);
    }
    const localNameLength = view.getUint16(entry.localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(entry.localHeaderOffset + 28, true);
    const compressedOffset = entry.localHeaderOffset + 30 + localNameLength + localExtraLength;
    const { localHeaderOffset, ...rest } = entry;
    void localHeaderOffset;
    return { ...rest, compressedOffset };
  });
}
function getCompressedBytes(input, entry) {
  const bytes = toUint8Array(input);
  return bytes.slice(entry.compressedOffset, entry.compressedOffset + entry.compressedSize);
}
export {
  METHOD_DEFLATE,
  METHOD_STORED,
  getCompressedBytes,
  parseZipEntries
};
