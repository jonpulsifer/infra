/**
 * Getting a `files` artifact's bytes into the edge platform's asset store.
 *
 * **This file is the undocumented half, on purpose.** The platform publishes a
 * REST reference for projects, deployments and domains — every call in
 * `index.ts` is in it — but the asset upload the direct-upload flow depends on
 * is not there. The three endpoints below and the token that authorizes them
 * are what the vendor's own CLI does, read off its source, and the manifest a
 * deployment is created from cannot be assembled without them.
 *
 * So they are here rather than spread through the adapter: when one of them
 * moves, the blast radius is one file, and a reader who wants to know how much
 * of this Target rests on an unpublished contract can see all of it at once.
 *
 * The flow, and why each step is not optional:
 *
 * 1. **A scoped token.** The account credential does not authorize the asset
 *    store; a short-lived token minted per project does, and it is the only
 *    thing the three calls below accept.
 * 2. **Offer every hash.** The store answers with the subset it does not
 *    already hold, which is what makes redeploying an unchanged site nearly
 *    free — and what makes the hash formula below load-bearing rather than an
 *    optimisation.
 * 3. **Upload what was asked for.** In buckets, because a single request has a
 *    size ceiling and a site clears it without trying.
 * 4. **Touch every hash.** Best effort: it keeps files this deployment reused
 *    from ageing out of the store, so the *next* deploy is cheap too. A failure
 *    here costs a slower deploy later and nothing else, which is why it is the
 *    one step that does not fail the release.
 */
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { CloudHttp, type CloudResponse, type Fetcher } from '../cloud/http.ts';
import { missing, type Outcome } from '../cloud/verdict.ts';
import type { BundleFile } from '../static/bundle.ts';

/**
 * How many characters of the digest the store keys on.
 *
 * The vendor's, not a choice: a longer key is rejected and a shorter one
 * collides. Same for the input being the **base64 text** of the file plus its
 * extension without the dot rather than the file's own bytes — the store
 * deduplicates on exactly this string, so hashing the content honestly instead
 * would offer keys it has never seen and re-upload the whole site every time.
 */
const HASH_LENGTH = 32;

/**
 * The most bytes one upload request carries, and the most files.
 *
 * The platform's ceilings. Exceeding either is a refusal of the whole bucket,
 * so the packing below is what keeps a large site deployable rather than a
 * tuning knob — and the size is measured on the base64 expansion rather than on
 * the file, because that is what the request actually carries.
 */
const BUCKET_BYTES = 40 * 1024 * 1024;
const BUCKET_FILES = 5_000;

/** The most hashes one offer carries. The store's own ceiling. */
const OFFER_LIMIT = 5_000;

/** One file, with the key the asset store addresses it by. */
export interface HashedFile {
  /** Rooted at the site with a leading slash — what the manifest is keyed on. */
  readonly path: string;
  readonly hash: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
}

/** What a deployment is created from: every path, mapped to its hash. */
export type AssetManifest = Readonly<Record<string, string>>;

/**
 * The store's key for one file.
 *
 * Exported because it is the one piece of this contract a test can check
 * against a fixed vector with no far side at all, and a formula nobody can
 * check is a formula that drifts.
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

/**
 * What the platform serves a file as.
 *
 * `Bun.file` resolves a media type from the name without touching the disk,
 * which is the whole of the mapping this needs — a table here would be a table
 * to maintain, and the runtime already ships one.
 */
export function contentTypeOf(path: string): string {
  return Bun.file(path).type || 'application/octet-stream';
}

/** Every file, with its key — computed once and reused by both steps below. */
export function hashFiles(files: readonly BundleFile[]): HashedFile[] {
  return files.map((file) => ({
    path: file.path,
    hash: hashOf(file),
    bytes: file.bytes,
    contentType: contentTypeOf(file.path),
  }));
}

/**
 * The platform's envelope. Every call answers in it, success included, and a
 * `200` carrying `success: false` is a real answer shape rather than a
 * curiosity — so unwrapping is where a refusal is noticed, not the status.
 */
export interface Envelope<Result> {
  readonly success?: boolean;
  readonly errors?: readonly { code?: number; message?: string }[];
  readonly result?: Result;
}

/**
 * The `result` of an enveloped answer, or the refusal it actually carried.
 *
 * A `200 { success: false }` is folded into the failure arm as `transport`,
 * which is deliberate: `cloudWriteFailure` reads `transport` as the Target
 * being unreachable, and a call refused with no status to reason about is
 * exactly as un-actionable to the person deploying as a socket that died.
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
  /** The account the project lives in, for that one call's path. */
  readonly account: string;
  /** The API root, so the token-scoped client can be built against it. */
  readonly endpoint: string;
  readonly fetch?: Fetcher;
  readonly project: string;
  readonly files: readonly HashedFile[];
  /** Written to the attempt log as each bucket lands. */
  readonly onProgress?: (line: string) => void;
}

/**
 * Put every file the store is missing into it, and answer with the manifest.
 *
 * The manifest names **every** file, not only the uploaded ones: it is what the
 * deployment serves, and one built from the missing subset would publish a site
 * consisting of whatever happened to change since last time.
 */
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

  // A second client over the same transport: the asset store accepts only the
  // minted token, and handing it the account credential is a `401` on every
  // file with nothing in the message to say which of the two was wrong.
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

  // Best effort, and the one refusal that is swallowed: this keeps files the
  // deployment reused from ageing out, so what a failure costs is a slower
  // deploy next time. Failing the release over it would trade a live site for
  // an optimisation.
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
 * Which of these keys the store does not already hold.
 *
 * A chunk whose answer carries no list is treated as **every hash in it
 * missing**, not none: uploading a file the store already has costs bandwidth,
 * and skipping one it does not have finalizes a deployment whose bytes are not
 * all there — which serves a broken site and reports success.
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
 * The files to upload, packed into requests that fit.
 *
 * First-fit decreasing over a size **and** a count: big files claim whole
 * buckets and small ones fill the gaps, which is what keeps the request count
 * near the minimum. A single file over the size ceiling still gets its own
 * bucket — it will be refused, and refused with the platform's own sentence
 * naming that file, which is a better answer than this function dropping it.
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

/** One list as chunks the store will accept, with no empty chunk. */
function chunksOf(items: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let at = 0; at < items.length; at += OFFER_LIMIT) {
    chunks.push(items.slice(at, at + OFFER_LIMIT));
  }
  return chunks;
}
