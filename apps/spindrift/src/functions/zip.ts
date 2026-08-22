/**
 * A store-only ZIP writer — enough of the format to hand Cloud Build a source
 * archive, and nothing else.
 *
 * No dependency, because the whole need is three small files with no
 * compression: method 0 means the bytes are copied verbatim and the only real
 * work is the CRC-32 the reader checks them against.
 *
 * **Deterministic on purpose.** Every entry carries the same fixed DOS
 * timestamp, so the same sources produce the same bytes and therefore the same
 * digest — which is what lets the object name be the digest and an unchanged
 * function re-upload to the same place instead of accumulating one object per
 * deploy.
 *
 * ponytail: store-only, no Zip64. A function whose archive passes 4 GiB has a
 * different problem; add deflate and Zip64 headers if one ever does.
 */

/** 1980-01-01 00:00, the earliest a DOS timestamp can say. */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

/** Bit 11: the name is UTF-8 rather than the format's ancient default. */
const UTF8_NAME = 0x0800;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** One archive, in the order the files were given. */
export function zip(
  files: readonly { name: string; bytes: Uint8Array }[],
): Uint8Array {
  const encoder = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.bytes);

    const header = new Uint8Array(30 + name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true); // version needed
    view.setUint16(6, UTF8_NAME, true);
    view.setUint16(8, 0, true); // method: stored
    view.setUint16(10, DOS_TIME, true);
    view.setUint16(12, DOS_DATE, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, file.bytes.length, true);
    view.setUint32(22, file.bytes.length, true);
    view.setUint16(26, name.length, true);
    view.setUint16(28, 0, true); // extra field length
    header.set(name, 30);
    local.push(header, file.bytes);

    const entry = new Uint8Array(46 + name.length);
    const entryView = new DataView(entry.buffer);
    entryView.setUint32(0, 0x02014b50, true);
    entryView.setUint16(4, 20, true); // version made by
    entryView.setUint16(6, 20, true); // version needed
    entryView.setUint16(8, UTF8_NAME, true);
    entryView.setUint16(10, 0, true);
    entryView.setUint16(12, DOS_TIME, true);
    entryView.setUint16(14, DOS_DATE, true);
    entryView.setUint32(16, crc, true);
    entryView.setUint32(20, file.bytes.length, true);
    entryView.setUint32(24, file.bytes.length, true);
    entryView.setUint16(28, name.length, true);
    entryView.setUint32(42, offset, true); // local header offset
    entry.set(name, 46);
    central.push(entry);

    offset += header.length + file.bytes.length;
  }

  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const parts = [...local, ...central, end];
  const archive = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let at = 0;
  for (const part of parts) {
    archive.set(part, at);
    at += part.length;
  }
  return archive;
}
