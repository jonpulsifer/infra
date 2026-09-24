/**
 * Uploads a `files` artifact to the edge platform's asset store. These calls
 * are undocumented, taken from the vendor CLI's source, and kept in this file.
 */
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { BundleFile } from '@repo/archive/bundle';
import { CloudHttp, type CloudResponse, type Fetcher } from '../cloud/http.ts';
import { missing, type Outcome } from '../cloud/verdict.ts';

/** Set by the vendor: a longer key is rejected and a shorter one collides. */
const HASH_LENGTH = 32;

/**
 * The platform's per-request ceilings; exceeding either refuses the whole
 * bucket. Bytes count after base64 expansion.
 */
const BUCKET_BYTES = 40 * 1024 * 1024;
const BUCKET_FILES = 5_000;

/** The store's ceiling on hashes per request. */
const OFFER_LIMIT = 5_000;

export interface HashedFile {
  /** Rooted at the site with a leading slash, as the manifest is keyed. */
  readonly path: string;
  readonly hash: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
}

export type AssetManifest = Readonly<Record<string, string>>;

/**
 * The store dedupes on BLAKE3 of the base64 text plus the bare extension. Any
 * other formula misses every stored file and re-uploads the whole site.
 */
export function hashOf(file: BundleFile): string {
  const name = file.path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  const extension = dot <= 0 ? '' : name.slice(dot + 1);
  const base64 = Buffer.from(file.bytes).toString('base64');
  return bytesToHex(blake3(new TextEncoder().encode(base64 + extension))).slice(
    0,
    HASH_LENGTH,
  );
}

/** `Bun.file` resolves the type from the name without touching the disk. */
export function contentTypeOf(path: string): string {
  return Bun.file(path).type || 'application/octet-stream';
}

export function hashFiles(files: readonly BundleFile[]): HashedFile[] {
  return files.map((file) => ({
    path: file.path,
    hash: hashOf(file),
    bytes: file.bytes,
    contentType: contentTypeOf(file.path),
  }));
}

/** A `200` can carry `success: false`, so refusals are read from here. */
export interface Envelope<Result> {
  readonly success?: boolean;
  readonly errors?: readonly { code?: number; message?: string }[];
  readonly result?: Result;
}

/**
 * `success: false` becomes a `transport` failure, which `cloudWriteFailure`
 * reads as the Target unreachable: there is no status to reason about.
 */
export function unwrap<Result>(
  response: CloudResponse<Envelope<Result> | undefined>,
): Outcome<Result | undefined> {
  if (!response.ok) return { ok: false, failure: response };
  const envelope = response.value;
  if (envelope?.success === false) {
    const said = (envelope.errors ?? [])
      .map((error) => `${error.code ?? '?'}: ${error.message ?? 'no message'}`)
      .join('; ');
    return {
      ok: false,
      failure: {
        ok: false,
        kind: 'transport',
        message: said === '' ? 'the API refused without saying why' : said,
      },
    };
  }
  return { ok: true, value: envelope?.result };
}

export interface UploadInput {
  /** The account-scoped client, for minting the upload token. */
  readonly client: CloudHttp;
  /** For the token call's path. */
  readonly account: string;
  /** The API root the token-scoped client is built against. */
  readonly endpoint: string;
  readonly fetch?: Fetcher;
  readonly project: string;
  readonly files: readonly HashedFile[];
  /** Written to the attempt log as each bucket uploads. */
  readonly onProgress?: (line: string) => void;
}

/** The manifest names every file, not only the uploaded ones. */
export async function uploadAssets(
  input: UploadInput,
): Promise<Outcome<AssetManifest>> {
  const minted = unwrap(
    await input.client.json<Envelope<{ jwt?: string }>>({
      method: 'GET',
      path: `/accounts/${encodeURIComponent(input.account)}/pages/projects/${encodeURIComponent(input.project)}/upload-token`,
    }),
  );
  if (!minted.ok) return minted;
  const jwt = minted.value?.jwt;
  if (jwt === undefined) {
    return { ok: false, failure: missing('the API minted no upload token') };
  }

  // The asset store accepts only the minted token; the account credential
  // gets a 401 that does not say why.
  const store = new CloudHttp({
    baseUrl: input.endpoint,
    token: () => jwt,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });

  const absent = await missingHashes(store, input.files);
  if (!absent.ok) return absent;

  const wanted = input.files.filter((file) => absent.value.has(file.hash));
  input.onProgress?.(
    `${wanted.length} of ${input.files.length} files are new to this Target`,
  );

  for (const bucket of bucketsOf(wanted)) {
    const uploaded = unwrap(
      await store.json<Envelope<unknown>>({
        method: 'POST',
        path: '/pages/assets/upload',
        body: bucket.map((file) => ({
          key: file.hash,
          value: Buffer.from(file.bytes).toString('base64'),
          metadata: { contentType: file.contentType },
          base64: true,
        })),
      }),
    );
    if (!uploaded.ok) return uploaded;
    input.onProgress?.(`uploaded ${bucket.length} files`);
  }

  // Best effort: this keeps reused files from ageing out of the store, so a
  // failure only slows the next deploy.
  for (const chunk of chunksOf(input.files.map((file) => file.hash))) {
    await store.json<Envelope<unknown>>({
      method: 'POST',
      path: '/pages/assets/upsert-hashes',
      body: { hashes: chunk },
    });
  }

  return {
    ok: true,
    value: Object.fromEntries(
      input.files.map((file) => [file.path, file.hash]),
    ),
  };
}

/**
 * A chunk answered with no list counts as all missing: skipping a file the
 * store lacks would publish a broken site.
 */
async function missingHashes(
  store: CloudHttp,
  files: readonly HashedFile[],
): Promise<Outcome<Set<string>>> {
  const absent = new Set<string>();
  for (const chunk of chunksOf(files.map((file) => file.hash))) {
    const answered = unwrap(
      await store.json<Envelope<readonly string[]>>({
        method: 'POST',
        path: '/pages/assets/check-missing',
        body: { hashes: chunk },
      }),
    );
    if (!answered.ok) return answered;
    for (const hash of answered.value ?? chunk) absent.add(hash);
  }
  return { ok: true, value: absent };
}

/**
 * First-fit decreasing by size and count. A file over the size ceiling still
 * gets a bucket, so the platform's refusal names it.
 */
function bucketsOf(files: readonly HashedFile[]): HashedFile[][] {
  const buckets: { files: HashedFile[]; remaining: number }[] = [];
  for (const file of [...files].sort(
    (left, right) => right.bytes.length - left.bytes.length,
  )) {
    const cost = Math.ceil(file.bytes.length / 3) * 4;
    const fits = buckets.find(
      (bucket) =>
        bucket.remaining >= cost && bucket.files.length < BUCKET_FILES,
    );
    if (fits === undefined) {
      buckets.push({ files: [file], remaining: BUCKET_BYTES - cost });
    } else {
      fits.files.push(file);
      fits.remaining -= cost;
    }
  }
  return buckets.map((bucket) => bucket.files);
}

function chunksOf(items: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let at = 0; at < items.length; at += OFFER_LIMIT) {
    chunks.push(items.slice(at, at + OFFER_LIMIT));
  }
  return chunks;
}
