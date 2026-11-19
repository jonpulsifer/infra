/**
 * The placement query and naming rule shared by the `setComponentZone` and
 * `setComponentVanity` previews, and the rule that one name belongs to one
 * Component across the installation.
 */
import { asc, eq, sql } from 'drizzle-orm';
import type { TargetAdapter } from '../../config/manifest.schema.ts';
import type { Database } from '../../db/client.ts';
import {
  apps,
  components,
  componentTargetDesired,
  targets,
  vessels,
} from '../../db/schema.ts';
import type { ComponentKind, Reach } from '../../domain/desired-state.ts';
import {
  componentCanonical,
  coreMintsCanonical,
  type DnsZones,
  heldNames,
  vanity,
  zoneFor,
} from '../../domain/naming.ts';
import type { CommandContext } from '../types.ts';

/**
 * The installation's one naming lock, held until the transaction ends, so two
 * acts cannot both find a name free and then both take it.
 */
export async function takeNamingLock(transaction: Database): Promise<void> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('kthx-engine/naming', 0))`,
  );
}

/** Runs `act` in a transaction holding {@link takeNamingLock}. */
export async function withNamingLock<Output>(
  context: CommandContext,
  act: (context: CommandContext) => Promise<Output>,
): Promise<Output> {
  return context.db.transaction(async (transaction) => {
    const locked = transaction as unknown as Database;
    await takeNamingLock(locked);
    return act({ ...context, db: locked });
  });
}

/** One placed Component, with what its name is minted from. */
export interface Placement {
  readonly componentId: string;
  readonly component: string;
  readonly reach: Reach;
  readonly adapter: TargetAdapter;
  readonly vessel: string;
  readonly id: string;
}

export async function placementsFor(
  db: Database,
  appId: string,
): Promise<Placement[]> {
  return db
    .selectDistinct({
      componentId: components.id,
      component: components.name,
      reach: components.reach,
      adapter: targets.adapter,
      vessel: vessels.name,
      id: targets.id,
    })
    .from(componentTargetDesired)
    .innerJoin(
      components,
      eq(components.id, componentTargetDesired.componentId),
    )
    .innerJoin(targets, eq(targets.id, componentTargetDesired.targetId))
    .innerJoin(vessels, eq(vessels.id, targets.vesselId))
    .where(eq(components.appId, appId));
}

/**
 * The hostnames one placement will answer on. Empty where nothing routes to the
 * Component; no canonical where the platform names its own workload.
 */
export function namesUnder(
  app: string,
  placement: Pick<Placement, 'component' | 'reach' | 'adapter'>,
  zones: DnsZones,
  pinned: string | null,
  vanityLabel: string | null = null,
): string[] {
  const zone = zoneFor(placement.reach, zones, pinned);
  if (zone === null) return [];

  const names: string[] = [];
  if (coreMintsCanonical(placement.adapter)) {
    names.push(
      componentCanonical({ app, component: placement.component, zone }),
    );
  }
  if (vanityLabel !== null) {
    names.push(vanity(vanityLabel, zone));
  }
  return names;
}

/** A Component that holds names, oldest first among those that share one. */
export interface NameHolder {
  readonly componentId: string;
  readonly app: string;
  readonly component: string;
  readonly names: readonly string[];
}

/**
 * Every Component with the names it holds ({@link heldNames}), oldest first.
 * Minted in memory from one unindexed query.
 */
export async function nameHolders(
  db: Database,
  zones: DnsZones,
): Promise<NameHolder[]> {
  const rows = await db
    .select({
      componentId: components.id,
      component: components.name,
      reach: components.reach,
      zone: components.zone,
      vanityLabel: components.vanityLabel,
      app: apps.name,
    })
    .from(components)
    .innerJoin(apps, eq(components.appId, apps.id))
    .orderBy(asc(components.createdAt), asc(components.id));
  return rows.map((row) => ({
    componentId: row.componentId,
    app: row.app,
    component: row.component,
    names: heldNames({ ...row, zones }),
  }));
}

/**
 * The first other Component holding one of `names`, with the name, or `null`.
 * `before` limits it to holders older than the Component, which is how a
 * Deploy tells the holder from the one that took the name second.
 */
export async function nameClash(
  db: Database,
  zones: DnsZones,
  /** `null` for a Component not yet written. */
  componentId: string | null,
  names: readonly string[],
  options: { readonly before?: boolean } = {},
): Promise<{ readonly name: string; readonly holder: NameHolder } | null> {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  if (wanted.size === 0) return null;
  const holders = await nameHolders(db, zones);
  const own = holders.findIndex((one) => one.componentId === componentId);
  const candidates =
    options.before === true && own !== -1 ? holders.slice(0, own) : holders;
  for (const holder of candidates) {
    if (holder.componentId === componentId) continue;
    const name = holder.names.find((held) => wanted.has(held));
    if (name !== undefined) return { name, holder };
  }
  return null;
}

/** One DNS label, since the join leads every canonical name. */
const JOINED_NAME_LIMIT = 63;

/**
 * Why a new Component may not take `<app>-<component>`, or `null`. The join
 * names its workload and leads its canonical name, so it is unique across the
 * installation whatever the reach: App my-shop with Component web and App my
 * with Component shop-web cannot both exist.
 */
export async function newComponentRefusal(
  db: Database,
  zones: DnsZones,
  component: {
    readonly app: string;
    readonly component: string;
    readonly reach: Reach;
  },
): Promise<string | null> {
  const joined = `${component.app}-${component.component}`;
  if (joined.length > JOINED_NAME_LIMIT) {
    return `${joined} is ${joined.length} characters; an App's name and a Component's, with the hyphen between them, take at most ${JOINED_NAME_LIMIT}`;
  }
  const holders = await nameHolders(db, zones);
  const twin = holders.find(
    (holder) => `${holder.app}-${holder.component}` === joined,
  );
  if (twin !== undefined) {
    return `${joined} is ${holderLabel(twin)}'s workload name already`;
  }
  const clash = await nameClash(
    db,
    zones,
    null,
    heldNames({ ...component, zones, zone: null, vanityLabel: null }),
  );
  return clash === null
    ? null
    : `would take ${clash.name}, which ${holderLabel(clash.holder)} holds`;
}

/** `shop's web`: how a refusal names the Component holding a name. */
export function holderLabel(
  holder: Pick<NameHolder, 'app' | 'component'>,
): string {
  return `${holder.app}'s ${holder.component}`;
}

/** What a Component's names are minted from, with its App's name. */
export interface ComponentNaming {
  readonly id: string;
  readonly appId: string;
  readonly app: string;
  readonly component: string;
  readonly kind: ComponentKind;
  readonly expose: boolean | null;
  readonly reach: Reach;
  readonly zone: string | null;
  readonly vanityLabel: string | null;
}

export async function componentNaming(
  db: Database,
  componentId: string,
): Promise<ComponentNaming | null> {
  const [row] = await db
    .select({
      id: components.id,
      appId: components.appId,
      app: apps.name,
      component: components.name,
      kind: components.kind,
      expose: components.expose,
      reach: components.reach,
      zone: components.zone,
      vanityLabel: components.vanityLabel,
    })
    .from(components)
    .innerJoin(apps, eq(components.appId, apps.id))
    .where(eq(components.id, componentId))
    .limit(1);
  return row ?? null;
}

/** What a zone serves, as a pin refusal says it: `only private`. */
export function zoneReaches(zone: string, zones: DnsZones): string {
  const reaches = zones.find((one) => one.name === zone)?.reaches ?? [];
  return reaches.length === 1
    ? `only ${reaches[0]}`
    : reaches.join(' and ') || 'nothing';
}
