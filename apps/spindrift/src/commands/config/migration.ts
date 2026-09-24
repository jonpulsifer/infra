/**
 * What moving a Component to another Target does to its config. A shared store
 * of record carries the references; any other store demands the keys again,
 * because core never reads a value back.
 */
import { and, eq, ne } from 'drizzle-orm';
import type {
  InstallationManifest,
  StoreAdapter,
} from '../../config/manifest.schema.ts';
import type { Database } from '../../db/client.ts';
import { configItems, PINNED_ENVIRONMENT, targets } from '../../db/schema.ts';
import {
  keysThatWillNotFollow,
  sharesStoreOfRecord,
} from '../../domain/config.ts';
import type { AdapterRegistry } from '../types.ts';
import { storeOfRecordOf } from './set.ts';

export interface MigrationContext {
  readonly manifest: InstallationManifest;
  readonly adapters: Pick<AdapterRegistry, 'deploy' | 'store'>;
}

export interface CarriedItem {
  readonly key: string;
  readonly storeRef: string | null;
  readonly storeVersion: string | null;
}

export interface Migration {
  /** Null when nothing is configured on another Target. */
  readonly fromTargetId: string | null;
  /** Items whose references the destination can use as they are. */
  readonly follows: readonly CarriedItem[];
  /** Sorted. Place demands these before the move commits. */
  readonly demanded: readonly string[];
}

const NOTHING: Migration = { fromTargetId: null, follows: [], demanded: [] };

/** The source is the other Target this Component was most recently configured on. */
export async function migrationFor(
  db: Database,
  context: MigrationContext,
  componentId: string,
  targetId: string,
): Promise<Migration> {
  const elsewhere = await db
    .select({
      targetId: configItems.targetId,
      key: configItems.key,
      storeRef: configItems.storeRef,
      storeVersion: configItems.storeVersion,
      updatedAt: configItems.updatedAt,
    })
    .from(configItems)
    .where(
      and(
        eq(configItems.componentId, componentId),
        ne(configItems.targetId, targetId),
        eq(configItems.environment, PINNED_ENVIRONMENT),
        eq(configItems.kind, 'secret_ref'),
      ),
    );
  if (elsewhere.length === 0) return NOTHING;

  const newest = elsewhere.reduce((left, right) =>
    right.updatedAt > left.updatedAt ? right : left,
  );
  const source = elsewhere.filter((item) => item.targetId === newest.targetId);

  const here = await db
    .select({ key: configItems.key })
    .from(configItems)
    .where(
      and(
        eq(configItems.componentId, componentId),
        eq(configItems.targetId, targetId),
        eq(configItems.environment, PINNED_ENVIRONMENT),
      ),
    );

  const [from, to] = await Promise.all([
    storeOf(db, context, newest.targetId),
    storeOf(db, context, targetId),
  ]);
  const shares = sharesStoreOfRecord(from, to);

  const alreadyAtDestination = here.map((row) => row.key);
  const present = new Set(alreadyAtDestination);
  return {
    fromTargetId: newest.targetId,
    follows: shares ? source.filter((item) => !present.has(item.key)) : [],
    demanded: keysThatWillNotFollow({
      configured: source.map((item) => item.key),
      alreadyAtDestination,
      sharesStore: shares,
    }),
  };
}

async function storeOf(
  db: Database,
  context: MigrationContext,
  targetId: string,
): Promise<StoreAdapter | null> {
  const [row] = await db.select().from(targets).where(eq(targets.id, targetId));
  return row === undefined ? null : storeOfRecordOf(context, row);
}

export function demandSentence(
  keys: readonly string[],
  targetName: string,
): string {
  return (
    `${keys.join(', ')} ${keys.length === 1 ? 'is' : 'are'} configured through a store ` +
    `${targetName} cannot reach, and Spindrift never reads a value back — supply ` +
    `${keys.length === 1 ? 'it' : 'them'} to finish the move`
  );
}
