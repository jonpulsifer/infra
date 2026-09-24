/**
 * The OCI read surface `static/oci.ts` uses, serving one artifact shaped as a
 * files push is: an index of one runnable child and one attestation manifest.
 */
import type { Fetcher } from '../../../src/adapters/deploy/cloud/http.ts';

export interface FakeOciRegistryOptions {
  /** e.g. `region-docker.pkg.dev`. */
  readonly host: string;
  /** The repository path under the host. */
  readonly repository: string;
  /** The index digest. */
  readonly digest: string;
  /** The first layer's bytes, normally a gzipped tar of the site. */
  readonly layer: Uint8Array;
  /** More than 1 fabricates an image at a files address. */
  readonly layerCount?: number;
  readonly layerMediaType?: string;
}

const CHILD_DIGEST = `sha256:${'c'.repeat(64)}`;
const ATTESTATION_DIGEST = `sha256:${'e'.repeat(64)}`;
const LAYER_DIGEST = `sha256:${'d'.repeat(64)}`;

export class FakeOciRegistry {
  readonly requests: {
    method: string;
    path: string;
    authorization: string | null;
  }[] = [];

  constructor(private readonly options: FakeOciRegistryOptions) {}

  readonly fetch: Fetcher = async (request) => {
    const url = new URL(request.url);
    this.requests.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.get('authorization'),
    });
    if (url.host !== this.options.host) {
      return json({ errors: [{ code: 'NAME_UNKNOWN' }] }, 404);
    }
    const base = `/v2/${this.options.repository}`;

    if (url.pathname === `${base}/manifests/${this.options.digest}`) {
      // The attestation manifest fails a reader that does not filter it out.
      return json({
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.index.v1+json',
        manifests: [
          {
            mediaType: 'application/vnd.oci.image.manifest.v1+json',
            digest: CHILD_DIGEST,
            platform: { os: 'linux', architecture: 'amd64' },
          },
          {
            mediaType: 'application/vnd.oci.image.manifest.v1+json',
            digest: ATTESTATION_DIGEST,
            annotations: {
              'vnd.docker.reference.type': 'attestation-manifest',
            },
            platform: { os: 'unknown', architecture: 'unknown' },
          },
        ],
      });
    }
    if (url.pathname === `${base}/manifests/${CHILD_DIGEST}`) {
      const count = this.options.layerCount ?? 1;
      return json({
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        layers: Array.from({ length: count }, (_, at) => ({
          mediaType:
            this.options.layerMediaType ??
            'application/vnd.oci.image.layer.v1.tar+gzip',
          digest:
            at === 0
              ? LAYER_DIGEST
              : `sha256:${`${at}`.repeat(64).slice(0, 64)}`,
          size: this.options.layer.length,
        })),
      });
    }
    if (url.pathname === `${base}/blobs/${LAYER_DIGEST}`) {
      return new Response(this.options.layer.slice() as unknown as BodyInit, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    }
    return json({ errors: [{ code: 'MANIFEST_UNKNOWN' }] }, 404);
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
