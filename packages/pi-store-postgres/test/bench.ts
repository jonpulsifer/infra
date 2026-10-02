/**
 * Commit throughput for the two writes a streamed reply makes: 200 document
 * deltas, one commit each, and 200 entry appends, one commit each. Runs in a
 * database of its own on the server that PI_STORE_TEST_DATABASE_URL or
 * DATABASE_URL names, or as user postgres through the Unix socket
 * PI_STORE_BENCH_SOCKET names, since Bun's URLs have no socket form.
 *
 *   bun run --cwd packages/pi-store-postgres bench
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  type ConversationId,
  type DocumentId,
  type EntryId,
  ROOT_CONVERSATION_ID,
  type StorageWrite,
} from '@earendil-works/pi-durable';
import { SQL } from 'bun';
import { migrate, openStorage } from '../src/index.ts';

const COMMITS = 200;
const WARMUP = 20;

function connect(database: string | undefined, max: number): SQL {
  const path = Bun.env.PI_STORE_BENCH_SOCKET?.trim();
  if (path) {
    return new SQL({ path, username: 'postgres', database, max });
  }
  const server =
    Bun.env.PI_STORE_TEST_DATABASE_URL?.trim() || Bun.env.DATABASE_URL?.trim();
  if (!server) {
    throw new Error(
      'set PI_STORE_TEST_DATABASE_URL, DATABASE_URL or PI_STORE_BENCH_SOCKET',
    );
  }
  const url = new URL(server);
  if (database !== undefined) url.pathname = `/${database}`;
  return new SQL(url.toString(), { max });
}

const DOCUMENT = 2 as DocumentId;

async function run(
  write: (index: number) => StorageWrite,
  storage: Awaited<ReturnType<typeof openStorage>>,
) {
  const commit = (index: number) =>
    storage.commit([write(index)], BACKGROUND_CONTEXT);
  for (let index = 0; index < WARMUP; index++) await commit(index);
  const latencies: number[] = [];
  const started = performance.now();
  for (let index = WARMUP; index < WARMUP + COMMITS; index++) {
    const before = performance.now();
    await commit(index);
    latencies.push(performance.now() - before);
  }
  const seconds = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  const at = (quantile: number) =>
    latencies[Math.min(latencies.length - 1, Math.floor(quantile * COMMITS))]!;
  return {
    'commits/s': Math.round(COMMITS / seconds),
    'p50 ms': Number(at(0.5).toFixed(2)),
    'p99 ms': Number(at(0.99).toFixed(2)),
  };
}

const name = `pi_store_bench_${crypto.randomUUID().replaceAll('-', '')}`;
const admin = connect(undefined, 1);
await admin.unsafe(`CREATE DATABASE "${name}"`);
const sql = connect(name, 4);
try {
  await migrate(sql);
  const [settings] = await sql`
    SELECT current_setting('server_version') AS version,
      current_setting('fsync') AS fsync,
      current_setting('synchronous_commit') AS synchronous_commit
  `;
  console.log(settings);
  const storage = await openStorage(sql, 'bench');
  await storage.commit(
    [
      { type: 'conversation', value: { id: ROOT_CONVERSATION_ID } },
      {
        type: 'document.create',
        record: {
          id: DOCUMENT,
          kind: 'bench.live',
          scope: { kind: 'session' },
        },
        content: { kind: 'base', version: 1, value: { text: '' } },
      },
    ],
    BACKGROUND_CONTEXT,
  );
  console.table({
    'document delta': await run(
      (index) => ({
        type: 'document.change',
        id: DOCUMENT,
        content: {
          kind: 'delta',
          version: 1,
          ops: [['s', ['text'], `token ${index} of a streamed reply `]],
        },
      }),
      storage,
    ),
    'entry append': await run(
      (index) => ({
        type: 'entry',
        value: {
          id: (1000 + index) as EntryId,
          conversationId: ROOT_CONVERSATION_ID as ConversationId,
          kind: 'bench.note',
          data: { text: `token ${index} of a streamed reply ` },
        },
      }),
      storage,
    ),
  });
  await storage.close(BACKGROUND_CONTEXT);
} finally {
  await sql.close();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.close();
}
