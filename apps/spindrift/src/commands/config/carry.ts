/**
 * Carrying pinned references from one Target to another (§10).
 *
 * This is the *free* half of a re-placement: the two Targets share a store of
 * record, so the item a reference names is reachable from both, and moving the
 * configuration means moving the pointer. No `put`, no value, no read — the
 * store is not called at all.
 *
 * It is a separate file from the write path on purpose. `set.ts` is where a
 * value crosses the store seam, and there is exactly one of those; a copy that
 * lived beside it would eventually grow a "and while we're here, re-put it"
 * branch, which is the migration §10 says core cannot do.
 */
import {
  configAuditEvents,
  configItems,
  PINNED_ENVIRONMENT,
} from '../../db/schema.ts';
import type { CommandContext } from '../types.ts';
import type { CarriedItem } from './migration.ts';
import type { ConfigSubject } from './set.ts';

/**
 * Write the carried references at the destination scope, and audit them.
 *
 * Conflict-tolerant on the destination's own key: a key already configured
 * there is not overwritten by one carried in, because a value somebody set on
 * this Target is more current than one that lived on the Target being moved
 * away from.
 */
export async function carryReferences(
  context: CommandContext,
  subject: ConfigSubject,
  items: readonly CarriedItem[],
): Promise<string[]> {
  const now = context.clock.now();
  const carried: string[] = [];

  for (const item of items) {
    if (item.storeRef === null || item.storeVersion === null) continue;
    const inserted = await context.db
      .insert(configItems)
      .values({
        componentId: subject.componentId,
        targetId: subject.targetId,
        environment: PINNED_ENVIRONMENT,
        key: item.key,
        kind: 'secret_ref',
        storeRef: item.storeRef,
        storeVersion: item.storeVersion,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ key: configItems.key });

    if (inserted.length === 0) continue;
    carried.push(item.key);

    // Audited as a `set`, because from the destination's side that is what
    // happened: this key is now configured here, by this principal, at this
    // time. The audit is metadata only (§10) and says nothing about a value,
    // which is just as well — no value moved.
    await context.db.insert(configAuditEvents).values({
      componentId: subject.componentId,
      targetId: subject.targetId,
      key: item.key,
      action: 'set',
      userId: context.principal.id,
      displayName: context.principal.displayName,
      createdAt: now,
    });
  }

  return carried;
}
