/**
 * The Secret Manager store, one per project. Secret Manager versions secrets
 * itself, so a reference is the version resource.
 */
import { createHash } from 'node:crypto';
import type { StoreAdapter } from '../../config/manifest.schema.ts';
import type {
  ConfigScope,
  PinningStrategy,
  SecretReference,
  SecretStore,
  SecretVersion,
} from './contract.ts';
import { type StoreEndpoint, StoreHttp, StoreRequestError } from './http.ts';

/** One API host serves every project, so the manifest may omit the endpoint. */
export const DEFAULT_ENDPOINT = 'https://secretmanager.googleapis.com';

export interface SecretManagerStoreConfig extends StoreEndpoint {
  /** The home vessel's project, which holds every App's secrets. */
  readonly project: string;
}

/** The subset of a `Secret` this adapter reads. */
interface SecretResource {
  name: string;
  annotations?: Record<string, string>;
}

/** The subset of a `SecretVersion` this adapter reads. */
interface SecretVersionResource {
  /** `projects/{p}/secrets/{id}/versions/{n}`. */
  name: string;
  createTime: string;
  state: 'STATE_UNSPECIFIED' | 'ENABLED' | 'DISABLED' | 'DESTROYED';
}

interface ListVersionsResponse {
  versions?: SecretVersionResource[];
  nextPageToken?: string;
}

/** The `:access` response, the one read that carries a payload. */
interface AccessVersionResponse {
  payload?: { data?: string };
}

/**
 * The exact scope of each secret, so {@link SecretManagerStore.put} can refuse
 * two scopes that sanitize to one {@link secretId}.
 */
const ANNOTATION = {
  app: 'spindrift-app',
  component: 'spindrift-component',
  target: 'spindrift-target',
  key: 'spindrift-key',
} as const;

/** The ceiling `projects.secrets.create` puts on a secret id. */
const MAX_ID_LENGTH = 255;

/** Hex characters of scope digest a truncated id ends with. */
const DIGEST_LENGTH = 16;

/**
 * A legible secret id in `[A-Za-z0-9_-]{1,255}`. Four names and an unbounded key
 * can pass 255, so a long id ends in a digest of the unsanitized scope.
 */
function secretId(scope: ConfigScope, key: string): string {
  const sanitize = (part: string) => part.replace(/[^A-Za-z0-9_-]/g, '_');
  const parts = [scope.app, scope.component, scope.target, key];
  const legible = parts.map(sanitize).join('--');
  if (legible.length <= MAX_ID_LENGTH) return legible;

  const digest = createHash('sha256')
    .update(JSON.stringify(parts))
    .digest('hex')
    .slice(0, DIGEST_LENGTH);
  const head = legible.slice(0, MAX_ID_LENGTH - DIGEST_LENGTH - 2);
  return `${head}--${digest}`;
}

function versionNumber(name: string): string {
  const segments = name.split('/');
  return segments[segments.length - 1] ?? name;
}

export class SecretManagerStore implements SecretStore {
  readonly adapter: StoreAdapter = 'gcp-secret-manager';
  readonly pinning: PinningStrategy = 'NATIVE';

  private readonly http: StoreHttp;
  private readonly project: string;

  constructor(config: SecretManagerStoreConfig) {
    this.http = new StoreHttp(config);
    this.project = config.project;
  }

  async put(
    scope: ConfigScope,
    key: string,
    value: string,
  ): Promise<SecretReference> {
    const id = secretId(scope, key);
    const existing = await this.http.json<SecretResource>({
      method: 'GET',
      path: this.secretPath(id),
    });

    if (existing === null) {
      await this.http.json<SecretResource>({
        method: 'POST',
        path: `${this.parent()}/secrets?secretId=${encodeURIComponent(id)}`,
        body: {
          replication: { automatic: {} },
          annotations: {
            [ANNOTATION.app]: scope.app,
            [ANNOTATION.component]: scope.component,
            [ANNOTATION.target]: scope.target,
            [ANNOTATION.key]: key,
          },
        },
      });
    } else {
      assertScopeMatches(existing, scope, key, id);
    }

    const version = await this.http.json<SecretVersionResource>({
      method: 'POST',
      path: `${this.secretPath(id)}:addVersion`,
      // Secret Manager takes the payload base64-encoded.
      body: {
        payload: { data: Buffer.from(value, 'utf8').toString('base64') },
      },
    });

    if (version === null) {
      throw new Error(
        `secret ${id} disappeared between being created and being written to`,
      );
    }

    return { key: id, version: versionNumber(version.name) };
  }

  async describe(reference: SecretReference): Promise<SecretVersion | null> {
    const version = await this.http.json<SecretVersionResource>({
      method: 'GET',
      path: this.versionPath(reference.key, reference.version),
    });
    // A destroyed version still answers, with no payload left to deliver.
    if (version === null || version.state === 'DESTROYED') return null;

    const secret = await this.http.json<SecretResource>({
      method: 'GET',
      path: this.secretPath(reference.key),
    });
    const key = secret?.annotations?.[ANNOTATION.key];
    if (key === undefined) return null;

    return { reference, key, createdAt: new Date(version.createTime) };
  }

  /** Build dispatch only; see {@link SecretStore.open}. */
  async open(reference: SecretReference): Promise<string | null> {
    const version = await this.http.json<AccessVersionResponse>({
      method: 'GET',
      path: `${this.versionPath(reference.key, reference.version)}:access`,
    });
    const data = version?.payload?.data;
    if (data === undefined) return null;
    return Buffer.from(data, 'base64').toString('utf8');
  }

  async versions(scope: ConfigScope, key: string): Promise<SecretVersion[]> {
    const id = secretId(scope, key);
    const found: SecretVersion[] = [];
    let pageToken: string | undefined;

    // Every page, because core reaps from this list.
    do {
      const page: ListVersionsResponse | null = await this.http.json({
        method: 'GET',
        path:
          `${this.secretPath(id)}/versions` +
          (pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ''),
      });
      if (page === null) break;
      for (const version of page.versions ?? []) {
        if (version.state === 'DESTROYED') continue;
        found.push({
          reference: { key: id, version: versionNumber(version.name) },
          key,
          createdAt: new Date(version.createTime),
        });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);

    return found.sort(
      (a, b) => Number(b.reference.version) - Number(a.reference.version),
    );
  }

  /**
   * Destroy first and re-read on refusal: a read-first check races another reaper
   * pass. `FAILED_PRECONDITION` is success only if the version is destroyed or gone.
   */
  async destroy(reference: SecretReference): Promise<void> {
    try {
      // The transport answers a 404 with `null`, which is success here.
      await this.http.send({
        method: 'POST',
        path: `${this.versionPath(reference.key, reference.version)}:destroy`,
        body: {},
      });
    } catch (error) {
      if (!(error instanceof StoreRequestError)) throw error;
      const version = await this.http.json<SecretVersionResource>({
        method: 'GET',
        path: this.versionPath(reference.key, reference.version),
      });
      if (version !== null && version.state !== 'DESTROYED') throw error;
    }
  }

  private parent(): string {
    return `/v1/projects/${encodeURIComponent(this.project)}`;
  }

  private secretPath(id: string): string {
    return `${this.parent()}/secrets/${encodeURIComponent(id)}`;
  }

  private versionPath(id: string, version: string): string {
    return `${this.secretPath(id)}/versions/${encodeURIComponent(version)}`;
  }
}

/** Refuses a secret whose annotations name another scope, naming both. */
function assertScopeMatches(
  secret: SecretResource,
  scope: ConfigScope,
  key: string,
  id: string,
): void {
  const annotations = secret.annotations ?? {};
  const owner = {
    app: annotations[ANNOTATION.app],
    component: annotations[ANNOTATION.component],
    target: annotations[ANNOTATION.target],
    key: annotations[ANNOTATION.key],
  };
  const matches =
    owner.app === scope.app &&
    owner.component === scope.component &&
    owner.target === scope.target &&
    owner.key === key;

  if (!matches) {
    throw new Error(
      `secret ${id} belongs to ${JSON.stringify(owner)}, not to ` +
        `${JSON.stringify({ ...scope, key })}`,
    );
  }
}

export { secretId as secretIdFor };
