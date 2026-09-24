/**
 * The Resource Manager, Cloud Storage and Cloud KMS APIs `GcpDiscovery` reads,
 * behind one `Fetcher` routed by host, as the client is given them.
 */
import type { Fetcher } from '../../../src/adapters/deploy/cloud/http.ts';

export interface FakeCryptoKey {
  readonly project: string;
  readonly location: string;
  readonly ring: string;
  readonly name: string;
  /** Defaults to `ASYMMETRIC_SIGN`; any other purpose must be filtered out. */
  readonly purpose?: string;
}

/** A refusal of everything one API is asked. */
export interface FakeRefusal {
  readonly status: number;
  /** `error.details[].reason`, such as `SERVICE_DISABLED`. */
  readonly reason?: string;
  /**
   * `error.details[].metadata.consumer`: the project the call bills, which may
   * differ from the one in the URL.
   */
  readonly consumer?: string;
  readonly message?: string;
}

export interface FakeGcpDiscoveryOptions {
  readonly token?: string;
  /** Project ids Resource Manager lists as active, in order. */
  readonly projects?: readonly string[];
  /** Listed as `DELETE_REQUESTED`. */
  readonly deletedProjects?: readonly string[];
  readonly buckets?: Readonly<Record<string, readonly string[]>>;
  readonly keyLocations?: Readonly<Record<string, readonly string[]>>;
  readonly keys?: readonly FakeCryptoKey[];
  /** Items per page; set it small to exercise the client's page loop. */
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

  /** `pageToken` is the offset of the next page. */
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
