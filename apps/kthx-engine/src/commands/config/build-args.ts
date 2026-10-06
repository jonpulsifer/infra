/**
 * A website's build-time config: plain rows, chosen by Component kind, never
 * fetched from a store. A baked value is public, so a website cannot reference
 * a stored secret, and no builder holds a store credential.
 */
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { configItems, PINNED_ENVIRONMENT } from '../../db/schema.ts';
import type { ComponentKind } from '../../domain/desired-state.ts';

/** A website has no process to read config at start, so it is baked at build. */
export function isBuildTimeConfig(kind: ComponentKind): boolean {
  return kind === 'website';
}

/**
 * Plain rows only. Sorted by key so the same config gives the same argument
 * order, and so the same build digest.
 */
export async function readBuildArgs(
  db: Database,
  componentId: string,
  targetId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({ key: configItems.key, value: configItems.plainValue })
    .from(configItems)
    .where(
      and(
        eq(configItems.componentId, componentId),
        eq(configItems.targetId, targetId),
        eq(configItems.environment, PINNED_ENVIRONMENT),
        eq(configItems.kind, 'plain'),
      ),
    );

  return Object.fromEntries(
    rows
      .filter((row) => row.value !== null)
      .map((row) => [row.key, row.value as string])
      .sort(([left], [right]) =>
        (left as string).localeCompare(right as string),
      ),
  );
}
