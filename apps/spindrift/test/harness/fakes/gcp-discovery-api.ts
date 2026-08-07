/**
 * A fake of the three APIs discovery reads (§ Seam 2).
 *
 * The far-side HTTP API behind the real client, so `GcpDiscovery`'s real
 * resource names, its real query parameters, its real page loop and its real
 * key-purpose filter are all exercised. One `Fetcher` rather than three,
 * routing on the host, because that is what the client is actually handed: it
 * addresses three hostnames through one injected transport, and a test that
 * substituted a per-API stub would never prove the client sends the right
 * request to the right host.
 *
 * Five behaviours are modelled because the client has to survive them, not
 * because they decorate:
 *
 * - **A wrong bearer is a `401`**, so a test can prove which credential arrived.
 * - **A disabled service is a `403` carrying `SERVICE_DISABLED` in
 *   `error.details`**, which is the shape the fold keys on and the one that must
 *   not be reported as a missing permission.
 * - **An unknown project is a `404`**, distinct from a refusal.
 * - **Listing is paginated at a deliberately tiny page**, because a client that
 *   reads one page answers a short list that looks complete.
 * - **A key of the wrong purpose exists**, so the filter is run rather than
 *   assumed. A symmetric key offered as a signer is a manifest that validates
 *   and then fails at the first cosign call.
 */
import type { Fetcher } from '../../../src/adapters/deploy/cloud/http.ts';

/** One key the fake holds, and where it lives. */
export interface FakeCryptoKey {
  readonly project: string;
  readonly location: string;
  readonly ring: string;
  readonly name: string;
  /** Defaults to a signing key; a test sets another to exercise the filter. */
  readonly purpose?: string;
}

/** How one of the three APIs refuses everything asked of it. */
export interface FakeRefusal {
  readonly status: number;
  /** Placed in `error.details[].reason`, as the real APIs place it. */
  readonly reason?: string;
  /**
   * Placed in `error.details[].metadata.consumer` as `projects/<id>`, as
   * ErrorInfo carries it — the project the refused call bills, which is not
   * necessarily the one the request URL names.
   */
  readonly consumer?: string;
  readonly message?: string;
}

export interface FakeGcpDiscoveryOptions {
  readonly token?: string;
  /** Project ids Resource Manager lists as active, in order. */
  readonly projects?: readonly string[];
  /** Listed too, and pending deletion — an answer that is not a candidate. */
  readonly deletedProjects?: readonly string[];
  readonly buckets?: Readonly<Record<string, readonly string[]>>;
  readonly keyLocations?: Readonly<Record<string, readonly string[]>>;
  readonly keys?: readonly FakeCryptoKey[];
  /** Items per page. Small on purpose, to run the client's page loop. */
  readonly pageSize?: number;
  readonly refuse?: {
    readonly resourceManager?: FakeRefusal;
    readonly storage?: FakeRefusal;
    readonly keyManagement?: FakeRefusal;
  };
}

export interface RecordedRequest {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly authorization: string | null;
}

const RESOURCE_MANAGER_HOST = 'cloudresourcemanager.googleapis.com';
const STORAGE_HOST = 'storage.googleapis.com';
const KEY_MANAGEMENT_HOST = 'cloudkms.googleapis.com';

export class FakeGcpDiscovery {
  readonly requests: RecordedRequest[] = [];

  private readonly token: string;
  private readonly options: FakeGcpDiscoveryOptions;
  private readonly pageSize: number;

  constructor(options: FakeGcpDiscoveryOptions = {}) {
    this.options = options;
    this.token = options.token ?? 'federated-token';
    this.pageSize = options.pageSize ?? 100;
  }

  readonly fetch: Fetcher = async (request) => {
    const url = new URL(request.url);
    this.requests.push({
      method: request.method,
      host: url.host,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: request.headers.get('Authorization'),
    });

    if (request.headers.get('Authorization') !== `Bearer ${this.token}`) {
      return error(401, { message: 'the caller is not authenticated' });
    }

    const segments = url.pathname.split('/').filter(Boolean);
    switch (url.host) {
      case RESOURCE_MANAGER_HOST:
        return this.resourceManager(segments, url.searchParams);
      case STORAGE_HOST:
        return this.storage(segments, url.searchParams);
      case KEY_MANAGEMENT_HOST:
        return this.keyManagement(segments, url.searchParams);
      default:
        return error(404, { message: `nothing is served at ${url.host}` });
    }
  };

  private resourceManager(
    segments: readonly string[],
    query: URLSearchParams,
  ): Response {
    const refused = refusalOf(this.options.refuse?.resourceManager);
    if (refused !== null) return refused;
    if (segments[0] !== 'v1' || segments[1] !== 'projects') {
      return error(404, { message: 'no such route' });
    }
    const all = [
      ...(this.options.projects ?? []).map((projectId) => ({
        projectId,
        lifecycleState: 'ACTIVE',
      })),
      ...(this.options.deletedProjects ?? []).map((projectId) => ({
        projectId,
        lifecycleState: 'DELETE_REQUESTED',
      })),
    ];
    return this.page('projects', all, query);
  }

  private storage(
    segments: readonly string[],
    query: URLSearchParams,
  ): Response {
    const refused = refusalOf(this.options.refuse?.storage);
    if (refused !== null) return refused;
    if (segments[0] !== 'storage' || segments[2] !== 'b') {
      return error(404, { message: 'no such route' });
    }
    const project = query.get('project');
    if (project === null) {
      return error(400, { message: 'the project parameter is required' });
    }
    const buckets = this.options.buckets?.[project];
    if (buckets === undefined) {
      return error(404, { message: `there is no project named ${project}` });
    }
    return this.page(
      'items',
      buckets.map((name) => ({ name })),
      query,
    );
  }

  private keyManagement(
    segments: readonly string[],
    query: URLSearchParams,
  ): Response {
    const refused = refusalOf(this.options.refuse?.keyManagement);
    if (refused !== null) return refused;
    // /v1/projects/{p}/locations[/{l}/keyRings[/{r}/cryptoKeys]]
    const [version, projects, project, locations, location, rings, ring, keys] =
      segments;
    if (version !== 'v1' || projects !== 'projects' || project === undefined) {
      return error(404, { message: 'no such route' });
    }

    if (segments.length === 4 && locations === 'locations') {
      const offered = this.options.keyLocations?.[project];
      if (offered === undefined) {
        return error(404, { message: `there is no project named ${project}` });
      }
      return this.page(
        'locations',
        offered.map((locationId) => ({
          locationId,
          name: `projects/${project}/locations/${locationId}`,
        })),
        query,
      );
    }

    const held = this.options.keys ?? [];
    if (segments.length === 6 && rings === 'keyRings') {
      const named = new Set(
        held
          .filter((key) => key.project === project && key.location === location)
          .map((key) => key.ring),
      );
      return this.page(
        'keyRings',
        [...named].map((name) => ({
          name: `projects/${project}/locations/${location}/keyRings/${name}`,
        })),
        query,
      );
    }

    if (segments.length === 8 && keys === 'cryptoKeys') {
      const inRing = held.filter(
        (key) =>
          key.project === project &&
          key.location === location &&
          key.ring === ring,
      );
      return this.page(
        'cryptoKeys',
        inRing.map((key) => ({
          name: `projects/${project}/locations/${location}/keyRings/${ring}/cryptoKeys/${key.name}`,
          purpose: key.purpose ?? 'ASYMMETRIC_SIGN',
        })),
        query,
      );
    }

    return error(404, { message: 'no such route' });
  }

  /** One page of a listing, with the continuation the client has to follow. */
  private page(
    key: string,
    all: readonly unknown[],
    query: URLSearchParams,
  ): Response {
    const offset = Number(query.get('pageToken') ?? '0');
    const next = offset + this.pageSize;
    return Response.json({
      [key]: all.slice(offset, next),
      ...(next < all.length ? { nextPageToken: String(next) } : {}),
    });
  }
}

/** A configured blanket refusal, in the shape the real APIs answer with. */
function refusalOf(refusal: FakeRefusal | undefined): Response | null {
  if (refusal === undefined) return null;
  return error(refusal.status, {
    message: refusal.message ?? 'the caller may not act here',
    ...(refusal.reason === undefined ? {} : { reason: refusal.reason }),
    ...(refusal.consumer === undefined ? {} : { consumer: refusal.consumer }),
  });
}

function error(
  status: number,
  detail: { message: string; reason?: string; consumer?: string },
): Response {
  const info = {
    ...(detail.reason === undefined ? {} : { reason: detail.reason }),
    ...(detail.consumer === undefined
      ? {}
      : { metadata: { consumer: `projects/${detail.consumer}` } }),
  };
  return Response.json(
    {
      error: {
        code: status,
        message: detail.message,
        ...(Object.keys(info).length === 0 ? {} : { details: [info] }),
      },
    },
    { status },
  );
}
