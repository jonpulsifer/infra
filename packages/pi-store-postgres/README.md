# @repo/pi-store-postgres

pi-store-postgres keeps [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) sessions in Postgres. It implements pi-durable's `Storage` interface on Bun's built-in `SQL` client, and names each session by a caller's own id, such as a thread key. Many sessions share one database. mate keeps each thread's session here, through `apps/mate/src/store.ts`.

```ts
import { SQL } from 'bun';
import { Harness } from '@earendil-works/pi-durable';
import { migrate, openStorage } from '@repo/pi-store-postgres';

const sql = new SQL(process.env.DATABASE_URL);
await migrate(sql);
const storage = await openStorage(sql, threadKey);
const harness = await Harness.open(storage, { models, registry }, context);
```

| Export | What it does |
| --- | --- |
| `migrate(sql)` | Applies the schema. It is idempotent and safe to race. |
| `openStorage(sql, id)` | Creates the session on first use, then reopens it. Returns pi-durable's `Storage`. |
| `deleteStorage(sql, id)` | Deletes a session and its rows. A missing session is not an error. |
| `storageExists(sql, id)` | Whether the session row exists. |
| `CommitOutcomeUnknownError` | A commit this `Storage` made or tried may have been lost, or may have landed unconfirmed. `firstSeq` is the seq the `Storage` expected, `foundSeq` the one a commit found instead, and `cause` the last error when the retries ran out. |

The caller owns the pool: nothing here closes `sql`. `Storage.close()` rejects every later operation with an error that says `closed`, and resolves once the operations it had admitted finish. There is no fork and no listing of sessions.

## Schema

`src/schema.ts` holds the migrations, recorded in `pi_store_migrations`. Migration 2 drops the tables of migration 1 and creates the pi-durable schema; no rows are converted. The tables port pi-durable's SQLite backend with a `pi_` prefix, so they can share a database with the host's own tables. Every table carries a `session_id` that references `pi_sessions` with `ON DELETE CASCADE`.

| Table | Holds |
| --- | --- |
| `pi_sessions` | One row per session: the next record id, `next_id`, and the next commit seq, `next_seq` |
| `pi_record_ids` | The session's id namespace: which kind of record owns each id |
| `pi_conversations` | Conversation records, with their owner columns |
| `pi_entries` | Entry records, with `conversation_id`, `head` and the `commit_seq` that stored them |
| `pi_tasks` | The latest record of each task, with its `status`, `kind`, `abort_requested` and `background` columns |
| `pi_submissions` | The latest record of each submission, with `request_id` and `status` |
| `pi_documents` | Document incarnations, with the columns that address them |
| `pi_document_revisions` | Each document's base and delta revisions, by commit seq |

Records are JSON stored as `text`: `jsonb` refuses `\u0000` and reorders keys. Indexed strings, which are task kinds, request ids, document kinds and document keys, are stored as their JSON text, so a lone surrogate or NUL survives. Key columns use the `"C"` collation. Ids, seqs and timestamps are `bigint`; Bun returns those as strings, and the store reads each through `Number()` and refuses one that is not a safe integer.

## Ids

`mintId()` takes the next id from `pi_sessions.next_id` with one `UPDATE`, so ids are unique across processes and across `Storage` instances of one session. A commit raises `next_id` past every id it writes, and a minted id that no commit uses is a gap. `mintId()` rejects with `ID space is exhausted` once `next_id` passes `Number.MAX_SAFE_INTEGER`.

## Commits

Each `commit()` is one transaction. It takes `pg_advisory_xact_lock(hashtext(session_id))`, then the session row `FOR UPDATE`, so one writer at a time assigns seqs whichever process it runs in. A commit's seq is the `next_seq` it read. `src/commit.ts` holds pi-durable's checks, which are the id namespace, document addresses, version transitions and copies, and the table writes. Commits from one `Storage` run in the order they were admitted.

A failed commit throws one of two classes, which decide what pi-durable's `Session` does next:

| Failure | Thrown | The `Session` |
| --- | --- | --- |
| A rule of the contract, a constraint, or an unknown session, rolled back | A plain `Error`, as pi-durable's SQLite and memory backends throw it | Poisons itself; reopen it |
| A failed document copy | `StorageRejected`, as the reference wraps it | Carries on |
| A connection failure whose every attempt provably did not commit | `StorageRejected`, with the connection error as `cause` | Carries on |
| A commit after `close()` | `StorageRejected` | Carries on |
| Retries ran out while an attempt may have committed, or `next_seq` is not where the `Storage` left it | `CommitOutcomeUnknownError`, which is not a `StorageRejected` | Poisons itself; reopen it |

A `Storage` expects to be its session's only writer. It remembers the `next_seq` it read when `openStorage` opened it, or last left under those locks, and a commit that finds any other value there throws `CommitOutcomeUnknownError` instead of writing: a commit was lost, one landed that the `Storage` could not confirm, or another writer moved the session. The `Storage` then takes the value it found as its own.

A commit that hits a lost connection, or a Postgres error that asks for a retry, runs again only when the retry proves the earlier attempt did not commit. The retry takes the same locks, which waits out an attempt still in flight, and the rule above refuses it unless `next_seq` is still where the earlier attempt read it. An attempt may have committed once it sends `COMMIT`, until a later attempt finds `next_seq` still where it was. Reads, `mintId`, `openStorage`, `deleteStorage` and `storageExists` retry the same failures.

Each call makes up to four attempts, 0.1 s, 0.3 s and 0.9 s apart, and starts none more than 2 s after the first. A server that refuses connections fails each attempt at once, so the retries ride out about 1.3 s of it. A server that does not answer holds each attempt for the pool's `connectionTimeout`, which Bun sets to 30 s unless the caller sets it; such a failure is not retried. A call against a server that is down therefore rejects after at most about 2 s plus one `connectionTimeout`. Set `connectionTimeout` on the pool to shorten that.

A document read runs its queries in one read-only `REPEATABLE READ` transaction, so a commit between them cannot replace the base it reads.

`bun run --cwd packages/pi-store-postgres bench` times 200 document deltas and 200 entry appends, one commit at a time. It takes the test URL, or `PI_STORE_BENCH_SOCKET` for a Unix socket. A commit is about eight round trips, so the network sets the floor.

## Limits

A session id is Postgres `text`: it cannot hold `\u0000` or unpaired surrogates. Nothing prunes a session; `deleteStorage` is the only way rows leave.

## Develop

```bash
PI_STORE_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:15432/postgres \
  bun run --cwd packages/pi-store-postgres test
bun run --cwd packages/pi-store-postgres typecheck
bun run --cwd packages/pi-store-postgres lint
```

The tests need a Postgres server, from `PI_STORE_TEST_DATABASE_URL` or else `DATABASE_URL`, and fail without one. Each test file creates its own database on that server and drops it after. They run pi-durable's storage conformance suite (`test/conformance.test.ts`), the isolation of two sessions and `migrate` (`test/session.test.ts`), pi-durable's `Harness` crashed at every commit of one turn and resumed from Postgres (`test/harness.test.ts`), and connection failures cut at chosen protocol messages by a relay in `test/proxy.ts` (`test/faults.test.ts`). CI runs them in the TypeScript workflow against the Postgres that workflow starts.
