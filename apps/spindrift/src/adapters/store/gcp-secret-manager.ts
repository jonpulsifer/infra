/**
 * The cloud store: Secret Manager (§10).
 *
 * §10: "the cloud Targets take the cloud store in the App's vessel, not a
 * choice." The project is therefore configuration, not a literal — an App's
 * vessel selects it (§14) — and this adapter is constructed per project.
 *
 * This is the `NATIVE` half of §10's pinning claim. Secret Manager versions
 * items itself and a version is addressable
 * (`projects/…/secrets/…/versions/7`), so a reference here is the version
 * resource and nothing has to be minted to make it immutable. The conformance
 * suite runs the same assertions against this and against the 1Password store,
 * which is the whole point of shipping two: §10 says the reference `put` returns
 * "has the same shape either way, and nothing above the seam can tell which
 * strategy produced it", and one implementation could not have falsified that.
 *
 * **Two things this adapter does not do**, both because §10 forbids them:
 *
 * - It never reads a payload back. `accessSecretVersion` exists on the far side
 *   and is not called anywhere here — values are write-only, so the read-back is
 *   `getSecretVersion`, which returns metadata only.
 * - It never reuses a version. `addVersion` is the only write, so a put is
 *   always a new version rather than an edit of one.
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

/** Which project's Secret Manager this adapter writes to. */
export interface SecretManagerStoreConfig extends StoreEndpoint {
  /** The vessel's project holding this installation's App secrets (§14). */
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

/**
 * The annotations every secret this adapter creates carries.
 *
 * They are the authority on what a secret is for; {@link secretId} below is only
 * a legible name. Keeping the scope here rather than parsing it back out of the
 * id is what lets {@link SecretManagerStore.put} detect the one hazard the
 * naming scheme has — two distinct scopes sanitizing to the same id — and refuse
 * loudly instead of silently sharing a secret between two Components.
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
 * A Secret Manager secret id: `[A-Za-z0-9_-]{1,255}`.
 *
 * Every character outside that alphabet becomes `_`, which is lossy on purpose —
 * the id is for a human reading the console, and {@link ANNOTATION} carries the
 * exact scope. `--` separates the four parts because a sanitized part can
 * contain a single `-` (App and Component names are DNS labels) but the pair is
 * only ever what this function put there.
 *
 * **The ceiling is the alphabet's other half and is enforced here.** App,
 * Component and Target names are DNS labels of up to 63 characters each and a
 * variable name has no ceiling at all, so four parts and three separators clear
 * 255 without anything unreasonable happening — and the API refuses the create,
 * not the character that pushed it over.
 *
 * Truncating alone would widen the one hazard this scheme already carries: two
 * distinct scopes landing on one id, which is what {@link assertScopeMatches}
 * exists to catch. So an id over the ceiling gives up the last
 * {@link DIGEST_LENGTH} characters of legibility to a digest of the **exact,
 * unsanitized** scope. Two long scopes now need both a shared prefix and a
 * 64-bit digest collision to meet, where sanitizing alone needed only a flatten
 * — so the truncated form separates strictly more pairs than the sanitized one,
 * which is what keeps this from trading a length bug for a collision bug.
 * `assertScopeMatches` still stands behind it: a digest is a legibility aid,
 * not a proof.
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

/** The version number out of a version resource name. */
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
      // Secret Manager takes the payload base64-encoded. This is the only
      // plaintext that crosses the seam, and it crosses in one direction (§10).
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
    // A destroyed version still answers, with its payload gone. §10's read-back
    // proves a pinned document "still resolves", and one that cannot be
    // delivered does not — so it reports absent, like a version that was purged.
    if (version === null || version.state === 'DESTROYED') return null;

    const secret = await this.http.json<SecretResource>({
      method: 'GET',
      path: this.secretPath(reference.key),
    });
    const key = secret?.annotations?.[ANNOTATION.key];
    if (key === undefined) return null;

    return { reference, key, createdAt: new Date(version.createTime) };
  }

  async versions(scope: ConfigScope, key: string): Promise<SecretVersion[]> {
    const id = secretId(scope, key);
    const found: SecretVersion[] = [];
    let pageToken: string | undefined;

    // Paginated because a key that has been rotated past the retention reaper
    // more than a page's worth of times would otherwise report only its newest
    // versions, and core reaps from exactly this list (§10).
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
   * Idempotent, which this API is not.
   *
   * `destroy` on a version that is already destroyed answers
   * `FAILED_PRECONDITION`, so idempotence has to be reconciled here rather than
   * assumed. Asking first would still lose a race between two reaper passes, so
   * the order is the other way round: attempt it, and accept the refusal only
   * once the far side confirms the version is in the state that was wanted.
   */
  async destroy(reference: SecretReference): Promise<void> {
    try {
      // A 404 is `null` from the transport — a version that is gone entirely is
      // already the outcome this verb promises.
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

/**
 * Refuse a secret whose annotations name a different scope.
 *
 * This is the one hazard {@link secretId} carries: two scopes that differ only
 * in a character sanitization flattens land on the same id. Writing anyway would
 * put one Component's value where another Component reads, which is the worst
 * outcome available here — so it fails loudly, naming both scopes.
 */
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
