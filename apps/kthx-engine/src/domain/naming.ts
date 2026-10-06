/**
 * Hostnames. The canonical name always resolves: the platform mints it where it
 * can, otherwise core does. The vanity name is the App's own label, layered on
 * every Target.
 */
import type { TargetAdapter } from '../config/manifest.schema.ts';
import type { ComponentKind, Hostname, Reach } from './desired-state.ts';

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Whether a string is one legal DNS label. */
export function isLabel(value: string): boolean {
  return value.length > 0 && value.length <= 63 && LABEL.test(value);
}

/**
 * Backends that mint their own address. A cluster's load-balancer range is
 * private, so core names cluster workloads.
 */
const PLATFORM_NAMES_ITS_OWN: readonly TargetAdapter[] = [
  'cloudrun',
  'static',
  'vercel',
  'cloudflare-pages',
];

export function coreMintsCanonical(adapter: TargetAdapter): boolean {
  return !PLATFORM_NAMES_ITS_OWN.includes(adapter);
}

export type RoutedReach = Exclude<Reach, 'none'>;

/**
 * A zone serving both reaches keeps a reach flip to a record re-point; a zone
 * per reach makes it a rename.
 */
export interface DnsZone {
  readonly name: string;
  readonly reaches: readonly RoutedReach[];
}

/** In priority order: an unpinned App takes the first zone serving its reach. */
export type DnsZones = readonly DnsZone[];

/**
 * `null` for `reach: none`, or when no zone serves the reach. A `preferred` pin
 * that cannot serve the reach falls through to the first zone that can.
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

/**
 * Whether the Component may claim the App's front-door name. Publishing and the
 * App screen both call this so they agree.
 */
export function servesNetwork(component: {
  readonly kind: ComponentKind;
  readonly expose: boolean | null;
}): boolean {
  return component.kind === 'website' || component.expose === true;
}

export interface CanonicalName {
  readonly app: string;
  readonly component: string;
  /** The zone for this Component's reach, from {@link zoneFor}. */
  readonly zone: string;
}

/**
 * `<app>-<component>.<zone>`: one label under the zone, because a wildcard
 * certificate covers exactly one label.
 */
export function componentCanonical(name: CanonicalName): string {
  return `${name.app}-${name.component}.${name.zone}`;
}

/** The vanity label for the zone apex; an empty label would read as no vanity. */
export const APEX = '@';

export function isVanityLabel(value: string): boolean {
  return value === APEX || isLabel(value);
}

export function installationHostnames(controlPlane: {
  readonly hostname: string;
  readonly publicHostname: string | null;
  readonly reservedHostnames: readonly string[];
}): string[] {
  return [
    controlPlane.hostname,
    controlPlane.publicHostname,
    ...controlPlane.reservedHostnames,
  ].flatMap((host) => (host ? [host.toLowerCase()] : []));
}

/**
 * Matched by first label across all zones, so a zone declared later cannot turn
 * an accepted label into the control plane's name.
 */
export function ownHostnameClaimedBy(
  label: string,
  zones: DnsZones,
  own: readonly string[],
): string | null {
  return (
    own.find((host) =>
      label === APEX
        ? zones.some((zone) => zone.name.toLowerCase() === host)
        : host.split('.')[0] === label,
    ) ?? null
  );
}

export function ownHostnameMintedIn(
  hostname: Hostname,
  own: readonly string[],
): string | null {
  return (
    [hostname.canonical, hostname.vanity].find(
      (name) => name !== undefined && own.includes(name.toLowerCase()),
    ) ?? null
  );
}

export function vanity(label: string, zone: string): string {
  return label === APEX ? zone : `${label}.${zone}`;
}

/**
 * Apex records are create-once: external-dns writes its ownership marker for an
 * apex outside the zone, so it never updates or deletes the record.
 */
export function isApexName(hostname: string, zones: DnsZones): boolean {
  return zones.some((zone) => zone.name === hostname);
}

/**
 * Limits of a proxied vanity leg: it buffers the whole response, so WebSockets
 * and SSE fail, and requests cap at 60 seconds.
 */
export const VANITY_LEG_LOSSES = {
  buffersResponse: true,
  streamingProtocols: false,
  maxRequestSeconds: 60,
} as const;

export interface HostnameContext {
  readonly app: string;
  readonly component: string;
  readonly adapter: TargetAdapter;
  readonly reach: Reach;
  readonly zones: DnsZones;
  /** The App's pinned zone: {@link zoneFor}'s `preferred`. */
  readonly zone: string | null;
  readonly vanityLabel: string | null;
}

/**
 * No name when the reach routes nowhere. Otherwise `canonical` is empty where
 * the platform names its own, and the adapter reports that address back.
 */
export function hostnameFor(context: HostnameContext): Hostname {
  const zone = zoneFor(context.reach, context.zones, context.zone);
  if (zone === null) return { canonical: '' };

  const vanityField =
    context.vanityLabel === null
      ? {}
      : { vanity: vanity(context.vanityLabel, zone) };

  if (coreMintsCanonical(context.adapter)) {
    return {
      canonical: componentCanonical({
        app: context.app,
        component: context.component,
        zone,
      }),
      ...vanityField,
    };
  }

  return { canonical: '', ...vanityField };
}

/** Vanity first: it is the name a developer shares. `null` when there is none. */
export function displayUrl(hostname: Hostname): string | null {
  const host = hostname.vanity ?? hostname.canonical;
  return host === '' ? null : `https://${host}`;
}
