/**
 * Carries pinned references to a Target that shares the same store of record.
 * Only the pointer moves: the store is never called.
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
 * Writes the carried references at the destination and audits them. A key
 * already configured at the destination keeps its own reference.
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

    // Audited as a `set`: to the destination, the key is now configured here.
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
