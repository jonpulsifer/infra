import type { SQL } from 'bun';
import journal from './migrations/meta/_journal.json';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export type SchemaWaitOptions = {
  pollIntervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

/** The timestamp Drizzle records for the newest migration in this image. */
export function expectedMigrationAt(): number {
  return Math.max(0, ...journal.entries.map((entry) => entry.when));
}

/** Whether the database journal contains every migration expected by this image. */
export async function schemaReady(client: SQL): Promise<boolean> {
  const [relation] = await client<{ journal: string | null }[]>`
    SELECT to_regclass('drizzle.__drizzle_migrations')::text AS journal
  `;
  if (!relation?.journal) return false;

  const [row] = await client<{ latest: string | number | bigint | null }[]>`
    SELECT max(created_at)::bigint AS latest
    FROM drizzle.__drizzle_migrations
  `;
  return Number(row?.latest ?? 0) >= expectedMigrationAt();
}

/**
 * Hold a process in its init container until the migration Job has brought
 * the database up to the migration journal embedded in the same image.
 */
export async function waitForSchema(
  client: SQL,
  options: SchemaWaitOptions = {},
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? Bun.sleep;
  const deadline = now() + timeoutMs;

  do {
    if (await schemaReady(client)) return;
    await sleep(pollIntervalMs);
  } while (now() < deadline);

  throw new Error(
    `database schema did not reach migration ${expectedMigrationAt()} within ${timeoutMs}ms`,
  );
}
