/**
 * A real ZIP, written by hand rather than checked in as a blob.
 *
 * Shared because two suites need one: the normalizer's own tests, and the
 * upload boundary's — which used to stage the string `dummy zip file contents`
 * under the name `test-app.zip` and pass. A fixture that is actually the format
 * is what makes that test able to fail.
 */
/** One entry, as a ZIP stores it: stored (method 0), so the fixture needs no deflate. */
export interface Entry {
  readonly path: string;
  readonly text: string;
  readonly mode?: number;
}

/**
 * A real ZIP, written here rather than checked in as a blob.
 *
 * Built by hand for the same reason the reader is: it is the format's own
 * layout, and a fixture nobody can read is a fixture nobody can correct.
 */
export function zipOf(entries: readonly Entry[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const data = encoder.encode(entry.text);

    const local = new Uint8Array(30 + name.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true); // version needed
    localView.setUint16(8, 0, true); // stored
    localView.setUint32(14, crc32(data), true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    // High byte 3 is unix, which is what makes the mode below readable.
    centralView.setUint16(4, (3 << 8) | 20, true);
    centralView.setUint16(10, 0, true); // stored
    centralView.setUint32(16, crc32(data), true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(
      38,
      (entry.mode ?? (entry.path.endsWith('/') ? 0o755 : 0o644)) << 16,
      true,
    );
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, block) => sum + block.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);

  return concat([...locals, ...centrals, eocd]);
}

function concat(blocks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(
    blocks.reduce((sum, block) => sum + block.length, 0),
  );
  let at = 0;
  for (const block of blocks) {
    out.set(block, at);
    at += block.length;
  }
  return out;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
