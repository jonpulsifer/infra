/**
 * CRC-32C (Castagnoli), the checksum Cloud Storage reports for every object,
 * so a client can tell an unchanged file without downloading it.
 */

const POLYNOMIAL = 0x82f63b78;

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (value >>> 1) ^ POLYNOMIAL : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32cValue(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Base64 of the big-endian value: the spelling of an object's `crc32c`. */
export function crc32c(bytes: Uint8Array): string {
  const value = crc32cValue(bytes);
  return btoa(
    String.fromCharCode(
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ),
  );
}
