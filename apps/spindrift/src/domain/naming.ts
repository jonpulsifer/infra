/**
 * Naming (§9).
 *
 * §9 is two layers, and the reason there are two is that they answer different
 * questions:
 *
 * > A **canonical** name that always resolves. Where the platform gives one of
 * > its own, that *is* the canonical; Spindrift mints one in its own zone only
 * > where the platform gives none — which is the metal cluster alone. A
 * > **vanity** flat single-label name layered on where a mechanism exists, so
 * > the name a developer shares is backend-agnostic and moving an App between
 * > backends is one record re-point.
 *
 * **The second layer survives only where core does not mint the first.** It was
 * written for a model where canonical was nested, unproxied and LAN-only, and
 * vanity was the only name with public reach — two layers because they were two
 * reach mechanisms. Reach is now a record type in a zone chosen per reach, so
 * where core mints the name it can simply mint a good one, and a second flat
 * name over it would be an alias for something already flat. Where the platform
 * names its own workloads that name is opaque and backend-specific, so the layer
 * still earns its place there: a flat zone name is both prettier and the thing
 * that makes moving backends one record re-point.
 *
 * **Core mints only what the platform will not.** {@link hostnameFor} returns an
 * empty canonical for a Target whose backend names its own workloads, and on
 * those the adapter reports the address back across the deploy seam (§6's
 * `DeployVerdict.url`). A core that minted a name there would be inventing a
 * second address for something that already had one.
 */
import type { TargetAdapter } from '../config/manifest.schema.ts';
import type { Hostname, Reach } from './desired-state.ts';

/**
 * A single DNS label: what a vanity name is allowed to be, and what a minted
 * name's one label is built from.
 */
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Whether a string is one legal DNS label. */
export function isLabel(value: string): boolean {
  return value.length > 0 && value.length <= 63 && LABEL.test(value);
}

/**
 * The backends that name their own workloads (§6's table, §9).
 *
 * Cloud Run mints a service URL and the hosting product mints a site address, so
 * on both of those the platform's name *is* the canonical one. A cluster mints
 * nothing an outsider can resolve — §9's "forcing fact" is that the metal
 * cluster's load-balancer range is RFC1918 — which is why it is the one place
 * core has to supply a name.
 */
const PLATFORM_NAMES_ITS_OWN: readonly TargetAdapter[] = [
  'cloudrun',
  'static',
  'vercel',
  'cloudflare-pages',
];

/** Whether core mints the canonical name for a Target of this adapter type. */
export function coreMintsCanonical(adapter: TargetAdapter): boolean {
  return !PLATFORM_NAMES_ITS_OWN.includes(adapter);
}

/**
 * A reach a zone is able to serve.
 *
 * `none` is absent because it is not a reach a zone could serve: nothing routes
 * to a Component that has it, so there is no record to publish anywhere.
 */
export type RoutedReach = Exclude<Reach, 'none'>;

/**
 * One zone this installation mints names in, and what it is able to serve (§9).
 *
 * A zone states its own reaches rather than a reach naming its zone, because
 * which way round that goes is what decides whether an installation may have
 * more than one. Under the old shape — one zone named per reach — two zones were
 * the maximum expressible, and an installation with a zone that only ever
 * answers on the internet had nowhere to say so.
 *
 * Both readings the old shape had survive. An installation that points every
 * zone at both reaches keeps §9's "flipping a Component's reach is a record
 * re-point and its hostname is stable". One that splits them — separate trust
 * boundaries, split-horizon resolvers — states a zone per reach and accepts, as
 * it always did, that changing reach is a rename.
 */
export interface DnsZone {
  readonly name: string;
  readonly reaches: readonly RoutedReach[];
}

/** Every zone this installation mints in, in the order an unpinned App takes. */
export type DnsZones = readonly DnsZone[];

/**
 * The zone a Component's name is minted in, or `null` when nothing routes to it.
 *
 * `reach: none` has no zone rather than a zone it declines to use, because the
 * absence is the point: a name that resolves to a Component nothing can reach is
 * a name that lies.
 *
 * `preferred` is the App's own pin, and it is a **preference rather than a
 * demand**. A pin that cannot serve this reach falls through to the first zone
 * that can, because the alternative is worse in both directions: minting in the
 * pinned zone anyway publishes a record on a boundary the operator said that
 * zone does not answer on, and refusing outright turns flipping a Component to
 * `private` into a deploy that fails at apply time rather than into §9's rename.
 * The name the fall-through produces is the name the UI shows, so the rename is
 * visible rather than silent.
 *
 * `null` also when no zone serves the reach at all — an installation whose zones
 * are all `public` has nothing honest to call a private Component.
 */
export function zoneFor(
  reach: Reach,
  zones: DnsZones,
  preferred: string | null = null,
): string | null {
  if (reach === 'none') return null;
  const serving = zones.filter((zone) => zone.reaches.includes(reach));
  return (
    serving.find((zone) => zone.name === preferred)?.name ??
    serving[0]?.name ??
    null
  );
}

/** What a minted name is assembled from. */
export interface CanonicalName {
  readonly app: string;
  readonly component: string;
  /** The zone for this Component's reach, from {@link zoneForReach}. */
  readonly zone: string;
}

/**
 * The name core mints for one Component on a Target that has none (§9).
 *
 * `<app>-<component>.<zone>` — **flat, one label under the zone**. Flatness is
 * not a style choice: one wildcard certificate binds exactly one label, so
 * a hyphen-joined single label is covered by `*.<zone>` and a nested one is not.
 * `<app>` leads so an App's Components sort together in a zone listing.
 */
export function componentCanonical(name: CanonicalName): string {
  return `${name.app}-${name.component}.${name.zone}`;
}

/** §9's flat single-label vanity name, in the zone for its Component's reach. */
export function vanity(label: string, zone: string): string {
  return `${label}.${zone}`;
}

/**
 * What is lost at a vanity name (§9).
 *
 * §9 records these as a **real loss, absorbed on purpose**: "the vanity leg
 * buffers the full response, so WebSockets and SSE die there and requests cap at
 * 60 seconds". They are properties of the proxying edge, which is why they apply
 * exactly where the layer still exists — the backends whose vanity name is a
 * proxied record in front of a platform-minted one. They
 * are false for the unproxied address a cluster Target now publishes, and there
 * is no vanity layer there to lose anything anyway.
 *
 * The answer is to **state them in the UI, never to work around them**. A
 * workaround would be a second edge, which is the external load balancer §9
 * declines to have.
 *
 * They are constants rather than prose in a component so that the screen showing
 * them and the test asserting they are shown read the same values.
 */
export const VANITY_LEG_LOSSES = {
  /** The leg buffers the whole response before sending any of it. */
  buffersResponse: true,
  /** Which is why a stream never arrives: it is complete or it is nothing. */
  streamingProtocols: false,
  /** And why a slow request is cut rather than waited out. */
  maxRequestSeconds: 60,
} as const;

/** What {@link hostnameFor} needs to answer §6's `hostname` field. */
export interface HostnameContext {
  readonly app: string;
  readonly component: string;
  readonly adapter: TargetAdapter;
  /** Where this Component can be reached from, which narrows the zones. */
  readonly reach: Reach;
  readonly zones: DnsZones;
  /** The zone this App is pinned to, if any — {@link zoneFor}'s `preferred`. */
  readonly zone: string | null;
  /** The flat label the developer chose, if any. */
  readonly vanityLabel: string | null;
}

/**
 * The `hostname` core hands the adapter (§6).
 *
 * Three cases, and the first is the one that changed: **a Component with no
 * reach has no name at all.** Nothing routes to it, so every name core could
 * mint would resolve to something unreachable.
 *
 * Otherwise `canonical` is empty exactly when the platform names its own — the
 * adapter fills that gap from its own API and reports the result back, which is
 * why {@link Hostname} carries a string rather than a nullable one: every routed
 * deploy ends with a canonical name, but not every one starts with one. The
 * vanity layer is layered on only there, for the reason in this module's header.
 */
export function hostnameFor(context: HostnameContext): Hostname {
  const zone = zoneFor(context.reach, context.zones, context.zone);
  if (zone === null) return { canonical: '' };

  if (coreMintsCanonical(context.adapter)) {
    return {
      canonical: componentCanonical({
        app: context.app,
        component: context.component,
        zone,
      }),
    };
  }

  return {
    canonical: '',
    ...(context.vanityLabel === null
      ? {}
      : { vanity: vanity(context.vanityLabel, zone) }),
  };
}

/**
 * The address a developer is shown for one Deploy.
 *
 * Vanity first where there is one, because that is the name §9 says a developer
 * shares; the canonical is what always resolves underneath it. `null` when
 * neither exists yet — a Deploy that has not reached a Target has no address,
 * and inventing one for the UI would make a pending deploy look live. It is also
 * `null` for a Component with no reach, which is not a gap but the answer.
 */
export function displayUrl(hostname: Hostname): string | null {
  const host = hostname.vanity ?? hostname.canonical;
  return host === '' ? null : `https://${host}`;
}
