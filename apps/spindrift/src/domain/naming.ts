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

/**
 * §9's hard ceiling on vanity names: "roughly 20".
 *
 * **Not a policy anyone chose.** One apex gets one free universal certificate,
 * and that certificate is what caps how many single-label names can be minted
 * under it. So this is a fact about the zone being reported, not a limit being
 * imposed — which is why {@link vanityRation} returns a count rather than
 * throwing, and why the UI's job is to say how many are left rather than to
 * refuse the twenty-first.
 */
export const VANITY_CEILING = 20;

/** What is left of the ration, for the UI to state rather than enforce. */
export interface VanityRation {
  readonly used: number;
  readonly ceiling: number;
  readonly remaining: number;
  /** True once the next name may not get a certificate. */
  readonly exhausted: boolean;
}

/** The ration, given how many vanity names this installation has minted. */
export function vanityRation(used: number): VanityRation {
  const remaining = Math.max(0, VANITY_CEILING - used);
  return {
    used,
    ceiling: VANITY_CEILING,
    remaining,
    exhausted: remaining === 0,
  };
}

/**
 * Whether a Target's vanity name is served through the proxying edge (§9).
 *
 * §9 makes this **a per-Target property**, and the sentence it makes it one in
 * is worth quoting because the causality runs the opposite way to how it reads:
 * "the vanity record is unproxied on that leg, **so** proxying becomes a
 * per-Target property." The proxy is not a preference — it is the only way a
 * name reaches a metal cluster at all, because §9's forcing fact is that the
 * cluster's load-balancer range is RFC1918 and public reach goes through the
 * tunnel. A backend that answers on the public internet by itself needs no such
 * hop, and putting one in front of it would buy nothing and cost the losses in
 * {@link VANITY_LEG_LOSSES}.
 *
 * It is derived from the adapter type rather than stored, which is a per-Target
 * property exactly because a Target has exactly one adapter type (§13). Storing
 * it would let an operator assert something the backend contradicts.
 */
export function vanityProxied(adapter: TargetAdapter): boolean {
  return coreMintsCanonical(adapter);
}

/**
 * What is lost at a vanity name that is not proxied (§9).
 *
 * §9 records these as a **real loss, absorbed on purpose**: "the vanity leg
 * buffers the full response, so WebSockets and SSE die there and requests cap at
 * 60 seconds". Two-layer naming is what makes that absorbable — the app stays
 * fully capable at its canonical name — so the answer is to **state them in the
 * UI, never to work around them**. A workaround would be a second edge, which
 * is the external load balancer §9 declines to have.
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

/**
 * Whether a Component reached at its vanity name still works as intended.
 *
 * The one thing the losses above make a *decision* rather than a caveat: an App
 * that streams is an App whose vanity name is worse than no vanity name, and
 * saying so at the moment a name is chosen is cheaper than saying it after
 * somebody's WebSocket has been failing in production for a week.
 */
export function vanityCarriesStreams(adapter: TargetAdapter): boolean {
  return vanityProxied(adapter) || VANITY_LEG_LOSSES.streamingProtocols;
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
