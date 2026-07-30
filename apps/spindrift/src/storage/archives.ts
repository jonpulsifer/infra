/**
 * Durable archive staging storage.
 *
 * §4: "Archive upload accepts real bytes, stages them durably, and follows the
 * supplied-artifact or source-build path selected during creation."
 *
 * Compute SHA-256 digest over exact uploaded bytes (§16) and stage to disk
 * under the storage directory so builders and reconcilers can fetch them.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface StagedArchive {
  readonly digest: string;
  readonly location: string;
  readonly filepath: string;
  readonly filename: string;
  readonly size: number;
}

export function storageDir(): string {
  const custom = process.env.SPINDRIFT_STORAGE_DIR?.trim();
  if (custom) return custom;
  return join(tmpdir(), 'spindrift-archives');
}

/** Compute SHA-256 digest in sha256:<hex> format over bytes. */
export function digestOfBytes(bytes: Uint8Array): string {
  const hash = createHash('sha256').update(bytes).digest('hex');
  return `sha256:${hash}`;
}

/** Stage archive bytes durably and return the digest and location. */
export async function stageArchiveBytes(
  filename: string,
  bytes: Uint8Array,
): Promise<StagedArchive> {
  const dir = storageDir();
  await mkdir(dir, { recursive: true });

  const digest = digestOfBytes(bytes);
  const hex = digest.replace('sha256:', '');
  const ext = filename.includes('.') ? filename.split('.').pop() : 'zip';
  const filepath = join(dir, `${hex}.${ext}`);

  await writeFile(filepath, bytes);

  return {
    digest,
    location: `upload://${hex}`,
    filepath,
    filename,
    size: bytes.byteLength,
  };
}

/** Read a staged archive by its sha256 digest or hex handle. */
export async function readStagedArchive(
  digestOrHex: string,
): Promise<Uint8Array | null> {
  const hex = digestOrHex.replace('sha256:', '').replace('upload://', '');
  const dir = storageDir();
  try {
    const entries = await readdir(dir);
    const match = entries.find((entry) => entry.startsWith(hex));
    if (match) {
      return new Uint8Array(await readFile(join(dir, match)));
    }
    return null;
  } catch {
    return null;
  }
}
