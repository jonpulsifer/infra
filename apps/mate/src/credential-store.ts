/**
 * pi-ai's `CredentialStore` over mate-db's `mate_credentials`: a write-through
 * cache with mate as its only writer. It holds the ChatGPT sign-in.
 */
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from '@earendil-works/pi-ai';
import { type Clock, type Handle, systemClock } from './clock.ts';
import type { Log } from './log.ts';
import type { Instruments } from './metrics.ts';
import type { Database } from './store.ts';

/** A stored credential owns its provider in pi, so one here would override the key file. */
export const KEY_FILE_PROVIDERS: ReadonlySet<string> = new Set(['opencode-go']);
/** Waits between the tries of one write before it is kept in memory as unsaved. */
export const WRITE_RETRY_MS: readonly number[] = [1_000, 2_000, 4_000];
export const UNSAVED_RETRY_MS = 30_000;

/** mate-db cannot be read, which is not the same as holding no credential. */
export class StoreUnavailable extends Error {
  override readonly name = 'StoreUnavailable';
}

/** What a listener learns of a write: never the credential itself. */
export interface CredentialChange {
  readonly providerId: string;
  readonly stored: boolean;
  /** The OAuth token's expiry, in epoch ms; null for none. */
  readonly expires: number | null;
}

export interface PostgresCredentialStoreOptions {
  readonly db: Pick<Database, 'sql' | 'up'>;
  readonly log: Log;
  readonly clock?: Clock;
  readonly metrics?: Pick<Instruments, 'storeFailed'>;
  readonly retryMs?: readonly number[];
  readonly unsavedRetryMs?: number;
}

interface Row {
  provider: string;
  credential: string;
}

export class PostgresCredentialStore implements CredentialStore {
  private readonly cache = new Map<string, Credential>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly unsaved = new Set<string>();
  private readonly listeners = new Set<(change: CredentialChange) => void>();
  private readonly clock: Clock;
  private loaded = false;
  private loading: Promise<void> | null = null;
  private retry: Handle | null = null;
  private closed = false;

  constructor(private readonly options: PostgresCredentialStoreOptions) {
    this.clock = options.clock ?? systemClock;
  }

  async read(
    providerId: string,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    await this.load();
    return this.cache.get(providerId);
  }

  async list(options?: AuthOperationOptions): Promise<CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    await this.load();
    return [...this.cache].map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    if (KEY_FILE_PROVIDERS.has(providerId)) {
      return Promise.reject(
        new Error(`mate stores no ${providerId} credential; its key is a file`),
      );
    }
    if (this.closed) return Promise.reject(closedError());
    return this.enqueue(
      providerId,
      async () => {
        await this.load();
        const current = this.cache.get(providerId);
        const next = await fn(current);
        if (next === undefined) return current;
        // Kept even when the caller has stopped waiting: a refresh has already
        // rotated the token at the provider, and the old one is spent.
        this.cache.set(providerId, next);
        this.emit(providerId, next);
        await this.save(providerId, next);
        return next;
      },
      options,
    );
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    if (this.closed) return Promise.reject(closedError());
    return this.enqueue(
      providerId,
      async () => {
        await this.load();
        const sql = this.sql();
        try {
          await sql`DELETE FROM mate_credentials WHERE provider = ${providerId}`;
        } catch (error) {
          this.options.metrics?.storeFailed('credentials');
          throw unavailable('delete', providerId, error);
        }
        this.unsaved.delete(providerId);
        if (this.cache.delete(providerId)) this.emit(providerId, undefined);
      },
      options,
    );
  }

  onChange(listener: (change: CredentialChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Refuses new writes and waits for those already running, since a refresh
   * in flight has spent the old token at OpenAI. Then one last try saves what
   * is unsaved.
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.retry) this.clock.cancel(this.retry);
    this.retry = null;
    await Promise.allSettled([...this.chains.values()]);
    await this.flush();
    if (this.unsaved.size > 0) {
      this.options.log.error('mate stops with a credential it could not save', {
        providers: [...this.unsaved],
      });
    }
  }

  private sql(): NonNullable<Database['sql']> {
    const { sql, up } = this.options.db;
    if (!sql || !up()) throw new StoreUnavailable('mate-db is not up');
    return sql;
  }

  private load(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    this.loading ??= this.fetch().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async fetch(): Promise<void> {
    const sql = this.sql();
    let rows: Row[];
    try {
      rows = await sql`SELECT provider, credential FROM mate_credentials`;
    } catch (error) {
      this.options.metrics?.storeFailed('credentials');
      throw unavailable('read', null, error);
    }
    if (this.loaded) return;
    for (const row of rows) {
      const credential = parse(row.credential);
      if (credential) this.cache.set(row.provider, credential);
      else {
        this.options.log.warn('a stored credential does not parse; ignored', {
          provider: row.provider,
        });
      }
    }
    this.loaded = true;
  }

  /** Tries the write a few times, then keeps it unsaved and retries it on a timer. */
  private async save(providerId: string, credential: Credential) {
    const waits = this.options.retryMs ?? WRITE_RETRY_MS;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.upsert(providerId, credential);
        this.unsaved.delete(providerId);
        return;
      } catch (error) {
        this.options.metrics?.storeFailed('credentials');
        const wait = waits[attempt];
        if (wait === undefined) {
          this.unsaved.add(providerId);
          this.options.log.error(
            'a credential could not be saved; mate keeps it in memory and retries',
            { provider: providerId, error: failure(error) },
          );
          this.schedule();
          return;
        }
        await this.clock.sleep(wait);
      }
    }
  }

  private async upsert(providerId: string, credential: Credential) {
    const sql = this.sql();
    await sql`
      INSERT INTO mate_credentials (provider, credential, updated_at)
      VALUES (${providerId}, ${JSON.stringify(credential)}, ${this.clock.now()})
      ON CONFLICT (provider) DO UPDATE
        SET credential = EXCLUDED.credential, updated_at = EXCLUDED.updated_at
    `;
  }

  private schedule(): void {
    if (this.closed || this.retry) return;
    this.retry = this.clock.after(
      this.options.unsavedRetryMs ?? UNSAVED_RETRY_MS,
      () => {
        this.retry = null;
        void this.flush();
      },
    );
  }

  /** Each unsaved credential, written as it stands now, on its provider's chain. */
  private async flush(): Promise<void> {
    await Promise.allSettled(
      [...this.unsaved].map((providerId) =>
        this.enqueue(providerId, async () => {
          const credential = this.cache.get(providerId);
          if (!this.unsaved.has(providerId) || !credential) {
            this.unsaved.delete(providerId);
            return;
          }
          try {
            await this.upsert(providerId, credential);
          } catch {
            this.options.metrics?.storeFailed('credentials');
            return;
          }
          this.unsaved.delete(providerId);
          this.options.log.info('an unsaved credential is saved', {
            provider: providerId,
          });
        }),
      ),
    );
    if (this.unsaved.size > 0) this.schedule();
  }

  /**
   * One task at a time per provider. The caller's signal stops only its wait:
   * a task that has started runs to the end.
   */
  private enqueue<T>(
    providerId: string,
    task: () => Promise<T>,
    options?: AuthOperationOptions,
  ): Promise<T> {
    const signal = options?.signal;
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const queued = (async () => {
      await previous;
      signal?.throwIfAborted();
      return task();
    })();
    const tail = queued.then(
      () => {},
      () => {},
    );
    this.chains.set(providerId, tail);
    void tail.then(() => {
      if (this.chains.get(providerId) === tail) this.chains.delete(providerId);
    });
    return raceAbort(queued, signal);
  }

  private emit(providerId: string, credential: Credential | undefined): void {
    const change: CredentialChange = {
      providerId,
      stored: credential !== undefined,
      expires: credential?.type === 'oauth' ? credential.expires : null,
    };
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (error) {
        this.options.log.warn('a credential listener threw', {
          provider: providerId,
          error: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
  }
}

function raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
    if (signal.aborted) onAbort();
  });
}

function parse(text: string): Credential | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const fields = value as Record<string, unknown>;
  if (
    fields.type === 'oauth' &&
    typeof fields.access === 'string' &&
    typeof fields.refresh === 'string' &&
    typeof fields.expires === 'number'
  ) {
    return value as Credential;
  }
  return fields.type === 'api_key' ? (value as Credential) : null;
}

function field(error: unknown, key: string): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

/** The error's class and codes alone: a driver message can quote a value. */
function failure(error: unknown): string {
  if (error instanceof StoreUnavailable) return error.message;
  const codes = [field(error, 'errno'), field(error, 'code')].filter(Boolean);
  const name = error instanceof Error ? error.name : 'unknown error';
  return codes.length > 0 ? `${name} (${codes.join(', ')})` : name;
}

function closedError(): StoreUnavailable {
  return new StoreUnavailable('the credential store is closed');
}

function unavailable(
  op: 'read' | 'delete',
  providerId: string | null,
  error: unknown,
): StoreUnavailable {
  const what = providerId ? `the ${providerId} credential` : 'the credentials';
  return new StoreUnavailable(
    `mate-db failed the ${op} of ${what}: ${failure(error)}`,
  );
}
