/**
 * The edge platform's own environment variables, as a store of record (§10).
 *
 * **Why the platform is the store rather than a place config is copied to.**
 * Every other Target resolves a *reference* at runtime — Cloud Run renders a
 * `secretKeyRef`, the cluster renders a `secretKeyRef` — which is what lets
 * §10's "values are write-only" hold end to end: core writes a value once and
 * afterwards only ever handles the reference to it. This platform has no such
 * mechanism. Its functions read environment variables, and an environment
 * variable is a literal. So there is no delivery document a value could be
 * referenced from, and the only way config reaches a function is for the
 * platform to be holding it.
 *
 * That is not a weakening of §10, it is §10's own shape: "a store is its store
 * of record plus one or more access paths". Here the store of record is the
 * project's environment, and the access path is the platform's API. Nothing
 * copies anything — `put` is still the one direction plaintext travels, and
 * nothing above this seam can read a value back, because {@link SecretStore}
 * still has no verb that would.
 *
 * **Written `sensitive`, which is write-only on the far side too.** The
 * platform offers `plain`, `encrypted` and `sensitive`; only the last is one
 * its own API and dashboard refuse to hand back. Choosing it means a leaked
 * platform token reads no config, and it means the property §10 asserts about
 * Spindrift is also true of the thing Spindrift wrote to.
 *
 * **The cost, stated once here and declared in {@link pinning}.** An
 * environment variable's name is the runtime's own namespace: a function reads
 * `DATABASE_URL`, so the item holding it must be called `DATABASE_URL`, and the
 * platform allows one of those per project and target. There is no
 * Spindrift-side name a superseded version could live under — the two other
 * strategies both depend on there being one — so a put supersedes rather than
 * accumulates. `CURRENT_ONLY` is that fact, and the contract's own commentary
 * carries what it costs: a rollback past a config change is refused rather than
 * deployed bare, because `placeIntent` proves every pinned reference still
 * resolves before writing an intent.
 */
import type { StoreAdapter } from '../../config/manifest.schema.ts';
import { vercelProjectName } from '../../domain/vercel-project.ts';
import type {
  ConfigScope,
  PinningStrategy,
  SecretReference,
  SecretStore,
  SecretVersion,
} from './contract.ts';
import { type StoreEndpoint, StoreHttp } from './http.ts';

/** Where the platform is reached and which team's projects are addressed. */
export interface VercelStoreConfig extends StoreEndpoint {
  /**
   * The team whose projects hold this installation's config.
   *
   * The same team the deploy adapter's Targets name. §14 does not create one,
   * so this is configuration rather than something the adapter provisions.
   */
  readonly team: string;
}

/**
 * The environment a Component's functions actually run in.
 *
 * Production only, and deliberately: §10 has no Environment noun in v1, so
 * there is exactly one set of values per (Component, Target) and writing them
 * to `preview` as well would create a second one nothing addresses.
 */
const TARGET = ['production'] as const;

/**
 * The one type whose value the platform will not hand back.
 *
 * `plain` is readable by anyone who can read the project and `encrypted` is
 * decrypted by the API on request; only this one is write-only on the far side,
 * which is the property this store exists to preserve.
 */
const SENSITIVE = 'sensitive';

/** One environment variable, as much of it as this adapter reads. */
interface EnvironmentVariable {
  readonly id?: string;
  readonly key?: string;
  readonly createdAt?: number;
}

/** What a list of them answers with. */
interface EnvironmentList {
  readonly envs?: readonly EnvironmentVariable[];
}

/** What a create answers with. */
interface CreatedEnvironment {
  readonly created?: EnvironmentVariable;
}

export class VercelSecretStore implements SecretStore {
  readonly adapter: StoreAdapter = 'vercel';
  /** See the module comment: the name is the runtime's, so there is one. */
  readonly pinning: PinningStrategy = 'CURRENT_ONLY';

  private readonly http: StoreHttp;

  constructor(private readonly config: VercelStoreConfig) {
    this.http = new StoreHttp(config);
  }

  /**
   * Write a value and return the reference to the version just written.
   *
   * Delete-then-create rather than the platform's own `upsert`, and the
   * difference is the whole of §10's pinning here. An upsert keeps the
   * variable's id, so two different values would share one reference and a
   * Deploy pinned to the first would silently be pinned to the second — which
   * is the floating latest §10 forbids. A create mints a new id, so a config
   * change produces a reference that is not equal to the one before it, and
   * every Deploy carrying the old one is now describably stale.
   */
  async put(
    scope: ConfigScope,
    key: string,
    value: string,
  ): Promise<SecretReference> {
    const project = vercelProjectName(scope);
    await this.ensureProject(project);

    // Whatever is there now, gone first: the platform answers `403` to a create
    // whose key already exists, and tolerating that would leave the old value
    // live under the old reference.
    const existing = await this.find(project, key);
    if (existing?.id !== undefined) await this.remove(project, existing.id);

    const created = await this.http.json<CreatedEnvironment>({
      method: 'POST',
      path: this.path(`/v10/projects/${encodeURIComponent(project)}/env`),
      body: { key, value, type: SENSITIVE, target: [...TARGET] },
    });
    const id = created?.created?.id;
    if (id === undefined) {
      throw new Error(
        `the platform created no environment variable for ${key} on ${project}`,
      );
    }
    return { key: itemName(project, key), version: id };
  }

  /**
   * Metadata for a pinned reference, or `null` when it is gone.
   *
   * `null` is the ordinary answer for a superseded version here rather than the
   * exceptional one — see {@link pinning} — and it is what makes a rollback
   * past a config change refuse instead of coming up without its config.
   */
  async describe(reference: SecretReference): Promise<SecretVersion | null> {
    const parsed = parseItemName(reference.key);
    if (parsed === null) return null;

    // Listed and matched by id rather than fetched by id: the platform's
    // read-one endpoint decrypts, and asking for a value this adapter has no
    // business holding — even to throw it away — is a request worth not making.
    const listed = await this.http.json<EnvironmentList>({
      method: 'GET',
      path: this.path(`/v9/projects/${encodeURIComponent(parsed.project)}/env`),
    });
    const found = listed?.envs?.find((one) => one.id === reference.version);
    if (found === undefined) return null;

    return {
      reference,
      key: found.key ?? parsed.key,
      createdAt: new Date(found.createdAt ?? 0),
    };
  }

  /**
   * Every version Spindrift has written for one key, newest first.
   *
   * At most one, always. §10's retention reaps from this list and finds nothing
   * to reap, which is the honest answer rather than a gap: the version before
   * the current one stopped existing when the current one was written.
   */
  async versions(scope: ConfigScope, key: string): Promise<SecretVersion[]> {
    const project = vercelProjectName(scope);
    const found = await this.find(project, key);
    if (found?.id === undefined) return [];
    return [
      {
        reference: { key: itemName(project, key), version: found.id },
        key,
        createdAt: new Date(found.createdAt ?? 0),
      },
    ];
  }

  /** Idempotent: destroying a version that is already gone succeeds. */
  async destroy(reference: SecretReference): Promise<void> {
    const parsed = parseItemName(reference.key);
    if (parsed === null) return;
    await this.remove(parsed.project, reference.version);
  }

  // --- plumbing ------------------------------------------------------------

  /**
   * Make sure the project exists, because config can be set before anything is
   * deployed.
   *
   * The deploy adapter creates the project as a side effect of its first
   * deployment, which is fine for it and useless here: §10 lets a developer
   * configure a Component the moment it is placed, and that is routinely before
   * a Build has finished. So this creates it too, idempotently. Both are
   * creating the same name — `vercelProjectName` — so whichever runs first
   * wins and the other finds it there.
   */
  private async ensureProject(project: string): Promise<void> {
    const existing = await this.http.json<unknown>({
      method: 'GET',
      path: this.path(`/v9/projects/${encodeURIComponent(project)}`),
    });
    if (existing !== null) return;
    await this.http.send({
      method: 'POST',
      path: this.path('/v9/projects'),
      body: { name: project },
    });
  }

  /** The variable with this name on this project, or `undefined`. */
  private async find(
    project: string,
    key: string,
  ): Promise<EnvironmentVariable | undefined> {
    const listed = await this.http.json<EnvironmentList>({
      method: 'GET',
      path: this.path(`/v9/projects/${encodeURIComponent(project)}/env`),
    });
    return listed?.envs?.find((one) => one.key === key);
  }

  /** Delete one by id. A `404` is success, which `StoreHttp` already makes so. */
  private async remove(project: string, id: string): Promise<void> {
    await this.http.send({
      method: 'DELETE',
      path: this.path(
        `/v9/projects/${encodeURIComponent(project)}/env/${encodeURIComponent(id)}`,
      ),
    });
  }

  /** Every call is made on behalf of the team; none of them may omit it. */
  private path(path: string): string {
    return `${path}${path.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(this.config.team)}`;
  }
}

/**
 * The store's own name for an item: the project it lives on and the variable it
 * fills.
 *
 * `SecretReference.key` is "the store's own name for the item", and here that
 * has to carry the project — {@link VercelSecretStore.describe} is handed a
 * reference and nothing else, and a variable name alone does not say which of
 * an installation's projects to look on. The same split the 1Password store
 * makes between an item's title and the field label it reads back.
 *
 * A slash, because a project name cannot contain one and a variable name cannot
 * either, so the first one is unambiguous.
 */
function itemName(project: string, key: string): string {
  return `${project}/${key}`;
}

/** The two halves back out, or `null` for a reference this store did not mint. */
function parseItemName(
  name: string,
): { readonly project: string; readonly key: string } | null {
  const slash = name.indexOf('/');
  if (slash <= 0 || slash === name.length - 1) return null;
  return { project: name.slice(0, slash), key: name.slice(slash + 1) };
}
