/**
 * What a move to another Target does to config (§10).
 *
 * §10 states the consequence before the mechanism: "**Core never retrieves,
 * therefore core cannot migrate config between stores.** Re-placement across a
 * store boundary is allowed, but **Place names the keys that will not follow and
 * demands them before the move commits.** Relaxing write-only for migration was
 * rejected because the carve-out *is* the boundary."
 *
 * So there are exactly two outcomes here and no third:
 *
 * - **Same store of record on both sides.** The item is the same item — "both
 *   clusters run their own connect service in front of the same vault, which is
 *   why cluster-to-cluster re-placement is free" — so the *reference* is copied
 *   and no value moves. Core still never reads one.
 * - **A different store of record.** Nothing can be copied: core holds no value
 *   and the reference names an item the destination cannot reach. Those keys are
 *   named and demanded.
 *
 * Both are computed from rows and capabilities only. There is no verb in this
 * file that could read a value even if the rule changed.
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

/** What deciding a move needs: the manifest, and the far side it can reach. */
export interface MigrationContext {
  readonly manifest: InstallationManifest;
  readonly adapters: Pick<AdapterRegistry, 'deploy' | 'store'>;
}

/** One key configured somewhere else, with the pin that may or may not follow. */
export interface CarriedItem {
  readonly key: string;
  readonly storeRef: string | null;
  readonly storeVersion: string | null;
}

/** Where a Component's configuration already lives, and whether it can move. */
export interface Migration {
  /** The Target the configuration is being carried from, if there is one. */
  readonly fromTargetId: string | null;
  /** Items whose references the destination can use as they are. */
  readonly follows: readonly CarriedItem[];
  /** Keys that will not follow, sorted. Place demands these (§10). */
  readonly demanded: readonly string[];
}

/** Nothing configured elsewhere: the first placement of a Component. */
const NOTHING: Migration = { fromTargetId: null, follows: [], demanded: [] };

/**
 * What moving this Component to this Target does to its configuration.
 *
 * The source is the *other* Target this Component is configured on. Where there
 * is more than one, the most recently configured wins: a Component that has
 * lived on three Targets is being moved from wherever it was last set up, and
 * asking a developer to choose a source would be asking them to answer a
 * question about a store they cannot see into.
 */
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

/** One Target's store of record, or `null` where it has none (§10). */
async function storeOf(
  db: Database,
  context: MigrationContext,
  targetId: string,
): Promise<StoreAdapter | null> {
  const [row] = await db.select().from(targets).where(eq(targets.id, targetId));
  return row === undefined ? null : storeOfRecordOf(context, row);
}

/** The sentence a developer reads when a move is blocked (§10). */
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
