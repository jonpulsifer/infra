/** The ChatGPT sign-in in mate-db: pi's CredentialStore contract, and what survives a failed write. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Credential } from '@earendil-works/pi-ai';
import {
  type CredentialChange,
  PostgresCredentialStore,
  StoreUnavailable,
  UNSAVED_RETRY_MS,
  WRITE_RETRY_MS,
} from '../src/credential-store.ts';
import { MIGRATIONS } from '../src/store.ts';
import { withDatabase } from './db.ts';
import {
  FakeClock,
  RecordingInstruments,
  RecordingLog,
  settle,
} from './support.ts';

const database = withDatabase();
const CODEX = 'openai-codex';
const ACCESS = 'eyJhbGciOiJub25lIn0.ACCESS-SECRET-0123456789abcdef.sig';
const REFRESH = 'rt_REFRESH-SECRET-0123456789abcdefghijklmnop';

function credential(n: number, expires = 1_800_000_000_000): Credential {
  return {
    type: 'oauth',
    access: `${ACCESS}-${n}`,
    refresh: `${REFRESH}-${n}`,
    expires,
    accountId: 'acct-1',
  };
}

let clock: FakeClock;
let log: RecordingLog;
let metrics: RecordingInstruments;
let up: boolean;
const stores: PostgresCredentialStore[] = [];

function open(): PostgresCredentialStore {
  const store = new PostgresCredentialStore({
    db: { sql: database().sql, up: () => up },
    log,
    clock,
    metrics,
  });
  stores.push(store);
  return store;
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('it never happened');
    await Bun.sleep(5);
  }
}

async function rows(): Promise<{ provider: string; credential: string }[]> {
  return database()
    .sql`SELECT provider, credential FROM mate_credentials ORDER BY provider`;
}

/** Nothing a store logs or throws carries a token. */
function expectNoSecret(text: string): void {
  expect(text).not.toContain('SECRET');
}

beforeEach(async () => {
  clock = new FakeClock();
  log = new RecordingLog();
  metrics = new RecordingInstruments();
  up = true;
  await database().sql`DELETE FROM mate_credentials`;
});

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

describe('reading', () => {
  test('an empty table holds nothing, and a down store is an error, never "signed out"', async () => {
    const store = open();
    up = false;
    await expect(store.read(CODEX)).rejects.toBeInstanceOf(StoreUnavailable);
    await expect(store.list()).rejects.toBeInstanceOf(StoreUnavailable);
    up = true;
    expect(await store.read(CODEX)).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  test('once loaded, reads come from memory even while the store is down', async () => {
    await open().modify(CODEX, async () => credential(1));
    const store = open();
    expect(await store.read(CODEX)).toEqual(credential(1));
    up = false;
    expect(await store.read(CODEX)).toEqual(credential(1));
    expect(await store.list()).toEqual([{ providerId: CODEX, type: 'oauth' }]);
  });

  test('a row that does not parse is ignored, and the log names only its provider', async () => {
    await database().sql`
      INSERT INTO mate_credentials (provider, credential, updated_at)
      VALUES (${CODEX}, ${`{"type":"oauth","access":"${ACCESS}"`}, 1)
    `;
    const store = open();
    expect(await store.read(CODEX)).toBeUndefined();
    expect(log.of('a stored credential does not parse; ignored')).toEqual([
      expect.objectContaining({ fields: { provider: CODEX } }),
    ]);
    expectNoSecret(JSON.stringify(log.entries));
  });
});

describe('modify', () => {
  test('writes through, and a new store reads back what the old one wrote', async () => {
    const first = open();
    expect(await first.modify(CODEX, async () => credential(1))).toEqual(
      credential(1),
    );
    const [row] = await database()
      .sql`SELECT updated_at FROM mate_credentials WHERE provider = ${CODEX}`;
    expect(Number(row.updated_at)).toBe(clock.now());
    expect(await open().read(CODEX)).toEqual(credential(1));
  });

  test('runs one task at a time per provider, each seeing the last one written', async () => {
    const store = open();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: (Credential | undefined)[] = [];
    const first = store.modify(CODEX, async (current) => {
      seen.push(current);
      await held;
      return credential(1);
    });
    const second = store.modify(CODEX, async (current) => {
      seen.push(current);
      return credential(2);
    });
    await settle();
    expect(seen).toEqual([undefined]);
    release();
    expect(await first).toEqual(credential(1));
    expect(await second).toEqual(credential(2));
    expect(seen).toEqual([undefined, credential(1)]);
    expect((await rows()).map((r) => JSON.parse(r.credential))).toEqual([
      credential(2),
    ]);
  });

  test('a rejection from fn propagates and writes nothing', async () => {
    const store = open();
    await store.modify(CODEX, async () => credential(1));
    const refused = new Error('invalid_grant');
    await expect(
      store.modify(CODEX, async () => {
        throw refused;
      }),
    ).rejects.toBe(refused);
    expect(await store.read(CODEX)).toEqual(credential(1));
    expect((await rows()).map((r) => JSON.parse(r.credential))).toEqual([
      credential(1),
    ]);
  });

  test('undefined from fn keeps the stored credential and resolves it', async () => {
    const store = open();
    await store.modify(CODEX, async () => credential(1));
    expect(await store.modify(CODEX, async () => undefined)).toEqual(
      credential(1),
    );
    expect(await open().read(CODEX)).toEqual(credential(1));
  });

  test('a caller that stops waiting mid-refresh still has the rotated token saved', async () => {
    const store = open();
    const stop = new AbortController();
    let rotate = () => {};
    const rotated = new Promise<void>((resolve) => {
      rotate = resolve;
    });
    const waiting = store.modify(
      CODEX,
      async () => {
        await rotated;
        return credential(2);
      },
      { signal: stop.signal },
    );
    await settle();
    stop.abort(new Error('the user pressed Stop'));
    await expect(waiting).rejects.toThrow('the user pressed Stop');
    rotate();
    await store.modify(CODEX, async () => undefined);
    expect(await store.read(CODEX)).toEqual(credential(2));
    expect(await open().read(CODEX)).toEqual(credential(2));
  });

  test('a caller that stops waiting before its turn comes never runs', async () => {
    const store = open();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = store.modify(CODEX, async () => {
      await held;
      return credential(1);
    });
    const stop = new AbortController();
    let ran = false;
    const queued = store.modify(
      CODEX,
      async () => {
        ran = true;
        return credential(2);
      },
      { signal: stop.signal },
    );
    await settle();
    stop.abort(new Error('the user pressed Stop'));
    await expect(queued).rejects.toThrow('the user pressed Stop');
    release();
    await first;
    await store.modify(CODEX, async () => undefined);
    expect(ran).toBe(false);
    expect(await open().read(CODEX)).toEqual(credential(1));
  });

  test('refuses opencode-go, whose key file a stored credential would override', async () => {
    const store = open();
    await expect(
      store.modify('opencode-go', async () => ({
        type: 'api_key',
        key: 'sk-x',
      })),
    ).rejects.toThrow('its key is a file');
    expect(await rows()).toEqual([]);
  });

  test('tells listeners what changed, never the credential', async () => {
    const store = open();
    const changes: CredentialChange[] = [];
    store.onChange((change) => changes.push(change));
    await store.modify(CODEX, async () => credential(1, 42));
    await store.delete(CODEX);
    expect(changes).toEqual([
      { providerId: CODEX, stored: true, expires: 42 },
      { providerId: CODEX, stored: false, expires: null },
    ]);
  });
});

describe('a write that fails', () => {
  test('retries, then keeps the rotated token in memory and saves it once the store is back', async () => {
    const store = open();
    await store.read(CODEX);
    up = false;
    const written = store.modify(CODEX, async () => credential(1));
    for (const wait of WRITE_RETRY_MS) {
      await settle();
      await clock.advance(wait);
    }
    expect(await written).toEqual(credential(1));
    expect(await store.read(CODEX)).toEqual(credential(1));
    expect(metrics.storeFailures).toEqual(
      Array(WRITE_RETRY_MS.length + 1).fill('credentials'),
    );
    expect(
      log.of(
        'a credential could not be saved; mate keeps it in memory and retries',
      ),
    ).toHaveLength(1);
    expect(await rows()).toEqual([]);

    await clock.advance(UNSAVED_RETRY_MS);
    expect(metrics.storeFailures).toHaveLength(WRITE_RETRY_MS.length + 2);
    up = true;
    await clock.advance(UNSAVED_RETRY_MS);
    await until(() => log.of('an unsaved credential is saved').length > 0);
    expect((await rows()).map((r) => JSON.parse(r.credential))).toEqual([
      credential(1),
    ]);
    expect(clock.pendingTimers).toBe(0);
  });

  test('saves the credential as it stands when the retry runs, not as it failed', async () => {
    const store = open();
    await store.read(CODEX);
    up = false;
    for (const n of [1, 2]) {
      const written = store.modify(CODEX, async () => credential(n));
      for (const wait of WRITE_RETRY_MS) {
        await settle();
        await clock.advance(wait);
      }
      await written;
    }
    up = true;
    await clock.advance(UNSAVED_RETRY_MS);
    await until(() => log.of('an unsaved credential is saved').length > 0);
    expect((await rows()).map((r) => JSON.parse(r.credential))).toEqual([
      credential(2),
    ]);
  });

  // Postgres puts the failing row, credential and all, in the error's detail.
  test('a driver error is logged by its code alone', async () => {
    const { sql } = database();
    const store = open();
    await store.read(CODEX);
    await sql`ALTER TABLE mate_credentials ADD CONSTRAINT refuse CHECK (false) NOT VALID`;
    try {
      const written = store.modify(CODEX, async () => credential(1));
      for (const wait of WRITE_RETRY_MS) {
        await until(() => clock.pendingTimers > 0);
        await clock.advance(wait);
      }
      expect(await written).toEqual(credential(1));
    } finally {
      await sql`ALTER TABLE mate_credentials DROP CONSTRAINT refuse`;
    }
    const [entry] = log.of(
      'a credential could not be saved; mate keeps it in memory and retries',
    );
    expect(String(entry?.fields?.error)).toContain('23514');
    expectNoSecret(JSON.stringify(log.entries));
  });

  test('closing makes one last try to save what is unsaved', async () => {
    const store = open();
    await store.read(CODEX);
    up = false;
    const written = store.modify(CODEX, async () => credential(1));
    for (const wait of WRITE_RETRY_MS) {
      await settle();
      await clock.advance(wait);
    }
    await written;
    up = true;
    await store.close();
    expect((await rows()).map((r) => JSON.parse(r.credential))).toEqual([
      credential(1),
    ]);
    expect(clock.pendingTimers).toBe(0);
  });

  test('closing on a store still down says the credential is lost, by provider alone', async () => {
    const store = open();
    await store.read(CODEX);
    up = false;
    const written = store.modify(CODEX, async () => credential(1));
    for (const wait of WRITE_RETRY_MS) {
      await settle();
      await clock.advance(wait);
    }
    await written;
    await store.close();
    expect(log.of('mate stops with a credential it could not save')).toEqual([
      expect.objectContaining({ fields: { providers: [CODEX] } }),
    ]);
    expect(clock.pendingTimers).toBe(0);
    expectNoSecret(JSON.stringify(log.entries));
  });
});

// mate closes the pool as soon as close() returns, then main.ts exits.
describe('closing', () => {
  test('waits for a rotation still running, and saves it before it returns', async () => {
    const store = open();
    await store.modify(CODEX, async () => credential(0));
    let rotate = () => {};
    const rotated = new Promise<void>((resolve) => {
      rotate = resolve;
    });
    const refreshing = store.modify(CODEX, async () => {
      await rotated;
      return credential(1);
    });
    await settle();
    let closed = false;
    const closing = store.close().then(() => {
      closed = true;
    });
    await settle();
    expect(closed).toBe(false);
    rotate();
    await closing;
    expect((await rows()).map((r) => JSON.parse(r.credential))).toEqual([
      credential(1),
    ]);
    expect(await refreshing).toEqual(credential(1));
  });

  test('refuses a write that has not started, so no refresh spends a token after it', async () => {
    const store = open();
    await store.close();
    let ran = false;
    const refresh = async () => {
      ran = true;
      return credential(1);
    };
    await expect(store.modify(CODEX, refresh)).rejects.toBeInstanceOf(
      StoreUnavailable,
    );
    await expect(store.delete(CODEX)).rejects.toBeInstanceOf(StoreUnavailable);
    expect(ran).toBe(false);
    expect(await rows()).toEqual([]);
  });
});

describe('delete', () => {
  test('removes the row and the cached copy, in order with writes', async () => {
    const store = open();
    const write = store.modify(CODEX, async () => credential(1));
    const gone = store.delete(CODEX);
    await Promise.all([write, gone]);
    expect(await store.read(CODEX)).toBeUndefined();
    expect(await rows()).toEqual([]);
  });

  test('a delete the store refuses throws and leaves the credential in place', async () => {
    const store = open();
    await store.modify(CODEX, async () => credential(1));
    up = false;
    await expect(store.delete(CODEX)).rejects.toBeInstanceOf(StoreUnavailable);
    await settle();
    expect(await store.read(CODEX)).toEqual(credential(1));
  });
});

describe('the nightly dump', () => {
  test('leaves out the rows of the table the migration creates', async () => {
    expect(
      MIGRATIONS.some(([, sql]) =>
        sql.includes('CREATE TABLE mate_credentials'),
      ),
    ).toBe(true);
    const manifests = Bun.YAML.parse(
      await Bun.file(
        new URL(
          '../../../clusters/offsite/apps/mate/database-backup.yaml',
          import.meta.url,
        ),
      ).text(),
    ) as { kind: string; spec?: unknown }[];
    const job = manifests.find((doc) => doc.kind === 'CronJob') as {
      spec: {
        jobTemplate: {
          spec: {
            template: {
              spec: {
                initContainers: { name: string; command: string[] }[];
              };
            };
          };
        };
      };
    };
    const dump = job.spec.jobTemplate.spec.template.spec.initContainers.find(
      (container) => container.name === 'dump',
    );
    const script = dump?.command.at(-1) ?? '';
    expect(script).toMatch(/\bpg_dump\b/);
    expect(script.split(/\s+/)).toContain(
      '--exclude-table-data=mate_credentials',
    );
  });
});
