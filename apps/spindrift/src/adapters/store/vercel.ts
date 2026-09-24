/**
 * Vercel project environment variables as a store of record. Functions read
 * config as literal environment variables, so the platform must hold the value.
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

export interface VercelStoreConfig extends StoreEndpoint {
  readonly team: string;
}

/** One value set per Component and Target, so only production is written. */
const TARGET = ['production'] as const;

/**
 * The only type whose value the platform's API never returns, so a leaked token
 * reads no config.
 */
const SENSITIVE = 'sensitive';

interface EnvironmentVariable {
  readonly id?: string;
  readonly key?: string;
  /** Milliseconds since the epoch. */
  readonly createdAt?: number;
}

interface EnvironmentList {
  readonly envs?: readonly EnvironmentVariable[];
}

interface CreatedEnvironment {
  readonly created?: EnvironmentVariable;
}

export class VercelSecretStore implements SecretStore {
  readonly adapter: StoreAdapter = 'vercel';
  /** A function reads its variable by name, so only one version can exist. */
  readonly pinning: PinningStrategy = 'CURRENT_ONLY';

  private readonly http: StoreHttp;

  constructor(private readonly config: VercelStoreConfig) {
    this.http = new StoreHttp(config);
  }

  /**
   * Delete then create: an upsert keeps the variable's id, so a Deploy pinned
   * to the old value would silently get the new one.
   */
  async put(
    scope: ConfigScope,
    key: string,
    value: string,
  ): Promise<SecretReference> {
    const project = vercelProjectName(scope);
    await this.ensureProject(project);

    // The platform answers 403 to a create whose key already exists.
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

  /** `null` for any superseded version: a put deletes the one before it. */
  async describe(reference: SecretReference): Promise<SecretVersion | null> {
    const parsed = parseItemName(reference.key);
    if (parsed === null) return null;

    // The read-one endpoint returns the decrypted value, so search the list.
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

  /** At most one: a put deletes the version before it. */
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

  /** Idempotent: a missing variable is a success. */
  async destroy(reference: SecretReference): Promise<void> {
    const parsed = parseItemName(reference.key);
    if (parsed === null) return;
    await this.remove(parsed.project, reference.version);
  }

  /**
   * Config can be set before the first deploy creates the project. Both
   * adapters name it with {@link vercelProjectName}; whichever runs first wins.
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

  private async remove(project: string, id: string): Promise<void> {
    await this.http.send({
      method: 'DELETE',
      path: this.path(
        `/v9/projects/${encodeURIComponent(project)}/env/${encodeURIComponent(id)}`,
      ),
    });
  }

  /** Appends the `teamId` every call must carry. */
  private path(path: string): string {
    return `${path}${path.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(this.config.team)}`;
  }
}

/**
 * `project/key`, because `describe` gets only the reference and must know the
 * project. Neither a project name nor a variable name can contain a slash.
 */
function itemName(project: string, key: string): string {
  return `${project}/${key}`;
}

/** `null` for a reference this store did not mint. */
function parseItemName(
  name: string,
): { readonly project: string; readonly key: string } | null {
  const slash = name.indexOf('/');
  if (slash <= 0 || slash === name.length - 1) return null;
  return { project: name.slice(0, slash), key: name.slice(slash + 1) };
}
