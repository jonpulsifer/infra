/**
 * Commit throughput for one streamed reply: 200 frame appends, one commit
 * each, as pi writes them, beside 200 appends of the same size that commit
 * synchronously. Runs in a database of its own on the server that
 * PI_STORE_TEST_DATABASE_URL or DATABASE_URL names, or as user postgres
 * through the Unix socket PI_STORE_BENCH_SOCKET names, since Bun's URLs have
 * no socket form.
 *
 *   bun run --cwd packages/pi-store-postgres bench
 */
import {
  appendList,
  BACKGROUND_CONTEXT,
  list,
  pendingAssistantFrames,
  type Storage,
  type ValueList,
} from '@earendil-works/pi-agent-core';
import { SQL } from 'bun';
import { migrate, openSession, postgresStorage } from '../src/index.ts';

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

function frame(index: number) {
  return {
    type: 'text_delta' as const,
    contentIndex: 0,
    delta: `token ${index} of a streamed reply `,
  };
}

async function run<T>(
  storage: Storage,
  address: ValueList<T>,
  element: (index: number) => T,
) {
  for (let index = 0; index < WARMUP; index++) {
    await storage.commit(
      [appendList(address, element(index))],
      BACKGROUND_CONTEXT,
    );
  }
  const latencies: number[] = [];
  const started = performance.now();
  for (let index = 0; index < COMMITS; index++) {
    const before = performance.now();
    await storage.commit(
      [appendList(address, element(index))],
      BACKGROUND_CONTEXT,
    );
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
  await (await openSession(sql, { id: 'bench' })).close(BACKGROUND_CONTEXT);
  const storage = postgresStorage(sql, 'bench');
  console.table({
    'frames (asynchronous commit)': await run(
      storage,
      pendingAssistantFrames('operation', 'response'),
      frame,
    ),
    'same-size list (synchronous)': await run(
      storage,
      list('bench.list', 'response'),
      frame,
    ),
  });
  await storage.close(BACKGROUND_CONTEXT);
} finally {
  await sql.close();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.close();
}
