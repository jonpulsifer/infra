/**
 * Pulling a `files` artifact out of an OCI registry.
 *
 * Static hosting is the one backend where the **controller** must hold the
 * bytes: Cloud Run and Kubernetes hand a reference to a runtime that does its
 * own pulling, but the hosting API is fed files, so whatever this adapter
 * deploys it must first fetch. A `files` Build lands in the registry like
 * every other artifact — as a single-layer image whose one layer *is* the
 * gzipped tar `bundle.ts` reads (the build workflow's files arm produces
 * exactly that with `FROM scratch` + `COPY . /`) — and this module is the read
 * half of that agreement.
 *
 * It speaks just enough of the distribution API to resolve one digest to one
 * layer: manifest, index-to-child, blob. It is not a registry client; there is
 * deliberately no tag resolution, no listing, and no push.
 *
 * **Google-family registries only.** The adapter's identity is the federated
 * token it already presents to the hosting API, and Artifact Registry accepts
 * that same token as a Bearer credential on its Docker API. Nothing here can
 * read `ghcr.io` — that would take a credential the manifest deliberately does
 * not model (§13) — which is why the caller chooses the ref, not this module.
 *
 * The blob request may answer with a redirect to signed storage. The runtime's
 * fetch follows it, and undici drops the `Authorization` header on the
 * cross-origin hop — which is required, because a signed URL refuses a request
 * that also carries credentials.
 */
import type { Fetcher, TokenProvider } from '../cloud/http.ts';

/** Why a pull failed, as a sentence the deploy verdict can carry. */
export class OciPullError extends Error {
  override readonly name = 'OciPullError';
}

/** One reference, split into the three parts the v2 API addresses. */
export interface OciRef {
  readonly host: string;
  readonly repository: string;
  readonly digest: string;
}

/** `host/repository@sha256:…`, or null for anything else. */
export function parseOciRef(ref: string): OciRef | null {
  const match = /^([^/@\s]+)\/([^@\s]+)@(sha256:[0-9a-f]{64})$/.exec(ref);
  if (match === null) return null;
  return {
    host: match[1] as string,
    repository: match[2] as string,
    digest: match[3] as string,
  };
}

/**
 * The first reference on a registry the adapter's own token reads.
 *
 * The predicate is the build workflow's `googleHosts` one, read from the other
 * end: the hosts the runner logs into with the federated identity are exactly
 * the hosts that identity can read back from.
 */
export function googleRegistryRef(refs: readonly string[]): string | null {
  return (
    refs.find((ref) => {
      const host = ref.split('/')[0] ?? '';
      return host.endsWith('-docker.pkg.dev') || host === 'gcr.io';
    }) ?? null
  );
}

/** Every manifest shape the one GET may answer with. */
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** The two spellings of "a gzipped tar" the two manifest families use. */
const GZIPPED_TAR_LAYERS = new Set([
  'application/vnd.oci.image.layer.v1.tar+gzip',
  'application/vnd.docker.image.rootfs.diff.tar.gzip',
]);

/** As much of a descriptor as choosing and fetching needs. */
interface Descriptor {
  readonly mediaType?: string;
  readonly digest?: string;
  readonly annotations?: Readonly<Record<string, string>>;
  readonly platform?: { readonly os?: string; readonly architecture?: string };
}

/** An index and an image manifest, read through one shape. */
interface Manifest {
  readonly manifests?: readonly Descriptor[];
  readonly layers?: readonly Descriptor[];
}

/** The files artifact's one layer, as the gzipped tar `readBundle` takes. */
export async function pullFilesLayer(input: {
  readonly ref: string;
  readonly token: TokenProvider;
  readonly fetch?: Fetcher;
}): Promise<Uint8Array<ArrayBuffer>> {
  const parsed = parseOciRef(input.ref);
  if (parsed === null) {
    throw new OciPullError(`not a registry reference: ${input.ref}`);
  }
  const send = input.fetch ?? ((request: Request) => fetch(request));
  const authorization = `Bearer ${await input.token()}`;

  const outer = await manifestOf(send, authorization, parsed, parsed.digest);
  const image = await imageOf(send, authorization, parsed, outer, input.ref);

  const layers = image.layers ?? [];
  if (layers.length !== 1) {
    // The one mismatch worth its own sentence: a multi-layer object at a
    // files address is an *image* — a Build made by a route with no files arm
    // — and "N layers" is what tells that story apart from a corrupt push.
    throw new OciPullError(
      `the artifact at ${input.ref} carries ${layers.length} layers — a files artifact is one gzipped tar, and this is an image`,
    );
  }
  const layer = layers[0] as Descriptor;
  if (!GZIPPED_TAR_LAYERS.has(layer.mediaType ?? '')) {
    throw new OciPullError(
      `the artifact's one layer is ${layer.mediaType ?? 'untyped'} rather than a gzipped tar`,
    );
  }
  if (layer.digest === undefined) {
    throw new OciPullError('the artifact names a layer with no digest');
  }

  const blob = await send(
    new Request(
      `https://${parsed.host}/v2/${parsed.repository}/blobs/${layer.digest}`,
      { headers: { Authorization: authorization } },
    ),
  );
  if (!blob.ok) {
    throw new OciPullError(
      `fetching the files layer ${layer.digest} answered ${blob.status}`,
    );
  }
  return new Uint8Array(await blob.arrayBuffer());
}

/** One manifest GET, refused as a sentence rather than a status. */
async function manifestOf(
  send: Fetcher,
  authorization: string,
  ref: OciRef,
  digest: string,
): Promise<Manifest> {
  const response = await send(
    new Request(
      `https://${ref.host}/v2/${ref.repository}/manifests/${digest}`,
      {
        headers: { Accept: MANIFEST_ACCEPT, Authorization: authorization },
      },
    ),
  );
  if (!response.ok) {
    throw new OciPullError(
      `the registry answered ${response.status} for the manifest at ${digest}`,
    );
  }
  return (await response.json()) as Manifest;
}

/**
 * The image manifest under an index, or the manifest itself.
 *
 * The selection is the build workflow's own (`Attest the artifact`): a child
 * is something a runtime could run — not an attestation manifest, not an
 * `unknown/unknown` platform. `provenance: mode=max` hangs both off every
 * push, so this filter is the ordinary case rather than a defensive one.
 */
async function imageOf(
  send: Fetcher,
  authorization: string,
  ref: OciRef,
  manifest: Manifest,
  named: string,
): Promise<Manifest> {
  if (manifest.manifests === undefined) return manifest;
  const children = manifest.manifests.filter(
    (child) =>
      child.annotations?.['vnd.docker.reference.type'] !==
        'attestation-manifest' &&
      (child.platform?.os ?? '') !== 'unknown' &&
      (child.platform?.architecture ?? '') !== 'unknown',
  );
  const digest = children[0]?.digest;
  if (children.length !== 1 || digest === undefined) {
    throw new OciPullError(
      `the index at ${named} holds ${children.length} runnable manifests where a files artifact holds one`,
    );
  }
  return manifestOf(send, authorization, ref, digest);
}
