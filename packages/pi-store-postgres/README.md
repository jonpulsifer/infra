# @repo/pi-store-postgres

pi-store-postgres keeps [pi](https://www.npmjs.com/package/@earendil-works/pi-agent-core) agent sessions in Postgres. It implements pi-agent-core's `Storage` interface on Bun's built-in `SQL` client, and opens sessions by a caller's own id, such as a thread key. It pins `@earendil-works/pi-agent-core` to one exact version, because pi's session format may change between releases. mate does not use it yet.

```ts
import { SQL } from 'bun';
import { migrate, openSession } from '@repo/pi-store-postgres';

const sql = new SQL(process.env.DATABASE_URL);
await migrate(sql);
const session = await openSession(sql, { id: threadKey });
// AgentHarness.create({ session, ... })
```

| Export | What it does |
| --- | --- |
| `migrate(sql)` | Applies the schema. It is idempotent and safe to race. |
| `openSession(sql, { id, metadata? })` | Creates the session on first use, then reopens it. Returns a `StorageBackedSession<PostgresSessionMetadata>`. |
| `postgresStorage(sql, id)` | The bare `Storage` for a session that exists. |
| `deleteSession(sql, id)` | Deletes a session and its rows. A missing session is not an error. |
| `sessionExists(sql, id)` | Whether the session row exists. |
| `CommitOutcomeUnknownError` | A commit failed after an earlier attempt of it may have committed. |
| `PostgresStoreOptions` | `{ sql }`, for a caller that passes the pool around. |

The caller owns the pool: nothing here closes `sql`. `metadata` is stored when `openSession` creates the session, and read back as `session.metadata.metadata`; a later open ignores it. There is no `SessionRepo`, fork or listing.

## Schema

`src/schema.ts` holds the migrations, recorded in `pi_store_migrations`. The tables port pi's SQLite backend (`001_initial.sql` in `@earendil-works/pi-session-backend-sqlite-node`) with a `pi_` prefix, so they can share a database with the host's own tables:

| Table | Holds |
| --- | --- |
| `pi_sessions` | One row per session: `next_seq`, `message_count` and the usage totals as JSON |
| `pi_entries` | The conversation tree; a self-referencing foreign key keeps every parent present |
| `pi_scalar_values` | pi's keyed values, such as lane state and operation state |
| `pi_list_values` | pi's append-only lists, such as streamed frames |
| `pi_usage_ledger` | One row per model request or adjustment |

JSON is stored as `text`: `jsonb` refuses `\u0000` and reorders keys. Key columns use the `"C"` collation, so keys sort by code point, as pi's in-memory store sorts them. Integers are `bigint`; Bun returns those as strings, and the store reads each through `Number()` and refuses one that is not a safe integer. SQLite's `branch_entries` and `branch_meta` index has no port: a branch scan is one recursive query over `pi_entries`, and pi's storage conformance suite checks its semantics.

## Commits

Each `commit()` is one transaction. It takes `pg_advisory_xact_lock(hashtext(session_id))`, then the session row `FOR UPDATE`, so one writer at a time assigns seqs whichever process it runs in. Seqs come from pi's `prepareStorageCommit`, pi's `validateCommittedWrites` checks ids and parents, and the totals add in pi's order. Commits from one `Storage` run in the order they were admitted. `close()` refuses new commits and reads from the moment it is called, and resolves once the admitted commits finish.

A commit that hits a lost connection, or a Postgres error that asks for a retry, runs again only when the retry proves the earlier attempt did not commit. The retry takes the same locks, which waits out an attempt still in flight, and proceeds only while `next_seq` equals the first seq an earlier attempt read. Otherwise the commit throws `CommitOutcomeUnknownError`, and the session is consistent either way. A commit that breaks pi's rules fails on its first attempt. Reads retry the same failures, and a commit or a read makes up to four attempts.

A commit of nothing but `pi.pending.assistant_frame` appends runs with `synchronous_commit = off`. pi writes one per streamed chunk, and after a crash it rebuilds the partial reply from the frames that survive. Any later synchronous commit flushes the frames before it.

`bun run --cwd packages/pi-store-postgres bench` times 200 frame commits, one at a time, beside 200 appends of the same size that commit synchronously. It takes the test URL, or `PI_STORE_BENCH_SOCKET` for a Unix socket. The median of three runs on each of two local Postgres 16 servers:

| Server | Frames: commits/s, p50, p99 | Synchronous: commits/s, p50, p99 |
| --- | --- | --- |
| Loopback TCP, `fsync` off | 768/s, 1.25 ms, 2.48 ms | 838/s, 1.19 ms, 1.91 ms |
| Unix socket, `fsync` on | 2859/s, 0.31 ms, 0.93 ms | 506/s, 2.05 ms, 3.28 ms |

A commit is six round trips (`BEGIN`, the lock, the row, the insert, the row update, `COMMIT`), so the network sets the floor. A frame also skips the WAL flush, which is most of a synchronous commit's time when the disk syncs.

## Limits

Ids, custom types, namespaces and keys are Postgres `text`: they cannot hold `\u0000` or unpaired surrogates. pi rejects `\u0000` in namespaces and keys, and its own ids are UUIDv7. Nothing prunes a session; `deleteSession` is the only way rows leave.

## Develop

```bash
PI_STORE_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:15432/postgres \
  bun run --cwd packages/pi-store-postgres test
bun run --cwd packages/pi-store-postgres typecheck
bun run --cwd packages/pi-store-postgres lint
```

The tests need a Postgres server, from `PI_STORE_TEST_DATABASE_URL` or else `DATABASE_URL`, and fail without one. Each test file creates its own database on that server and drops it after. They run every case of pi's storage conformance suite, pi's harness crashed at every commit of one turn and resumed from Postgres, and connection failures cut at chosen protocol messages by a relay in `test/proxy.ts`. CI runs them in the TypeScript workflow against the Postgres that workflow starts.
