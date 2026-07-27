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
 * The asymmetry between them is not cosmetic and it is enforced here:
 *
 * - **Canonical names nest freely.** `web.shop.apps.example` is legal because
 *   free universal certificates only bind *proxied* records to one subdomain
 *   level, and a canonical name is not proxied.
 * - **Vanity names are flat, single-label, and rationed.** One apex, one
 *   certificate, and §9's "hard ceiling: roughly 20 vanity names" is a property
 *   of that certificate rather than a policy anyone chose.
 *
 * **Core mints only what the platform will not.** {@link canonicalFor} returns
 * `null` for a Target whose backend names its own workloads, and on those the
 * adapter reports the address back across the deploy seam (§6's
 * `DeployVerdict.url`). A core that minted a name there would be inventing a
 * second address for something that already had one.
 */
import type { TargetAdapter } from '../config/manifest.schema.ts';
import type { Hostname } from './desired-state.ts';

/**
 * A single DNS label: what a vanity name is allowed to be, and what each
 * segment of a canonical name is built from.
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
const PLATFORM_NAMES_ITS_OWN: readonly TargetAdapter[] = ['cloudrun', 'static'];

/** Whether core mints the canonical name for a Target of this adapter type. */
export function coreMintsCanonical(adapter: TargetAdapter): boolean {
  return !PLATFORM_NAMES_ITS_OWN.includes(adapter);
}

/** What a canonical name is assembled from. */
export interface CanonicalName {
  readonly app: string;
  readonly component: string;
  /** The installation's dedicated apex, disjoint from any hand-managed space. */
  readonly apexZone: string;
}

/**
 * The name core mints for one Component on a Target that has none (§9).
 *
 * `<component>.<app>.<apex>` — nested rather than flattened to
 * `<component>-<app>`, because nesting is free here (canonical names are
 * unproxied) and a hyphen-joined name is ambiguous the moment either half
 * contains a hyphen, which both are allowed to.
 */
export function componentCanonical(name: CanonicalName): string {
  return `${name.component}.${name.app}.${name.apexZone}`;
}

/** §9's flat single-label vanity name, in the installation's vanity zone. */
export function vanity(label: string, vanityZone: string): string {
  return `${label}.${vanityZone}`;
}

/** What {@link hostnameFor} needs to answer §6's `hostname` field. */
export interface HostnameContext {
  readonly app: string;
  readonly component: string;
  readonly adapter: TargetAdapter;
  readonly apexZone: string;
  readonly vanityZone: string;
  /** The flat label the developer chose, if any. */
  readonly vanityLabel: string | null;
}

/**
 * The `hostname` core hands the adapter (§6).
 *
 * `canonical` is empty exactly when the platform names its own — the adapter
 * fills that gap from its own API and reports the result back on the verdict,
 * which is why {@link Hostname} carries a string rather than a nullable one:
 * every deploy ends with a canonical name, but not every deploy starts with one.
 */
export function hostnameFor(context: HostnameContext): Hostname {
  const canonical = coreMintsCanonical(context.adapter)
    ? componentCanonical({
        app: context.app,
        component: context.component,
        apexZone: context.apexZone,
      })
    : '';

  return {
    canonical,
    ...(context.vanityLabel === null
      ? {}
      : { vanity: vanity(context.vanityLabel, context.vanityZone) }),
  };
}

/**
 * The address a developer is shown for one Deploy.
 *
 * Vanity first where there is one, because that is the name §9 says a developer
 * shares; the canonical is what always resolves underneath it. `null` when
 * neither exists yet — a Deploy that has not reached a Target has no address,
 * and inventing one for the UI would make a pending deploy look live.
 */
export function displayUrl(hostname: Hostname): string | null {
  const host = hostname.vanity ?? hostname.canonical;
  return host === '' ? null : `https://${host}`;
}
