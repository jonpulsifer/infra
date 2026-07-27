/**
 * A fake Secret Manager (Task 10, § Seam 2).
 *
 * The far-side HTTP API behind the real client, per § Seam 2 — so the
 * conformance suite exercises `SecretManagerStore`'s real resource names, its
 * real base64 payload, and its real pagination loop.
 *
 * Three behaviours here are modelled because the adapter has to survive them,
 * not because they are decoration:
 *
 * - **Versions are numbered by the far side**, starting at 1 per secret. That is
 *   what makes this the `NATIVE` pinning strategy: nothing is minted by
 *   Spindrift to make a reference immutable.
 * - **Destroying an already-destroyed version fails**, as the real API does with
 *   a `FAILED_PRECONDITION`. The contract still requires `destroy` to be
 *   idempotent, so the adapter has to reconcile the two — and would pass a
 *   permissive fake without doing so.
 * - **Listing is paginated**, at a deliberately tiny page, because core reaps
 *   config from that list and a single-page fake would never run the loop.
 */
import type { Fetcher } from '../../../src/adapters/store/http.ts';

type VersionState = 'ENABLED' | 'DESTROYED';

interface StoredVersion {
  number: number;
  createTime: string;
  state: VersionState;
  /** Held so a test can prove what was written; never returned by the API. */
  payload: string;
}

interface StoredSecret {
  id: string;
  annotations: Record<string, string>;
  versions: StoredVersion[];
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

export interface FakeSecretManagerOptions {
  /** The project this API serves. Any other answers `404`. */
  project?: string;
  token?: string;
  /** Versions per page. Small on purpose, to run the adapter's page loop. */
  pageSize?: number;
}

const BASE = 'https://secretmanager.invalid';

export class FakeSecretManager {
  readonly project: string;
  readonly requests: RecordedRequest[] = [];

  private readonly token: string;
  private readonly pageSize: number;
  private readonly secrets = new Map<string, StoredSecret>();
  private clock = 0;

  constructor(options: FakeSecretManagerOptions = {}) {
    this.project = options.project ?? 'vessel-project';
    this.token = options.token ?? 'federated-token';
    this.pageSize = options.pageSize ?? 2;
  }

  get baseUrl(): string {
    return BASE;
  }

  /** How many secrets exist — the far side's own view, for a test. */
  get secretCount(): number {
    return this.secrets.size;
  }

  /** The annotations a secret carries, or `null`. */
  annotationsOf(id: string): Record<string, string> | null {
    return this.secrets.get(id)?.annotations ?? null;
  }

  /** What was written, decoded. Never reachable through the contract. */
  payloadOf(id: string, version: string): string | null {
    const stored = this.secrets
      .get(id)
      ?.versions.find((candidate) => String(candidate.number) === version);
    if (!stored) return null;
    return Buffer.from(stored.payload, 'base64').toString('utf8');
  }

  /** Seed a secret this adapter did not create — for the collision refusal. */
  seedSecret(id: string, annotations: Record<string, string>): void {
    this.secrets.set(id, { id, annotations, versions: [] });
  }

  readonly fetch: Fetcher = async (request) => {
    const url = new URL(request.url);
    const body =
      request.method === 'GET' ? undefined : await request.clone().json();
    this.requests.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      body,
    });

    if (request.headers.get('Authorization') !== `Bearer ${this.token}`) {
      return json({ error: { message: 'unauthorized' } }, 401);
    }

    const segments = url.pathname.split('/').filter(Boolean);
    if (
      segments[0] !== 'v1' ||
      segments[1] !== 'projects' ||
      segments[3] !== 'secrets'
    ) {
      return json({ error: { message: 'no such route' } }, 404);
    }
    if (segments[2] !== this.project) {
      return json({ error: { message: 'no such project' } }, 404);
    }

    // The API puts custom verbs on the end of a resource name, so the last
    // segment carries at most one `:verb` suffix.
    const tail = segments[segments.length - 1] ?? '';
    const colon = tail.indexOf(':');
    const verb = colon === -1 ? null : tail.slice(colon + 1);
    const resource = colon === -1 ? tail : tail.slice(0, colon);
    const path = [...segments.slice(0, -1), resource];

    // /v1/projects/{p}/secrets
    if (path.length === 4) {
      if (request.method !== 'POST') {
        return json({ error: { message: 'method not allowed' } }, 405);
      }
      return this.createSecret(url.searchParams.get('secretId'), body);
    }

    const id = path[4];
    if (id === undefined || id === '') {
      return json({ error: { message: 'no such route' } }, 404);
    }

    // /v1/projects/{p}/secrets/{id}[:addVersion]
    if (path.length === 5) {
      if (verb === 'addVersion') return this.addVersion(id, body);
      if (verb === null && request.method === 'GET') return this.getSecret(id);
      return json({ error: { message: 'no such route' } }, 404);
    }

    if (path[5] !== 'versions') {
      return json({ error: { message: 'no such route' } }, 404);
    }

    // /v1/projects/{p}/secrets/{id}/versions
    if (path.length === 6) {
      if (request.method !== 'GET') {
        return json({ error: { message: 'method not allowed' } }, 405);
      }
      return this.listVersions(id, url.searchParams.get('pageToken'));
    }

    // /v1/projects/{p}/secrets/{id}/versions/{n}[:destroy]
    if (path.length === 7) {
      const number = path[6] ?? '';
      if (verb === 'destroy') return this.destroyVersion(id, number);
      if (verb === null && request.method === 'GET') {
        return this.getVersion(id, number);
      }
    }
    return json({ error: { message: 'no such route' } }, 404);
  };

  private createSecret(id: string | null, body: unknown): Response {
    if (!id) return json({ error: { message: 'secretId is required' } }, 400);
    if (this.secrets.has(id)) {
      return json({ error: { message: 'already exists' } }, 409);
    }
    const requested = body as { annotations?: Record<string, string> };
    const secret: StoredSecret = {
      id,
      annotations: requested?.annotations ?? {},
      versions: [],
    };
    this.secrets.set(id, secret);
    return json(this.renderSecret(secret), 200);
  }

  private getSecret(id: string): Response {
    const secret = this.secrets.get(id);
    if (!secret) return json({ error: { message: 'no such secret' } }, 404);
    return json(this.renderSecret(secret), 200);
  }

  private addVersion(id: string, body: unknown): Response {
    const secret = this.secrets.get(id);
    if (!secret) return json({ error: { message: 'no such secret' } }, 404);
    const payload = (body as { payload?: { data?: string } })?.payload?.data;
    if (typeof payload !== 'string') {
      return json({ error: { message: 'payload.data is required' } }, 400);
    }
    this.clock += 1;
    const version: StoredVersion = {
      number: secret.versions.length + 1,
      createTime: new Date(Date.UTC(2024, 0, 1, 0, this.clock)).toISOString(),
      state: 'ENABLED',
      payload,
    };
    secret.versions.push(version);
    return json(this.renderVersion(id, version), 200);
  }

  private listVersions(id: string, pageToken: string | null): Response {
    const secret = this.secrets.get(id);
    if (!secret) return json({ error: { message: 'no such secret' } }, 404);
    // Newest first, as the real API lists them.
    const ordered = [...secret.versions].sort((a, b) => b.number - a.number);
    const offset = pageToken ? Number(pageToken) : 0;
    const page = ordered.slice(offset, offset + this.pageSize);
    const next = offset + this.pageSize;
    return json(
      {
        versions: page.map((version) => this.renderVersion(id, version)),
        ...(next < ordered.length ? { nextPageToken: String(next) } : {}),
      },
      200,
    );
  }

  private getVersion(id: string, number: string): Response {
    const version = this.secrets
      .get(id)
      ?.versions.find((candidate) => String(candidate.number) === number);
    if (!version) return json({ error: { message: 'no such version' } }, 404);
    return json(this.renderVersion(id, version), 200);
  }

  private destroyVersion(id: string, number: string): Response {
    const version = this.secrets
      .get(id)
      ?.versions.find((candidate) => String(candidate.number) === number);
    if (!version) return json({ error: { message: 'no such version' } }, 404);
    if (version.state === 'DESTROYED') {
      return json(
        {
          error: {
            status: 'FAILED_PRECONDITION',
            message: 'already destroyed',
          },
        },
        400,
      );
    }
    version.state = 'DESTROYED';
    version.payload = '';
    return json(this.renderVersion(id, version), 200);
  }

  private renderSecret(secret: StoredSecret) {
    return {
      name: `projects/${this.project}/secrets/${secret.id}`,
      annotations: secret.annotations,
    };
  }

  private renderVersion(id: string, version: StoredVersion) {
    return {
      name: `projects/${this.project}/secrets/${id}/versions/${version.number}`,
      createTime: version.createTime,
      state: version.state,
    };
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
